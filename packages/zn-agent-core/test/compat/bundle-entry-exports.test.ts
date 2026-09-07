/**
 * bundle-entry exposure test (zai patch 2026-09-07, fix-busy-flush-v2-r2,
 * worktree-dsh, Item D).
 *
 * 验证主入口 `@zn-ai/zn-agent-core` 暴露的 vendor `messageQueueManager`
 * capability 都能从主入口调到, 不绕过 bundle 单实例 invariant。
 *
 * 设计意图: vendor `commandQueue` 是 module-level 单例, zai-server 入口层
 * (busyFlush 等) 必须从 bundle 入口拿, 否则两套 module 实例会让 commandQueue
 * 不共享。本测试不锁实现, 只锁"主入口能调到每个暴露函数"。
 *
 * 实现注意: 这里 import '@zn-ai/zn-agent-core' 而非 'src/bundle-entry.js',
 * 走 dist/opencc-core.mjs bundle (esbuild 单文件), 不触发源码路径加载
 * BashTool 等 vendor 重型模块 —— 那样会在 vitest 解析阶段
 * `getMaxTimeoutMs is not a function`。bundle 已预编译, 单实例 invariant
 * 由 esbuild 保证, 与生产 zai-server 消费方式一致。
 */
import { describe, test, expect, beforeEach } from 'vitest'
import {
  enqueue,
  enqueuePendingNotification,
  dequeue,
  dequeueAllMatching,
  peek,
  getCommandQueue,
  getCommandQueueLength,
  getCommandQueueSnapshot,
  hasCommandsInQueue,
  resetCommandQueue,
  clearCommandQueue,
  remove,
  removeByFilter,
  getCommandsByMaxPriority,
  recheckCommandQueue,
  isSlashCommand,
  subscribeToCommandQueue,
  type QueuedCommand,
} from '@zn-ai/zn-agent-core'

function makeCmd(value: string, mode: QueuedCommand['mode'] = 'prompt'): QueuedCommand {
  return { value, mode, uuid: `uuid-${Math.random()}` }
}

beforeEach(() => {
  resetCommandQueue()
})

