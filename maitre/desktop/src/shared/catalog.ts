import type { McpServerInput, McpTransportType } from './types';

export type CatalogCategory = 'Search and docs' | 'Work apps' | 'Developer' | 'Browser and computer';

/** One value the user fills in when adding a gallery server. */
export interface CatalogField {
  key: string;
  label: string;
  placeholder?: string;
  /** Where the value goes: an environment variable, an HTTP header, or appended to the command arguments. */
  target: 'env' | 'header' | 'arg';
  /** Header value template, e.g. `Bearer {value}`. */
  format?: string;
  secret?: boolean;
  optional?: boolean;
  /** Ask with a folder picker. */
  folder?: boolean;
  help?: string;
}

export interface CatalogEntry {
  id: string;
  name: string;
  description: string;
  category: CatalogCategory;
  /** Logo: one or two letters on a colour. */
  mark: string;
  color: string;
  type: McpTransportType;
  url?: string;
  command?: string;
  args?: string[];
  /** How it signs in: nothing, the service's own sign-in page (OAuth), or a key the user pastes. */
  auth: 'none' | 'oauth' | 'key';
  fields?: CatalogField[];
  /** Program that must be installed for a local server. */
  requires?: 'npx' | 'uvx';
  docs: string;
}

export const MCP_CATALOG: readonly CatalogEntry[] = [
  {
    id: 'context7', name: 'Context7', description: 'Up-to-date documentation and code examples for thousands of libraries and frameworks.',
    category: 'Search and docs', mark: 'C7', color: '#0f766e', type: 'http', url: 'https://mcp.context7.com/mcp', auth: 'none',
    fields: [{ key: 'CONTEXT7_API_KEY', label: 'API key (optional, for higher limits)', target: 'header', secret: true, optional: true }],
    docs: 'https://github.com/upstash/context7',
  },
  {
    id: 'deepwiki', name: 'DeepWiki', description: 'Ask questions about any public GitHub repository and read its generated wiki.',
    category: 'Search and docs', mark: 'DW', color: '#2563eb', type: 'http', url: 'https://mcp.deepwiki.com/mcp', auth: 'none',
    docs: 'https://docs.devin.ai/work-with-devin/deepwiki-mcp',
  },
  {
    id: 'exa', name: 'Exa Search', description: 'Neural web search, code search and page crawling built for AI agents.',
    category: 'Search and docs', mark: 'Ex', color: '#1d4ed8', type: 'http', url: 'https://mcp.exa.ai/mcp', auth: 'none',
    docs: 'https://docs.exa.ai/reference/exa-mcp',
  },
  {
    id: 'huggingface', name: 'Hugging Face', description: 'Search models, datasets, Spaces and papers on the Hugging Face Hub.',
    category: 'Search and docs', mark: 'HF', color: '#d97706', type: 'http', url: 'https://huggingface.co/mcp', auth: 'none',
    fields: [{ key: 'Authorization', label: 'Access token (optional)', target: 'header', format: 'Bearer {value}', secret: true, optional: true, placeholder: 'hf_…' }],
    docs: 'https://huggingface.co/settings/mcp',
  },
  {
    id: 'cloudflare-docs', name: 'Cloudflare Docs', description: 'Search the Cloudflare developer documentation (Workers, Pages, R2, D1 and more).',
    category: 'Search and docs', mark: 'CF', color: '#f38020', type: 'http', url: 'https://docs.mcp.cloudflare.com/mcp', auth: 'none',
    docs: 'https://github.com/cloudflare/mcp-server-cloudflare',
  },
  {
    id: 'brave-search', name: 'Brave Search', description: 'Web, news, image and local search through the Brave Search API.',
    category: 'Search and docs', mark: 'B', color: '#fb542b', type: 'stdio', command: 'npx', args: ['-y', '@brave/brave-search-mcp-server'], auth: 'key', requires: 'npx',
    fields: [{ key: 'BRAVE_API_KEY', label: 'Brave Search API key', target: 'env', secret: true, help: 'Free key at api-dashboard.search.brave.com' }],
    docs: 'https://github.com/brave/brave-search-mcp-server',
  },
  {
    id: 'notion', name: 'Notion', description: 'Search, read and edit pages and databases in your Notion workspace.',
    category: 'Work apps', mark: 'N', color: '#111111', type: 'http', url: 'https://mcp.notion.com/mcp', auth: 'oauth',
    docs: 'https://developers.notion.com/docs/mcp',
  },
  {
    id: 'linear', name: 'Linear', description: 'Find, create and update issues, projects and comments in Linear.',
    category: 'Work apps', mark: 'L', color: '#5e6ad2', type: 'http', url: 'https://mcp.linear.app/mcp', auth: 'oauth',
    docs: 'https://linear.app/docs/mcp',
  },
  {
    id: 'atlassian', name: 'Jira and Confluence', description: 'Work with Jira issues and Confluence pages in your Atlassian cloud site.',
    category: 'Work apps', mark: 'A', color: '#0052cc', type: 'http', url: 'https://mcp.atlassian.com/v1/mcp', auth: 'oauth',
    docs: 'https://support.atlassian.com/rovo/docs/getting-started-with-the-atlassian-remote-mcp-server/',
  },
  {
    id: 'asana', name: 'Asana', description: 'Read and manage tasks, projects and goals in Asana.',
    category: 'Work apps', mark: 'As', color: '#f06a6a', type: 'http', url: 'https://mcp.asana.com/v2/mcp', auth: 'oauth',
    docs: 'https://developers.asana.com/docs/using-asanas-mcp-server',
  },
  {
    id: 'canva', name: 'Canva', description: 'Search, create and export Canva designs.',
    category: 'Work apps', mark: 'Ca', color: '#00c4cc', type: 'http', url: 'https://mcp.canva.com/mcp', auth: 'oauth',
    docs: 'https://www.canva.dev/docs/connect/canva-mcp-server-setup/',
  },
  {
    id: 'stripe', name: 'Stripe', description: 'Look up customers, payments and invoices, and search the Stripe docs.',
    category: 'Work apps', mark: 'S', color: '#635bff', type: 'http', url: 'https://mcp.stripe.com', auth: 'oauth',
    docs: 'https://docs.stripe.com/mcp',
  },
  {
    id: 'paypal', name: 'PayPal', description: 'Invoices, orders, subscriptions and transaction reports in PayPal.',
    category: 'Work apps', mark: 'PP', color: '#003087', type: 'http', url: 'https://mcp.paypal.com/mcp', auth: 'oauth',
    docs: 'https://developer.paypal.com/tools/mcp-server/',
  },
  {
    id: 'github', name: 'GitHub', description: 'Repositories, issues, pull requests, Actions and code search on GitHub.',
    category: 'Developer', mark: 'GH', color: '#24292f', type: 'http', url: 'https://api.githubcopilot.com/mcp/', auth: 'key',
    fields: [{ key: 'Authorization', label: 'Personal access token', target: 'header', format: 'Bearer {value}', secret: true, placeholder: 'github_pat_… or ghp_…', help: 'Create one at github.com/settings/personal-access-tokens' }],
    docs: 'https://github.com/github/github-mcp-server',
  },
  {
    id: 'sentry', name: 'Sentry', description: 'Investigate errors, issues and releases in your Sentry projects.',
    category: 'Developer', mark: 'Se', color: '#362d59', type: 'http', url: 'https://mcp.sentry.dev/mcp', auth: 'oauth',
    docs: 'https://docs.sentry.io/product/sentry-mcp/',
  },
  {
    id: 'supabase', name: 'Supabase', description: 'Manage Supabase projects: tables, SQL, migrations, logs and edge functions.',
    category: 'Developer', mark: 'Sb', color: '#3ecf8e', type: 'http', url: 'https://mcp.supabase.com/mcp', auth: 'oauth',
    docs: 'https://supabase.com/docs/guides/getting-started/mcp',
  },
  {
    id: 'filesystem', name: 'Filesystem', description: 'Read and write files in one folder you choose, even in Chat mode.',
    category: 'Developer', mark: 'FS', color: '#475569', type: 'stdio', command: 'npx', args: ['-y', '@modelcontextprotocol/server-filesystem'], auth: 'none', requires: 'npx',
    fields: [{ key: 'folder', label: 'Folder it may use', target: 'arg', folder: true }],
    docs: 'https://github.com/modelcontextprotocol/servers/tree/main/src/filesystem',
  },
  {
    id: 'memory-graph', name: 'Knowledge graph memory', description: 'A local knowledge graph of people, projects and facts the agent can build and query.',
    category: 'Developer', mark: 'KG', color: '#7c3aed', type: 'stdio', command: 'npx', args: ['-y', '@modelcontextprotocol/server-memory'], auth: 'none', requires: 'npx',
    docs: 'https://github.com/modelcontextprotocol/servers/tree/main/src/memory',
  },
  {
    id: 'sequential-thinking', name: 'Sequential thinking', description: 'Structured step-by-step reasoning for hard, multi-stage problems.',
    category: 'Developer', mark: 'ST', color: '#0891b2', type: 'stdio', command: 'npx', args: ['-y', '@modelcontextprotocol/server-sequential-thinking'], auth: 'none', requires: 'npx',
    docs: 'https://github.com/modelcontextprotocol/servers/tree/main/src/sequentialthinking',
  },
  {
    id: 'fetch', name: 'Fetch', description: 'Fetch any web page and convert it to clean Markdown.',
    category: 'Search and docs', mark: 'F', color: '#15803d', type: 'stdio', command: 'uvx', args: ['mcp-server-fetch'], auth: 'none', requires: 'uvx',
    docs: 'https://github.com/modelcontextprotocol/servers/tree/main/src/fetch',
  },
  {
    id: 'playwright', name: 'Playwright browser', description: 'Drive a real browser: open pages, click, type, fill forms and take snapshots.',
    category: 'Browser and computer', mark: 'PW', color: '#2ead33', type: 'stdio', command: 'npx', args: ['-y', '@playwright/mcp@latest'], auth: 'none', requires: 'npx',
    docs: 'https://github.com/microsoft/playwright-mcp',
  },
  {
    id: 'chrome-devtools', name: 'Chrome DevTools', description: 'Control Chrome and inspect pages: console, network, performance traces.',
    category: 'Browser and computer', mark: 'CD', color: '#4285f4', type: 'stdio', command: 'npx', args: ['-y', 'chrome-devtools-mcp@latest'], auth: 'none', requires: 'npx',
    docs: 'https://github.com/ChromeDevTools/chrome-devtools-mcp',
  },
];

export const CATALOG_CATEGORIES: readonly CatalogCategory[] = ['Search and docs', 'Work apps', 'Developer', 'Browser and computer'];

/** The server config for a gallery entry and the values the user filled in. */
export function catalogServer(entry: CatalogEntry, values: Record<string, string>): McpServerInput {
  const env: Record<string, string> = {};
  const headers: Record<string, string> = {};
  const extraArgs: string[] = [];
  for (const field of entry.fields ?? []) {
    const value = (values[field.key] ?? '').trim();
    if (!value) continue;
    if (field.target === 'env') env[field.key] = value;
    else if (field.target === 'header') headers[field.key] = field.format ? field.format.replace('{value}', value) : value;
    else extraArgs.push(value);
  }
  return {
    id: entry.id,
    name: entry.name,
    type: entry.type,
    url: entry.url,
    command: entry.command,
    args: entry.args ? [...entry.args, ...extraArgs] : undefined,
    enabled: true,
    catalogId: entry.id,
    env,
    headers,
  };
}

/** Required fields the user left empty. */
export const missingFields = (entry: CatalogEntry, values: Record<string, string>): CatalogField[] =>
  (entry.fields ?? []).filter((field) => !field.optional && !(values[field.key] ?? '').trim());
