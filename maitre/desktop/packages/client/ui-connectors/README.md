---
description: "Maitre Connectors page: sign in to Google, Notion, Linear, GitHub and other apps that offer MCP servers, and give their tools to every agent preset."
kind: "package-reference"
---

# @deepseek-ai/dsh-client-ui-connectors

## Summary

The **Connectors** sidebar entry lists a catalog of apps that offer MCP servers, grouped by category and searchable. Connecting an app signs the user in (MCP OAuth with dynamic client registration, a pasted API key, or the built-in Google sign-in) and registers the app's server with [`dsh-mcp-manager`](../../mcp/mcp-manager/README.md) through `ctx.mcpManager.register()`. Managed servers are global, so their tools reach the Chat and Work presets alike. **Add custom connector** connects any Streamable HTTP MCP server by URL, with an optional API-key header or OAuth when the server answers 401.

## Use this package

Mount one row per Host; the web-app bundle does:

```yaml
- id: ui-connectors
  name: '@deepseek-ai/dsh-client-ui-connectors'
  inject: [credentials, mcpManager]
  config:
    googleClientFile: /path/to/google-oauth.json
```

| Field | Default | Meaning |
|---|---|---|
| `redirectPort` | `33418` | Fixed loopback port of the MCP OAuth redirect (`http://127.0.0.1:<port>/mcp/callback`); dynamically registered clients are bound to it |
| `signInTimeoutMs` | `300000` | How long a browser sign-in may take |
| `refreshMarginMs` | `120000` | Refresh access tokens this long before they expire |
| `openSystemBrowser` | `false` | Also open the authorization page with the OS browser; the page always opens it in a tab it owns |
| `clientName` | `Maitre` | Client name sent in dynamic client registration |
| `googleClientFile` | `''` | Google OAuth client JSON (installed/Desktop client); read at each sign-in and refresh, never copied |
| `googleOAuthBase` / `googleApiBase` | `''` | Test origins replacing Google's OAuth endpoints and REST APIs |

### Storage

Each connected app has a credentials record `connectors/<id>` naming its sign-in kind (and, for a custom connector, its name, URL, and header name). OAuth and Google grants live in `connector-tokens/<id>`. The value a registered entry needs at connection time (an OAuth access token, an API key, a folder) lives in the credentials reference `CONNECTOR_<ID>`, which the entry names through a `${credential:CONNECTOR_<ID>}` template; rotating it makes mcp-client replace the connection. At Host start every recorded app is registered again.

### Sign-in kinds

- **oauth**: the MCP SDK's `auth()` discovers protected-resource and authorization-server metadata, registers a client, and builds a PKCE authorization URL with `state`. The Host listens on the loopback redirect, exchanges the code, and stores the token. A timer refreshes the token `refreshMarginMs` before expiry; a 401 from the server triggers one refresh and restart per minute.
- **key**: the value is stored in the reference and templated into a header, the URL, an environment variable, or the argument list, as the catalog entry says.
- **google**: Google's installed-app OAuth flow with PKCE on an ephemeral loopback port, requesting only the chosen products' scopes and keeping the products whose scopes were all granted. The Host serves the built-in Google Workspace MCP server (Gmail, Calendar, Drive, Docs, Sheets tools) on `127.0.0.1` behind a per-process bearer secret and registers it as `google`; each Google API call refreshes the access token when it expires within the margin.
- **none**: the server is registered as is.

Disconnecting unregisters the server, revokes OAuth tokens at the authorization server's `revocation_endpoint` when it advertises one (Google: its revoke endpoint), and deletes the reference and both records. Servers the deployment configures directly in mcp-manager (DeepWiki and Context7 in the web-app bundle) show as **Always on**.

### Remote operations

`ctx.remote.connectors`: `watch(signal)` streams the complete page state; `connect({ id, key?, services? })`, `addCustom({ name, url, headerName?, headerValue? })`, `disconnect(id)`, and `cancel(id)`. A sign-in returns `{ kind: 'authorizing', authUrl }` as soon as the authorization page is known.

## Model Experience

Indirectly, through the mcp-client instances that mcp-manager mounts for connected apps, whose server-qualified tools enter requests; this package adds no prompt or tool content itself.

#### KV Cache effect

Connecting or disconnecting an app changes the tool definitions exactly as the mcp-manager and mcp-client READMEs document; a token rotation replaces a connection without changing tool definitions once the new connection lists the same tools.

## Known Limitations and Deferred Work

- **Loopback redirects** — OAuth redirects go to `127.0.0.1` on the Host, so a sign-in completes only in a browser on the Host machine.
- **No usable dynamic client registration** — catalog entries whose authorization server has no registration endpoint (Asana, Slack, Box, HubSpot, Zoom, Docusign, Xero, PagerDuty, Render), refuses self-registered clients (Figma, Dropbox, Railway, Similarweb, ZoomInfo), accepts only `https` redirects (Calendly), or requires vendor scopes at registration (Gong) are listed as unavailable until a pre-registered client is configured.
- **SSE-only servers** — mcp-client speaks Streamable HTTP and stdio only, so legacy SSE endpoints are not offered.
- **Fixed redirect port** — two MCP OAuth sign-ins cannot run at the same time.
- **Local servers** — stdio entries need `npx` or `uvx` on the Host's PATH and download their package on first start.
