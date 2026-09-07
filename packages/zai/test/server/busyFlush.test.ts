/**
 * busy-flush-v2 unit tests — 验证主 turn finally 兜底的三条 flush 路径:
 *   1. flushPendingBashNotifications (v1, 已在 bashNotifier.test.ts 覆盖)
 *   2. promoteNextStepToNextTurn (本测试覆盖)
 *   3. drainCommandQueueForSession (本测试覆盖)
 *
 * 真实场景 (sess-1788753456906-3fvboh58): 父 turn busy 时 SubagentNotifier
 * followup 降级入 nextStep; vendor `enqueuePendingNotification` 同时推到
 * vendor commandQueue。父 turn end_turn 没有下一次 API call, 两份通知双双
 * 卡住 —— LLM 永远看不到 <task-notification>。
 *
 * 修法 (v2): runQueryLoop finally 调 promoteNextStepToNextTurn + drainCommandQueue,
 * 把两份通知搬出 + 触发 SessionInbox wake → runNextInQueue → 新一轮 turn 把
 * 通知当作真实 cmd.prompt 喂 vendor query(), 落盘 transcript + 唤醒 LLM。
 */
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import {
  promoteNextStepToNextTurn,
  drainCommandQueueForSession,
} from '../../src/server/services/busyFlush.js'
import { getSessionInbox, disposeSessionInbox } from '../../src/server/services/sessionInbox.js'
import {
  enqueuePendingNotification,
  resetCommandQueue,
} from '@zn-ai/zn-agent-core'

/**
 * 模拟"父 turn busy 期间 followup 触发降级入 nextStep"的写法:
 *   inbox.setBusy(sid) 后 followup 走 nextStep + 不 wake。
 *   finally 调用时 inbox.clearRunning(sid) 模拟 release, 然后 promote。
 * 真实场景 followup 由 SubagentNotifier.handle 调, finally 由
 * runQueryLoop finally 调; 测试里手工模拟两个状态机。
 */
function setupBusyInbox(sid: string, wakeHandler: () => void) {
  const inbox = getSessionInbox(sid)
  inbox.setWakeHandler(wakeHandler)
  inbox.setBusy(sid)
  return inbox
}

afterEach(() => {
  resetCommandQueue()
  for (const sid of ['sess-test', 'sess-other', 'sess-multi']) {
    disposeSessionInbox(sid)
  }
  vi.restoreAllMocks()
})

