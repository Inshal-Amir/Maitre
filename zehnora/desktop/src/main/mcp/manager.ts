import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { UnauthorizedError } from '@modelcontextprotocol/sdk/client/auth.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import type { CallToolResult, Tool as McpTool } from '@modelcontextprotocol/sdk/types.js';
import type { ConnectorState, ConnectorStatus, GoogleService, McpServerConfig } from '../../shared/types';
import type { Risk } from '../../shared/types';
import type { McpInputSchema } from '../llm';
import type { Tool } from '../tools/types';
import { ToolError, clip } from '../tools/types';
import { OAuthProvider } from './oauth';

export const GOOGLE_OFFICIAL_URLS: Record<GoogleService, string> = {
  gmail: 'https://gmailmcp.googleapis.com/mcp/v1',
  calendar: 'https://calendarmcp.googleapis.com/mcp/v1',
  drive: 'https://drivemcp.googleapis.com/mcp/v1',
  docs: 'https://docsmcp.googleapis.com/mcp/v1',
  sheets: 'https://sheetsmcp.googleapis.com/mcp/v1',
};

const RISKY_NAME = /(^|_)(send|delete|remove|trash|share|unshare|permission|publish|transfer|pay|purchase|drop|revoke|invite)/i;
const CALL_TIMEOUT_MS = 120_000;
const PREFIX_MAX = 20;

/** How to reach one MCP server: a transport factory plus the prefix its tools get in the agent. */
export interface ConnectorSpec {
  id: string;
  name: string;
  kind: 'google' | 'custom';
  prefix: string;
  account?: string;
  transport(): Transport | Promise<Transport>;
  oauth?: OAuthProvider;
}

interface Connection {
  spec: ConnectorSpec;
  state: ConnectorState;
  detail: string;
  client: Client | null;
  tools: Tool[];
}

export function riskOf(tool: McpTool): Risk {
  const hints = tool.annotations ?? {};
  if (hints.destructiveHint === true || RISKY_NAME.test(tool.name)) return 'risky';
  if (hints.readOnlyHint === true) return 'safe';
  return 'normal';
}

const slug = (text: string): string => text.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '').slice(0, PREFIX_MAX) || 'mcp';

export function formatResult(result: CallToolResult): string {
  const parts = result.content.map((item) => {
    if (item.type === 'text') return item.text;
    if (item.type === 'resource' && 'text' in item.resource) return String(item.resource.text);
    if (item.type === 'resource_link') return `${item.name}: ${item.uri}`;
    return `[${item.type} content]`;
  });
  if (!parts.length && result.structuredContent) parts.push(JSON.stringify(result.structuredContent, null, 2));
  return clip(parts.join('\n').trim() || '(no output)');
}

function summarizeArgs(args: object): string {
  const text = Object.entries(args)
    .map(([key, value]) => `${key}: ${typeof value === 'string' ? value : JSON.stringify(value)}`)
    .join('\n');
  return text.length > 1500 ? `${text.slice(0, 1500)}…` : text;
}

function toAgentTool(connection: Connection, tool: McpTool): Tool {
  const { spec } = connection;
  const name = `${spec.prefix}_${tool.name}`.replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 64);
  const risk = riskOf(tool);
  return {
    name,
    description: `[${spec.name}] ${tool.description ?? tool.title ?? tool.name}`.slice(0, 1024),
    parameters: { properties: {}, ...(tool.inputSchema as McpInputSchema), type: 'object' },
    modes: ['chat', 'work'],
    assess: (args) => ({ risk, title: `${spec.name}: ${tool.title ?? tool.name.replace(/_/g, ' ')}`, detail: summarizeArgs(args), allowKey: `mcp:${name}` }),
    async run(args, context) {
      const client = connection.client;
      if (!client || connection.state !== 'connected') throw new ToolError(`${spec.name} is not connected (${connection.detail}). Reconnect it in Settings → Connected apps.`);
      const result = (await client.callTool({ name: tool.name, arguments: args }, undefined, { signal: context.signal, timeout: CALL_TIMEOUT_MS })) as CallToolResult;
      const text = formatResult(result);
      if (result.isError) throw new ToolError(text);
      return text;
    },
  };
}

async function listAllTools(client: Client): Promise<McpTool[]> {
  const tools: McpTool[] = [];
  let cursor: string | undefined;
  do {
    const page = await client.listTools(cursor ? { cursor } : undefined);
    tools.push(...page.tools);
    cursor = page.nextCursor;
  } while (cursor && tools.length < 500);
  return tools;
}

