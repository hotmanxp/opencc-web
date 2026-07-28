import type { AnthropicUsage } from '../codexShim.js'
import type { OpenAIStreamChunk } from './types.js'

const JSON_REPAIR_SUFFIXES = [
  '}', '"}', ']}', '"]}', '}}', '"}}', ']}}', '"]}}', '"]}]}', '}]}'
]

function makeMessageId(): string {
  return `msg_${crypto.randomUUID().replace(/-/g, '')}`
}

function convertChunkUsage(
  usage: OpenAIStreamChunk['usage'] | undefined,
): Partial<AnthropicUsage> | undefined {
  if (!usage) return undefined

  const cached = usage.prompt_tokens_details?.cached_tokens ?? 0
  return {
    // Subtract cached tokens: OpenAI includes them in prompt_tokens,
    // but Anthropic convention treats input_tokens as non-cached only.
    input_tokens: (usage.prompt_tokens ?? 0) - cached,
    output_tokens: usage.completion_tokens ?? 0,
    cache_creation_input_tokens: 0,
    cache_read_input_tokens: cached,
  }
}

function repairPossiblyTruncatedObjectJson(raw: string): string | null {
  try {
    const parsed = JSON.parse(raw)
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? raw
      : null
  } catch {
    for (const combo of JSON_REPAIR_SUFFIXES) {
      try {
        const repaired = raw + combo
        const parsed = JSON.parse(repaired)
        if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
          return repaired
        }
      } catch {}
    }
    return null
  }
}

const STREAM_IDLE_TIMEOUT_MS = 120_000 // 2 minutes without data = connection likely dead

interface ReadWithTimeoutState {
  lastDataTime: number
}

/**
 * Read from a ReadableStream with an idle timeout. If no data arrives within
 * STREAM_IDLE_TIMEOUT_MS, the promise rejects so the caller can reconnect.
 * Respects the caller's AbortSignal — clears the idle timer on abort
 * so the rejection reason is AbortError, not a spurious idle timeout.
 *
 * @param state - mutable object holding lastDataTime; updated on each successful read
 * @param streamName - displayed in error messages (e.g. "OpenAI/Gemini" or "Codex")
 */
async function readWithTimeout(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  signal: AbortSignal | undefined,
  state: ReadWithTimeoutState,
  streamName: string,
): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const timeoutId = setTimeout(() => {
      const elapsed = Math.round((Date.now() - state.lastDataTime) / 1000)
      reject(new Error(
        `${streamName} SSE stream idle for ${elapsed}s (limit: ${STREAM_IDLE_TIMEOUT_MS / 1000}s). Connection likely dropped.`,
      ))
    }, STREAM_IDLE_TIMEOUT_MS)

    let abortCleanup: (() => void) | undefined
    if (signal) {
      abortCleanup = () => {
        clearTimeout(timeoutId)
      }
      signal.addEventListener('abort', abortCleanup, { once: true })
    }

    reader.read().then(
      result => {
        clearTimeout(timeoutId)
        if (signal && abortCleanup) signal.removeEventListener('abort', abortCleanup)
        if (result.value) state.lastDataTime = Date.now()
        resolve(result)
      },
      err => {
        clearTimeout(timeoutId)
        if (signal && abortCleanup) signal.removeEventListener('abort', abortCleanup)
        reject(err)
      },
    )
  })
}

export {
  JSON_REPAIR_SUFFIXES,
  makeMessageId,
  convertChunkUsage,
  repairPossiblyTruncatedObjectJson,
  readWithTimeout,
  STREAM_IDLE_TIMEOUT_MS,
}

// ---------------------------------------------------------------------------
// Legacy stream controller API (cherry-pick 4a60c43a compatibility)
// Mirrors the monolith openaiShim.ts:160-275 surface used by
// openaiShim.test.ts:1309/1337/1371 via the __test namespace.
// ---------------------------------------------------------------------------

export const DEFAULT_STREAM_IDLE_TIMEOUT_MS = 90_000
export const MAX_STREAM_IDLE_TIMEOUT_MS = 2_147_483_647

export class StreamIdleTimeoutError extends Error {
  constructor(timeoutMs: number) {
    super(`Stream idle timeout - no chunks received for ${timeoutMs}ms`)
    this.name = 'StreamIdleTimeoutError'
  }
}

export function createStreamAbortError(): DOMException {
  return new DOMException('Aborted', 'AbortError')
}

export function createReaderCanceller(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  signal?: AbortSignal,
): {
  cancel: (error?: unknown) => void
  cleanup: () => void
} {
  let cancelled = false
  const cancel = (error: unknown = createStreamAbortError()) => {
    if (cancelled) return
    cancelled = true
    void reader.cancel(error).catch(() => {})
  }
  const onAbort = () => cancel(createStreamAbortError())

  signal?.addEventListener('abort', onAbort, { once: true })
  if (signal?.aborted) {
    onAbort()
  }

  return {
    cancel,
    cleanup: () => signal?.removeEventListener('abort', onAbort),
  }
}

export function getStreamIdleTimeoutMs(): number {
  const raw = process.env.CLAUDE_STREAM_IDLE_TIMEOUT_MS?.trim()
  if (!raw || !/^\d+$/.test(raw)) return DEFAULT_STREAM_IDLE_TIMEOUT_MS
  const parsed = Number(raw)
  return Number.isSafeInteger(parsed) && parsed > 0
    ? Math.min(parsed, MAX_STREAM_IDLE_TIMEOUT_MS)
    : DEFAULT_STREAM_IDLE_TIMEOUT_MS
}

type StreamReadResult = Awaited<ReturnType<ReadableStreamDefaultReader<Uint8Array>['read']>>

export async function readWithIdleTimeout(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  timeoutMs: number,
  options: {
    signal?: AbortSignal
    cancelReader?: (error?: unknown) => void
    onTimeout?: () => void
  } = {},
): Promise<StreamReadResult> {
  const signal = options.signal
  let timeoutId: ReturnType<typeof setTimeout> | undefined

  return new Promise<StreamReadResult>((resolve, reject) => {
    let settled = false
    const cleanup = () => {
      if (timeoutId !== undefined) {
        clearTimeout(timeoutId)
        timeoutId = undefined
      }
      signal?.removeEventListener('abort', onAbort)
    }
    const finishResolve = (value: StreamReadResult) => {
      if (settled) return
      settled = true
      cleanup()
      resolve(value)
    }
    const finishReject = (error: unknown) => {
      if (settled) return
      settled = true
      cleanup()
      reject(error)
    }
    const cancelAndReject = (error: unknown) => {
      if (options.cancelReader) {
        options.cancelReader(error)
      } else {
        void reader.cancel(error).catch(() => {})
      }
      finishReject(error)
    }
    const onAbort = () => {
      cancelAndReject(createStreamAbortError())
    }

    signal?.addEventListener('abort', onAbort, { once: true })
    if (signal?.aborted) {
      onAbort()
      return
    }

    timeoutId = setTimeout(() => {
      const error = new StreamIdleTimeoutError(timeoutMs)
      try {
        options.onTimeout?.()
      } catch {
        // ignore diagnostic callback failures
      }
      cancelAndReject(error)
    }, timeoutMs)

    reader.read().then(finishResolve, finishReject)
  })
}

// Test-only surface — mirrors the legacy __test namespace from openaiShim.ts:2741.
// Lets cherry-pick tests (openaiShim.test.ts:1309/1337/1371) exercise the
// stream controller abort path via `await import('./openaiShim/index.js')`.
export const __test = {
  getStreamIdleTimeoutMs,
  readWithIdleTimeout,
  StreamIdleTimeoutError,
}
