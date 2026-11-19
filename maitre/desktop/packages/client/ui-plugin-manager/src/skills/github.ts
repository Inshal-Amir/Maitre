/**
 * GitHub addresses and downloads for skill imports: a repository archive is
 * fetched from codeload without git, capped in size, and unpacked by the
 * link-free tar reader.
 */

import { Readable } from 'node:stream'
import type { ReadableStream as WebReadableStream } from 'node:stream/web'
import { extractTarGz, type TarLimits, type TarResult } from './tar.ts'
import type { SkillRepository } from './types.ts'

/** A repository, optionally at a ref and a folder inside it. */
export interface GitHubAddress {
  readonly owner: string
  readonly repo: string
  readonly ref?: string
  readonly path?: string
}

const SEGMENT = /^[A-Za-z0-9_.-]+$/
const USER_AGENT = 'dsh-skill-import'

/**
 * Read a GitHub address: `owner/repo[#ref]`, `github:owner/repo[#ref]`, `git@github.com:owner/repo.git`, or a
 * `github.com` URL, optionally `git+https`, ending `.git`, or naming `/tree/<ref>/<path>` or `/blob/<ref>/<path>`.
 * A ref containing `/` in a tree link is read as its first segment.
 * @param input - the typed spec.
 * @returns the address, or undefined when the spec does not name a GitHub repository.
 */
export function parseGitHub(input: string): GitHubAddress | undefined {
  const typed = input.trim().replace(/\/+$/, '')
  const short = /^(?:github:)?([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+?)(?:\.git)?(?:#(.+))?$/.exec(typed)
  if (short !== null && !typed.startsWith('.') && !typed.startsWith('@')) {
    const [, owner = '', repo = '', ref] = short
    return { owner, repo, ...ref === undefined ? {} : { ref } }
  }
  const ssh = /^(?:ssh:\/\/)?git@github\.com[:/]([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+?)(?:\.git)?(?:#(.+))?$/.exec(typed)
  if (ssh !== null) {
    const [, owner = '', repo = '', ref] = ssh
    return { owner, repo, ...ref === undefined ? {} : { ref } }
  }
  let url: URL
  try {
    url = new URL(/^[a-z+]+:\/\//i.test(typed) ? typed.replace(/^git\+/, '') : `https://${typed}`)
  } catch (_notUrl) {
    // Text that is no URL names no repository.
    return undefined
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:' && url.protocol !== 'git:') return undefined
  if (url.hostname !== 'github.com' && url.hostname !== 'www.github.com') return undefined
  const [owner, rawRepo, kind, ref, ...rest] = url.pathname.split('/').filter(segment => segment !== '').map(decodeURIComponent)
  const repo = rawRepo?.replace(/\.git$/, '')
  if (owner === undefined || repo === undefined || !SEGMENT.test(owner) || !SEGMENT.test(repo)) return undefined
  if ((kind === 'tree' || kind === 'blob') && ref !== undefined) {
    const path = (kind === 'blob' && /(^|\/)SKILL\.md$/i.test(rest.join('/')) ? rest.slice(0, -1) : rest).join('/')
    return { owner, repo, ref, ...path === '' ? {} : { path } }
  }
  if (kind !== undefined) return undefined
  const hash = url.hash.slice(1)
  return { owner, repo, ...hash === '' ? {} : { ref: decodeURIComponent(hash) } }
}

/** `owner/repo` with the folder a link named. */
export function repositoryUrl(address: GitHubAddress): string {
  const base = `https://github.com/${address.owner}/${address.repo}`
  if (address.path === undefined) return address.ref === undefined ? base : `${base}/tree/${address.ref}`
  return `${base}/tree/${address.ref ?? 'HEAD'}/${address.path}`
}

/**
 * A link to one folder of a downloaded repository, at the commit it was downloaded from when known.
 * @param source - the repository as inspected.
 * @param path - the folder inside it.
 * @returns the folder's GitHub URL.
 */
export function folderUrl(source: SkillRepository, path: string): string {
  return `https://github.com/${source.repo}/tree/${source.commit ?? source.ref ?? 'HEAD'}/${path}`
}

const refPath = (ref: string | undefined): string => (ref ?? 'HEAD').split('/').map(encodeURIComponent).join('/')

/** A failed download, phrased for the person who typed the address. */
export class DownloadError extends Error {}

/**
 * Read the repository's root `package.json`, when it has one.
 * @param address - the repository and ref.
 * @param signal - stops the request.
 * @returns the parsed manifest, or undefined when the repository has none or it is unreadable.
 */
export async function rootManifest(address: GitHubAddress, signal: AbortSignal): Promise<object | undefined> {
  const url = `https://raw.githubusercontent.com/${address.owner}/${address.repo}/${refPath(address.ref)}/package.json`
  try {
    const response = await fetch(url, { headers: { 'user-agent': USER_AGENT }, redirect: 'follow', signal })
    if (!response.ok) {
      await response.body?.cancel()
      return undefined
    }
    const parsed: unknown = JSON.parse(await response.text())
    return typeof parsed === 'object' && parsed !== null ? parsed : undefined
  } catch (error) {
    if (signal.aborted) throw error
    // An unreadable manifest only means the repository is not inspected as a package here.
    return undefined
  }
}

/** Bounds on one download. */
export interface DownloadLimits extends TarLimits {
  /** Compressed archive bytes. */
  readonly maxArchiveBytes: number
}

/**
 * Download a repository archive and unpack it below `dest`.
 * @param address - the repository and ref; the folder is applied by the caller.
 * @param dest - an empty folder.
 * @param limits - archive and extraction bounds.
 * @param signal - stops the download.
 * @returns the archive's links and commit.
 * @throws DownloadError for a missing repository, an HTTP failure, or an archive over a limit.
 */
export async function downloadRepository(
  address: GitHubAddress, dest: string, limits: DownloadLimits, signal: AbortSignal,
): Promise<TarResult> {
  const url = `https://codeload.github.com/${address.owner}/${address.repo}/tar.gz/${refPath(address.ref)}`
  const response = await fetch(url, { headers: { 'user-agent': USER_AGENT }, redirect: 'follow', signal })
  if (response.status === 404) {
    await response.body?.cancel()
    throw new DownloadError('GitHub has no public repository or branch at that address.')
  }
  if (!response.ok || response.body === null) {
    await response.body?.cancel()
    throw new DownloadError(`GitHub answered HTTP ${String(response.status)}.`)
  }
  const declared = Number(response.headers.get('content-length') ?? 0)
  const tooLarge = `The repository is larger than ${String(Math.round(limits.maxArchiveBytes / 1024 / 1024))} MB.`
  if (declared > limits.maxArchiveBytes) {
    await response.body.cancel()
    throw new DownloadError(tooLarge)
  }
  let received = 0
  const counted = Readable.fromWeb(response.body as WebReadableStream<Uint8Array>).map((chunk: Uint8Array) => {
    received += chunk.length
    if (received > limits.maxArchiveBytes) throw new DownloadError(tooLarge)
    return chunk
  })
  return await extractTarGz(counted, dest, limits, signal)
}
