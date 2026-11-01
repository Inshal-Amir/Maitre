import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { shell } from 'electron';
import type { InstallResult, MarketplaceInfo, PluginInfo, PluginPreview, PluginServerInfo } from '../../shared/types';
import type { GitHubRef } from './fetch';
import type { InstalledPlugin, PluginOrigin } from './store';
import type { EntrySource, MarketplaceEntry, MarketplaceFile, PluginServerSpec, ResolvedPlugin } from './manifest';
import { MARKETPLACE_FILE, manifestFile, readJson, requiredVars, resolvePlugin, serverTarget, skillNames } from './manifest';
import { cloneGit, downloadGitHub, githubLabel, parseGitHub, removeQuietly, tempDir, within } from './fetch';
import { importSkillFolders, skillFoldersIn, skillSlug } from '../skills';
import { pluginDir, pluginsRoot, readInstalled, writeInstalled } from './store';
import { readSecret } from '../settings';

const COPY_SKIP = new Set(['.git', 'node_modules', '.DS_Store']);
const STAGING_TTL_MS = 30 * 60_000;

/** Marketplaces offered before the user adds any. */
const DEFAULT_MARKETPLACES: { source: string; name: string; description: string }[] = [
  { source: 'anthropics/claude-plugins-official', name: 'Claude plugins (official)', description: 'The official Claude Code plugin directory: hundreds of plugins with skills and app connectors.' },
  { source: 'anthropics/skills', name: 'Anthropic skills', description: 'Anthropic\'s skills: Word, Excel, PowerPoint and PDF documents, frontend design, MCP building and more.' },
];

interface StoredMarketplace {
  id: string;
  name: string;
  source: string;
  description?: string;
  pluginRoot?: string;
  entries: MarketplaceEntry[];
  loaded: boolean;
  updatedAt: number;
  error?: string;
}

interface Staged {
  dir: string;
  plugin: Omit<InstalledPlugin, 'enabled' | 'installedAt'>;
  preview: PluginPreview;
  createdAt: number;
}

/** A place a plugin or marketplace can come from: a GitHub repository or a folder on this computer. */
type Location = { kind: 'github'; ref: GitHubRef } | { kind: 'folder'; dir: string };

const marketplacesFile = (): string => path.join(pluginsRoot(), 'marketplaces.json');
const stagingRoot = (): string => path.join(pluginsRoot(), '.staging');

const expandHome = (input: string): string => (input === '~' ? os.homedir() : input.replace(/^~(?=[\\/])/, os.homedir()));

function locate(input: string): Location {
  const text = input.trim();
  if (!text) throw new Error('Enter a GitHub address (owner/repo or a github.com link) or choose a folder.');
  const local = expandHome(text);
  if (path.isAbsolute(local)) {
    if (!fs.existsSync(local) || !fs.statSync(local).isDirectory()) throw new Error(`${local} is not a folder.`);
    return { kind: 'folder', dir: fs.realpathSync(local) };
  }
  const github = parseGitHub(text);
  if (!github) throw new Error('Use a GitHub address like owner/repo or https://github.com/owner/repo, or a full folder path.');
  return { kind: 'github', ref: github };
}

const locationLabel = (location: Location): string => (location.kind === 'github' ? githubLabel(location.ref) : location.dir);

/** The folder for a location: a GitHub download goes to a temporary folder that `cleanup` removes. */
async function materialize(location: Location): Promise<{ dir: string; cleanup(): void }> {
  if (location.kind === 'folder') return { dir: location.dir, cleanup: () => undefined };
  const temp = tempDir(location.ref.repo.toLowerCase());
  try {
    return { dir: await downloadGitHub(location.ref, path.join(temp, 'repo')), cleanup: () => removeQuietly(temp) };
  } catch (error) {
    removeQuietly(temp);
    throw error;
  }
}

function copyTree(from: string, to: string): void {
  fs.cpSync(from, to, { recursive: true, dereference: false, filter: (source) => !COPY_SKIP.has(path.basename(source)) });
}

const marketplaceId = (name: string, source: string): string => skillSlug(name) || skillSlug(source) || crypto.randomBytes(4).toString('hex');

