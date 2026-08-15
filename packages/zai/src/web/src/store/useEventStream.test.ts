// useEventStream 批量 dispatch 测试。
//
// 验证 applyBatch (从 dispatch switch 重构出的批量 dispatcher) 的行为:
// - 同 tick 多次 enqueue 合并成一次 microtask flush
// - batch 内按 seq 排序后应用 (乱序输入 → 顺序输出)
// - server.connected → connected 态 + hydrate
// - stream/error → error 态
// - state.* / queue.changed 路由到对应 reducer
//
// 连接状态机本身 (onState 回调) 由 eventSource.test.ts 覆盖; useAppStore 的
// streamState 字段写入由本文件 + useAppStore.test.ts 覆盖。

import { describe, expect, it, vi, beforeEach } from 'vitest'
import { applyBatch, enqueue } from './useEventStream.js'
import { useAgentStore } from './useAgentStore.js'
import { useAppStore } from './useAppStore.js'

function delta(seq: number, text: string) {
  return {
    type: 'runtime.delta' as const,
    eventId: `e${seq}`,
    ts: seq,
    seq,
    sessionId: 's1',
    turnIndex: 0,
    delta: text,
  }
}

describe('useEventStream batch dispatch', () => {
  beforeEach(() => {
    useAgentStore.setState({
      sessionId: 's1',
      messages: [],
      sendSeq: 0,
      textSegmentRev: 0,
      segmentedToolUseIds: {},
      queuedPrompts: [],
    })
    useAppStore.setState({ connected: false, streamState: 'connecting', streamAttempt: 0 })
  })

  it('applies batch events in seq order within one flush', () => {
    applyBatch([delta(3, 'c'), delta(1, 'a'), delta(2, 'b')])
    const msgs = useAgentStore.getState().messages
    // 三条 delta 同 (sendSeq, turnIndex, textSegmentRev, blockIndex, kind) key
    // → 合并进同一个 text block, 按 seq 排序后文本为 'abc' (乱序输入验证排序)。
    expect(msgs).toHaveLength(1)
    expect((msgs[0] as { text: string }).text).toBe('abc')
  })

  it('coalesces same-tick enqueues into a single microtask flush', async () => {
    enqueue(delta(1, 'a'))
    enqueue(delta(2, 'b'))
    enqueue(delta(3, 'c'))
    // 同步检查: microtask 尚未 flush
    expect(useAgentStore.getState().messages).toHaveLength(0)
    await Promise.resolve()
    const msgs = useAgentStore.getState().messages
    expect(msgs).toHaveLength(1)
    expect((msgs[0] as { text: string }).text).toBe('abc')
  })

  it('routes server.connected to connected state + hydrate', () => {
    const hydrate = vi
      .spyOn(useAgentStore.getState(), 'hydrateSessionState')
      .mockResolvedValue(undefined as never)
    applyBatch([
      { type: 'server.connected', eventId: 'e', ts: 1, seq: 1, sessionId: null },
    ])
    expect(useAppStore.getState().connected).toBe(true)
    expect(useAppStore.getState().streamState).toBe('connected')
    expect(hydrate).toHaveBeenCalledWith('s1')
    hydrate.mockRestore()
  })

  it('routes stream/error to error stream state', () => {
    applyBatch([{
      type: 'stream/error',
      eventId: 'e',
      ts: 1,
      seq: 1,
      error: { code: 'internal', message: 'boom', details: {} },
    }])
    expect(useAppStore.getState().streamState).toBe('error')
  })

  it('routes state.* and queue.changed events to their reducers', () => {
    applyBatch([
      {
        type: 'cwd.changed', eventId: 'e1', ts: 1, seq: 1,
        sessionId: 's1', cwd: '/tmp', updatedAt: 1,
      },
      {
        type: 'queue.changed', eventId: 'e2', ts: 2, seq: 2,
        sessionId: 's1', running: true, queueLength: 1,
        pending: [{ id: 'q1', text: 'x' }],
      },
    ])
    expect(useAgentStore.getState().cwdBySession['s1']).toBe('/tmp')
    expect(useAgentStore.getState().queuedPrompts).toEqual([{ id: 'q1', text: 'x' }])
  })
})
