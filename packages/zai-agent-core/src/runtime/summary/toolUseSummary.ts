/**
 * runtime/summary/toolUseSummary.ts — generate a 1-2 sentence summary for a
 * tool-use result by calling a small model (default 'haiku').
 *
 * Spec: docs/superpowers/specs/2026-07-19-zai-loop-resilience-e-step-limit-design.md
 *
 * §2.1 signature:
 *
 *   export function generateToolUseSummary(
 *     opts: GenerateSummaryOptions
 *   ): Promise<ToolSummaryRecord>
 *
 * §2.4 error contract:
 *   - Never throws. If modelCaller errors / times out / yields no text →
 *     return a fallback record `{ summary: '', modelUsed: 'fallback' }`.
 *   - 5s timeout enforced via internal AbortController (linked with the
 *     caller's `signal` so external aborts short-circuit immediately).
 *
 * §6.4 boundary: this function ONLY generates and (optionally) persists the
 * summary; it does NOT inject the summary into the prompt assembly.
 * Integration with prompt assembly is left to a later spec (F2).
 */

import { randomUUID } from 'node:crypto'

// ---- types ----------------------------------------------------------------

/**
 * Minimal `ModelCaller` shape this module needs. Compatible with the broader
 * `ModelCaller` in `../types.js`; declared structurally here to avoid the
 * runtime/types import (keeps this module usable from tests without dragging
 * in the full runtime surface).
 */
export type SummaryModelCaller = (req: {
  model: string
  systemPrompt: string
  messages: Array<{ role: 'user' | 'assistant'; content: unknown }>
  tools: unknown[]
  signal?: AbortSignal
}) => AsyncIterable<{
  type: string
  index?: number
  content_block?: { type: string; text?: string }
  delta?: { type: string; text?: string }
}>

/**
 * Structural subset of `ToolResult<T>` from `../../tools/Tool.js`. The spec
 * (§2.1) passes the full `ToolResult`, but we only read `data` here — keeping
 * the type loose avoids a dependency on `opencc-internals`.
 */
export interface ToolResultLike {
  data?: unknown
  // Optional passthrough fields — ignored but tolerated.
  [key: string]: unknown
}

export interface GenerateSummaryOptions {
  /** Result of the tool execution. Only `data` is read. */
  toolResult: ToolResultLike
  /**
   * Optional explicit toolUseId. When omitted, a random id is generated
   * (`tu-<uuid>`). Persisted callers should pass the actual id so the
   * SummaryStore can be looked up by the integration PR.
   */
  toolUseId?: string
  /** Session/transcript identifier. Echoed back in the record for tracing. */
  sessionId: string
  /**
   * Transcript ID — used as the SummaryStore key. (Typically equals
   * sessionId in current zai; kept separate so future split is non-breaking.)
   */
  transcriptId: string
  /** Caller's abort signal. Linked with internal timeout. */
  signal: AbortSignal
  /**
   * Model caller used to produce the summary. If omitted, `generateToolUseSummary`
   * cannot produce a summary — it returns the fallback record immediately.
   */
  modelCaller?: SummaryModelCaller
  /**
   * Override for the default 'haiku' model alias.
   * Resolved by the caller's `ModelCaller` implementation; we just thread
   * it through.
   */
  summaryModel?: string
  /**
   * Override for the default 5_000 ms timeout. Tests use shorter values to
   * keep CI fast.
   */
  summaryTimeoutMs?: number
}

import type { ToolSummaryRecord } from './summaryStore.js'

// ---- constants ------------------------------------------------------------

const DEFAULT_MODEL = 'haiku'
const DEFAULT_TIMEOUT_MS = 5_000
const MAX_OUTPUT_TOKENS = 200 // spec §6.4 — cap to prevent runaway spend

// ---- implementation -------------------------------------------------------

/**
 * Generate a summary for the given tool result.
 *
 * Always resolves — never throws. See §2.4.
 */
