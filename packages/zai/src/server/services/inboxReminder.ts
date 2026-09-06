/**
 * Inbox `<system-reminder>` prepend — drain the per-session SessionInbox
 * nextStep lane at the top of `runQueryLoop` and render its contents as a
 * `<system-reminder>` block prepended to the LLM-facing prompt.
 *
 * zai patch (2026-09-06): mirror of opencc-vendor's bg-daemon inbox injection
 * (see packages/zn-agent-core/src/opencc-src/utils/daemon/inboxSection.ts and
 * query.ts:698 buildInboxSystemReminder). Vendor pulls from a cross-process
 * darwin bg-daemon via IPC; zai's SessionInbox is in-process and per-session,
 * so we drain its nextStep lane directly instead.
 *
 * The rendered block is EPHEMERAL — it must NOT be persisted to the
 * transcript (the runtime reads from `params.messages`, not from disk; the
 * transcript persistence path in runQueryLoop continues to receive the
 * unmodified userContent). On reload, the user sees their original prompt
 * verbatim; the reminder is for the in-flight LLM call only.
 *
 * Format mirrors the bullet style of vendor `mailbox.ts:renderInbox` but
 * uses zai's source.kind/form/agentType labels so the LLM can tell where
 * each message came from.
 */
import { getSessionInbox, type InboxMessage } from './sessionInbox.js'

/**
 * Drain the per-session SessionInbox.nextStep lane for `sessionId` and
 * render as a `<system-reminder>...</system-reminder>` block. Returns
 * null when the lane is empty (so callers can short-circuit and avoid
 * invalidating any prompt cache for no reason).
 */
export function drainInboxReminder(sessionId: string): string | null {
  const messages = getSessionInbox(sessionId).consumeNextStep(sessionId)
  return renderInboxReminder(messages)
}

/**
 * Pure renderer for the inbox reminder. Separated from the drainer so
 * tests can exercise formatting without spinning up a SessionInbox.
 * Returns null when `messages` is empty.
 *
 * Content is passed through verbatim — no XML escaping. task-factory
 * and subagent sources emit `<task-command>` / `<task-notification>`
 * XML blocks that the LLM must read as XML; escaping them would mangle
 * the intent. Matches vendor `mailbox.ts:renderInbox` which also does
 * not escape. Callers sending raw text are responsible for their own
 * content shape.
 */
export function renderInboxReminder(messages: InboxMessage[]): string | null {
  if (messages.length === 0) return null

  const bullets = messages.map(renderBullet).join('\n')
  return (
    '<system-reminder>\n' +
    'The following system events occurred since your last turn.\n' +
    'Use this context when responding to the user.\n' +
    '\n' +
    bullets +
    '\n' +
    '</system-reminder>'
  )
}

function renderBullet(msg: InboxMessage): string {
  const content = msg.content
  const kind = msg.source.kind
  const form = msg.source.form

  if (kind === 'subagent' && form === 'notice') {
    const agentType =
      typeof msg.source.agentType === 'string' ? msg.source.agentType : ''
    const label = agentType
      ? `subagent notice (agentType=${agentType})`
      : 'subagent notice'
    return `- ${label}: ${content}`
  }
  if (kind === 'task-factory' && form === 'notice') {
    return `- task-factory notice: ${content}`
  }
  if (kind === 'user' && form === 'steer') {
    return `- follow-up from user: ${content}`
  }
  return `- ${kind} / ${form}: ${content}`
}
