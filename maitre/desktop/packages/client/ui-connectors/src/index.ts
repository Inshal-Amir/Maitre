/**
 * Connectors, Host half (`ctx.connectors`): signs the user in to apps that
 * offer MCP servers and registers each connected app with `ctx.mcpManager`,
 * so its tools reach every agent preset.
 *
 * - `oauth` connectors run MCP authorization (dynamic client registration,
 *   PKCE, loopback redirect) and keep the access token in a credentials
 *   reference that the registered entry's `Authorization` header templates;
 *   the token is refreshed before it expires and after a 401.
 * - `key` connectors store the pasted value in a credentials reference used
 *   by a header, URL, environment variable, or argument template.
 * - `google` runs Google's installed-app OAuth flow and serves the built-in
 *   Google Workspace MCP server on a loopback port behind a per-process secret.
 * - Custom connectors are user-entered Streamable HTTP servers, with an
 *   optional API-key header or OAuth when the server asks for it.
 *
 * Connection markers and grants are credentials records, so connected apps
 * reconnect when the Host restarts. Disconnecting withdraws the server,
 * revokes what the provider lets us revoke, and deletes every stored value.
 *
 * @module @deepseek-ai/dsh-client-ui-connectors
 */

import { randomBytes } from 'node:crypto'
import { existsSync, statSync } from 'node:fs'
import { delimiter, join } from 'node:path'
import { Context, Service } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { Remote, TypertRemoteService } from '@deepseek-ai/dsh-typert-protocol'
import { credentialKey, credentialKeyId, credentialKeyScope, credentialRef } from '@deepseek-ai/dsh-credentials'
import type { CredentialRef } from '@deepseek-ai/dsh-credentials'
import type { McpServerRegistration } from '@deepseek-ai/dsh-mcp-manager'
import type { McpManagedServerStatus, McpManagedServerView } from '@deepseek-ai/dsh-mcp-manager/types'
import { CATALOG, GOOGLE_SERVICES } from './catalog.ts'
import type { CatalogEntry } from './catalog.ts'
import { GoogleAccount, googleEndpoints, readGoogleClient } from './google/auth.ts'
import { serveGoogle } from './google/server.ts'
import { listenForRedirect, openSystemBrowser } from './loopback.ts'
import type { LoopbackListener } from './loopback.ts'
import { authorize, McpOAuthProvider } from './oauth.ts'
import type {
  ConnectOutcome, ConnectorPhase, ConnectorsSnapshot, ConnectorView, ConnectRequest, CustomConnectorRequest, GoogleService,
} from './types.ts'

export type * from './types.ts'

declare module '@deepseek-ai/cordis' {
  interface Context {
    connectors: ConnectorService
  }
}

/** Connector sign-in policy. */
export interface Config {
  /** Fixed loopback port for MCP OAuth redirects; dynamic client registration binds the client to it. */
  redirectPort: number
  /** How long a browser sign-in may take. */
  signInTimeoutMs: number
  /** Refresh access tokens this long before they expire. */
  refreshMarginMs: number
  /** Also open the authorization page with the operating system's browser; the page opens it in a tab either way. */
  openSystemBrowser: boolean
  /** Client name shown on authorization pages. */
  clientName: string
  /** Google OAuth client JSON file (an installed/Desktop client); read at each sign-in and refresh. */
  googleClientFile: string
  /** Origin replacing every Google OAuth endpoint, for tests; empty for Google. */
  googleOAuthBase: string
  /** Origin replacing every Google REST API, for tests; empty for Google. */
  googleApiBase: string
}

const SCOPE = 'connectors'
const TOKEN_SCOPE = 'connector-tokens'
const REDIRECT_PATH = '/mcp/callback'
const ID_PATTERN = /^[a-z][a-z0-9-]{0,31}$/

/** What a connected app's marker record says about it. */
type Marker =
  | { readonly auth: 'none' | 'key' | 'oauth' | 'google' }
  | { readonly auth: 'custom'; readonly name: string; readonly url: string; readonly headerName?: string; readonly oauth: boolean }

type CustomMarker = Extract<Marker, { auth: 'custom' }>

