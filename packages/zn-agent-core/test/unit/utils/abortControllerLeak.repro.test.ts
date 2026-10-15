/**
 * MaxListenersExceededWarning: Possible EventTarget memory leak detected.
 * N abort listeners added to [AbortSignal]。
 *
 * 机制：query() 每次新建一个 createAbortController()(阈值 50)当 per-query
 * controller,StreamingToolExecutor 每个 turn 都以它为 parent 建一个
 * createChildAbortController(兄弟 controller),per-tool 再从兄弟 controller
 * 派生一层。旧实现每个 child 往 parent.signal 上 addEventListener 一个
 * { once: true } handler,且只有 child 自己被 abort 时才摘 —— 正常跑完的
 * turn 既不 abort 兄弟 controller 也不 abort per-tool controller,于是同一个
 * query 的 controller 上线性堆积,第 51 个触发警告。
 *
 * 现实现:每个 parent 只挂 1 个共享 listener,内部用 WeakRef 集合跟踪所有
 * child。所以不变量从"child 数个 listener"变成"恒定 1 个"。
 */
import { describe, it, expect } from 'vitest'
import { getEventListeners } from 'events'
import {
  createAbortController,
  createChildAbortController,
} from '../../../src/opencc-src/utils/abortController.js'

/**
 * 模拟 query 的 turn 循环:每轮 new 一个 StreamingToolExecutor(兄弟
 * controller = child(queryController)),该轮每个 tool 再派生一层。
 */
function simulateTurns(queryController: AbortController, toolsPerTurn = 2): void {
  for (let turn = 0; turn < 60; turn++) {
    const sibling = createChildAbortController(queryController)
    for (let tool = 0; tool < toolsPerTurn; tool++) {
      createChildAbortController(sibling)
    }
  }
}

describe('createChildAbortController 不在 parent 上累积 listener', () => {
  it('60 轮 turn × 2 tool → query controller 上恒定 1 个 listener', () => {
    const controller = createAbortController()
    simulateTurns(controller)

    // 关键断言:listener 数与 child 数解耦,不再越过 50 阈值。
    expect(getEventListeners(controller.signal, 'abort').length).toBe(1)
  })

  it('parent abort → 所有层级的 child 都被 abort 并带上 parent 的 reason', () => {
    const queryController = createAbortController()
    const sibling = createChildAbortController(queryController)
    const tool = createChildAbortController(sibling)
    const grandTool = createChildAbortController(tool)

    queryController.abort('query_finished')

    for (const child of [sibling, tool, grandTool]) {
      expect(child.signal.aborted).toBe(true)
      expect(child.signal.reason).toBe('query_finished')
    }
    // { once: true } → 触发后共享 listener 自行摘除
    expect(getEventListeners(queryController.signal, 'abort').length).toBe(0)
  })

  it('单个 child 提前 abort 不影响 parent 及其兄弟 child', () => {
    const parent = createAbortController()
    const childA = createChildAbortController(parent)
    const childB = createChildAbortController(parent)

    childA.abort('tool_finished')

    expect(parent.signal.aborted).toBe(false)
    expect(childB.signal.aborted).toBe(false)
    // parent 的共享 listener 仍在,后续 child 仍能被传播
    expect(getEventListeners(parent.signal, 'abort').length).toBe(1)

    parent.abort('parent_done')
    expect(childB.signal.reason).toBe('parent_done')
  })

  it('parent 已 aborted → child 立即 aborted,parent 不新增 listener', () => {
    const parent = createAbortController()
    parent.abort('already_done')

    const child = createChildAbortController(parent)

    expect(child.signal.aborted).toBe(true)
    expect(child.signal.reason).toBe('already_done')
    expect(getEventListeners(parent.signal, 'abort').length).toBe(0)
  })

  it('child 只被 WeakRef 持有 → 不会被 parent 强引用住(可被 GC)', () => {
    const parent = createAbortController()
    createChildAbortController(parent)
    createChildAbortController(parent)
    // 不 abort,也不持有 child 引用 —— WeakRef 保证它们可回收,
    // parent 上依旧只有 1 个 listener。
    expect(getEventListeners(parent.signal, 'abort').length).toBe(1)
  })

  it('WeakRef 集合不会无限增长(超过阈值时清理已回收的条目)', () => {
    const parent = createAbortController()
    // 建 200 个 child,大部分立刻被 abort(释放工具执行上下文)。
    for (let i = 0; i < 200; i++) {
      createChildAbortController(parent).abort('tool_finished')
    }
    // 关键行为:parent 的 listener 数不随 child 数增长。
    expect(getEventListeners(parent.signal, 'abort').length).toBe(1)
  })
})
