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
import { useSuperTaskStore } from './useSuperTaskStore.js'

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
      lastSeqBySession: {},
      // 压缩过程态也要重置 —— 它是跨用例持存的 boolean, 不重置会让前一个用例
      // 的 compacting=true 泄漏到下一个, 断言互相干扰。
      compacting: false,
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

  it('routes task_factory.created → lastCreatedTaskId + 面板刷新', () => {
    const loadSpy = vi
      .spyOn(useSuperTaskStore.getState(), 'load')
      .mockResolvedValue(undefined as never)
    applyBatch([
      {
        type: 'task_factory', eventId: 'etf1', ts: 1, seq: 1,
        action: 'created', payload: { id: 'tf-abc' },
      },
    ])
    expect(useSuperTaskStore.getState().lastCreatedTaskId).toBe('tf-abc')
    expect(loadSpy).toHaveBeenCalled()
    loadSpy.mockRestore()
  })

  it('routes task_factory.state.changed → 同步 managed/supervisorSessionId', () => {
    const loadSpy = vi
      .spyOn(useSuperTaskStore.getState(), 'load')
      .mockResolvedValue(undefined as never)
    applyBatch([
      {
        type: 'task_factory', eventId: 'etf2', ts: 1, seq: 1,
        action: 'state.changed',
        payload: { managedEnabled: true, supervisorSessionId: 'sup-x' },
      },
    ])
    expect(useSuperTaskStore.getState().managed).toBe(true)
    expect(useSuperTaskStore.getState().supervisorSessionId).toBe('sup-x')
    loadSpy.mockRestore()
  })

  // 回归 (2026-10-12): compact_boundary 曾漏掉 applyBatchTo 的 switch case。
  // switch 原本既无 default 也无断言, 漏 case 时事件**静默穿过** —— 症状是
  // "toast 会弹(那个 case 在), 但对话流里的分隔线永远不出现"。
  // 4 个 compact 单测全绿也照样漏: 它们直接调 applyRuntimeEvent / 测
  // translator, 都没走过「EventSource 白名单 + 这个 dispatch switch」这条
  // 真实链路 —— mock 把 bug 藏住了。
  it('compact_boundary 路由到 applyRuntimeEvent 并落进 messages', () => {
    applyBatch([
      {
        type: 'compact_boundary', eventId: 'eb1', ts: 1, seq: 1,
        sessionId: 's1', trigger: 'auto', preTokens: 180000,
        messagesSummarized: 42,
      },
    ] as never)
    const msgs = useAgentStore.getState().messages
    expect(msgs).toHaveLength(1)
    expect(msgs[0]).toMatchObject({
      type: 'compact_boundary',
      trigger: 'auto',
      preTokens: 180000,
      messagesSummarized: 42,
    })
  })

  it('compact_boundary 重放(同 eventId)不重复追加 —— SSE 重连会重发同一帧', () => {
    const ev = {
      type: 'compact_boundary', eventId: 'eb-dup', ts: 1, seq: 7,
      sessionId: 's1', trigger: 'auto', preTokens: 1000,
    }
    applyBatch([ev] as never)
    applyBatch([ev] as never)
    // 分界线是纯追加事件(无 upsert 语义), 漏去重就会画出两条线。
    expect(
      useAgentStore.getState().messages.filter(
        (m) => m.type === 'compact_boundary',
      ),
    ).toHaveLength(1)
  })

  it('runtime.compacted 路由到 toast 而不是 messages', () => {
    applyBatch([
      {
        type: 'runtime.compacted', eventId: 'ec1', ts: 1, seq: 1,
        sessionId: 's1', trigger: 'auto', preTokens: 180000,
        timestamp: Date.now(),
      },
    ] as never)
    expect(useAgentStore.getState().toasts).toHaveLength(1)
    expect(
      useAgentStore.getState().messages.some(
        (m) => m.type === 'runtime.compacted',
      ),
    ).toBe(false)
  })

  it('system.stopping 路由到 applySystemEvent 并置 stopping 态 (2026-10-12 补登)', () => {
    // 此前 system.stopping 既不在白名单也不在 dispatch switch, serviceState
    // 永远停在 null。注意: 该状态目前**还没有 UI 读取**(横幅待建), 这里守
    // 的是状态层 —— 将来接横幅时这条用例就是它的地基。
    useAppStore.setState({ serviceState: null })
    applyBatch([
      { type: 'system.stopping', eventId: 'es1', ts: 1, seq: 1, deadlineMs: 5000 },
    ] as never)
    expect(useAppStore.getState().serviceState).toEqual({
      phase: 'stopping', deadlineMs: 5000,
    })
  })

  it('system.restarting 路由到 applySystemEvent 并置 restarting 态', () => {
    useAppStore.setState({ serviceState: null })
    applyBatch([
      {
        type: 'system.restarting', eventId: 'es2', ts: 1, seq: 1,
        reason: 'user_action', deadlineMs: 5000,
      },
    ] as never)
    expect(useAppStore.getState().serviceState).toEqual({
      phase: 'restarting', reason: 'user_action', deadlineMs: 5000,
    })
  })

  // 压缩过程态 (2026-10-12) 走真实链路 (applyBatchTo)。
  //
  // 数据来源是 stateBridge 推的 ServerEvent —— core 侧
  // createCompactProgressEmitter 把 vendor 的 compact_start/compact_end
  // 转成 compact.changed 走 stateChangeBus, zai stateBridge 翻译成
  // runtime.compacting。**手动与自动同源**, 都经这一个事件 type。
  it('runtime.compacting 路由到过程态 (手动/自动共用)', () => {
    applyBatch([
      {
        type: 'runtime.compacting', eventId: 'cp1', ts: 1, seq: 1,
        sessionId: 's1', compacting: true,
      },
    ] as never)
    expect(useAgentStore.getState().compacting).toBe(true)
    applyBatch([
      {
        type: 'runtime.compacting', eventId: 'cp2', ts: 2, seq: 2,
        sessionId: 's1', compacting: false,
      },
    ] as never)
    expect(useAgentStore.getState().compacting).toBe(false)
  })

  it('command.run/done **不再**驱动压缩过程态 (同源要求)', () => {
    // command.* 是 command 层通用埋点, 不反映 vendor 压缩语义 —— 此前
    // 曾用 `name === 'compact'` 近似"正在压缩", 属错误接线, 已撤除。
    // 自动压缩根本不经过 command 层, 拿它近似会让两条路径来路不同。
    applyBatch([
      {
        type: 'command.run', eventId: 'cr1', ts: 1, seq: 1,
        sessionId: 's1', commandId: 'cid1', name: 'compact',
        args: '', trigger: 'user',
      },
    ] as never)
    expect(useAgentStore.getState().compacting).toBe(false)
    applyBatch([
      {
        type: 'command.done', eventId: 'cd1', ts: 2, seq: 2,
        sessionId: 's1', commandId: 'cid1', name: 'compact',
        result: 'compacted', durationMs: 19932,
      },
    ] as never)
    expect(useAgentStore.getState().compacting).toBe(false)
  })
})
