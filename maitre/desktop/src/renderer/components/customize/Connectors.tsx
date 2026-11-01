import { useEffect, useMemo, useState } from 'react';
import type { ReactElement } from 'react';
import type { CatalogEntry } from '../../../shared/catalog';
import type { ConnectorStatus, GoogleService, GoogleSettings, McpServerConfig, McpServerInput, McpTransportType, PluginInfo } from '../../../shared/types';
import { CATALOG_CATEGORIES, MCP_CATALOG, catalogServer, missingFields } from '../../../shared/catalog';
import { Empty, ErrorNote, ExternalLink, Mark, Toggle, useAction, useLive } from './shared';
import { GOOGLE_SERVICES } from '../../../shared/types';
import { Icon } from '../Icon';
import { api } from '../../state';

const SERVICE_LABEL: Record<GoogleService, string> = { gmail: 'Gmail', calendar: 'Calendar', drive: 'Drive', docs: 'Docs', sheets: 'Sheets' };
const STATE_LABEL: Record<ConnectorStatus['state'], string> = { connected: 'Connected', connecting: 'Connecting…', disconnected: 'Off', 'needs-auth': 'Sign-in needed', error: 'Error' };
const DOT: Record<ConnectorStatus['state'], string> = { connected: 'online', connecting: 'live', disconnected: 'offline', 'needs-auth': 'no-key', error: 'unauthorized' };
const AUTH_LABEL: Record<CatalogEntry['auth'], string> = { none: 'No sign-in', oauth: 'Sign in with the app', key: 'Needs a key' };
const REQUIRES_LABEL: Record<NonNullable<CatalogEntry['requires']>, { name: string; url: string }> = {
  npx: { name: 'Node.js', url: 'https://nodejs.org/en/download' },
  uvx: { name: 'uv (Python)', url: 'https://docs.astral.sh/uv/getting-started/installation/' },
};

function GoogleCard({ statuses, initial }: { statuses: ConnectorStatus[]; initial: GoogleSettings }): ReactElement {
  const [google, setGoogle] = useState(initial);
  const [advanced, setAdvanced] = useState(!initial.clientId);
  const { busy, error, run } = useAction();
  const parts = statuses.filter((status) => status.kind === 'google');
  const connected = parts.filter((status) => status.state === 'connected');
  const account = parts.find((status) => status.account)?.account;
  const state = connected.length ? 'connected' : (parts[0]?.state ?? 'disconnected');
  const toggle = (service: GoogleService): void =>
    setGoogle({ ...google, services: google.services.includes(service) ? google.services.filter((s) => s !== service) : [...google.services, service] });
  const connect = (): Promise<boolean> => run('connect', async () => {
    await api().saveSettings({ google });
    await api().connectGoogle(google.services);
  });

  return (
    <div className="connector">
      <div className="connector-head">
        <span className="connector-logo google" aria-hidden="true">G</span>
        <div className="connector-title">
          <div>Google</div>
          <div className="field-note"><span className={`dot ${DOT[state]}`} /> {busy ? 'Waiting for Google sign-in in your browser…' : account ? `${STATE_LABEL[state]} as ${account}` : parts[0]?.detail ?? STATE_LABEL[state]}</div>
        </div>
        {account && <button type="button" className="btn small" disabled={busy !== null} onClick={() => run('disconnect', () => api().disconnectGoogle())}>Disconnect</button>}
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
        <button type="button" className="btn primary small" disabled={busy !== null || !google.services.length || !google.clientId} onClick={connect}>
          {account ? 'Reconnect with these services' : 'Connect Google'}
        </button>
        <button type="button" className="link" onClick={() => setAdvanced(!advanced)}>{advanced ? 'Hide advanced' : 'Advanced'}</button>
      </div>
      {connected.length > 0 && <div className="field-note">{connected.reduce((sum, status) => sum + status.tools.length, 0)} tools available to the agent in Chat and Work.</div>}
      <ErrorNote error={error} />
      {advanced && (
        <div className="connector-advanced">
          <div className="grid2">
            <label>
              OAuth client ID
              <input value={google.clientId} onChange={(event) => setGoogle({ ...google, clientId: event.target.value.trim() })} placeholder="….apps.googleusercontent.com" spellCheck={false} />
            </label>
            <label>
              OAuth client secret
              <input type="password" value={google.clientSecret} onChange={(event) => setGoogle({ ...google, clientSecret: event.target.value.trim() })} placeholder="GOCSPX-…" autoComplete="off" />
            </label>
          </div>
          <label className="check">
            <input type="checkbox" checked={google.official} onChange={(event) => setGoogle({ ...google, official: event.target.checked })} />
            Use Google's hosted MCP servers (needs the Workspace Developer Preview) instead of the built-in connector
          </label>
        </div>
      )}
    </div>
  );
}

