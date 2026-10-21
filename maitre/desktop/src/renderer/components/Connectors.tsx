import { useState } from 'react';
import type { ReactElement } from 'react';
import type { ConnectorStatus, GoogleService, GoogleSettings, McpServerConfig } from '../../shared/types';
import { GOOGLE_SERVICES } from '../../shared/types';
import { api } from '../state';

const SERVICE_LABEL: Record<GoogleService, string> = { gmail: 'Gmail', calendar: 'Calendar', drive: 'Drive', docs: 'Docs', sheets: 'Sheets' };
const STATE_LABEL: Record<ConnectorStatus['state'], string> = { connected: 'Connected', connecting: 'Connecting…', disconnected: 'Not connected', 'needs-auth': 'Sign-in needed', error: 'Error' };
const DOT: Record<ConnectorStatus['state'], string> = { connected: 'online', connecting: 'live', disconnected: 'offline', 'needs-auth': 'no-key', error: 'unauthorized' };

const cleanError = (error: Error): string => error.message.replace(/^Error invoking remote method '[^']+': (\w*Error: )?/, '');

function GoogleCard({ statuses, google, onGoogle, saveGoogle }: {
  statuses: ConnectorStatus[];
  google: GoogleSettings;
  onGoogle(google: GoogleSettings): void;
  saveGoogle(): Promise<void>;
}): ReactElement {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [advanced, setAdvanced] = useState(!google.clientId);
  const parts = statuses.filter((status) => status.kind === 'google');
  const connected = parts.filter((status) => status.state === 'connected');
  const account = parts.find((status) => status.account)?.account;
  const state = connected.length ? 'connected' : (parts[0]?.state ?? 'disconnected');
  const toggle = (service: GoogleService): void =>
    onGoogle({ ...google, services: google.services.includes(service) ? google.services.filter((s) => s !== service) : [...google.services, service] });

  const run = async (action: () => Promise<unknown>): Promise<void> => {
    setBusy(true);
    setError('');
    try {
      await action();
    } catch (failure) {
      setError(cleanError(failure as Error));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="connector">
      <div className="connector-head">
        <span className="connector-logo google" aria-hidden="true">G</span>
        <div className="connector-title">
          <div>Google</div>
          <div className="field-note"><span className={`dot ${DOT[state]}`} /> {busy ? 'Waiting for Google sign-in in your browser…' : account ? `${STATE_LABEL[state]} as ${account}` : parts[0]?.detail ?? STATE_LABEL[state]}</div>
        </div>
        {account ? (
          <button type="button" className="btn small" disabled={busy} onClick={() => run(() => api().disconnectGoogle())}>Disconnect</button>
        ) : null}
      </div>
      <div className="service-list" role="group" aria-label="Google services">
        {GOOGLE_SERVICES.map((service) => (
          <label key={service} className={`service ${google.services.includes(service) ? 'on' : ''}`}>
            <input type="checkbox" checked={google.services.includes(service)} onChange={() => toggle(service)} />
            {SERVICE_LABEL[service]}
          </label>
        ))}
      </div>
      <div className="connector-actions">
        <button type="button" className="btn primary small" disabled={busy || !google.services.length || !google.clientId} onClick={() => run(async () => { await saveGoogle(); await api().connectGoogle(google.services); })}>
          {account ? 'Reconnect with these services' : 'Connect Google'}
        </button>
        <button type="button" className="link" onClick={() => setAdvanced(!advanced)}>{advanced ? 'Hide advanced' : 'Advanced'}</button>
      </div>
      {connected.length > 0 && <div className="field-note">{connected.reduce((sum, status) => sum + status.tools.length, 0)} tools available to the agent in Chat and Work.</div>}
      {error && <div className="step-error" role="alert">{error}</div>}
      {advanced && (
        <div className="connector-advanced">
          <div className="grid2">
            <label>
              OAuth client ID
              <input value={google.clientId} onChange={(event) => onGoogle({ ...google, clientId: event.target.value.trim() })} placeholder="….apps.googleusercontent.com" spellCheck={false} />
            </label>
            <label>
              OAuth client secret
              <input type="password" value={google.clientSecret} onChange={(event) => onGoogle({ ...google, clientSecret: event.target.value.trim() })} placeholder="GOCSPX-…" autoComplete="off" />
            </label>
          </div>
          <label className="check">
            <input type="checkbox" checked={google.official} onChange={(event) => onGoogle({ ...google, official: event.target.checked })} />
            Use Google's hosted MCP servers (needs the Workspace Developer Preview) instead of the built-in connector
          </label>
        </div>
      )}
    </div>
  );
}

const EMPTY_SERVER: McpServerConfig = { id: '', name: '', type: 'http', url: '', command: '', args: [], enabled: true };

function CustomServers({ statuses, servers }: { statuses: ConnectorStatus[]; servers: McpServerConfig[] }): ReactElement {
  const [draft, setDraft] = useState<McpServerConfig | null>(null);
  const [argsText, setArgsText] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const byId = new Map(statuses.map((status) => [status.id, status]));

  const save = async (): Promise<void> => {
    if (!draft) return;
    setBusy(true);
    setError('');
    try {
      await api().saveMcpServer({ ...draft, args: argsText.split(/\s+/).filter(Boolean) });
      setDraft(null);
    } catch (failure) {
      setError(cleanError(failure as Error));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="custom-servers">
      {servers.map((server) => {
        const status = byId.get(server.id);
        const state = status?.state ?? 'disconnected';
        return (
          <div key={server.id} className="connector-row">
            <span className={`dot ${DOT[state]}`} />
            <div className="connector-title">
              <div>{server.name}</div>
              <div className="field-note">{server.type === 'http' ? server.url : `${server.command} ${(server.args ?? []).join(' ')}`} · {state === 'connected' ? `${status?.tools.length ?? 0} tools` : status?.detail ?? STATE_LABEL[state]}</div>
            </div>
            <button type="button" className="btn small" onClick={() => api().reconnectMcpServer(server.id)}>{state === 'needs-auth' ? 'Sign in' : 'Reconnect'}</button>
            <button type="button" className="btn small danger" onClick={() => api().removeMcpServer(server.id)}>Remove</button>
          </div>
        );
      })}
      {draft ? (
        <div className="connector-advanced">
          <div className="grid2">
            <label>
              Name
              <input value={draft.name} onChange={(event) => setDraft({ ...draft, name: event.target.value })} placeholder="e.g. Notion" />
            </label>
            <label>
              Type
              <select value={draft.type} onChange={(event) => setDraft({ ...draft, type: event.target.value === 'stdio' ? 'stdio' : 'http' })}>
                <option value="http">Remote URL (Streamable HTTP)</option>
                <option value="stdio">Local command (stdio)</option>
              </select>
            </label>
          </div>
          {draft.type === 'http' ? (
            <label>
              Server URL
              <input value={draft.url ?? ''} onChange={(event) => setDraft({ ...draft, url: event.target.value })} placeholder="https://example.com/mcp" spellCheck={false} />
            </label>
          ) : (
            <div className="grid2">
              <label>
                Command
                <input value={draft.command ?? ''} onChange={(event) => setDraft({ ...draft, command: event.target.value })} placeholder="npx" spellCheck={false} />
              </label>
              <label>
                Arguments
                <input value={argsText} onChange={(event) => setArgsText(event.target.value)} placeholder="-y @modelcontextprotocol/server-filesystem ~/Documents" spellCheck={false} />
              </label>
            </div>
          )}
          {error && <div className="step-error" role="alert">{error}</div>}
          <div className="connector-actions">
            <button type="button" className="btn primary small" disabled={busy || !draft.name.trim()} onClick={save}>{busy ? 'Connecting…' : 'Add and connect'}</button>
            <button type="button" className="btn small" onClick={() => setDraft(null)}>Cancel</button>
          </div>
        </div>
      ) : (
        <button type="button" className="btn small" onClick={() => { setDraft(EMPTY_SERVER); setArgsText(''); }}>+ Add MCP server</button>
      )}
    </div>
  );
}

export function Connectors({ statuses, servers, google, onGoogle, saveGoogle }: {
  statuses: ConnectorStatus[];
  servers: McpServerConfig[];
  google: GoogleSettings;
  onGoogle(google: GoogleSettings): void;
  saveGoogle(): Promise<void>;
}): ReactElement {
  return (
    <section>
      <h3>Connected apps</h3>
      <GoogleCard statuses={statuses} google={google} onGoogle={onGoogle} saveGoogle={saveGoogle} />
      <CustomServers statuses={statuses.filter((status) => status.kind === 'custom')} servers={servers} />
    </section>
  );
}