/** A live registration with the MCP manager. */
interface Binding {
  readonly dispose: () => Promise<void>
  readonly account?: string
  readonly services?: GoogleService[]
}

/** An open browser sign-in. */
interface Attempt {
  readonly abort: AbortController
  authUrl?: string
}

const refName = (id: string): CredentialRef => credentialRef(`CONNECTOR_${id.toUpperCase().replace(/-/g, '_')}`)
const template = (ref: CredentialRef): string => `\${credential:${ref}}`
const message = (error: unknown): string => error instanceof Error ? error.message : String(error)

function isMarker(value: unknown): value is Marker {
  if (value === null || typeof value !== 'object') return false
  const auth = (value as { auth?: unknown }).auth
  return auth === 'none' || auth === 'key' || auth === 'oauth' || auth === 'google' || auth === 'custom'
}

function onPath(command: string): boolean {
  const dirs = (process.env.PATH ?? '').split(delimiter).filter(dir => dir !== '')
  const extensions = process.platform === 'win32' ? ['', '.cmd', '.exe', '.bat'] : ['']
  return dirs.some(dir => extensions.some((extension) => {
    const file = join(dir, `${command}${extension}`)
    return existsSync(file) && statSync(file).isFile()
  }))
}

function customEntry(id: string, marker: CustomMarker): CatalogEntry {
  return {
    id, name: marker.name, category: 'custom', mark: marker.name.replace(/[^A-Za-z0-9]/g, '').slice(0, 2) || 'MC', color: '#64748b',
    description: marker.url, docs: '', auth: marker.oauth ? 'oauth' : marker.headerName === undefined ? 'none' : 'key',
    server: { transport: 'http', url: marker.url },
  }
}

/** Connector sign-in and MCP registration service. */
export default class ConnectorService extends TypertRemoteService {
  static Config: z<Partial<Config>, Config> = z.object({
    redirectPort: z.natural().min(1).max(65535).default(33418),
    signInTimeoutMs: z.natural().min(1000).default(300_000),
    refreshMarginMs: z.natural().default(120_000),
    openSystemBrowser: z.boolean().default(false),
    clientName: z.string().default('Maitre'),
    googleClientFile: z.string().default(''),
    googleOAuthBase: z.string().default(''),
    googleApiBase: z.string().default(''),
  })

  static inject = ['mcpManager', 'credentials']

  private readonly bindings = new Map<string, Binding>()
  private readonly attempts = new Map<string, Attempt>()
  private readonly errors = new Map<string, string>()
  private readonly customs = new Map<string, CustomMarker>()
  private readonly refreshTimers = new Map<string, NodeJS.Timeout>()
  private readonly refreshing = new Map<string, Promise<void>>()
  private readonly lastAuthRefresh = new Map<string, number>()
  private readonly watchers = new Set<() => void>()
  private readonly lifetime = new AbortController()
  private readonly programs = new Map<string, boolean>()
  private readonly google: GoogleAccount

  constructor(ctx: Context, private readonly config: Config) {
    super(ctx, 'connectors')
    this.google = new GoogleAccount({
      credentials: ctx.credentials,
      key: credentialKey(TOKEN_SCOPE, 'google'),
      endpoints: googleEndpoints(config.googleOAuthBase),
      client: () => readGoogleClient(config.googleClientFile),
      refreshMarginMs: config.refreshMarginMs,
    })
  }

  * [Service.init](): Generator<() => Promise<void> | void, void, void> {
    yield async () => {
      this.lifetime.abort()
      for (const attempt of this.attempts.values()) attempt.abort.abort()
      for (const timer of this.refreshTimers.values()) clearTimeout(timer)
      for (const binding of this.bindings.values()) await binding.dispose()
      this.bindings.clear()
    }
    this.ctx.on('mcp-manager/status', (name, status) => {
      this.changed()
      this.onServerStatus(name, status)
    })
    void this.ctx.fiber.await().then(() => this.restore(), () => undefined)
  }

