/**
 * Maitre Search: one request to the Maitre search endpoint per search, and the public DuckDuckGo HTML page when the
 * endpoint has no key, is unreachable, or fails.
 * @module @deepseek-ai/dsh-web-search-maitre/provider
 */
import { WebError } from '@deepseek-ai/dsh-web'
import type { WebSearchProvider, WebSearchRequest, WebSearchResult, WebSearchSource } from '@deepseek-ai/dsh-web'

/** Stable id Maitre Search registers under in the search registry. */
export const MAITRE_SEARCH_PROVIDER_ID = 'maitre'

/** Results requested when the request sets no bound. */
export const MAITRE_DEFAULT_RESULTS = 6

/** Longest snippet kept per source, in characters. Search answers stay cheap; the model fetches a page for more. */
export const MAITRE_SNIPPET_CHARS = 300

const DUCKDUCKGO_HTML = 'https://html.duckduckgo.com/html/'
const USER_AGENT = 'Mozilla/5.0 (compatible; Maitre/1.0; +https://maitre.menthiq.com)'

/** Settings snapshotted for one provider instance. */
export interface MaitreSearchOptions {
  /** API base the key is sent to, including `/v1`; `/search` is appended. */
  baseURL: string
  /** Read the Maitre API key; undefined or empty means no key. */
  apiKey: () => Promise<string | undefined>
  /** Per-request timeout in milliseconds. */
  timeoutMs: number
  /** Whether a failed or keyless endpoint search falls back to DuckDuckGo. */
  fallback: boolean
}

interface EndpointResult {
  title?: unknown
  url?: unknown
  snippet?: unknown
  published?: unknown
}

const text = (value: unknown): string | undefined =>
  typeof value === 'string' && value.trim() !== '' ? value.trim() : undefined

const clip = (value: string | undefined): string | undefined =>
  value === undefined || value.length <= MAITRE_SNIPPET_CHARS ? value : `${value.slice(0, MAITRE_SNIPPET_CHARS - 1)}…`

const isHttpUrl = (value: string): boolean => {
  try {
    const { protocol } = new URL(value)
    return protocol === 'http:' || protocol === 'https:'
  } catch {
    return false
  }
}

/**
 * Keep the first source per URL, drop non-HTTP URLs, and bound snippets.
 * @param sources - candidate sources in rank order.
 * @param limit - most sources to keep.
 * @returns the cleaned sources.
 */
export function cleanSources(sources: readonly WebSearchSource[], limit: number): WebSearchSource[] {
  const seen = new Set<string>()
  const kept: WebSearchSource[] = []
  for (const source of sources) {
    if (kept.length >= limit) break
    if (!isHttpUrl(source.url) || seen.has(source.url)) continue
    seen.add(source.url)
    const snippet = clip(source.snippet)
    kept.push({
      url: source.url,
      ...(source.title === undefined ? {} : { title: source.title }),
      ...(snippet === undefined ? {} : { snippet }),
      ...(source.publishedAt === undefined ? {} : { publishedAt: source.publishedAt }),
    })
  }
  return kept
}

const ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: '\'', nbsp: ' ', '#39': '\'', '#x27': '\'' }

const decodeHtml = (value: string): string => value
  .replace(/<[^>]*>/gu, '')
  .replace(/&(#x[0-9a-f]+|#\d+|[a-z]+|#39|#x27);/giu, (match: string, entity: string) => {
    const known = ENTITIES[entity.toLowerCase()]
    if (known !== undefined) return known
    if (entity.startsWith('#x') || entity.startsWith('#X')) return String.fromCodePoint(Number.parseInt(entity.slice(2), 16))
    if (entity.startsWith('#')) return String.fromCodePoint(Number.parseInt(entity.slice(1), 10))
    return match
  })
  .replace(/\s+/gu, ' ')
  .trim()

/**
 * Resolve a DuckDuckGo result link to its destination: `//duckduckgo.com/l/?uddg=<encoded>` redirects are unwrapped,
 * direct links pass through, and ad links are dropped.
 * @param href - the raw `href` attribute value.
 * @returns the destination URL, or undefined for links that are not results.
 */
export function duckDuckGoTarget(href: string): string | undefined {
  const raw = decodeHtml(href)
  let parsed: URL
  try {
    parsed = new URL(raw, 'https://duckduckgo.com')
  } catch {
    return undefined
  }
  if (parsed.hostname.endsWith('duckduckgo.com')) {
    if (parsed.pathname.startsWith('/y.js')) return undefined
    const target = parsed.searchParams.get('uddg')
    return target !== null && isHttpUrl(target) ? target : undefined
  }
  return isHttpUrl(parsed.href) ? parsed.href : undefined
}

/**
 * Read result titles, links, and snippets from a DuckDuckGo HTML results page.
 * @param html - the page body.
 * @returns the sources in page order.
 */
