import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { findSkill, skillsChanged } from '../src/main/skills';
import { pluginDir } from '../src/main/plugins/store';
import { Connectors } from '../src/main/mcp/connectors';
import { Plugins } from '../src/main/plugins';
import { MCP_CATALOG, catalogServer } from '../src/shared/catalog';

/** Real downloads from GitHub; run with MAITRE_LIVE_GITHUB=1 npx vitest run tests/github-live.test.ts */
describe.runIf(process.env.MAITRE_LIVE_GITHUB === '1')('GitHub marketplaces (live)', () => {
  const plugins = new Plugins(() => skillsChanged());

  it('loads the official plugin directory and Anthropic skills, and installs document skills', async () => {
    const markets = plugins.marketplaces();
    const official = await plugins.refreshMarketplace(markets.find((entry) => entry.source === 'anthropics/claude-plugins-official')!.id);
    expect(official.error).toBeUndefined();
    expect(official.plugins.length).toBeGreaterThan(50);
    const skills = await plugins.refreshMarketplace(markets.find((entry) => entry.source === 'anthropics/skills')!.id);
    expect(skills.plugins.map((entry) => entry.name)).toContain('document-skills');

    const preview = await plugins.inspectMarketplacePlugin(skills.id, 'document-skills');
    expect(preview.skills.sort()).toEqual(['docx', 'pdf', 'pptx', 'xlsx']);
    plugins.confirm(preview.stagingId);
    expect(findSkill('pdf')?.files.length).toBeGreaterThan(0);
    expect(fs.existsSync(path.join(pluginDir('document-skills'), 'skills', 'frontend-design'))).toBe(false);

    const direct = await plugins.inspect('https://github.com/anthropics/skills/tree/main/skills/frontend-design');
    expect(direct.kind).toBe('skills');
    expect(findSkill('frontend-design')?.source).toBe('user');
  }, 180_000);

  it('installs plugins from the official directory that bring MCP servers', async () => {
    const official = plugins.marketplaces().find((entry) => entry.source === 'anthropics/claude-plugins-official')!;
    const github = await plugins.inspectMarketplacePlugin(official.id, 'github');
    expect(github.servers).toEqual([expect.objectContaining({ name: 'github', missingVars: ['GITHUB_PERSONAL_ACCESS_TOKEN'] })]);
    plugins.cancel(github.stagingId);

    const context7 = await plugins.inspectMarketplacePlugin(official.id, 'context7');
    expect(context7.servers).toEqual([expect.objectContaining({ name: 'context7', missingVars: [] })]);
    plugins.confirm(context7.stagingId);
    expect(plugins.servers().map((server) => server.id)).toContain('plugin-context7-context7');
  }, 180_000);

  it('connects gallery servers that need no sign-in', async () => {
    const connectors = new Connectors(() => undefined);
    for (const id of ['context7', 'deepwiki', 'exa', 'cloudflare-docs', 'huggingface']) {
      const entry = MCP_CATALOG.find((item) => item.id === id)!;
      await connectors.saveServer(catalogServer(entry, {}));
      const status = connectors.statuses().find((item) => item.id === id);
      expect(`${id}: ${status?.state} ${status?.detail}`).toMatch(new RegExp(`^${id}: connected`));
    }
    await connectors.manager.closeAll();
  }, 180_000);
});
