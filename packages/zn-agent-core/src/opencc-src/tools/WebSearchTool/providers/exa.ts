/**
 * Exa Search API adapter.
 * POST https://api.exa.ai/search
 * Auth: x-api-key: <key>
 */

import type { SearchInput, SearchProvider } from './types.js'
import { applyDomainFilters, safeHostname, type ProviderOutput } from './types.js'
import { fetchJsonWithWebSearchTimeout } from './timeout.js'

export const exaProvider: SearchProvider = {
  name: 'exa',

  isConfigured() {
    return Boolean(process.env.EXA_API_KEY)
  },

  async search(input: SearchInput, signal?: AbortSignal): Promise<ProviderOutput> {
    const start = performance.now()

    const body: Record<string, any> = {
      query: input.query,
      numResults: 15,
      type: 'auto',
    }

    if (input.allowed_domains?.length) body.includeDomains = input.allowed_domains
    if (input.blocked_domains?.length) body.excludeDomains = input.blocked_domains

    const data = await fetchJsonWithWebSearchTimeout(
      'https://api.exa.ai/search',
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': process.env.EXA_API_KEY!,
        },
        body: JSON.stringify(body),
      },
      signal,
      { providerName: 'Exa' },
    )

    const hits = (data.results ?? []).map((r: any) => ({
      title: r.title ?? '',
      url: r.url ?? '',
      description: r.snippet ?? r.text,
      source: r.url ? safeHostname(r.url) : undefined,
    }))

    return {
      // Exa handles domain filtering server-side via includeDomains/excludeDomains
      hits,
      providerName: 'exa',
      durationSeconds: (performance.now() - start) / 1000,
    }
  },
}