describe('bundle-entry: messageQueueManager 暴露粒度 (Item D)', () => {
  test('write 入口: enqueue / enqueuePendingNotification', () => {
    enqueue(makeCmd('user-prompt'))
    enqueuePendingNotification(makeCmd('notif', 'task-notification'))
    expect(getCommandQueueLength()).toBe(2)
  })

  test('read 入口: getCommandQueue / getCommandQueueLength / getCommandQueueSnapshot / hasCommandsInQueue', () => {
    enqueue(makeCmd('a'))
    enqueue(makeCmd('b'))
    const arr = getCommandQueue()
    expect(arr.length).toBe(2)
    expect(arr.map((c) => c.value)).toEqual(['a', 'b'])
    const snapshot = getCommandQueueSnapshot()
    expect(snapshot.length).toBe(2)
    expect(snapshot).toEqual(arr)
    expect(getCommandQueueLength()).toBe(2)
    expect(hasCommandsInQueue()).toBe(true)
  })

  test('dequeue (单条 highest-priority)', () => {
    enqueuePendingNotification(makeCmd('later-1', 'task-notification'))
    enqueuePendingNotification(makeCmd('later-2', 'task-notification'))
    enqueue(makeCmd('next-1'))
    enqueue({ ...makeCmd('now-1'), priority: 'now' })
    const cmd = dequeue()
    expect(cmd?.priority).toBe('now')
    expect(getCommandQueueLength()).toBe(3)
  })

  test('dequeueAllMatching (predicate 路由)', () => {
    enqueuePendingNotification(makeCmd('notif', 'task-notification'))
    enqueue(makeCmd('user-1'))
    enqueue(makeCmd('user-2'))
    const matched = dequeueAllMatching((c) => c.mode === 'prompt')
    expect(matched.length).toBe(2)
    expect(getCommandQueueLength()).toBe(1) // notif 留下
  })

  test('peek (不消费)', () => {
    enqueuePendingNotification(makeCmd('notif', 'task-notification'))
    enqueue(makeCmd('user-1'))
    const cmd = peek((c) => c.mode === 'prompt')
    expect(cmd?.value).toBe('user-1')
    expect(getCommandQueueLength()).toBe(2) // 没消耗
  })

  test('remove (按引用移除) — 拿到 queue 内引用再 remove', () => {
    enqueue(makeCmd('a'))
    enqueue(makeCmd('b'))
    // vendor enqueue 会做 spread 复制, 所以 test 端 `a` 引用与 queue 内
    // 元素不严格相等; 通过 getCommandQueue() 拿到的才是 queue 内真实引用。
    const [first] = getCommandQueue()
    remove([first!])
    expect(getCommandQueueLength()).toBe(1)
    expect(getCommandQueue()[0]!.value).toBe('b')
  })

  test('removeByFilter (predicate 移除)', () => {
    enqueue(makeCmd('keep'))
    enqueuePendingNotification(makeCmd('drop', 'task-notification'))
    enqueue(makeCmd('keep-2'))
    const removed = removeByFilter((c) => c.mode === 'task-notification')
    expect(removed.length).toBe(1)
    expect(removed[0]!.value).toBe('drop')
    expect(getCommandQueueLength()).toBe(2)
  })

  test('getCommandsByMaxPriority (按优先级阈值查询)', () => {
    enqueuePendingNotification(makeCmd('later', 'task-notification'))
    enqueue(makeCmd('next'))
    enqueue({ ...makeCmd('now'), priority: 'now' })
    const nows = getCommandsByMaxPriority('now')
    expect(nows.length).toBe(1)
    expect(nows[0]!.priority).toBe('now')
    const nexts = getCommandsByMaxPriority('next')
    expect(nexts.length).toBe(2) // now + next
  })

  test('isSlashCommand (slash command 识别)', () => {
    expect(isSlashCommand({ value: '/help', mode: 'prompt' })).toBe(true)
    expect(isSlashCommand({ value: 'plain text', mode: 'prompt' })).toBe(false)
    expect(
      isSlashCommand({ value: '/from-bridge', mode: 'prompt', skipSlashCommands: true }),
    ).toBe(false)
  })

  test('resetCommandQueue (test cleanup)', () => {
    enqueue(makeCmd('a'))
    enqueue(makeCmd('b'))
    expect(getCommandQueueLength()).toBe(2)
    resetCommandQueue()
    expect(getCommandQueueLength()).toBe(0)
    expect(hasCommandsInQueue()).toBe(false)
  })

  test('单实例 invariant: enqueue 写入后从主入口 dequeue 能拿到 (不绕过 bundle)', () => {
    enqueue(makeCmd('invariance-test'))
    const cmd = dequeue()
    expect(cmd?.value).toBe('invariance-test')
  })

  test('subscribeToCommandQueue 订阅 queue 变化通知', () => {
    let notifyCount = 0
    const off = subscribeToCommandQueue(() => {
      notifyCount++
    })
    enqueue(makeCmd('trigger'))
    expect(notifyCount).toBeGreaterThanOrEqual(1)
    off()
  })

  test('clearCommandQueue (emergency clear)', () => {
    enqueue(makeCmd('a'))
    enqueue(makeCmd('b'))
    expect(getCommandQueueLength()).toBe(2)
    clearCommandQueue()
    expect(getCommandQueueLength()).toBe(0)
  })

  test('recheckCommandQueue (queue 非空时通知 subscribers)', () => {
    enqueue(makeCmd('a'))
    let notifyCount = 0
    const off = subscribeToCommandQueue(() => {
      notifyCount++
    })
    recheckCommandQueue()
    expect(notifyCount).toBeGreaterThanOrEqual(1)
    off()
  })
})
