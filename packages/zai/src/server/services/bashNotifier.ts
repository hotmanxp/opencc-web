import type { BashTaskInfo } from '@zn-ai/zn-agent-core'

/**
 * BashNotifier:后台 Bash 任务完成时,**不再**给父 session 开新一轮 query。
 *
 * 为什么不自动注入通知:
 *   zai 是 headless,没有 REPL 那套 idle-subscriber。早期实现是后台 Bash 完成时
 *   调 `adapter.run({prompt: <task-notification>, isMeta: true})` 给父 session 开
 *   一轮新 query。但实测中,每个完成的后台任务都会触发一次 `adapter.run()`,
 *   一次 TURN 结束如果积压了 N 个后台任务 → flushPendingBashNotifications 顺
 *   序补发 N 个通知 → Agent 被强制拉起 N 个新 turn,每轮 1 次 API 调用,观察
 *   到每次 TURN 结束后消息列表里追加一连串 assistant + BASH 工具调用。
 *   用户要求:"不要往用户消息队列插入消息"。
 *
 *   UI 仍通过 `bash_task.changed` SSE 看到后台任务状态变化(TaskDock 实时刷
 *   新),但 Agent 不再被动接收 <task-notification>。后续若需要让 Agent 感知
 *   后台完成,改为(1)用户主动发 prompt 时把已完成 task 摘要拼进 prompt,
 *   或(2)走 `SubagentNotifier` 同样的 inbox 路径;在此之前本模块保持 no-op。
 *
 * 历史背景(2026-08-09):曾用 `enqueueShellNotification` 走 vendor commandQueue
 *   drain,bundle/double-module 问题导致通知永远 drain 不到 → 改用 BashTaskInfo
 *   构造 prompt 调 `runtime.query()` 直发,但同样会被多任务积压放大。
 *   2026-08-22:收到用户反馈后,决定**移除自动注入**,只保留事件桥 UI 状态显示。
 */
export interface BashNotifierOptions {
  /** 保留以兼容历史调用方 —— 当前 no-op,不再消费该字段。 */
  getKernelAdapter?: unknown
}

let notifier: BashNotifier | null = null

// zai patch (2026-08-22): 自动注入通知已禁用,不再向 pendingNotifications 写入;
// 保留 Map + 仍接受 handle() 入参只为不让 stateBridge.ts / 老测试报错(其中
// `__resetBashNotifierPendingForTests` 仍被测试使用)。实际不会触发任何 query。
const pendingNotifications = new Map<string, BashTaskInfo[]>()

/**
 * 主线 query 结束(agent.ts runQueryLoop finally)时调一次,清掉该 session
 * 任何残留的 pending 项。**不再**补发通知 — UI 状态由 `bash_task.changed`
 * SSE 推送实时更新,Agent 不再被后台任务完成拉起新 turn。
 */
export function flushPendingBashNotifications(sessionId: string): void {
  pendingNotifications.delete(sessionId)
}

/** 测试 seam:清空暂存队列。 */
export function __resetBashNotifierPendingForTests(): void {
  pendingNotifications.clear()
}

/**
 * 构造 <task-notification> 风格 user message 文本(基于 BashTaskInfo)。
 * summary 对齐 LocalShellTask.enqueueShellNotification 的措辞,并追加
 * "只确认结果、不续跑主任务"的引导 —— 通知 query 加载完整父上下文,不加
 * 引导的话模型会把通知误当成"继续干主任务"的信号(请求风暴的放大器)。
 */
export function renderBashNotificationMessage(task: BashTaskInfo): string {
  const status = task.status
  const exitCode = task.exitCode
  let summary: string
  switch (status) {
    case 'completed':
      summary = `Background command "${task.description}" completed${exitCode !== undefined ? ` (exit code ${exitCode})` : ''}`
      break
    case 'failed':
      summary = `Background command "${task.description}" failed${exitCode !== undefined ? ` with exit code ${exitCode}` : ''}`
      break
    case 'killed':
      summary = `Background command "${task.description}" was stopped`
      break
    default:
      summary = `Background command "${task.description}" ${status}`
  }
  const guidance =
    'This is a system notification about a background command. Acknowledge the result briefly; do not resume, restart, or continue the main task unless the result clearly requires it.'
  return (
    `<task-notification>\n` +
    `<task-id>${escapeXml(task.taskId)}</task-id>\n` +
    `<status>${status}</status>\n` +
    `<summary>${escapeXml(summary)}</summary>\n` +
    `</task-notification>\n\n` +
    guidance
  )
}

function escapeXml(s: string): string {
  // 防注入:破坏 < > & 让 LLM 看不到伪造标签
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}

export class BashNotifier {
  // 构造器保留 opts 以兼容历史 `new BashNotifier({ getKernelAdapter: ... })`
  // 调用方(stateBridge 之外的测试、单测 setup)。当前 no-op,不再消费字段。
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  constructor(_opts: BashNotifierOptions = {}) {}

  /**
   * bash_task.changed 回调。**当前为 no-op** —— 不再触发任何 query,避免
   * 后台任务完成时把 Agent 拉起新 turn(用户要求"不要往用户消息队列插入消息")。
   *
   * 仅保留入参守卫(task 终态校验、isBackgrounded 过滤、sessionId 兜底),与
   * 之前语义保持一致,这样任何仍通过 stateBridge 调 `getBashNotifier().handle()`
   * 的代码(测试、单测 setup)都不会出错。eventBus 的 `bash_task.changed` SSE
   * 推送由 stateBridge 单独 emit,UI TaskDock 仍能看到任务状态变化。
   */
  async handle(e: { sessionId: string; task: BashTaskInfo }): Promise<void> {
    const task = e.task
    if (task.status !== 'completed' && task.status !== 'failed' && task.status !== 'killed') {
      return
    }
    if (!task.isBackgrounded) return
    const sessionId = e.sessionId
    if (!sessionId || sessionId === 'sess-unknown') return
    // 故意 no-op:不再调 adapter.run(),不再写 pendingNotifications。
  }
}

/** Initialize the singleton. Idempotent. */
export function initBashNotifier(opts: BashNotifierOptions = {}): BashNotifier {
  if (notifier) return notifier
  notifier = new BashNotifier(opts)
  return notifier
}

export function getBashNotifier(): BashNotifier {
  if (!notifier) {
    throw new Error('BashNotifier not initialized; call initBashNotifier() first')
  }
  return notifier
}

/** Test seam: replace or clear the singleton. */
export function __setBashNotifier(n: BashNotifier | null): void {
  notifier = n
}