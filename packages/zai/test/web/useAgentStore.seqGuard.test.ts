// packages/zai/test/web/useAgentStore.seqGuard.test.ts
//
// H2 — SSE 断点续传的两处断裂 (docs/bugs/fix-plan-10-05.md)
//
// 断裂 1:seq 是**进程内**计数器(eventBus `seqCounter`,重启后从 0 重数),
// 而客户端 `lastSeqBySession` 高水位守卫(`guardSeq <= prev` 就丢弃)全仓
// 原本没有任何重置路径 → 服务端重启后所有新事件被当旧事件丢弃,页面 spinner
// 转、文本空白、静默无提示(重启路径不刷新页面)。
// 修法:server.connected 带 bootId,客户端见到新 bootId 就清空高水位。
//
// 断裂 2:SSE `id:` 原本发的是数字型 seq,而服务端断点续传按 eventId 匹配 →
// 100% miss,每次重连都退化成全量重放。(在 server/services/sse.ts 的单测侧验证。)

import { describe, it, expect, beforeEach } from 'vitest'
import { useAgentStore } from '../../src/web/src/store/useAgentStore.js'

function toolEvent(seq: number, toolUseId: string) {
  return {
    eventId: `e-${seq}`,
    sessionId: 'sess-1',
    ts: seq,
    turnIndex: 0,
    seq,
    type: 'tool_use:start',
    toolUseId,
    name: 'Bash',
    input: { cmd: `echo ${seq}` },
  } as any
}

describe('useAgentStore seq 高水位守卫 (H2 断裂 1)', () => {
  beforeEach(() => {
    useAgentStore.setState({
      sessionId: 'sess-1',
      messages: [],
      lastSeqBySession: {},
      serverBootId: null,
    })
  })

  it('同一进程内:seq 单调递增,低 seq 事件被当重放丢弃', () => {
    const state = useAgentStore.getState()
    state.upsertToolCall(toolEvent(1, 't1'))
    state.upsertToolCall(toolEvent(5, 't5'))
    expect(useAgentStore.getState().lastSeqBySession['sess-1']).toBe(5)
    // seq 3 < 高水位 5 → 丢弃
    state.upsertToolCall(toolEvent(3, 't3'))
    const ids = useAgentStore.getState().messages.map((m: any) => m.toolUseId)
    expect(ids).toContain('t1')
    expect(ids).toContain('t5')
    expect(ids).not.toContain('t3')
  })

  it('服务端重启(seq 归零)后见到新 bootId,新事件不再被丢弃', () => {
    const state = useAgentStore.getState()
    state.upsertToolCall(toolEvent(500, 'before-restart'))
    expect(useAgentStore.getState().lastSeqBySession['sess-1']).toBe(500)

    // SSE 重连 → server.connected 带新 bootId
    useAgentStore.getState().noteServerBootId('boot-1')
    expect(useAgentStore.getState().lastSeqBySession).toEqual({})

    // 重启后的 seq 从 1 重新计数
    useAgentStore.getState().upsertToolCall(toolEvent(1, 'after-restart'))
    const ids = useAgentStore.getState().messages.map((m: any) => m.toolUseId)
    expect(ids).toContain('after-restart')
  })

  it('同一个 bootId 重复上报不清空高水位(避免同进程内重连丢事件)', () => {
    // 先把 boot-1 确立为基线(首连时序),再喂事件
    useAgentStore.getState().noteServerBootId('boot-1')
    const state = useAgentStore.getState()
    state.upsertToolCall(toolEvent(7, 't7'))
    // 同进程内的 SSE 重连会再次推 server.connected(同一个 bootId)
    useAgentStore.getState().noteServerBootId('boot-1')
    useAgentStore.getState().noteServerBootId('boot-1')
    expect(useAgentStore.getState().lastSeqBySession['sess-1']).toBe(7)
  })

  it('老服务端不发 bootId 时保持原高水位(不误清)', () => {
    const state = useAgentStore.getState()
    state.upsertToolCall(toolEvent(9, 't9'))
    useAgentStore.getState().noteServerBootId(undefined)
    expect(useAgentStore.getState().lastSeqBySession['sess-1']).toBe(9)
  })

  it('setCurrentSession / clearMessages 重置 seq 高水位', () => {
    const state = useAgentStore.getState()
    state.upsertToolCall(toolEvent(42, 't42'))
    expect(useAgentStore.getState().lastSeqBySession['sess-1']).toBe(42)
    useAgentStore.getState().setCurrentSession('sess-2')
    expect(useAgentStore.getState().lastSeqBySession).toEqual({})
  })
})