function fromFile(file: MarketplaceFile, source: string, previous?: StoredMarketplace): StoredMarketplace {
  const plugins = (file.plugins ?? []).filter((entry) => entry && typeof entry.name === 'string' && entry.source !== undefined);
  const name = file.name ?? previous?.name ?? source;
  return {
    id: previous?.id ?? marketplaceId(name, source),
    name: previous?.name && DEFAULT_MARKETPLACES.some((entry) => entry.source === source) ? previous.name : name,
    source,
    description: file.metadata?.description ?? file.description ?? previous?.description,
    pluginRoot: file.metadata?.pluginRoot,
    entries: plugins,
    loaded: true,
    updatedAt: Date.now(),
  };
}

function entryAuthor(entry: MarketplaceEntry): string | undefined {
  return typeof entry.author === 'string' ? entry.author : entry.author?.name;
}

export class Plugins {
  private readonly staged = new Map<string, Staged>();

  constructor(private readonly onChange: () => void) {
    removeQuietly(stagingRoot());
  }

  list(): PluginInfo[] {
    return readInstalled().map((plugin) => this.info(plugin));
  }

  private info(plugin: InstalledPlugin): PluginInfo {
    const dir = pluginDir(plugin.id);
    return {
      id: plugin.id, name: plugin.name, description: plugin.description, version: plugin.version, author: plugin.author,
      source: plugin.source, marketplace: plugin.marketplace, dir, enabled: plugin.enabled, ignored: plugin.ignored, installedAt: plugin.installedAt,
      skills: skillNames(dir, plugin.skillDirs),
      commands: plugin.commandFiles.map((file) => skillSlug(path.basename(file, '.md'))),
      servers: this.serverInfos(plugin.id, plugin.servers),
    };
  }

  private serverInfos(pluginId: string, servers: Record<string, PluginServerSpec>): PluginServerInfo[] {
    return Object.entries(servers).map(([name, spec]) => {
      const id = pluginServerId(pluginId, name);
      const saved = savedVars(id);
      return { id, name, target: serverTarget(spec), missingVars: requiredVars(spec).filter((variable) => !saved[variable] && !process.env[variable]) };
    });
  }

  /** Looks at a GitHub repository or folder: a marketplace is added, a plugin is staged for review, plain skills are imported. */
  async inspect(input: string): Promise<InstallResult> {
    const location = locate(input);
    if (location.kind === 'github') {
      const remote = await remoteMarketplace(location.ref);
      if (remote) return { kind: 'marketplace', marketplace: this.marketplaceInfo(this.saveMarketplace(fromFile(remote, githubLabel(location.ref)))) };
    }
    const { dir, cleanup } = await materialize(location);
    let keep = false;
    try {
      const marketplace = readJson<MarketplaceFile>(path.join(dir, MARKETPLACE_FILE));
      if (marketplace && !manifestFile(dir)) {
        const stored = this.saveMarketplace(fromFile(marketplace, location.kind === 'github' ? githubLabel(location.ref) : location.dir));
        return { kind: 'marketplace', marketplace: this.marketplaceInfo(stored) };
      }
      const resolved = resolvePlugin(dir);
      const isPlugin = manifestFile(dir) || resolved.commandFiles.length || Object.keys(resolved.servers).length;
      if (!isPlugin) {
        const skills = importSkillFolders(skillFoldersIn(dir));
        return { kind: 'skills', skills };
      }
      const origin: PluginOrigin = location.kind === 'github' ? { kind: 'github', input: input.trim() } : { kind: 'folder', path: location.dir };
      keep = true;
      return { kind: 'plugin', preview: this.stage(dir, resolved, origin, locationLabel(location), cleanup) };
    } finally {
      if (!keep) cleanup();
    }
  }

