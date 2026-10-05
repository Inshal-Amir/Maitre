"""Sign in with Google for the console (OpenID Connect authorization-code flow with PKCE).

The browser is sent to Google, comes back to /platform/v1/auth/google/callback, and gets the same
session cookies as a password login. Accounts are matched by Google subject, then by verified email
(linking an existing password account), else created as a normal user with zero credits.
"""

from __future__ import annotations

import base64
import hashlib
import hmac
import json
import logging
import secrets
import time
from urllib.parse import urlencode

import httpx
from fastapi import APIRouter, Depends, Request
from fastapi.responses import RedirectResponse
from sqlalchemy import select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession

from .auth import client_ip, now
from .config import get_settings
from .db import get_db
from .models import AuditEvent, OAuthIdentity, User, Wallet
from .routes_platform import _start_session, normalize_email
from .security import hash_password, new_token

log = logging.getLogger("zehnora.oauth")
router = APIRouter(prefix="/platform/v1/auth")

STATE_COOKIE = "zehnora_oauth"
STATE_PATH = "/platform/v1/auth/google"
STATE_TTL_S = 600
GOOGLE_ISSUERS = {"accounts.google.com", "https://accounts.google.com"}


def _enabled() -> bool:
    s = get_settings()
    return bool(s.google_client_id and s.google_client_secret)


def _b64(data: bytes) -> str:
    return base64.urlsafe_b64encode(data).rstrip(b"=").decode()


def _unb64(text: str) -> bytes:
    return base64.urlsafe_b64decode(text + "=" * (-len(text) % 4))


def _sign(payload: dict) -> str:
    body = _b64(json.dumps(payload, separators=(",", ":")).encode())
    mac = hmac.new(get_settings().session_secret.encode(), body.encode(), hashlib.sha256).hexdigest()
    return f"{body}.{mac}"


def _unsign(value: str) -> dict | None:
    body, _, mac = value.rpartition(".")
    expected = hmac.new(get_settings().session_secret.encode(), body.encode(), hashlib.sha256).hexdigest()
    if not body or not hmac.compare_digest(mac, expected):
        return None
    try:
        payload = json.loads(_unb64(body))
    except ValueError:
        return None
    return payload if payload.get("exp", 0) > time.time() else None


def _redirect_uri(request: Request) -> str:
    base = get_settings().console_url.rstrip("/") or str(request.base_url).rstrip("/")
    return f"{base}{STATE_PATH}/callback"


def _safe_next(value: str | None) -> str:
    """Only same-site paths, so the login cannot be used as an open redirect."""
    return value if value and value.startswith("/") and not value.startswith("//") and "\\" not in value else "/"


def _fail(code: str) -> RedirectResponse:
    response = RedirectResponse(f"/?{urlencode({'login_error': code})}", status_code=302)
    response.delete_cookie(STATE_COOKIE, path=STATE_PATH)
    return response


@router.get("/providers")
async def providers():
    return {"google": _enabled()}


@router.get("/google/start")
async def google_start(request: Request, next: str | None = None):
    if not _enabled():
        return _fail("google_not_configured")
    s = get_settings()
    state, nonce, verifier = new_token(), new_token(), secrets.token_urlsafe(48)
    params = {
        "client_id": s.google_client_id,
        "redirect_uri": _redirect_uri(request),
        "response_type": "code",
        "scope": "openid email profile",
        "state": state,
        "nonce": nonce,
        "code_challenge": _b64(hashlib.sha256(verifier.encode()).digest()),
        "code_challenge_method": "S256",
        "prompt": "select_account",
    }
    response = RedirectResponse(f"{s.google_auth_url}?{urlencode(params)}", status_code=302)
    cookie = _sign({"state": state, "nonce": nonce, "verifier": verifier, "next": _safe_next(next), "exp": time.time() + STATE_TTL_S})
    response.set_cookie(STATE_COOKIE, cookie, max_age=STATE_TTL_S, httponly=True, secure=s.cookie_secure, samesite="lax", path=STATE_PATH)
    return response


async def _exchange(code: str, verifier: str, redirect_uri: str) -> dict | None:
    s = get_settings()
    async with httpx.AsyncClient(timeout=15) as client:
        r = await client.post(s.google_token_url, data={
            "grant_type": "authorization_code", "code": code, "code_verifier": verifier, "redirect_uri": redirect_uri,
            "client_id": s.google_client_id, "client_secret": s.google_client_secret,
        })
    if r.status_code != 200:
        log.warning("google token exchange failed: HTTP %s %s", r.status_code, r.text[:200])
        return None
    return r.json()


def _claims(id_token: str, nonce: str) -> dict | None:
    """Claims of an ID token received directly from Google's token endpoint over TLS (OIDC Core 3.1.3.7);
    issuer, audience, expiry and nonce are still checked."""
    try:
        claims = json.loads(_unb64(id_token.split(".")[1]))
    except (IndexError, ValueError):
        return None
    if claims.get("iss") not in GOOGLE_ISSUERS or claims.get("aud") != get_settings().google_client_id:
        return None
    if claims.get("exp", 0) < time.time() or not hmac.compare_digest(str(claims.get("nonce", "")), nonce):
        return None
    return claims


async def _user_for(db: AsyncSession, subject: str, email: str, request: Request) -> User:
    identity = await db.scalar(select(OAuthIdentity).where(OAuthIdentity.provider == "google", OAuthIdentity.subject == subject))
    if identity:
        identity.last_login_at = now()
        return await db.get(User, identity.user_id)
    user = await db.scalar(select(User).where(User.email == email))
    if user is None:
        # A Google-only account: the random password is never shown, so password login stays closed.
        user = User(email=email, password_hash=hash_password(new_token()), role="user", status="active")
        db.add(user)
        await db.flush()
        db.add(Wallet(user_id=user.id, balance_units=0, reserved_units=0))
        db.add(AuditEvent(actor_user_id=user.id, action="user.register", target_type="user", target_id=str(user.id),
                          details={"via": "google"}, ip=client_ip(request)))
    db.add(OAuthIdentity(user_id=user.id, provider="google", subject=subject, email=email, last_login_at=now()))
    db.add(AuditEvent(actor_user_id=user.id, action="oauth.link", target_type="user", target_id=str(user.id),
                      details={"provider": "google"}, ip=client_ip(request)))
    return user


@router.get("/google/callback")
async def google_callback(request: Request, code: str | None = None, state: str | None = None, error: str | None = None,
                          db: AsyncSession = Depends(get_db)):
    if error:
        return _fail("google_cancelled" if error == "access_denied" else "google_error")
    saved = _unsign(request.cookies.get(STATE_COOKIE, ""))
    if not saved or not code or not state or not hmac.compare_digest(saved["state"], state):
        return _fail("google_state")
    tokens = await _exchange(code, saved["verifier"], _redirect_uri(request))
    claims = _claims((tokens or {}).get("id_token", ""), saved["nonce"]) if tokens else None
    if not claims or not claims.get("sub") or not claims.get("email"):
        return _fail("google_token")
    if claims.get("email_verified") is not True:
        return _fail("google_unverified_email")
    try:
        email = normalize_email(claims["email"])
        user = await _user_for(db, str(claims["sub"]), email, request)
        await db.flush()
    except IntegrityError:
        await db.rollback()
        return _fail("google_error")
    if user.status != "active":
        await db.commit()
        return _fail("account_disabled")
    response = RedirectResponse(saved["next"], status_code=302)
    response.delete_cookie(STATE_COOKIE, path=STATE_PATH)
    await _start_session(db, user, request, response)
    return response
