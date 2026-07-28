import type { SearchInput, SearchProvider } from './types.js'
import { applyDomainFilters, type ProviderOutput } from './types.js'
import { firecrawlSearch } from '../firecrawl/client.js'
import { withWebSearchTimeout } from './timeout.js'

export const firecrawlProvider: SearchProvider = {
  name: 'firecrawl',

  isConfigured() {
    return Boolean(process.env.FIRECRAWL_API_KEY) || Boolean(process.env.FIRECRAWL_API_URL)
  },

  async search(input: SearchInput, signal?: AbortSignal): Promise<ProviderOutput> {
    const start = performance.now()
    if (signal?.aborted) throw new DOMException('Aborted', 'AbortError')
    // TODO: @mendable/firecrawl-js SDK doesn't accept AbortSignal — can't cancel in-flight searches
    const { FirecrawlClient } = await import('@mendable/firecrawl-js')
    const app = new FirecrawlClient({
      apiKey: process.env.FIRECRAWL_API_KEY,
      apiUrl: process.env.FIRECRAWL_API_URL,
    })

    let query = input.query
    if (input.blocked_domains?.length) {
      const exclusions = input.blocked_domains.map(d => `-site:${d}`).join(' ')
      query = `${query} ${exclusions}`
    }

    const data = await withWebSearchTimeout(
      combinedSignal => firecrawlSearch(query, {
        apiKey: process.env.FIRECRAWL_API_KEY,
        apiUrl: process.env.FIRECRAWL_API_URL,
        limit: 15,
        signal: combinedSignal,
      }),
      signal,
      { providerName: 'Firecrawl' },
    )

    const hits = applyDomainFilters(
      // @ts-ignore - type mismatch in map callback
      (data.web ?? []).map((r: { url: string; title?: string; description?: string }) => ({
        title: r.title ?? r.url,
        url: r.url,
        description: r.description,
      })),
      input,
    )

    return {
      hits,
      providerName: 'firecrawl',
      durationSeconds: (performance.now() - start) / 1000,
    }
  },
}