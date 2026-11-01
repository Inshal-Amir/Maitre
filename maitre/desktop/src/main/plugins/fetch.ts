import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { childEnv } from '../tools/shell';
import { readSecret } from '../settings';
import { maitreHome } from '../home';

const run = promisify(execFile);
const MAX_ARCHIVE_BYTES = 250 * 1024 * 1024;
const DOWNLOAD_TIMEOUT_MS = 180_000;

export interface GitHubRef {
  owner: string;
  repo: string;
  ref?: string;
  /** Folder inside the repository. */
  path?: string;
}

const NAME = /^[A-Za-z0-9_.-]+$/;

/** `owner/repo`, `owner/repo#ref`, `https://github.com/owner/repo[.git][/tree/ref/path]` or `git@github.com:owner/repo.git`. */
export function parseGitHub(input: string): GitHubRef | null {
  const text = input.trim().replace(/\/+$/, '');
  const short = /^([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+?)(?:\.git)?(?:#(.+))?$/.exec(text);
  if (short && !text.includes(':') && !text.startsWith('.')) return { owner: short[1], repo: short[2], ref: short[3] };
  const ssh = /^git@github\.com:([^/]+)\/(.+?)(?:\.git)?$/.exec(text);
  if (ssh) return { owner: ssh[1], repo: ssh[2] };
  let url: URL;
  try {
    url = new URL(/^https?:\/\//.test(text) ? text : `https://${text}`);
  } catch {
    return null;
  }
  if (url.hostname !== 'github.com' && url.hostname !== 'www.github.com') return null;
  const [owner, rawRepo, kind, ref, ...rest] = url.pathname.split('/').filter(Boolean);
  const repo = rawRepo?.replace(/\.git$/, '');
  if (!owner || !repo || !NAME.test(owner) || !NAME.test(repo)) return null;
  if ((kind === 'tree' || kind === 'blob') && ref) return { owner, repo, ref, path: rest.join('/') || undefined };
  return { owner, repo, ref: url.hash ? url.hash.slice(1) : undefined };
}

export const githubLabel = (ref: GitHubRef): string => `${ref.owner}/${ref.repo}${ref.path ? `/${ref.path}` : ''}`;

/** A fresh folder under ~/.maitre/cache, removed by the caller. */
export function tempDir(label: string): string {
  const dir = path.join(maitreHome(), 'cache', `${label}-${crypto.randomBytes(5).toString('hex')}`);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

export function removeQuietly(dir: string): void {
  fs.rmSync(dir, { recursive: true, force: true });
}

async function downloadTo(url: string, file: string, headers: Record<string, string>): Promise<void> {
  const response = await fetch(url, { headers: { 'user-agent': 'maitre-desktop', ...headers }, redirect: 'follow', signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS) });
  if (response.status === 404) throw new Error('Not found on GitHub. Check the address (owner/repo) and that the repository is public, or add a GitHub token in Settings for private ones.');
  if (!response.ok || !response.body) throw new Error(`GitHub download failed (HTTP ${response.status}).`);
  const declared = Number(response.headers.get('content-length') ?? 0);
  if (declared > MAX_ARCHIVE_BYTES) throw new Error('That repository is too large to install (over 250 MB).');
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of response.body) {
    size += chunk.length;
    if (size > MAX_ARCHIVE_BYTES) throw new Error('That repository is too large to install (over 250 MB).');
    chunks.push(Buffer.from(chunk));
  }
  fs.writeFileSync(file, Buffer.concat(chunks));
}

/** Downloads a GitHub repository (tarball, no git needed) into `dest` and returns the folder the ref points to. */
export async function downloadGitHub(ref: GitHubRef, dest: string): Promise<string> {
  const token = readSecret('github-token');
  const at = encodeURIComponent(ref.ref ?? 'HEAD');
  const url = token
    ? `https://api.github.com/repos/${ref.owner}/${ref.repo}/tarball/${at}`
    : `https://codeload.github.com/${ref.owner}/${ref.repo}/tar.gz/${at}`;
  const archive = path.join(dest, '..', `${path.basename(dest)}.tar.gz`);
  fs.mkdirSync(dest, { recursive: true });
  try {
    await downloadTo(url, archive, token ? { authorization: `Bearer ${token}`, accept: 'application/vnd.github+json' } : {});
    await run('tar', ['-xzf', archive, '-C', dest, '--strip-components=1'], { env: childEnv(), timeout: DOWNLOAD_TIMEOUT_MS, windowsHide: true });
  } finally {
    fs.rmSync(archive, { force: true });
  }
  return within(dest, ref.path);
}

/** Any other git URL: a shallow clone (needs git). */
export async function cloneGit(url: string, ref: string | undefined, dest: string, sub?: string): Promise<string> {
  if (!/^(https?:\/\/|git@)/.test(url)) throw new Error(`Unsupported plugin source: ${url}`);
  const github = parseGitHub(url);
  if (github) return downloadGitHub({ ...github, ref: ref ?? github.ref, path: sub ?? github.path }, dest);
  const isSha = ref && /^[0-9a-f]{40}$/i.test(ref);
  const args = ['clone', '--quiet', ...(isSha ? [] : ['--depth', '1']), ...(ref && !isSha ? ['--branch', ref] : []), url, dest];
  try {
    await run('git', args, { env: childEnv(), timeout: DOWNLOAD_TIMEOUT_MS, windowsHide: true });
    if (isSha) await run('git', ['-C', dest, 'checkout', '--quiet', ref], { env: childEnv(), timeout: 60_000, windowsHide: true });
  } catch (error) {
    throw new Error(`Could not clone ${url}: ${(error as Error).message.split('\n')[0]}. Is git installed?`);
  }
  return within(dest, sub);
}

/** `root/sub`, refusing paths that leave `root`. */
export function within(root: string, sub?: string): string {
  if (!sub || sub === '.' || sub === './') return root;
  const target = path.resolve(root, sub);
  const relative = path.relative(root, target);
  if (relative.startsWith('..') || path.isAbsolute(relative)) throw new Error(`The path "${sub}" points outside the repository.`);
  if (!fs.existsSync(target)) throw new Error(`The folder "${sub}" does not exist in the repository.`);
  return target;
}
