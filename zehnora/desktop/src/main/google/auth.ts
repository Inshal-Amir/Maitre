import crypto from 'node:crypto';
import type { GoogleService } from '../../shared/types';
import { getSettings, readSecret, writeSecret } from '../settings';
import { listenForRedirect } from '../mcp/loopback';

const OAUTH_BASE = process.env.ZEHNORA_GOOGLE_OAUTH_BASE;
const AUTH_URL = OAUTH_BASE ? `${OAUTH_BASE}/o/oauth2/v2/auth` : 'https://accounts.google.com/o/oauth2/v2/auth';
const TOKEN_URL = OAUTH_BASE ? `${OAUTH_BASE}/token` : 'https://oauth2.googleapis.com/token';
const REVOKE_URL = OAUTH_BASE ? `${OAUTH_BASE}/revoke` : 'https://oauth2.googleapis.com/revoke';
const USERINFO_URL = OAUTH_BASE ? `${OAUTH_BASE}/v1/userinfo` : 'https://openidconnect.googleapis.com/v1/userinfo';
const REFRESH_MARGIN_MS = 120_000;

export const SCOPES: Record<GoogleService, string[]> = {
  gmail: ['https://www.googleapis.com/auth/gmail.readonly', 'https://www.googleapis.com/auth/gmail.compose'],
  calendar: ['https://www.googleapis.com/auth/calendar.events'],
  drive: ['https://www.googleapis.com/auth/drive.readonly', 'https://www.googleapis.com/auth/drive.file'],
  docs: ['https://www.googleapis.com/auth/documents'],
  sheets: ['https://www.googleapis.com/auth/spreadsheets'],
};

interface StoredToken {
  accessToken: string;
  refreshToken: string;
  expiresAt: number;
  email: string;
  services: GoogleService[];
}

interface TokenResponse {
  access_token: string;
  refresh_token?: string;
  expires_in: number;
  scope?: string;
  error?: string;
  error_description?: string;
}

export class GoogleAuthError extends Error {}

const base64url = (buffer: Buffer): string => buffer.toString('base64url');

function load(): StoredToken | null {
  const raw = readSecret('google');
  if (!raw) return null;
  try {
    return JSON.parse(raw) as StoredToken;
  } catch {
    return null;
  }
}

const store = (token: StoredToken): void => writeSecret('google', JSON.stringify(token));

function client(): { clientId: string; clientSecret: string } {
  const { clientId, clientSecret } = getSettings().google;
  if (!clientId) throw new GoogleAuthError('No Google OAuth client is configured. Add the client ID in Settings → Connected apps → Advanced.');
  return { clientId, clientSecret };
}

async function tokenRequest(params: Record<string, string>): Promise<TokenResponse> {
  const response = await fetch(TOKEN_URL, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(params),
    signal: AbortSignal.timeout(20_000),
  });
  const body = (await response.json()) as TokenResponse;
  if (!response.ok || body.error) throw new GoogleAuthError(`Google token request failed: ${body.error_description ?? body.error ?? response.status}`);
  return body;
}

/** Runs Google's installed-app OAuth flow (PKCE + loopback redirect) in the user's browser. */
export async function signIn(services: GoogleService[], openBrowser: (url: string) => Promise<void>): Promise<string> {
  if (!services.length) throw new GoogleAuthError('Choose at least one Google service.');
  const { clientId, clientSecret } = client();
  const verifier = base64url(crypto.randomBytes(32));
  const state = base64url(crypto.randomBytes(16));
  const listener = await listenForRedirect();
  const scopes = ['openid', 'email', ...services.flatMap((service) => SCOPES[service])];
  const url = new URL(AUTH_URL);
  url.search = new URLSearchParams({
    client_id: clientId,
    redirect_uri: listener.redirectUri,
    response_type: 'code',
    scope: scopes.join(' '),
    code_challenge: base64url(crypto.createHash('sha256').update(verifier).digest()),
    code_challenge_method: 'S256',
    state,
    access_type: 'offline',
    prompt: 'consent',
    include_granted_scopes: 'true',
  }).toString();
  try {
    await openBrowser(url.toString());
    const redirect = await listener.result;
    if (redirect.state !== state) throw new GoogleAuthError('Sign-in state did not match; please try again.');
    const tokens = await tokenRequest({
      grant_type: 'authorization_code',
      code: redirect.code,
      code_verifier: verifier,
      redirect_uri: listener.redirectUri,
      client_id: clientId,
      ...(clientSecret ? { client_secret: clientSecret } : {}),
    });
    if (!tokens.refresh_token) throw new GoogleAuthError('Google did not return a refresh token; remove Zehnora from your Google account permissions and connect again.');
    const granted = new Set((tokens.scope ?? '').split(' '));
    const allowed = services.filter((service) => SCOPES[service].every((scope) => granted.has(scope)));
    const email = await fetchEmail(tokens.access_token);
    store({ accessToken: tokens.access_token, refreshToken: tokens.refresh_token, expiresAt: Date.now() + tokens.expires_in * 1000, email, services: allowed });
    return email;
  } finally {
    listener.close();
  }
}

async function fetchEmail(accessToken: string): Promise<string> {
  const response = await fetch(USERINFO_URL, { headers: { authorization: `Bearer ${accessToken}` }, signal: AbortSignal.timeout(15_000) });
  if (!response.ok) return '';
  return ((await response.json()) as { email?: string }).email ?? '';
}

export function account(): { email: string; services: GoogleService[] } | null {
  const token = load();
  return token ? { email: token.email, services: token.services } : null;
}

let refreshing: Promise<string> | null = null;

/** A valid access token, refreshed shortly before it expires. */
export async function accessToken(): Promise<string> {
  const token = load();
  if (!token) throw new GoogleAuthError('Google is not connected. Connect it in Settings → Connected apps.');
  if (token.expiresAt - REFRESH_MARGIN_MS > Date.now()) return token.accessToken;
  refreshing ??= (async () => {
    const { clientId, clientSecret } = client();
    try {
      const fresh = await tokenRequest({ grant_type: 'refresh_token', refresh_token: token.refreshToken, client_id: clientId, ...(clientSecret ? { client_secret: clientSecret } : {}) });
      store({ ...token, accessToken: fresh.access_token, expiresAt: Date.now() + fresh.expires_in * 1000, refreshToken: fresh.refresh_token ?? token.refreshToken });
      return fresh.access_token;
    } catch (error) {
      if (/invalid_grant/.test((error as Error).message)) throw new GoogleAuthError('Google access expired or was revoked. Reconnect Google in Settings → Connected apps.');
      throw error;
    }
  })().finally(() => {
    refreshing = null;
  });
  return refreshing;
}

export async function signOut(): Promise<void> {
  const token = load();
  writeSecret('google', '');
  if (!token) return;
  await fetch(`${REVOKE_URL}?token=${encodeURIComponent(token.refreshToken)}`, { method: 'POST', signal: AbortSignal.timeout(10_000) }).catch(() => undefined);
}
