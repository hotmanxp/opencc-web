/**
 * A.2 max_output_tokens 自愈流式恢复 (recoverMaxOutputTokens).
 *
 * spec §2.1 / §2.4:
 * - maxAttempts 默认 3,capEscalation 默认 [4096, 16384, 65536]
 * - 非 max_output_tokens 错误立即抛(不重试)
 * - 第 3 次仍失败 → yield runtime.error kind:'max_output_tokens',不再抛
 * - 暴露的 RuntimeEvent runtime.error payload 加 kind + providerErrorCode
 */

import { randomUUID } from 'node:crypto'
import type { RuntimeEvent } from '../events.js'
import { classifyApiError } from './classification.js'
import type { ModelCaller } from '../types.js'
import type { AnthropicMessage } from '../../transcript/types.js'

const DEFAULT_CAP_ESCALATION: [number, number, number] = [4096, 16384, 65536]
const DEFAULT_MAX_ATTEMPTS = 3

export interface MaxTokensRecoveryOptions {
  modelCaller: ModelCaller
  messages: AnthropicMessage[]
  maxAttempts?: number
  capEscalation?: [number, number, number]
  signal: AbortSignal
  /** Optional session/turn ctx so yielded events get meta attached. */
  ctx?: { sessionId?: string; turnIndex?: number }
}

/** Detect a max_output_tokens condition from a thrown error or yielded error event. */
function isMaxOutputTokensError(err: unknown): boolean {
  // Direct thrown error
  const direct = classifyApiError(err)
  if (direct.kind === 'max_output_tokens') return true

  // Error event yielded inside the stream (some SDKs stream an error event then stop)
  if (err && typeof err === 'object') {
    const e: any = err
    if (e.type === 'error' && e.error) {
      const classified = classifyApiError(e.error)
      if (classified.kind === 'max_output_tokens') return true
    }
  }
  return false
}

let eventCounter = 0
function nextEventId(): string {
  eventCounter++
  return `evt-${eventCounter}`
}

export async function* recoverMaxOutputTokens(
  opts: MaxTokensRecoveryOptions,
): AsyncGenerator<RuntimeEvent> {
  const maxAttempts = opts.maxAttempts ?? DEFAULT_MAX_ATTEMPTS
  const caps = opts.capEscalation ?? DEFAULT_CAP_ESCALATION
  const { modelCaller, messages, signal } = opts
  const sessionId = opts.ctx?.sessionId ?? 'sess-recovery'
  const turnIndex = opts.ctx?.turnIndex ?? 0

  if (signal.aborted) {
    yield {
      eventId: nextEventId(),
      sessionId,
      ts: Date.now(),
      turnIndex,
      type: 'runtime.error',
      error: {
        category: 'aborted',
        message: 'aborted before recovery',
        recoverable: false,
        kind: 'max_output_tokens',
        providerErrorCode: 'aborted',
      },
    }
    return
  }

  const attempts = Math.min(maxAttempts, caps.length)
  let lastErr: unknown = null

  for (let i = 0; i < attempts; i++) {
    const cap = caps[i]!
    try {
      const stream = modelCaller({
        model: 'recovered',
        systemPrompt: '',
        messages: messages as any,
        tools: [],
        signal,
        max_tokens: cap,
      } as any)

      let sawAnyEvent = false
      let sawNonMaxError = false
      let firstNonMaxErr: unknown = null

      for await (const ev of stream) {
        // SDK error event with non-max_output_tokens → bail immediately, rethrow up
        if ((ev as any).type === 'error') {
          const classified = classifyApiError((ev as any).error)
          if (classified.kind !== 'max_output_tokens') {
            sawNonMaxError = true
            firstNonMaxErr = (ev as any).error
            // Yield the upstream event so callers can observe
            yield {
              ...(ev as any),
              eventId: nextEventId(),
              sessionId,
              ts: Date.now(),
              turnIndex,
            } as RuntimeEvent
            break
          }
          // max_output_tokens → silently retry with next cap
          lastErr = (ev as any).error
          break
        }

        sawAnyEvent = true
        // Forward raw stream event with runtime meta attached
        yield {
          ...(ev as any),
          eventId: nextEventId(),
          sessionId,
          ts: Date.now(),
          turnIndex,
        } as RuntimeEvent

        if ((ev as any).type === 'message_stop') {
          // 成功 — 不重试,直接退出
          return
        }
      }

      if (sawNonMaxError) {
        throw firstNonMaxErr
      }

      if (!sawAnyEvent) {
        // Stream terminated without any event — treat as soft failure → retry next cap
        continue
      }
    } catch (err) {
      if (isMaxOutputTokensError(err)) {
        lastErr = err
        // Continue to next attempt
        continue
      }
      // 非 max_output_tokens → 立即抛(spec §2.4)
      throw err
    }
  }

  // 全部 attempts 都失败 → yield runtime.error kind:'max_output_tokens',不抛
  const classified = classifyApiError(lastErr)
  yield {
    eventId: nextEventId(),
    sessionId,
    ts: Date.now(),
    turnIndex,
    type: 'runtime.error',
    error: {
      category: 'llm_provider',
      message: classified.message,
      recoverable: false,
      kind: 'max_output_tokens',
      providerErrorCode: classified.providerErrorCode ?? 'max_output_tokens',
    },
  }
}