/**
 * Wire shapes of the `skillImport` Remote namespace, shared by the Host
 * service and the Plugins page. Plain data only: they cross the Gateway as JSON.
 */

/** Where a set of skills was read from. */
export interface SkillRepository {
  /** `owner/repo`. */
  readonly repo: string
  /** The branch, tag, or commit the link named; absent for the default branch. */
  readonly ref?: string
  /** The folder inside the repository a `/tree/<ref>/<path>` link named. */
  readonly path?: string
  /** The commit the downloaded archive was made from, when the archive says. */
  readonly commit?: string
  /** A link back to the repository folder. */
  readonly url: string
}

/** One skill folder found in a downloaded repository. */
export interface SkillCandidate {
  /** The folder's path inside the repository, `.` for the root; the id an install names. */
  readonly id: string
  /** The frontmatter `name`, or the folder name when the frontmatter is unreadable. */
  readonly name: string
  readonly description: string
  /** Why discovery would skip this skill; such a skill cannot be installed. */
  readonly problem?: string
  /** A skill of this name is already in the skills folder. */
  readonly exists: boolean
}

/** What a typed plugin spec turned out to be. */
export type SkillInspection =
  /** Not a GitHub address: the plugin installer handles it. */
  | { readonly kind: 'not-github' }
  /** The repository declares a dsh bundle: the plugin installer handles it. */
  | { readonly kind: 'bundle' }
  /** Neither skills nor a bundle were found. */
  | { readonly kind: 'none'; readonly source: SkillRepository }
  /** The repository could not be read. */
  | { readonly kind: 'failed'; readonly message: string }
  /** Skills were found; `token` names the staged download an install copies from. */
  | { readonly kind: 'skills'; readonly token: string; readonly source: SkillRepository; readonly skills: SkillCandidate[] }

/** Why a chosen skill was not installed. */
export interface SkippedSkill {
  readonly name: string
  readonly reason: 'exists' | 'invalid' | 'unknown'
  readonly detail?: string
}

/** The outcome of copying the chosen skills. */
export type SkillInstallResult =
  | { readonly ok: true; readonly installed: string[]; readonly skipped: SkippedSkill[]; readonly warnings: string[] }
  | { readonly ok: false; readonly message: string }

/** A skill installed from GitHub, as the Plugins page lists it. */
export interface InstalledSkill {
  readonly name: string
  readonly description: string
  readonly source: SkillRepository
  /** ISO 8601 time of the install. */
  readonly installedAt: string
  /** The folder still holds a `SKILL.md`. */
  readonly present: boolean
}
