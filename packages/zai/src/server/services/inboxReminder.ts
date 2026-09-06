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
 * zai patch (2026-09-06, follow-up): the reminder is rendered as PURE ASCII
 * by parsing `<task-notification>...</task-notification>` XML on subagent
 * notices and re-emitting the structured fields as a vendor-isomorphic line
 * (modeled after `packages/zn-agent-core/src/opencc-src/utils/daemon/mailbox.ts:185-202`
 * `renderInboxMessage`). This avoids embedding nested XML inside the outer
 * `<system-reminder>` block — the previous escape-then-passthrough approach
 * caused the model's XML parser to split the reminder early, and pure-
 * character escape made inner XML arrive as `&lt;task-notification&gt;` text
 * the LLM couldn't structurally recognize. Parse + rebuild keeps the inner
 * semantics readable to the model while emitting no `<`/`>` in the bullet.
 *
 * task-factory `<task-command>` notices (and other unrecognized shapes)
 * fall back to a truncated plain-text rendering so the reminder block stays
 * bounded in length.
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
 * Bullets are pure ASCII (no `<` / `>` characters), so the model's
 * XML/SGML parser sees exactly one well-formed `<system-reminder>` block.
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
  const kind = msg.source.kind
  const form = msg.source.form

  // Try parse-and-rebuild for subagent task-notifications so the inner
  // XML is never embedded in the outer <system-reminder> block.
  if (kind === 'subagent' && form === 'notice') {
    const parsed = parseTaskNotification(msg.content)
    if (parsed) {
      return renderParsedTaskNotification(parsed)
    }
    // Not a recognizable task-notification shape — fall back to a
    // truncated plain-text rendering so the reminder stays bounded.
    const fallback = truncateForReminder(msg.content)
    return `- subagent notice: ${fallback}`
  }
  if (kind === 'task-factory' && form === 'notice') {
    // task-factory currently emits <task-command>...</task-command> as a
    // prompt-rebuild signal, not as LLM-facing content. Render the body
    // verbatim in a single truncated line (also bounded).
    return `- task-factory notice: ${truncateForReminder(msg.content)}`
  }
  if (kind === 'user' && form === 'steer') {
    return `- follow-up from user: ${truncateForReminder(msg.content)}`
  }
  return `- ${kind} / ${form}: ${truncateForReminder(msg.content)}`
}

// ---------------------------------------------------------------------------
// Task-notification parsing
// ---------------------------------------------------------------------------

export interface ParsedTaskNotification {
  taskId: string
  status: string
  summary: string
  description?: string
  agentType?: string
  result?: string
}

/**
 * Parse a literal `<task-notification>...</task-notification>` block into
 * structured fields. Returns `null` when the content isn't a recognizable
 * task-notification shape (caller falls back to a plain-text rendering).
 *
 * Field values may contain XML entity references (`&lt;` `&gt;` `&amp;`
 * `"`) — the subagent notifier escapes raw values to keep them from
 * prematurely closing the outer structure; we decode them on read so
 * the bullet text is human/machine readable.
 *
 * Field extraction is regex-based and order-agnostic: any tag order is
 * accepted; missing tags are simply absent from the result.
 */
export function parseTaskNotification(content: string): ParsedTaskNotification | null {
  const wrapped = content.match(
    /<task-notification\b[^>]*>([\s\S]*?)<\/task-notification>/,
  )
  if (!wrapped) return null
  const inner = wrapped[1] ?? ''
  if (!inner) return null

  const taskId = extractTag(inner, 'task-id')
  const status = extractTag(inner, 'status')
  const summary = extractTag(inner, 'summary')
  if (!taskId || !status || !summary) return null

  const description = extractTag(inner, 'description') ?? undefined
  const agentType = extractTag(inner, 'agent-type') ?? undefined
  const result = extractTag(inner, 'result') ?? undefined

  return { taskId, status, summary, description, agentType, result }
}

function extractTag(inner: string, tag: string): string | null {
  // Greedy across lines, non-greedy body. Attribute-tolerant (e.g.
  // `<summary lang="en">`). Body may contain entity references — we
  // decode the common five below so the bullet text reads cleanly.
  const re = new RegExp(`<${tag}\\b[^>]*>([\\s\\S]*?)<\\/${tag}>`, 'i')
  const m = inner.match(re)
  if (!m) return null
  return decodeXmlEntities(m[1])
}

/**
 * Decode the XML entities the subagent notifier emits in field values.
 * Quotes are decoded too — they're safe in pure-ASCII bullet text (we
 * never re-emit the value into XML).
 */
function decodeXmlEntities(s: string): string {
  return s
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&')
}

/**
 * Render a parsed task-notification as a single pure-ASCII bullet.
 * Mirrors vendor `mailbox.ts:renderInboxMessage` in spirit — structured
 * fields, no XML, no embedded newlines.
 *
 *   - subagent `${taskId}` (${agentType}${description ? ', ' + description : ''}) — ${status}: ${summary}
 */
export function renderParsedTaskNotification(p: ParsedTaskNotification): string {
  const meta: string[] = []
  if (p.agentType) meta.push(p.agentType)
  if (p.description) meta.push(p.description)
  const metaStr = meta.length > 0 ? ` (${meta.join(', ')})` : ''
  const summary = collapseWhitespace(p.summary)
  return `- subagent \`${p.taskId}\`${metaStr} - ${p.status}: ${summary}`
}

/**
 * Bound a long content field so the reminder block stays small.
 * 200 chars mirrors the LLM-attention budget for one bullet; we add
 * an ellipsis when truncated.
 */
const REMINDER_CONTENT_MAX = 200

function truncateForReminder(content: string): string {
  const collapsed = collapseWhitespace(content)
  if (collapsed.length <= REMINDER_CONTENT_MAX) return collapsed
  return collapsed.slice(0, REMINDER_CONTENT_MAX) + '...'
}

/** Collapse internal whitespace runs into single spaces and trim. */
function collapseWhitespace(s: string): string {
  return s.replace(/\s+/g, ' ').trim()
}
