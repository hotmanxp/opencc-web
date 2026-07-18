import { describe, expect, test } from 'vitest'
import { wrapWithZaiMeta, toRuntimeErrorEvent, toAbortedEvent } from '../../src/runtime/streamAdapter.js'

async function collect(gen: AsyncGenerator<any>): Promise<any[]> {
  const items: any[] = []
  for await (const item of gen) {
    items.push(item)
  }
  return items
}

describe('wrapWithZaiMeta', () => {
  test('enriches events with eventId/sessionId/ts/turnIndex', async () => {
    async function* mockStream() {
      yield { type: 'message_start', message: { id: 'm1' } }
      yield { type: 'message_stop' }
    }
    const events = await collect(wrapWithZaiMeta(mockStream(), { sessionId: 'sess-1', sessionStartTs: 1 }))
    // wrap 本身只做元数据填充, 不 yield runtime.done —— 那是 queryEngine 在 turn
    // 全部结束后统一 yield 的 (见 streamAdapter.ts 末尾注释). 这里只验证元数据.
    expect(events).toHaveLength(2)
    expect(events[0].eventId).toBeTruthy()
    expect(events[0].sessionId).toBe('sess-1')
    expect(events[0].ts).toBeGreaterThan(0)
  })
})

describe('toRuntimeErrorEvent', () => {
  test('classifies auth error', () => {
    const err = toRuntimeErrorEvent(new Error('401 Unauthorized'), { sessionId: 's1', turnIndex: 0 })
    expect(err.error.recoverable).toBe(false)
  })
})

describe('toAbortedEvent', () => {
  test('emits aborted event', () => {
    const evt = toAbortedEvent({ sessionId: 's1', turnIndex: 0 }, 'user cancelled')
    expect(evt.type).toBe('runtime.aborted')
    expect(evt.reason).toBe('user cancelled')
  })
})
