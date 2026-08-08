/**
 * Bg daemon mailbox protocol — port of upstream 2.1.177's
 * teammate lifecycle / idle-notification system, simplified for the
 * bg-daemon use case.
 *
 * The daemon appends `InboxMessage`s to per-clientId inboxes when a
 * background agent finishes (or is killed, or fails to spawn). The
 * REPL drains its inbox on every LLM call and injects the messages
 * as a `<system-reminder>` block prepended to the user message
 * (port of upstream's `G_K` / `InboxPoller`), so the LLM naturally
 * sees bg-agent completions and can call
 * `BackgroundAgentResult(shortId)` to fetch the output.
 *
 * Per-clientId isolation: the REPL process's `getReplClientId()` is
 * embedded in `job.sessionId` on dispatch, and the daemon scopes
 * the broadcast to the matching inbox. Other opencc sessions
 * sharing the daemon do NOT see this session's events.
 *
 * Field names match upstream 2.1.177 verbatim where applicable; the
 * "bg" overlay and per-clientId routing are OpenCC-specific.
 *
 * @see docs/superpowers/plans/2026-06-13-plan-bg-agent-view.md §T5
 * @see https://github.com/anthropics/claude-code 2.1.177 (upstream)
 */
import { randomUUID } from 'node:crypto'
import { z } from 'zod/v4'

// ---------- Idle notification ----------
//
// Emitted when a background agent becomes idle (finished, killed, or
// failed). The main LLM is expected to inspect `completedTaskId` and
// follow up with `BackgroundAgentResult(shortId)` if it needs the
// captured stdout/stderr.

export const IdleReasonSchema = z.enum(['available', 'interrupted', 'failed'])
export type IdleReason = z.infer<typeof IdleReasonSchema>

export const CompletedStatusSchema = z.enum(['resolved', 'blocked', 'failed'])
export type CompletedStatus = z.infer<typeof CompletedStatusSchema>

export const IdleNotificationSchema = z.object({
  type: z.literal('idle_notification'),
  /** Short ID of the background agent that just went idle. */
  from: z.string(),
  timestamp: z.string(),
  idleReason: IdleReasonSchema.optional(),
  /** Short human-readable summary (e.g., the label or first 80 chars of the prompt). */
  summary: z.string().optional(),
  /** The 8-hex `shortId` of the completed job; pass to `BackgroundAgentResult`. */
  completedTaskId: z.string().optional(),
  completedStatus: CompletedStatusSchema.optional(),
  failureReason: z.string().optional(),
})
export type IdleNotification = z.infer<typeof IdleNotificationSchema>

// ---------- Task completed ----------

export const TaskCompletedSchema = z.object({
  type: z.literal('task_completed'),
  from: z.string().optional(),
  taskId: z.string(),
  taskSubject: z.string().optional(),
  timestamp: z.string().optional(),
})
export type TaskCompleted = z.infer<typeof TaskCompletedSchema>

// ---------- Union ----------
//
// Both messages share enough shape that downstream consumers can
// branch on `type` and read whichever fields are present. Use
// `discriminatedUnion` so zod narrows correctly.
//
// The `id` field is server-side metadata (assigned by the daemon
// when appending to a mailbox), NOT in the canonical zod schema.
// We expose it as a separate `id` field on the wire format that
// downstream consumers can use for ack cursoring.

export const InboxMessageSchema = z.discriminatedUnion('type', [
  IdleNotificationSchema,
  TaskCompletedSchema,
])
export type InboxMessage = z.infer<typeof InboxMessageSchema>

/** Wire shape: InboxMessage + server-assigned `id` for ack cursoring. */
export type InboxMessageWithId = InboxMessage & {id: number}

/**
 * Generate a stable clientId for a REPL process. Used by the
 * BackgroundAgent tool (to populate `job.sessionId` on dispatch) and
 * by `buildInboxSystemReminder` (to scope inbox queries). Persists
 * for the lifetime of the process so all dispatches and inbox
 * queries from the same REPL are scoped to the same daemon-side
 * mailbox — preventing cross-session message leaks.
 *
 * Format: OpenCC-specific UUID v4 (upstream uses appState-side
 * identity, which is implicit per REPL process; we make it explicit
 * for the daemon's per-clientId mailbox routing).
 */
let cachedClientId: string | null = null
export function getReplClientId(): string {
  if (cachedClientId === null) {
    cachedClientId = randomUUID()
  }
  return cachedClientId
}

