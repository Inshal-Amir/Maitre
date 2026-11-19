import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { readdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { gzipSync } from 'node:zlib'
import { Context } from '@deepseek-ai/cordis'
import { afterEach, beforeEach, expect, it, onTestFinished, vi } from 'vitest'
import { SkillImport } from '../src/index.ts'
import { parseGitHub } from '../src/skills/github.ts'

const COMMIT = '0123456789abcdef0123456789abcdef01234567'

interface Entry {
  readonly name: string
  readonly type?: '0' | '2' | '5' | 'g'
  readonly body?: string
  readonly linkname?: string
}

function header(entry: Entry, size: number): Buffer {
  const block = Buffer.alloc(512)
  block.write(entry.name, 0, 100, 'utf8')
  block.write('0000644\0', 100, 'latin1')
  block.write(`${size.toString(8).padStart(11, '0')}\0`, 124, 'latin1')
  block.write('00000000000\0', 136, 'latin1')
  block.write('        ', 148, 'latin1')
  block.write(entry.type ?? '0', 156, 'latin1')
  if (entry.linkname !== undefined) block.write(entry.linkname, 157, 100, 'utf8')
  block.write('ustar\u000000', 257, 'latin1')
  const sum = block.reduce((total, byte) => total + byte, 0)
  block.write(`${sum.toString(8).padStart(6, '0')}\0 `, 148, 'latin1')
  return block
}

function tarGz(entries: readonly Entry[]): Buffer {
  const parts = entries.flatMap((entry) => {
    const body = Buffer.from(entry.type === 'g' ? `${String(`comment=${COMMIT}\n`.length + 3)} comment=${COMMIT}\n` : entry.body ?? '')
    const padding = Buffer.alloc((512 - (body.length % 512)) % 512)
    return [header(entry, body.length), body, padding]
  })
  return gzipSync(Buffer.concat([...parts, Buffer.alloc(1024)]))
}

const skill = (name: string, description = `${name} does things`): string => `---\nname: ${name}\ndescription: ${description}\n---\n\nBody of ${name}.\n`

const REPO: Entry[] = [
  { name: 'pax_global_header', type: 'g' },
  { name: 'repo-main/', type: '5' },
  { name: 'repo-main/.claude-plugin/marketplace.json', body: JSON.stringify({ plugins: [{ name: 'pack', source: './pack' }, { name: 'far', source: { source: 'github', repo: 'x/y' } }] }) },
  { name: 'repo-main/pack/skills/alpha/SKILL.md', body: skill('alpha') },
  { name: 'repo-main/beta/SKILL.md', body: skill('beta') },
  { name: 'repo-main/beta/scripts/run.sh', body: 'echo never run\n' },
  { name: 'repo-main/beta/escape', type: '2', linkname: '../../../etc/passwd' },
  { name: 'repo-main/beta/ref.md', type: '2', linkname: '../shared/ref.md' },
  { name: 'repo-main/shared/ref.md', body: 'shared reference\n' },
  { name: 'repo-main/skills/gamma/skill.md', body: skill('gamma') },
  { name: 'repo-main/skills/beta/SKILL.md', body: skill('beta', 'a second beta') },
  { name: 'repo-main/bad/SKILL.md', body: 'no frontmatter here\n' },
  { name: 'repo-main/../evil.txt', body: 'outside\n' },
  { name: '/abs/evil.txt', body: 'outside\n' },
]

let home: string

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'dsh-skill-import-'))
  vi.stubEnv('DSH_HOME', home)
})

afterEach(() => {
  vi.unstubAllEnvs()
  vi.unstubAllGlobals()
  rmSync(home, { recursive: true, force: true })
})

function serve(archive: Buffer, manifest?: object) {
  const fetch = vi.fn(async (url: string) => {
    if (url.startsWith('https://raw.githubusercontent.com/')) {
      return manifest === undefined ? new Response('nope', { status: 404 }) : new Response(JSON.stringify(manifest))
    }
    if (url.startsWith('https://codeload.github.com/owner/repo/tar.gz/')) return new Response(new Uint8Array(archive))
    return new Response('missing', { status: 404 })
  })
  vi.stubGlobal('fetch', fetch)
  return fetch
}

async function mount() {
  const ctx = new Context()
  onTestFinished(() => ctx.fiber.dispose())
  await ctx.plugin(SkillImport)
  return ctx.skillImport
}

it('reads GitHub addresses and leaves other specs alone', () => {
  expect(parseGitHub('owner/repo')).toEqual({ owner: 'owner', repo: 'repo' })
  expect(parseGitHub('https://github.com/owner/repo.git')).toEqual({ owner: 'owner', repo: 'repo' })
  expect(parseGitHub('https://github.com/owner/repo/tree/main/skills/x')).toEqual({ owner: 'owner', repo: 'repo', ref: 'main', path: 'skills/x' })
  expect(parseGitHub('https://github.com/owner/repo/blob/v1/x/SKILL.md')).toEqual({ owner: 'owner', repo: 'repo', ref: 'v1', path: 'x' })
  expect(parseGitHub('git@github.com:owner/repo.git')).toEqual({ owner: 'owner', repo: 'repo' })
  expect(parseGitHub('git+https://github.com/owner/repo.git#dev')).toEqual({ owner: 'owner', repo: 'repo', ref: 'dev' })
  for (const other of ['lodash', '@scope/pkg', '/abs/path', './rel/x', 'https://gitlab.com/a/b', 'https://github.com/owner/repo/issues/1']) {
    expect(parseGitHub(other)).toBeUndefined()
  }
})