  /** Copies a resolved plugin into a staging folder and remembers it until the user confirms or cancels. */
  private stage(dir: string, resolved: ResolvedPlugin, origin: PluginOrigin, source: string, cleanup: () => void, marketplace?: string): PluginPreview {
    this.dropExpired();
    const usable = resolved.skillDirs.length + resolved.commandFiles.length + Object.keys(resolved.servers).length;
    if (!usable) {
      cleanup();
      const ignored = resolved.ignored.length ? ` It only has ${resolved.ignored.join(', ')}, which Maitre does not run.` : '';
      throw new Error(`Nothing Maitre can use was found in this plugin (no skills, commands or MCP servers).${ignored}`);
    }
    const stagingId = crypto.randomUUID();
    const target = path.join(stagingRoot(), stagingId);
    fs.mkdirSync(stagingRoot(), { recursive: true });
    try {
      const onlySkills = !Object.keys(resolved.servers).length && resolved.skillDirs.every((rel) => rel !== '.');
      if (onlySkills) {
        for (const rel of [...resolved.skillDirs, ...resolved.commandFiles]) copyTree(path.join(dir, rel), path.join(target, rel));
      } else {
        copyTree(dir, target);
      }
    } finally {
      cleanup();
    }
    const id = skillSlug(resolved.name) || `plugin-${stagingId.slice(0, 8)}`;
    const plugin: Staged['plugin'] = {
      id, name: resolved.name, description: resolved.description, version: resolved.version, author: resolved.author,
      source, origin, marketplace, ignored: resolved.ignored,
      skillDirs: resolved.skillDirs, commandFiles: resolved.commandFiles, servers: resolved.servers,
    };
    const replaces = readInstalled().some((entry) => entry.id === id) ? id : undefined;
    const preview: PluginPreview = {
      stagingId, id, name: plugin.name, description: plugin.description, version: plugin.version, author: plugin.author, source, marketplace,
      ignored: plugin.ignored, replaces,
      skills: skillNames(target, plugin.skillDirs),
      commands: plugin.commandFiles.map((file) => skillSlug(path.basename(file, '.md'))),
      servers: this.serverInfos(id, plugin.servers),
    };
    this.staged.set(stagingId, { dir: target, plugin, preview, createdAt: Date.now() });
    return preview;
  }

  private dropExpired(): void {
    for (const [id, entry] of this.staged) if (Date.now() - entry.createdAt > STAGING_TTL_MS) this.cancel(id);
  }

  cancel(stagingId: string): void {
    const entry = this.staged.get(stagingId);
    if (!entry) return;
    this.staged.delete(stagingId);
    removeQuietly(entry.dir);
  }

  /** Moves a reviewed plugin into place (replacing an older version) and turns it on. */
  confirm(stagingId: string): PluginInfo {
    const entry = this.staged.get(stagingId);
    if (!entry) throw new Error('This install expired. Start it again.');
    this.staged.delete(stagingId);
    const target = pluginDir(entry.plugin.id);
    const installed = readInstalled();
    const previous = installed.find((plugin) => plugin.id === entry.plugin.id);
    removeQuietly(target);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.renameSync(entry.dir, target);
    const plugin: InstalledPlugin = { ...entry.plugin, enabled: previous?.enabled ?? true, installedAt: Date.now() };
    writeInstalled([...installed.filter((item) => item.id !== plugin.id), plugin]);
    this.onChange();
    return this.info(plugin);
  }

  setEnabled(id: string, enabled: boolean): void {
    writeInstalled(readInstalled().map((plugin) => (plugin.id === id ? { ...plugin, enabled } : plugin)));
    this.onChange();
  }

  async remove(id: string): Promise<void> {
    const dir = pluginDir(id);
    writeInstalled(readInstalled().filter((plugin) => plugin.id !== id));
    if (fs.existsSync(dir)) await shell.trashItem(dir).catch(() => removeQuietly(dir));
    this.onChange();
  }

  /** Fetches the plugin again from where it came from and stages it for review. */
  async update(id: string): Promise<PluginPreview> {
    const plugin = readInstalled().find((entry) => entry.id === id);
    if (!plugin) throw new Error('That plugin is not installed.');
    if (plugin.origin.kind === 'marketplace') {
      await this.refreshMarketplace(plugin.origin.marketplace);
      return this.inspectMarketplacePlugin(plugin.origin.marketplace, plugin.origin.name);
    }
    const result = await this.inspect(plugin.origin.kind === 'github' ? plugin.origin.input : plugin.origin.path);
    if (result.kind !== 'plugin') throw new Error('That source is no longer a plugin.');
    return result.preview;
  }

  private readMarketplaces(): StoredMarketplace[] {
    const stored = readJson<StoredMarketplace[]>(marketplacesFile());
    if (Array.isArray(stored)) return stored;
    return DEFAULT_MARKETPLACES.map((entry) => ({ id: marketplaceId(entry.name, entry.source), name: entry.name, source: entry.source, description: entry.description, entries: [], loaded: false, updatedAt: 0 }));
  }