export async function generateToolUseSummary(
  opts: GenerateSummaryOptions,
): Promise<ToolSummaryRecord> {
  const toolUseId = opts.toolUseId ?? `tu-${randomUUID()}`
  const fallback = (): ToolSummaryRecord => ({
    toolUseId,
    summary: '',
    generatedAt: Date.now(),
    modelUsed: 'fallback',
  })

  if (!opts.modelCaller) {
    return fallback()
  }

  // ---- timeout + signal composition (§2.4 + §3 行为 5) -----------------
  const timeoutMs = opts.summaryTimeoutMs ?? DEFAULT_TIMEOUT_MS
  const timeoutController = new AbortController()
  const timer = setTimeout(() => timeoutController.abort(), timeoutMs)

  const onCallerAbort = () => timeoutController.abort()
  if (opts.signal.aborted) {
    clearTimeout(timer)
    return fallback()
  }
  opts.signal.addEventListener('abort', onCallerAbort, { once: true })

  try {
    const modelUsed = opts.summaryModel ?? DEFAULT_MODEL
    const req = {
      model: modelUsed,
      systemPrompt:
        'You are a tool-result summarizer. Produce a 1-2 sentence summary ' +
        'of the following tool result. Keep it concise and factual.',
      messages: [
        {
          role: 'user' as const,
          content: serializeToolResult(opts.toolResult),
        },
      ],
      tools: [],
      signal: timeoutController.signal,
    }

    let summary = ''
    const stream = opts.modelCaller(req as Parameters<SummaryModelCaller>[0])
    try {
      // Drive the async iterator manually with a race against the abort
      // signal so a stuck caller (e.g. a generator that awaits a Promise
      // that never resolves) cannot block longer than `timeoutMs`.
      for await (const ev of abortableIter(stream, timeoutController.signal)) {
        if (
          ev &&
          ev.type === 'content_block_delta' &&
          (ev as { delta?: { type?: string; text?: string } }).delta?.type ===
            'text_delta' &&
          typeof (ev as { delta?: { text?: string } }).delta?.text === 'string'
        ) {
          summary += (ev as { delta: { text: string } }).delta.text
        }
        if (ev && ev.type === 'message_stop') {
          break
        }
      }
    } catch {
      // modelCaller threw while iterating → fallback.
      return fallback()
    }

    summary = summary.trim()
    if (!summary) {
      // Either timeout fired mid-stream, or the model returned no text.
      return fallback()
    }

    return {
      toolUseId,
      summary,
      generatedAt: Date.now(),
      modelUsed,
    }
  } catch {
    // §2.4: any unexpected error → fallback. Never re-throw.
    return fallback()
  } finally {
    clearTimeout(timer)
    opts.signal.removeEventListener('abort', onCallerAbort)
  }
}

// ---- helpers --------------------------------------------------------------

/**
 * Wrap an async iterable so that pulling the next item races against an
 * AbortSignal. If the signal aborts before the next item is available, the
 * iterator yields nothing further — letting the caller's `for await` loop
 * exit and check the abort flag.
 *
 * This is the only way to enforce a timeout against a stuck
 * `modelCaller` whose generator awaits a Promise that never resolves:
 * `for await` alone blocks on `iter.next()`, and a never-resolving inner
 * await means `next()` never settles.
 */
async function* abortableIter<T>(
  source: AsyncIterable<T>,
  signal: AbortSignal,
): AsyncGenerator<T> {
  const it = source[Symbol.asyncIterator]()
  try {
    while (true) {
      if (signal.aborted) return
      // Race the next() promise against an abort-triggered never-resolving
      // promise. If abort wins, return without yielding.
      const next = it.next()
      const aborted = new Promise<never>((_, reject) => {
        if (signal.aborted) reject(new Error('aborted'))
        else signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true })
      })
      let result: IteratorResult<T>
      try {
        result = await Promise.race([next, aborted])
      } catch {
        // Aborted — stop iterating cleanly.
        return
      }
      if (result.done) return
      yield result.value
    }
  } finally {
    if (typeof it.return === 'function') {
      try {
        it.return()
      } catch {
        // ignore — we're already exiting
      }
    }
  }
}

/**
 * Serialize a `ToolResultLike` into a short text payload for the model
 * prompt. Cap at ~8 KB to avoid sending pathological payloads to the
 * summary model. Falls back to JSON.stringify when content isn't a string.
 */
function serializeToolResult(result: ToolResultLike): string {
  const data = result?.data
  if (typeof data === 'string') return truncate(data)
  try {
    return truncate(JSON.stringify(data, null, 2))
  } catch {
    return truncate(String(data))
  }
}

const SERIALIZE_CAP = 8 * 1024
function truncate(s: string): string {
  if (s.length <= SERIALIZE_CAP) return s
  return `${s.slice(0, SERIALIZE_CAP)}\n...[truncated]`
}

// re-export MAX_OUTPUT_TOKENS for tests
export const __testing = { MAX_OUTPUT_TOKENS, DEFAULT_TIMEOUT_MS, DEFAULT_MODEL }
