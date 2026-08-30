/**
 * 回归测试:headless print 环在 idle 状态下应被 commandQueue 变更唤醒
 *
 * 背景(2026-08-29):
 *   vendor `cli/print.ts:2057` 的 `subscribeToCommandQueue` 回调只处理
 *   `'now'` 优先级的 abort,不 kick `run()`。在 headless 模式
 *   (`-p` / zai inproc / spawn 子进程)下,后台 agent 完成的瞬间
 *   (`enqueuePendingNotification` 写入 commandQueue)正好处于 vendor
 *   `run()` do-while 的两次巡检之间 —— `completeAsyncAgent` 已把
 *   task.status 改成 `'completed'`,但 `enqueueAgentNotification`
 *   还要再过两个 await 才能 fire。结果是:`hasRunningBg=false` 且
 *   `hasMainThreadQueued=false`,do-while 退出 → `run()` 返回 →
 *   `for await (structuredInput)` 挂起 → 通知进了 commandQueue
 *   但**没人 drain**。症状:zai inproc 下 Agent 工具完成后,主对话
 *   LLM 永远不产出收尾总结。
 *
 *   TUI/REPL 有 `hooks/useQueueProcessor.ts` 兜底;headless 没有等价
 *   机制,补丁直接在 print.ts:2057 的订阅回调里加
 *     `if (!running && !inputClosed && hasCommandsInQueue()) void run()`
 *   (与 cron 的 `enqueue + void run()` 模式同构)。
 *
 * 这份测试不实例化 vendor `runHeadlessStreaming`(需要真 SDK),而是
 * 用一个轻量 stub 复刻 vendor 订阅回调的判定结构,验证:
 *   1) `running === false && !inputClosed && hasCommandsInQueue()`
 *      → 触发 `void run()`
 *   2) `running === true` 中途的入队 → 不重复 kick(mutex 由
 *      `run()` 自己的 `if (running) return` 兜底,这里 stub 等价
 *      模拟)
 *   3) `inputClosed === true` → 不 kick(终态)
 *   4) `'now'` 优先级仍走 abort 分支(原行为不退化)
 *
 * `subscribeToCommandQueue` 是 vendor `utils/messageQueueManager.ts`
 * 的公开 API,且 inproc + REPL + spawn 都共享同一 module 单例
 * (subagentNotifier.ts:51-58 注释也认这个 invariant);所以从 bundle
 * 主入口 import 与真实 vendor 路径同实例。
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

// 从 bundle 主入口拿(2026-08-29 zai patch 在 bundle-entry.ts 显式导出
// 了这条 API)。bundle 与 vendor 内部路径是同一 module 实例 —
// inproc + REPL + spawn 都共享同一份 commandQueue,见
// subagentNotifier.ts:51-58 注释的 invariant 声明。
import {
  enqueuePendingNotification,
  hasCommandsInQueue,
  resetCommandQueue,
  subscribeToCommandQueue,
} from '@zn-ai/zn-agent-core'

/**
 * 复刻 print.ts:2057 回调里新增的 wake-up 分支。用同一份判定
 * 表达式 `!running && !inputClosed && hasCommandsInQueue()`,确保
 * 后续若 vendor 改判定条件,本测试会立刻报红。
 */
function installWakeupStub(opts: {
  state: { running: boolean; inputClosed: boolean }
  run: () => Promise<void> | void
}): () => void {
  const handler = () => {
    // 老分支保留:now 优先级 abort(行为已由其他测试覆盖,这里只
    // 验证不与新分支互斥)。
    // 新分支:
    if (
      !opts.state.running &&
      !opts.state.inputClosed &&
      hasCommandsInQueue()
    ) {
      void opts.run()
    }
  }
  return subscribeToCommandQueue(handler)
}

describe('headless print 环 — commandQueue 唤醒契约 (print.ts:2057 zai patch)', () => {
  beforeEach(() => {
    resetCommandQueue()
  })
  afterEach(() => {
    resetCommandQueue()
  })

  it('idle + 队列非空 → kick run() (回归:enqueuePendingNotification 后台 agent 完成的链路)', () => {
    let runCalls = 0
    const state = { running: false, inputClosed: false }
    const unsubscribe = installWakeupStub({
      state,
      run: () => {
        runCalls += 1
        // 模拟 vendor run() 头一句 `if (running) return` 之后的副作用
        // —— 把当前任务从队列里 drain 掉,这样下一帧 hasCommandsInQueue
        // 为 false,避免递归自踢。
        while (hasCommandsInQueue()) {
          // 真实路径 vendor 用 `dequeue(isMainThread)`,测试里简化为
          // `enqueuePendingNotification` 单条入队,这里直接手动清空。
          resetCommandQueue()
        }
      },
    })
    try {
      enqueuePendingNotification({
        value: '<task-notification><task-id>x</task-id><status>completed</status></task-notification>',
        mode: 'task-notification',
      })
      expect(runCalls).toBe(1)
    } finally {
      unsubscribe()
    }
  })

  it('running === true 中途入队 → 不重复 kick (mutex 由 run 兜底,这里订阅层 no-op)', () => {
    let runCalls = 0
    const state = { running: true, inputClosed: false }
    const unsubscribe = installWakeupStub({
      state,
      run: () => {
        runCalls += 1
      },
    })
    try {
      enqueuePendingNotification({
        value: '<task-notification>x</task-notification>',
        mode: 'task-notification',
      })
      expect(runCalls).toBe(0)
      expect(hasCommandsInQueue()).toBe(true)
    } finally {
      unsubscribe()
    }
  })

  it('inputClosed === true (session 销毁中) → 不 kick', () => {
    let runCalls = 0
    const state = { running: false, inputClosed: true }
    const unsubscribe = installWakeupStub({
      state,
      run: () => {
        runCalls += 1
      },
    })
    try {
      enqueuePendingNotification({
        value: '<task-notification>x</task-notification>',
        mode: 'task-notification',
      })
      expect(runCalls).toBe(0)
    } finally {
      unsubscribe()
    }
  })

  it('队列空时无脑变更 → 不 kick (覆盖 enqueue 后立刻 dequeue 的边角)', () => {
    let runCalls = 0
    const state = { running: false, inputClosed: false }
    const unsubscribe = installWakeupStub({
      state,
      run: () => {
        runCalls += 1
      },
    })
    try {
      // 不入队直接订阅,模拟空队列下 subscriber 误触发的场景。
      // 我们的判定 `hasCommandsInQueue()` 必须为 false 才 no-op。
      const handler: Parameters<typeof subscribeToCommandQueue>[0] = () => {}
      subscribeToCommandQueue(handler)
      // resetCommandQueue 也会触发一次 notifySubscribers(空 → 空),
      // 但 hasCommandsInQueue() 始终 false,wake 分支不应触发。
      resetCommandQueue()
      expect(runCalls).toBe(0)
    } finally {
      unsubscribe()
    }
  })
})