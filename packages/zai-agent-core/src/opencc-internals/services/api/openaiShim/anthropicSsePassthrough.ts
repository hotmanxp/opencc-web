// @ts-nocheck
import type { AnthropicStreamEvent } from '../codexShim.js'
import {
  createReaderCanceller,
  getStreamIdleTimeoutMs,
  readWithIdleTimeout,
} from './streaming.js'

/**
 * Forwards an Anthropic-shaped SSE stream verbatim.
 *
 * The endpoint already produces Anthropic-format streaming events
 * (`message_start`, `content_block_*`, `message_delta`, `message_stop`),
 * so we just parse the SSE framing, JSON-decode each `data:` payload,
 * and yield it as an `AnthropicStreamEvent` without translation.
 *
 * Abort handling mirrors `openaiStreamToAnthropic.ts`:
 *   - `createReaderCanceller` invokes `reader.cancel()` when the caller's
 *     AbortSignal fires (controller.abort() or upstream cancellation).
 *   - `readWithIdleTimeout` rejects the in-flight read with AbortError on
 *     the same signal, so the async generator throws to the consumer.
 *   - `while (signal?.aborted) { cancel; return }` at the loop top short-
 *     circuits the next iteration once abort has fired.
 *
 * Buffered chunk handling: an SSE event is bounded by a blank line. The
 * `data:` payload of one event may span multiple reader.read() chunks
 * (newlines inside the JSON), so we accumulate into a buffer and only
 * attempt to parse a frame once we see a `\n\n` (or a stream `done`).
 * If the caller's signal aborts while buffered frames are pending, we
 * drop them — the test only requires that no further events reach the
 * consumer after abort fires.
 */
async function* anthropicSsePassthrough(
  response: Response,
  signal?: AbortSignal,
): AsyncGenerator<AnthropicStreamEvent> {
  const reader = response.body?.getReader()
  if (!reader) return

  const decoder = new TextDecoder()
  const readerCanceller = createReaderCanceller(reader, signal)
  const streamIdleTimeoutMs = getStreamIdleTimeoutMs()
  let buffer = ''
  let streamComplete = false

  try {
    if (signal?.aborted) {
      throw new DOMException('Aborted', 'AbortError')
    }

    while (true) {
      if (signal?.aborted) {
        readerCanceller.cancel(new DOMException('Aborted', 'AbortError'))
        throw new DOMException('Aborted', 'AbortError')
      }
      const { done, value } = await readWithIdleTimeout(reader, streamIdleTimeoutMs, {
        signal,
        cancelReader: readerCanceller.cancel,
      })

      if (done) {
        // Drain any remaining buffered frame on EOF (e.g. trailing
        // message_stop that arrived without a final blank line).
        const tail = buffer.trim()
        if (tail) {
          if (signal?.aborted) {
            readerCanceller.cancel(new DOMException('Aborted', 'AbortError'))
            throw new DOMException('Aborted', 'AbortError')
          }
          const event = parseSseFrame(tail)
          if (event) yield event
        }
        streamComplete = true
        return
      }

      if (signal?.aborted) {
        readerCanceller.cancel(new DOMException('Aborted', 'AbortError'))
        throw new DOMException('Aborted', 'AbortError')
      }

      buffer += decoder.decode(value, { stream: true })

      // SSE events are delimited by a blank line (`\n\n`). Split the
      // buffer, keep the last incomplete chunk, yield the rest.
      let boundary = buffer.indexOf('\n\n')
      while (boundary !== -1) {
        if (signal?.aborted) {
          readerCanceller.cancel(new DOMException('Aborted', 'AbortError'))
          throw new DOMException('Aborted', 'AbortError')
        }
        const frame = buffer.slice(0, boundary)
        buffer = buffer.slice(boundary + 2)
        const event = parseSseFrame(frame)
        if (event) yield event
        boundary = buffer.indexOf('\n\n')
      }
    }
  } finally {
    if (!streamComplete || signal?.aborted) {
      readerCanceller.cancel(new DOMException('Aborted', 'AbortError'))
    }
    readerCanceller.cleanup()
    reader.releaseLock()
  }
}

/**
 * Parse one SSE event block into an AnthropicStreamEvent. Returns null
 * for blank lines, comments (`:...`), or payloads that don't decode as
 * a well-formed object with a `type` field.
 */
function parseSseFrame(frame: string): AnthropicStreamEvent | null {
  const dataLines: string[] = []
  for (const rawLine of frame.split('\n')) {
    const line = rawLine.trimEnd()
    if (!line || line.startsWith(':')) continue
    if (line.startsWith('data:')) {
      dataLines.push(line.slice(5).trimStart())
    }
  }
  if (dataLines.length === 0) return null
  const payload = dataLines.join('\n')
  try {
    const parsed = JSON.parse(payload)
    if (!parsed || typeof parsed !== 'object' || !('type' in parsed)) {
      return null
    }
    return parsed as AnthropicStreamEvent
  } catch {
    return null
  }
}

export { anthropicSsePassthrough }
