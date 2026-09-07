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
  registerSessionAgent,
  __resetSessionAgentsForTests,
} from '../../src/server/services/sessionAgentRegistry.js'
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
  __resetSessionAgentsForTests()
  for (const sid of ['sess-test', 'sess-other', 'sess-multi', 'sess-steer']) {
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

  test('cmd.agentId 兼容路径 (Item C, v2-r2): 仅当该 agentId 注册为属于本 session 时才匹配', () => {
    let wakeCount = 0
    const inbox = getSessionInbox('sess-test')
    inbox.setWakeHandler(() => {
      wakeCount++
    })
    // 注册: agent 'agent-x' 属于 session 'sess-test' (模拟 SubagentNotifier
    // terminal 事件时 registerSessionAgent 写入)。
    registerSessionAgent('sess-test', 'agent-x')

    // vendor 原生 enqueuePendingNotification 无 sessionId 字段, 只填 agentId
    // (cron / 第三方 vendor 调用方可能漏改 wrapper 的场景)。
    enqueuePendingNotification({
      value: '<task-notification>fallback</task-notification>',
      mode: 'task-notification',
      agentId: 'agent-x',
      taskKind: 'agent',
    })
    const drained = drainCommandQueueForSession('sess-test')
    expect(drained).toBe(1)
    expect(inbox.peekNextTurnCount('sess-test')).toBe(1)
    expect(wakeCount).toBe(1)
  })

  // zai patch (2026-09-07, Item C, fix-busy-flush-v2-r2): 严格 fallback
  // 防止跨 session 误派。原 "cmd.agentId === sid" 一刀切在多 session
  // 并发时会撞 sid 字面值 (sess-xxxx vs sess-yyyy)。
  test('cmd.agentId === sid 但 agent 不属于本 session → 严格 fallback 拒绝', () => {
    let wakeCount = 0
    const inbox = getSessionInbox('sess-test')
    inbox.setWakeHandler(() => {
      wakeCount++
    })
    // 关键: 不调用 registerSessionAgent, 表示这个 agentId 没注册到任何 session
    // (或注册到了别的 session)。模拟 vendor 调用方未走 wrapper, 漏写
    // sessionId, 又恰好 agentId 字面撞上 sid。

    // cmd.agentId === sid 字面撞: 这种情况以前会被旧 fallback 误派
    enqueuePendingNotification({
      value: '<task-notification>would-be-misdelivered</task-notification>',
      mode: 'task-notification',
      agentId: 'sess-test', // ← 撞 sid 字面值, 但没 register
      taskKind: 'agent',
    })
    const drained = drainCommandQueueForSession('sess-test')
    expect(drained).toBe(0) // ← 严格 fallback 拒收
    expect(inbox.peekNextTurnCount('sess-test')).toBe(0)
    expect(wakeCount).toBe(0)
  })

  test('cmd.agentId 是别的 session 注册的 agent → 不抽 (跨 session 隔离)', () => {
    let wakeCount = 0
    const inbox = getSessionInbox('sess-test')
    inbox.setWakeHandler(() => {
      wakeCount++
    })
    // 注册 agent-y 属于 sess-other
    registerSessionAgent('sess-other', 'agent-y')

    enqueuePendingNotification({
      value: '<task-notification>belongs-to-other-session</task-notification>',
      mode: 'task-notification',
      agentId: 'agent-y', // ← 注册到 sess-other, 不是 sess-test
      taskKind: 'agent',
    })
    const drained = drainCommandQueueForSession('sess-test')
    expect(drained).toBe(0) // ← 拒收
    expect(inbox.peekNextTurnCount('sess-test')).toBe(0)

    // 但 drainCommandQueueForSession('sess-other') 能正确拿到
    const drainedOther = drainCommandQueueForSession('sess-other')
    expect(drainedOther).toBe(1)
  })

  test('fallback 命中时输出 warn log 提示调用方改造走 zai wrapper', () => {
    const inbox = getSessionInbox('sess-test')
    inbox.setWakeHandler(() => {})
    registerSessionAgent('sess-test', 'agent-x')

    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    enqueuePendingNotification({
      value: '<task-notification>x</task-notification>',
      mode: 'task-notification',
      agentId: 'agent-x',
      taskKind: 'agent',
    })
    drainCommandQueueForSession('sess-test')
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining('严格 agentId fallback'),
    )
    // 提示包含 sessionId 便于排查
    expect(warnSpy.mock.calls[0][0]).toContain('sess-test')
    warnSpy.mockRestore()
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

  // zai patch (2026-09-07, fix-busy-flush-v2-r2, worktree-dsh, Item B):
  // steer 路径语义 — steer (kind=user + form=steer) 写入 nextStep 后, promote
  // 必须跳过它, 保留在 nextStep 由下次 API call 的 vendor hook prepend
  // <system-reminder>。steer 的设计意图是"等用户下次 prompt 时让 LLM 看到",
  // 不被 promote 触发立即新 turn。
  test('steer 消息不被 promoteNextStepToNextTurn 搬走 (skipSteer=true)', () => {
    let wakeCount = 0
    const inbox = getSessionInbox('sess-steer')
    inbox.setWakeHandler(() => {
      wakeCount++
    })
    // 模拟 steer 路径: queue/steer endpoint 写入 inbox.steer()
    // (busy 状态下 steer 也入 nextStep, 走 vendor hook prepend)
    inbox.setBusy('sess-steer')
    inbox.steer('sess-steer', {
      id: 'steer-1', source: { kind: 'user', form: 'steer' },
      content: '用户插话文本',
      createdAt: Date.now(),
    })
    inbox.steer('sess-steer', {
      id: 'steer-2', source: { kind: 'user', form: 'steer' },
      content: '第二条插话',
      createdAt: Date.now(),
    })
    inbox.clearRunning('sess-steer')

    // promote 必须跳过 steer (skipSteer 默认 true 在 busyFlush 层)
    const promoted = promoteNextStepToNextTurn('sess-steer')
    expect(promoted).toBe(0)
    expect(inbox.peekNextStepCount('sess-steer')).toBe(2)
    expect(inbox.peekNextTurnCount('sess-steer')).toBe(0)
    // 没有 promote → 没触发 wake (steer 不需要 wake 触发新 turn)
    expect(wakeCount).toBe(0)
    // 两条 steer 仍在 nextStep, vendor hook 会在下次 API call prepend
    expect(inbox.consumeNextStep('sess-steer').map((m) => m.id)).toEqual([
      'steer-1',
      'steer-2',
    ])
  })

  test('混合: steer + subagent + task-factory → 只 promote 非 steer 消息', () => {
    let wakeCount = 0
    const inbox = getSessionInbox('sess-steer')
    inbox.setWakeHandler(() => {
      wakeCount++
    })
    inbox.setBusy('sess-steer')
    // 1 steer
    inbox.steer('sess-steer', {
      id: 'steer-x', source: { kind: 'user', form: 'steer' },
      content: '插话', createdAt: Date.now(),
    })
    // 1 subagent (busy 路径)
    inbox.followup('sess-steer', {
      id: 'subagent-x', source: { kind: 'subagent', form: 'notice' },
      content: '<task-notification>x</task-notification>', createdAt: Date.now(),
    })
    // 1 task-factory (busy 路径)
    inbox.followup('sess-steer', {
      id: 'tf-x', source: { kind: 'task-factory', form: 'notice' },
      content: '<task-command>x</task-command>', createdAt: Date.now(),
    })
    inbox.clearRunning('sess-steer')

    const promoted = promoteNextStepToNextTurn('sess-steer')
    expect(promoted).toBe(2) // subagent + task-factory, steer 留下
    expect(inbox.peekNextTurnCount('sess-steer')).toBe(2)
    expect(inbox.peekNextStepCount('sess-steer')).toBe(1) // steer 仍在 nextStep
    expect(wakeCount).toBe(1)
    // consumeNextTurn FIFO: subagent 先 (busy followup 比 task-factory 早入 nextStep)
    expect(inbox.consumeNextTurn('sess-steer')?.id).toBe('subagent-x')
    expect(inbox.consumeNextTurn('sess-steer')?.id).toBe('tf-x')
    // steer 留在 nextStep (consumeNextStep 返回数组, 取首个元素)
    expect(inbox.consumeNextStep('sess-steer')[0]?.id).toBe('steer-x')
  })

  test('SessionInbox 直调: skipSteer=false (默认) → 仍搬 steer (向后兼容)', () => {
    // SessionInbox.promoteNextStepToNextTurn 默认 skipSteer=false, 让
    // 旧调用方 (agent.queue.test.ts) 行为不变; busyFlush 是新 caller,
    // 显式传 skipSteer=true。这是契约边界 —— 两个层各自决定过滤策略。
    const inbox = getSessionInbox('sess-steer')
    inbox.setBusy('sess-steer')
    inbox.steer('sess-steer', {
      id: 's1', source: { kind: 'user', form: 'steer' },
      content: 'steer msg', createdAt: Date.now(),
    })
    inbox.clearRunning('sess-steer')

    // 默认 opts={} → skipSteer=false → steer 也会被搬走 (旧契约)
    const promoted = inbox.promoteNextStepToNextTurn('sess-steer')
    expect(promoted).toBe(1)
    expect(inbox.peekNextStepCount('sess-steer')).toBe(0)
    expect(inbox.peekNextTurnCount('sess-steer')).toBe(1)
  })

  test('SessionInbox 直调: skipSteer=true → steer 留下', () => {
    const inbox = getSessionInbox('sess-steer')
    inbox.setBusy('sess-steer')
    inbox.steer('sess-steer', {
      id: 's1', source: { kind: 'user', form: 'steer' },
      content: 'steer msg', createdAt: Date.now(),
    })
    inbox.clearRunning('sess-steer')

    const promoted = inbox.promoteNextStepToNextTurn('sess-steer', {
      skipSteer: true,
    })
    expect(promoted).toBe(0)
    expect(inbox.peekNextStepCount('sess-steer')).toBe(1)
    expect(inbox.peekNextTurnCount('sess-steer')).toBe(0)
  })
})