  /** Re-register every app connected before the Host started. */
  private async restore(): Promise<void> {
    let entries
    try {
      entries = await this.ctx.credentials.listRecords()
    } catch (error) {
      this.ctx.logger.warn('connectors: cannot list stored connections: %s', message(error))
      return
    }
    await Promise.all(entries.filter(entry => credentialKeyScope(entry.key) === SCOPE).map(async (entry) => {
      const id = credentialKeyId(entry.key)
      try {
        const record = await this.ctx.credentials.readRecord(entry.key)
        const marker = record?.kind === 'grant' ? record.payload : undefined
        if (!isMarker(marker)) return
        if (marker.auth === 'custom') this.customs.set(id, marker)
        if (this.entry(id) === undefined) return
        if (marker.auth === 'oauth' || (marker.auth === 'custom' && marker.oauth)) {
          const entry = this.entry(id)
          const grant = entry === undefined ? undefined : await this.oauthProvider(id, this.serverUrl(entry), async () => undefined).grant()
          if (grant?.tokens === undefined) {
            this.errors.set(id, 'Sign in again to reconnect.')
            return
          }
          await this.refreshIfDue(id)
        }
        await this.bind(id)
      } catch (error) {
        this.errors.set(id, message(error))
      }
    }))
    this.changed()
  }

  private entry(id: string): CatalogEntry | undefined {
    const custom = this.customs.get(id)
    return custom === undefined ? CATALOG.find(entry => entry.id === id) : customEntry(id, custom)
  }

  private serverUrl(entry: CatalogEntry): string {
    return entry.server.transport === 'http' ? entry.server.url : ''
  }

  private oauthProvider(id: string, serverUrl: string, onAuthorizationUrl: (url: URL) => Promise<void>): McpOAuthProvider {
    return new McpOAuthProvider({
      credentials: this.ctx.credentials,
      key: credentialKey(TOKEN_SCOPE, id),
      serverUrl,
      redirectUrl: `http://127.0.0.1:${String(this.config.redirectPort)}${REDIRECT_PATH}`,
      clientName: this.config.clientName,
      onAuthorizationUrl,
    })
  }

  // ── snapshot and watch ───────────────────────────────────────────────────

  private unavailable(entry: CatalogEntry): string | undefined {
    if (entry.unavailable !== undefined) return entry.unavailable
    if (entry.server.transport === 'stdio') {
      const { command } = entry.server
      let found = this.programs.get(command)
      if (found === undefined) {
        found = onPath(command)
        this.programs.set(command, found)
      }
      if (!found) return command === 'npx' ? 'Needs Node.js (npx) installed on this computer.' : 'Needs uv (uvx) installed on this computer.'
    }
    if (entry.auth === 'google' && (this.config.googleClientFile === '' || !existsSync(this.config.googleClientFile))) {
      return 'No Google OAuth client is configured on this computer (set MAITRE_GOOGLE_OAUTH_FILE).'
    }
    return undefined
  }

  private view(entry: CatalogEntry, servers: ReadonlyMap<string, McpManagedServerView>): ConnectorView {
    const server = servers.get(entry.id)
    const binding = this.bindings.get(entry.id)
    const attempt = this.attempts.get(entry.id)
    const unavailable = this.unavailable(entry)
    const base: ConnectorView = {
      id: entry.id, name: entry.name, description: entry.description, category: entry.category, mark: entry.mark, color: entry.color,
      auth: entry.auth, docs: entry.docs,
      transport: entry.server.transport,
      endpoint: entry.server.transport === 'http'
        ? entry.server.url.replace('{value}', '…')
        : entry.server.transport === 'stdio' ? [entry.server.command, ...entry.server.args].join(' ') : 'Built in',
      ...(entry.input === undefined ? {} : {
        input: {
          label: entry.input.label,
          placeholder: entry.input.placeholder,
          secret: entry.input.secret,
          ...(entry.input.helpUrl === undefined ? {} : { helpUrl: entry.input.helpUrl }),
        },
      }),
      ...(unavailable === undefined ? {} : { unavailable }),
      ...(binding?.account === undefined || binding.account === '' ? {} : { account: binding.account }),
      ...(binding?.services === undefined ? {} : { services: binding.services }),
      phase: 'disconnected',
    }
    if (attempt !== undefined) return { ...base, phase: 'authorizing', ...(attempt.authUrl === undefined ? {} : { authUrl: attempt.authUrl }) }
    if (binding === undefined && server?.configured === true) {
      return { ...base, ...this.statusView(server.status), phase: this.builtinPhase(server.status) }
    }
    const error = this.errors.get(entry.id)
    if (binding === undefined) return error === undefined ? base : { ...base, phase: 'error', error }
    const status = this.statusView(server?.status)
    return error === undefined || status.phase === 'connected' ? { ...base, ...status } : { ...base, ...status, phase: 'error', error }
  }

