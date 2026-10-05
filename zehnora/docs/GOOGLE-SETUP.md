# Google connector setup (Zehnora Desktop)

Zehnora Desktop connects to Google through MCP. Users click **Settings → Connected apps → Connect Google**, sign in with their own Google account in the browser, and the agent can then use Gmail, Calendar, Drive, Docs and Sheets in Chat and Work mode.

## How it works
- **Built-in connector (default):** an MCP server that runs inside the app (`desktop/src/main/google/server.ts`) and calls the Google REST APIs with the user's token. 15 tools:
  - Gmail: `gmail_search`, `gmail_read`, `gmail_create_draft`, `gmail_send` (approval)
  - Calendar: `calendar_list_events`, `calendar_create_event` (no invitation emails), `calendar_delete_event` (approval)
  - Drive: `drive_search`, `drive_read_file`, `drive_create_file`
  - Docs: `docs_create`, `docs_append`
  - Sheets: `sheets_read`, `sheets_write`, `sheets_create`
- **Google's hosted MCP servers (optional):** `https://gmailmcp.googleapis.com/mcp/v1` etc. They are in the Google Workspace **Developer Preview**, so they only work for a project enrolled in that program. Tick "Use Google's hosted MCP servers" under Advanced; the same Google token is sent to them.
- Sign-in is Google's installed-app OAuth flow: PKCE, a loopback redirect to `http://127.0.0.1:<random port>/callback`, `access_type=offline`. The refresh token is stored in the OS keychain (Electron `safeStorage`); access tokens refresh automatically. Disconnect revokes the token at Google.
- Sending mail and deleting events always show the approval card (tool annotations `destructiveHint`); reading and searching run without asking.

## Owner steps (once, in Google Cloud console)
1. Create a project, e.g. "Zehnora Desktop".
2. APIs & Services → Library → enable **Gmail API, Google Calendar API, Google Drive API, Google Docs API, Google Sheets API**.
3. OAuth consent screen (Google Auth Platform → Branding / Audience): app name "Zehnora", support email, audience **External**, publishing status **Testing**.
4. Audience → **Test users**: add the Google accounts of every tester (up to 100). Only these accounts can sign in while the app is in Testing. Refresh tokens of Testing apps expire after 7 days, so testers reconnect weekly.
5. Data access → add scopes: `openid`, `email`, `gmail.readonly`, `gmail.compose`, `calendar.events`, `drive.readonly`, `drive.file`, `documents`, `spreadsheets`.
6. Clients → **Create client → Application type: Desktop app** → name "Zehnora Desktop" → **Download JSON**.
7. Save that file as `zehnora/desktop/build-config/google-oauth.json` (git-ignored; never commit it) and rebuild the installers (`npm run dist:mac`, `npm run dist:win`). The client is then packed into the app and testers only click Connect Google.
   - Without rebuilding: paste the client ID and secret in Settings → Connected apps → Advanced.
   - The client secret of a Desktop-app client is not confidential by Google's definition (it ships inside installed apps); PKCE protects the flow.

## Limits
- Gmail scopes are "restricted": for more than 100 users or a public release, Google requires app verification (and a security assessment for Gmail). Testing mode is enough for the test group.
- While unverified, Google shows "Google hasn't verified this app": testers click **Continue** (only listed test users get this far).

## Other MCP servers
Settings → Connected apps → **Add MCP server** accepts a remote URL (Streamable HTTP, with MCP OAuth sign-in and dynamic client registration; redirect `http://127.0.0.1:33418/mcp/callback`) or a local command (stdio, e.g. `npx -y @modelcontextprotocol/server-filesystem ~/Documents`). Their tools appear to the agent as `<server name>_<tool>`, with approval risk taken from the tools' annotations and names.

## Sign in with Google on the console (console.dubg.dev)

Separate from the Desktop connector above: this lets anyone create a console account with Google. It only asks for `openid email profile`, so the app can be published to all Google users without Google's verification of restricted scopes. Use a **separate Google Cloud project** (e.g. "Zehnora Console") so the Gmail/Drive scopes of the Desktop connector do not hold this one in Testing mode.

1. Google Auth Platform → Branding: app name "Zehnora", support email, app domain `dubg.dev`; Audience: **External**, then **Publish app** (In production).
2. Clients → Create client → **Web application**:
   - Authorized JavaScript origins: `https://console.dubg.dev`
   - Authorized redirect URIs: `https://console.dubg.dev/platform/v1/auth/google/callback`
3. On the GPU PC add to `~/zehnora/.server-secrets/platform.env` (never commit it):
   ```
   ZEHNORA_GOOGLE_CLIENT_ID=<client id>.apps.googleusercontent.com
   ZEHNORA_GOOGLE_CLIENT_SECRET=<client secret>
   ZEHNORA_CONSOLE_URL=https://console.dubg.dev
   ```
   then run `zehnora/scripts/server/start.sh --with-tunnel`. The login and sign-up pages show "Continue with Google" as soon as `/platform/v1/auth/providers` reports `google: true`.

How it works (`platform-api/app/routes_oauth.py`): OpenID Connect code flow with PKCE, state and nonce in a short-lived signed cookie; the ID token comes straight from Google's token endpoint and its issuer, audience, expiry, nonce and `email_verified` are checked. Accounts are matched by Google subject, then by verified email (an existing password account gets Google linked and keeps its password), else a new user with zero credits is created. Tests: `platform-api/tests/test_oauth.py` (mock Google).