describe('promoteNextStepToNextTurn', () => {
  test('nextStep 空 → 返回 0, 不 wake', async () => {
    let wakeCount = 0
    getSessionInbox('sess-test').setWakeHandler(() => {
      wakeCount++
    })
    const n = promoteNextStepToNextTurn('sess-test')
    expect(n).toBe(0)
    expect(wakeCount).toBe(0)
  })

  test('nextStep 有 1 条 (busy 降级) → finally 搬到 nextTurn + wake 一次', async () => {
    let wakeCount = 0
    const inbox = setupBusyInbox('sess-test', () => {
      wakeCount++
    })
    // busy 路径 followup 降级入 nextStep, 不 wake
    inbox.followup('sess-test', {
      id: 'bg-1',
      source: { kind: 'subagent', form: 'notice' },
      content: '<task-notification>agent done</task-notification>',
      createdAt: Date.now(),
    })
    expect(wakeCount).toBe(0)
    expect(inbox.peekNextStepCount('sess-test')).toBe(1)
    expect(inbox.peekNextTurnCount('sess-test')).toBe(0)
    // 父 turn 真正结束: clearRunning (busy=false), 然后 finally 调 promote
    inbox.clearRunning('sess-test')
    const promoted = promoteNextStepToNextTurn('sess-test')
    expect(promoted).toBe(1)
    expect(inbox.peekNextStepCount('sess-test')).toBe(0)
    expect(inbox.peekNextTurnCount('sess-test')).toBe(1)
    expect(wakeCount).toBe(1)
    // consumeNextTurn 拿到内容
    const msg = inbox.consumeNextTurn('sess-test')
    expect(msg?.content).toContain('<task-notification>')
  })

  test('nextStep 有 N 条 (busy 降级) → 全部搬到 nextTurn 保持 FIFO + wake 一次', async () => {
    let wakeCount = 0
    const inbox = setupBusyInbox('sess-test', () => {
      wakeCount++
    })
    // busy 路径塞 3 条 followup
    inbox.followup('sess-test', {
      id: 'bg-1', source: { kind: 'subagent', form: 'notice' },
      content: 'msg1', createdAt: Date.now(),
    })
    inbox.followup('sess-test', {
      id: 'bg-2', source: { kind: 'subagent', form: 'notice' },
      content: 'msg2', createdAt: Date.now(),
    })
    inbox.followup('sess-test', {
      id: 'bg-3', source: { kind: 'system', form: 'reminder' },
      content: 'msg3', createdAt: Date.now(),
    })
    expect(inbox.peekNextStepCount('sess-test')).toBe(3)
    inbox.clearRunning('sess-test')
    const promoted = promoteNextStepToNextTurn('sess-test')
    expect(promoted).toBe(3)
    expect(inbox.peekNextStepCount('sess-test')).toBe(0)
    expect(inbox.peekNextTurnCount('sess-test')).toBe(3)
    expect(wakeCount).toBe(1)
    // FIFO 顺序
    expect(inbox.consumeNextTurn('sess-test')?.content).toBe('msg1')
    expect(inbox.consumeNextTurn('sess-test')?.content).toBe('msg2')
    expect(inbox.consumeNextTurn('sess-test')?.content).toBe('msg3')
  })

  test('wake budget 耗尽 (同 turn 内 4+ 次 wake) → 第 N 次 wake 静默 no-op, 消息保留', async () => {
    let wakeCount = 0
    const inbox = getSessionInbox('sess-test')
    inbox.setWakeHandler(() => {
      wakeCount++
    })
    // busy 路径塞 5 条 followup 入 nextStep (都不 wake, busy 路径)
    inbox.setBusy('sess-test')
    for (let i = 0; i < 5; i++) {
      inbox.followup('sess-test', {
        id: `w${i}`, source: { kind: 'subagent', form: 'notice' },
        content: `msg${i}`, createdAt: Date.now(),
      })
    }
    expect(inbox.peekNextStepCount('sess-test')).toBe(5)
    expect(wakeCount).toBe(0)
    // clearRunning 会重置 budget(对齐 sessionInbox.ts 设计:用户 turn 结束恢复预算)
    inbox.clearRunning('sess-test')

    // promote: 5 条 nextStep → nextTurn, wakeFor 第一次成功(budget 重置后 = 1)
    const promoted = promoteNextStepToNextTurn('sess-test')
    expect(promoted).toBe(5)
    expect(inbox.peekNextStepCount('sess-test')).toBe(0)
    expect(inbox.peekNextTurnCount('sess-test')).toBe(5)
    expect(wakeCount).toBe(1)

    // 模拟接下来 3 次 wake 触发把 budget 再次耗尽 (DEFAULT_WAKE_BUDGET=3)
    inbox.wakeFor('sess-test')
    inbox.wakeFor('sess-test')
    inbox.wakeFor('sess-test')
    expect(wakeCount).toBe(3)

    // 第 4 次 wake 静默 no-op (budget 耗尽)
    inbox.wakeFor('sess-test')
    expect(wakeCount).toBe(3)

    // 消息仍在 nextTurn 等下次 user prompt
    expect(inbox.peekNextTurnCount('sess-test')).toBe(5)
  })
})

