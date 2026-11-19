/**
 * The connector catalog: the apps the Connectors page offers and how each one
 * reaches its MCP server. Remote entries speak Streamable HTTP; every URL was
 * checked to answer MCP `initialize` without credentials, or to answer 401
 * with OAuth protected-resource or authorization-server metadata whose
 * server supports dynamic client registration. Remote servers whose
 * authorization server has no dynamic client registration need a client
 * registered with the vendor, so they are listed as unavailable.
 */

import type { ConnectorAuth, ConnectorCategory, ConnectorInput, GoogleService } from './types.ts'

/** Where a `key` connector's value goes; every placement is a `${credential:REF}` template. */
export type InputTarget =
  | { readonly kind: 'header'; readonly name: string; readonly format: string }
  | { readonly kind: 'env'; readonly name: string }
  /** Replaces `{value}` in the URL. */
  | { readonly kind: 'url' }
  /** Appended to the command arguments. */
  | { readonly kind: 'arg' }

/** How the Host reaches the entry's MCP server. */
export type CatalogServer =
  | { readonly transport: 'http'; readonly url: string }
  | { readonly transport: 'stdio'; readonly command: 'npx' | 'uvx'; readonly args: readonly string[] }
  | { readonly transport: 'builtin' }

/** One catalog entry. */
export interface CatalogEntry {
  /** Catalog id and managed MCP server name (`[a-z][a-z0-9-]*`, at most 32 characters). */
  readonly id: string
  readonly name: string
  readonly description: string
  readonly category: ConnectorCategory
  readonly mark: string
  readonly color: string
  readonly auth: ConnectorAuth
  readonly server: CatalogServer
  readonly docs: string
  readonly input?: ConnectorInput & { readonly target: InputTarget }
  /** Why the entry cannot be connected in this release. */
  readonly unavailable?: string
}

type Base = Pick<CatalogEntry, 'id' | 'name' | 'category' | 'mark' | 'color' | 'description'> & { readonly docs?: string }

const oauth = (base: Base, url: string): CatalogEntry => ({ docs: '', ...base, auth: 'oauth', server: { transport: 'http', url } })
const open = (base: Base, url: string): CatalogEntry => ({ docs: '', ...base, auth: 'none', server: { transport: 'http', url } })
const NO_DCR = 'Its sign-in server does not let apps register themselves, so Maitre needs an app registered with the vendor first. Use "Add custom connector" with an access token meanwhile.'
const DCR_REFUSED = 'Its sign-in server refuses self-registered apps (only vendor-approved clients), so Maitre needs an app approved by the vendor first. Use "Add custom connector" with an access token meanwhile.'
const HTTPS_REDIRECT = 'Its sign-in server accepts only https:// redirect addresses, and Maitre signs in through this computer (http://127.0.0.1), so it cannot connect yet.'
const SCOPE_REQUIRED = 'Its sign-in server requires app-specific permission scopes at registration, which Maitre does not know yet.'
const blocked = (base: Base, url: string, reason = NO_DCR): CatalogEntry => ({ ...oauth(base, url), unavailable: reason })
const local = (base: Base, command: 'npx' | 'uvx', args: readonly string[], input?: CatalogEntry['input']): CatalogEntry =>
  ({ docs: '', ...base, auth: input === undefined ? 'none' : 'key', server: { transport: 'stdio', command, args }, ...(input === undefined ? {} : { input }) })

