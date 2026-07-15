/**
 * 瞬时 API 错误重试策略 — 对齐 OpenCC `withRetry.ts` 的语义。
 *
 * 触发点：`DefaultBackgroundRuntime.runOne` 的 catch block（modelCaller
 * 抛错路径，不是 stream 内的 `runtime.error` 事件）。不依赖 `@anthropic-ai/sdk`
 * 类型，用 duck-type 读 `err.status` / `err.message`，避免给 runtime 包加硬依赖。
 */
import type { ErrorCategory } from '../events.js'

export const RETRY_POLICY = {
  /** OpenCC DEFAULT_MAX_RETRIES = 10 */
  maxRetries: 10,
  /** OpenCC MAX_529_RETRIES = 3 */
  max529Retries: 3,
  /** OpenCC DEFAULT_RETRY_DELAY_MS = 500 */
  baseDelayMs: 500,
  /** OpenCC MAX_RETRY_DELAY_BASE_MS = 60_000（zai BackgroundRuntime 收紧到 32s） */
  maxDelayMs: 32_000,
} as const

export interface RetryDecision {
  /** 落 `BackgroundTask.error.category` */
  category: ErrorCategory
  /** 是否可重试（受 maxRetries / max529Retries 上限约束） */
  retryable: boolean
  /** 距下一次重试的等待毫秒；retryable=true 时必有 */
  delayMs: number
  /** OpenCC `isTransientCapacityError`：529 / 429（限速但非 quota） */
  isTransientCapacity: boolean
}

/**
 * 判断一个 429 错误是否因为"quota 耗尽"——quota exhausted 不应重试，
 * 让用户切 provider 或充值。对齐 OpenCC `withRetry.ts:124`。
 */
export function isQuotaExhausted(err: unknown): boolean {
  if (!err || typeof err !== 'object') return false
  const e = err as { status?: unknown; message?: unknown }
  if (e.status !== 429) return false
  const msg = typeof e.message === 'string' ? e.message.toLowerCase() : ''
  return msg.includes('limit: 0') || msg.includes('exceeded your current quota')
}

/**
 * Duck-type 读取 error.status / error.message，不强制 instanceof APIError。
 * Anthropic SDK 抛 APIError(status=529)，OpenAI 兼容网关也可能抛带 status 的对象，
 * 还有些 throw new Error('fetch failed') 形式的网络错误——都能识别。
 */
export function classifyRetryableError(err: unknown): RetryDecision {
  const status = readStatus(err)
  const msg = readMessage(err)
  const lower = msg.toLowerCase()

  // 529 / overloaded_error → 永远可重试
  if (status === 529 || lower.includes('overloaded_error')) {
    return {
      category: 'llm_provider_overloaded',
      retryable: true,
      delayMs: RETRY_POLICY.baseDelayMs,
      isTransientCapacity: true,
    }
  }

  // 429 rate limit
  if (status === 429) {
    if (isQuotaExhausted(err)) {
      return {
        category: 'internal',
        retryable: false,
        delayMs: 0,
        isTransientCapacity: false,
      }
    }
    return {
      category: 'llm_provider_rate_limit',
      retryable: true,
      delayMs: RETRY_POLICY.baseDelayMs,
      isTransientCapacity: true,
    }
  }

  // 401 / 403 → auth，不可重试（依赖上层 token 刷新）
  if (status === 401 || status === 403) {
    return {
      category: 'llm_provider_auth',
      retryable: false,
      delayMs: 0,
      isTransientCapacity: false,
    }
  }

  // 5xx / 网络错误 / timeout → server，可重试
  if (
    (status !== undefined && status >= 500) ||
    lower.includes('fetch failed') ||
    lower.includes('econnreset') ||
    lower.includes('epipe') ||
    lower.includes('timeout')
  ) {
    return {
      category: 'llm_provider_server',
      retryable: true,
      delayMs: RETRY_POLICY.baseDelayMs,
      isTransientCapacity: false,
    }
  }

  // 其他 4xx / 未知错误 → internal，不可重试
  return {
    category: 'internal',
    retryable: false,
    delayMs: 0,
    isTransientCapacity: false,
  }
}

/**
 * 指数退避 + 抖动。对齐 OpenCC `withRetry.ts:622 getRetryDelay`。
 * - base = baseDelayMs × 2^(attempt-1)
 * - cap at maxDelayMs
 * - jitter: random(0..0.25) × base；`jitterRatio=0` 时退化为纯 base 序列。
 */
export function getRetryDelay(
  attempt: number,
  baseDelayMs: number = RETRY_POLICY.baseDelayMs,
  maxDelayMs: number = RETRY_POLICY.maxDelayMs,
  jitterRatio: number = 0.25,
): number {
  const safeAttempt = Math.max(1, attempt)
  const base = Math.min(baseDelayMs * 2 ** (safeAttempt - 1), maxDelayMs)
  const jitter = jitterRatio === 0 ? 0 : Math.random() * jitterRatio * base
  return base + jitter
}

/**
 * 带 abort signal 的 sleep。signal 已 abort 时立即 resolve。
 */
export function retrySleep(ms: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) return Promise.resolve()
  return new Promise<void>((resolve) => {
    const t = setTimeout(resolve, ms)
    if (signal) {
      const onAbort = () => {
        clearTimeout(t)
        resolve()
      }
      signal.addEventListener('abort', onAbort, { once: true })
    }
  })
}

function readStatus(err: unknown): number | undefined {
  if (!err || typeof err !== 'object') return undefined
  const s = (err as { status?: unknown }).status
  return typeof s === 'number' ? s : undefined
}

function readMessage(err: unknown): string {
  if (err instanceof Error) return err.message
  if (err && typeof err === 'object') {
    const m = (err as { message?: unknown }).message
    if (typeof m === 'string') return m
  }
  if (typeof err === 'string') return err
  return ''
}