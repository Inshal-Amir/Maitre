import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { shell } from 'electron';
import type { CommandCheck, ConnectorStatus, GoogleService, McpServerConfig, McpServerInput, McpTransportType } from '../../shared/types';
import type { PluginServer } from '../plugins';
import type { Tool } from '../tools/types';
import { McpManager, GOOGLE_OFFICIAL_URLS, bearerHttpTransport, customSpec, inProcessTransport } from './manager';
import { getSettings, readSecret, saveSettings, writeSecret } from '../settings';
import { accessToken, account, signIn, signOut } from '../google/auth';
import { expandSpec, requiredVars, transportOf } from '../plugins/manifest';
import { createGoogleServer } from '../google/server';
import { savedVars } from '../plugins';
import { childEnv } from '../tools/shell';
import { OAuthProvider } from './oauth';

const GOOGLE_ID = 'google';
const SERVICE_NAMES: Record<GoogleService, string> = { gmail: 'Gmail', calendar: 'Calendar', drive: 'Drive', docs: 'Docs', sheets: 'Sheets' };
const ID_PATTERN = /^[a-z0-9-]{1,40}$/;
const HEADER_NAME = /^[A-Za-z0-9-]{1,80}$/;
const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]{0,80}$/;

/** Env and header values of a custom server, kept encrypted out of settings.json. */
interface ServerSecrets {
  env: Record<string, string>;
  headers: Record<string, string>;
}

const openBrowser = async (url: string): Promise<void> => {
  await shell.openExternal(url);
};

const isGoogle = (id: string): boolean => id === GOOGLE_ID || id.startsWith(`${GOOGLE_ID}-`);

function processEnv(): Record<string, string> {
  return Object.fromEntries(Object.entries(childEnv()).filter((entry): entry is [string, string] => typeof entry[1] === 'string'));
}

function readServerSecrets(id: string): ServerSecrets {
  try {
    const parsed = JSON.parse(readSecret(`mcp-${id}-config`) ?? '{}') as Partial<ServerSecrets>;
    return { env: parsed.env ?? {}, headers: parsed.headers ?? {} };
  } catch {
    return { env: {}, headers: {} };
  }
}

/** Keeps the saved value for keys sent empty ("unchanged"), drops keys no longer listed. */
function mergeValues(saved: Record<string, string>, incoming: Record<string, string> | undefined, valid: RegExp): Record<string, string> {
  const entries = Object.entries(incoming ?? {}).map(([key, value]): [string, string] => [key.trim(), value.trim() || saved[key.trim()] || '']);
  return Object.fromEntries(entries.filter(([key, value]) => valid.test(key) && value));
}

/** `npx`, `uvx`, … found on the user's PATH (with Windows extensions). */
export function programExists(command: string): boolean {
  if (!command || /[\\/]/.test(command)) return Boolean(command) && fs.existsSync(command);
  const env = childEnv();
  const dirs = (env.PATH ?? env.Path ?? '').split(path.delimiter).filter(Boolean);
  const extensions = process.platform === 'win32' ? ['', ...(env.PATHEXT ?? '.EXE;.CMD;.BAT;.COM').split(';').filter(Boolean)] : [''];
  return dirs.some((dir) => extensions.some((ext) => {
    try {
      return fs.statSync(path.join(dir, `${command}${ext}`)).isFile();
    } catch {
      return false;
    }
  }));
}

interface JsonServer {
  type?: string;
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  url?: string;
  serverUrl?: string;
  headers?: Record<string, string>;
  disabled?: boolean;
}

/** Server entries from Claude Desktop / Claude Code (`mcpServers`), VS Code (`servers`, `mcp.servers`) or a bare map. */
function jsonServers(text: string): [string, JsonServer][] {
  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(text) as Record<string, unknown>;
  } catch (error) {
    throw new Error(`That is not valid JSON (${(error as Error).message}).`);
  }
  const nested = (parsed.mcp as { servers?: object } | undefined)?.servers;
  const map = (parsed.mcpServers ?? parsed.servers ?? nested ?? parsed) as Record<string, JsonServer>;
  const entries = Object.entries(map).filter(([, server]) => server && typeof server === 'object' && (typeof server.command === 'string' || typeof server.url === 'string' || typeof server.serverUrl === 'string'));
  if (!entries.length) throw new Error('No servers found. Paste JSON with an "mcpServers" object, as in Claude Desktop or Claude Code.');
  return entries;
}

function jsonType(server: JsonServer): McpTransportType {
  if (server.command) return 'stdio';
  return server.type === 'sse' ? 'sse' : 'http';
}

export class Connectors {
  readonly manager: McpManager;
  /** What each connected plugin server was started with, to reconnect only the ones that changed. */
  private readonly pluginSignatures = new Map<string, string>();

