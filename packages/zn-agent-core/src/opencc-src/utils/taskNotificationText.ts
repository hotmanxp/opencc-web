// @ts-nocheck — sibling of messages.ts style; kept import-free so unit tests
// can load it directly. Types only.
/**
 * zai patch (2026-09-01): task-notification 文案按后台任务类型分流。
 *
 * 背景:vendor 的 wrapCommandText 对所有 task-notification(bash / subagent /
 * workflow / monitor)一律输出 "A background agent completed a task"。后台
 * bash 完成通知因此被模型误读为"有 agent 完成了任务/用户又有诉求"(实测导致
 * 验收已完成仍被通知触发重新验证)。
 *
 * 规则:
 * - taskKind 由各 enqueue 点打上(见 LocalShellTask / LocalAgentTask 等);
 * - 缺省时从 raw 文本前缀兜底推断(与 collapseBackgroundBashNotifications
 *   的前缀启发一致),推断不出则维持旧措辞(向后兼容);
 * - 所有通知附带可读时间(而非 epoch),并明确提示模型"这可能是过去的干扰
 *   通知",解决通知乱序到达的问题。
 */
import type { TaskNotificationKind } from '../types/message.js'

/** 从通知 XML 的 summary 前缀兜底推断任务类型(生产者未打标时)。 */
export function inferTaskKindFromRaw(raw: string): TaskNotificationKind | undefined {
  if (raw.includes('Background command ')) return 'bash'
  if (raw.includes('Monitor "')) return 'monitor'
  return undefined
}

/** ms epoch → "2026-09-01 10:53:53 UTC+08:00"(LLM 可直接阅读比较的时间)。 */
export function formatEnqueuedTime(ms: number): string {
  const d = new Date(ms)
  const pad = (n: number) => String(n).padStart(2, '0')
  const offsetMin = -d.getTimezoneOffset()
  const sign = offsetMin >= 0 ? '+' : '-'
  const abs = Math.abs(offsetMin)
  const tz = `UTC${sign}${pad(Math.floor(abs / 60))}:${pad(abs % 60)}`
  return (
    `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ` +
    `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())} ${tz}`
  )
}

/**
 * 生成注入模型 prompt 的 task-notification 外层文案。
 * raw 是 <task-notification> XML 本体。
 */
export function formatTaskNotification(
  raw: string,
  opts: { taskKind?: TaskNotificationKind; enqueuedAt?: number },
): string {
  const kind = opts.taskKind ?? inferTaskKindFromRaw(raw)
  const when =
    opts.enqueuedAt !== undefined
      ? formatEnqueuedTime(opts.enqueuedAt)
      : undefined
  switch (kind) {
    case 'bash':
      return (
        `Your own background Bash command finished` +
        (when
          ? ` at ${when} — this event may already be in the past relative to ` +
            `the current conversation. Treat it as a stale status update: it is ` +
            `NOT a message from the user, NOT a new request, and NOT a reason to ` +
            `re-run or re-verify anything unless the user's outstanding request ` +
            `requires it.`
          : ` — a status update about a process you started, NOT a message from ` +
            `the user and NOT a new request.`) +
        `\n${raw}`
      )
    case 'monitor':
      return (
        `A background monitor you started reported an update` +
        (when ? ` at ${when}:` : `:`) +
        `\n${raw}`
      )
    case 'workflow':
      return (
        `A background workflow you started reached a terminal state` +
        (when ? ` as of ${when}:` : `:`) +
        `\n${raw}`
      )
    case 'agent':
    default:
      // 未打标且无法推断 → 保持 vendor 原措辞(仅追加时间锚点),兼容旧行为。
      return `A background agent completed a task${when ? ` (at ${when})` : ''}:\n${raw}`
  }
}