it('lists marketplace, skills folder, and top-level skills once each, and copies chosen folders without links leaving the repository', async () => {
  serve(tarGz(REPO))
  const service = await mount()
  const inspection = await service.inspect('https://github.com/owner/repo')
  if (inspection.kind !== 'skills') throw new Error(`unexpected ${inspection.kind}`)
  expect(inspection.source).toEqual({ repo: 'owner/repo', url: 'https://github.com/owner/repo', commit: COMMIT })
  expect(inspection.skills.map(found => [found.id, found.name, found.problem === undefined])).toEqual([
    ['pack/skills/alpha', 'alpha', true],
    ['bad', 'bad', false],
    ['skills/beta', 'beta', true],
    ['skills/gamma', 'gamma', true],
  ])
  expect(existsSync(join(home, '..', 'evil.txt'))).toBe(false)

  const result = await service.add(inspection.token, ['skills/beta', 'skills/gamma', 'pack/skills/alpha', 'bad'], [])
  expect(result).toEqual({ ok: true, installed: ['beta', 'gamma', 'alpha'], skipped: [{ name: 'bad', reason: 'invalid', detail: 'missing YAML frontmatter' }], warnings: [] })
  expect(readFileSync(join(home, 'skills', 'beta', 'SKILL.md'), 'utf8')).toContain('a second beta')
  expect(readFileSync(join(home, 'skills', 'gamma', 'SKILL.md'), 'utf8')).toContain('gamma does things')
  expect(await readdir(join(home, 'skills'))).toEqual(expect.arrayContaining(['.maitre-sources.json', 'alpha', 'beta', 'gamma']))
  expect(existsSync(join(home, 'cache', 'skill-import', inspection.token))).toBe(false)
  expect((await service.list()).map(installed => [installed.name, installed.source.path, installed.present])).toEqual([
    ['alpha', 'pack/skills/alpha', true], ['beta', 'skills/beta', true], ['gamma', 'skills/gamma', true],
  ])
  expect((await service.list())[0]?.source.url).toBe(`https://github.com/owner/repo/tree/${COMMIT}/pack/skills/alpha`)
})

it('installs one linked skill folder, copying in-repository links and leaving out the rest', async () => {
  serve(tarGz(REPO))
  const service = await mount()
  const inspection = await service.inspect('https://github.com/owner/repo/tree/main/beta')
  if (inspection.kind !== 'skills') throw new Error(`unexpected ${inspection.kind}`)
  expect(inspection.skills.map(found => found.id)).toEqual(['beta'])
  const result = await service.add(inspection.token, ['beta'], [])
  expect(result).toMatchObject({ ok: true, installed: ['beta'], warnings: [expect.stringContaining('beta/escape')] })
  expect(readFileSync(join(home, 'skills', 'beta', 'ref.md'), 'utf8')).toBe('shared reference\n')
  expect(readFileSync(join(home, 'skills', 'beta', 'scripts', 'run.sh'), 'utf8')).toBe('echo never run\n')
  expect(existsSync(join(home, 'skills', 'beta', 'escape'))).toBe(false)
})

it('skips existing names unless replacing them, and removes only skills it installed', async () => {
  serve(tarGz(REPO))
  const service = await mount()
  const first = await service.inspect('owner/repo')
  if (first.kind !== 'skills') throw new Error(`unexpected ${first.kind}`)
  await service.add(first.token, ['skills/beta'], [])
  const second = await service.inspect('owner/repo')
  if (second.kind !== 'skills') throw new Error(`unexpected ${second.kind}`)
  expect(second.skills.find(found => found.name === 'beta')?.exists).toBe(true)
  expect(await service.add(second.token, ['skills/beta'], [])).toMatchObject({ installed: [], skipped: [{ name: 'beta', reason: 'exists' }] })
  const third = await service.inspect('owner/repo')
  if (third.kind !== 'skills') throw new Error(`unexpected ${third.kind}`)
  expect(await service.add(third.token, ['skills/beta'], ['beta'])).toMatchObject({ installed: ['beta'], skipped: [] })
  const expired = await service.add(third.token, ['skills/beta'], [])
  expect(expired.ok).toBe(false)
  expect(expired.ok ? '' : expired.message).toContain('expired')

  expect(await service.uninstall('not-installed')).toHaveLength(1)
  expect(await service.uninstall('beta')).toEqual([])
  expect(existsSync(join(home, 'skills', 'beta'))).toBe(false)
})

it('leaves a repository declaring a dsh bundle to the plugin installer without downloading it', async () => {
  const fetch = serve(tarGz(REPO), { name: 'dsh-plugin-x', dsh: { bundle: { patch: './cordis.patch.yml' } } })
  const service = await mount()
  expect(await service.inspect('https://github.com/owner/repo')).toEqual({ kind: 'bundle' })
  expect(await service.inspect('dsh-plugin-x')).toEqual({ kind: 'not-github' })
  expect(fetch.mock.calls.map(([url]) => url).some(url => url.includes('codeload'))).toBe(false)
})

it('reports a repository without skills or a missing linked folder', async () => {
  serve(tarGz([{ name: 'repo-main/README.md', body: '# nothing\n' }]))
  const service = await mount()
  expect(await service.inspect('owner/repo')).toEqual({ kind: 'none', source: { repo: 'owner/repo', url: 'https://github.com/owner/repo' } })
  expect(await service.inspect('https://github.com/owner/repo/tree/main/missing')).toMatchObject({ kind: 'failed' })
  expect(await readdir(join(home, 'cache', 'skill-import'))).toEqual([])
})