  private writeMarketplaces(list: StoredMarketplace[]): void {
    fs.mkdirSync(pluginsRoot(), { recursive: true });
    fs.writeFileSync(marketplacesFile(), JSON.stringify(list, null, 2));
  }

  private saveMarketplace(next: StoredMarketplace): StoredMarketplace {
    const list = this.readMarketplaces();
    const existing = list.find((entry) => entry.source === next.source || entry.id === next.id);
    const saved = { ...next, id: existing?.id ?? next.id };
    this.writeMarketplaces([...list.filter((entry) => entry !== existing), saved]);
    return saved;
  }

  private marketplaceInfo(stored: StoredMarketplace): MarketplaceInfo {
    const installed = new Set(readInstalled().filter((plugin) => plugin.marketplace === stored.id).map((plugin) => plugin.origin.kind === 'marketplace' ? plugin.origin.name : plugin.name));
    return {
      id: stored.id, name: stored.name, source: stored.source, description: stored.description, loaded: stored.loaded, updatedAt: stored.updatedAt, error: stored.error,
      plugins: stored.entries.map((entry) => ({
        name: entry.name, description: entry.description ?? '', category: entry.category, author: entryAuthor(entry), homepage: entry.homepage, installed: installed.has(entry.name),
      })),
    };
  }

  marketplaces(): MarketplaceInfo[] {
    return this.readMarketplaces().map((entry) => this.marketplaceInfo(entry));
  }

  /** Downloads the marketplace's catalog (only the JSON file for GitHub, not the whole repository). */
  async refreshMarketplace(id: string): Promise<MarketplaceInfo> {
    const stored = this.readMarketplaces().find((entry) => entry.id === id);
    if (!stored) throw new Error('Unknown marketplace.');
    try {
      const file = await loadMarketplaceFile(locate(stored.source));
      return this.marketplaceInfo(this.saveMarketplace(fromFile(file, stored.source, stored)));
    } catch (error) {
      const failed = this.saveMarketplace({ ...stored, error: (error as Error).message });
      return this.marketplaceInfo(failed);
    }
  }

  removeMarketplace(id: string): void {
    this.writeMarketplaces(this.readMarketplaces().filter((entry) => entry.id !== id));
  }

  async inspectMarketplacePlugin(id: string, name: string): Promise<PluginPreview> {
    const market = this.readMarketplaces().find((entry) => entry.id === id);
    const entry = market?.entries.find((candidate) => candidate.name === name);
    if (!market || !entry) throw new Error('That plugin is not in the marketplace any more. Refresh it and try again.');
    const location = entryLocation(market, entry.source);
    const { dir, cleanup } = await materializeEntry(location);
    try {
      const resolved = resolvePlugin(dir, entry);
      return this.stage(dir, { ...resolved, name: entry.name, description: resolved.description || entry.description || '' }, { kind: 'marketplace', marketplace: id, name }, `${market.name} · ${entry.name}`, cleanup, id);
    } catch (error) {
      cleanup();
      throw error;
    }
  }

  /** Plugin MCP servers to connect: those of enabled plugins. */
  servers(): PluginServer[] {
    return readInstalled().filter((plugin) => plugin.enabled).flatMap((plugin) => Object.entries(plugin.servers).map(([name, spec]) => ({
      id: pluginServerId(plugin.id, name), name, plugin: plugin.id, pluginName: plugin.name, spec, root: pluginDir(plugin.id),
    })));
  }
}

export interface PluginServer {
  id: string;
  name: string;
  plugin: string;
  pluginName: string;
  spec: PluginServerSpec;
  root: string;
}

export const pluginServerId = (pluginId: string, server: string): string => `plugin-${pluginId}-${skillSlug(server) || 'server'}`.slice(0, 80);

/** Values the user entered for a server's `${VAR}` placeholders (or a custom server's env/headers). */
export function savedVars(serverId: string): Record<string, string> {
  try {
    const parsed = JSON.parse(readSecret(`mcp-${serverId}-vars`) ?? '{}') as Record<string, string>;
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {};
  }
}

type EntryLocation = { kind: 'github'; ref: GitHubRef } | { kind: 'git'; url: string; ref?: string; path?: string } | { kind: 'folder'; dir: string };

