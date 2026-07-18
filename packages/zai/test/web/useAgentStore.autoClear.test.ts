// packages/zai/test/web/useAgentStore.autoClear.test.ts
// @vitest-environment happy-dom
//
// 修复目标: 当某个 sid 的 todos + v2 tasks 全部 completed / deleted,
// 5 秒后自动从 store 清掉, 让 UI 不再展示已完成的任务列表. 中途若有
// 新任务/回到 pending/in_progress, 取消清空.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { useAgentStore, type TodoItem, type V2TaskItem } from '../../src/web/src/store/useAgentStore.js'

const todo = (content: string, status: TodoItem['status']): TodoItem => ({
  content,
  status,
  activeForm: content,
})

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
    todosBySession: {},
    v2TasksBySession: {},
  })
})

afterEach(() => {
  vi.useRealTimers()
})

describe('useAgentStore — 任务全部完成 5s 后自动清空', () => {
  it('todos 全部 completed 后 5s, todosBySession[sid] 被清空', () => {
    useAgentStore.getState().setTodos('sess-1', [
      todo('A', 'completed'),
      todo('B', 'completed'),
    ])
    // 立即: 仍在
    expect(useAgentStore.getState().todosBySession['sess-1']).toHaveLength(2)
    // 4s: 仍应存在
    vi.advanceTimersByTime(4000)
    expect(useAgentStore.getState().todosBySession['sess-1']).toHaveLength(2)
    // 5s: 清掉
    vi.advanceTimersByTime(1000)
    expect(useAgentStore.getState().todosBySession['sess-1']).toBeUndefined()
  })

  it('有 pending/in_progress 时不触发自动清空', () => {
    useAgentStore.getState().setTodos('sess-1', [
      todo('A', 'completed'),
      todo('B', 'pending'),
    ])
    vi.advanceTimersByTime(10_000)
    expect(useAgentStore.getState().todosBySession['sess-1']).toHaveLength(2)
  })

  it('5s 内重新写入包含未完成任务 → 取消清空 timer', () => {
    useAgentStore.getState().setTodos('sess-1', [
      todo('A', 'completed'),
      todo('B', 'completed'),
    ])
    vi.advanceTimersByTime(2000)
    // 2s 后又加了一个 pending → 取消 timer
    useAgentStore.getState().setTodos('sess-1', [
      todo('A', 'completed'),
      todo('B', 'in_progress'),
    ])
    // 再过 5s 也不应清掉
    vi.advanceTimersByTime(10_000)
    expect(useAgentStore.getState().todosBySession['sess-1']).toHaveLength(2)
  })

  it('v2 tasks 全部 completed + deleted 后 5s 自动清空', () => {
    useAgentStore.getState().setV2Tasks('sess-1', [
      v2('v1', 'completed'),
      v2('v2', 'deleted'),
    ])
    expect(useAgentStore.getState().v2TasksBySession['sess-1']).toHaveLength(2)
    vi.advanceTimersByTime(5000)
    expect(useAgentStore.getState().v2TasksBySession['sess-1']).toBeUndefined()
  })

  it('只清当前全完成的 sid, 其他 sid 保留', () => {
    useAgentStore.getState().setTodos('sess-1', [todo('A', 'completed')])
    useAgentStore.getState().setTodos('sess-2', [todo('B', 'pending')])
    vi.advanceTimersByTime(5000)
    expect(useAgentStore.getState().todosBySession['sess-1']).toBeUndefined()
    expect(useAgentStore.getState().todosBySession['sess-2']).toHaveLength(1)
  })
})