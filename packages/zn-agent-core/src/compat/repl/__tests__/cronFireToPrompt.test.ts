// @ts-nocheck
/**
 * zai patch (2026-09-12, plan cron-fire-to-prompt): E2E 测试 —
 * 验证 cron 到点 fire 时, 两条链路都被触发:
 *   1. vendor commandQueue (zaiEnqueuePendingNotification) —— 原 fallback
 *   2. SessionInbox.followup (__zaiSessionInboxFollowup) —— idle wake / busy steer
 *
 * 不 mock 真链路 (inboxMessageHandler.ts / messageQueueManager.ts 等):
 * 按 memory feedback-obsolete-tests.md 规则, 主链路测试不该 mock
 * inboxMessageHandler 的实现, 用 spy 监听 globalThis seam 调用次数。
 * createCronScheduler 替换为最小存根, 让 onFire 在 50ms 内被调一次。
 */

import { vi, describe, it, expect, beforeEach, afterEach } from 'vitest'

// 让 onFire 在 50ms 内被调一次的存根 —— 替代真实 createCronScheduler 的
// chokidar/clock/lock 链, 但保留 onFire → opts.sessionId/onFireTask
// 同样的 contract, 让主测试只关心 fire 之后发生了什么。
let mockOnFire: ((prompt: string) => void) | null = null
let mockStartCalled = 0
let mockStopCalled = 0

vi.mock('../../../opencc-src/utils/cronScheduler.js', () => ({
  createCronScheduler: (options: any) => {
    mockOnFire = options.onFire
    mockStartCalled = 0
    mockStopCalled = 0
    return {
      start: () => {
        mockStartCalled += 1
      },
      stop: () => {
        mockStopCalled += 1
      },
      getNextFireTime: () => null,
    }
  },
}))

vi.mock('../../../opencc-src/tools/ScheduleCronTool/prompt.js', () => ({
  isKairosCronEnabled: () => true,
}))

import { setupScheduledTasks } from '../setup/setupCronScheduler.js'
import { installMessageQueueAdapterBridges, __resetMessageQueueAdapterBridgesForTests } from '../../messageQueueAdapter.js'

describe('cron fire → prompt dual dispatch (E2E)', () => {
  let enqueueSpy: ReturnType<typeof vi.fn>
  let enqueuePendingSpy: ReturnType<typeof vi.fn>
  let inboxFollowupSpy: ReturnType<typeof vi.fn>

  beforeEach(() => {
    // 1) vendor bridge spy —— 验 fallback 链路
    enqueueSpy = vi.fn()
    enqueuePendingSpy = vi.fn()
    installMessageQueueAdapterBridges({
      enqueue: enqueueSpy,
      enqueuePendingNotification: enqueuePendingSpy,
    })

    // 2) zai-server install 的 inbox seam —— 验证 Fix 2 触发
    inboxFollowupSpy = vi.fn()
    ;(globalThis as any).__zaiSessionInboxFollowup = inboxFollowupSpy

    // 3) zai-server 在 setCurrentSessionId 时写入, 这里设个测试 sessionId
    ;(globalThis as any).__zaiCurrentSessionId = 'test-session-123'
  })

  afterEach(() => {
    __resetMessageQueueAdapterBridgesForTests()
    delete (globalThis as any).__zaiSessionInboxFollowup
    delete (globalThis as any).__zaiCurrentSessionId
    mockOnFire = null
    mockStartCalled = 0
    mockStopCalled = 0
  })

  it('fires both dispatch paths within 50ms', async () => {
    const handle = setupScheduledTasks({
      sessionId: '', // v2 路径: 走 globalThis.__zaiCurrentSessionId fallback
      getAppState: () => ({}),
      isLoading: () => false,
    })

    // setupScheduledTasks 内部已调 scheduler.start()
    expect(mockStartCalled).toBe(1)

    // 模拟 cron 到点 fire —— 由 mock 触发 onFire
    expect(mockOnFire).not.toBeNull()
    mockOnFire!('请检查一下今天的待办')

    // 等下一个 microtask 让所有 dispatch path 跑完
    await new Promise(resolve => setTimeout(resolve, 50))

    // 断言 1: vendor commandQueue fallback 仍被调 (向后兼容)
    expect(enqueuePendingSpy).toHaveBeenCalledTimes(1)
    expect(enqueuePendingSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        value: '请检查一下今天的待办',
        mode: 'prompt',
        priority: 'later',
        isMeta: true,
        sessionId: 'test-session-123',
      }),
    )

    // 断言 2: SessionInbox.followup 被调 (Fix 2)
    expect(inboxFollowupSpy).toHaveBeenCalledTimes(1)
    expect(inboxFollowupSpy).toHaveBeenCalledWith(
      'test-session-123',
      expect.objectContaining({
        content: '请检查一下今天的待办',
        source: { kind: 'system', form: 'notice' },
      }),
    )

    handle.teardown()
    expect(mockStopCalled).toBe(1)
  })

  it('routes sessionId from opts.sessionId when provided (v1 per-session path)', async () => {
    const handle = setupScheduledTasks({
      sessionId: 'per-session-instance-abc',
      getAppState: () => ({}),
      isLoading: () => false,
    })

    expect(mockOnFire).not.toBeNull()
    mockOnFire!('per-session prompt')

    await new Promise(resolve => setTimeout(resolve, 50))

    expect(inboxFollowupSpy).toHaveBeenCalledTimes(1)
    expect(inboxFollowupSpy).toHaveBeenCalledWith(
      'per-session-instance-abc',
      expect.objectContaining({ content: 'per-session prompt' }),
    )

    handle.teardown()
  })

  it('falls back silently when seams not installed (vendor unit test env)', async () => {
    // 清理 inbox seam 模拟 "zai-server 还没启动" 的 vendor 单测场景
    delete (globalThis as any).__zaiSessionInboxFollowup
    delete (globalThis as any).__zaiCurrentSessionId

    const handle = setupScheduledTasks({
      sessionId: 'sid-only-no-seams',
      getAppState: () => ({}),
      isLoading: () => false,
    })

    expect(mockOnFire).not.toBeNull()
    // 不应抛
    expect(() => mockOnFire!('trigger')).not.toThrow()

    await new Promise(resolve => setTimeout(resolve, 50))

    // vendor fallback 仍应触发 (主路径不依赖 seam)
    expect(enqueuePendingSpy).toHaveBeenCalledTimes(1)
    // inbox seam 静默跳过 (typeof check fail → no-op)
    expect(inboxFollowupSpy).not.toHaveBeenCalled()

    handle.teardown()
  })

  it('isolated fire errors in inbox do not break vendor fallback', async () => {
    // 模拟 seam 抛错 —— 主路径必须 robust
    ;(globalThis as any).__zaiSessionInboxFollowup = vi.fn(() => {
      throw new Error('inbox explosion')
    })

    const handle = setupScheduledTasks({
      sessionId: '',
      getAppState: () => ({}),
      isLoading: () => false,
    })

    // 不应抛到调用方
    expect(() => mockOnFire!('critical prompt')).not.toThrow()
    await new Promise(resolve => setTimeout(resolve, 50))

    // vendor fallback 仍跑 —— 这是 P0 必须保住的不变量
    expect(enqueuePendingSpy).toHaveBeenCalledTimes(1)

    handle.teardown()
  })
})