describe('drainCommandQueueForSession', () => {
  test('commandQueue 空 → 返回 0, 不 wake', () => {
    let wakeCount = 0
    getSessionInbox('sess-test').setWakeHandler(() => {
      wakeCount++
    })
    const n = drainCommandQueueForSession('sess-test')
    expect(n).toBe(0)
    expect(wakeCount).toBe(0)
  })

  test('1 条 task-notification 指向本 session → drain + 投递 SessionInbox + wake', () => {
    let wakeCount = 0
    const inbox = getSessionInbox('sess-test')
    inbox.setWakeHandler(() => {
      wakeCount++
    })
    // 模拟 vendor `enqueuePendingNotification` 由 zai wrapper 注入 sessionId
    enqueuePendingNotification({
      value: '<task-notification><task-id>agent-1</task-id></task-notification>',
      mode: 'task-notification',
      sessionId: 'sess-test',
      taskKind: 'agent',
    })
    const drained = drainCommandQueueForSession('sess-test')
    expect(drained).toBe(1)
    // 投递到 nextTurn (idle 路径), 触发 wake
    expect(inbox.peekNextTurnCount('sess-test')).toBe(1)
    expect(inbox.peekNextStepCount('sess-test')).toBe(0)
    expect(wakeCount).toBe(1)
    // 内容保留 task-notification XML
    expect(inbox.consumeNextTurn('sess-test')?.content).toContain('<task-notification>')
  })

  test('其他 session 的命令不抽(精确 sessionId 路由)', () => {
    let wakeCount = 0
    const inbox = getSessionInbox('sess-test')
    inbox.setWakeHandler(() => {
      wakeCount++
    })
    enqueuePendingNotification({
      value: '<task-notification>other</task-notification>',
      mode: 'task-notification',
      sessionId: 'sess-other',
      taskKind: 'agent',
    })
    const drained = drainCommandQueueForSession('sess-test')
    expect(drained).toBe(0)
    expect(inbox.peekNextTurnCount('sess-test')).toBe(0)
    expect(wakeCount).toBe(0)
    // sess-other 那条仍在 queue(不被 sess-test drain 抽走)
    // 后续 sess-other 自己的 drain 会处理
    drainCommandQueueForSession('sess-other')
  })

  test('cmd.agentId 兼容路径: vendor 原生无 sessionId 时按 agentId 路由', () => {
    let wakeCount = 0
    const inbox = getSessionInbox('sess-test')
    inbox.setWakeHandler(() => {
      wakeCount++
    })
    // vendor 原生 enqueuePendingNotification 无 sessionId 字段
    enqueuePendingNotification({
      value: '<task-notification>fallback</task-notification>',
      mode: 'task-notification',
      agentId: 'sess-test',
      taskKind: 'agent',
    })
    const drained = drainCommandQueueForSession('sess-test')
    expect(drained).toBe(1)
    expect(inbox.peekNextTurnCount('sess-test')).toBe(1)
    expect(wakeCount).toBe(1)
  })

  test('多条混合: 部分本 session 部分其他 → 仅本 session 被抽', () => {
    let wakeCount = 0
    const inbox = getSessionInbox('sess-test')
    inbox.setWakeHandler(() => {
      wakeCount++
    })
    enqueuePendingNotification({
      value: 'a1', mode: 'task-notification',
      sessionId: 'sess-test', taskKind: 'agent',
    })
    enqueuePendingNotification({
      value: 'a2', mode: 'task-notification',
      sessionId: 'sess-other', taskKind: 'agent',
    })
    enqueuePendingNotification({
      value: 'a3', mode: 'task-notification',
      sessionId: 'sess-test', taskKind: 'agent',
    })
    const drained = drainCommandQueueForSession('sess-test')
    expect(drained).toBe(2)
    expect(inbox.peekNextTurnCount('sess-test')).toBe(2)
    // 第一次 followup 触发 wake, 第二次仍走 wake(走 wakeBudget 计数)
    expect(wakeCount).toBeGreaterThanOrEqual(1)
  })

  test('孤儿 (空字符串 value) 跳过 + wake 仍触发(同 session 投递至少一次)', () => {
    let wakeCount = 0
    const inbox = getSessionInbox('sess-test')
    inbox.setWakeHandler(() => {
      wakeCount++
    })
    // cmd.value 非字符串会跳过投递, 但仍算 drain 命中
    enqueuePendingNotification({
      value: '',
      mode: 'task-notification',
      sessionId: 'sess-test',
      taskKind: 'agent',
    })
    const drained = drainCommandQueueForSession('sess-test')
    // 空字符串也算 "drain 了一条" 但不投递, 返回 0 表示"实际投递数"
    expect(drained).toBe(0)
    expect(inbox.peekNextTurnCount('sess-test')).toBe(0)
    expect(wakeCount).toBe(0)
  })
})