/** Catalog in page order. */
export const CATALOG: readonly CatalogEntry[] = [
  {
    id: 'google', name: 'Google Workspace', category: 'google', mark: 'G', color: '#4285f4', auth: 'google', server: { transport: 'builtin' },
    description: 'Search and read Gmail, draft and send email, manage Calendar events, and work with Drive, Docs and Sheets.',
    docs: 'https://developers.google.com/workspace',
  },

  oauth({ id: 'notion', name: 'Notion', category: 'work', mark: 'N', color: '#111111', description: 'Search, read and edit pages and databases in your Notion workspace.', docs: 'https://developers.notion.com/docs/mcp' }, 'https://mcp.notion.com/mcp'),
  oauth({ id: 'linear', name: 'Linear', category: 'work', mark: 'L', color: '#5e6ad2', description: 'Find, create and update issues, projects and comments in Linear.', docs: 'https://linear.app/docs/mcp' }, 'https://mcp.linear.app/mcp'),
  oauth({ id: 'atlassian', name: 'Jira and Confluence', category: 'work', mark: 'A', color: '#0052cc', description: 'Work with Jira issues and Confluence pages in your Atlassian cloud site.', docs: 'https://support.atlassian.com/rovo/docs/getting-started-with-the-atlassian-remote-mcp-server/' }, 'https://mcp.atlassian.com/v1/mcp'),
  oauth({ id: 'monday', name: 'monday.com', category: 'work', mark: 'M', color: '#ff3d57', description: 'Read and update boards, items and updates in monday.com.' }, 'https://mcp.monday.com/mcp'),
  oauth({ id: 'clickup', name: 'ClickUp', category: 'work', mark: 'CU', color: '#7b68ee', description: 'Search, create and update ClickUp tasks, lists and docs.' }, 'https://mcp.clickup.com/mcp'),
  oauth({ id: 'trello', name: 'Trello', category: 'work', mark: 'T', color: '#0079bf', description: 'Read and manage Trello boards, lists and cards.' }, 'https://mcp.trello.com/v1'),
  oauth({ id: 'airtable', name: 'Airtable', category: 'work', mark: 'At', color: '#18bfff', description: 'Query and edit records in your Airtable bases.' }, 'https://mcp.airtable.com/mcp'),
  oauth({ id: 'miro', name: 'Miro', category: 'work', mark: 'Mi', color: '#ffd02f', description: 'Read and create content on Miro boards.' }, 'https://mcp.miro.com/'),
  blocked({ id: 'dropbox', name: 'Dropbox', category: 'work', mark: 'Db', color: '#0061ff', description: 'Search, read and organize files in Dropbox.' }, 'https://mcp.dropbox.com/mcp', DCR_REFUSED),
  oauth({ id: 'egnyte', name: 'Egnyte', category: 'work', mark: 'Eg', color: '#00968f', description: 'Search and read documents stored in Egnyte.' }, 'https://mcp-server.egnyte.com/mcp'),
  blocked({ id: 'calendly', name: 'Calendly', category: 'work', mark: 'Ca', color: '#006bff', description: 'See event types and scheduled meetings, and share booking links.' }, 'https://mcp.calendly.com/', HTTPS_REDIRECT),
  oauth({ id: 'granola', name: 'Granola', category: 'work', mark: 'Gr', color: '#3f6212', description: 'Search your Granola meeting notes and transcripts.' }, 'https://mcp.granola.ai/mcp'),
  oauth({ id: 'fireflies', name: 'Fireflies', category: 'work', mark: 'Ff', color: '#7c3aed', description: 'Search meeting transcripts and summaries recorded by Fireflies.' }, 'https://api.fireflies.ai/mcp'),
  oauth({ id: 'otter', name: 'Otter', category: 'work', mark: 'Ot', color: '#2563eb', description: 'Search Otter meeting transcripts and notes.' }, 'https://mcp.otter.ai/mcp'),
  oauth({ id: 'tldv', name: 'tl;dv', category: 'work', mark: 'tl', color: '#5b21b6', description: 'Find meetings and read tl;dv recordings, notes and highlights.' }, 'https://mcp.tldv.io/mcp'),
  oauth({ id: 'guru', name: 'Guru', category: 'work', mark: 'Gu', color: '#4f46e5', description: 'Search your company knowledge in Guru cards.' }, 'https://mcp.api.getguru.com/mcp'),
  oauth({ id: 'intercom', name: 'Intercom', category: 'work', mark: 'Ic', color: '#1f8ded', description: 'Search conversations, contacts and help-center articles in Intercom.' }, 'https://mcp.intercom.com/mcp'),
  oauth({ id: 'jotform', name: 'Jotform', category: 'work', mark: 'Jf', color: '#ff6100', description: 'Create forms and read submissions in Jotform.' }, 'https://mcp.jotform.com/'),
  oauth({ id: 'zapier', name: 'Zapier', category: 'work', mark: 'Z', color: '#ff4f00', description: 'Run the actions you enable in Zapier across thousands of apps.' }, 'https://mcp.zapier.com/api/v1/connect'),
  oauth({ id: 'pipedream', name: 'Pipedream', category: 'work', mark: 'Pd', color: '#22c55e', description: 'Use Pipedream-connected app actions and workflows.' }, 'https://remote.mcp.pipedream.net'),
  blocked({ id: 'asana', name: 'Asana', category: 'work', mark: 'As', color: '#f06a6a', description: 'Read and manage tasks, projects and goals in Asana.', docs: 'https://developers.asana.com/docs/using-asanas-mcp-server' }, 'https://mcp.asana.com/v2/mcp'),
  blocked({ id: 'slack', name: 'Slack', category: 'work', mark: 'Sl', color: '#4a154b', description: 'Search and read Slack messages and channels, and post messages.' }, 'https://mcp.slack.com/mcp'),
  blocked({ id: 'box', name: 'Box', category: 'work', mark: 'Bx', color: '#0061d5', description: 'Search and read files stored in Box.' }, 'https://mcp.box.com'),
  blocked({ id: 'zoom', name: 'Zoom', category: 'work', mark: 'Zm', color: '#0b5cff', description: 'Meetings, recordings and summaries in Zoom.' }, 'https://mcp.zoom.us/mcp/zoom/streamable'),
  blocked({ id: 'docusign', name: 'Docusign', category: 'work', mark: 'DS', color: '#4c00ff', description: 'Agreements and envelopes in Docusign.' }, 'https://mcp.docusign.com/mcp'),

  oauth({ id: 'attio', name: 'Attio', category: 'sales', mark: 'Ao', color: '#111827', description: 'Search and update people, companies and deals in Attio.' }, 'https://mcp.attio.com/mcp'),
  oauth({ id: 'close', name: 'Close', category: 'sales', mark: 'Cl', color: '#2563eb', description: 'Leads, contacts, opportunities and activities in Close CRM.' }, 'https://mcp.close.com/mcp'),
  oauth({ id: 'apollo', name: 'Apollo.io', category: 'sales', mark: 'Ap', color: '#ffc700', description: 'Find people and companies and enrich leads with Apollo.' }, 'https://mcp.apollo.io/mcp'),
  oauth({ id: 'outreach', name: 'Outreach', category: 'sales', mark: 'Or', color: '#5951ff', description: 'Prospects, sequences and engagement data in Outreach.' }, 'https://api.outreach.io/mcp/'),
  blocked({ id: 'zoominfo', name: 'ZoomInfo', category: 'sales', mark: 'ZI', color: '#d11f1f', description: 'Company and contact intelligence from ZoomInfo.' }, 'https://mcp.zoominfo.com/mcp', DCR_REFUSED),
  oauth({ id: 'lusha', name: 'Lusha', category: 'sales', mark: 'Lu', color: '#7f56d9', description: 'Find and enrich B2B contacts and companies with Lusha.' }, 'https://mcp.lusha.com/mcp/claude'),
  blocked({ id: 'gong', name: 'Gong', category: 'sales', mark: 'Go', color: '#8039df', description: 'Search Gong calls, transcripts and deal activity.' }, 'https://mcp.gong.io/mcp', SCOPE_REQUIRED),
  oauth({ id: 'common-room', name: 'Common Room', category: 'sales', mark: 'CR', color: '#0f172a', description: 'Account and contact signals from Common Room.' }, 'https://mcp.commonroom.io/mcp'),
  oauth({ id: 'clay', name: 'Clay', category: 'sales', mark: 'Cy', color: '#1d1d1d', description: 'Research and enrich companies and people with Clay.' }, 'https://api.clay.com/v3/mcp'),
  oauth({ id: 'klaviyo', name: 'Klaviyo', category: 'sales', mark: 'K', color: '#232426', description: 'Campaigns, flows, lists and performance in Klaviyo.' }, 'https://mcp.klaviyo.com/mcp'),
  blocked({ id: 'similarweb', name: 'Similarweb', category: 'sales', mark: 'Sw', color: '#092540', description: 'Website traffic and market data from Similarweb.' }, 'https://mcp.similarweb.com/mcp', DCR_REFUSED),
  oauth({ id: 'ahrefs', name: 'Ahrefs', category: 'sales', mark: 'Ah', color: '#ff8800', description: 'SEO data: backlinks, keywords and site metrics from Ahrefs.' }, 'https://api.ahrefs.com/mcp/mcp'),
  oauth({ id: 'supermetrics', name: 'Supermetrics', category: 'sales', mark: 'Sm', color: '#1e3a8a', description: 'Marketing data from ad and analytics platforms via Supermetrics.' }, 'https://mcp.supermetrics.com/mcp'),
  oauth({ id: 'wix', name: 'Wix', category: 'sales', mark: 'Wx', color: '#0c6efc', description: 'Manage your Wix site, store, bookings and content.' }, 'https://mcp.wix.com/mcp'),
  oauth({ id: 'webflow', name: 'Webflow', category: 'sales', mark: 'Wf', color: '#146ef5', description: 'Manage Webflow sites, pages and CMS collections.' }, 'https://mcp.webflow.com/mcp'),
  blocked({ id: 'hubspot', name: 'HubSpot', category: 'sales', mark: 'HS', color: '#ff7a59', description: 'Contacts, companies, deals and tickets in HubSpot.' }, 'https://mcp.hubspot.com/anthropic'),

  oauth({ id: 'stripe', name: 'Stripe', category: 'finance', mark: 'S', color: '#635bff', description: 'Look up customers, payments and invoices, and search the Stripe docs.', docs: 'https://docs.stripe.com/mcp' }, 'https://mcp.stripe.com'),
  oauth({ id: 'paypal', name: 'PayPal', category: 'finance', mark: 'PP', color: '#003087', description: 'Invoices, orders, subscriptions and transaction reports in PayPal.', docs: 'https://developer.paypal.com/tools/mcp-server/' }, 'https://mcp.paypal.com/mcp'),
  oauth({ id: 'square', name: 'Square', category: 'finance', mark: 'Sq', color: '#000000', description: 'Payments, orders, catalog and customers in Square.' }, 'https://mcp.squareup.com/mcp'),
  oauth({ id: 'ramp', name: 'Ramp', category: 'finance', mark: 'R', color: '#e4f222', description: 'Spend, cards, bills and reimbursements in Ramp.' }, 'https://mcp.ramp.com/mcp'),
  oauth({ id: 'expensify', name: 'Expensify', category: 'finance', mark: 'Ex', color: '#03d47c', description: 'Expenses and reports in Expensify.' }, 'https://www.expensify.com/mcp'),
  oauth({ id: 'airwallex', name: 'Airwallex', category: 'finance', mark: 'Aw', color: '#612fff', description: 'Balances, transfers and payments in Airwallex.' }, 'https://mcp.airwallex.com/mcp'),
  oauth({ id: 'gusto', name: 'Gusto', category: 'finance', mark: 'Gs', color: '#f45d48', description: 'Payroll, people and benefits data in Gusto.' }, 'https://mcp.api.gusto.com/anthropic'),
  oauth({ id: 'plaid', name: 'Plaid', category: 'finance', mark: 'Pl', color: '#111111', description: 'Your Plaid dashboard: items, usage and link analytics.' }, 'https://api.dashboard.plaid.com/mcp'),
  oauth({ id: 'dodo-payments', name: 'Dodo Payments', category: 'finance', mark: 'Dd', color: '#0f172a', description: 'Payments, subscriptions and customers in Dodo Payments.' }, 'https://mcp.dodopayments.com/mcp'),
  open({ id: 'shopify', name: 'Shopify store setup', category: 'finance', mark: 'Sh', color: '#5e8e3e', description: 'Plan a new Shopify store: names, domains and store previews.' }, 'https://setup.shopify.com/mcp'),
  blocked({ id: 'xero', name: 'Xero', category: 'finance', mark: 'X', color: '#13b5ea', description: 'Invoices, contacts and accounts in Xero.' }, 'https://mcp.xero.com/mcp'),

  oauth({ id: 'canva', name: 'Canva', category: 'design', mark: 'Cv', color: '#00c4cc', description: 'Search, create and export Canva designs.', docs: 'https://www.canva.dev/docs/connect/canva-mcp-server-setup/' }, 'https://mcp.canva.com/mcp'),
  blocked({ id: 'figma', name: 'Figma', category: 'design', mark: 'Fg', color: '#a259ff', description: 'Read Figma designs, components and variables.' }, 'https://mcp.figma.com/mcp', DCR_REFUSED),
  oauth({ id: 'adobe', name: 'Adobe for creativity', category: 'design', mark: 'Ad', color: '#fa0f00', description: 'Edit images, documents and designs with Adobe tools.' }, 'https://adobe-creativity.adobe.io/mcp'),
  oauth({ id: 'sanity', name: 'Sanity', category: 'design', mark: 'Sa', color: '#f03e2f', description: 'Query and edit content in your Sanity projects.' }, 'https://mcp.sanity.io'),

  {
    id: 'github', name: 'GitHub', category: 'developer', mark: 'GH', color: '#24292f', auth: 'key', server: { transport: 'http', url: 'https://api.githubcopilot.com/mcp/' },
    description: 'Repositories, issues, pull requests, Actions and code search on GitHub.', docs: 'https://github.com/github/github-mcp-server',
    input: { label: 'Personal access token', placeholder: 'github_pat_… or ghp_…', helpUrl: 'https://github.com/settings/personal-access-tokens', secret: true, target: { kind: 'header', name: 'Authorization', format: 'Bearer {value}' } },
  },
  oauth({ id: 'gitlab', name: 'GitLab', category: 'developer', mark: 'GL', color: '#fc6d26', description: 'Projects, issues, merge requests and pipelines on GitLab.com.' }, 'https://gitlab.com/api/v4/mcp'),
  oauth({ id: 'sentry', name: 'Sentry', category: 'developer', mark: 'Se', color: '#362d59', description: 'Investigate errors, issues and releases in your Sentry projects.', docs: 'https://docs.sentry.io/product/sentry-mcp/' }, 'https://mcp.sentry.dev/mcp'),
  oauth({ id: 'supabase', name: 'Supabase', category: 'developer', mark: 'Sb', color: '#3ecf8e', description: 'Manage Supabase projects: tables, SQL, migrations, logs and edge functions.', docs: 'https://supabase.com/docs/guides/getting-started/mcp' }, 'https://mcp.supabase.com/mcp'),
  oauth({ id: 'vercel', name: 'Vercel', category: 'developer', mark: 'V', color: '#000000', description: 'Projects, deployments and logs on Vercel.' }, 'https://mcp.vercel.com'),
  oauth({ id: 'netlify', name: 'Netlify', category: 'developer', mark: 'Nf', color: '#05bdba', description: 'Create, deploy and manage Netlify sites.' }, 'https://netlify-mcp.netlify.app/mcp'),
  oauth({ id: 'neon', name: 'Neon', category: 'developer', mark: 'Ne', color: '#00e599', description: 'Manage Neon Postgres projects, branches and queries.' }, 'https://mcp.neon.tech/mcp'),
  oauth({ id: 'prisma', name: 'Prisma Postgres', category: 'developer', mark: 'Pr', color: '#2d3748', description: 'Create and manage Prisma Postgres databases.' }, 'https://mcp.prisma.io/mcp'),
  oauth({ id: 'planetscale', name: 'PlanetScale', category: 'developer', mark: 'PS', color: '#000000', description: 'Databases, branches and insights on PlanetScale.' }, 'https://mcp.pscale.dev/mcp/planetscale'),
  oauth({ id: 'cockroachdb', name: 'CockroachDB Cloud', category: 'developer', mark: 'Cr', color: '#6933ff', description: 'Clusters and SQL on CockroachDB Cloud.' }, 'https://cockroachlabs.cloud/mcp'),
  blocked({ id: 'railway', name: 'Railway', category: 'developer', mark: 'Rw', color: '#0b0d0e', description: 'Projects, services, deployments and logs on Railway.' }, 'https://mcp.railway.com/mcp', DCR_REFUSED),
  oauth({ id: 'buildkite', name: 'Buildkite', category: 'developer', mark: 'Bk', color: '#14cc80', description: 'Pipelines, builds and job logs in Buildkite.' }, 'https://mcp.buildkite.com/mcp'),
  oauth({ id: 'launchdarkly', name: 'LaunchDarkly', category: 'developer', mark: 'LD', color: '#405bff', description: 'Feature flags and environments in LaunchDarkly.' }, 'https://mcp.launchdarkly.com/mcp'),
  oauth({ id: 'datadog', name: 'Datadog', category: 'developer', mark: 'Dg', color: '#632ca6', description: 'Logs, metrics, monitors and incidents in Datadog.' }, 'https://mcp.datadoghq.com/api/unstable/mcp-server/mcp'),
  oauth({ id: 'axiom', name: 'Axiom', category: 'developer', mark: 'Ax', color: '#111111', description: 'Query logs and events in Axiom datasets.' }, 'https://mcp.axiom.co/mcp'),
  oauth({ id: 'semgrep', name: 'Semgrep', category: 'developer', mark: 'Sg', color: '#00a67d', description: 'Scan code for security issues with Semgrep.' }, 'https://mcp.semgrep.ai/mcp'),
  oauth({ id: 'postman', name: 'Postman', category: 'developer', mark: 'Pm', color: '#ff6c37', description: 'Collections, environments and APIs in Postman.' }, 'https://mcp.postman.com/mcp'),
  oauth({ id: 'jam', name: 'Jam', category: 'developer', mark: 'Jm', color: '#7c3aed', description: 'Read bug reports with console logs and network requests from Jam.' }, 'https://mcp.jam.dev/mcp'),
  oauth({ id: 'cloudflare-bindings', name: 'Cloudflare Workers bindings', category: 'developer', mark: 'CF', color: '#f38020', description: 'Manage Workers, KV, R2 and D1 resources in your Cloudflare account.' }, 'https://bindings.mcp.cloudflare.com/mcp'),
  oauth({ id: 'cloudflare-builds', name: 'Cloudflare Workers builds', category: 'developer', mark: 'CF', color: '#f38020', description: 'Inspect Workers builds and their logs.' }, 'https://builds.mcp.cloudflare.com/mcp'),
  oauth({ id: 'cloudflare-observability', name: 'Cloudflare observability', category: 'developer', mark: 'CF', color: '#f38020', description: 'Query Workers logs and analytics.' }, 'https://observability.mcp.cloudflare.com/mcp'),
  oauth({ id: 'cloudflare-browser', name: 'Cloudflare browser rendering', category: 'developer', mark: 'CF', color: '#f38020', description: 'Fetch pages, take screenshots and convert pages to Markdown.' }, 'https://browser.mcp.cloudflare.com/mcp'),
  blocked({ id: 'pagerduty', name: 'PagerDuty', category: 'developer', mark: 'PD', color: '#06ac38', description: 'Incidents, services and on-call schedules in PagerDuty.' }, 'https://mcp.pagerduty.com/mcp'),
  blocked({ id: 'render', name: 'Render', category: 'developer', mark: 'Rn', color: '#000000', description: 'Services, deploys and logs on Render.' }, 'https://mcp.render.com/mcp'),

  oauth({ id: 'hex', name: 'Hex', category: 'data', mark: 'Hx', color: '#473982', description: 'Search and run Hex projects and analyses.' }, 'https://app.hex.tech/mcp'),
  oauth({ id: 'amplitude', name: 'Amplitude', category: 'data', mark: 'Am', color: '#1e61f0', description: 'Charts, dashboards and product analytics in Amplitude.' }, 'https://mcp.amplitude.com/mcp'),
  oauth({ id: 'mixpanel', name: 'Mixpanel', category: 'data', mark: 'Mp', color: '#7856ff', description: 'Query events, funnels and retention in Mixpanel.' }, 'https://mcp.mixpanel.com/mcp'),
  oauth({ id: 'posthog', name: 'PostHog', category: 'data', mark: 'PH', color: '#f54e00', description: 'Product analytics, feature flags and errors in PostHog.' }, 'https://mcp.posthog.com/mcp'),
  oauth({ id: 'pendo', name: 'Pendo', category: 'data', mark: 'Pe', color: '#ff4876', description: 'Product usage and guides data from Pendo.' }, 'https://app.pendo.io/mcp/v0/shttp'),
  oauth({ id: 'atlan', name: 'Atlan', category: 'data', mark: 'Al', color: '#2026d2', description: 'Search data assets, lineage and glossary in Atlan.' }, 'https://mcp.atlan.com/mcp'),
  oauth({ id: 'vanta', name: 'Vanta', category: 'data', mark: 'Va', color: '#5d36ed', description: 'Compliance tests, controls and evidence in Vanta.' }, 'https://mcp.vanta.com/mcp'),

  open({ id: 'deepwiki', name: 'DeepWiki', category: 'search', mark: 'DW', color: '#2563eb', description: 'Ask questions about any public GitHub repository and read its generated wiki.', docs: 'https://docs.devin.ai/work-with-devin/deepwiki-mcp' }, 'https://mcp.deepwiki.com/mcp'),
  open({ id: 'context7', name: 'Context7', category: 'search', mark: 'C7', color: '#0f766e', description: 'Up-to-date documentation and code examples for thousands of libraries and frameworks.', docs: 'https://github.com/upstash/context7' }, 'https://mcp.context7.com/mcp'),
  open({ id: 'exa', name: 'Exa Search', category: 'search', mark: 'Ex', color: '#1d4ed8', description: 'Neural web search, code search and page crawling built for AI agents.', docs: 'https://docs.exa.ai/reference/exa-mcp' }, 'https://mcp.exa.ai/mcp'),
  open({ id: 'huggingface', name: 'Hugging Face', category: 'search', mark: 'HF', color: '#d97706', description: 'Search models, datasets, Spaces and papers on the Hugging Face Hub.', docs: 'https://huggingface.co/settings/mcp' }, 'https://huggingface.co/mcp'),
  open({ id: 'cloudflare-docs', name: 'Cloudflare Docs', category: 'search', mark: 'CF', color: '#f38020', description: 'Search the Cloudflare developer documentation (Workers, Pages, R2, D1 and more).', docs: 'https://github.com/cloudflare/mcp-server-cloudflare' }, 'https://docs.mcp.cloudflare.com/mcp'),
  oauth({ id: 'tavily', name: 'Tavily', category: 'search', mark: 'Tv', color: '#0ea5e9', description: 'Web search, extraction and crawling built for AI agents.' }, 'https://mcp.tavily.com/mcp/'),
  oauth({ id: 'consensus', name: 'Consensus', category: 'search', mark: 'Cs', color: '#1a73e8', description: 'Search 200M+ research papers and get evidence-based answers.' }, 'https://mcp.consensus.app/mcp'),
  oauth({ id: 'nimble', name: 'Nimble', category: 'search', mark: 'Nb', color: '#0f172a', description: 'Real-time web search and structured page extraction.' }, 'https://mcp.nimbleway.com/mcp'),
  {
    id: 'firecrawl', name: 'Firecrawl', category: 'search', mark: 'Fc', color: '#fa5d19', auth: 'key', server: { transport: 'http', url: 'https://mcp.firecrawl.dev/{value}/v2/mcp' },
    description: 'Scrape, crawl and search the web, returning clean Markdown.', docs: '',
    input: { label: 'Firecrawl API key', placeholder: 'fc-…', secret: true, target: { kind: 'url' } },
  },
  local({ id: 'brave-search', name: 'Brave Search', category: 'search', mark: 'B', color: '#fb542b', description: 'Web, news, image and local search through the Brave Search API.', docs: 'https://github.com/brave/brave-search-mcp-server' },
    'npx', ['-y', '@brave/brave-search-mcp-server'],
    { label: 'Brave Search API key', placeholder: 'BSA…', helpUrl: 'https://api-dashboard.search.brave.com', secret: true, target: { kind: 'env', name: 'BRAVE_API_KEY' } }),
  local({ id: 'fetch', name: 'Fetch', category: 'search', mark: 'F', color: '#15803d', description: 'Fetch any web page and convert it to clean Markdown.', docs: 'https://github.com/modelcontextprotocol/servers/tree/main/src/fetch' },
    'uvx', ['mcp-server-fetch']),

  local({ id: 'filesystem', name: 'Filesystem', category: 'local', mark: 'FS', color: '#475569', description: 'Read and write files in one folder you choose, even in Chat mode.', docs: 'https://github.com/modelcontextprotocol/servers/tree/main/src/filesystem' },
    'npx', ['-y', '@modelcontextprotocol/server-filesystem'],
    { label: 'Folder it may use', placeholder: '/Users/you/Documents', secret: false, target: { kind: 'arg' } }),
  local({ id: 'memory-graph', name: 'Knowledge graph memory', category: 'local', mark: 'KG', color: '#7c3aed', description: 'A local knowledge graph of people, projects and facts the agent can build and query.', docs: 'https://github.com/modelcontextprotocol/servers/tree/main/src/memory' },
    'npx', ['-y', '@modelcontextprotocol/server-memory']),
  local({ id: 'sequential-thinking', name: 'Sequential thinking', category: 'local', mark: 'ST', color: '#0891b2', description: 'Structured step-by-step reasoning for hard, multi-stage problems.', docs: 'https://github.com/modelcontextprotocol/servers/tree/main/src/sequentialthinking' },
    'npx', ['-y', '@modelcontextprotocol/server-sequential-thinking']),
  local({ id: 'playwright', name: 'Playwright browser', category: 'local', mark: 'PW', color: '#2ead33', description: 'Drive a real browser: open pages, click, type, fill forms and take snapshots.', docs: 'https://github.com/microsoft/playwright-mcp' },
    'npx', ['-y', '@playwright/mcp@latest']),
  local({ id: 'chrome-devtools', name: 'Chrome DevTools', category: 'local', mark: 'CD', color: '#4285f4', description: 'Control Chrome and inspect pages: console, network, performance traces.', docs: 'https://github.com/ChromeDevTools/chrome-devtools-mcp' },
    'npx', ['-y', 'chrome-devtools-mcp@latest']),
]

/** Every Google product the built-in connector can expose, in display order. */
export const GOOGLE_SERVICES: readonly GoogleService[] = ['gmail', 'calendar', 'drive', 'docs', 'sheets']
