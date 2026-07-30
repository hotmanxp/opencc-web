import { getSessionId } from '../../bootstrap/state.js'
import { resolveProviderRequest } from '../../services/api/providerConfig.js'
import type { LocalCommandCall } from '../../types/command.js'
import { getMainLoopModel } from '../../utils/model/model.js'

// Large system prompt (~6000 chars, ~1500 tokens) to cross the 1024-token cache threshold
const SYSTEM_PROMPT = [
  'You are a coding assistant. Answer concisely.',
  'CONTEXT: User is working on a TypeScript project with Bun runtime.',
  ...Array.from(
    { length: 80 },
    (_, i) =>
      `Rule ${i + 1}: Follow best practices for TypeScript including strict typing, error handling, testing, and clean code. Prefer explicit types over any. Use const assertions. Await all async operations.`,
  ),
].join('\n\n')

const USER_MESSAGE = 'Say "hello" and nothing else.'

/**
 * Extract model family from a versioned model string.
 */
function getModelFamily(model: string | undefined): string {
  if (!model) return 'unknown'
  return model
    .replace(/-\d{4,}$/, '')
    .replace(/-latest$/, '')
    .replace(/-preview$/, '')
}

interface ProbeResult {
  label: string
  status: number
  cached: boolean
  latency: number
  detail?: string
}

async function probeCache(
  url: string,
  headers: Record<string, string>,
  body: Record<string, unknown>,
): Promise<ProbeResult> {
  const start = Date.now()

  try {
    const response = await fetch(url, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
    })

    const latency = Date.now() - start
    const cached = response.headers.get('x-cache-hit') === 'true' ||
      response.headers.get('cf-cache-status') === 'HIT'

    return {
      label: 'Cache probe',
      status: response.status,
      cached,
      latency,
      detail: cached ? 'Response served from cache' : 'Response not cached',
    }
  } catch (error) {
    return {
      label: 'Cache probe',
      status: 0,
      cached: false,
      latency: Date.now() - start,
      detail: error instanceof Error ? error.message : 'Unknown error',
    }
  }
}

export async function runCacheProbe(
  _args: LocalCommandCall,
  options?: { modelOverride?: string },
): Promise<{ type: 'text'; value: string } | { type: 'table'; columns: string[]; rows: string[][] }> {
  const modelOverride = options?.modelOverride
  const modelStr = modelOverride ?? getMainLoopModel()
  const request = resolveProviderRequest({ model: modelStr })

  const apiKey = process.env.OPENAI_API_KEY ?? ''

  if (!apiKey) {
    return {
      type: 'text',
      value:
        'No API key found. Make sure you are in an active OpenAI-compatible session.\n' +
        'Set OPENAI_API_KEY.',
    }
  }

  const endpoint = '/chat/completions'
  const url = `${request.baseUrl}${endpoint}`
  const family = getModelFamily(request.resolvedModel)
  const cacheKey = `${getSessionId()}:${family}`

  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    Authorization: `Bearer ${apiKey}`,
    originator: 'opencc',
  }

  const body = {
    model: request.resolvedModel,
    messages: [
      { role: 'system', content: SYSTEM_PROMPT },
      { role: 'user', content: USER_MESSAGE },
    ],
    max_tokens: 10,
  }

  const result = await probeCache(url, headers, body)

  const statusIcon = result.status === 200 ? '✓' : '✗'
  const cacheIcon = result.cached ? 'HIT' : 'MISS'

  return {
    type: 'table',
    columns: ['Endpoint', 'Status', 'Cache', 'Latency', 'Detail'],
    rows: [[
      cacheKey,
      `${statusIcon} ${result.status}`,
      cacheIcon,
      `${result.latency}ms`,
      result.detail ?? '',
    ]],
  }
}
