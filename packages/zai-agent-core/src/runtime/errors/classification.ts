/**
 * A.1 错误分类(classifyApiError).
 *
 * 把 API / 网络 / 工具错误归类为 ErrorKind 枚举,前端 toast 可读。
 * spec §2.1 ErrorKind union + §2.4 永不抛契约。
 */

export type ErrorKind =
  | 'prompt_too_long'
  | 'max_output_tokens'
  | 'rate_limit'
  | 'auth'
  | 'context_overflow'
  | 'provider_max_tokens_cap'
  | 'tool_failure_loop'
  | 'hook_blocked'
  | 'unknown'

export interface ClassifiedError {
  kind: ErrorKind
  message: string
  retryable: boolean
  providerErrorCode?: string | number
}

const UNKNOWN_FALLBACK: ClassifiedError = {
  kind: 'unknown',
  message: 'unrecognized error',
  retryable: true,
}

/** Duck-typed read of `status` / `statusCode` for SDK version portability. */
function readStatus(err: any): number | undefined {
  if (typeof err?.status === 'number') return err.status
  if (typeof err?.statusCode === 'number') return err.statusCode
  return undefined
}

/** Read provider-side error code / type, opaque passthrough. */
function readProviderCode(err: any): string | number | undefined {
  // Anthropic APIError.error.type (e.g. 'rate_limit_error')
  const t = err?.error?.type
  if (typeof t === 'string') return t
  // Proxy / Node-style .code (e.g. 'ECONNRESET', 'proxy_internal_error')
  if (typeof err?.code === 'string' || typeof err?.code === 'number') return err.code
  return undefined
}

function readMessage(err: any): string {
  if (err instanceof Error) return err.message
  if (typeof err === 'string') return err
  if (err == null) return ''
  try {
    return String(err)
  } catch {
    return ''
  }
}

export function classifyApiError(err: unknown): ClassifiedError {
  try {
    const status = readStatus(err as any)
    const providerCode = readProviderCode(err as any)
    const msg = readMessage(err as any).toLowerCase()

    // --- status code mapping (highest priority) ---

    // 413 → prompt_too_long
    if (status === 413) {
      return {
        kind: 'prompt_too_long',
        message: readMessage(err as any) || 'prompt is too long',
        retryable: false,
        providerErrorCode: providerCode,
      }
    }

    // 401 / 403 → auth
    if (status === 401 || status === 403) {
      return {
        kind: 'auth',
        message: readMessage(err as any) || 'authentication failed',
        retryable: false,
        providerErrorCode: providerCode,
      }
    }

    // 429 / 529 → rate_limit (overloaded ≡ rate_limit retryable)
    if (status === 429 || status === 529) {
      return {
        kind: 'rate_limit',
        message: readMessage(err as any) || 'rate limited',
        retryable: true,
        providerErrorCode: providerCode,
      }
    }

    // 500 / 502 / 503 / 504 → 兜底 unknown retryable
    if (status === 500 || status === 502 || status === 503 || status === 504) {
      return {
        kind: 'unknown',
        message: readMessage(err as any) || `server error ${status}`,
        retryable: true,
        providerErrorCode: providerCode,
      }
    }

    // --- message-literal mapping ---

    // 'prompt_too_long' / 'context length exceeded' / 'context overflow' → prompt_too_long
    if (
      msg.includes('prompt_too_long') ||
      msg.includes('context length exceeded') ||
      msg.includes('context overflow') ||
      msg.includes('context window exceeded')
    ) {
      return {
        kind: 'prompt_too_long',
        message: readMessage(err as any),
        retryable: false,
        providerErrorCode: providerCode,
      }
    }

    // 'max_output_tokens' / 'output token limit' / 'max_tokens'
    if (
      msg.includes('max_output_tokens') ||
      msg.includes('max output tokens') ||
      msg.includes('output token limit') ||
      msg.includes('max_tokens')
    ) {
      return {
        kind: 'max_output_tokens',
        message: readMessage(err as any),
        retryable: true,
        providerErrorCode: providerCode,
      }
    }

    // 'rate limit' literal
    if (msg.includes('rate limit') || msg.includes('overloaded')) {
      return {
        kind: 'rate_limit',
        message: readMessage(err as any),
        retryable: true,
        providerErrorCode: providerCode,
      }
    }

    // 'context overflow' / 'context window'
    if (msg.includes('context overflow') || msg.includes('context window')) {
      return {
        kind: 'context_overflow',
        message: readMessage(err as any),
        retryable: false,
        providerErrorCode: providerCode,
      }
    }

    // network-layer node codes → unknown retryable
    if (
      msg.includes('econnreset') ||
      msg.includes('etimedout') ||
      msg.includes('fetch failed') ||
      msg.includes('econnrefused') ||
      msg.includes('enotfound') ||
      msg.includes('socket hang up')
    ) {
      return {
        kind: 'unknown',
        message: readMessage(err as any) || 'network error',
        retryable: true,
        providerErrorCode: providerCode,
      }
    }

    // 5xx generic message catch
    if (msg.match(/\b5\d\d\b/) || msg.includes('server error')) {
      return {
        kind: 'unknown',
        message: readMessage(err as any),
        retryable: true,
        providerErrorCode: providerCode,
      }
    }

    // Fallback (no recognizable signal)
    return {
      ...UNKNOWN_FALLBACK,
      providerErrorCode: providerCode,
    }
  } catch {
    // 永不抛 — 任何意外走兜底
    return { ...UNKNOWN_FALLBACK }
  }
}