import type { BackgroundTask } from '@zn-ai/zn-agent-core'
import { getSessionInbox, type SessionInbox } from './sessionInbox.js'
import { registerSessionAgent } from './sessionAgentRegistry.js'

/**
 * SubagentNotifier:把 BackgroundRuntime 子 agent 的完成事件回流到父 session。
 *
 * 投递语义(2026-08-17 起):
 *   handle(task) 仅构造 InboxMessage 并 sessionInbox.followup(parentSessionId, msg)。
 *   - idle 且 wakeBudget 预算内 → 入 next-turn lane + wakeHandler,父 session
 *     立刻开新一轮 turn 处理通知;
 *   - busy → followup 自动降级入 next-step lane(原 running 守卫 / flush 暂存的替代),
 *     不唤醒、不与主线并行,turn 结束后由 consumeNextStep 合并到下一条 prompt;
 *   - wakeBudget 耗尽 → 仍入 next-turn,但不再 wake(避免后台连环唤醒)。
 *
 * 通知格式参考 upstream opencc
 * (`opencc/src/tasks/LocalAgentTask/LocalAgentTask.tsx:253-258`):
 *   <task-notification>
 *   <task-id>...</task-id>
 *   <output-file>...</output-file>
 *   <status>completed|failed|cancelled</status>
 *   <summary>Agent "X" completed</summary>
 *   <result>final message</result>
 *   </task-notification>
 *
 * zai patch (2026-09-06): inbox 默认按 `parentSessionId` 走 per-session
 * `getSessionInbox(sid)` 工厂,跨 session 隔离。`opts.inbox` 测试钩子
 * 保留为单实例(测试场景通常一个 mock 就够)。
 */
export interface SubagentNotifierOptions {
  /**
   * 测试钩子:替换为固定的 SessionInbox 实例(默认走
   * `getSessionInbox(parentSessionId)` per-session 工厂)。
   */
  inbox?: SessionInbox
}

let notifier: SubagentNotifier | null = null

export class SubagentNotifier {
  private readonly fixedInbox: SessionInbox | null

  constructor(opts: SubagentNotifierOptions = {}) {
    this.fixedInbox = opts.inbox ?? null
  }

  /**
   * Resolve the inbox for a given session. Returns the test-injected
   * fixed inbox if set, otherwise the per-session instance.
   */
  private inboxFor(sessionId: string): SessionInbox {
    return this.fixedInbox ?? getSessionInbox(sessionId)
  }

  /**
   * onTaskStateChange 钩子。仅在任务进入 terminal 且携带 parentSessionId
   * 时触发,构造 InboxMessage 经 sessionInbox.followup 投递到父 session。
   * 异常仅 console.warn,不让后台回调把 server 弄崩。
   */
  async handle(task: BackgroundTask): Promise<void> {
    if (
      task.status !== 'completed' &&
      task.status !== 'failed' &&
      task.status !== 'cancelled'
    ) {
      return
    }
    const parentSessionId = task.parentSessionId
    if (!parentSessionId) return
    if (parentSessionId === 'sess-unknown') return // 兜底:无父 session 的占位 ID

    // zai patch (2026-09-07, fix-busy-flush-v2-r2, Item C): 在 terminal
    // 事件入口注册 (parentSessionId, task.id) 到 sessionAgentRegistry,
    // 让后续 busyFlush.drainCommandQueueForSession 的 cmd.agentId fallback
    // 能严格校验"这个 agentId 真的属于这个 session", 避免跨 session 误派。
    // 写入点是稳定的 (terminal 时 parentSessionId / task.id 都已 freeze),
    // 不会 race。其它 cron / 第三方 vendor 调用方不走这条, 它们被 fallback
    // 跳过时会 warn log, 提示改造走 zai wrapper。
    registerSessionAgent(parentSessionId, task.id)

    try {
      this.inboxFor(parentSessionId).followup(parentSessionId, {
        id: `bg-${task.id}`,
        source: {
          kind: 'subagent',
          form: 'notice',
          senderSessionId: parentSessionId,
          agentType: task.agentType,
        },
        content: renderTaskNotificationMessage(task),
        createdAt: Date.now(),
      })
    } catch (err) {
      console.warn('[SubagentNotifier] inbox followup failed:', err)
    }
  }
}

/**
 * 构造 <task-notification> 风格 user message 文本。
 * 字段含义对齐 upstream `LocalAgentTask.tsx:253-258`。
 */
export function renderTaskNotificationMessage(task: BackgroundTask): string {
  const statusText = task.status
  const summary =
    task.status === 'completed'
      ? `Sub-agent "${task.description ?? task.id}" completed`
      : task.status === 'failed'
        ? `Sub-agent "${task.description ?? task.id}" failed: ${task.error?.message ?? 'unknown error'}`
        : `Sub-agent "${task.description ?? task.id}" was cancelled`

  // zai patch: 指引主 Agent 用 TaskOutput(task_id) 取最终结果,而不是直接
  // Read output 文件。与 vendor enqueueAgentNotification (LocalAgentTask.tsx)
  // 的 guidance 同构;内联进 summary 避免出现同名并列/嵌套 tag。
  const guidance = '\nUse TaskOutput with task_id to retrieve the final result.'
  const summaryWithGuidance = `${summary}${guidance}`

  // failed 时把 error 信息放在 result 字段里,让模型看到诊断细节
  const resultSection =
    task.status === 'completed' && task.resultText
      ? `\n<result>${escapeXml(task.resultText)}</result>`
      : task.status === 'failed' && task.error
        ? `\n<result>${escapeXml(`[error: ${task.error.message ?? 'unknown'} (${task.error.category ?? 'internal'})]`)}</result>`
        : task.status === 'cancelled'
          ? `\n<result>${escapeXml('[cancelled by user]')}</result>`
          : ''

  return (
    `<task-notification>\n` +
    `<task-id>${escapeXml(task.id)}</task-id>\n` +
    (task.agentType ? `<agent-type>${escapeXml(task.agentType)}</agent-type>\n` : '') +
    (task.description ? `<description>${escapeXml(task.description)}</description>\n` : '') +
    `<status>${statusText}</status>\n` +
    `<summary>${escapeXml(summaryWithGuidance)}</summary>` +
    resultSection +
    `\n</task-notification>`
  )
}

function escapeXml(s: string): string {
  // 防注入:破坏 < > & 让 LLM 看不到伪造标签
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}

/** Initialize the singleton. Idempotent. */
export function initSubagentNotifier(opts: SubagentNotifierOptions = {}): SubagentNotifier {
  if (notifier) return notifier
  notifier = new SubagentNotifier(opts)
  return notifier
}

export function getSubagentNotifier(): SubagentNotifier {
  if (!notifier) {
    throw new Error('SubagentNotifier not initialized; call initSubagentNotifier() first')
  }
  return notifier
}

/** Test seam: replace or clear the singleton. */
export function __setSubagentNotifier(n: SubagentNotifier | null): void {
  notifier = n
}
