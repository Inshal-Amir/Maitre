/**
 * Copying skill folders out of an unpacked repository into the user skills
 * root, and the sources ledger that remembers where each came from.
 *
 * A folder lands at `<skills>/<name>/`, one level deep as discovery requires,
 * through a staged copy renamed into place. Links recorded by the tar reader
 * are copied as the file or folder they point to inside the repository; a
 * link leaving the repository is left out and reported.
 */

import { copyFile, mkdir, readdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { SkillRepository } from './types.ts'

/** The ledger file beside the skills; discovery reads only folders and `.md` files, so it is never a skill. */
export const SOURCES_FILE = '.maitre-sources.json'

/** One ledger row. */
export interface SourceRecord {
  readonly source: SkillRepository
  readonly installedAt: string
}

type Ledger = Record<string, SourceRecord>

const MAX_LINK_DEPTH = 3

/**
 * Read the sources ledger.
 * @param skillsRoot - the user skills root.
 * @returns rows by skill name; empty when the file is absent or unreadable.
 */
export async function readSources(skillsRoot: string): Promise<Ledger> {
  try {
    const parsed: unknown = JSON.parse(await readFile(join(skillsRoot, SOURCES_FILE), 'utf8'))
    if (typeof parsed !== 'object' || parsed === null) return {}
    const skills = (parsed as { skills?: unknown }).skills
    return typeof skills === 'object' && skills !== null ? skills as Ledger : {}
  } catch (_absent) {
    // No ledger yet means nothing was installed from GitHub.
    return {}
  }
}

/**
 * Replace the sources ledger through a renamed temporary file.
 * @param skillsRoot - the user skills root.
 * @param ledger - every row to keep.
 */
export async function writeSources(skillsRoot: string, ledger: Ledger): Promise<void> {
  await mkdir(skillsRoot, { recursive: true })
  const file = join(skillsRoot, SOURCES_FILE)
  const temporary = `${file}.${String(process.pid)}.tmp`
  await writeFile(temporary, `${JSON.stringify({ version: 1, skills: ledger }, null, 2)}\n`)
  await rename(temporary, file)
}

/** What a copy needs to know about the unpacked repository. */
export interface RepositoryTree {
  /** The unpacked repository folder. */
  readonly root: string
  /** Link path to its in-repository target, or null for a target outside it. */
  readonly links: ReadonlyMap<string, string | null>
}

const nativePath = (root: string, path: string): string => path === '.' ? root : join(root, ...path.split('/'))
const childPath = (dir: string, name: string): string => dir === '.' ? name : `${dir}/${name}`

/** The links recorded directly inside `dir`. */
function linksIn(tree: RepositoryTree, dir: string): [string, string | null][] {
  const prefix = dir === '.' ? '' : `${dir}/`
  return [...tree.links].filter(([path]) => path.startsWith(prefix) && !path.slice(prefix.length).includes('/'))
}

async function kindOf(tree: RepositoryTree, path: string): Promise<'file' | 'dir' | undefined> {
  const parent = path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : '.'
  const name = path.slice(path.lastIndexOf('/') + 1)
  try {
    const entry = (await readdir(nativePath(tree.root, parent), { withFileTypes: true })).find(item => item.name === name)
    return entry?.isFile() === true ? 'file' : entry?.isDirectory() === true ? 'dir' : undefined
  } catch (_absent) {
    // A link into a folder that does not exist points at nothing.
    return undefined
  }
}

/**
 * Copy one repository folder, links resolved inside the repository.
 * @param tree - the unpacked repository.
 * @param dir - posix folder path inside it.
 * @param dest - the destination folder, created here.
 * @param warnings - collects links left out.
 * @param depth - link hops taken so far.
 */
export async function copyFolder(tree: RepositoryTree, dir: string, dest: string, warnings: string[], depth = 0): Promise<void> {
  await mkdir(dest, { recursive: true })
  const listed = await readdir(nativePath(tree.root, dir), { withFileTypes: true })
  for (const entry of listed) {
    const target = join(dest, entry.name)
    if (entry.isDirectory()) await copyFolder(tree, childPath(dir, entry.name), target, warnings, depth)
    else if (entry.isFile()) await copyFile(nativePath(tree.root, childPath(dir, entry.name)), target)
  }
  for (const [path, resolved] of linksIn(tree, dir)) {
    const name = path.slice(path.lastIndexOf('/') + 1)
    const kind = resolved === null ? undefined : await kindOf(tree, resolved)
    if (resolved === null || kind === undefined || depth >= MAX_LINK_DEPTH) {
      warnings.push(`${path}: a link to something outside the repository was left out`)
      continue
    }
    if (kind === 'file') await copyFile(nativePath(tree.root, resolved), join(dest, name))
    else if (resolved === '.' || path.startsWith(`${resolved}/`)) warnings.push(`${path}: a link to a folder containing it was left out`)
    else await copyFolder(tree, resolved, join(dest, name), warnings, depth + 1)
  }
}

/**
 * Move a staged folder to `dest`, replacing what is there.
 * @param staged - the finished copy.
 * @param dest - the skill's folder in the skills root.
 * @param trash - a free path on the same volume the old folder moves to before it is deleted.
 */
export async function moveIntoPlace(staged: string, dest: string, trash: string): Promise<void> {
  let replaced = false
  try {
    await rename(dest, trash)
    replaced = true
  } catch (error) {
    if ((error as { code?: unknown }).code !== 'ENOENT') throw error
  }
  try {
    await rename(staged, dest)
  } catch (error) {
    if (replaced) await rename(trash, dest)
    throw error
  }
  if (replaced) await rm(trash, { recursive: true, force: true })
}
