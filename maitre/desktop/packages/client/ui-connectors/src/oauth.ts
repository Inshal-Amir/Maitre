/**
 * MCP authorization (OAuth 2.1 with PKCE and dynamic client registration) for
 * remote MCP servers, driven by the MCP SDK's `auth()` state machine. The
 * provider keeps its whole state in one credentials record, so a sign-in
 * survives a Host restart and refreshes from any process holding the record.
 */

import { randomBytes } from 'node:crypto'
import { auth } from '@modelcontextprotocol/client'
import type {
  OAuthClientMetadata, OAuthClientProvider, OAuthDiscoveryState, StoredOAuthClientInformation, StoredOAuthTokens,
} from '@modelcontextprotocol/client'
import type { CredentialKey, CredentialProvider, CredentialRecord } from '@deepseek-ai/dsh-credentials'

/** What one OAuth connector keeps in its credentials record. */
export interface OAuthGrant {
  readonly auth: 'oauth'
  readonly serverUrl: string
  /** Redirect URI the client was registered with; a changed port forces a fresh registration. */
  readonly redirectUrl: string
  readonly client?: StoredOAuthClientInformation | undefined
  readonly tokens?: StoredOAuthTokens | undefined
  /** Epoch milliseconds the access token expires; absent when the server did not say. */
  readonly expiresAt?: number | undefined
  readonly verifier?: string | undefined
  readonly discovery?: OAuthDiscoveryState | undefined
}

/** Narrow a stored grant payload to an OAuth grant. */
export function oauthGrantOf(record: CredentialRecord | undefined): OAuthGrant | undefined {
  if (record?.kind !== 'grant') return undefined
  const payload = record.payload as { auth?: unknown } | null
  return payload !== null && typeof payload === 'object' && payload.auth === 'oauth' ? record.payload as OAuthGrant : undefined
}

/** Inputs of one provider instance. */
export interface McpOAuthOptions {
  readonly credentials: CredentialProvider
  readonly key: CredentialKey
  readonly serverUrl: string
  readonly redirectUrl: string
  readonly clientName: string
  /** Called when the SDK asks the user to visit the authorization page. */
  readonly onAuthorizationUrl: (url: URL) => Promise<void>
}

/** SDK `OAuthClientProvider` over one credentials record. */
export class McpOAuthProvider implements OAuthClientProvider {
  /** `state` sent with the last authorization request; the redirect must echo it. */
  expectedState: string | undefined

  constructor(private readonly options: McpOAuthOptions) {}

  state(): string {
    this.expectedState = randomBytes(16).toString('base64url')
    return this.expectedState
  }

  get redirectUrl(): string {
    return this.options.redirectUrl
  }

  get clientMetadata(): OAuthClientMetadata {
    return {
      client_name: this.options.clientName,
      redirect_uris: [this.options.redirectUrl],
      grant_types: ['authorization_code', 'refresh_token'],
      response_types: ['code'],
      token_endpoint_auth_method: 'none',
    }
  }

  /** Read the stored grant, dropping a client registered for another redirect URI. */
  async grant(): Promise<OAuthGrant | undefined> {
    const grant = oauthGrantOf(await this.options.credentials.readRecord(this.options.key))
    if (grant === undefined || grant.serverUrl !== this.options.serverUrl) return undefined
    return grant
  }

  private async update(patch: (current: OAuthGrant) => OAuthGrant): Promise<void> {
    await this.options.credentials.modifyRecord(this.options.key, async (record) => {
      const stored = oauthGrantOf(record)
      const current: OAuthGrant = stored !== undefined && stored.serverUrl === this.options.serverUrl
        ? stored
        : { auth: 'oauth', serverUrl: this.options.serverUrl, redirectUrl: this.options.redirectUrl }
      // Stored records hold JSON only: the round trip drops fields the patch cleared to `undefined`.
      return { kind: 'grant', payload: JSON.parse(JSON.stringify(patch(current))) as OAuthGrant }
    })
  }

  async clientInformation(): Promise<StoredOAuthClientInformation | undefined> {
    const grant = await this.grant()
    return grant?.redirectUrl === this.options.redirectUrl ? grant.client : undefined
  }

  async saveClientInformation(client: StoredOAuthClientInformation): Promise<void> {
    await this.update(current => ({ ...current, redirectUrl: this.options.redirectUrl, client }))
  }

  async tokens(): Promise<StoredOAuthTokens | undefined> {
    return (await this.grant())?.tokens
  }

  async saveTokens(tokens: StoredOAuthTokens): Promise<void> {
    const expiresAt = tokens.expires_in === undefined ? undefined : Date.now() + tokens.expires_in * 1000
    await this.update(current => ({
      ...current,
      // A refresh response may omit the refresh token; the previous one stays valid then.
      tokens: { ...tokens, refresh_token: tokens.refresh_token ?? current.tokens?.refresh_token },
      expiresAt,
    }))
  }

  async redirectToAuthorization(authorizationUrl: URL): Promise<void> {
    await this.options.onAuthorizationUrl(authorizationUrl)
  }

  async saveCodeVerifier(verifier: string): Promise<void> {
    await this.update(current => ({ ...current, verifier }))
  }

  async codeVerifier(): Promise<string> {
    const verifier = (await this.grant())?.verifier
    if (verifier === undefined) throw new Error('No PKCE verifier is stored for this sign-in.')
    return verifier
  }

  async saveDiscoveryState(discovery: OAuthDiscoveryState): Promise<void> {
    await this.update(current => ({ ...current, discovery }))
  }

  async discoveryState(): Promise<OAuthDiscoveryState | undefined> {
    return (await this.grant())?.discovery
  }

  async invalidateCredentials(scope: 'all' | 'client' | 'tokens' | 'verifier' | 'discovery'): Promise<void> {
    await this.update((current) => {
      switch (scope) {
        case 'all': return { auth: 'oauth', serverUrl: current.serverUrl, redirectUrl: current.redirectUrl }
        case 'client': return { ...current, client: undefined }
        case 'tokens': return { ...current, tokens: undefined, expiresAt: undefined }
        case 'verifier': return { ...current, verifier: undefined }
        case 'discovery': return { ...current, discovery: undefined }
      }
    })
  }
}

/**
 * Start or finish authorization. Without a code, a stored refresh token is
 * used first; when none works the SDK registers the client if needed and
 * calls `redirectToAuthorization`.
 * @param provider - the connector's provider.
 * @param serverUrl - the MCP endpoint.
 * @param authorizationCode - code from the redirect, to exchange for tokens.
 * @param iss - authorization server issuer from the redirect, when sent.
 * @returns `AUTHORIZED` when tokens are stored, `REDIRECT` when the user must sign in.
 */
export function authorize(provider: McpOAuthProvider, serverUrl: string, authorizationCode?: string, iss?: string): Promise<'AUTHORIZED' | 'REDIRECT'> {
  return auth(provider, {
    serverUrl,
    ...(authorizationCode === undefined ? {} : { authorizationCode }),
    ...(iss === undefined ? {} : { iss }),
  })
}