  constructor(onChange: (statuses: ConnectorStatus[]) => void, private readonly pluginServers: () => PluginServer[] = () => []) {
    this.manager = new McpManager(onChange);
  }

  statuses(): ConnectorStatus[] {
    const statuses = this.manager.statuses();
    if (statuses.some((status) => isGoogle(status.id))) return statuses;
    const { clientId } = getSettings().google;
    const google: ConnectorStatus = {
      id: GOOGLE_ID, name: 'Google', kind: 'google', state: 'disconnected', tools: [],
      detail: clientId ? 'Not connected' : 'Needs a Google OAuth client ID (open Advanced below)',
    };
    return [google, ...statuses];
  }

  tools(): Tool[] {
    return this.manager.tools();
  }

  connectedApps(): string[] {
    return this.manager.statuses()
      .filter((status) => status.state === 'connected')
      .map((status) => `${status.name}${status.account ? ` (${status.account})` : ''}${status.plugin ? ` [plugin ${status.plugin}]` : ''}: tools ${status.tools.slice(0, 12).join(', ')}${status.tools.length > 12 ? ', …' : ''}`);
  }

  /** Connects everything that was connected before: runs at startup without blocking the window. */
  async start(): Promise<void> {
    const jobs: Promise<void>[] = getSettings().mcpServers.filter((config) => config.enabled).map((config) => this.connectCustom(config));
    if (account()) jobs.push(this.startGoogle());
    jobs.push(this.syncPlugins());
    await Promise.allSettled(jobs);
  }

  private async startGoogle(): Promise<void> {
    const linked = account();
    if (!linked) return;
    const { official } = getSettings().google;
    if (official) {
      await Promise.all(linked.services.map((service) => this.manager.connect({
        id: `${GOOGLE_ID}-${service}`, name: `Google ${SERVICE_NAMES[service]}`, kind: 'google', prefix: service, account: linked.email,
        transport: bearerHttpTransport(GOOGLE_OFFICIAL_URLS[service], accessToken),
      })));
      return;
    }
    await this.manager.connect({
      id: GOOGLE_ID, name: 'Google', kind: 'google', prefix: 'google', account: linked.email,
      transport: inProcessTransport((transport) => createGoogleServer(linked.services, accessToken).connect(transport)),
    });
  }

  async connectGoogle(services: GoogleService[]): Promise<ConnectorStatus[]> {
    await signIn(services, openBrowser);
    saveSettings({ google: { ...getSettings().google, services } });
    await this.disconnectGoogleServers();
    await this.startGoogle();
    return this.statuses();
  }

  private async disconnectGoogleServers(): Promise<void> {
    const ids = this.manager.statuses().map((status) => status.id).filter(isGoogle);
    await Promise.all(ids.map((id) => this.manager.disconnect(id)));
  }

  async disconnectGoogle(): Promise<ConnectorStatus[]> {
    await this.disconnectGoogleServers();
    await signOut();
    return this.statuses();
  }

  private connectCustom(config: McpServerConfig): Promise<void> {
    const secrets = readServerSecrets(config.id);
    const oauth = config.type !== 'stdio' ? new OAuthProvider(config.id, openBrowser) : undefined;
    return this.manager.connect(customSpec(config, { env: { ...processEnv(), ...secrets.env }, headers: secrets.headers, oauth }));
  }

  async saveServer(input: McpServerInput): Promise<ConnectorStatus[]> {
    const type: McpTransportType = input.type === 'stdio' || input.type === 'sse' ? input.type : 'http';
    const id = ID_PATTERN.test(input.id) ? input.id : `mcp-${crypto.randomBytes(4).toString('hex')}`;
    const saved = readServerSecrets(id);
    const secrets: ServerSecrets = {
      env: type === 'stdio' ? mergeValues(saved.env, input.env ?? Object.fromEntries((input.envKeys ?? []).map((key) => [key, ''])), ENV_NAME) : {},
      headers: type !== 'stdio' ? mergeValues(saved.headers, input.headers ?? Object.fromEntries((input.headerKeys ?? []).map((key) => [key, ''])), HEADER_NAME) : {},
    };
    const config: McpServerConfig = {
      id,
      name: input.name.trim().slice(0, 40) || 'MCP server',
      type,
      url: type !== 'stdio' ? input.url?.trim() : undefined,
      command: type === 'stdio' ? input.command?.trim() : undefined,
      args: type === 'stdio' ? (input.args ?? []).filter(Boolean) : undefined,
      enabled: input.enabled,
      envKeys: Object.keys(secrets.env),
      headerKeys: Object.keys(secrets.headers),
      catalogId: input.catalogId,
    };
    if (type !== 'stdio' && !/^https?:\/\//.test(config.url ?? '')) throw new Error('Enter the server URL, e.g. https://example.com/mcp');
    if (type === 'stdio' && !config.command) throw new Error('Enter the command that starts the server, e.g. npx');
    writeSecret(`mcp-${id}-config`, Object.keys(secrets.env).length || Object.keys(secrets.headers).length ? JSON.stringify(secrets) : '');
    const others = getSettings().mcpServers.filter((server) => server.id !== config.id);
    saveSettings({ mcpServers: [...others, config] });
    if (config.enabled) await this.connectCustom(config);
    else await this.manager.disconnect(config.id);
    return this.statuses();
  }

  /** Adds every server in a pasted `mcpServers` JSON; returns how many. */
  async importJson(text: string): Promise<number> {
    const entries = jsonServers(text);
    const taken = new Set(getSettings().mcpServers.map((server) => server.id));
    const jobs = entries.map(([name, server]) => {
      const base = name.toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 34) || 'server';
      let id = base;
      for (let n = 2; taken.has(id); n++) id = `${base}-${n}`;
      taken.add(id);
      const type = jsonType(server);
      return this.saveServer({
        id, name, type, url: server.url ?? server.serverUrl, command: server.command, args: (server.args ?? []).map(String),
        enabled: server.disabled !== true, env: server.env, headers: server.headers,
      });
    });
    await Promise.all(jobs);
    return entries.length;
  }

