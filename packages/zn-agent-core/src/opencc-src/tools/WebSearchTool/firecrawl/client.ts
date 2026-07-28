/**
 * Minimal Firecrawl client stub for the #1874 websearch cherry-pick.
 *
 * Upstream's `firecrawlSearch` lived in a sibling module under
 * `src/tools/WebSearchTool/firecrawl/client.ts` that was NOT included in the
 * cherry-pick (it lives in the upstream `openclaude` SDK bundle, which
 * OpenCC deliberately skips per AGENTS.md "Skip SDK bundle"). This stub
 * matches the surface that `src/tools/WebSearchTool/providers/firecrawl.ts`
 * consumes: a `firecrawlSearch(query, opts)` call returning
 * `{ web: Array<{url, title?, description?}> }`.
 *
 * The stub throws a clear runtime error pointing the user to install
 * `@mendable/firecrawl-js` so the call path fails loudly rather than
 * silently returning empty results.
 */

export type FirecrawlSearchOptions = {
  apiKey: string | undefined
  apiUrl: string | undefined
  limit: number
  signal: AbortSignal
}

export type FirecrawlSearchHit = {
  url: string
  title?: string
  description?: string
}

export type FirecrawlSearchResult = {
  web?: FirecrawlSearchHit[]
}

export async function firecrawlSearch(
  query: string,
  opts: FirecrawlSearchOptions,
): Promise<FirecrawlSearchResult> {
  throw new Error(
    'firecrawlSearch stub: upstream SDK client not available in OpenCC. ' +
      'Install @mendable/firecrawl-js and replace this stub, or remove the ' +
      `firecrawl provider (query="${query}", apiUrl=${opts.apiUrl ?? '<unset>'}).`,
  )
}