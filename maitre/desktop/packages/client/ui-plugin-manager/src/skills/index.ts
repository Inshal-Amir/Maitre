/**
 * Host owner of the `skillImport` Remote namespace: the Plugins dialog's path
 * for a GitHub repository of Claude-style skills.
 *
 * `inspect` reads a typed spec. A repository whose root `package.json`
 * declares a dsh bundle is left to the plugin installer. Otherwise the archive
 * is downloaded (no git, size-capped) into `$DSH_HOME/cache/skill-import`,
 * unpacked without links, and its skills are listed for review; the staged
 * copy waits for `add` or `discard` and expires on its own. `add`
 * copies each chosen folder to `$DSH_HOME/skills/<name>/` and records its
 * source in the skills root's ledger, which `list` and `uninstall` read.
 * Repository content is data: nothing from it is executed.
 */

import { randomBytes } from 'node:crypto'
import { existsSync } from 'node:fs'
import { mkdir, readFile, rename, rm } from 'node:fs/promises'
import { join } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import { resolveDshHome } from '@deepseek-ai/dsh-home-paths'
import { readSkillDocument } from '@deepseek-ai/dsh-skill-filesystem'
import { isSkillName } from '@deepseek-ai/dsh-skill'
import { Remote, TypertRemoteService } from '@deepseek-ai/dsh-typert-protocol'
import { readSkills, skillFolders, SKILL_FILES, type FoundSkill } from './discover.ts'
import { DownloadError, downloadRepository, folderUrl, parseGitHub, repositoryUrl, rootManifest, type GitHubAddress } from './github.ts'
import { copyFolder, moveIntoPlace, readSources, writeSources, type RepositoryTree } from './install.ts'
import { TarError } from './tar.ts'
import type { InstalledSkill, SkillInspection, SkillInstallResult, SkillRepository, SkippedSkill } from './types.ts'

export type * from './types.ts'

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** Host owner of the `skillImport` Remote namespace. */
    skillImport: SkillImport
  }
}

const LIMITS = { maxArchiveBytes: 250 * 1024 * 1024, maxBytes: 512 * 1024 * 1024, maxEntries: 50_000 }
const DOWNLOAD_TIMEOUT_MS = 180_000
const STAGE_TTL_MS = 15 * 60_000
const TOKEN = /^[0-9a-f]{24}$/

/** A downloaded repository waiting for the person's choice. */
interface Stage {
  readonly dir: string
  readonly tree: RepositoryTree
  readonly source: SkillRepository
  readonly skills: ReadonlyMap<string, FoundSkill>
  readonly timer: ReturnType<typeof setTimeout>
}

const messageOf = (error: unknown): string => error instanceof Error ? error.message : String(error)

function declaresBundle(manifest: { dsh?: unknown } | undefined): boolean {
  const dsh = manifest?.dsh
  return typeof dsh === 'object' && dsh !== null && (dsh as { bundle?: unknown }).bundle !== undefined
}

/** Imports skills from GitHub repositories into the user skills root. */
export class SkillImport extends TypertRemoteService {
  private readonly home: string
  private readonly skillsRoot: string
  private readonly cacheRoot: string
  private readonly stages = new Map<string, Stage>()
  private readonly lifetime = new AbortController()
  /** Serializes writes to the skills root and its ledger. */
  private writing: Promise<unknown> = Promise.resolve()
  /** Removes stages a previous process left behind; downloads wait for it. */
  private swept: Promise<void> = Promise.resolve()

  /** @param ctx - the Host context. */
  constructor(ctx: Context) {
    super(ctx, 'skillImport')
    this.home = resolveDshHome()
    this.skillsRoot = join(this.home, 'skills')
    this.cacheRoot = join(this.home, 'cache', 'skill-import')
    ctx.effect(() => {
      this.swept = rm(this.cacheRoot, { recursive: true, force: true }).catch(() => undefined)
      return async () => {
        this.lifetime.abort()
        for (const stage of this.stages.values()) clearTimeout(stage.timer)
        this.stages.clear()
        await rm(this.cacheRoot, { recursive: true, force: true })
      }
    })
  }