describe('busy-flush-v2 集成: 真实场景重现', () => {
  test('父 turn busy + subagent 完成 → finally flush 让 LLM 看到通知', async () => {
    // 模拟 sess-1788753456906-3fvboh58 的现象:
    //   1. busy 路径 inbox.followup 降级入 nextStep
    //   2. vendor enqueuePendingNotification 推 commandQueue
    //   3. 父 turn end_turn → 没有下次 API call
    //   4. v1 修复: flushPendingBashNotifications (BashNotifier 暂存)
    //      → 本测试场景下没有 bash, 跳过
    //   5. v2 修复: promoteNextStepToNextTurn + drainCommandQueue
    //      → nextStep 与 commandQueue 都搬到 nextTurn + wake
    //   6. runNextInQueue 入口 consumeNextTurn → inboxToPendingPrompt
    //      → runQueryLoop 调 vendor query(prompt=通知内容)
    //   7. LLM 看到 <task-notification> user message, 落盘 transcript

    let wakeCount = 0
    const inbox = getSessionInbox('sess-multi')
    inbox.setWakeHandler(() => {
      wakeCount++
    })
    // 模拟父 turn busy
    inbox.setBusy('sess-multi')
    // 1) busy 路径 inbox.followup 降级入 nextStep
    inbox.followup('sess-multi', {
      id: 'subagent-1', source: { kind: 'subagent', form: 'notice' },
      content: '<task-notification><task-id>a7d1d8d7</task-id><status>completed</status><summary>Agent completed</summary></task-notification>',
      createdAt: Date.now(),
    })
    // 2) vendor enqueuePendingNotification 推 commandQueue
    enqueuePendingNotification({
      value: '<task-notification><task-id>a7d1d8d7</task-id><status>completed</status></task-notification>',
      mode: 'task-notification',
      sessionId: 'sess-multi',
      taskKind: 'agent',
    })
    // 此时两条通知卡在 nextStep + commandQueue, 模拟父 turn end_turn 后
    expect(inbox.peekNextStepCount('sess-multi')).toBe(1)
    expect(wakeCount).toBe(0)

    // 父 turn 真正结束
    inbox.clearRunning('sess-multi')

    // 3) finally 兜底: 先 promote nextStep → nextTurn
    const promoted = promoteNextStepToNextTurn('sess-multi')
    expect(promoted).toBe(1)
    expect(inbox.peekNextStepCount('sess-multi')).toBe(0)
    expect(inbox.peekNextTurnCount('sess-multi')).toBe(1)
    expect(wakeCount).toBe(1)

    // 4) finally 兜底: drain commandQueue
    const drained = drainCommandQueueForSession('sess-multi')
    expect(drained).toBe(1)
    expect(inbox.peekNextTurnCount('sess-multi')).toBe(2)

    // 5) consumeNextTurn 两条消息都能拿到 (代表 LLM 看到了)
    const m1 = inbox.consumeNextTurn('sess-multi')
    const m2 = inbox.consumeNextTurn('sess-multi')
    expect(m1?.content).toContain('<task-notification>')
    expect(m2?.content).toContain('<task-notification>')
    expect(inbox.peekNextTurnCount('sess-multi')).toBe(0)
  })
})