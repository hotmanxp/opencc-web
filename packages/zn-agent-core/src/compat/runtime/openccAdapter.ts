/**
 * runOpenccQuery — top-level adapter connecting DefaultAgentRuntime.run()
 * to opencc's query() function.
 *
 * Responsibilities:
 * 1. Detect Bun runtime (opencc requires it due to bun:bundle imports).
 * 2. Honor pre-aborted signals before calling opencc.
 * 3. Translate QueryOptions → QueryParams.
 * 4. Call openccSrc.query() and forward events.
 * 5. Wrap events with RuntimeEvent meta fields (eventId, sessionId, ts, turnIndex).
 * 6. Translate opencc errors / aborts / stream-end-without-stop into RuntimeEvents.
 */

import type { QueryOptions, OpenccAdapterConfig } from './types.js'
import type { RuntimeEvent } from './events.js'
import { toQueryParams } from './queryParamsAdapter.js'
import { toRuntimeErrorEvent, toAbortedEvent } from './streamAdapter.js'

const isBun = (): boolean =>
  typeof process !== 'undefined' && typeof process.versions?.bun === 'string'

export async function* runOpenccQuery(
  opts: QueryOptions,
  config: OpenccAdapterConfig,
): AsyncIterable<RuntimeEvent> {
  // 1. Bun detection — opencc's bun:bundle imports crash in Node.
  if (!isBun()) {
    yield toRuntimeErrorEvent(
      new Error(
        'zn-agent-core opencc adapter requires Bun runtime. Run with `bun --bun zai dev` or set ZAI_USE_BUN=1',
      ),
      { sessionId: opts.sessionId ?? 'unknown', turnIndex: 0 },
    )
    return
  }

  // 2. Pre-aborted
  if (opts.abortSignal?.aborted) {
    yield toAbortedEvent(
      { sessionId: opts.sessionId ?? 'unknown', turnIndex: 0 },
      String(opts.abortSignal.reason ?? 'aborted'),
    )
    return
  }

  // 3. Translate params
  const params = toQueryParams(opts, config)

  // 4. Call opencc + wrap events
  let turnIndex = 0
  let eventCounter = 0
  let sawMessageStop = false

  try {
    // Lazy import to avoid bun:bundle chain at module load time
    const { query: openccQuery } = await import(
      '../../opencc-src/query.js' as any
    ).catch(() => {
      throw new Error('opencc-src/query.js not found; ensure opencc source is vendored')
    })

    const stream = openccQuery(params)
    for await (const rawEvent of stream as AsyncIterable<Record<string, unknown>>) {
      if (opts.abortSignal?.aborted) {
        yield toAbortedEvent(
          { sessionId: opts.sessionId ?? 'unknown', turnIndex },
          String(opts.abortSignal.reason ?? 'aborted'),
        )
        return
      }

      const eventType = String((rawEvent as any).type ?? '')
      eventCounter++
      const ev: RuntimeEvent = {
        ...rawEvent,
        type: eventType,
        eventId: `evt-${eventCounter}`,
        sessionId: opts.sessionId ?? 'unknown',
        ts: Date.now(),
        turnIndex,
      } as RuntimeEvent

      // Track turnIndex on tool_use starts
      if (
        eventType === 'content_block_start' &&
        (rawEvent as any).content_block?.type === 'tool_use'
      ) {
        turnIndex++
        ;(ev as any).turnIndex = turnIndex
      }

      // Track message_stop
      if (eventType === 'message_stop') {
        sawMessageStop = true
      }

      // Forward error events
      if (eventType === 'error') {
        const err = (rawEvent as any).error ?? rawEvent
        yield toRuntimeErrorEvent(err, {
          sessionId: opts.sessionId ?? 'unknown',
          turnIndex,
        })
        continue
      }

      yield ev
    }

    // Stream ended without message_stop — soft error
    if (!sawMessageStop) {
      yield toRuntimeErrorEvent(
        new Error('response ended without message_stop'),
        { sessionId: opts.sessionId ?? 'unknown', turnIndex },
      )
    }
  } catch (err) {
    yield toRuntimeErrorEvent(err, {
      sessionId: opts.sessionId ?? 'unknown',
      turnIndex,
    })
  }
}
