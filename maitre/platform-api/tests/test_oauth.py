"""Sign in with Google against a local mock of Google's authorization and token endpoints.

The platform under test must run with:
  MAITRE_GOOGLE_CLIENT_ID=test-client.apps.googleusercontent.com MAITRE_GOOGLE_CLIENT_SECRET=test-secret
  MAITRE_GOOGLE_AUTH_URL=http://127.0.0.1:18911/auth MAITRE_GOOGLE_TOKEN_URL=http://127.0.0.1:18911/token
"""

from __future__ import annotations

import base64
import json
import threading
import time
import uuid
from http.server import BaseHTTPRequestHandler, HTTPServer
from urllib.parse import parse_qs, urlparse

import httpx
import pytest

from conftest import BASE, PW, Portal, unique_email

CLIENT_ID = "test-client.apps.googleusercontent.com"
MOCK_PORT = 18911
CODES: dict[str, dict] = {}


def _jwt(claims: dict) -> str:
    part = lambda obj: base64.urlsafe_b64encode(json.dumps(obj).encode()).rstrip(b"=").decode()
    return f"{part({'alg': 'RS256'})}.{part(claims)}.c2lnbmF0dXJl"


class _Google(BaseHTTPRequestHandler):
    def log_message(self, *args):
        pass

    def do_POST(self):
        form = parse_qs(self.rfile.read(int(self.headers["content-length"])).decode())
        claims = CODES.pop(form.get("code", [""])[0], None)
        ok = claims and form.get("client_secret") == ["test-secret"] and form.get("code_verifier", [""])[0]
        body = {"access_token": "at", "id_token": _jwt(claims), "expires_in": 3600} if ok else {"error": "invalid_grant"}
        self.send_response(200 if ok else 400)
        self.send_header("content-type", "application/json")
        self.end_headers()
        self.wfile.write(json.dumps(body).encode())


@pytest.fixture(scope="module", autouse=True)
def google():
    if not httpx.get(f"{BASE}/platform/v1/auth/providers").json().get("google"):
        pytest.skip("platform not started with the mock Google settings (see module docstring)")
    server = HTTPServer(("127.0.0.1", MOCK_PORT), _Google)
    threading.Thread(target=server.serve_forever, daemon=True).start()
    yield
    server.shutdown()


def sign_in(email: str, sub: str, verified: bool = True, next_path: str | None = None, tamper_state: bool = False) -> httpx.Client:
    """Plays the browser: start -> (Google) -> callback; returns the client holding the resulting cookies."""
    client = httpx.Client(base_url=BASE, follow_redirects=False)
    start = client.get("/platform/v1/auth/google/start", params={"next": next_path} if next_path else None)
    assert start.status_code == 302
    auth = urlparse(start.headers["location"])
    query = parse_qs(auth.query)
    assert auth.netloc == f"127.0.0.1:{MOCK_PORT}" and query["client_id"] == [CLIENT_ID]
    assert query["code_challenge_method"] == ["S256"] and query["scope"] == ["openid email profile"]
    assert query["redirect_uri"][0].endswith("/platform/v1/auth/google/callback")
    code = uuid.uuid4().hex
    CODES[code] = {"iss": "https://accounts.google.com", "aud": CLIENT_ID, "sub": sub, "email": email, "email_verified": verified,
                   "nonce": query["nonce"][0], "exp": time.time() + 600}
    state = "forged" if tamper_state else query["state"][0]
    client.callback = client.get("/platform/v1/auth/google/callback", params={"code": code, "state": state})
    return client


def test_new_google_user_gets_an_account_and_a_session():
    email = unique_email("google")
    client = sign_in(email, f"sub-{uuid.uuid4().hex}", next_path="/playground")
    assert client.callback.status_code == 302 and client.callback.headers["location"] == "/playground"
    session = client.get("/platform/v1/session").json()
    assert session["authenticated"] and session["user"]["email"] == email and session["user"]["role"] == "user"
    assert session["wallet"]["available_units"] == 0


def test_same_google_account_signs_in_to_the_same_user():
    email, sub = unique_email("again"), f"sub-{uuid.uuid4().hex}"
    first = sign_in(email, sub).get("/platform/v1/session").json()["user"]["id"]
    second = sign_in(email, sub).get("/platform/v1/session").json()["user"]["id"]
    assert first == second


def test_google_links_an_existing_password_account():
    email = unique_email("linked")
    portal = Portal(email)
    client = sign_in(email, f"sub-{uuid.uuid4().hex}")
    assert client.get("/platform/v1/session").json()["user"]["id"] == portal.user["id"]
    relogin = httpx.post(f"{BASE}/platform/v1/auth/login", json={"email": email, "password": PW})
    assert relogin.status_code == 200, "password login keeps working after linking"


def test_unverified_email_is_refused():
    client = sign_in(unique_email("unverified"), f"sub-{uuid.uuid4().hex}", verified=False)
    assert client.callback.status_code == 302 and "login_error=google_unverified_email" in client.callback.headers["location"]
    assert not client.get("/platform/v1/session").json()["authenticated"]


def test_forged_state_is_refused():
    client = sign_in(unique_email("forged"), f"sub-{uuid.uuid4().hex}", tamper_state=True)
    assert "login_error=google_state" in client.callback.headers["location"]
    assert not client.get("/platform/v1/session").json()["authenticated"]


def test_next_cannot_redirect_to_another_site():
    client = sign_in(unique_email("open-redirect"), f"sub-{uuid.uuid4().hex}", next_path="//evil.example.com/x")
    assert client.callback.headers["location"] == "/"
