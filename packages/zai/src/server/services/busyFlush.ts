/**
 * busy-flush-v2: 主 turn 真正结束时(sessionControllers 已 release)的兜底
 * 唤醒机制。修复 v1 修复(commit 646335c4)只覆盖后台 Bash 通知漏掉的两个场景:
 *
 *   1. SessionInbox.nextStep 降级队列里堆积的 subagent `<task-notification>` /
 *      系统 reminder —— 父 turn busy 时 followup 走 nextStep, 由 vendor hook
 *      (`runExtraReminderProviders` → `drainInboxReminder`) 在下一次 API call
 *      时 prepend `<system-reminder>`。但 repl runtime 没有 print.ts 的
 *      `subscribeToHeadlessWake` 唤醒机制 (print.ts:2095); 父 turn end_turn
 *      后若没有下一次 API call, nextStep 永远不会被消费。
 *
 *   2. vendor `commandQueue` (messageQueueManager.ts:52) 里指向本 session
 *      的 task-notification —— QueryEngine mid-turn drain (query.ts:2675)
 *      只在 LLM 下一次 API call 之前触发, 父 turn end_turn 没有下一次
 *      API call 时, 命令卡在 commandQueue。
 *
 * 修法:
 *   - `promoteNextStepToNextTurn(sid)`: 把 nextStep 全部提升到 nextTurn 队列。
 *     runNextInQueue 入口会 consumeNextTurn 拿到, 当作真实 cmd.prompt 喂给
 *     vendor query(), 落盘 transcript + 唤醒 LLM 看到通知。
 *   - `drainCommandQueueForSession(sid)`: dequeueAllMatching 把
 *     `cmd.sessionId === sid` 的命令(vendor 入队时由 zai wrapper 自动注入)
 *     全部抽出, 走 SessionInbox.followup 投递。idle 走 nextTurn + wake,
 *     busy 走 nextStep (但既然这里在 finally 调, busy 已经 release, idle 路径)。
 *
 * `flushPendingBashNotifications` (v1) 在更早位置调用, 三者全顺序执行:
 *   1. flushPendingBashNotifications(sid) — v1 修的 BashNotifier 兜底
 *   2. promoteNextStepToNextTurn(sid) — v2 修的 SessionInbox 兜底
 *   3. drainCommandQueueForSession(sid) — v2 修的 vendor commandQueue 兜底
 *
 * 三者各自独立, 任一路径触发的通知都不会丢。共同点: 都从 idle 入口
 * (releaseSessionController 之后) 走, 不需要 running 守卫。
 */
import { dequeueAllMatching, type QueuedCommand } from '@zn-ai/zn-agent-core'
import { getSessionInbox, type InboxMessage } from './sessionInbox.js'

/**
 * 提升某 session 的 SessionInbox.nextStep 全部消息到 nextTurn 队列,
 * 并触发 wake handler 唤醒。runNextInQueue 入口的 consumeNextTurn 会
 * 按 FIFO 取出, 当作真实 cmd.prompt 喂给 vendor query(), 等价于用户
 * 又发了一条新 prompt。
 *
 * 返回提升的消息数(0 表示 lane 空, 不触发 wake)。
 *
 * 设计上 `followup()` busy 路径降级到 nextStep, 这里在 finally release
 * 之后兜底提升到 nextTurn, 触发 LLM 真正处理通知 (vs. 留到用户下条
 * prompt 时 vendor hook prepend —— 那条路在用户不主动发 prompt 时永远
 * 走不到, 通知丢失)。
 */
export function promoteNextStepToNextTurn(sessionId: string): number {
  const inbox = getSessionInbox(sessionId)
  const promoted = inbox.promoteNextStepToNextTurn(sessionId)
  if (promoted > 0) {
    // wake handler 由 agent.ts 在启动时注册为 runNextInQueue(sid):
    // 见 agent.ts:1058 setSessionInboxWakeHandler。wakeBudget 默认 3/turn,
    // 超超时不 wake 也无所谓 —— 消息仍在 nextTurn, 下次用户 prompt 时
    // 会和 HTTP queue 一起被消费。
    inbox.wakeFor(sessionId)
  }
  return promoted
}

/**
 * 兜底 drain vendor `commandQueue` (messageQueueManager.ts:52 全局单例)
 * 中指向本 session 的命令, 走 SessionInbox.followup 投递 (idle 走
 * nextTurn + wake; busy 走 nextStep)。调用方需要保证此时 session 已
 * release, busy 路径不会触发, 全部 idle 走 nextTurn。
 *
 * zai patch 注入: vendor `enqueuePendingNotification` 由 zai wrapper
 * (`compat/messageQueueAdapter.ts`) 自动注入独立 `sessionId` 字段
 * (而非污染 `agentId`), 这里读 `cmd.sessionId` 精确路由, fallback
 * `cmd.agentId` 兼容 vendor 原生调用。
 */
export function drainCommandQueueForSession(sessionId: string): number {
  let drained = 0
  // 单次 drain: dequeueAllMatching 把匹配的全部拿出, 我们逐条走 followup。
  // 循环兜底: 若 followup 触发了新 turn (nextTurn + wake → runQueryLoop),
  // 那个新 turn 的 mid-turn drain 会消费 commandQueue 的剩余项 —— 不需要
  // 在这里再 drain。
  const matched = dequeueAllMatching((cmd: QueuedCommand) => {
    const cmdSid = (cmd as { sessionId?: string }).sessionId
    return cmdSid === sessionId || cmd.agentId === sessionId
  })
  if (matched.length === 0) return 0
  const inbox = getSessionInbox(sessionId)
  for (const cmd of matched) {
    const value = cmd.value
    if (typeof value !== 'string' || value.length === 0) continue
    // task-notification / orphaned-permission / cron-prompt 等都按
    // inbox notification 投递。内容已经包含 `<task-notification>` XML
    // 或类似结构, LLM 拿到后按 vendor 的 renderInboxMessage 同款方式
    // 识别处理 (folllowup path 走 inboxToPendingPrompt 当真实 prompt
    // 喂 vendor query() —— 用户消息注入语义, 与 vendor mid-turn drain
    // 路径不同但语义对齐)。
    //
    // followup() 内部已经处理 wake (idle → nextTurn + wakeIfBudgeted;
    // busy → nextStep + 不 wake)。这里是 finally 调, busy 已经 release,
    // 所以走 idle 路径 —— 每次 followup 都会 wake 一次。wakeBudget 默认 3,
    // 第 4 条以上不再 wake, 但消息仍在 nextTurn 等下次 user prompt。
    const msg: InboxMessage = {
      id: `vendor-${cmd.uuid ?? Date.now()}-${drained}`,
      source: {
        kind: cmd.mode === 'task-notification' ? 'subagent' : 'system',
        form: 'notice',
        ...(cmd.taskKind ? { agentType: cmd.taskKind } : {}),
      },
      content: value,
      createdAt: cmd.enqueuedAt ?? Date.now(),
    }
    inbox.followup(sessionId, msg)
    drained++
  }
  // 不需要额外 wakeFor: followup 已经触发 wake (走 wakeBudget)。
  return drained
}