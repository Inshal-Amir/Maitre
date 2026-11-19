"""Hosted web search (/v1/search): a key-authenticated front for the private SearXNG service.

Search is not billed in tokens. The query is never logged here; failures log only the error type.
Rate limit: a per-key sliding window in this process (the API runs as a single uvicorn process).
"""

from __future__ import annotations

import base64
import binascii
import logging
import re
import time
import uuid
from collections import defaultdict, deque
from urllib.parse import parse_qs, parse_qsl, unquote, urlencode, urlsplit, urlunsplit

import httpx
from fastapi import APIRouter, Depends, Request
from fastapi.responses import JSONResponse
from pydantic import BaseModel, ConfigDict, Field, ValidationError
from sqlalchemy import update
from sqlalchemy.ext.asyncio import AsyncSession

from .auth import api_key_principal, now
from .config import get_settings
from .db import get_db
from .errors import ApiError, request_id_of
from .models import ApiKey

log = logging.getLogger("maitre.search")
router = APIRouter()

SNIPPET_CHARS = 300
TITLE_CHARS = 300
WINDOW_S = 60.0

TRACKING_PARAMS = {"gclid", "dclid", "gbraid", "wbraid", "fbclid", "msclkid", "yclid", "igshid", "mc_cid", "mc_eid",
                   "_hsenc", "_hsmi", "mkt_tok", "ref_src", "ref_url", "srsltid", "si", "spm", "oly_anon_id", "oly_enc_id",
                   "vero_id", "trk", "trkcampaign", "cmpid"}
TRACKING_PREFIXES = ("utm_", "pk_", "mtm_", "hsa_")

_recent: dict[uuid.UUID, deque[float]] = defaultdict(deque)


class SearchRequest(BaseModel):
    model_config = ConfigDict(str_strip_whitespace=True)

    query: str = Field(min_length=1, max_length=400)
    max_results: int = Field(default=6, ge=1, le=10)
    language: str | None = Field(default=None, pattern=r"^(all|auto|[A-Za-z]{2,3}(-[A-Za-z0-9]{2,8})?)$")


def _client() -> httpx.AsyncClient:
    return httpx.AsyncClient(timeout=httpx.Timeout(get_settings().search_timeout_s, connect=5))


def check_rate(key_id: uuid.UUID) -> None:
    limit = get_settings().search_requests_per_minute
    if limit <= 0:
        return
    t = time.monotonic()
    window = _recent[key_id]
    while window and t - window[0] >= WINDOW_S:
        window.popleft()
    if len(window) >= limit:
        raise ApiError(429, "search_rate_limited", f"Search is limited to {limit} requests per minute per key. Retry shortly.")
    window.append(t)


def _bing_target(value: str) -> str | None:
    if not value.startswith("a1"):
        return None
    raw = value[2:]
    try:
        return base64.urlsafe_b64decode(raw + "=" * (-len(raw) % 4)).decode()
    except (binascii.Error, UnicodeDecodeError):
        return None


def _unwrap(url: str) -> str:
    """Follow known search-engine redirect wrappers to the real destination (no network)."""
    for _ in range(3):
        parts = urlsplit(url if not url.startswith("//") else "https:" + url)
        host = (parts.hostname or "").lower()
        query = parse_qs(parts.query)
        target = None
        if host.endswith("duckduckgo.com") and parts.path.startswith("/l/"):
            target = (query.get("uddg") or [None])[0]
        elif re.fullmatch(r"(www\.)?google\.[a-z.]+", host) and parts.path == "/url":
            target = (query.get("q") or query.get("url") or [None])[0]
        elif host.endswith("bing.com") and parts.path.startswith("/ck/"):
            target = _bing_target((query.get("u") or [""])[0])
        elif host.endswith("search.yahoo.com") and "/RU=" in parts.path:
            target = unquote(parts.path.split("/RU=", 1)[1].split("/", 1)[0])
        if not target or not target.startswith(("http://", "https://")):
            return url
        url = target
    return url


def clean_url(url: str) -> str | None:
    """Real destination without tracking parameters or fragment; None for anything that is not http(s)."""
    parts = urlsplit(_unwrap(url.strip()))
    if parts.scheme.lower() not in ("http", "https") or not parts.hostname:
        return None
    pairs = parse_qsl(parts.query, keep_blank_values=True)
    kept = [(k, v) for k, v in pairs if k.lower() not in TRACKING_PARAMS and not k.lower().startswith(TRACKING_PREFIXES)]
    query = parts.query if len(kept) == len(pairs) else urlencode(kept)
    return urlunsplit((parts.scheme.lower(), parts.netloc.lower(), parts.path or "/", query, ""))


