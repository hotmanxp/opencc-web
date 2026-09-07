/**
 * zai patch (2026-09-07, fix task-notification dup, worktree-dsh):
 * BashBackgroundTracker 的 markTaskNotified 在终态任务上不应再触发
 * 一次 50ms debounce 的 bash_task.changed —— 否则会与 markFinished
 * 的同步 emit 叠加,引发第二次事件,进而导致 zai BashNotifier 重复
 * runtime.query() (ZULU session bin925bz9 现场)。
 *
 * 回归门禁:
 *   1. markFinished → 同步 emit 一次
 *   2. 紧随其后的 markTaskNotified → 同步 emit 一次(notified: true)
 *      然后不再触发 debounce 定时器
 *   3. running 状态下的 markTaskNotified 仍走 debounce(对齐 appendOutput)
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import {
  BashBackgroundTracker,
  stateChangeBus,
  resetStateChangeBusForTests,
} from '@zn-ai/zn-agent-core'

describe('BashBackgroundTracker — markTaskNotified 终态不再触发 debounce', () => {
  let tracker: BashBackgroundTracker
  let emits: Array<unknown>

  beforeEach(() => {
    resetStateChangeBusForTests()
    tracker = new BashBackgroundTracker()
    emits = []
    stateChangeBus.on('bash_task.changed', (e) => emits.push(e))
  })

  afterEach(() => {
    tracker.__resetForTests()
    resetStateChangeBusForTests()
    vi.useRealTimers()
  })

  it('markFinished → 同步 emit 一次(回归门禁 1)', () => {
    tracker.register('t1', { sessionId: 's1', command: 'echo', description: 'd', startedAt: 1 })
    tracker.markFinished('t1', 'completed', { exitCode: 0 })
    expect(emits).toHaveLength(1)
    const ev = emits[0] as { task: { taskId: string; status: string; notified: boolean } }
    expect(ev.task.taskId).toBe('t1')
    expect(ev.task.status).toBe('completed')
    // markFinished 路径尚未 markTaskNotified, 初始 notified=false
    expect(ev.task.notified).toBe(false)
  })

  it('markFinished 紧接 markTaskNotified → 终态只再 emit 一次(回归门禁 2)', async () => {
    vi.useFakeTimers()
    tracker.register('t1', { sessionId: 's1', command: 'echo', description: 'd', startedAt: 1 })
    tracker.markFinished('t1', 'completed', { exitCode: 0 })
    expect(emits).toHaveLength(1)
    // 模拟 LocalShellTask.tsx:281-282 的调用序:markFinished 后立即
    // markTaskNotified,后者在终态上不应再启动 debounce 定时器。
    tracker.markTaskNotified('t1')
    // 同步 emit 应当已落地(notified: true)
    expect(emits).toHaveLength(2)
    const ev2 = emits[1] as { task: { taskId: string; notified: boolean } }
    expect(ev2.task.notified).toBe(true)
    // 等过 50ms debounce 窗口:不应再有新 emit
    await vi.advanceTimersByTimeAsync(100)
    expect(emits).toHaveLength(2)
  })

  it('running 状态 markTaskNotified → 仍走 debounce(回归门禁 3)', async () => {
    vi.useFakeTimers()
    tracker.register('t1', { sessionId: 's1', command: 'echo', description: 'd', startedAt: 1 })
    // 不调用 markFinished, 任务仍在 running
    tracker.markTaskNotified('t1')
    // 同步 emit 不应发生, 走 50ms debounce
    expect(emits).toHaveLength(0)
    await vi.advanceTimersByTimeAsync(60)
    expect(emits).toHaveLength(1)
    const ev = emits[0] as { task: { taskId: string; notified: boolean } }
    expect(ev.task.notified).toBe(true)
  })

  it('markFinished + markTaskNotified + 5 次 appendOutput → 总共 2 次 emit (sync 两次, debounce 一次取消)', async () => {
    vi.useFakeTimers()
    tracker.register('t1', { sessionId: 's1', command: 'echo', description: 'd', startedAt: 1 })
    // 模拟 streaming:appendOutput 走 debounce
    tracker.appendOutput('t1', { stdout: 'chunk1' })
    await vi.advanceTimersByTimeAsync(10)
    tracker.appendOutput('t1', { stdout: 'chunk2' })
    // 此时还在 debounce 窗口内 (10ms < 50ms)
    tracker.markFinished('t1', 'completed', { exitCode: 0 })
    // markFinished 同步 emit + 取消 debounce
    expect(emits.length).toBeGreaterThanOrEqual(1)
    // 跟随 markTaskNotified → 终态同步 emit
    tracker.markTaskNotified('t1')
    await vi.advanceTimersByTimeAsync(100)
    // 总 emit 数:debounce 取消后只剩 markFinished + markTaskNotified 两次
    expect(emits).toHaveLength(2)
    const statuses = emits.map((e) => (e as { task: { status: string } }).task.status)
    expect(statuses).toEqual(['completed', 'completed'])
    const notified = emits.map((e) => (e as { task: { notified: boolean } }).task.notified)
    expect(notified).toEqual([false, true])
  })
})
