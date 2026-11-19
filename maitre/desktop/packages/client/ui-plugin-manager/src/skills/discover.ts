/**
 * Skill discovery in an unpacked repository, in the Claude plugin layout:
 * every plugin a `.claude-plugin/marketplace.json` lists, the `skills` paths of
 * a `plugin.json`, the `skills/` folder, and top-level folders holding a
 * `SKILL.md`, merged and deduplicated by skill name; a repository with none of
 * those that has a root `SKILL.md` is one skill. Only real files and folders
 * count: the tar reader materializes no links.
 */

import { readdir, readFile } from 'node:fs/promises'
import { join, posix } from 'node:path'
import { readSkillDocument } from '@deepseek-ai/dsh-skill-filesystem'

/** The instruction file names a skill folder may use; dsh reads `SKILL.md`, and an install renames the other. */
export const SKILL_FILES = ['SKILL.md', 'skill.md'] as const

/** One skill folder, read. */
export interface FoundSkill {
  /** Posix path inside the repository; `.` for the root. */
  readonly dir: string
  /** The instruction file's name inside the folder. */
  readonly file: string
  readonly name: string
  readonly description: string
  readonly problem?: string
}

type PathList = string | readonly string[] | undefined

interface PluginManifest {
  readonly skills?: PathList
}

interface MarketplaceEntry extends PluginManifest {
  readonly source?: unknown
}

interface Marketplace {
  readonly metadata?: { readonly pluginRoot?: unknown }
  readonly plugins?: unknown
}

const MARKETPLACE = '.claude-plugin/marketplace.json'
const PLUGIN_MANIFESTS = ['.claude-plugin/plugin.json', 'plugin.json']

const toList = (value: PathList): string[] =>
  (value === undefined ? [] : typeof value === 'string' ? [value] : [...value]).filter(entry => typeof entry === 'string')

/** A repository-relative posix path, or undefined when it leaves the repository. */
function inside(base: string, relative: string): string | undefined {
  if (relative.startsWith('/') || relative.includes('\\')) return undefined
  const joined = posix.normalize(posix.join(base, relative))
  if (joined === '..' || joined.startsWith('../')) return undefined
  return joined === '' ? '.' : joined.replace(/\/$/, '')
}

const child = (dir: string, name: string): string => dir === '.' ? name : `${dir}/${name}`

async function entries(root: string, dir: string): Promise<{ files: Set<string>; dirs: string[] }> {
  try {
    const listed = await readdir(join(root, ...dir.split('/')), { withFileTypes: true })
    return {
      files: new Set(listed.filter(entry => entry.isFile()).map(entry => entry.name)),
      dirs: listed.filter(entry => entry.isDirectory() && !entry.name.startsWith('.') && entry.name !== 'node_modules')
        .map(entry => child(dir, entry.name)),
    }
  } catch (_absent) {
    // A path a manifest names that is not a folder holds no skills.
    return { files: new Set(), dirs: [] }
  }
}

async function readJson<T>(root: string, file: string): Promise<T | undefined> {
  try {
    const parsed: unknown = JSON.parse((await readFile(join(root, ...file.split('/')), 'utf8')).replace(/^﻿/, ''))
    return typeof parsed === 'object' && parsed !== null ? parsed as T : undefined
  } catch (_unreadable) {
    // A missing or malformed manifest declares nothing.
    return undefined
  }
}

async function pluginManifest(root: string, plugin: string): Promise<PluginManifest | undefined> {
  const manifests = await Promise.all(PLUGIN_MANIFESTS.map(file => readJson<PluginManifest>(root, child(plugin, file))))
  return manifests.find(manifest => manifest !== undefined)
}

const skillFileIn = (files: ReadonlySet<string>): string | undefined => SKILL_FILES.find(name => files.has(name))

/** The skill folder at `dir`, or the skill folders directly inside it. */
async function skillDirsAt(root: string, dir: string): Promise<string[]> {
  const listed = await entries(root, dir)
  if (skillFileIn(listed.files) !== undefined) return [dir]
  const children = await Promise.all(listed.dirs.map(async dir => skillFileIn((await entries(root, dir)).files) === undefined ? [] : [dir]))
  return children.flat()
}