export class McpManager {
  private readonly connections = new Map<string, Connection>();

  constructor(private readonly onChange: (statuses: ConnectorStatus[]) => void) {}

  statuses(): ConnectorStatus[] {
    return [...this.connections.values()].map(({ spec, state, detail, tools }) => ({
      id: spec.id, name: spec.name, kind: spec.kind, state, detail, account: spec.account, tools: tools.map((tool) => tool.name),
    }));
  }

  tools(): Tool[] {
    return [...this.connections.values()].filter((c) => c.state === 'connected').flatMap((c) => c.tools);
  }

  private update(connection: Connection, state: ConnectorState, detail: string): void {
    connection.state = state;
    connection.detail = detail;
    this.onChange(this.statuses());
  }

  /** Connects (or reconnects) one server. HTTP servers that need OAuth open the browser and finish sign-in first. */
  async connect(spec: ConnectorSpec): Promise<void> {
    await this.disconnect(spec.id, false);
    const connection: Connection = { spec, state: 'connecting', detail: 'Connecting…', client: null, tools: [] };
    this.connections.set(spec.id, connection);
    this.onChange(this.statuses());
    try {
      const client = await this.open(spec);
      connection.client = client;
      connection.tools = (await listAllTools(client)).map((tool) => toAgentTool(connection, tool));
      client.onclose = () => {
        if (this.connections.get(spec.id) === connection && connection.state === 'connected') this.update(connection, 'error', 'Connection closed');
      };
      this.update(connection, 'connected', `${connection.tools.length} tools`);
    } catch (error) {
      const needsAuth = error instanceof UnauthorizedError;
      this.update(connection, needsAuth ? 'needs-auth' : 'error', needsAuth ? 'Sign-in needed' : (error as Error).message.slice(0, 300));
    }
  }

  private async open(spec: ConnectorSpec): Promise<Client> {
    const client = new Client({ name: 'zehnora-desktop', version: '0.3.0' });
    const transport = await spec.transport();
    try {
      await client.connect(transport);
      return client;
    } catch (error) {
      if (!(error instanceof UnauthorizedError) || !spec.oauth || !(transport instanceof StreamableHTTPClientTransport)) throw error;
      const code = await spec.oauth.waitForCode();
      await transport.finishAuth(code);
      const retry = new Client({ name: 'zehnora-desktop', version: '0.3.0' });
      await retry.connect(await spec.transport());
      return retry;
    }
  }

  async disconnect(id: string, forget = true): Promise<void> {
    const connection = this.connections.get(id);
    if (!connection) return;
    connection.state = 'disconnected';
    await connection.client?.close().catch(() => undefined);
    if (forget) this.connections.delete(id);
    else connection.client = null;
    this.onChange(this.statuses());
  }

  async closeAll(): Promise<void> {
    await Promise.all([...this.connections.keys()].map((id) => this.disconnect(id)));
  }
}

export function customSpec(config: McpServerConfig, env: Record<string, string>, oauth: OAuthProvider | undefined): ConnectorSpec {
  return {
    id: config.id,
    name: config.name,
    kind: 'custom',
    prefix: slug(config.name),
    oauth,
    transport: () => {
      if (config.type === 'stdio') {
        if (!config.command) throw new Error('No command set for this MCP server.');
        return new StdioClientTransport({ command: config.command, args: config.args ?? [], env, stderr: 'ignore' });
      }
      if (!config.url) throw new Error('No URL set for this MCP server.');
      return new StreamableHTTPClientTransport(new URL(config.url), { authProvider: oauth });
    },
  };
}

/** The built-in Google server runs in this process: a linked in-memory transport pair, no child process or network hop. */
export function inProcessTransport(connectServer: (transport: Transport) => Promise<void>): () => Promise<Transport> {
  return async () => {
    const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
    await connectServer(serverSide);
    return clientSide;
  };
}

/** Google's hosted MCP servers accept the user's Google OAuth access token as a bearer token. */
export function bearerHttpTransport(url: string, token: () => Promise<string>): () => Transport {
  return () =>
    new StreamableHTTPClientTransport(new URL(url), {
      fetch: async (input, init) => {
        const headers = new Headers(init?.headers);
        headers.set('authorization', `Bearer ${await token()}`);
        return fetch(input, { ...init, headers });
      },
    });
}