const joinPath = (...parts: (string | undefined)[]): string | undefined => {
  const joined = parts.filter((part): part is string => Boolean(part) && part !== '.' && part !== './').map((part) => part.replace(/^\.\//, '').replace(/\/+$/, '')).join('/');
  return joined || undefined;
};

function entryLocation(market: StoredMarketplace, source: EntrySource): EntryLocation {
  if (typeof source === 'string') {
    const relative = joinPath(market.pluginRoot, source);
    const base = locate(market.source);
    if (base.kind === 'folder') return { kind: 'folder', dir: within(base.dir, relative) };
    return { kind: 'github', ref: { ...base.ref, path: joinPath(base.ref.path, relative) } };
  }
  const ref = source.sha ?? source.ref;
  if (source.source === 'github' && source.repo) {
    const parsed = parseGitHub(source.repo);
    if (!parsed) throw new Error(`Bad GitHub repository "${source.repo}" in the marketplace.`);
    return { kind: 'github', ref: { ...parsed, ref: ref ?? parsed.ref, path: source.path } };
  }
  if (source.url && ['url', 'git', 'git-subdir'].includes(source.source)) {
    const github = parseGitHub(source.url);
    if (github) return { kind: 'github', ref: { ...github, ref: ref ?? github.ref, path: source.path ?? github.path } };
    return { kind: 'git', url: source.url, ref, path: source.path };
  }
  throw new Error(`Plugins from "${source.source}" sources cannot be installed in Maitre yet (only GitHub, git and folders).`);
}

async function materializeEntry(location: EntryLocation): Promise<{ dir: string; cleanup(): void }> {
  if (location.kind === 'folder') return { dir: location.dir, cleanup: () => undefined };
  if (location.kind === 'github') return materialize(location);
  const temp = tempDir('git');
  try {
    return { dir: await cloneGit(location.url, location.ref, path.join(temp, 'repo'), location.path), cleanup: () => removeQuietly(temp) };
  } catch (error) {
    removeQuietly(temp);
    throw error;
  }
}

/** A GitHub repository that is a marketplace (and not itself a plugin), read without downloading it. */
async function remoteMarketplace(ref: GitHubRef): Promise<MarketplaceFile | null> {
  const raw = (file: string): Promise<Response> => fetch(`https://raw.githubusercontent.com/${ref.owner}/${ref.repo}/${encodeURIComponent(ref.ref ?? 'HEAD')}/${ref.path ? `${ref.path}/` : ''}${file}`, { headers: { 'user-agent': 'maitre-desktop' }, signal: AbortSignal.timeout(20_000) });
  try {
    const [marketplace, plugin] = await Promise.all([raw(MARKETPLACE_FILE), raw('.claude-plugin/plugin.json')]);
    if (!marketplace.ok || plugin.ok) return null;
    const file = (await marketplace.json()) as MarketplaceFile;
    return Array.isArray(file.plugins) ? file : null;
  } catch {
    return null;
  }
}

async function loadMarketplaceFile(location: Location): Promise<MarketplaceFile> {
  if (location.kind === 'folder') {
    const file = readJson<MarketplaceFile>(path.join(location.dir, MARKETPLACE_FILE));
    if (!file) throw new Error(`No ${MARKETPLACE_FILE} in ${location.dir}.`);
    return file;
  }
  const { owner, repo, ref, path: sub } = location.ref;
  const token = readSecret('github-token');
  const url = `https://raw.githubusercontent.com/${owner}/${repo}/${encodeURIComponent(ref ?? 'HEAD')}/${sub ? `${sub}/` : ''}${MARKETPLACE_FILE}`;
  const response = await fetch(url, { headers: { 'user-agent': 'maitre-desktop', ...(token ? { authorization: `Bearer ${token}` } : {}) }, signal: AbortSignal.timeout(30_000) });
  if (response.status === 404) throw new Error(`${owner}/${repo} has no ${MARKETPLACE_FILE}.`);
  if (!response.ok) throw new Error(`Could not load the marketplace (HTTP ${response.status}).`);
  const file = (await response.json()) as MarketplaceFile;
  if (!Array.isArray(file.plugins)) throw new Error('That marketplace file has no plugin list.');
  return file;
}