async function manifestSkills(root: string, plugin: string, declared: PathList): Promise<string[] | undefined> {
  const paths = toList(declared).map(path => inside(plugin, path)).filter(path => path !== undefined)
  if (paths.length === 0) return undefined
  return (await Promise.all(paths.map(path => skillDirsAt(root, path)))).flat()
}

/** A plugin folder's skills: its manifest's `skills` paths, else its `skills/` folder, else the folder itself. */
async function pluginSkills(root: string, plugin: string, entry?: MarketplaceEntry): Promise<string[]> {
  const declared = await manifestSkills(root, plugin, (await pluginManifest(root, plugin))?.skills ?? entry?.skills)
  if (declared !== undefined) return declared
  const nested = await skillDirsAt(root, child(plugin, 'skills'))
  if (nested.length > 0) return nested
  return skillFileIn((await entries(root, plugin)).files) === undefined ? [] : [plugin]
}

async function marketplaceSkills(root: string, base: string): Promise<string[]> {
  const marketplace = await readJson<Marketplace>(root, child(base, MARKETPLACE))
  const listed: unknown = marketplace?.plugins
  if (marketplace === undefined || !Array.isArray(listed)) return []
  const declaredRoot = marketplace.metadata?.pluginRoot
  const pluginRoot = typeof declaredRoot === 'string' ? inside(base, declaredRoot) ?? base : base
  const plugins = (listed as unknown[]).flatMap((value) => {
    if (typeof value !== 'object' || value === null) return []
    const entry = value as MarketplaceEntry
    if (typeof entry.source !== 'string') return []
    const dir = inside(entry.source.startsWith('./') || entry.source.startsWith('../') ? base : pluginRoot, entry.source)
    return dir === undefined ? [] : [{ dir, entry }]
  })
  return (await Promise.all(plugins.map(({ dir, entry }) => pluginSkills(root, dir, entry)))).flat()
}

/**
 * The skill folders at or below `base` in discovery order, each once.
 * @param root - the unpacked repository.
 * @param base - the folder a link named, or `.`.
 * @returns repository-relative posix folder paths.
 */
export async function skillFolders(root: string, base: string): Promise<string[]> {
  const top = await entries(root, base)
  if (skillFileIn(top.files) !== undefined) return [base]
  const found = [
    ...await marketplaceSkills(root, base),
    ...await manifestSkills(root, base, (await pluginManifest(root, base))?.skills) ?? [],
    ...await skillDirsAt(root, child(base, 'skills')),
    ...await skillDirsAt(root, base),
  ]
  return [...new Set(found)]
}

/**
 * Read each folder's instruction file the way dsh discovery will, keeping the first folder of each name.
 * @param root - the unpacked repository.
 * @param dirs - folders from {@link skillFolders}.
 * @param rootName - the name an unreadable root skill is listed under.
 * @returns one entry per skill name; unreadable skills are kept, named after their folder, with the problem.
 */
export async function readSkills(root: string, dirs: readonly string[], rootName: string): Promise<FoundSkill[]> {
  const read = await Promise.all(dirs.map(async (dir): Promise<FoundSkill | undefined> => {
    const file = skillFileIn((await entries(root, dir)).files)
    if (file === undefined) return undefined
    const folder = dir === '.' ? rootName : posix.basename(dir)
    let text: string
    try {
      text = await readFile(join(root, ...dir.split('/'), file), 'utf8')
    } catch (error) {
      return { dir, file, name: folder, description: '', problem: `unreadable ${file}: ${String(error)}` }
    }
    const document = readSkillDocument(text)
    if (!document.ok) return { dir, file, name: folder, description: '', problem: document.problem }
    return { dir, file, name: document.skill.name, description: document.skill.description }
  }))
  const byName = new Map<string, FoundSkill>()
  for (const skill of read) {
    if (skill !== undefined && !byName.has(skill.name)) byName.set(skill.name, skill)
  }
  return [...byName.values()]
}