  /**
   * Read a typed plugin spec as a GitHub skills repository.
   * @param spec - what the person typed into the Add plugin dialog.
   * @param signal - stops the download.
   * @returns whether the spec is a skills repository, with its skills staged for review, or what else it is.
   */
  @Remote
  async inspect(spec: string, signal?: AbortSignal): Promise<SkillInspection> {
    const address = parseGitHub(spec)
    if (address === undefined) return { kind: 'not-github' }
    const abort = AbortSignal.any([this.lifetime.signal, AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS), ...signal === undefined ? [] : [signal]])
    if (address.path === undefined && declaresBundle(await rootManifest(address, abort))) return { kind: 'bundle' }
    await this.swept
    const token = randomBytes(12).toString('hex')
    const dir = join(this.cacheRoot, token)
    const root = join(dir, 'repo')
    try {
      await mkdir(root, { recursive: true })
      const archive = await downloadRepository(address, root, LIMITS, abort)
      const source = this.sourceOf(address, archive.commit)
      const base = address.path ?? '.'
      if (base !== '.' && !existsSync(join(root, ...base.split('/')))) {
        await rm(dir, { recursive: true, force: true })
        return { kind: 'failed', message: `The repository has no folder "${base}".` }
      }
      const found = await readSkills(root, await skillFolders(root, base), address.path?.split('/').at(-1) ?? address.repo)
      if (found.length === 0) {
        await rm(dir, { recursive: true, force: true })
        return { kind: 'none', source }
      }
      const timer = setTimeout(() => { void this.discard(token) }, STAGE_TTL_MS)
      timer.unref()
      const skills = new Map(found.map(skill => [skill.dir, skill]))
      this.stages.set(token, { dir, tree: { root, links: archive.links }, source, skills, timer })
      return {
        kind: 'skills', token, source,
        skills: [...found].sort((a, b) => a.name.localeCompare(b.name)).map(skill => ({
          id: skill.dir, name: skill.name, description: skill.description,
          ...skill.problem === undefined ? {} : { problem: skill.problem },
          exists: isSkillName(skill.name) && existsSync(join(this.skillsRoot, skill.name)),
        })),
      }
    } catch (error) {
      await rm(dir, { recursive: true, force: true })
      if (error instanceof DownloadError || error instanceof TarError) return { kind: 'failed', message: error.message }
      if (abort.aborted && signal?.aborted !== true && !this.lifetime.signal.aborted) return { kind: 'failed', message: 'GitHub took too long to send the repository.' }
      if (abort.aborted) throw error
      return { kind: 'failed', message: `The repository could not be read: ${messageOf(error)}` }
    }
  }

  /**
   * Copy chosen skills from a staged repository into the skills root, then drop the stage.
   * @param token - the stage `inspect` returned.
   * @param ids - repository folders of the skills to install.
   * @param replace - names of existing skills the person agreed to replace; other existing names are skipped.
   * @returns what was installed and skipped, or why nothing could be.
   */
  @Remote
  async add(token: string, ids: string[], replace: string[]): Promise<SkillInstallResult> {
    const stage = TOKEN.test(token) ? this.stages.get(token) : undefined
    if (stage === undefined) return { ok: false, message: 'This review expired. Add the repository again.' }
    const run = this.writing.then(() => this.copy(stage, token, ids, new Set(replace)))
    this.writing = run.catch(() => undefined)
    try {
      return await run
    } catch (error) {
      return { ok: false, message: `The skills could not be copied: ${messageOf(error)}` }
    } finally {
      await this.discard(token)
    }
  }

  /**
   * Drop a staged repository the person closed without installing.
   * @param token - the stage `inspect` returned.
   */
  @Remote
  async discard(token: string): Promise<void> {
    const stage = this.stages.get(token)
    if (stage === undefined) return
    this.stages.delete(token)
    clearTimeout(stage.timer)
    await rm(stage.dir, { recursive: true, force: true })
  }

  /**
   * List the skills installed from GitHub.
   * @returns the ledger's skills by name, with whether each folder is still there.
   */
  @Remote
  async list(): Promise<InstalledSkill[]> {
    const ledger = await readSources(this.skillsRoot)
    const rows = await Promise.all(Object.entries(ledger).map(async ([name, record]): Promise<InstalledSkill> => {
      let description = ''
      let present = false
      try {
        const document = readSkillDocument(await readFile(join(this.skillsRoot, name, 'SKILL.md'), 'utf8'))
        present = true
        if (document.ok) description = document.skill.description
      } catch (_absent) {
        // A folder removed by hand stays listed so its row can be cleared.
      }
      return { name, description, source: record.source, installedAt: record.installedAt, present }
    }))
    return rows.sort((a, b) => a.name.localeCompare(b.name))
  }

  /**
   * Delete a skill installed from GitHub and its ledger row.
   * @param name - the skill name.
   * @returns the remaining list.
   */
  @Remote
  async uninstall(name: string): Promise<InstalledSkill[]> {
    const run = this.writing.then(async () => {
      const ledger = await readSources(this.skillsRoot)
      if (!isSkillName(name) || ledger[name] === undefined) return
      await rm(join(this.skillsRoot, name), { recursive: true, force: true })
      const { [name]: _removed, ...rest } = ledger
      await writeSources(this.skillsRoot, rest)
    })
    this.writing = run.catch(() => undefined)
    await run
    return await this.list()
  }

  private sourceOf(address: GitHubAddress, commit: string | undefined): SkillRepository {
    return {
      repo: `${address.owner}/${address.repo}`, url: repositoryUrl(address),
      ...address.ref === undefined ? {} : { ref: address.ref },
      ...address.path === undefined ? {} : { path: address.path },
      ...commit === undefined ? {} : { commit },
    }
  }

  private async copy(stage: Stage, token: string, ids: readonly string[], replace: ReadonlySet<string>): Promise<SkillInstallResult> {
    const installed: string[] = []
    const skipped: SkippedSkill[] = []
    const warnings: string[] = []
    const out = join(this.cacheRoot, `${token}-out`)
    const installedAt = new Date().toISOString()
    await mkdir(this.skillsRoot, { recursive: true })
    await mkdir(out, { recursive: true })
    const ledger = { ...await readSources(this.skillsRoot) }
    try {
      for (const id of new Set(ids)) {
        const skill = stage.skills.get(id)
        if (skill === undefined) {
          skipped.push({ name: id, reason: 'unknown' })
          continue
        }
        if (skill.problem !== undefined || !isSkillName(skill.name)) {
          skipped.push({ name: skill.name, reason: 'invalid', ...skill.problem === undefined ? {} : { detail: skill.problem } })
          continue
        }
        const dest = join(this.skillsRoot, skill.name)
        if (existsSync(dest) && !replace.has(skill.name)) {
          skipped.push({ name: skill.name, reason: 'exists' })
          continue
        }
        const staged = join(out, skill.name)
        const found: string[] = []
        await copyFolder(stage.tree, skill.dir, staged, found)
        warnings.push(...found.map(warning => `${skill.name}: ${warning}`))
        await this.canonicalInstructions(staged, skill.file)
        await moveIntoPlace(staged, dest, join(out, `${skill.name}.old`))
        const source = skill.dir === '.' ? stage.source : { ...stage.source, path: skill.dir, url: folderUrl(stage.source, skill.dir) }
        ledger[skill.name] = { source, installedAt }
        installed.push(skill.name)
      }
      if (installed.length > 0) await writeSources(this.skillsRoot, ledger)
    } finally {
      await rm(out, { recursive: true, force: true })
    }
    return { ok: true, installed, skipped, warnings }
  }

  /** dsh reads `SKILL.md`; a folder using another accepted spelling is renamed to it. */
  private async canonicalInstructions(dir: string, file: string): Promise<void> {
    if (file === SKILL_FILES[0]) return
    await rename(join(dir, file), join(dir, SKILL_FILES[0]))
  }
}