/** `KEY=value` / `Header: value` lines ↔ a record. Saved values are hidden, so editing shows only the keys. */
const toLines = (keys: string[] | undefined, separator: string): string => (keys ?? []).map((key) => `${key}${separator}`).join('\n');

function fromLines(text: string, separator: '=' | ':'): Record<string, string> {
  return Object.fromEntries(text.split('\n').map((line) => line.trim()).filter(Boolean).map((line) => {
    const at = line.indexOf(separator);
    return at < 0 ? [line, ''] : [line.slice(0, at).trim(), line.slice(at + 1).trim()];
  }));
}

const EMPTY_SERVER: McpServerConfig = { id: '', name: '', type: 'http', url: '', command: '', args: [], enabled: true };

function ServerForm({ initial, onDone }: { initial: McpServerConfig; onDone(): void }): ReactElement {
  const [draft, setDraft] = useState(initial);
  const [argsText, setArgsText] = useState((initial.args ?? []).map((arg) => (/\s/.test(arg) ? JSON.stringify(arg) : arg)).join(' '));
  const [envText, setEnvText] = useState(toLines(initial.envKeys, '='));
  const [headerText, setHeaderText] = useState(toLines(initial.headerKeys, ': '));
  const { busy, error, run } = useAction();
  const editing = Boolean(initial.id);
  const save = async (): Promise<void> => {
    const args = [...argsText.matchAll(/"([^"]*)"|'([^']*)'|(\S+)/g)].map((match) => match[1] ?? match[2] ?? match[3]);
    const input: McpServerInput = { ...draft, args, env: fromLines(envText, '='), headers: fromLines(headerText, ':') };
    if (await run('save', () => api().saveMcpServer(input))) onDone();
  };
  return (
    <div className="connector-advanced form-card">
      <div className="grid2">
        <label>
          Name
          <input value={draft.name} onChange={(event) => setDraft({ ...draft, name: event.target.value })} placeholder="e.g. Notion" autoFocus={!editing} />
        </label>
        <label>
          Type
          <select value={draft.type} onChange={(event) => setDraft({ ...draft, type: event.target.value as McpTransportType })}>
            <option value="http">Remote URL (Streamable HTTP)</option>
            <option value="sse">Remote URL (SSE, older servers)</option>
            <option value="stdio">Local command (stdio)</option>
          </select>
        </label>
      </div>
      {draft.type === 'stdio' ? (
        <>
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
          <label>
            Environment variables (one KEY=value per line)
            <textarea className="short mono" value={envText} onChange={(event) => setEnvText(event.target.value)} placeholder="API_KEY=…" spellCheck={false} />
            {editing && (initial.envKeys?.length ?? 0) > 0 && <span className="field-hint">Saved values are hidden. Leave a value empty to keep it.</span>}
          </label>
        </>
      ) : (
        <>
          <label>
            Server URL
            <input value={draft.url ?? ''} onChange={(event) => setDraft({ ...draft, url: event.target.value })} placeholder="https://example.com/mcp" spellCheck={false} />
          </label>
          <label>
            Headers (optional, one Name: value per line)
            <textarea className="short mono" value={headerText} onChange={(event) => setHeaderText(event.target.value)} placeholder="Authorization: Bearer …" spellCheck={false} />
            <span className="field-hint">{editing && (initial.headerKeys?.length ?? 0) > 0 ? 'Saved values are hidden. Leave a value empty to keep it. ' : ''}Servers that use OAuth open their sign-in page in your browser instead.</span>
          </label>
        </>
      )}
      <ErrorNote error={error} />
      <div className="connector-actions">
        <button type="button" className="btn primary small" disabled={busy !== null || !draft.name.trim()} onClick={save}>{busy ? 'Connecting…' : editing ? 'Save and reconnect' : 'Add and connect'}</button>
        <button type="button" className="btn small" onClick={onDone}>Cancel</button>
      </div>
    </div>
  );
}

