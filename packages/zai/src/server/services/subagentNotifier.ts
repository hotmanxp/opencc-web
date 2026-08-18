import type { BackgroundTask } from '@zn-ai/zn-agent-core'
import { sessionInbox } from './sessionInbox.js'

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
 */
export interface SubagentNotifierOptions {
  /** 测试钩子:替换为 mock sessionInbox(默认走 module 单例)。 */
  inbox?: typeof sessionInbox
}

let notifier: SubagentNotifier | null = null

export class SubagentNotifier {
  private readonly inbox: typeof sessionInbox

  constructor(opts: SubagentNotifierOptions = {}) {
    this.inbox = opts.inbox ?? sessionInbox
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

    try {
      this.inbox.followup(parentSessionId, {
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