def dedupe_key(url: str) -> str:
    parts = urlsplit(url)
    host = parts.netloc.removeprefix("www.")
    return f"{host}{parts.path.rstrip('/')}?{parts.query}"


def trim(text: str | None, limit: int) -> str:
    text = " ".join((text or "").split())
    if len(text) <= limit:
        return text
    cut = text[:limit - 1]
    space = cut.rfind(" ")
    return (cut[:space] if space > limit // 2 else cut).rstrip(" ,.;:-") + "…"


def normalize_results(raw: list, max_results: int) -> list[dict]:
    """SearXNG results -> [{title, url, snippet, engine?, published?}], deduplicated by destination URL."""
    out: list[dict] = []
    seen: set[str] = set()
    for item in raw:
        if not isinstance(item, dict) or not isinstance(item.get("url"), str):
            continue
        url = clean_url(item["url"])
        if url is None or dedupe_key(url) in seen:
            continue
        seen.add(dedupe_key(url))
        result = {"title": trim(item.get("title"), TITLE_CHARS) or url, "url": url,
                  "snippet": trim(item.get("content"), SNIPPET_CHARS)}
        if isinstance(item.get("engine"), str) and item["engine"]:
            result["engine"] = item["engine"]
        if isinstance(item.get("publishedDate"), str) and item["publishedDate"]:
            result["published"] = item["publishedDate"]
        out.append(result)
        if len(out) >= max_results:
            break
    return out


async def run_search(req: SearchRequest, rid: str) -> dict:
    params = {"q": req.query, "format": "json", "pageno": 1}
    if req.language:
        params["language"] = req.language
    url = f"{get_settings().searxng_url.rstrip('/')}/search"
    try:
        async with _client() as client:
            resp = await client.get(url, params=params, headers={"Accept": "application/json"})
    except httpx.HTTPError as exc:
        log.warning("search upstream unreachable (%s) %s", type(exc).__name__, rid)
        raise ApiError(503, "search_unavailable", "Search service unavailable. Retry shortly.", rid) from exc
    if resp.status_code != 200:
        log.warning("search upstream HTTP %s %s", resp.status_code, rid)
        raise ApiError(503, "search_unavailable", f"Search service error (HTTP {resp.status_code}).", rid)
    try:
        data = resp.json()
    except ValueError as exc:
        raise ApiError(503, "search_unavailable", "Search service returned an invalid response.", rid) from exc
    raw = data.get("results") if isinstance(data, dict) else None
    if not isinstance(raw, list):
        raise ApiError(503, "search_unavailable", "Search service returned an invalid response.", rid)
    results = normalize_results(raw, req.max_results)
    if not results and data.get("unresponsive_engines"):
        raise ApiError(503, "search_engines_unavailable", "No search engine answered. Retry shortly.", rid)
    return {"query": req.query, "results": results}


async def _parse(request: Request) -> SearchRequest:
    if request.method == "GET":
        data = {k: v for k, v in (("query", request.query_params.get("q")),
                                  ("max_results", request.query_params.get("max_results")),
                                  ("language", request.query_params.get("language"))) if v is not None}
    else:
        try:
            data = await request.json()
        except Exception as exc:
            raise ApiError(400, "invalid_json", "Request body must be JSON.") from exc
        if not isinstance(data, dict):
            raise ApiError(400, "invalid_json", "Request body must be a JSON object.")
    try:
        return SearchRequest.model_validate(data)
    except ValidationError as exc:
        first = exc.errors()[0]
        field = ".".join(str(x) for x in first.get("loc", [])) or "body"
        raise ApiError(400, "invalid_request", f"{field}: {first.get('msg', 'invalid value')}") from exc


@router.api_route("/v1/search", methods=["GET", "POST"])
async def search(request: Request, db: AsyncSession = Depends(get_db)):
    principal = await api_key_principal(request, db)
    req = await _parse(request)
    check_rate(principal.key.id)
    rid = request_id_of(request)
    result = await run_search(req, rid)
    await db.execute(update(ApiKey).where(ApiKey.id == principal.key.id).values(last_used_at=now()))
    await db.commit()
    return JSONResponse(result, headers={"x-request-id": rid})