  async removeServer(id: string): Promise<ConnectorStatus[]> {
    saveSettings({ mcpServers: getSettings().mcpServers.filter((server) => server.id !== id) });
    await this.manager.disconnect(id);
    new OAuthProvider(id, openBrowser).forget();
    writeSecret(`mcp-${id}-config`, '');
    return this.statuses();
  }

  async reconnect(id: string): Promise<ConnectorStatus[]> {
    if (isGoogle(id)) await this.startGoogle();
    const config = getSettings().mcpServers.find((server) => server.id === id);
    if (config) await this.connectCustom(config);
    const plugin = this.pluginServers().find((server) => server.id === id);
    if (plugin) await this.connectPlugin(plugin);
    return this.statuses();
  }

  /** Connects servers of newly enabled plugins, reconnects changed ones and drops those of removed or disabled plugins. */
  async syncPlugins(): Promise<void> {
    const wanted = new Map(this.pluginServers().map((server) => [server.id, server]));
    const stale = this.manager.statuses().filter((status) => status.kind === 'plugin' && !wanted.has(status.id)).map((status) => status.id);
    stale.forEach((id) => this.pluginSignatures.delete(id));
    await Promise.all(stale.map((id) => this.manager.disconnect(id)));
    const changed = [...wanted.values()].filter((server) => this.pluginSignatures.get(server.id) !== signature(server));
    await Promise.allSettled(changed.map((server) => this.connectPlugin(server)));
  }

  private async connectPlugin(server: PluginServer): Promise<void> {
    this.pluginSignatures.set(server.id, signature(server));
    const env = processEnv();
    const values = savedVars(server.id);
    const spec = expandSpec(server.spec, server.root, (name) => values[name] ?? env[name]);
    const config: McpServerConfig = { id: server.id, name: server.name, type: transportOf(server.spec), url: spec.url, command: spec.command, args: spec.args, enabled: true };
    const connector = customSpec(config, {
      env: { ...env, ...spec.env },
      headers: spec.headers,
      oauth: spec.url ? new OAuthProvider(server.id, openBrowser) : undefined,
      kind: 'plugin',
      plugin: server.pluginName,
    });
    const missing = requiredVars(server.spec).filter((name) => !values[name] && !env[name]);
    if (missing.length) {
      this.manager.hold(connector, 'needs-auth', `Needs ${missing.join(', ')}: enter ${missing.length > 1 ? 'them' : 'it'} below`);
      return;
    }
    await this.manager.connect(connector);
  }

  /** Saves values for a plugin server's placeholders and reconnects it. */
  async setServerVars(id: string, values: Record<string, string>): Promise<ConnectorStatus[]> {
    const merged = { ...savedVars(id), ...Object.fromEntries(Object.entries(values).map(([key, value]) => [key, value.trim()]).filter(([key, value]) => ENV_NAME.test(key) && value)) };
    writeSecret(`mcp-${id}-vars`, Object.keys(merged).length ? JSON.stringify(merged) : '');
    const server = this.pluginServers().find((entry) => entry.id === id);
    if (server) await this.connectPlugin(server);
    return this.statuses();
  }

  checkCommands(commands: string[]): CommandCheck[] {
    return commands.map((command) => ({ command, found: programExists(command) }));
  }
}

const signature = (server: PluginServer): string => JSON.stringify([server.spec, server.root, savedVars(server.id)]);
