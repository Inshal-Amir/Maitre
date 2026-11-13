import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterAll, describe, expect, it } from 'vitest';
import type { ConnectorStatus } from '../src/shared/types';
import type { ToolContext } from '../src/main/tools/types';
import { findSkill, listSkills, resolveInvocation, skillsChanged } from '../src/main/skills';
import { getSettings, readSecret } from '../src/main/settings';
import { Connectors } from '../src/main/mcp/connectors';
import { parseGitHub } from '../src/main/plugins/fetch';
import { pluginDir } from '../src/main/plugins/store';
import { Plugins } from '../src/main/plugins';

const context: ToolContext = { conversationId: 'c', mode: 'chat', cwd: os.tmpdir(), signal: new AbortController().signal };
const fixture = (name: string): string => path.join(__dirname, 'fixtures', name);

function write(root: string, files: Record<string, string>): string {
  for (const [file, content] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
    fs.writeFileSync(path.join(root, file), content);
  }
  return root;
}

/** A Claude Code plugin: manifest, a skill, a command, an MCP server needing a key, and hooks Maitre ignores. */
function makePlugin(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'plugin-src-'));
  return write(root, {
    '.claude-plugin/plugin.json': JSON.stringify({ name: 'demo-kit', description: 'Demo plugin', version: '1.2.0', author: { name: 'Menthiq' } }),
    'skills/summarize/SKILL.md': '---\nname: summarize\ndescription: Summarizes long text into five bullet points.\n---\n\nUse five bullets. Plugin root: ${CLAUDE_PLUGIN_ROOT}',
    'commands/standup.md': '---\ndescription: Write my standup\nargument-hint: <notes>\n---\nTurn these notes into a standup: $ARGUMENTS',
    'server/run.mjs': `import ${JSON.stringify(pathToFileURL(fixture('env-server.mjs')).href)};\n`,
    '.mcp.json': JSON.stringify({ mcpServers: { demo: { command: process.execPath, args: ['${CLAUDE_PLUGIN_ROOT}/server/run.mjs'], env: { DEMO_TOKEN: '${DEMO_TOKEN}', DEMO_ROOT: '${CLAUDE_PLUGIN_ROOT}' } } } }),
    'hooks/hooks.json': '{"hooks":{}}',
    'node_modules/big/index.js': 'x',
  });
}