  private builtinPhase(status: McpManagedServerStatus): ConnectorPhase {
    return status.state === 'failed' ? 'error' : 'builtin'
  }

  private statusView(status: McpManagedServerStatus | undefined): Pick<ConnectorView, 'phase' | 'toolCount' | 'error'> {
    if (status === undefined) return { phase: 'connecting' }
    switch (status.state) {
      case 'connected': return { phase: 'connected', toolCount: status.toolCount }
      case 'connecting': return { phase: 'connecting' }
      case 'reconnecting': return { phase: 'connecting', error: status.lastError }
      case 'waiting-credentials': return { phase: 'connecting', error: status.lastError }
      case 'failed': return { phase: 'error', error: 'lastError' in status && status.lastError !== undefined ? status.lastError : 'The server stopped.' }
      case 'disabled': return { phase: 'disconnected' }
      case 'closed': return { phase: 'connecting' }
    }
  }

  /**
   * The complete page state.
   * @returns every catalog entry followed by custom connectors, with live phases.
   */
  snapshot(): ConnectorsSnapshot {
    const servers = new Map(this.ctx.mcpManager.list().map(view => [view.name, view]))
    const customs = [...this.customs].map(([id, marker]) => customEntry(id, marker))
    return { connectors: [...CATALOG, ...customs].map(entry => this.view(entry, servers)) }
  }

  private changed(): void {
    for (const notify of this.watchers) notify()
  }

  /**
   * Stream page state: the current snapshot on subscription, then again after every change.
   * @param signal - subscription lifetime.
   * @returns coalesced snapshots until the subscriber or the service stops.
   */
  @Remote({ mode: 'stream' })
  async* watch(signal: AbortSignal): AsyncIterable<ConnectorsSnapshot> {
    const ended = AbortSignal.any([signal, this.lifetime.signal])
    const aborted = (): boolean => ended.aborted
    let wake = Promise.withResolvers<void>()
    let dirty = true
    const notify = (): void => {
      dirty = true
      wake.resolve()
    }
    this.watchers.add(notify)
    ended.addEventListener('abort', notify, { once: true })
    try {
      while (!aborted()) {
        if (!dirty) await wake.promise
        if (aborted()) break
        dirty = false
        wake = Promise.withResolvers<void>()
        yield this.snapshot()
      }
    } finally {
      this.watchers.delete(notify)
      ended.removeEventListener('abort', notify)
    }
  }

  // ── connect ──────────────────────────────────────────────────────────────

  /**
   * Connect one catalog or custom entry. Browser sign-ins return as soon as
   * the authorization page is known; completion arrives through `watch`.
   * @param request - entry id plus a key or Google products when the entry needs them.
   * @returns connected, authorizing with the page to open, or failed with a reason.
   */
  @Remote
  async connect(request: ConnectRequest): Promise<ConnectOutcome> {
    const entry = this.entry(request.id)
    if (entry === undefined) return { kind: 'failed', message: `Unknown connector "${request.id}".` }
    const unavailable = this.unavailable(entry)
    if (unavailable !== undefined) return { kind: 'failed', message: unavailable }
    if (this.ctx.mcpManager.config.servers.get()[entry.id] !== undefined) return { kind: 'connected' }
    const bound = this.bindings.get(entry.id)
    if (bound !== undefined && entry.auth !== 'oauth') return { kind: 'connected' }
    if (bound !== undefined) {
      // Signing in again replaces a connection whose token stopped working.
      this.bindings.delete(entry.id)
      await bound.dispose()
    }
    this.attempts.get(entry.id)?.abort.abort()
    this.errors.delete(entry.id)
    try {
      switch (entry.auth) {
        case 'none':
          await this.mark(entry.id, this.customs.get(entry.id) ?? { auth: 'none' })
          await this.bind(entry.id)
          return { kind: 'connected' }
        case 'key': {
          const key = request.key?.trim() ?? ''
          if (key === '') return { kind: 'failed', message: `Enter the ${entry.input?.label.toLowerCase() ?? 'key'} first.` }
          await this.ctx.credentials.set(refName(entry.id), key)
          await this.mark(entry.id, { auth: 'key' })
          await this.bind(entry.id)
          return { kind: 'connected' }
        }
        case 'oauth':
          return await this.startOAuth(entry)
        case 'google':
          return await this.startGoogle(request.services?.filter(service => GOOGLE_SERVICES.includes(service)) ?? [...GOOGLE_SERVICES])
      }
    } catch (error) {
      this.errors.set(entry.id, message(error))
      this.changed()
      return { kind: 'failed', message: message(error) }
    }
  }

