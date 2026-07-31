// packages/zai/test/web/useAgentStore.autoClear.test.ts
// @vitest-environment happy-dom
//
// 修复目标: 当某个 sid 的 v2 tasks 全部 completed / deleted,
// 5 秒后自动从 store 清掉, 让 UI 不再展示已完成的任务列表. 中途若有
// 新任务/回到 pending/in_progress, 取消清空.
// 2026-07-31: 老 todosBySession 已 refactor 删除, 该测试只剩 v2 部分.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { useAgentStore, type V2TaskItem } from '../../src/web/src/store/useAgentStore.js'

const v2 = (id: string, status: V2TaskItem['status']): V2TaskItem => ({
  id,
  subject: id,
  status,
  blocks: [],
  blockedBy: [],
  updatedAt: 1,
})

beforeEach(() => {
  vi.useFakeTimers()
  useAgentStore.setState({
    sessionId: 'sess-1',
    messages: [],
    textSegmentRev: 0,
    segmentedToolUseIds: {},
    sendSeq: 0,
    v2TasksBySession: {},
  })
})

afterEach(() => {
  vi.useRealTimers()
})

describe('useAgentStore — v2 任务全部完成 5s 后自动清空', () => {
  it('v2 tasks 全部 completed + deleted 后 5s 自动清空', () => {
    useAgentStore.getState().setV2Tasks('sess-1', [
      v2('v1', 'completed'),
      v2('v2', 'deleted'),
    ])
    expect(useAgentStore.getState().v2TasksBySession['sess-1']).toHaveLength(2)
    vi.advanceTimersByTime(5000)
    expect(useAgentStore.getState().v2TasksBySession['sess-1']).toBeUndefined()
  })

  it('v2 有 pending/in_progress 时不触发自动清空', () => {
    useAgentStore.getState().setV2Tasks('sess-1', [
      v2('v1', 'completed'),
      v2('v2', 'pending'),
    ])
    vi.advanceTimersByTime(10_000)
    expect(useAgentStore.getState().v2TasksBySession['sess-1']).toHaveLength(2)
  })

  it('5s 内重新写入包含未完成 v2 任务 → 取消清空 timer', () => {
    useAgentStore.getState().setV2Tasks('sess-1', [
      v2('v1', 'completed'),
      v2('v2', 'completed'),
    ])
    vi.advanceTimersByTime(2000)
    // 2s 后又加了一个 in_progress → 取消 timer
    useAgentStore.getState().setV2Tasks('sess-1', [
      v2('v1', 'completed'),
      v2('v2', 'in_progress'),
    ])
    // 再过 5s 也不应清掉
    vi.advanceTimersByTime(10_000)
    expect(useAgentStore.getState().v2TasksBySession['sess-1']).toHaveLength(2)
  })

  it('只清当前全完成的 sid, 其他 sid 保留', () => {
    useAgentStore.getState().setV2Tasks('sess-1', [v2('v1', 'completed')])
    useAgentStore.getState().setV2Tasks('sess-2', [v2('v2', 'pending')])
    vi.advanceTimersByTime(5000)
    expect(useAgentStore.getState().v2TasksBySession['sess-1']).toBeUndefined()
    expect(useAgentStore.getState().v2TasksBySession['sess-2']).toHaveLength(1)
  })
})