/**
 * Track whether this REPL process has ever dispatched a background
 * agent. When false, `buildInboxSystemReminder` short-circuits —
 * no daemon IPC, no IPC-timeout risk, no overhead for users who
 * never use the bg tool. Flips to true on the first
 * `BackgroundAgent` dispatch (and stays true for the process
 * lifetime; cheap, no need to flip back when jobs complete).
 */
let hasDispatchedBackgroundAgent = false
export function markBackgroundAgentDispatched(): void {
  hasDispatchedBackgroundAgent = true
}
export function hasEverDispatchedBackgroundAgent(): boolean {
  return hasDispatchedBackgroundAgent
}

/**
 * Runtime gate for all bg-agent / daemon features. Mirrors the
 * upstream 2.1.177 `isAgentViewEnabled` semantics: any single
 * disable signal hides every bg-related entry point.
 *
 * Used by:
 *   - `BackgroundAgentTool.isEnabled()` + `BackgroundAgentResultTool.isEnabled()`
 *     → buildTool filter strips them from the available tools list
 *   - `/background` slash command registration
 *   - `claude bg-agents` CLI subcommand
 *   - `claude daemon` supervisor (refuses to start with helpful msg)
 *   - `query.ts` user-message `<system-reminder>` injection (skip)
 *   - `inboxSection.ts` drain (skip)
 *
 * When disabled, every one of those surfaces either returns
 * "feature disabled" or silently no-ops — the LLM doesn't even
 * know the tools exist.
 */
export function isBgAgentRuntimeEnabled(): boolean {
  // Lazy require to avoid a module-level settings import cycle.
  // (mailbox.ts is imported by tools, which load early; pulling in
  // settings here would force a load before bootstrap.)
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const {isAgentViewEnabled} = require('../settings/agentView.js') as {
    isAgentViewEnabled: (s: {enableAgentView?: boolean}) => boolean
  }
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const {getInitialSettings} = require('../settings/settings.js') as {
    getInitialSettings: () => {enableAgentView?: boolean}
  }
  try {
    return isAgentViewEnabled(getInitialSettings())
  } catch {
    // If settings aren't bootstrapped yet (e.g., during early module
    // load), default-on. The next call will re-evaluate.
    return true
  }
}

// ---------- Renderers ----------
//
// Lightweight text rendering for the "Recent daemon messages" system
// prompt section. Kept here (not in the REPL) so upstream-port
// compatibility is testable in isolation.

const IDLE_REASON_LABEL: Record<IdleReason, string> = {
  available: 'completed normally',
  interrupted: 'interrupted (killed by user or REPL exit)',
  failed: 'failed to start or crashed',
}

const COMPLETED_STATUS_LABEL: Record<CompletedStatus, string> = {
  resolved: 'resolved',
  blocked: 'blocked',
  failed: 'failed',
}

/**
 * Render an inbox message to a single human-readable line for the
 * system prompt. `completedTaskId` is wrapped in backticks so the LLM
 * can spot it as the handle to pass to `BackgroundAgentResult`.
 */
export function renderInboxMessage(msg: InboxMessage): string {
  if (msg.type === 'idle_notification') {
    const reason = msg.idleReason
      ? ` (${IDLE_REASON_LABEL[msg.idleReason]})`
      : ''
    const status = msg.completedStatus
      ? ` — ${COMPLETED_STATUS_LABEL[msg.completedStatus]}`
      : ''
    const fail = msg.failureReason ? ` — ${msg.failureReason}` : ''
    const taskId = msg.completedTaskId ? ` \`${msg.completedTaskId}\`` : ''
    const summary = msg.summary ? `: ${msg.summary}` : ''
    return `- bg agent ${taskId}${reason}${status}${fail}${summary}`
  }
  // task_completed
  const taskId = `\`${msg.taskId}\``
  const subject = msg.taskSubject ? ` (${msg.taskSubject})` : ''
  return `- bg agent ${taskId}${subject} completed`
}

/** Render an inbox of messages as a single system-prompt section body. */
export function renderInbox(messages: InboxMessage[]): string {
  if (messages.length === 0) return ''
  const lines = [
    '## Recent daemon messages',
    '',
    'Background agent activity since your last turn. If a job you spawned is',
    'listed here, call `BackgroundAgentResult(shortId)` to read its captured',
    'output (the log file at `~/.zai/background/<shortId>.log`).',
    '',
  ]
  for (const m of messages) {
    lines.push(renderInboxMessage(m))
  }
  return lines.join('\n')
}