function ImportJson({ onDone }: { onDone(): void }): ReactElement {
  const [text, setText] = useState('');
  const [added, setAdded] = useState(0);
  const { busy, error, run } = useAction();
  return (
    <div className="connector-advanced form-card">
      <label>
        Paste an MCP config (Claude Desktop, Claude Code, Cursor or VS Code format)
        <textarea className="code-area" value={text} onChange={(event) => setText(event.target.value)} spellCheck={false}
                  placeholder={'{\n  "mcpServers": {\n    "memory": { "command": "npx", "args": ["-y", "@modelcontextprotocol/server-memory"] },\n    "linear": { "url": "https://mcp.linear.app/mcp" }\n  }\n}'} />
      </label>
      <ErrorNote error={error} />
      {added > 0 && <div className="field-note ok">Added {added} server{added > 1 ? 's' : ''}.</div>}
      <div className="connector-actions">
        <button type="button" className="btn primary small" disabled={busy !== null || !text.trim()} onClick={() => run('import', async () => { setAdded(await api().importMcpJson(text)); setText(''); })}>{busy ? 'Adding…' : 'Add servers'}</button>
        <button type="button" className="btn small" onClick={onDone}>Close</button>
      </div>
    </div>
  );
}

function ServerRow({ server, status, onEdit }: { server: McpServerConfig; status?: ConnectorStatus; onEdit(): void }): ReactElement {
  const [open, setOpen] = useState(false);
  const { busy, error, run } = useAction();
  const state = server.enabled ? status?.state ?? 'disconnected' : 'disconnected';
  const target = server.type === 'stdio' ? `${server.command} ${(server.args ?? []).join(' ')}` : server.url;
  const catalog = MCP_CATALOG.find((entry) => entry.id === server.catalogId);
  return (
    <div className={`item ${server.enabled ? '' : 'off'}`}>
      <div className="item-head">
        <button type="button" className="item-main" onClick={() => setOpen(!open)} aria-expanded={open}>
          {catalog ? <Mark text={catalog.mark} color={catalog.color} /> : <span className="item-icon"><Icon name="plug" size={15} /></span>}
          <span className="item-text">
            <span className="item-title">{server.name}</span>
            <span className="item-sub"><span className={`dot ${DOT[state]}`} /> {busy ? 'Working…' : !server.enabled ? 'Off' : state === 'connected' ? `${status?.tools.length ?? 0} tools` : status?.detail ?? STATE_LABEL[state]}</span>
          </span>
        </button>
        {server.enabled && state !== 'connected' && state !== 'connecting' && (
          <button type="button" className="btn small" disabled={busy !== null} onClick={() => run('reconnect', () => api().reconnectMcpServer(server.id))}>{state === 'needs-auth' ? 'Sign in' : 'Retry'}</button>
        )}
        <Toggle checked={server.enabled} label={`${server.enabled ? 'Turn off' : 'Turn on'} ${server.name}`} onChange={(enabled) => run('toggle', () => api().saveMcpServer({ ...server, enabled }))} />
      </div>
      {open && (
        <div className="item-body">
          <div className="field-note"><code>{target}</code></div>
          {status?.tools.length ? <div className="tool-chips">{status.tools.map((tool) => <code key={tool}>{tool}</code>)}</div> : null}
          <div className="connector-actions">
            <button type="button" className="btn small" onClick={onEdit}>Edit</button>
            {server.enabled && <button type="button" className="btn small" disabled={busy !== null} onClick={() => run('reconnect', () => api().reconnectMcpServer(server.id))}>Reconnect</button>}
            <button type="button" className="btn small danger" disabled={busy !== null} onClick={() => run('remove', () => api().removeMcpServer(server.id))}>Remove</button>
          </div>
        </div>
      )}
      <ErrorNote error={error} />
    </div>
  );
}

