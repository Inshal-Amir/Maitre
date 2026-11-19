/**
 * Maitre Search `WebSearchProvider` plugin. It contributes to the `ctx.web` registry without owning the service and
 * reads the Maitre API key from the credential store on every search.
 *
 * @module @deepseek-ai/dsh-web-search-maitre
 */

import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import type {} from '@deepseek-ai/dsh-web'
import { credentialRef } from '@deepseek-ai/dsh-credentials'
import type { CredentialProvider } from '@deepseek-ai/dsh-credentials'
import { MaitreSearchProvider } from './provider.ts'

export {
  MAITRE_DEFAULT_RESULTS,
  MAITRE_SEARCH_PROVIDER_ID,
  MAITRE_SNIPPET_CHARS,
  MaitreSearchProvider,
  cleanSources,
  duckDuckGoTarget,
  parseDuckDuckGo,
} from './provider.ts'
export type { MaitreSearchOptions } from './provider.ts'

/** Cordis plugin name used by loader diagnostics. */
export const name = 'web-search-maitre'

/** The web seam this provider registers into. */
export const inject = ['web']

/** Plugin config: endpoint, credential reference, timeout, and fallback. */
export interface Config {
  /** Maitre API base including `/v1`; `/search` is appended. */
  baseURL?: string
  /** Credential reference holding the Maitre API key. */
  apiKeyEnv?: string
  /** Per-request timeout in milliseconds. */
  timeoutMs?: number
  /** Fall back to DuckDuckGo when the endpoint has no key or fails. */
  fallback?: boolean
}

export const Config: z<Config> = z.object({
  baseURL: z.string().default('https://api.menthiq.com/v1'),
  apiKeyEnv: z.string().role('credential-ref').default('MAITRE_API_KEY'),
  timeoutMs: z.number().default(20_000),
  fallback: z.boolean().default(true),
})

/** Register Maitre Search with `ctx.web`. */
export function apply(ctx: Context, config: Config): void {
  const resolved = config as Required<Config>
  if (!Number.isFinite(resolved.timeoutMs) || resolved.timeoutMs <= 0) {
    throw new Error('web-search-maitre: timeoutMs must be a positive finite number')
  }
  const ref = credentialRef(resolved.apiKeyEnv)
  const apiKey = async (): Promise<string | undefined> => {
    const credentials = ctx.get('credentials') as CredentialProvider | undefined
    const stored = await credentials?.resolve(ref)
    return stored?.value ?? process.env[resolved.apiKeyEnv]
  }
  ctx.web.registerSearchProvider(new MaitreSearchProvider({
    baseURL: resolved.baseURL,
    apiKey,
    timeoutMs: resolved.timeoutMs,
    fallback: resolved.fallback,
  }))
}