export function parseDuckDuckGo(html: string): WebSearchSource[] {
  const sources: WebSearchSource[] = []
  const blocks = html.split(/<div[^>]+class="[^"]*\bresult\b[^"]*"/u).slice(1)
  for (const block of blocks) {
    const link = /<a[^>]+class="[^"]*\bresult__a\b[^"]*"[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/u.exec(block)
      ?? /<a[^>]+href="([^"]+)"[^>]*class="[^"]*\bresult__a\b[^"]*"[^>]*>([\s\S]*?)<\/a>/u.exec(block)
    if (link === null) continue
    const url = duckDuckGoTarget(link[1] ?? '')
    if (url === undefined) continue
    const snippet = /class="[^"]*\bresult__snippet\b[^"]*"[^>]*>([\s\S]*?)<\/(?:a|div|td)>/u.exec(block)
    const title = decodeHtml(link[2] ?? '')
    const body = snippet === null ? '' : decodeHtml(snippet[1] ?? '')
    sources.push({ url, ...(title === '' ? {} : { title }), ...(body === '' ? {} : { snippet: body }) })
  }
  return sources
}

const linked = (signal: AbortSignal | undefined, timeoutMs: number): AbortSignal =>
  signal === undefined ? AbortSignal.timeout(timeoutMs) : AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)])

const aborted = (signal: AbortSignal | undefined): WebError =>
  new WebError('Search was cancelled', 'WEB_ABORTED', { cause: signal?.reason })

/** {@link WebSearchProvider} backed by the Maitre search endpoint with a DuckDuckGo fallback. */
export class MaitreSearchProvider implements WebSearchProvider {
  readonly id = MAITRE_SEARCH_PROVIDER_ID
  readonly title = 'Maitre Search'
  readonly description = {
    en: 'Fast web search through Maitre. Results are short snippets; fetch a page only when the snippets are not enough.',
  }

  constructor(private readonly options: MaitreSearchOptions) {}

  available(): boolean {
    return true
  }

  async search(request: WebSearchRequest, signal?: AbortSignal): Promise<WebSearchResult> {
    const limit = Math.max(1, Math.min(request.maxResults ?? MAITRE_DEFAULT_RESULTS, 10))
    const query = request.query.trim()
    if (query === '') throw new WebError('Search query is empty', 'WEB_INVALID_REQUEST')
    const failures: string[] = []
    const key = await this.options.apiKey().catch(() => undefined)
    if (key !== undefined && key !== '') {
      try {
        return { sources: cleanSources(await this.endpoint(query, limit, key, signal), limit), truncated: false }
      } catch (error: unknown) {
        if (signal?.aborted === true) throw aborted(signal)
        if (!this.options.fallback) throw error
        failures.push(error instanceof Error ? error.message : String(error))
      }
    } else if (!this.options.fallback) {
      throw new WebError('Maitre Search needs a Maitre API key. Ask the user to add their key in Settings.', 'WEB_PROVIDER_MISCONFIGURED')
    }
    try {
      return { sources: cleanSources(await this.duckDuckGo(query, signal), limit), truncated: false }
    } catch (error: unknown) {
      if (signal?.aborted === true) throw aborted(signal)
      failures.push(error instanceof Error ? error.message : String(error))
      throw new WebError(`Web search failed: ${failures.join('; ')}`, 'WEB_PROVIDER_ERROR', { cause: error })
    }
  }

  private async endpoint(query: string, limit: number, key: string, signal?: AbortSignal): Promise<WebSearchSource[]> {
    const response = await fetch(`${this.options.baseURL.replace(/\/+$/u, '')}/search`, {
      method: 'POST',
      headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json', 'user-agent': USER_AGENT },
      body: JSON.stringify({ query, max_results: limit }),
      redirect: 'error',
      signal: linked(signal, this.options.timeoutMs),
    })
    if (!response.ok) throw new WebError(`Maitre Search answered HTTP ${response.status}`, 'WEB_PROVIDER_ERROR')
    const body = await response.json() as { results?: unknown }
    if (!Array.isArray(body.results)) throw new WebError('Maitre Search returned an invalid response', 'WEB_PROVIDER_ERROR')
    return (body.results as EndpointResult[]).flatMap((item): WebSearchSource[] => {
      const url = text(item.url)
      if (url === undefined) return []
      const title = text(item.title), snippet = text(item.snippet), publishedAt = text(item.published)
      return [{
        url,
        ...(title === undefined ? {} : { title }),
        ...(snippet === undefined ? {} : { snippet }),
        ...(publishedAt === undefined ? {} : { publishedAt }),
      }]
    })
  }

  private async duckDuckGo(query: string, signal?: AbortSignal): Promise<WebSearchSource[]> {
    const response = await fetch(DUCKDUCKGO_HTML, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded', 'user-agent': USER_AGENT },
      body: new URLSearchParams({ q: query }).toString(),
      signal: linked(signal, this.options.timeoutMs),
    })
    if (!response.ok) throw new WebError(`DuckDuckGo answered HTTP ${response.status}`, 'WEB_PROVIDER_ERROR')
    const page = await response.text()
    if (response.status === 202 || page.includes('anomaly-modal')) {
      throw new WebError('DuckDuckGo blocked the request with a bot check', 'WEB_PROVIDER_ERROR')
    }
    const sources = parseDuckDuckGo(page)
    if (sources.length === 0) throw new WebError('DuckDuckGo returned no results (it may be rate limiting)', 'WEB_PROVIDER_ERROR')
    return sources
  }
}
