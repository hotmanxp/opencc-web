/**
 * SDKMessage → zai RuntimeEvent translator.
 *
 * opencc's `query()` (`opencc-src/query.ts`) emits a stream of `Message`s
 * (opencc's internal types, NOT Anthropic SDK). zai's
 * `routes/agent.ts::translateRuntimeEvents()` consumes zai's
 * `RuntimeEvent` shape (Anthropic content_block_* primitives).
 *
 * This adapter unwraps each opencc Message into the same Anthropic
 * primitives that `translateRuntimeEvents()` already handles, so the
 * downstream translator can stay unchanged.
 *
 * Status: Phase 5 stub. The full unwrap (system / user / assistant /
 * attachment / tool_use_summary / tombstone → message_start /
 * content_block_* / message_delta / message_stop) requires careful
 * mapping of opencc's Message union. The skeleton below shows the
 * structure; full impl comes once `runViaOpenccQuery` calls
 * `opencc query()` and we exercise the integration tests.
 *
 * Opencc Message types (from `opencc-src/types/message.ts`):
 *   - SystemMessage (init / local_command / compact_boundary / ...)
 *   - UserMessage
 *   - AssistantMessage (contains content blocks)
 *   - AttachmentMessage
 *   - ProgressMessage
 *   - ToolUseSummaryMessage
 *   - TombstoneMessage (deleted)
 *   - ResultMessage (final result)
 *
 * Anthropic primitives we yield:
 *   - message_start (with messageId / model)
 *   - content_block_start (text / thinking / tool_use)
 *   - content_block_delta (text_delta / thinking_delta / input_json_delta)
 *   - content_block_stop
 *   - message_delta (stop_reason)
 *   - message_stop
 *
 * Each yielded event carries zai meta:
 *   - eventId, sessionId, ts, turnIndex
 *
 * Plus the SSE translator in zai routes/agent.ts understands extra
 * meta fields (toolUseId / toolName / input) attached to tool_use:start
 * events emitted by tools' onYield.
 */

import type { RuntimeEvent } from './events.js'

export function* translateSdkToRuntime(
  openccMessage: unknown,
  meta: { sessionId: string; turnIndex: number; eventCounter: number },
): Iterable<RuntimeEvent> {
  const m = openccMessage as { type: string; [key: string]: unknown }
  const nextId = () => `evt-${++meta.eventCounter}`

  switch (m.type) {
    case 'system': {
      // SystemMessage → forward as runtime.system (zai's SSE channel)
      // Examples: init, compact_boundary, local_command
      yield {
        type: 'runtime.system',
        eventId: nextId(),
        sessionId: meta.sessionId,
        turnIndex: meta.turnIndex,
        ts: Date.now(),
        payload: m,
      } as RuntimeEvent
      return
    }

    case 'user': {
      // UserMessage echoes from tool_result feedback. Yield as a system
      // event so the SSE translator can decide what to do (usually suppress).
      yield {
        type: 'runtime.system',
        eventId: nextId(),
        sessionId: meta.sessionId,
        turnIndex: meta.turnIndex,
        ts: Date.now(),
        payload: { kind: 'tool_result_echo', message: m },
      } as RuntimeEvent
      return
    }

    case 'assistant': {
      // AssistantMessage — this is the big one. We yield:
      //   message_start
      //   for each content block:
      //     content_block_start
      //     content_block_delta (text/thinking/input_json)
      //     content_block_stop
      //   message_delta (with stop_reason)
      //   message_stop
      //
      // Phase 5 placeholder: yield message_start + message_stop so the
      // shape matches. The block unwrap needs opencc's AssistantMessage
      // shape (full impl in subsequent commits).
      const assistant = m.message as {
        id?: string
        model?: string
        content?: Array<Record<string, unknown>>
        stop_reason?: string
      } | undefined
      yield {
        type: 'message_start',
        eventId: nextId(),
        sessionId: meta.sessionId,
        turnIndex: meta.turnIndex,
        ts: Date.now(),
        message: {
          id: assistant?.id ?? `msg-${Date.now()}`,
          model: assistant?.model ?? 'unknown',
          role: 'assistant',
        },
      } as RuntimeEvent
      // TODO: walk assistant.content and yield content_block_*
      yield {
        type: 'message_stop',
        eventId: nextId(),
        sessionId: meta.sessionId,
        turnIndex: meta.turnIndex,
        ts: Date.now(),
      } as RuntimeEvent
      return
    }

    case 'attachment': {
      // AttachmentMessage — image / file attached to a user turn.
      yield {
        type: 'runtime.system',
        eventId: nextId(),
        sessionId: meta.sessionId,
        turnIndex: meta.turnIndex,
        ts: Date.now(),
        payload: { kind: 'attachment', message: m },
      } as RuntimeEvent
      return
    }

    case 'progress': {
      // ProgressMessage — tool progress updates (bash running etc.)
      yield {
        type: 'runtime.system',
        eventId: nextId(),
        sessionId: meta.sessionId,
        turnIndex: meta.turnIndex,
        ts: Date.now(),
        payload: { kind: 'progress', message: m },
      } as RuntimeEvent
      return
    }

    case 'tool_use_summary': {
      // ToolUseSummaryMessage — lightweight summary of a tool call
      // (used by transcript persistence). Forward as-is.
      yield {
        type: 'runtime.system',
        eventId: nextId(),
        sessionId: meta.sessionId,
        turnIndex: meta.turnIndex,
        ts: Date.now(),
        payload: { kind: 'tool_use_summary', message: m },
      } as RuntimeEvent
      return
    }

    case 'tombstone': {
      // TombstoneMessage — message was deleted (e.g. via /rewind)
      yield {
        type: 'runtime.system',
        eventId: nextId(),
        sessionId: meta.sessionId,
        turnIndex: meta.turnIndex,
        ts: Date.now(),
        payload: { kind: 'tombstone', message: m },
      } as RuntimeEvent
      return
    }

    case 'result': {
      // ResultMessage — final result with usage / cost / duration
      yield {
        type: 'runtime.done',
        eventId: nextId(),
        sessionId: meta.sessionId,
        turnIndex: meta.turnIndex,
        ts: Date.now(),
        payload: m,
      } as RuntimeEvent
      return
    }

    default:
      // Unknown message variant — forward as system event so it's at
      // least visible in logs.
      yield {
        type: 'runtime.system',
        eventId: nextId(),
        sessionId: meta.sessionId,
        turnIndex: meta.turnIndex,
        ts: Date.now(),
        payload: { kind: 'unknown', message: m },
      } as RuntimeEvent
  }
}