async function waitFor(check: () => boolean, ms = 15_000): Promise<void> {
  const end = Date.now() + ms;
  while (!check()) {
    if (Date.now() > end) throw new Error('timed out');
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

describe('GitHub addresses', () => {
  it('parses the forms people paste', () => {
    expect(parseGitHub('anthropics/skills')).toEqual({ owner: 'anthropics', repo: 'skills', ref: undefined });
    expect(parseGitHub('owner/repo#v2')).toEqual({ owner: 'owner', repo: 'repo', ref: 'v2' });
    expect(parseGitHub('https://github.com/owner/repo.git')).toEqual({ owner: 'owner', repo: 'repo', ref: undefined });
    expect(parseGitHub('github.com/owner/repo/tree/main/plugins/x')).toEqual({ owner: 'owner', repo: 'repo', ref: 'main', path: 'plugins/x' });
    expect(parseGitHub('git@github.com:owner/repo.git')).toEqual({ owner: 'owner', repo: 'repo' });
    expect(parseGitHub('https://gitlab.com/owner/repo')).toBeNull();
    expect(parseGitHub('not a repo')).toBeNull();
  });
});

describe('plugins', () => {
  let changes = 0;
  const plugins = new Plugins(() => {
    changes++;
    skillsChanged();
  });
  const statuses: ConnectorStatus[][] = [];
  const connectors = new Connectors((list) => statuses.push(list), () => plugins.servers());
  afterAll(() => connectors.manager.closeAll());
  const server = (): ConnectorStatus | undefined => connectors.statuses().find((status) => status.kind === 'plugin');

  it('reviews a plugin folder before installing, then installs its skills, commands and server', async () => {
    const result = await plugins.inspect(makePlugin());
    if (result.kind !== 'plugin') throw new Error(`expected a plugin, got ${result.kind}`);
    const { preview } = result;
    expect(preview).toMatchObject({ id: 'demo-kit', name: 'demo-kit', version: '1.2.0', author: 'Menthiq', skills: ['summarize'], commands: ['standup'], ignored: ['hooks'] });
    expect(preview.servers).toEqual([{ id: 'plugin-demo-kit-demo', name: 'demo', target: `${process.execPath} \${CLAUDE_PLUGIN_ROOT}/server/run.mjs`, missingVars: ['DEMO_TOKEN'] }]);
    expect(findSkill('demo-kit:summarize')).toBeNull();
    expect(changes).toBe(0);

    const installed = plugins.confirm(preview.stagingId);
    expect(installed.enabled).toBe(true);
    expect(fs.existsSync(path.join(installed.dir, 'node_modules'))).toBe(false);
    expect(changes).toBe(1);
    expect(plugins.list().map((plugin) => plugin.id)).toEqual(['demo-kit']);

    const skill = findSkill('summarize');
    expect(skill).toMatchObject({ name: 'demo-kit:summarize', source: 'plugin', plugin: 'demo-kit' });
    expect(resolveInvocation('/standup fixed login bug')?.instructions).toBe('Turn these notes into a standup: fixed login bug');
    expect(resolveInvocation('/demo-kit:summarize')?.instructions).toBe(`Use five bullets. Plugin root: ${pluginDir('demo-kit')}`);
    expect(listSkills().find((entry) => entry.name === 'demo-kit:standup')).toMatchObject({ kind: 'command', modelInvocable: false });
  });

  it('holds a plugin server until its key is entered, then connects with it', async () => {
    await connectors.syncPlugins();
    expect(server()).toMatchObject({ id: 'plugin-demo-kit-demo', state: 'needs-auth', plugin: 'demo-kit' });
    expect(server()?.detail).toContain('DEMO_TOKEN');

    await connectors.setServerVars('plugin-demo-kit-demo', { DEMO_TOKEN: 'secret-123' });
    expect(server()).toMatchObject({ state: 'connected', tools: ['demo_show_token'] });
    expect(readSecret('mcp-plugin-demo-kit-demo-vars')).toContain('secret-123');
    expect(plugins.list()[0].servers[0].missingVars).toEqual([]);
    const tool = connectors.tools().find((entry) => entry.name === 'demo_show_token')!;
    expect(await tool.run({}, context)).toBe(`token=secret-123 root=${pluginDir('demo-kit')}`);
    expect(connectors.connectedApps()[0]).toContain('[plugin demo-kit]');
  });

  it('turns a plugin off and on, and removes it', async () => {
    plugins.setEnabled('demo-kit', false);
    await connectors.syncPlugins();
    expect(findSkill('summarize')).toBeNull();
    expect(server()).toBeUndefined();
    plugins.setEnabled('demo-kit', true);
    await connectors.syncPlugins();
    await waitFor(() => server()?.state === 'connected');
    expect(findSkill('summarize')).not.toBeNull();

    await plugins.remove('demo-kit');
    await connectors.syncPlugins();
    expect(plugins.list()).toEqual([]);
    expect(fs.existsSync(pluginDir('demo-kit'))).toBe(false);
    expect(server()).toBeUndefined();
  });

  it('reads a single-skill plugin whose SKILL.md sits next to its plugin.json', async () => {
    const root = write(fs.mkdtempSync(path.join(os.tmpdir(), 'root-skill-')), {
      '.claude-plugin/plugin.json': '{"name":"pdf-maker","description":"Makes PDFs"}',
      'SKILL.md': '---\nname: pdf-maker\ndescription: Turns markdown into a PDF.\n---\nUse pandoc.',
    });
    const result = await plugins.inspect(root);
    if (result.kind !== 'plugin') throw new Error(`expected a plugin, got ${result.kind}`);
    expect(result.preview.skills).toEqual(['pdf-maker']);
  });

  it('rejects a plugin that only has parts Maitre does not run', async () => {
    const root = write(fs.mkdtempSync(path.join(os.tmpdir(), 'hooks-only-')), { '.claude-plugin/plugin.json': '{"name":"hooky"}', 'hooks/hooks.json': '{}', 'agents/a.md': 'x' });
    await expect(plugins.inspect(root)).rejects.toThrow(/Nothing Maitre can use.*agents, hooks/);
  });

  it('imports a folder of plain skills directly', async () => {
    const root = write(fs.mkdtempSync(path.join(os.tmpdir(), 'skills-repo-')), {
      'skills/alpha/SKILL.md': '---\nname: alpha\ndescription: Alpha skill for the import test.\n---\nAlpha',
      'skills/beta/SKILL.md': '---\nname: beta\ndescription: Beta skill for the import test.\n---\nBeta',
    });
    const result = await plugins.inspect(root);
    expect(result.kind).toBe('skills');
    expect(findSkill('alpha')?.source).toBe('user');
  });

  it('adds a marketplace and installs only the skills an entry lists', async () => {
    const root = write(fs.mkdtempSync(path.join(os.tmpdir(), 'market-')), {
      '.claude-plugin/marketplace.json': JSON.stringify({
        name: 'team-tools',
        metadata: { description: 'Our team plugins' },
        plugins: [
          { name: 'docs-pack', description: 'Document skills', source: './', strict: false, skills: ['./skills/word', './skills/pdf'] },
          { name: 'notes', description: 'Notes server', source: './plugins/notes', category: 'productivity', author: { name: 'Team' } },
          { name: 'from-npm', description: 'Not supported', source: { source: 'npm', package: 'x' } },
        ],
      }),
      'skills/word/SKILL.md': '---\nname: word\ndescription: Writes Word documents with python-docx.\n---\nWord',
      'skills/pdf/SKILL.md': '---\nname: pdf\ndescription: Reads and fills PDF files.\n---\nPDF',
      'skills/art/SKILL.md': '---\nname: art\ndescription: Not part of docs-pack.\n---\nArt',
      'plugins/notes/.mcp.json': JSON.stringify({ notes: { command: process.execPath, args: [fixture('notes-server.mjs')] } }),
    });
    const result = await plugins.inspect(root);
    if (result.kind !== 'marketplace') throw new Error(`expected a marketplace, got ${result.kind}`);
    expect(result.marketplace).toMatchObject({ name: 'team-tools', description: 'Our team plugins', loaded: true });
    expect(result.marketplace.plugins.map((entry) => entry.name)).toEqual(['docs-pack', 'notes', 'from-npm']);
    expect(plugins.marketplaces().map((entry) => entry.name)).toEqual(expect.arrayContaining(['Claude plugins (official)', 'Anthropic skills', 'team-tools']));

    const docs = await plugins.inspectMarketplacePlugin(result.marketplace.id, 'docs-pack');
    expect(docs.skills.sort()).toEqual(['pdf', 'word']);
    plugins.confirm(docs.stagingId);
    expect(fs.existsSync(path.join(pluginDir('docs-pack'), 'skills', 'art'))).toBe(false);
    expect(findSkill('docs-pack:pdf')).not.toBeNull();
    expect(findSkill('art')).toBeNull();

    const notes = await plugins.inspectMarketplacePlugin(result.marketplace.id, 'notes');
    expect(notes.servers.map((entry) => entry.name)).toEqual(['notes']);
    plugins.confirm(notes.stagingId);
    await connectors.syncPlugins();
    expect(connectors.statuses().find((status) => status.id === 'plugin-notes-notes')).toMatchObject({ state: 'connected' });
    expect(plugins.marketplaces().find((entry) => entry.id === result.marketplace.id)?.plugins.filter((entry) => entry.installed).map((entry) => entry.name)).toEqual(['docs-pack', 'notes']);

    await expect(plugins.inspectMarketplacePlugin(result.marketplace.id, 'from-npm')).rejects.toThrow(/"npm" sources/);
    const refreshed = await plugins.refreshMarketplace(result.marketplace.id);
    expect(refreshed.error).toBeUndefined();
    plugins.removeMarketplace(result.marketplace.id);
    expect(plugins.marketplaces().some((entry) => entry.id === result.marketplace.id)).toBe(false);
  });

  it('updates an installed plugin from its source after review', async () => {
    const source = makePlugin();
    const first = await plugins.inspect(source);
    if (first.kind !== 'plugin') throw new Error('expected plugin');
    plugins.confirm(first.preview.stagingId);
    write(source, { 'skills/extra/SKILL.md': '---\nname: extra\ndescription: Added in version two of the plugin.\n---\nExtra' });
    const next = await plugins.update('demo-kit');
    expect(next.replaces).toBe('demo-kit');
    expect(next.skills.sort()).toEqual(['extra', 'summarize']);
    plugins.cancel(next.stagingId);
    expect(findSkill('demo-kit:extra')).toBeNull();
  });
});

describe('custom MCP servers', () => {
  const connectors = new Connectors(() => undefined);
  afterAll(() => connectors.manager.closeAll());

  it('imports Claude Desktop JSON and keeps env values out of settings.json', async () => {
    const json = JSON.stringify({ mcpServers: { 'Team Notes': { command: process.execPath, args: [fixture('notes-server.mjs')], env: { NOTES_KEY: 'k-999' } }, remote: { url: 'https://example.invalid/mcp', headers: { Authorization: 'Bearer abc' }, disabled: true } } });
    expect(await connectors.importJson(json)).toBe(2);
    const settings = getSettings();
    const notes = settings.mcpServers.find((server) => server.name === 'Team Notes')!;
    expect(notes).toMatchObject({ id: 'team-notes', type: 'stdio', envKeys: ['NOTES_KEY'] });
    expect(settings.mcpServers.find((server) => server.id === 'remote')).toMatchObject({ type: 'http', enabled: false, headerKeys: ['Authorization'] });
    expect(JSON.stringify(settings)).not.toContain('k-999');
    expect(JSON.stringify(settings)).not.toContain('Bearer abc');
    expect(readSecret('mcp-team-notes-config')).toContain('k-999');
    expect(connectors.statuses().find((status) => status.id === 'team-notes')).toMatchObject({ state: 'connected', tools: ['team_notes_add_note', 'team_notes_list_notes', 'team_notes_delete_all'] });

    await connectors.saveServer({ ...notes, env: { NOTES_KEY: '' } });
    expect(readSecret('mcp-team-notes-config')).toContain('k-999');
    await connectors.removeServer('team-notes');
    expect(readSecret('mcp-team-notes-config')).toBeNull();
    await expect(connectors.importJson('{"nothing": 1}')).rejects.toThrow(/No servers found/);
    await expect(connectors.importJson('{oops')).rejects.toThrow(/not valid JSON/);
  });

  it('finds programs on PATH', () => {
    const [nodeCheck, missing] = connectors.checkCommands([path.basename(process.execPath), 'definitely-not-installed-xyz']);
    expect(nodeCheck.found).toBe(true);
    expect(missing.found).toBe(false);
  });
});