  /**
   * Add a user-defined Streamable HTTP server and connect it. Without a
   * header, a server that answers 401 is signed in with OAuth.
   * @param request - name, URL, and optional API-key header.
   * @returns the same outcomes as {@link connect}.
   */
  @Remote
  async addCustom(request: CustomConnectorRequest): Promise<ConnectOutcome> {
    const name = request.name.trim().slice(0, 40)
    if (name === '') return { kind: 'failed', message: 'Enter a name for the connector.' }
    let url: URL
    try {
      url = new URL(request.url.trim())
    } catch (_invalidUrl) {
      return { kind: 'failed', message: 'Enter the server URL, such as https://example.com/mcp.' }
    }
    const local = url.hostname === '127.0.0.1' || url.hostname === 'localhost' || url.hostname === '[::1]'
    if (url.protocol !== 'https:' && !(url.protocol === 'http:' && local)) return { kind: 'failed', message: 'The URL must start with https:// (http:// only for this computer).' }
    const headerName = request.headerName?.trim() ?? ''
    const headerValue = request.headerValue?.trim() ?? ''
    if ((headerName === '') !== (headerValue === '')) return { kind: 'failed', message: 'Enter both the header name and its value, or neither.' }
    if (headerName !== '' && !/^[A-Za-z0-9-]{1,80}$/.test(headerName)) return { kind: 'failed', message: 'The header name may use letters, digits and dashes only.' }
    const slug = name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 20) || 'server'
    let id = `custom-${slug}`
    for (let n = 2; this.entry(id) !== undefined; n++) id = `custom-${slug}-${String(n)}`
    if (!ID_PATTERN.test(id)) return { kind: 'failed', message: 'Choose a shorter name.' }
    let oauth = false
    if (headerName === '') {
      const answer = await this.probeAuth(url.href)
      if (answer === 'unreachable') return { kind: 'failed', message: `${url.href} did not answer as an MCP server.` }
      oauth = answer === 'oauth'
    } else {
      await this.ctx.credentials.set(refName(id), headerValue)
    }
    const marker: CustomMarker = { auth: 'custom', name, url: url.href, oauth, ...(headerName === '' ? {} : { headerName }) }
    this.customs.set(id, marker)
    await this.mark(id, marker)
    this.changed()
    if (!oauth) {
      try {
        await this.bind(id)
      } catch (error) {
        this.errors.set(id, message(error))
        this.changed()
        return { kind: 'failed', message: message(error), added: true }
      }
      return { kind: 'connected' }
    }
    const outcome = await this.connect({ id })
    return outcome.kind === 'failed' ? { ...outcome, added: true } : outcome
  }

  /** Send MCP `initialize` without credentials to learn whether the server needs sign-in. */
  private async probeAuth(url: string): Promise<'open' | 'oauth' | 'unreachable'> {
    try {
      const response = await fetch(url, {
        method: 'POST',
        signal: AbortSignal.timeout(15_000),
        headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: this.config.clientName, version: '1' } } }),
      })
      await response.body?.cancel()
      if (response.status === 401) return 'oauth'
      return response.ok ? 'open' : 'unreachable'
    } catch (_unreachable) {
      return 'unreachable'
    }
  }

  private async mark(id: string, marker: Marker): Promise<void> {
    await this.ctx.credentials.modifyRecord(credentialKey(SCOPE, id), async () => ({ kind: 'grant', payload: marker }))
  }

  private async startOAuth(entry: CatalogEntry): Promise<ConnectOutcome> {
    const serverUrl = this.serverUrl(entry)
    const attempt: Attempt = { abort: new AbortController() }
    this.attempts.set(entry.id, attempt)
    this.changed()
    const pageReady = Promise.withResolvers<string>()
    let listener: LoopbackListener | undefined
    const provider = this.oauthProvider(entry.id, serverUrl, async (url) => {
      listener = await listenForRedirect(this.config.redirectPort, REDIRECT_PATH, this.config.signInTimeoutMs, attempt.abort.signal)
      this.showAuthorizationPage(entry, attempt, url.href)
      pageReady.resolve(url.href)
    })
    const flow = (async (): Promise<void> => {
      if (await authorize(provider, serverUrl) === 'REDIRECT') {
        if (listener === undefined) throw new Error('The server asked for sign-in but no sign-in page was opened.')
        const redirect = await listener.result
        if (provider.expectedState !== undefined && redirect.state !== provider.expectedState) throw new Error('The sign-in response did not match this request; try again.')
        await authorize(provider, serverUrl, redirect.code, redirect.iss)
      }
      await this.storeAccessToken(entry.id, provider)
      const custom = this.customs.get(entry.id)
      await this.mark(entry.id, custom ?? { auth: 'oauth' })
      await this.bind(entry.id)
    })()
    const finished = this.settleAttempt(entry.id, attempt, flow, () => listener?.close())
    return Promise.race([
      finished.then((error): ConnectOutcome => error === undefined ? { kind: 'connected' } : { kind: 'failed', message: error }),
      pageReady.promise.then((authUrl): ConnectOutcome => ({ kind: 'authorizing', authUrl })),
    ])
  }

  private async startGoogle(services: GoogleService[]): Promise<ConnectOutcome> {
    if (services.length === 0) return { kind: 'failed', message: 'Choose at least one Google product.' }
    const entry = this.entry('google')
    if (entry === undefined) return { kind: 'failed', message: 'Google is not in the catalog.' }
    const attempt: Attempt = { abort: new AbortController() }
    this.attempts.set('google', attempt)
    this.changed()
    let listener: LoopbackListener | undefined
    try {
      // Google installed-app clients accept any loopback port, so each sign-in takes a free one.
      listener = await listenForRedirect(0, '/callback', this.config.signInTimeoutMs, attempt.abort.signal)
      const request = await this.google.authorizationRequest(services, listener.redirectUri)
      this.showAuthorizationPage(entry, attempt, request.url)
      const bound = listener
      const flow = (async (): Promise<void> => {
        const redirect = await bound.result
        if (redirect.state !== request.state) throw new Error('The sign-in response did not match this request; try again.')
        await this.google.complete(services, redirect.code, request.verifier, bound.redirectUri)
        await this.mark('google', { auth: 'google' })
        const previous = this.bindings.get('google')
        this.bindings.delete('google')
        await previous?.dispose()
        await this.bind('google')
      })()
      void this.settleAttempt('google', attempt, flow, () => bound.close())
      return { kind: 'authorizing', authUrl: request.url }
    } catch (error) {
      listener?.close()
      this.attempts.delete('google')
      throw error
    }
  }

  private showAuthorizationPage(entry: CatalogEntry, attempt: Attempt, url: string): void {
    attempt.authUrl = url
    this.ctx.logger.info('connectors: %s sign-in page: %s', entry.id, url)
    this.changed()
    if (this.config.openSystemBrowser) {
      openSystemBrowser(url).catch((error: unknown) => {
        this.ctx.logger.warn('connectors: cannot open the browser: %s', message(error))
      })
    }
  }

  /** Record a sign-in's end: the attempt is removed and a failure becomes the entry's error. */
  private async settleAttempt(id: string, attempt: Attempt, flow: Promise<void>, close: () => void): Promise<string | undefined> {
    let failure: string | undefined
    try {
      await flow
    } catch (error) {
      failure = attempt.abort.signal.aborted ? undefined : message(error)
      if (failure !== undefined) {
        this.ctx.logger.warn('connectors: %s sign-in failed: %s', id, failure)
        this.errors.set(id, failure)
      }
    } finally {
      close()
      if (this.attempts.get(id) === attempt) this.attempts.delete(id)
      this.changed()
    }
    return failure
  }

  /**
   * Stop an open browser sign-in.
   * @param id - the entry whose sign-in to stop.
   */
  @Remote
  async cancel(id: string): Promise<void> {
    this.attempts.get(id)?.abort.abort()
    this.attempts.delete(id)
    this.changed()
  }

  // ── tokens ───────────────────────────────────────────────────────────────

  private async storeAccessToken(id: string, provider: McpOAuthProvider): Promise<void> {
    const grant = await provider.grant()
    const token = grant?.tokens?.access_token
    if (token === undefined) throw new Error('The server returned no access token.')
    await this.ctx.credentials.set(refName(id), token)
    this.scheduleRefresh(id, grant?.expiresAt)
  }

  private scheduleRefresh(id: string, expiresAt: number | undefined): void {
    clearTimeout(this.refreshTimers.get(id))
    this.refreshTimers.delete(id)
    if (expiresAt === undefined || this.lifetime.signal.aborted) return
    const delay = Math.max(10_000, Math.min(expiresAt - this.config.refreshMarginMs - Date.now(), 2 ** 31 - 1))
    const timer = setTimeout(() => { void this.refreshOAuth(id) }, delay)
    timer.unref()
    this.refreshTimers.set(id, timer)
  }

  private async refreshIfDue(id: string): Promise<void> {
    const entry = this.entry(id)
    if (entry === undefined) return
    const grant = await this.oauthProvider(id, this.serverUrl(entry), async () => undefined).grant()
    if (grant?.expiresAt !== undefined && grant.expiresAt - this.config.refreshMarginMs <= Date.now()) await this.refreshOAuth(id)
    else this.scheduleRefresh(id, grant?.expiresAt)
  }

  /** Refresh one OAuth connector's access token; concurrent callers share one refresh. */
  private refreshOAuth(id: string): Promise<void> {
    let running = this.refreshing.get(id)
    if (running !== undefined) return running
    running = (async () => {
      const entry = this.entry(id)
      if (entry === undefined || this.lifetime.signal.aborted) return
      const provider = this.oauthProvider(id, this.serverUrl(entry), async () => {
        throw new Error('Sign-in expired. Connect again.')
      })
      try {
        if (await authorize(provider, this.serverUrl(entry)) === 'AUTHORIZED') {
          await this.storeAccessToken(id, provider)
          this.errors.delete(id)
          this.ctx.logger.info('connectors: refreshed the %s access token', id)
        }
      } catch (error) {
        this.errors.set(id, message(error))
        this.ctx.logger.warn('connectors: %s token refresh failed: %s', id, message(error))
      }
      this.changed()
    })().finally(() => { this.refreshing.delete(id) })
    this.refreshing.set(id, running)
    return running
  }

  /** Refresh after the server rejected the token, at most once a minute per connector. */
  private onServerStatus(name: string, status: McpManagedServerStatus): void {
    if (!this.bindings.has(name)) return
    const entry = this.entry(name)
    if (entry?.auth !== 'oauth') return
    const lastError = 'lastError' in status ? status.lastError ?? '' : ''
    if (!/\b401\b|unauthori[sz]ed|invalid_token/i.test(lastError)) return
    const last = this.lastAuthRefresh.get(name) ?? 0
    if (Date.now() - last < 60_000) return
    this.lastAuthRefresh.set(name, Date.now())
    void this.refreshOAuth(name).then(() => this.ctx.mcpManager.restart(name)).catch((error: unknown) => {
      this.ctx.logger.warn('connectors: %s restart after refresh failed: %s', name, message(error))
    })
  }

  // ── registration ─────────────────────────────────────────────────────────

  private registration(entry: CatalogEntry): McpServerRegistration {
    const ref = template(refName(entry.id))
    const { server, input } = entry
    if (server.transport === 'stdio') {
      const args = [...server.args, ...(input?.target.kind === 'arg' ? [ref] : [])]
      const env = input?.target.kind === 'env' ? { [input.target.name]: ref } : {}
      return { transport: 'stdio', command: server.command, args, env, startupTimeoutMs: 120_000 }
    }
    if (server.transport === 'builtin') throw new Error(`${entry.name} has no remote server.`)
    const custom = this.customs.get(entry.id)
    const headers: Record<string, string> = {}
    let url = server.url
    if (entry.auth === 'oauth') headers.Authorization = `Bearer ${ref}`
    if (custom?.headerName !== undefined) headers[custom.headerName] = ref
    if (input?.target.kind === 'header') headers[input.target.name] = input.target.format.replace('{value}', ref)
    if (input?.target.kind === 'url') url = url.replace('{value}', ref)
    return { transport: 'streamable-http', url, headers }
  }

  private async bind(id: string): Promise<void> {
    if (this.bindings.has(id) || this.lifetime.signal.aborted) return
    const entry = this.entry(id)
    if (entry === undefined) throw new Error(`Unknown connector "${id}".`)
    if (entry.auth === 'google') {
      const grant = await this.google.grant()
      if (grant === undefined) throw new Error('Google is not signed in.')
      const secret = randomBytes(24).toString('hex')
      const endpoint = await serveGoogle(grant.services, () => this.google.accessToken(), this.config.googleApiBase, secret)
      let unregister: () => void
      try {
        unregister = this.ctx.mcpManager.register(id, { transport: 'streamable-http', url: endpoint.url, headers: { Authorization: `Bearer ${secret}` } })
      } catch (error) {
        await endpoint.close()
        throw error
      }
      this.bindings.set(id, {
        account: grant.email, services: grant.services,
        dispose: async () => {
          unregister()
          await endpoint.close()
        },
      })
    } else {
      const unregister = this.ctx.mcpManager.register(id, this.registration(entry))
      this.bindings.set(id, { dispose: async () => { unregister() } })
    }
    this.errors.delete(id)
    this.changed()
  }

  // ── disconnect ───────────────────────────────────────────────────────────

  /**
   * Disconnect one entry: withdraw its MCP server and tools, revoke the grant
   * where the provider allows it, and delete every stored value. A custom
   * connector is removed from the list.
   * @param id - the entry to disconnect.
   */
  @Remote
  async disconnect(id: string): Promise<void> {
    const entry = this.entry(id)
    if (entry === undefined) return
    this.attempts.get(id)?.abort.abort()
    this.attempts.delete(id)
    clearTimeout(this.refreshTimers.get(id))
    this.refreshTimers.delete(id)
    const binding = this.bindings.get(id)
    this.bindings.delete(id)
    await binding?.dispose()
    if (entry.auth === 'google') {
      await this.google.signOut()
    } else if (entry.auth === 'oauth') {
      await this.revokeOAuth(id, this.serverUrl(entry))
    }
    await this.ctx.credentials.unset(refName(id))
    await this.ctx.credentials.deleteRecord(credentialKey(TOKEN_SCOPE, id))
    await this.ctx.credentials.deleteRecord(credentialKey(SCOPE, id))
    this.customs.delete(id)
    this.errors.delete(id)
    this.changed()
  }

  /** Revoke the refresh and access tokens at the authorization server's revocation endpoint (RFC 7009), when it has one. */
  private async revokeOAuth(id: string, serverUrl: string): Promise<void> {
    const grant = await this.oauthProvider(id, serverUrl, async () => undefined).grant()
    const endpoint = (grant?.discovery?.authorizationServerMetadata as { revocation_endpoint?: string } | undefined)?.revocation_endpoint
    const clientId = grant?.client?.client_id
    if (endpoint === undefined || clientId === undefined) return
    const tokens = [grant?.tokens?.refresh_token, grant?.tokens?.access_token].filter((token): token is string => token !== undefined)
    await Promise.all(tokens.map(async (token) => {
      try {
        await fetch(endpoint, {
          method: 'POST',
          headers: { 'content-type': 'application/x-www-form-urlencoded' },
          body: new URLSearchParams({ token, client_id: clientId }),
          signal: AbortSignal.timeout(10_000),
        })
      } catch (error) {
        this.ctx.logger.warn('connectors: %s token revocation failed: %s', id, message(error))
      }
    }))
  }
}
