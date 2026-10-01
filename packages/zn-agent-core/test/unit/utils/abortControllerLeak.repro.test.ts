/**
 * 复现 MaxListenersExceededWarning: Possible EventTarget memory leak
 * detected. N abort listeners added to [AbortSignal]。
 *
 * 机制(createOpenccRuntime-impl.ts:835 + QueryEngine.replaceAbortController):
 * 每次 query() 新建一个 createAbortController()(阈值 50)并塞进 per-session
 * 缓存复用的 QueryEngine。本 query 正常跑完不会 abort,所以挂在该 signal
 * 上的 { once: true } listener 永远不会被清掉。StreamingToolExecutor 在
 * query.ts 的 turn 循环里每轮 new 一个,每轮又给 toolUseContext.abortController
 * 挂一个 createChildAbortController 的 parent listener —— 该 listener 只在
 * child 被 abort 时才摘除,而 child 同样不会 abort。
 *
 * 本测试只验证 listener 计数行为,不依赖完整 runtime 启动。
 */
import { describe, it, expect } from 'vitest'
import { getEventListeners } from 'events'
import {
  createAbortController,
  createChildAbortController,
} from '../../../src/opencc-src/utils/abortController.js'

/** 模拟 StreamingToolExecutor 构造函数(query.ts:1129)在每轮 turn 的行为。 */
function simulateOneTurn(queryController: AbortController): void {
  // StreamingToolExecutor 构造:siblingAbortController = child(queryController)
  // 该 child 永不 abort,所以它在 parent 上挂的 listener 也永不摘除。
  createChildAbortController(queryController)
  // 每个 tool:toolAbortController = child(siblingAbortController)
  // 这里只需要 parent(queryController) 上那一个 listener 来演示累积。
}

describe('AbortSignal listener 累积复现', () => {
  it('单次 query 内 N 轮 turn → querySignal 上 N 个 listener 且从不回收', () => {
    const controller = createAbortController()
    const TURNS = 60

    for (let i = 0; i < TURNS; i++) simulateOneTurn(controller)

    const listeners = getEventListeners(controller.signal, 'abort')
    // 关键断言:query 正常跑完(不 abort)后 listener 全部滞留。
    expect(listeners.length).toBe(TURNS)
  })

  it('阈值 50 的 createAbortController 在第 51 个 listener 处触发警告', async () => {
    // 注意:Node 在超过阈值的**那一刻**同步 emit,而不是等到下一个 tick。
    // 这里不能靠 process.on('warning') 捕获 —— vitest 运行时 warning 已经
    // 打过一次(stderr 里可见,与线上一致的 "51 abort listeners added to
    // [AbortSignal]. MaxListeners is 50."),自己的 handler 挂晚了。
    // 因此改为直接断言 listener 计数越过阈值,警告文本的复现由 stderr 佐证。
    const controller = createAbortController()
    for (let i = 0; i < 60; i++) simulateOneTurn(controller)

    expect(getEventListeners(controller.signal, 'abort').length).toBeGreaterThan(50)
  })

  it('对照:child 被 abort 时 parent listener 确实会被摘除(机制本身没坏)', () => {
    const parent = createAbortController()
    const child = createChildAbortController(parent)
    expect(getEventListeners(parent.signal, 'abort').length).toBe(1)

    child.abort('tool_finished')
    expect(getEventListeners(parent.signal, 'abort').length).toBe(0)
  })

  it('修复验证:query 结束时 abort 旧 controller → listener 全部清零', () => {
    // 模拟 createOpenccRuntime-impl.ts 的修复形态:query finally 里 abort
    // 本轮 controller,而不是只从 map 里 delete。
    const queryController = createAbortController()
    for (let i = 0; i < 60; i++) simulateOneTurn(queryController)
    expect(getEventListeners(queryController.signal, 'abort').length).toBe(60)

    // 修复点:query 收尾时 abort,触发所有 { once: true } listener 集中清场。
    queryController.abort('query_finished')

    expect(getEventListeners(queryController.signal, 'abort').length).toBe(0)
  })
})
