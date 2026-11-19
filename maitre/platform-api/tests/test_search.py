"""Hosted web search (/v1/search) against a mocked SearXNG.

URL cleaning and validation are unit level. Endpoint tests run the app in process (real development
PostgreSQL for the key lookup) with SearXNG replaced by an httpx MockTransport; the test key comes
from the live platform API like the rest of the suite.
"""

from __future__ import annotations

import json

import httpx
import pytest
import pytest_asyncio
from pydantic import ValidationError

from app import search
from app.config import get_settings
from app.db import dispose
from app.main import app
from app.search import SearchRequest, clean_url, normalize_results, trim

from conftest import Portal

PAGE = "https://example.com/guide"
SEARXNG_OK = {
    "query": "maitre",
    "results": [
        {"title": "  Example   guide ", "url": PAGE + "?utm_source=x&utm_medium=y", "content": "First   copy.",
         "engine": "duckduckgo", "publishedDate": "2026-11-01T00:00:00"},
        {"title": "Same page via DuckDuckGo", "url": "https://duckduckgo.com/l/?uddg=https%3A%2F%2Fexample.com%2Fguide&rut=1",
         "content": "dup", "engine": "duckduckgo"},
        {"title": "Same page, www", "url": "https://www.example.com/guide/#top", "content": "dup", "engine": "brave"},
        {"title": "Script", "url": "javascript:alert(1)", "content": "never"},
        {"title": "Long", "url": "https://docs.example.org/a?id=7&fbclid=abc", "content": "word " * 200, "engine": "google"},
    ],
    "unresponsive_engines": [],
}


# ---------- unit: URL cleaning, trimming, validation ----------

@pytest.mark.parametrize("raw, expected", [
    ("https://Example.com/a?utm_source=x&id=3&gclid=1#frag", "https://example.com/a?id=3"),
    ("https://example.com/a?b=1&c=2", "https://example.com/a?b=1&c=2"),
    ("https://duckduckgo.com/l/?uddg=https%3A%2F%2Fexample.com%2Fx%3Fy%3D1&rut=abc", "https://example.com/x?y=1"),
    ("//duckduckgo.com/l/?uddg=https%3A%2F%2Fexample.com%2F", "https://example.com/"),
    ("https://www.google.com/url?q=https://example.com/g&sa=U", "https://example.com/g"),
    ("https://www.bing.com/ck/a?!&&p=1&u=a1aHR0cHM6Ly9leGFtcGxlLmNvbS9i&ntb=1", "https://example.com/b"),
    ("https://r.search.yahoo.com/_ylt=A/RV=2/RE=1/RO=10/RU=https%3a%2f%2fexample.com%2fy/RK=2/RS=x-", "https://example.com/y"),
])
def test_clean_url_unwraps_and_strips_tracking(raw, expected):
    assert clean_url(raw) == expected


@pytest.mark.parametrize("raw", ["javascript:alert(1)", "ftp://example.com/f", "mailto:a@example.com", "not a url"])
def test_clean_url_drops_non_web_links(raw):
    assert clean_url(raw) is None


def test_trim_collapses_whitespace_and_cuts_at_a_word():
    assert trim("  a \n b  ", 300) == "a b"
    cut = trim("word " * 200, 300)
    assert len(cut) <= 300 and cut.endswith("word…")


def test_normalize_dedupes_and_limits():
    results = normalize_results(SEARXNG_OK["results"], 10)
    assert [r["url"] for r in results] == [PAGE, "https://docs.example.org/a?id=7"]
    assert results[0] == {"title": "Example guide", "url": PAGE, "snippet": "First copy.", "engine": "duckduckgo",
                          "published": "2026-11-01T00:00:00"}
    assert len(results[1]["snippet"]) <= 300
    assert len(normalize_results(SEARXNG_OK["results"], 1)) == 1


@pytest.mark.parametrize("body", [
    {"query": ""}, {"query": "   "}, {"query": "x" * 401}, {"query": "x", "max_results": 0}, {"query": "x", "max_results": 11},
    {"query": "x", "language": "en; drop"}, {},
])
def test_request_validation(body):
    with pytest.raises(ValidationError):
        SearchRequest.model_validate(body)


def test_request_defaults():
    req = SearchRequest(query="x" * 400, language="en-US")
    assert req.max_results == 6 and req.language == "en-US"


# ---------- endpoint (in process, SearXNG mocked) ----------

@pytest.fixture
def searxng(monkeypatch):
    """Replaces the SearXNG HTTP call. Set .reply to a dict (JSON 200), an int (status) or an exception."""

    class Upstream:
        def __init__(self):
            self.reply: object = SEARXNG_OK
            self.calls: list[httpx.Request] = []

        def handle(self, request: httpx.Request) -> httpx.Response:
            self.calls.append(request)
            if isinstance(self.reply, Exception):
                raise self.reply
            if isinstance(self.reply, int):
                return httpx.Response(self.reply, text="upstream says no")
            return httpx.Response(200, json=self.reply)

    upstream = Upstream()
    monkeypatch.setattr(search, "_client", lambda: httpx.AsyncClient(transport=httpx.MockTransport(upstream.handle)))
    return upstream


