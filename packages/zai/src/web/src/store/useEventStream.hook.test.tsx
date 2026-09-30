// @vitest-environment happy-dom

// useEventStream hook 的**连接建立**测试(applyBatch 的 dispatch 行为在
// useEventStream.test.ts 里覆盖)。
//
// 守护 2026-09-30 修复的根因:此前 `if (!sessionId) return` 让「没有活跃
// 会话」时**完全不建 EventSource**。/instances 只在 mount 时拉一次
// /api/instances,之后全靠 instance.changed 推进 —— 机器上一个会话都没有时
// (loadSessions 见 sessions.length === 0 就留 null),实例管理页会永久卡在
// 首次快照上,别的 tab 启停实例这边纹丝不动。
//
// 无 sid 时走 topics 白名单而非全量流:applyPromptAsk / applyQueueChanged
// 都不按 sid 过滤,全量会把别的会话的待确认卡片串到当前页。

import { describe, expect, it, vi, beforeEach } from 'vitest'
import { renderHook } from '@testing-library/react'
import { useEventStream } from './useEventStream.js'
import { useAgentStore } from './useAgentStore.js'

const subscribeMock = vi.hoisted(() => vi.fn(() => ({ close: vi.fn() })))
vi.mock('../lib/eventSource.js', () => ({ subscribeServerEvents: subscribeMock }))

beforeEach(() => {
  subscribeMock.mockClear()
  useAgentStore.setState({ sessionId: null })
})

describe('useEventStream 连接建立', () => {
  it('无活跃会话时仍然建立订阅 (根因回归)', () => {
    useAgentStore.setState({ sessionId: null })
    renderHook(() => useEventStream())
    expect(subscribeMock).toHaveBeenCalledTimes(1)
  })

  it('无会话时传 topics 白名单,不走全量流 (防 prompt.ask 串台)', () => {
    useAgentStore.setState({ sessionId: null })
    renderHook(() => useEventStream())
    const [, , , topics] = subscribeMock.mock.calls[0]
    expect(Array.isArray(topics)).toBe(true)
    expect(topics).toContain('instance')
    // 关键:不能收 runtime / prompt 这类会话级事件
    expect(topics).not.toContain('runtime')
    expect(topics).not.toContain('prompt')
    // queue / agent_task / state.* 在服务端 isGlobalEvent 里是 false,
    // 收进来等于让无会话页面持有别的会话的状态(漂移守护见 eventBus-topics.test.ts)
    expect(topics).not.toContain('queue')
    expect(topics).not.toContain('agent_task')
  })

  it('有活跃会话时不传 topics(维持 sid 切片原行为)', () => {
    useAgentStore.setState({ sessionId: 's1' })
    renderHook(() => useEventStream())
    const [sid, , , topics] = subscribeMock.mock.calls[0]
    expect(sid).toBe('s1')
    expect(topics).toBeUndefined()
  })

  it('sessionId 从 null 变成有值时重建订阅', () => {
    useAgentStore.setState({ sessionId: null })
    const { rerender } = renderHook(() => useEventStream())
    expect(subscribeMock).toHaveBeenCalledTimes(1)
    useAgentStore.setState({ sessionId: 's1' })
    rerender()
    expect(subscribeMock).toHaveBeenCalledTimes(2)
    expect(subscribeMock.mock.calls[1][0]).toBe('s1')
  })
})
