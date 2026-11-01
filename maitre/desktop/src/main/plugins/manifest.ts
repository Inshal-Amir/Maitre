import fs from 'node:fs';
import path from 'node:path';
import { parseFrontmatter } from '../skills/parse';
import { skillSlug } from '../skills';

/** One server from a plugin's `.mcp.json` (Claude Code format), before `${…}` placeholders are filled in. */
export interface PluginServerSpec {
  type?: string;
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  url?: string;
  headers?: Record<string, string>;
}

type PathList = string | string[];

/** `.claude-plugin/plugin.json`, or the same fields on a marketplace entry. */
export interface RawManifest {
  name?: string;
  description?: string;
  version?: string;
  author?: string | { name?: string };
  skills?: PathList;
  commands?: PathList;
  mcpServers?: PathList | Record<string, PluginServerSpec> | { mcpServers: Record<string, PluginServerSpec> };
  agents?: PathList;
  hooks?: PathList | object;
  lspServers?: PathList | object;
  outputStyles?: PathList;
}

/** `github` (repo), `url` / `git-subdir` (url, path); ref or sha pin a version. */
export interface SourceObject {
  source: string;
  repo?: string;
  url?: string;
  ref?: string;
  sha?: string;
  path?: string;
}

/** A relative path inside the marketplace, or a source object. */
export type EntrySource = string | SourceObject;

export interface MarketplaceEntry extends RawManifest {
  name: string;
  source: EntrySource;
  category?: string;
  homepage?: string;
  strict?: boolean;
}

export interface MarketplaceFile {
  name?: string;
  owner?: { name?: string };
  metadata?: { description?: string; pluginRoot?: string };
  description?: string;
  plugins?: MarketplaceEntry[];
}

/** A plugin folder resolved to what Maitre uses (paths relative to the plugin folder). */
export interface ResolvedPlugin {
  name: string;
  description: string;
  version?: string;
  author?: string;
  skillDirs: string[];
  commandFiles: string[];
  servers: Record<string, PluginServerSpec>;
  ignored: string[];
}

const MANIFESTS = ['.claude-plugin/plugin.json', 'plugin.json', '.maitre-plugin/plugin.json'];
export const MARKETPLACE_FILE = '.claude-plugin/marketplace.json';

export function readJson<T>(file: string): T | null {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8').replace(/^﻿/, '')) as T;
  } catch {
    return null;
  }
}

export function manifestFile(dir: string): string | null {
  return MANIFESTS.map((name) => path.join(dir, name)).find((file) => fs.existsSync(file)) ?? null;
}

const list = (value: PathList | undefined): string[] => (value === undefined ? [] : Array.isArray(value) ? value : [value]).filter((entry): entry is string => typeof entry === 'string');

/** Relative path inside `root`, or null when it escapes or does not exist. */
function inside(root: string, relative: string): string | null {
  const target = path.resolve(root, relative);
  const rel = path.relative(root, target);
  if (rel.startsWith('..') || path.isAbsolute(rel) || !fs.existsSync(target)) return null;
  return rel.split(path.sep).join('/') || '.';
}

const hasSkillFile = (dir: string): boolean => fs.existsSync(path.join(dir, 'SKILL.md')) || fs.existsSync(path.join(dir, 'skill.md'));

function childDirs(dir: string): string[] {
  try {
    return fs.readdirSync(dir, { withFileTypes: true }).filter((entry) => entry.isDirectory() && !entry.name.startsWith('.')).map((entry) => path.join(dir, entry.name));
  } catch {
    return [];
  }
}

/** A path that is a skill folder, or a folder of skill folders. */
function skillDirsAt(root: string, relative: string): string[] {
  const rel = inside(root, relative);
  if (!rel) return [];
  const dir = path.join(root, rel);
  if (hasSkillFile(dir)) return [rel];
  return childDirs(dir).filter(hasSkillFile).map((child) => path.relative(root, child).split(path.sep).join('/'));
}

function commandFilesAt(root: string, relative: string): string[] {
  const rel = inside(root, relative);
  if (!rel) return [];
  const target = path.join(root, rel);
  if (fs.statSync(target).isFile()) return rel.endsWith('.md') ? [rel] : [];
  return fs.readdirSync(target).filter((name) => name.endsWith('.md')).map((name) => `${rel === '.' ? '' : `${rel}/`}${name}`);
}

function serverMap(value: object | null): Record<string, PluginServerSpec> {
  if (!value) return {};
  const wrapped = (value as { mcpServers?: Record<string, PluginServerSpec> }).mcpServers;
  const map = (wrapped && typeof wrapped === 'object' ? wrapped : value) as Record<string, PluginServerSpec>;
  return Object.fromEntries(Object.entries(map).filter(([, spec]) => spec && typeof spec === 'object' && (typeof spec.command === 'string' || typeof spec.url === 'string')));
}

function servers(root: string, field: RawManifest['mcpServers']): Record<string, PluginServerSpec> {
  if (field && typeof field === 'object' && !Array.isArray(field)) return serverMap(field);
  const files = field === undefined ? ['.mcp.json'] : list(field as PathList);
  return Object.assign({}, ...files.map((file) => {
    const rel = inside(root, file);
    return rel ? serverMap(readJson<object>(path.join(root, rel))) : {};
  }));
}