@pytest_asyncio.fixture
async def client():
    async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://test") as c:
        yield c
    await dispose()  # the engine belongs to this test's event loop


@pytest.fixture
def key(user: Portal) -> str:
    return user.new_key("search")["secret"]


def auth(key: str) -> dict:
    return {"Authorization": f"Bearer {key}"}


@pytest.mark.asyncio
async def test_search_requires_a_valid_key(client, searxng):
    r = await client.post("/v1/search", json={"query": "maitre"})
    assert r.status_code == 401 and r.json()["error"]["code"] == "missing_api_key"
    r = await client.get("/v1/search", params={"q": "maitre"}, headers=auth("sk-maitre-not-a-real-key"))
    assert r.status_code == 401 and r.json()["error"]["code"] == "invalid_api_key"
    assert r.json()["error"]["type"] == "authentication_error" and r.json()["request_id"]
    assert searxng.calls == []


@pytest.mark.asyncio
async def test_post_search_returns_clean_results_and_is_not_billed(client, searxng, user, key):
    before = user.get("/platform/v1/wallet").json()["wallet"]
    r = await client.post("/v1/search", json={"query": "maitre", "max_results": 6, "language": "en"}, headers=auth(key))
    assert r.status_code == 200, r.text
    assert r.headers["x-request-id"]
    body = r.json()
    assert body["query"] == "maitre"
    assert [x["url"] for x in body["results"]] == [PAGE, "https://docs.example.org/a?id=7"]
    sent = searxng.calls[0].url
    assert sent.path == "/search" and sent.params["q"] == "maitre" and sent.params["format"] == "json"
    assert sent.params["language"] == "en"
    assert user.get("/platform/v1/wallet").json()["wallet"] == before


@pytest.mark.asyncio
async def test_get_search_with_q(client, searxng, key):
    r = await client.get("/v1/search", params={"q": "maitre", "max_results": "1"}, headers=auth(key))
    assert r.status_code == 200, r.text
    assert len(r.json()["results"]) == 1
    assert "language" not in searxng.calls[0].url.params


@pytest.mark.asyncio
@pytest.mark.parametrize("payload", [{"query": ""}, {"query": "x" * 401}, {"query": "x", "max_results": 11}, {"max_results": 3}, ["x"]])
async def test_invalid_requests_are_400_without_upstream_call(client, searxng, key, payload):
    r = await client.post("/v1/search", json=payload, headers=auth(key))
    assert r.status_code == 400, r.text
    assert r.json()["error"]["type"] == "invalid_request_error"
    assert searxng.calls == []


@pytest.mark.asyncio
async def test_non_json_body_and_missing_q(client, searxng, key):
    r = await client.post("/v1/search", content=b"not json", headers={**auth(key), "content-type": "application/json"})
    assert r.status_code == 400 and r.json()["error"]["code"] == "invalid_json"
    r = await client.get("/v1/search", headers=auth(key))
    assert r.status_code == 400 and r.json()["error"]["code"] == "invalid_request"
    assert searxng.calls == []


@pytest.mark.asyncio
@pytest.mark.parametrize("reply, code", [
    (httpx.ConnectError("connection refused"), "search_unavailable"),
    (httpx.ReadTimeout("timed out"), "search_unavailable"),
    (502, "search_unavailable"),
    ({"results": [], "unresponsive_engines": [["duckduckgo", "timeout"], ["brave", "CAPTCHA"]]}, "search_engines_unavailable"),
    ({"unexpected": True}, "search_unavailable"),
])
async def test_upstream_failure_is_503(client, searxng, key, reply, code):
    searxng.reply = reply
    r = await client.post("/v1/search", json={"query": "maitre"}, headers=auth(key))
    assert r.status_code == 503, r.text
    err = r.json()["error"]
    assert err["code"] == code and err["type"] == "service_unavailable"
    assert "maitre" not in json.dumps(err)


@pytest.mark.asyncio
async def test_empty_results_are_not_an_error(client, searxng, key):
    searxng.reply = {"results": [], "unresponsive_engines": []}
    r = await client.post("/v1/search", json={"query": "zxqv"}, headers=auth(key))
    assert r.status_code == 200 and r.json() == {"query": "zxqv", "results": []}


@pytest.mark.asyncio
async def test_per_key_rate_limit(client, searxng, key, monkeypatch):
    monkeypatch.setattr(get_settings(), "search_requests_per_minute", 2)
    codes = [(await client.post("/v1/search", json={"query": "maitre"}, headers=auth(key))).status_code for _ in range(3)]
    assert codes == [200, 200, 429]
    r = await client.post("/v1/search", json={"query": "maitre"}, headers=auth(key))
    assert r.json()["error"]["code"] == "search_rate_limited" and r.json()["error"]["type"] == "rate_limit_error"
    assert len(searxng.calls) == 2
