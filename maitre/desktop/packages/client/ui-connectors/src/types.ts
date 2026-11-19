/**
 * Client-safe connector vocabulary shared by the Host service and the
 * Connectors page. Types only: no runtime code.
 * @module @deepseek-ai/dsh-client-ui-connectors/types
 */

/** Catalog grouping shown as one section on the Connectors page. */
export type ConnectorCategory = 'google' | 'work' | 'sales' | 'finance' | 'design' | 'developer' | 'data' | 'search' | 'local' | 'custom'

/**
 * How a connector obtains its credential: none, the service's own sign-in page
 * through MCP OAuth, a pasted value (an API key, or a folder for a local
 * server), or the built-in Google sign-in.
 */
export type ConnectorAuth = 'none' | 'oauth' | 'key' | 'google'

/** How the agent reaches the connector's MCP server. */
export type ConnectorTransport = 'http' | 'stdio' | 'builtin'

/** One Google Workspace product the built-in Google connector can expose. */
export type GoogleService = 'gmail' | 'calendar' | 'drive' | 'docs' | 'sheets'

/**
 * Connection phase of one catalog entry.
 * - `disconnected`: nothing stored and no MCP server registered.
 * - `authorizing`: a browser sign-in is open and the Host waits for its redirect.
 * - `connecting`: credentials are stored and the MCP server is starting.
 * - `connected`: the MCP server is connected and its tools are available to every agent preset.
 * - `error`: the last attempt or the live server failed; `error` carries the reason.
 * - `builtin`: a server the deployment configures directly; it cannot be disconnected here.
 */
export type ConnectorPhase = 'disconnected' | 'authorizing' | 'connecting' | 'connected' | 'error' | 'builtin'

/** The value a `key` connector asks for, as the page labels it. */
export interface ConnectorInput {
  /** Field label. */
  label: string
  /** Placeholder text for the input. */
  placeholder: string
  /** Where the user gets the value, as a URL. */
  helpUrl?: string
  /** Whether the value is a secret drawn masked. */
  secret: boolean
}

/** One catalog entry with its live connection state. */
export interface ConnectorView {
  /** Catalog id; also the managed MCP server name. */
  id: string
  /** Product name. */
  name: string
  /** One-sentence description of what the agent can do with it. */
  description: string
  /** Page section. */
  category: ConnectorCategory
  /** One or two letters drawn as the logo. */
  mark: string
  /** Logo background colour as a CSS hex value. */
  color: string
  /** Sign-in method. */
  auth: ConnectorAuth
  /** Transport to the MCP server. */
  transport: ConnectorTransport
  /** Remote endpoint, or the local command line, shown as the server's address. */
  endpoint: string
  /** Documentation URL of the MCP server; empty for custom connectors. */
  docs: string
  /** The value a `key` connector asks for. */
  input?: ConnectorInput
  /** Current phase. */
  phase: ConnectorPhase
  /** Signed-in account, when the service reports one (Google email). */
  account?: string
  /** Number of tools the connected server exposes. */
  toolCount?: number
  /** Failure or wait reason for `error` and `connecting`. */
  error?: string
  /** Authorization page of an open sign-in, for a browser that did not open it. */
  authUrl?: string
  /** Google products granted at the last sign-in. */
  services?: GoogleService[]
  /** Whether connecting is possible in this deployment, and why not. */
  unavailable?: string
}

/** Complete Connectors page state, streamed on every change. */
export interface ConnectorsSnapshot {
  /** Every catalog entry in catalog order. */
  connectors: ConnectorView[]
}

/** One Connect request from the page. */
export interface ConnectRequest {
  /** Catalog id. */
  id: string
  /** Pasted value for `key` connectors. */
  key?: string
  /** Google products to request for the `google` connector. */
  services?: GoogleService[]
}

/** A user-defined remote MCP server. */
export interface CustomConnectorRequest {
  /** Display name; the server name derives from it. */
  name: string
  /** Streamable HTTP endpoint (`https://…`, or `http://` on localhost). */
  url: string
  /** Optional request header carrying an API key, such as `Authorization`. */
  headerName?: string
  /** Header value, such as `Bearer sk-…`; stored in the credentials provider. */
  headerValue?: string
}

/** Immediate result of a Connect request; later progress arrives through the snapshot stream. */
export type ConnectOutcome =
  | { kind: 'connected' }
  | { kind: 'authorizing'; authUrl: string }
  /** `added`: a custom connector was saved even though connecting it failed, so it is listed with its error. */
  | { kind: 'failed'; message: string; added?: boolean }
