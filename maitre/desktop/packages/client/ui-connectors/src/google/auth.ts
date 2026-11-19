/**
 * Google sign-in for the built-in Google Workspace connector: the OAuth 2.0
 * installed-application flow with PKCE and a loopback redirect, per-product
 * scopes, refresh before expiry, and revocation. Tokens live in one
 * credentials record.
 */

import { createHash, randomBytes } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import type { CredentialKey, CredentialProvider, CredentialRecord } from '@deepseek-ai/dsh-credentials'
import type { GoogleService } from '../types.ts'

/** OAuth scopes requested per Google product. */
export const GOOGLE_SCOPES: Readonly<Record<GoogleService, readonly string[]>> = {
  gmail: ['https://www.googleapis.com/auth/gmail.readonly', 'https://www.googleapis.com/auth/gmail.compose'],
  calendar: ['https://www.googleapis.com/auth/calendar.events'],
  drive: ['https://www.googleapis.com/auth/drive.readonly', 'https://www.googleapis.com/auth/drive.file'],
  docs: ['https://www.googleapis.com/auth/documents'],
  sheets: ['https://www.googleapis.com/auth/spreadsheets'],
}

/** Google OAuth endpoints. */
export interface GoogleEndpoints {
  readonly authUrl: string
  readonly tokenUrl: string
  readonly revokeUrl: string
  readonly userinfoUrl: string
}

/**
 * Real Google endpoints, or every endpoint under one test base URL.
 * @param base - mock server origin; empty for Google.
 * @returns the four endpoints.
 */
export function googleEndpoints(base: string): GoogleEndpoints {
  if (base === '') {
    return {
      authUrl: 'https://accounts.google.com/o/oauth2/v2/auth',
      tokenUrl: 'https://oauth2.googleapis.com/token',
      revokeUrl: 'https://oauth2.googleapis.com/revoke',
      userinfoUrl: 'https://openidconnect.googleapis.com/v1/userinfo',
    }
  }
  return { authUrl: `${base}/o/oauth2/v2/auth`, tokenUrl: `${base}/token`, revokeUrl: `${base}/revoke`, userinfoUrl: `${base}/v1/userinfo` }
}

/** The Google OAuth client (an "installed"/Desktop client). */
export interface GoogleClient {
  readonly clientId: string
  readonly clientSecret: string
}

/**
 * Read a Google client JSON file as downloaded from Google Cloud Console.
 * @param path - file path; the file is a secret and is read at each sign-in.
 * @returns the client id and secret.
 * @throws when the file is missing or has no `installed` or `web` client.
 */
export async function readGoogleClient(path: string): Promise<GoogleClient> {
  if (path === '') throw new Error('No Google OAuth client file is configured (set MAITRE_GOOGLE_OAUTH_FILE).')
  let text: string
  try {
    text = await readFile(path, 'utf8')
  } catch (error) {
    throw new Error(`The Google OAuth client file ${path} cannot be read: ${(error as Error).message}`, { cause: error })
  }
  type ClientFile = { client_id?: string; client_secret?: string }
  const parsed = JSON.parse(text) as { installed?: ClientFile; web?: ClientFile }
  const client = parsed.installed ?? parsed.web
  if (client?.client_id === undefined) throw new Error(`The Google OAuth client file ${path} has no client_id.`)
  return { clientId: client.client_id, clientSecret: client.client_secret ?? '' }
}

/** What the Google connector keeps in its credentials record. */
export interface GoogleGrant {
  readonly auth: 'google'
  readonly accessToken: string
  readonly refreshToken: string
  readonly expiresAt: number
  readonly email: string
  readonly services: GoogleService[]
}

/** Narrow a stored grant payload to the Google grant. */
export function googleGrantOf(record: CredentialRecord | undefined): GoogleGrant | undefined {
  if (record?.kind !== 'grant') return undefined
  const payload = record.payload as { auth?: unknown } | null
  return payload !== null && typeof payload === 'object' && payload.auth === 'google' ? record.payload as GoogleGrant : undefined
}

interface TokenResponse {
  access_token: string
  refresh_token?: string
  expires_in: number
  scope?: string
  error?: string
  error_description?: string
}

/** Session-independent inputs of the Google account. */
export interface GoogleAccountOptions {
  readonly credentials: CredentialProvider
  readonly key: CredentialKey
  readonly endpoints: GoogleEndpoints
  /** Reads the OAuth client at each sign-in and refresh, so a replaced file applies without a restart. */
  readonly client: () => Promise<GoogleClient>
  readonly refreshMarginMs: number
}

/** The signed-in Google account: token storage, refresh, and revocation. */
export class GoogleAccount {
  private refreshing: Promise<string> | undefined

  constructor(private readonly options: GoogleAccountOptions) {}

  /** Read the stored grant. */
  async grant(): Promise<GoogleGrant | undefined> {
    return googleGrantOf(await this.options.credentials.readRecord(this.options.key))
  }

