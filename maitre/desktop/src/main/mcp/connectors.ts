import crypto from 'node:crypto';
import { shell } from 'electron';
import type { ConnectorStatus, GoogleService, McpServerConfig } from '../../shared/types';
import type { Tool } from '../tools/types';
import { McpManager, GOOGLE_OFFICIAL_URLS, bearerHttpTransport, customSpec, inProcessTransport } from './manager';
import { accessToken, account, signIn, signOut } from '../google/auth';
import { getSettings, saveSettings } from '../settings';
import { createGoogleServer } from '../google/server';
import { childEnv } from '../tools/shell';
import { OAuthProvider } from './oauth';

const GOOGLE_ID = 'google';
const SERVICE_NAMES: Record<GoogleService, string> = { gmail: 'Gmail', calendar: 'Calendar', drive: 'Drive', docs: 'Docs', sheets: 'Sheets' };
const ID_PATTERN = /^[a-z0-9-]{1,40}$/;

const openBrowser = async (url: string): Promise<void> => {
  await shell.openExternal(url);
};

export class Connectors {
  readonly manager: McpManager;

  constructor(onChange: (statuses: ConnectorStatus[]) => void) {
    this.manager = new McpManager(onChange);
  }

  statuses(): ConnectorStatus[] {
    const statuses = this.manager.statuses();
    if (statuses.some((status) => status.id === GOOGLE_ID || status.id.startsWith(`${GOOGLE_ID}-`))) return statuses;
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
      .map((status) => `${status.name}${status.account ? ` (${status.account})` : ''}: tools ${status.tools.slice(0, 12).join(', ')}${status.tools.length > 12 ? ', …' : ''}`);
  }

  /** Connects everything that was connected before: runs at startup without blocking the window. */
  async start(): Promise<void> {
    const jobs: Promise<void>[] = getSettings().mcpServers.filter((config) => config.enabled).map((config) => this.connectCustom(config));
    if (account()) jobs.push(this.startGoogle());
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
    const ids = this.manager.statuses().map((status) => status.id).filter((id) => id === GOOGLE_ID || id.startsWith(`${GOOGLE_ID}-`));
    await Promise.all(ids.map((id) => this.manager.disconnect(id)));
  }

  async disconnectGoogle(): Promise<ConnectorStatus[]> {
    await this.disconnectGoogleServers();
    await signOut();
    return this.statuses();
  }

  private connectCustom(config: McpServerConfig): Promise<void> {
    const oauth = config.type === 'http' ? new OAuthProvider(config.id, openBrowser) : undefined;
    const env = Object.fromEntries(Object.entries(childEnv()).filter((entry): entry is [string, string] => typeof entry[1] === 'string'));
    return this.manager.connect(customSpec(config, env, oauth));
  }

  async saveServer(input: McpServerConfig): Promise<ConnectorStatus[]> {
    const config: McpServerConfig = {
      id: ID_PATTERN.test(input.id) ? input.id : `mcp-${crypto.randomBytes(4).toString('hex')}`,
      name: input.name.trim().slice(0, 40) || 'MCP server',
      type: input.type === 'stdio' ? 'stdio' : 'http',
      url: input.type === 'http' ? input.url?.trim() : undefined,
      command: input.type === 'stdio' ? input.command?.trim() : undefined,
      args: input.type === 'stdio' ? (input.args ?? []).filter(Boolean) : undefined,
      enabled: input.enabled,
    };
    if (config.type === 'http' && !/^https?:\/\//.test(config.url ?? '')) throw new Error('Enter the server URL, e.g. https://example.com/mcp');
    if (config.type === 'stdio' && !config.command) throw new Error('Enter the command that starts the server, e.g. npx');
    const others = getSettings().mcpServers.filter((server) => server.id !== config.id);
    saveSettings({ mcpServers: [...others, config] });
    if (config.enabled) await this.connectCustom(config);
    else await this.manager.disconnect(config.id);
    return this.statuses();
  }

  async removeServer(id: string): Promise<ConnectorStatus[]> {
    saveSettings({ mcpServers: getSettings().mcpServers.filter((server) => server.id !== id) });
    await this.manager.disconnect(id);
    new OAuthProvider(id, openBrowser).forget();
    return this.statuses();
  }

  async reconnect(id: string): Promise<ConnectorStatus[]> {
    if (id === GOOGLE_ID || id.startsWith(`${GOOGLE_ID}-`)) await this.startGoogle();
    const config = getSettings().mcpServers.find((server) => server.id === id);
    if (config) await this.connectCustom(config);
    return this.statuses();
  }
}
