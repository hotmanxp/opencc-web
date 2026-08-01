import { describe, expect, it, vi } from 'vitest'
import { buildOpenccQueryParams } from '../../../src/compat/runtime/buildOpenccQueryParams.js'
import type { QueryOptions } from '../../../src/compat/runtime/types.js'

// 回归测试: zai 的 `translateCallModel` (buildOpenccQueryParams.ts:319+) 在
// 消费 Anthropic 流式事件时, 必须逐个 yield `{type:'stream_event', event:<raw>}`
// wrapper, 而不是只 yield 终态 `assistant` Message.
//
// 端到端流: zai ModelCaller → translateCallModel → opencc queryLoop →
// openccQueryBridge → sdkEventAdapter(stream_event 分支 line 85-139) →
// translateRuntimeEvents → runtime.delta(text_delta) → 前端 upsertStreamBlock.
//
// 如果只 yield 终态 assistant 消息, sdkEventAdapter.ts:197-205 会合成一个
// content_block_delta 包含整段文本, 前端一次性收齐全部 runtime.delta, 失去
// 流式效果。注释见 buildOpenccQueryParams.ts:319-329。

const minimalOpts: QueryOptions = {
  prompt: { role: 'user', content: 'hi' },
  cwd: '/tmp',
  model: 'm',
  tools: [],
  sessionId: 's-stream',
}

describe('buildOpenccQueryParams — translateCallModel stream yield', () => {
  it('yields stream_event wrappers per Anthropic primitive + final assistant Message at message_stop', async () => {
    async function* fakeZaiStream() {
      yield { type: 'message_start', message: { id: 'm1', model: 'm' } }
      yield {
        type: 'content_block_start',
        index: 0,
        content_block: { type: 'text', text: '' },
      }
      yield {
        type: 'content_block_delta',
        index: 0,
        delta: { type: 'text_delta', text: '你' },
      }
      yield {
        type: 'content_block_delta',
        index: 0,
        delta: { type: 'text_delta', text: '好' },
      }
      yield { type: 'content_block_stop', index: 0 }
      yield { type: 'message_delta', delta: { stop_reason: 'end_turn' } }
      yield { type: 'message_stop' }
    }
    const modelCaller = vi.fn().mockReturnValue(fakeZaiStream())

    const params = await buildOpenccQueryParams(minimalOpts, {
      modelCaller: modelCaller as any,
    })

    const events: any[] = []
    for await (const ev of params.deps!.callModel({
      messages: [{ role: 'user', content: 'hi' }],
      systemPrompt: '',
      tools: [],
      signal: new AbortController().signal,
      options: { model: 'm' },
    } as any) as AsyncIterable<any>) {
      events.push(ev)
    }

    // Expect 7 stream_event wrappers (one per Anthropic primitive)
    // + 1 terminal assistant Message at message_stop.
    const streamEvents = events.filter((e) => e?.type === 'stream_event')
    const assistantMessages = events.filter((e) => e?.type === 'assistant')

    expect(streamEvents).toHaveLength(7)
    expect(assistantMessages).toHaveLength(1)

    // First stream_event wraps message_start (raw event type leaks through)
    expect(streamEvents[0].event.type).toBe('message_start')
    // Two text_delta stream_events in chronological order
    const textDeltas = streamEvents
      .map((e) => e.event)
      .filter((raw) => raw.type === 'content_block_delta' && raw.delta?.type === 'text_delta')
    expect(textDeltas).toHaveLength(2)
    expect(textDeltas[0].delta.text).toBe('你')
    expect(textDeltas[1].delta.text).toBe('好')

    // Final assistant Message holds the assembled text
    const final = assistantMessages[0]
    expect(final.message.content).toHaveLength(1)
    expect(final.message.content[0]).toEqual({ type: 'text', text: '你好' })
    expect(final.message.stop_reason).toBe('end_turn')
  }, 30_000)
})