  private async tokenRequest(params: Record<string, string>): Promise<TokenResponse> {
    const response = await fetch(this.options.endpoints.tokenUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams(params),
      signal: AbortSignal.timeout(20_000),
    })
    const body = await response.json() as TokenResponse
    if (!response.ok || body.error !== undefined) {
      throw new Error(`Google token request failed: ${body.error_description ?? body.error ?? String(response.status)}`)
    }
    return body
  }

  /**
   * Build the consent URL for a sign-in.
   * @param services - products to request.
   * @param redirectUri - the loopback listener's URI.
   * @returns the URL with its PKCE verifier and state.
   */
  async authorizationRequest(
    services: readonly GoogleService[], redirectUri: string,
  ): Promise<{ url: string; verifier: string; state: string }> {
    const { clientId } = await this.options.client()
    const verifier = randomBytes(32).toString('base64url')
    const state = randomBytes(16).toString('base64url')
    const url = new URL(this.options.endpoints.authUrl)
    url.search = new URLSearchParams({
      client_id: clientId,
      redirect_uri: redirectUri,
      response_type: 'code',
      scope: ['openid', 'email', ...services.flatMap(service => GOOGLE_SCOPES[service])].join(' '),
      code_challenge: createHash('sha256').update(verifier).digest('base64url'),
      code_challenge_method: 'S256',
      state,
      access_type: 'offline',
      prompt: 'consent',
      include_granted_scopes: 'true',
    }).toString()
    return { url: url.toString(), verifier, state }
  }

  /**
   * Exchange the redirect's code and store the grant.
   * @param services - products that were requested.
   * @param code - authorization code from the redirect.
   * @param verifier - the request's PKCE verifier.
   * @param redirectUri - the redirect URI used in the request.
   * @returns the stored grant; only products whose scopes were all granted are kept.
   */
  async complete(services: readonly GoogleService[], code: string, verifier: string, redirectUri: string): Promise<GoogleGrant> {
    const { clientId, clientSecret } = await this.options.client()
    const tokens = await this.tokenRequest({
      grant_type: 'authorization_code', code, code_verifier: verifier, redirect_uri: redirectUri, client_id: clientId,
      ...(clientSecret === '' ? {} : { client_secret: clientSecret }),
    })
    if (tokens.refresh_token === undefined) {
      throw new Error('Google did not return a refresh token; remove Maitre from your Google account permissions and connect again.')
    }
    const granted = new Set((tokens.scope ?? '').split(' '))
    const allowed = services.filter(service => GOOGLE_SCOPES[service].every(scope => granted.has(scope)))
    if (allowed.length === 0) throw new Error('Google granted none of the requested permissions. Tick the boxes on the consent page and try again.')
    const grant: GoogleGrant = {
      auth: 'google',
      accessToken: tokens.access_token,
      refreshToken: tokens.refresh_token,
      expiresAt: Date.now() + tokens.expires_in * 1000,
      email: await this.fetchEmail(tokens.access_token),
      services: allowed,
    }
    await this.options.credentials.modifyRecord(this.options.key, async () => ({ kind: 'grant', payload: grant }))
    return grant
  }

  private async fetchEmail(accessToken: string): Promise<string> {
    const response = await fetch(this.options.endpoints.userinfoUrl, {
      headers: { authorization: `Bearer ${accessToken}` }, signal: AbortSignal.timeout(15_000),
    })
    if (!response.ok) return ''
    return (await response.json() as { email?: string }).email ?? ''
  }

  /**
   * A valid access token, refreshed when it expires within the refresh margin.
   * @returns the access token.
   * @throws when Google is not connected or the refresh token was revoked.
   */
  async accessToken(): Promise<string> {
    const grant = await this.grant()
    if (grant === undefined) throw new Error('Google is not connected. Connect it on the Connectors page.')
    if (grant.expiresAt - this.options.refreshMarginMs > Date.now()) return grant.accessToken
    return this.refresh()
  }

  /**
   * Refresh the access token now; concurrent callers share one request.
   * @returns the new access token.
   */
  refresh(): Promise<string> {
    this.refreshing ??= this.refreshOnce().finally(() => { this.refreshing = undefined })
    return this.refreshing
  }

  private async refreshOnce(): Promise<string> {
    const { clientId, clientSecret } = await this.options.client()
    const stored = await this.options.credentials.modifyRecord(this.options.key, async (record) => {
      const grant = googleGrantOf(record)
      if (grant === undefined) throw new Error('Google is not connected. Connect it on the Connectors page.')
      // Another process may have refreshed while this one waited for the lock.
      if (grant.expiresAt - this.options.refreshMarginMs > Date.now()) return undefined
      let fresh: TokenResponse
      try {
        fresh = await this.tokenRequest({
          grant_type: 'refresh_token', refresh_token: grant.refreshToken, client_id: clientId,
          ...(clientSecret === '' ? {} : { client_secret: clientSecret }),
        })
      } catch (error) {
        if (/invalid_grant/.test((error as Error).message)) {
          throw new Error('Google access expired or was revoked. Reconnect Google on the Connectors page.', { cause: error })
        }
        throw error
      }
      const next: GoogleGrant = {
        ...grant,
        accessToken: fresh.access_token,
        refreshToken: fresh.refresh_token ?? grant.refreshToken,
        expiresAt: Date.now() + fresh.expires_in * 1000,
      }
      return { kind: 'grant', payload: next }
    })
    const grant = googleGrantOf(stored)
    if (grant === undefined) throw new Error('Google is not connected. Connect it on the Connectors page.')
    return grant.accessToken
  }

  /** Delete the grant, then revoke the refresh token at Google; revocation failures are ignored. */
  async signOut(): Promise<void> {
    const grant = await this.grant()
    await this.options.credentials.deleteRecord(this.options.key)
    if (grant === undefined) return
    try {
      await fetch(`${this.options.endpoints.revokeUrl}?token=${encodeURIComponent(grant.refreshToken)}`, {
        method: 'POST', signal: AbortSignal.timeout(10_000),
      })
    } catch (_revocationFailed) {
      // The local grant is already gone; Google expires an unrevoked token on its own.
    }
  }
}
