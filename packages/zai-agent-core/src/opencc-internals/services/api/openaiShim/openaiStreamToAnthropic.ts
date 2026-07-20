// @ts-nocheck
import { createThinkTagFilter } from '../thinkTagSanitizer.js'
import { hasToolFieldMapping, normalizeToolArguments } from '../toolArgumentNormalization.js'
import { createStreamState, processStreamChunk, getStreamStats } from '../../../utils/streamingOptimizer.js'
import { logForDebugging } from '../../../utils/debug.js'
import type { AnthropicStreamEvent } from '../codexShim.js'
import {
  makeMessageId,
  convertChunkUsage,
  repairPossiblyTruncatedObjectJson,
  JSON_REPAIR_SUFFIXES,
  readWithIdleTimeout,
  createReaderCanceller,
  getStreamIdleTimeoutMs,
} from './streaming.js'
import type { OpenAIStreamChunk } from './types.js'

async function* openaiStreamToAnthropic(
  response: Response,
  model: string,
  signal?: AbortSignal,
): AsyncGenerator<AnthropicStreamEvent> {
  const readerOrNull = response.body?.getReader()
  if (!readerOrNull) return
  const reader: ReadableStreamDefaultReader<Uint8Array> = readerOrNull
  const readerCanceller = createReaderCanceller(reader, signal)

  const messageId = makeMessageId()
  let contentBlockIndex = 0
  const activeToolCalls = new Map<
    number,
    {
      id: string
      name: string
      index: number
      jsonBuffer: string
      normalizeAtStop: boolean
    }
  >()
  let hasEmittedContentStart = false
  let hasEmittedThinkingStart = false
  let hasClosedThinking = false
  const thinkFilter = createThinkTagFilter()
  let lastStopReason: 'tool_use' | 'max_tokens' | 'end_turn' | null = null
  let hasEmittedFinalUsage = false
  let hasProcessedFinishReason = false
  const streamState = createStreamState()
  let streamComplete = false

  const decoder = new TextDecoder()
  let buffer = ''
  const streamIdleTimeoutMs = getStreamIdleTimeoutMs()

  const closeActiveContentBlock = async function* () {
    if (!hasEmittedContentStart) return

    const tail = thinkFilter.flush()
    if (tail) {
      yield {
        type: 'content_block_delta',
        index: contentBlockIndex,
        delta: { type: 'text_delta', text: tail },
      }
    }

    yield {
      type: 'content_block_stop',
      index: contentBlockIndex,
    }
    contentBlockIndex++
    hasEmittedContentStart = false
  }

  try {
    if (signal?.aborted) {
      throw new DOMException('Aborted', 'AbortError')
    }

    // Emit message_start
    yield {
      type: 'message_start',
      message: {
        id: messageId,
        type: 'message',
        role: 'assistant',
        content: [],
        model,
        stop_reason: null,
        stop_sequence: null,
        usage: {
          input_tokens: 0,
          output_tokens: 0,
          cache_creation_input_tokens: 0,
          cache_read_input_tokens: 0,
        },
      },
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
        streamComplete = true
        break
      }

      if (signal?.aborted) {
        readerCanceller.cancel(new DOMException('Aborted', 'AbortError'))
        throw new DOMException('Aborted', 'AbortError')
      }

      buffer += decoder.decode(value, { stream: true })
      const lines = buffer.split('\n')
      buffer = lines.pop() ?? ''

      for (const line of lines) {
        if (signal?.aborted) {
          readerCanceller.cancel(new DOMException('Aborted', 'AbortError'))
          throw new DOMException('Aborted', 'AbortError')
        }
        const trimmed = line.trim()
        if (!trimmed || trimmed === 'data: [DONE]') continue
        // Accept both "data: " (with space, OpenAI spec) and "data:" (no space,
        // emitted by paic.com.cn gateways like wizard-ai). The stream chunks
        // themselves follow the standard; only the prefix separator varies.
        if (!trimmed.startsWith('data:')) {
          continue
        }

        let chunk: OpenAIStreamChunk
        try {
          // Skip the "data:" prefix (5 chars) plus optional single space.
          chunk = JSON.parse(trimmed.startsWith('data: ') ? trimmed.slice(6) : trimmed.slice(5))
        } catch {
          continue
        }

        const chunkUsage = convertChunkUsage(chunk.usage)

        for (const choice of chunk.choices ?? []) {
          const delta = choice.delta

          // Reasoning models (e.g. GLM-5, DeepSeek) may stream chain-of-thought
          // in `reasoning_content` before the actual reply appears in `content`.
          // Emit reasoning as a thinking block and content as a text block.
          if (delta.reasoning_content != null && delta.reasoning_content !== '') {
            if (!hasEmittedThinkingStart) {
              yield {
                type: 'content_block_start',
                index: contentBlockIndex,
                content_block: { type: 'thinking', thinking: '' },
              }
              hasEmittedThinkingStart = true
            }
            yield {
              type: 'content_block_delta',
              index: contentBlockIndex,
              delta: { type: 'thinking_delta', thinking: delta.reasoning_content },
            }
          }

          // Text content
          if (delta.content != null && delta.content !== '') {
            // Close thinking block if transitioning from reasoning to content
            if (hasEmittedThinkingStart && !hasClosedThinking) {
              yield { type: 'content_block_stop', index: contentBlockIndex }
              contentBlockIndex++
              hasClosedThinking = true
            }
            if (!hasEmittedContentStart) {
              yield {
                type: 'content_block_start',
                index: contentBlockIndex,
                content_block: { type: 'text', text: '' },
              }
              hasEmittedContentStart = true
            }

            const visible = thinkFilter.feed(delta.content)
            if (visible) {
              yield {
                type: 'content_block_delta',
                index: contentBlockIndex,
                delta: { type: 'text_delta', text: visible },
              }
            }
            processStreamChunk(streamState, delta.content)
          }

          // Tool calls
          if (delta.tool_calls) {
            for (const tc of delta.tool_calls) {
              if (tc.id && tc.function?.name) {
                // New tool call starting — close any open thinking block first
                if (hasEmittedThinkingStart && !hasClosedThinking) {
                  yield { type: 'content_block_stop', index: contentBlockIndex }
                  contentBlockIndex++
                  hasClosedThinking = true
                }
                if (hasEmittedContentStart) {
                  yield* closeActiveContentBlock()
                }

                const toolBlockIndex = contentBlockIndex
                const initialArguments = tc.function.arguments ?? ''
                const normalizeAtStop = hasToolFieldMapping(tc.function.name)
                processStreamChunk(streamState, tc.function.arguments ?? '')
                activeToolCalls.set(tc.index, {
                  id: tc.id,
                  name: tc.function.name,
                  index: toolBlockIndex,
                  jsonBuffer: initialArguments,
                  normalizeAtStop,
                })

                yield {
                  type: 'content_block_start',
                  index: toolBlockIndex,
                  content_block: {
                    type: 'tool_use',
                    id: tc.id,
                    name: tc.function.name,
                    input: {},
                    ...(tc.extra_content ? { extra_content: tc.extra_content } : {}),
                    // Extract Gemini signature from extra_content
                    ...((tc.extra_content?.google as any)?.thought_signature
                      ? {
                          signature: (tc.extra_content?.google as any)
                            .thought_signature,
                        }
                      : {}),
                  },
                }
                contentBlockIndex++

                // Emit any initial arguments
                if (tc.function.arguments && !normalizeAtStop) {
                  yield {
                    type: 'content_block_delta',
                    index: toolBlockIndex,
                    delta: {
                      type: 'input_json_delta',
                      partial_json: tc.function.arguments,
                    },
                  }
                }
              } else if (tc.function?.arguments) {
                // Continuation of existing tool call
                const active = activeToolCalls.get(tc.index)
                if (active) {
                  if (tc.function.arguments) {
                    active.jsonBuffer += tc.function.arguments
                  }

                  if (active.normalizeAtStop) {
                    continue
                  }

                  yield {
                    type: 'content_block_delta',
                    index: active.index,
                    delta: {
                      type: 'input_json_delta',
                      partial_json: tc.function.arguments,
                    },
                  }
                }
              }
            }
          }

          // Finish
          if (choice.finish_reason && !hasProcessedFinishReason) {
            hasProcessedFinishReason = true

            // Close any open thinking block
            if (hasEmittedThinkingStart && !hasClosedThinking) {
              yield { type: 'content_block_stop', index: contentBlockIndex }
              contentBlockIndex++
              hasClosedThinking = true
            }
            if (hasEmittedContentStart) {
              yield* closeActiveContentBlock()
            }
            // Close active tool calls
            for (const [, tc] of activeToolCalls) {
              if (tc.normalizeAtStop) {
                let partialJson: string
                if (choice.finish_reason === 'length') {
                  partialJson = tc.jsonBuffer
                } else {
                  const repairedStructuredJson = repairPossiblyTruncatedObjectJson(
                    tc.jsonBuffer,
                  )
                  if (repairedStructuredJson) {
                    partialJson = repairedStructuredJson
                  } else {
                    partialJson = JSON.stringify(
                      normalizeToolArguments(tc.name, tc.jsonBuffer),
                    )
                  }
                }

                yield {
                  type: 'content_block_delta',
                  index: tc.index,
                  delta: {
                    type: 'input_json_delta',
                    partial_json: partialJson,
                  },
                }
                yield { type: 'content_block_stop', index: tc.index }
                continue
              }

              let suffixToAdd = ''
              if (tc.jsonBuffer) {
                try {
                  JSON.parse(tc.jsonBuffer)
                } catch {
                  const str = tc.jsonBuffer.trimEnd()
                  for (const combo of JSON_REPAIR_SUFFIXES) {
                    try {
                      JSON.parse(str + combo)
                      suffixToAdd = combo
                      break
                    } catch {}
                  }
                }
              }

              if (suffixToAdd) {
                yield {
                  type: 'content_block_delta',
                  index: tc.index,
                  delta: {
                    type: 'input_json_delta',
                    partial_json: suffixToAdd,
                  },
                }
              }

              yield { type: 'content_block_stop', index: tc.index }
            }

            const stopReason =
              choice.finish_reason === 'tool_calls'
                ? 'tool_use'
                : choice.finish_reason === 'length'
                  ? 'max_tokens'
                  : 'end_turn'
            if (choice.finish_reason === 'content_filter' || choice.finish_reason === 'safety') {
              if (!hasEmittedContentStart) {
                yield {
                  type: 'content_block_start',
                  index: contentBlockIndex,
                  content_block: { type: 'text', text: '' },
                }
                hasEmittedContentStart = true
              }
              yield {
                type: 'content_block_delta',
                index: contentBlockIndex,
                delta: { type: 'text_delta', text: '\n\n[Content blocked by provider safety filter]' },
              }
            }
            lastStopReason = stopReason

            yield {
              type: 'message_delta',
              delta: { stop_reason: stopReason, stop_sequence: null },
              ...(chunkUsage ? { usage: chunkUsage } : {}),
            }
            if (chunkUsage) {
              hasEmittedFinalUsage = true
            }
          }
        }

        if (
          !hasEmittedFinalUsage &&
          chunkUsage &&
          (chunk.choices?.length ?? 0) === 0 &&
          lastStopReason !== null
        ) {
          yield {
            type: 'message_delta',
            delta: { stop_reason: lastStopReason, stop_sequence: null },
            usage: chunkUsage,
          }
          hasEmittedFinalUsage = true
        }
      }
    }
  } finally {
    if (!streamComplete || signal?.aborted) {
      readerCanceller.cancel(new DOMException('Aborted', 'AbortError'))
    }
    readerCanceller.cleanup()
    reader.releaseLock()
  }

  const stats = getStreamStats(streamState)
  if (stats.totalChunks > 0) {
    logForDebugging(
      JSON.stringify({
        type: 'stream_stats',
        model,
        total_chunks: stats.totalChunks,
        first_token_ms: stats.firstTokenMs,
        duration_ms: stats.durationMs,
      }),
      { level: 'debug' },
    )
  }

  yield { type: 'message_stop' }
  streamComplete = true
}

export { openaiStreamToAnthropic }
