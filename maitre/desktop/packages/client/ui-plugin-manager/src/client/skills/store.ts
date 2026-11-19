/**
 * The Plugins page's skill import: the review of a GitHub repository's skills
 * the Add plugin dialog found, the copy the person confirms, and the list of
 * skills installed from GitHub, all through the `skillImport` Remote.
 */
import type { Context as ClientContext } from '@deepseek-ai/cordis'
import { createSnapshotStore, type SnapshotStore } from '@deepseek-ai/dsh-client-store'
import type { InstalledSkill, SkillCandidate, SkillInstallResult, SkillRepository } from '../../skills/types.ts'

/** A repository's skills waiting for the person's choice, and what the copy did. */
export interface SkillReview {
  readonly token: string
  readonly source: SkillRepository
  readonly skills: readonly SkillCandidate[]
  readonly phase: 'review' | 'installing' | 'done'
  readonly result?: SkillInstallResult
}

/** The skill import's snapshot. */
export interface SkillImportState {
  readonly review: SkillReview | null
  readonly installed: { readonly status: 'idle' | 'loading' | 'ready' | 'failed'; readonly skills: readonly InstalledSkill[] }
  /** The skill a removal is deleting. */
  readonly removing: string | null
}

/** What the Add plugin dialog should do with a typed spec after the skill check. */
export type SkillRoute =
  | { readonly kind: 'review' }
  | { readonly kind: 'plugin' }
  | { readonly kind: 'refused'; readonly reason: string }

/** The skill import's actions, injected into the Plugins page. */
export interface SkillImportFace {
  /** Leave the review, dropping the staged download. */
  closeSkillReview: () => void
  /** Copy the chosen skills; existing names in `replace` are replaced, the others skipped. */
  installSkills: (ids: readonly string[], replace: readonly string[]) => void
  /** Read the skills installed from GitHub unless they were read. */
  ensureSkills: () => void
  /** Delete a skill installed from GitHub. */
  removeSkill: (name: string) => void
}

/**
 * Whether a typed spec may name a GitHub repository, so the skill check is worth a Host round trip; the Host parses
 * it exactly. Registry names, paths, and other hosts go straight to the plugin installer.
 * @param spec - the trimmed spec.
 * @returns true for GitHub URLs, `github:` and `git@github.com:` forms, and `owner/repo` shorthands.
 */
export function mayNameGitHub(spec: string): boolean {
  return /github\.com[/:]|^github:/i.test(spec) || /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+(#.*)?$/.test(spec)
}

const IDLE: SkillImportState = { review: null, installed: { status: 'idle', skills: [] }, removing: null }

/** Owns the skill import's snapshot and its calls to the Host. */
export class SkillImportController {
  readonly store: SnapshotStore<SkillImportState> = createSnapshotStore<SkillImportState>(IDLE)
  private disposed = false

  /** @param ctx - the page plugin's context, whose `remote.skillImport` namespace answers. */
  constructor(private readonly ctx: ClientContext) {}

  /**
   * Ask the Host whether a typed spec is a GitHub skills repository; a found one opens the review.
   * @param spec - the typed spec.
   * @param signal - the dialog's check, aborted when it closes.
   * @returns whether the review opened, the plugin installer should continue, or the spec is refused.
   */
  async route(spec: string, signal: AbortSignal): Promise<SkillRoute> {
    let answer
    try {
      answer = await this.ctx.remote.skillImport.inspect(spec, signal)
    } catch (_unavailable) {
      // Without the skill import the plugin installer reads every spec, as before it existed.
      return { kind: 'plugin' }
    }
    if (!answer.ok || this.disposed || signal.aborted) return { kind: 'plugin' }
    const inspection = answer.value
    const linked = /\/(tree|blob)\//.test(spec)
    switch (inspection.kind) {
      case 'skills':
        this.patch({ review: { token: inspection.token, source: inspection.source, skills: inspection.skills, phase: 'review' } })
        return { kind: 'review' }
      case 'failed':
        return linked ? { kind: 'refused', reason: inspection.message } : { kind: 'plugin' }
      case 'none':
        return linked ? { kind: 'refused', reason: 'that folder holds no skills' } : { kind: 'plugin' }
      default:
        return { kind: 'plugin' }
    }
  }

  /** @returns the actions the page calls. */
  face(): SkillImportFace {
    return {
      closeSkillReview: () => {
        const review = this.store.getSnapshot().review
        if (review === null || review.phase === 'installing') return
        this.patch({ review: null })
        if (review.phase === 'review') void this.ctx.remote.skillImport.discard(review.token)
      },
      installSkills: (ids, replace) => { void this.install(ids, replace) },
      ensureSkills: () => { if (this.store.getSnapshot().installed.status === 'idle') void this.load() },
      removeSkill: (name) => { void this.remove(name) },
    }
  }

  private patch(next: Partial<SkillImportState>): void {
    if (this.disposed) return
    this.store.set({ ...this.store.getSnapshot(), ...next })
  }

  /** Stop publishing late answers. */
  dispose(): void {
    this.disposed = true
  }

  /** Read the skills installed from GitHub. */
  async load(): Promise<void> {
    this.patch({ installed: { ...this.store.getSnapshot().installed, status: 'loading' } })
    const answer = await this.ctx.remote.skillImport.list()
    this.patch({
      installed: answer.ok ? { status: 'ready', skills: answer.value } : { status: 'failed', skills: this.store.getSnapshot().installed.skills },
    })
  }

  private async install(ids: readonly string[], replace: readonly string[]): Promise<void> {
    const review = this.store.getSnapshot().review
    if (review === null || review.phase !== 'review') return
    this.patch({ review: { ...review, phase: 'installing' } })
    const answer = await this.ctx.remote.skillImport.add(review.token, [...ids], [...replace])
    const result: SkillInstallResult = answer.ok ? answer.value : { ok: false, message: answer.error.message }
    this.patch({ review: { ...review, phase: 'done', result } })
    await this.load()
  }

  private async remove(name: string): Promise<void> {
    if (this.store.getSnapshot().removing !== null) return
    this.patch({ removing: name })
    const answer = await this.ctx.remote.skillImport.uninstall(name)
    this.patch({ removing: null, ...answer.ok ? { installed: { status: 'ready', skills: answer.value } } : {} })
  }
}