function ignoredParts(root: string, manifest: RawManifest): string[] {
  const parts: string[] = [];
  if (manifest.agents !== undefined || fs.existsSync(path.join(root, 'agents'))) parts.push('agents');
  if (manifest.hooks !== undefined || fs.existsSync(path.join(root, 'hooks', 'hooks.json'))) parts.push('hooks');
  if (manifest.lspServers !== undefined || fs.existsSync(path.join(root, '.lsp.json'))) parts.push('LSP servers');
  if (manifest.outputStyles !== undefined) parts.push('output styles');
  return parts;
}

const authorName = (author: RawManifest['author']): string | undefined => (typeof author === 'string' ? author : author?.name) || undefined;

/**
 * Resolves a plugin folder. Explicit `skills` / `commands` paths replace the default `skills/` and `commands/` folders,
 * so a marketplace entry can pick a few skills out of a larger repository.
 */
export function resolvePlugin(root: string, entry?: MarketplaceEntry): ResolvedPlugin {
  const file = manifestFile(root);
  const own = (file ? readJson<RawManifest>(file) : null) ?? {};
  const manifest: RawManifest = entry && entry.strict === false ? { ...own, ...entry } : { ...entry, ...own };
  const skillPaths = list(manifest.skills);
  const commandPaths = list(manifest.commands);
  const skillDirs = skillPaths.length ? skillPaths.flatMap((rel) => skillDirsAt(root, rel)) : [...skillDirsAt(root, 'skills'), ...(hasSkillFile(root) && !file ? ['.'] : [])];
  const commandFiles = commandPaths.length ? commandPaths.flatMap((rel) => commandFilesAt(root, rel)) : commandFilesAt(root, 'commands');
  return {
    name: manifest.name || entry?.name || path.basename(root),
    description: manifest.description ?? '',
    version: manifest.version,
    author: authorName(manifest.author),
    skillDirs: [...new Set(skillDirs)],
    commandFiles: [...new Set(commandFiles)],
    servers: servers(root, manifest.mcpServers),
    ignored: ignoredParts(root, manifest),
  };
}

/** Skill names inside a resolved plugin (for the review screen). */
export function skillNames(root: string, dirs: string[]): string[] {
  return dirs.map((rel) => {
    const dir = path.join(root, rel);
    const file = ['SKILL.md', 'skill.md'].map((name) => path.join(dir, name)).find((candidate) => fs.existsSync(candidate));
    const name = file ? parseFrontmatter(fs.readFileSync(file, 'utf8')).fields.get('name') : undefined;
    return skillSlug(name || path.basename(rel === '.' ? root : dir));
  });
}

const PLACEHOLDER = /\$\{([A-Za-z_][A-Za-z0-9_]*)(?::-([^}]*))?\}/g;
const ROOT_VARS = new Set(['CLAUDE_PLUGIN_ROOT', 'MAITRE_PLUGIN_ROOT', 'CLAUDE_PLUGIN_DATA']);

const specStrings = (spec: PluginServerSpec): string[] => [spec.command ?? '', spec.url ?? '', ...(spec.args ?? []), ...Object.values(spec.env ?? {}), ...Object.values(spec.headers ?? {})];

/** `${VAR}` placeholders a server needs, without the plugin-folder ones and those with a `:-default`. */
export function requiredVars(spec: PluginServerSpec): string[] {
  const names = specStrings(spec).flatMap((text) => [...text.matchAll(PLACEHOLDER)].filter((match) => match[2] === undefined).map((match) => match[1]));
  return [...new Set(names.filter((name) => !ROOT_VARS.has(name)))];
}

/** Fills placeholders: the plugin folder, then the given values (user-entered, then environment), then `:-default`. */
export function expandSpec(spec: PluginServerSpec, root: string, lookup: (name: string) => string | undefined): PluginServerSpec {
  const fill = (text: string): string => text.replace(PLACEHOLDER, (_match, name: string, fallback: string | undefined) => (ROOT_VARS.has(name) ? root : lookup(name) ?? fallback ?? ''));
  const map = (record: Record<string, string> | undefined): Record<string, string> | undefined => (record ? Object.fromEntries(Object.entries(record).map(([key, value]) => [key, fill(String(value))])) : undefined);
  return {
    type: spec.type,
    command: spec.command === undefined ? undefined : fill(spec.command),
    args: spec.args?.map((arg) => fill(String(arg))),
    env: map(spec.env),
    url: spec.url === undefined ? undefined : fill(spec.url),
    headers: map(spec.headers),
  };
}

export const serverTarget = (spec: PluginServerSpec): string => spec.url ?? [spec.command, ...(spec.args ?? [])].filter(Boolean).join(' ');

export const transportOf = (spec: PluginServerSpec): 'http' | 'sse' | 'stdio' => (spec.url ? (spec.type === 'sse' ? 'sse' : 'http') : 'stdio');
