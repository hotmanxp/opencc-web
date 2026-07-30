/**
 * Bg-daemon inbox → user-message `<system-reminder>` injection.
 *
 * Port of upstream 2.1.177's `G_K` / `InboxPoller` mechanism:
 * - Drain pending bg-daemon inbox messages on every LLM call
 * - Render as a `<system-reminder>...</system-reminder>` XML block
 *   that gets prepended to the user message (NOT the system prompt)
 *
 * Why user message instead of system prompt:
 * - System prompt is part of Anthropic's API prompt cache key. Any
 *   change busts the cache. The reminder text changes whenever a bg
 *   agent completes → would bust the cache every turn.
 * - User-message content is NOT part of the prompt cache. Adding a
 *   reminder doesn't bust the cache; only the system prompt does.
 * - Upstream's `loK(H)` trims `<system-reminder>` blocks from the
 *   start of user messages — same pattern.
 *
 * No-op if the daemon isn't running or the platform isn't darwin.
 */
import { platform } from 'node:process'
import {
  getReplClientId,
  hasEverDispatchedBackgroundAgent,
  renderInbox,
  type InboxMessage,
} from './mailbox.js'
import { DaemonError, requestDaemon } from './socket.js'

/** Module-level cursor: highest inbox id we've already shown the LLM. */
let lastInboxAckThrough = 0

/**
 * Drain the bg-daemon mailbox since the last call. Returns [] if the
 * daemon isn't reachable. Catches all errors and returns [].
 *
 * Scoped to this REPL's `clientId` (stable for process lifetime) so
 * other opencc sessions sharing the daemon are NOT visible here.
 */
export async function drainBgDaemonInbox(): Promise<{
  messages: InboxMessage[]
  highestId: number
}> {
  // Short-circuit: if this REPL has never dispatched a bg agent,
  // there's nothing in the daemon's mailbox for us. Skip the IPC
  // entirely (saves the 2s timeout risk + a few ms per LLM call).
  if (!hasEverDispatchedBackgroundAgent()) {
    return {messages: [], highestId: lastInboxAckThrough}
  }
  if (platform !== 'darwin') {
    return {messages: [], highestId: lastInboxAckThrough}
  }
  // Runtime gate: when the bg-agent feature is disabled, don't
  // touch the daemon socket at all.
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const {isBgAgentRuntimeEnabled} = require('./mailbox.js') as {
    isBgAgentRuntimeEnabled: () => boolean
  }
  if (!isBgAgentRuntimeEnabled()) {
    return {messages: [], highestId: lastInboxAckThrough}
  }
  try {
    const resp = await requestDaemon(
      {
        proto: 1,
        op: 'inbox',
        clientId: getReplClientId(),
        ackThrough: lastInboxAckThrough,
      },
      2000,
    )
    if (!resp.ok || resp.op !== 'inbox') {
      return {messages: [], highestId: lastInboxAckThrough}
    }
    return {
      messages: resp.messages as InboxMessage[],
      highestId: resp.highestId,
    }
  } catch (err) {
    if (err instanceof DaemonError) {
      return {messages: [], highestId: lastInboxAckThrough}
    }
    return {messages: [], highestId: lastInboxAckThrough}
  }
}

/**
 * Build a `<system-reminder>` block wrapping new bg-daemon inbox
 * messages. Returns null when no new messages have arrived since the
 * last turn (preserves the prompt cache). Advances the cursor so
 * the same messages are not re-rendered next turn.
 *
 * Caller should prepend this to the user message (NOT the system
 * prompt) per upstream's `G_K` / `InboxPoller` pattern.
 *
 * Format mirrors upstream 2.1.177: a single `<system-reminder>`
 * element containing the rendered inbox.
 */
export async function buildInboxSystemReminder(): Promise<string | null> {
  const {messages, highestId} = await drainBgDaemonInbox()
  if (messages.length === 0) return null
  if (highestId > lastInboxAckThrough) {
    lastInboxAckThrough = highestId
  }
  const body = renderInbox(messages)
  return `<system-reminder>\n${body}\n</system-reminder>`
}
