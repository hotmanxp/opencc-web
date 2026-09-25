/**
 * MiniMax native web search adapter.
 *
 * MiniMax (https://api.minimaxi.com) exposes Anthropic-compatible
 * /v1/messages with the server-side `web_search_20250305` tool — the model
 * autonomously triggers searches and the server streams back
 * server_tool_use / web_search_tool_result / text content blocks.
 *
 * Activated via WEB_SEARCH_PROVIDER=minimax (or the IS_HOME_NETWORK
 * env-var shortcut handled in providers/index.ts → getProviderMode()).
 * Credentials are read from MINIMAX_API_KEY; the base URL and model are
 * configurable via MINIMAX_BASE_URL / MINIMAX_WEB_SEARCH_MODEL.
 *
 * Env vars:
 *   MINIMAX_API_KEY         required — MiniMax API key
 *   MINIMAX_BASE_URL        optional — default https://api.minimaxi.com/anthropic
 *   MINIMAX_WEB_SEARCH_MODEL optional — default MiniMax-M3 (the Agentic model)
 */

import type { SearchInput, SearchProvider } from './types.js'
import { applyDomainFilters, type ProviderOutput } from './types.js'
import { fetchJsonWithWebSearchTimeout } from './timeout.js'

const DEFAULT_BASE_URL = 'https://api.minimaxi.com/anthropic'
const DEFAULT_MODEL = 'MiniMax-M3'

export const minimaxProvider: SearchProvider = {
  name: 'minimax',

  isConfigured() {
    return Boolean(process.env.MINIMAX_API_KEY)
  },

  async search(input: SearchInput, signal?: AbortSignal): Promise<ProviderOutput> {
    const start = performance.now()
    const baseUrl = process.env.MINIMAX_BASE_URL ?? DEFAULT_BASE_URL
    const apiKey = process.env.MINIMAX_API_KEY
    if (!apiKey) {
      throw new Error(
        'MiniMax web search requires MINIMAX_API_KEY. ' +
        'Set it in your shell environment, or switch WEB_SEARCH_PROVIDER.',
      )
    }
    const model = process.env.MINIMAX_WEB_SEARCH_MODEL ?? DEFAULT_MODEL

    const tool: Record<string, unknown> = {
      type: 'web_search_20250305',
      name: 'web_search',
      max_uses: 10,
    }
    if (input.allowed_domains?.length) {
      tool.allowed_domains = input.allowed_domains
    }
    if (input.blocked_domains?.length) {
      tool.blocked_domains = input.blocked_domains
    }

    const data = await fetchJsonWithWebSearchTimeout(
      `${baseUrl}/v1/messages`,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': apiKey,
          'anthropic-version': '2023-06-01',
        },
        body: JSON.stringify({
          model,
          max_tokens: 8192,
          messages: [{ role: 'user', content: input.query }],
          tools: [tool],
        }),
      },
      signal,
      { providerName: 'MiniMax' },
    )

    const hits: Array<{ title: string; url: string; description?: string; source?: string }> = []
    const blocks = Array.isArray(data?.content) ? data.content : []
    for (const block of blocks) {
      if (block?.type !== 'web_search_tool_result') continue
      if (!Array.isArray(block.content)) continue
      for (const r of block.content) {
        if (typeof r?.title === 'string' && typeof r?.url === 'string') {
          hits.push({
            title: r.title,
            url: r.url,
            description: typeof r.content === 'string' ? r.content : undefined,
          })
        }
      }
    }

    return {
      hits: applyDomainFilters(hits, input),
      providerName: 'minimax',
      durationSeconds: (performance.now() - start) / 1000,
    }
  },
}