function PluginServerRow({ status, missing }: { status: ConnectorStatus; missing: string[] }): ReactElement {
  const [values, setValues] = useState<Record<string, string>>({});
  const { busy, error, run } = useAction();
  return (
    <div className="item">
      <div className="item-head">
        <div className="item-main static">
          <span className="item-icon"><Icon name="puzzle" size={15} /></span>
          <span className="item-text">
            <span className="item-title">{status.name}<span className="tag">plugin {status.plugin}</span></span>
            <span className="item-sub"><span className={`dot ${DOT[status.state]}`} /> {busy ? 'Working…' : status.state === 'connected' ? `${status.tools.length} tools` : status.detail}</span>
          </span>
        </div>
        {status.state !== 'connected' && status.state !== 'connecting' && !missing.length && (
          <button type="button" className="btn small" disabled={busy !== null} onClick={() => run('reconnect', () => api().reconnectMcpServer(status.id))}>{status.state === 'needs-auth' ? 'Sign in' : 'Retry'}</button>
        )}
      </div>
      {missing.length > 0 && (
        <div className="item-body">
          <div className="grid2">
            {missing.map((name) => (
              <label key={name}>
                {name}
                <input type="password" value={values[name] ?? ''} onChange={(event) => setValues({ ...values, [name]: event.target.value })} autoComplete="off" spellCheck={false} />
              </label>
            ))}
          </div>
          <button type="button" className="btn primary small" disabled={busy !== null || missing.some((name) => !values[name]?.trim())} onClick={() => run('vars', () => api().setServerVars(status.id, values))}>Save and connect</button>
        </div>
      )}
      <ErrorNote error={error} />
    </div>
  );
}

function CatalogCard({ entry, added, missingProgram }: { entry: CatalogEntry; added: boolean; missingProgram: boolean }): ReactElement {
  const [values, setValues] = useState<Record<string, string>>({});
  const [form, setForm] = useState(false);
  const { busy, error, run } = useAction();
  const add = (): Promise<boolean> => run('add', async () => {
    const missing = missingFields(entry, values);
    if (missing.length) throw new Error(`Fill in: ${missing.map((field) => field.label).join(', ')}`);
    await api().saveMcpServer(catalogServer(entry, values));
    setForm(false);
  });
  const pickFolder = async (key: string): Promise<void> => {
    const dir = await api().chooseDirectory(values[key]);
    if (dir) setValues({ ...values, [key]: dir });
  };
  const requires = entry.requires ? REQUIRES_LABEL[entry.requires] : null;
  return (
    <div className="card">
      <div className="card-head">
        <Mark text={entry.mark} color={entry.color} />
        <div className="card-title">
          <div>{entry.name}</div>
          <div className="card-badges">
            <span className={`badge ${entry.auth}`}>{AUTH_LABEL[entry.auth]}</span>
            {requires && <span className={`badge ${missingProgram ? 'warn' : ''}`}>{missingProgram ? `Install ${requires.name} first` : entry.type === 'stdio' ? 'Runs on this computer' : ''}</span>}
          </div>
        </div>
      </div>
      <p className="card-text">{entry.description}</p>
      {form && (
        <div className="card-form">
          {(entry.fields ?? []).map((field) => (
            <label key={field.key}>
              {field.label}
              {field.folder ? (
                <div className="input-row">
                  <input value={values[field.key] ?? ''} onChange={(event) => setValues({ ...values, [field.key]: event.target.value })} spellCheck={false} />
                  <button type="button" className="btn small" onClick={() => pickFolder(field.key)}>Choose…</button>
                </div>
              ) : (
                <input type={field.secret ? 'password' : 'text'} value={values[field.key] ?? ''} placeholder={field.placeholder} autoComplete="off" spellCheck={false}
                       onChange={(event) => setValues({ ...values, [field.key]: event.target.value })} />
              )}
              {field.help && <span className="field-hint">{field.help}</span>}
            </label>
          ))}
        </div>
      )}
      <ErrorNote error={error} />
      <div className="card-actions">
        {added ? (
          <span className="field-note ok"><Icon name="check" size={14} /> Added</span>
        ) : missingProgram && requires ? (
          <ExternalLink href={requires.url}>Get {requires.name}</ExternalLink>
        ) : (
          <button type="button" className="btn primary small" disabled={busy !== null} onClick={() => (entry.fields?.length && !form ? setForm(true) : add())}>
            {busy ? (entry.auth === 'oauth' ? 'Sign in in your browser…' : 'Connecting…') : form ? 'Connect' : 'Add'}
          </button>
        )}
        {form && !busy && <button type="button" className="btn small" onClick={() => setForm(false)}>Cancel</button>}
        <ExternalLink href={entry.docs}>Docs</ExternalLink>
      </div>
    </div>
  );
}

