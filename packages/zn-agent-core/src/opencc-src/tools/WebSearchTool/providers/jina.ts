/**
 * Jina Search API adapter.
 * GET https://s.jina.ai/?q=...
 * Auth: Authorization: Bearer <key>
 */

import type { SearchInput, SearchProvider } from './types.ts'
import { applyDomainFilters, safeHostname, type ProviderOutput } from './types.ts'
import { fetchJsonWithWebSearchTimeout } from './timeout.ts'

export const jinaProvider: SearchProvider = {
  name: 'jina',

  isConfigured() {
    return Boolean(process.env.JINA_API_KEY)
  },

  async search(input: SearchInput, signal?: AbortSignal): Promise<ProviderOutput> {
    const start = performance.now()

    const url = new URL('https://s.jina.ai/')
    url.searchParams.set('q', input.query)
    url.searchParams.set('count', '10')

    const data = await fetchJsonWithWebSearchTimeout(
      url.toString(),
      {
        headers: {
          Authorization: `Bearer ${process.env.JINA_API_KEY}`,
          Accept: 'application/json',
        },
      },
      signal,
      { providerName: 'Jina' },
    )

    const hits = (data.data ?? data.results ?? []).map((r: any) => ({
      title: r.title ?? '',
      url: r.url ?? '',
      description: r.description ?? r.snippet ?? r.content,
      source: r.url ? safeHostname(r.url) : undefined,
    }))

    return {
      hits: applyDomainFilters(hits, input),
      providerName: 'jina',
      durationSeconds: (performance.now() - start) / 1000,
    }
  },
}
