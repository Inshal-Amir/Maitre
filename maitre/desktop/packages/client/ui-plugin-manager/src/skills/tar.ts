/**
 * A gzip tar reader for repository archives. It writes regular files and
 * folders only, below one destination, and never materializes links: a
 * symbolic or hard link is recorded with its target resolved inside the
 * archive, or as escaping when it points anywhere else. No entry can reach
 * outside the destination, and the extracted size and entry count are capped.
 */

import { mkdir, writeFile } from 'node:fs/promises'
import { join, posix } from 'node:path'
import { Writable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import { createGunzip } from 'node:zlib'

const BLOCK = 512

/** Bounds on what one archive may write. */
export interface TarLimits {
  /** Total bytes of file content. */
  readonly maxBytes: number
  /** Files, folders, and links. */
  readonly maxEntries: number
}

/** What an extraction left behind beside the files. */
export interface TarResult {
  /** The commit `git archive` recorded in the global header, when present. */
  readonly commit?: string
  /** Link path to its target, both relative to the destination; null for a target outside the archive. */
  readonly links: ReadonlyMap<string, string | null>
}

/** An archive refused while it was read. */
export class TarError extends Error {}

interface Header {
  name: string
  linkname: string
  size: number
  type: string
  mode: number
}

function text(block: Buffer, start: number, length: number): string {
  const end = block.indexOf(0, start)
  return block.toString('utf8', start, end < 0 || end > start + length ? start + length : end)
}

function octal(block: Buffer, start: number, length: number): number {
  if ((block[start] ?? 0) & 0x80) {
    let value = 0
    for (let index = start + 1; index < start + length; index++) value = value * 256 + (block[index] ?? 0)
    return value
  }
  const digits = text(block, start, length).trim()
  return digits === '' ? 0 : Number.parseInt(digits, 8)
}

function readHeader(block: Buffer): Header {
  const name = text(block, 0, 100)
  const prefix = block.toString('latin1', 257, 262) === 'ustar' ? text(block, 345, 155) : ''
  return {
    name: prefix === '' ? name : `${prefix}/${name}`,
    linkname: text(block, 157, 100),
    size: octal(block, 124, 12),
    type: String.fromCharCode(block[156] ?? 0),
    mode: octal(block, 100, 8),
  }
}

/** `length key=value\n` records of a pax header. */
function paxRecords(data: Buffer): Map<string, string> {
  const records = new Map<string, string>()
  let offset = 0
  while (offset < data.length) {
    const space = data.indexOf(0x20, offset)
    if (space < 0) break
    const length = Number.parseInt(data.toString('utf8', offset, space), 10)
    if (!Number.isFinite(length) || length <= 0) break
    const record = data.toString('utf8', space + 1, offset + length - 1)
    const equals = record.indexOf('=')
    if (equals > 0) records.set(record.slice(0, equals), record.slice(equals + 1))
    offset += length
  }
  return records
}

/**
 * The entry's path below the archive's single top folder, or undefined when it names the top folder itself, an
 * absolute path, or a path through `..`.
 */
function strippedPath(name: string): string | undefined {
  if (name.startsWith('/') || /^[A-Za-z]:/.test(name)) return undefined
  const segments = name.split('/').filter(segment => segment !== '' && segment !== '.')
  if (segments.length < 2 || segments.includes('..') || segments.some(segment => segment.includes('\\'))) return undefined
  return segments.slice(1).join('/')
}

/** A link target relative to the destination, or null when it leaves it. */
function linkTarget(path: string, linkname: string, hard: boolean): string | null {
  if (hard) return strippedPath(linkname) ?? null
  if (linkname.startsWith('/') || linkname.includes('\\')) return null
  const target = posix.normalize(posix.join(posix.dirname(path), linkname))
  return target === '..' || target.startsWith('../') || target === '.' ? null : target
}

class TarSink extends Writable {
  private pending: Buffer = Buffer.alloc(0)
  private header: Header | undefined
  private remaining = 0
  private padding = 0
  private chunks: Buffer[] = []
  private pax = new Map<string, string>()
  private longName: string | undefined
  private longLink: string | undefined
  private written = 0
  private entries = 0
  private ended = false
  commit: string | undefined
  readonly links = new Map<string, string | null>()

  constructor(private readonly dest: string, private readonly limits: TarLimits) {
    super()
  }

  override _write(chunk: Buffer, _encoding: BufferEncoding, done: (error?: Error | null) => void): void {
    this.pending = this.pending.length === 0 ? chunk : Buffer.concat([this.pending, chunk])
    this.drain().then(() => { done() }, (error: unknown) => { done(error instanceof Error ? error : new TarError(String(error))) })
  }

  private async drain(): Promise<void> {
    while (!this.ended) {
      if (this.header !== undefined) {
        if (this.remaining > 0) {
          if (this.pending.length === 0) return
          const take = Math.min(this.remaining, this.pending.length)
          this.chunks.push(this.pending.subarray(0, take))
          this.pending = this.pending.subarray(take)
          this.remaining -= take
          if (this.remaining > 0) return
        }
        if (this.pending.length < this.padding) return
        this.pending = this.pending.subarray(this.padding)
        const header = this.header
        const data = Buffer.concat(this.chunks)
        this.header = undefined
        this.chunks = []
        await this.entry(header, data)
        continue
      }
      if (this.pending.length < BLOCK) return
      const block = this.pending.subarray(0, BLOCK)
      this.pending = this.pending.subarray(BLOCK)
      if (block.every(byte => byte === 0)) {
        this.ended = true
        return
      }
      const header = readHeader(block)
      if (!Number.isSafeInteger(header.size) || header.size < 0) throw new TarError('The archive has an unreadable entry.')
      const stored = header.type === '5' || header.type === '2' || header.type === '1' ? 0 : header.size
      if (header.type === '0' || header.type === '\0' || header.type === '7') {
        this.written += stored
        if (this.written > this.limits.maxBytes) throw new TarError('The repository is too large to read.')
      }
      this.header = header
      this.remaining = stored
      this.padding = (BLOCK - (stored % BLOCK)) % BLOCK
    }
  }

  private async entry(header: Header, data: Buffer): Promise<void> {
    switch (header.type) {
      case 'g': {
        const comment = paxRecords(data).get('comment')
        if (comment !== undefined && /^[0-9a-f]{40}$/.test(comment)) this.commit = comment
        return
      }
      case 'x':
        this.pax = paxRecords(data)
        return
      case 'L':
        this.longName = data.toString('utf8').replace(/\0+$/, '')
        return
      case 'K':
        this.longLink = data.toString('utf8').replace(/\0+$/, '')
        return
    }
    const name = this.pax.get('path') ?? this.longName ?? header.name
    const linkname = this.pax.get('linkpath') ?? this.longLink ?? header.linkname
    this.pax = new Map()
    this.longName = undefined
    this.longLink = undefined
    const path = strippedPath(name)
    if (path === undefined) return
    this.entries += 1
    if (this.entries > this.limits.maxEntries) throw new TarError('The repository has too many files to read.')
    const target = join(this.dest, ...path.split('/'))
    switch (header.type) {
      case '5':
        await mkdir(target, { recursive: true })
        return
      case '0':
      case '\0':
      case '7':
        await mkdir(join(target, '..'), { recursive: true })
        await writeFile(target, data, { mode: header.mode & 0o111 ? 0o755 : 0o644, flag: 'wx' })
        return
      case '1':
      case '2':
        this.links.set(path, linkTarget(path, linkname, header.type === '1'))
    }
  }
}

/**
 * Extract a gzip tar stream below `dest`, dropping the archive's top folder.
 * @param source - the compressed archive bytes.
 * @param dest - an empty folder the files land in.
 * @param limits - bounds on extracted bytes and entries.
 * @param signal - stops reading.
 * @returns the recorded links and the archive's commit.
 * @throws TarError when the archive exceeds a limit or is malformed; stream errors propagate.
 */
export async function extractTarGz(
  source: NodeJS.ReadableStream, dest: string, limits: TarLimits, signal?: AbortSignal,
): Promise<TarResult> {
  const sink = new TarSink(dest, limits)
  if (signal === undefined) await pipeline(source, createGunzip(), sink)
  else await pipeline(source, createGunzip(), sink, { signal })
  return { links: sink.links, ...sink.commit === undefined ? {} : { commit: sink.commit } }
}