function Gallery({ servers }: { servers: McpServerConfig[] }): ReactElement {
  const [query, setQuery] = useState('');
  const [category, setCategory] = useState<string>('All');
  const [programs, setPrograms] = useState<Record<string, boolean>>({});
  useEffect(() => {
    const needed = [...new Set(MCP_CATALOG.map((entry) => entry.requires).filter((value): value is NonNullable<CatalogEntry['requires']> => Boolean(value)))];
    api().checkCommands(needed).then((checks) => setPrograms(Object.fromEntries(checks.map((check) => [check.command, check.found]))));
  }, []);
  const added = new Set(servers.map((server) => server.catalogId).filter(Boolean));
  const shown = useMemo(() => {
    const words = query.toLowerCase().split(/\s+/).filter(Boolean);
    return MCP_CATALOG.filter((entry) => (category === 'All' || entry.category === category) && words.every((word) => `${entry.name} ${entry.description}`.toLowerCase().includes(word)));
  }, [query, category]);
  return (
    <section className="group">
      <div className="group-head"><h4>Gallery</h4><span>Popular MCP servers, ready to add.</span></div>
      <div className="filters">
        <input className="search" value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Search apps" aria-label="Search apps" />
        <div className="segmented">
          {['All', ...CATALOG_CATEGORIES].map((name) => <button key={name} type="button" className={category === name ? 'on' : ''} onClick={() => setCategory(name)}>{name}</button>)}
        </div>
      </div>
      <div className="cards">
        {shown.map((entry) => (
          <CatalogCard key={entry.id} entry={entry} added={added.has(entry.id)} missingProgram={Boolean(entry.requires) && programs[entry.requires!] === false} />
        ))}
      </div>
    </section>
  );
}

export function ConnectorsTab({ statuses, servers, google }: { statuses: ConnectorStatus[]; servers: McpServerConfig[]; google: GoogleSettings }): ReactElement {
  const [form, setForm] = useState<McpServerConfig | 'import' | null>(null);
  const [plugins] = useLive(() => api().listPlugins(), ['plugins', 'connectors'], [] as PluginInfo[]);
  const byId = new Map(statuses.map((status) => [status.id, status]));
  const missingById = new Map(plugins.flatMap((plugin) => plugin.servers.map((server): [string, string[]] => [server.id, server.missingVars])));
  const pluginStatuses = statuses.filter((status) => status.kind === 'plugin');
  const totalTools = statuses.filter((status) => status.state === 'connected').reduce((sum, status) => sum + status.tools.length, 0);

  return (
    <div className="tab-body">
      <div className="tab-intro">
        <p>Connectors (MCP servers) give Maitre tools for your apps and services, in Chat and Work. {totalTools > 0 && <b>{totalTools} tools connected.</b>} Actions that send, delete or share still ask you first.</p>
      </div>
      <section className="group">
        <div className="group-head"><h4>Your connectors</h4></div>
        <GoogleCard statuses={statuses} initial={google} />
        {servers.map((server) => (form && form !== 'import' && form.id === server.id
          ? <ServerForm key={server.id} initial={server} onDone={() => setForm(null)} />
          : <ServerRow key={server.id} server={server} status={byId.get(server.id)} onEdit={() => setForm(server)} />))}
        {pluginStatuses.map((status) => <PluginServerRow key={status.id} status={status} missing={missingById.get(status.id) ?? []} />)}
        {!servers.length && !pluginStatuses.length && <Empty>Add one from the gallery below, or your own server.</Empty>}
        {form === 'import' ? <ImportJson onDone={() => setForm(null)} /> : form && !form.id ? <ServerForm initial={form} onDone={() => setForm(null)} /> : (
          <div className="connector-actions">
            <button type="button" className="btn small" onClick={() => setForm(EMPTY_SERVER)}><Icon name="plus" size={14} /> Custom server</button>
            <button type="button" className="btn small" onClick={() => setForm('import')}>Paste JSON config</button>
          </div>
        )}
      </section>
      <Gallery servers={servers} />
    </div>
  );
}
