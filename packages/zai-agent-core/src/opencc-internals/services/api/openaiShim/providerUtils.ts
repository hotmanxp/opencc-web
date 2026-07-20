// @ts-nocheck
import { redactSecretValueForDisplay } from '../../../utils/providerProfile.js'
import { isEnvTruthy } from '../../../utils/envUtils.js'
import { isLocalProviderUrl } from '../providerConfig.js'
import { GEMINI_API_HOST, MOONSHOT_API_HOSTS, SENSITIVE_URL_QUERY_PARAM_NAMES } from './constants.js'
import type { SecretValueSource } from './types.js'

function filterAnthropicHeaders(
  headers: Record<string, string> | undefined,
): Record<string, string> {
  if (!headers) return {}

  const filtered: Record<string, string> = {}
  for (const [key, value] of Object.entries(headers)) {
    const lower = key.toLowerCase()
    if (
      lower.startsWith('x-anthropic') ||
      lower.startsWith('anthropic-') ||
      lower.startsWith('x-claude') ||
      lower === 'x-app' ||
      lower === 'x-client-app' ||
      lower === 'authorization' ||
      lower === 'x-api-key' ||
      lower === 'api-key'
    ) {
      continue
    }
    filtered[key] = value
  }

  return filtered
}

function hasGeminiApiHost(baseUrl: string | undefined): boolean {
  if (!baseUrl) return false

  try {
    return new URL(baseUrl).hostname.toLowerCase() === GEMINI_API_HOST
  } catch {
    return false
  }
}

function hasCerebrasApiHost(baseUrl: string | undefined): boolean {
  if (!baseUrl) return false

  try {
    const host = new URL(baseUrl).hostname.toLowerCase()
    return host === 'api.cerebras.ai' || host.endsWith('.cerebras.ai')
  } catch {
    return false
  }
}

function isMoonshotBaseUrl(baseUrl: string | undefined): boolean {
  if (!baseUrl) return false
  try {
    return MOONSHOT_API_HOSTS.has(new URL(baseUrl).hostname.toLowerCase())
  } catch {
    return false
  }
}

// Ping An Tech's API gateway hosts every model as `zhiniao-*` and rejects
// unprefixed names with 403. We auto-prepend `zhiniao-` here so callers can
// pass the bare API name and the shim handles the rest.
const ZHINIAO_MODEL_PREFIX = 'zhiniao-'
const WIZARD_AI_HOST_TOKEN = 'wizard-ai'

function isWizardAiBaseUrl(baseUrl: string | undefined): boolean {
  if (!baseUrl) return false
  try {
    return new URL(baseUrl).hostname.toLowerCase().includes(WIZARD_AI_HOST_TOKEN)
  } catch {
    return false
  }
}

function applyZhiniaoModelPrefix(baseUrl: string | undefined, model: string): string {
  if (!model) return model
  if (!isWizardAiBaseUrl(baseUrl)) return model
  if (model.startsWith(ZHINIAO_MODEL_PREFIX)) return model
  return `${ZHINIAO_MODEL_PREFIX}${model}`
}

function formatRetryAfterHint(response: Response): string {
  const ra = response.headers.get('retry-after')
  return ra ? ` (Retry-After: ${ra})` : ''
}

function shouldRedactUrlQueryParam(name: string): boolean {
  const lower = name.toLowerCase()
  return SENSITIVE_URL_QUERY_PARAM_NAMES.some(token => lower.includes(token))
}

function redactUrlForDiagnostics(url: string): string {
  try {
    const parsed = new URL(url)
    if (parsed.username) {
      parsed.username = 'redacted'
    }
    if (parsed.password) {
      parsed.password = 'redacted'
    }

    for (const key of parsed.searchParams.keys()) {
      if (shouldRedactUrlQueryParam(key)) {
        parsed.searchParams.set(key, 'redacted')
      }
    }

    const serialized = parsed.toString()
    return redactSecretValueForDisplay(serialized, process.env as SecretValueSource) ?? serialized
  } catch {
    return redactSecretValueForDisplay(url, process.env as SecretValueSource) ?? url
  }
}

function sleepMs(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms))
}

function trimTrailingSlash(value: string): string {
  return value.replace(/\/+$/, '')
}

function normalizePathWithV1(pathname: string): string {
  const trimmed = trimTrailingSlash(pathname)
  if (!trimmed || trimmed === '/') {
    return '/v1'
  }
  if (trimmed.toLowerCase().endsWith('/v1')) {
    return trimmed
  }
  return `${trimmed}/v1`
}

function isLikelyOllamaEndpoint(baseUrl: string): boolean {
  try {
    const parsed = new URL(baseUrl)
    const hostname = parsed.hostname.toLowerCase()
    const pathname = parsed.pathname.toLowerCase()
    if (parsed.port === '11434') {
      return true
    }
    return (
      hostname.includes('ollama') ||
      pathname.includes('ollama')
    )
  } catch {
    return false
  }
}

export function getLocalProviderRetryBaseUrls(baseUrl: string): string[] {
  if (!isLocalProviderUrl(baseUrl)) {
    return []
  }
  try {
    const parsed = new URL(baseUrl)
    const original = trimTrailingSlash(parsed.toString())
    const seen = new Set<string>([original])
    const candidates: string[] = []

    const addCandidate = (hostname: string, pathname: string): void => {
      const next = new URL(parsed.toString())
      next.hostname = hostname
      next.pathname = pathname
      next.search = ''
      next.hash = ''
      const normalized = trimTrailingSlash(next.toString())
      if (seen.has(normalized)) {
        return
      }
      seen.add(normalized)
      candidates.push(normalized)
    }

    const v1Pathname = normalizePathWithV1(parsed.pathname)
    if (v1Pathname !== trimTrailingSlash(parsed.pathname)) {
      addCandidate(parsed.hostname, v1Pathname)
    }

    const hostname = parsed.hostname.toLowerCase().replace(/^\[|\]$/g, '')
    if (hostname === 'localhost' || hostname === '::1') {
      addCandidate('127.0.0.1', parsed.pathname || '/')
      addCandidate('127.0.0.1', v1Pathname)
    }

    return candidates
  } catch {
    return []
  }
}

export function shouldAttemptLocalToollessRetry(options: {
  baseUrl: string
  hasTools: boolean
}): boolean {
  if (!options.hasTools) {
    return false
  }
  if (!isLocalProviderUrl(options.baseUrl)) {
    return false
  }
  return isLikelyOllamaEndpoint(options.baseUrl)
}

export {
  filterAnthropicHeaders,
  hasGeminiApiHost,
  hasCerebrasApiHost,
  isMoonshotBaseUrl,
  isWizardAiBaseUrl,
  applyZhiniaoModelPrefix,
  formatRetryAfterHint,
  shouldRedactUrlQueryParam,
  redactUrlForDiagnostics,
  sleepMs,
}
