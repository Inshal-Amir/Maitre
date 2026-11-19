import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  MaitreSearchProvider, MAITRE_SNIPPET_CHARS, cleanSources, duckDuckGoTarget, parseDuckDuckGo,
} from '../src/provider.ts'
import type { MaitreSearchOptions } from '../src/provider.ts'

const DDG_PAGE = `
<div class="result results_links results_links_deep web-result">
  <h2 class="result__title"><a rel="nofollow" class="result__a"
    href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fwww.ogra.org.pk%2Fprices&amp;rut=abc">OGRA &amp; <b>petrol</b> prices</a></h2>
  <a class="result__snippet" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fwww.ogra.org.pk%2Fprices">Notified prices &#x27;today&#x27;</a>
</div>
<div class="result results_links web-result result--ad">
  <a class="result__a" href="https://duckduckgo.com/y.js?ad_domain=x">Ad</a>
</div>
<div class="result results_links web-result">
  <a class="result__a" href="https://example.com/b">Second</a>
  <div class="result__snippet">Second snippet</div>
</div>`

const options = (overrides: Partial<MaitreSearchOptions> = {}): MaitreSearchOptions => ({
  baseURL: 'https://api.test/v1/',
  apiKey: () => Promise.resolve('sk-test'),
  timeoutMs: 5_000,
  fallback: true,
  ...overrides,
})

const json = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('parseDuckDuckGo', () => {
  it('unwraps redirect links, decodes text, and skips ads', () => {
    expect(parseDuckDuckGo(DDG_PAGE)).toEqual([
      { url: 'https://www.ogra.org.pk/prices', title: 'OGRA & petrol prices', snippet: 'Notified prices \'today\'' },
      { url: 'https://example.com/b', title: 'Second', snippet: 'Second snippet' },
    ])
  })

  it('rejects non-result links', () => {
    expect(duckDuckGoTarget('https://duckduckgo.com/y.js?ad=1')).toBeUndefined()
    expect(duckDuckGoTarget('javascript:alert(1)')).toBeUndefined()
    expect(duckDuckGoTarget('https://a.example/x')).toBe('https://a.example/x')
  })
})

describe('cleanSources', () => {
  it('dedupes by URL, drops non-HTTP URLs, bounds snippets and count', () => {
    const long = 'x'.repeat(MAITRE_SNIPPET_CHARS + 50)
    const cleaned = cleanSources([
      { url: 'https://a.example', snippet: long },
      { url: 'https://a.example', title: 'dup' },
      { url: 'ftp://b.example' },
      { url: 'https://c.example' },
      { url: 'https://d.example' },
    ], 2)
    expect(cleaned.map(source => source.url)).toEqual(['https://a.example', 'https://c.example'])
    expect(cleaned[0]?.snippet).toHaveLength(MAITRE_SNIPPET_CHARS)
  })
})

describe('MaitreSearchProvider', () => {
  it('sends the key to the Maitre endpoint and maps results', async () => {
    const fetchMock = vi.fn(() => Promise.resolve(json({
      results: [{ title: 'T', url: 'https://r.example', snippet: 'S', published: '2026-11-01' }, { title: 'no url' }],
    })))
    vi.stubGlobal('fetch', fetchMock)
    const result = await new MaitreSearchProvider(options()).search({ query: ' petrol ', maxResults: 3 })
    expect(result).toEqual({
      sources: [{ url: 'https://r.example', title: 'T', snippet: 'S', publishedAt: '2026-11-01' }],
      truncated: false,
    })
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit]
    expect(url).toBe('https://api.test/v1/search')
    expect((init.headers as Record<string, string>).authorization).toBe('Bearer sk-test')
    expect(JSON.parse(init.body as string)).toEqual({ query: 'petrol', max_results: 3 })
  })

  it('falls back to DuckDuckGo when the endpoint fails', async () => {
    const fetchMock = vi.fn((url: string) => Promise.resolve(
      url.includes('duckduckgo') ? new Response(DDG_PAGE, { status: 200 }) : json({ error: 'down' }, 503),
    ))
    vi.stubGlobal('fetch', fetchMock)
    const result = await new MaitreSearchProvider(options()).search({ query: 'petrol', maxResults: 1 })
    expect(result.sources).toEqual([
      { url: 'https://www.ogra.org.pk/prices', title: 'OGRA & petrol prices', snippet: 'Notified prices \'today\'' },
    ])
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })

  it('uses DuckDuckGo directly without a key', async () => {
    const fetchMock = vi.fn(() => Promise.resolve(new Response(DDG_PAGE, { status: 200 })))
    vi.stubGlobal('fetch', fetchMock)
    await new MaitreSearchProvider(options({ apiKey: () => Promise.resolve(undefined) })).search({ query: 'q' })
    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect((fetchMock.mock.calls[0] as unknown as [string])[0]).toContain('duckduckgo')
  })

  it('reports both failures when every source fails', async () => {
    vi.stubGlobal('fetch', vi.fn(() => Promise.resolve(new Response('', { status: 503 }))))
    await expect(new MaitreSearchProvider(options()).search({ query: 'q' }))
      .rejects.toMatchObject({ code: 'WEB_PROVIDER_ERROR', message: expect.stringContaining('Maitre Search answered HTTP 503') })
  })

  it('without fallback, a missing key is a configuration error', async () => {
    vi.stubGlobal('fetch', vi.fn())
    const provider = new MaitreSearchProvider(options({ fallback: false, apiKey: () => Promise.resolve('') }))
    await expect(provider.search({ query: 'q' })).rejects.toMatchObject({ code: 'WEB_PROVIDER_MISCONFIGURED' })
  })

  it('rejects an empty query', async () => {
    await expect(new MaitreSearchProvider(options()).search({ query: '  ' }))
      .rejects.toMatchObject({ code: 'WEB_INVALID_REQUEST' })
  })
})
