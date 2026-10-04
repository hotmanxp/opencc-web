import { createUserMessage } from '../../utils/messages.js'
import type { Message, UserMessage } from '../../types/message.js'

/**
 * Collapse a repeated skill invocation instead of re-injecting the whole body.
 *
 * A skill invoked twice with identical arguments produces byte-identical
 * instructions. Sending them twice wastes context and — worse — invites the
 * model to act on a stale copy after the first has been superseded. Ported from
 * upstream's `Be`.
 *
 * Two outcomes:
 *  - The prior copy was truncated by compaction → the model no longer has the
 *    full text, so keep the body and prepend a note saying so.
 *  - Otherwise the body is already in context → replace it with one line.
 */

/** Byte-identical to compact.ts's SKILL_TRUNCATION_MARKER; kept in sync by hand. */
const COMPACTION_TRUNCATION_SUFFIX =
  '\n\n[... skill content truncated for compaction; use Read on the skill path if you need the full text]'

/**
 * Text of a synthetic (isMeta) user message, or null if this is not one.
 * Ported from upstream's `pin`.
 */
function pinMetaUserText(message: Message): string | null {
  if (message.type !== 'user' || !(message as UserMessage).isMeta) return null
  const content = (message as UserMessage).message.content
  if (typeof content === 'string') return content
  const textBlocks = content.filter(
    (block): block is { type: 'text'; text: string } => block.type === 'text',
  )
  // A meta message with a non-text block carries something other than the
  // skill body; comparing it as text would produce a false match.
  if (textBlocks.length !== content.length) return null
  return textBlocks.map(block => block.text).join('\n\n')
}

/** Where the prior copy of this skill lives, if it is still around. */
type PriorLocation = 'body' | 'attachment' | null

/**
 * Scan backwards for an earlier copy of the skill. Ported from upstream's
 * `Wlt`.
 *
 * The `attachment` branch is retained for parity, but in OpenCC invoked_skills
 * attachments only originate from the compaction path, so `body` is what
 * normally matches.
 */
function findPriorContent(
  contextMessages: Message[],
  priorContent: string,
): PriorLocation {
  // Scanned in full before returning, mirroring upstream: a body hit wins
  // outright, and an attachment hit is only reported when the body was never
  // seen. `sawAttachment` is function-local — a module-level flag would leak
  // across concurrent invocations.
  let sawAttachment = false
  for (let i = contextMessages.length - 1; i >= 0; i--) {
    const message = contextMessages[i]!
    if (message.type === 'attachment') {
      const attachment = (
        message as unknown as {
          attachment?: { type?: string; skills?: { content?: string }[] }
        }
      ).attachment
      if (
        !sawAttachment &&
        attachment?.type === 'invoked_skills' &&
        attachment.skills?.some(skill => skill.content === priorContent)
      ) {
        sawAttachment = true
      }
      continue
    }
    if (pinMetaUserText(message) === priorContent) return 'body'
  }
  return sawAttachment ? 'attachment' : null
}

export type ElideReinvocationArgs = {
  messages: Message[]
  contextMessages: Message[]
  commandName: string
  args: string | undefined
  priorContent: string | undefined
  renderedContent: string | undefined
}

export function elideReinvocation({
  messages,
  contextMessages,
  commandName,
  args,
  priorContent,
  renderedContent,
}: ElideReinvocationArgs): Message[] {
  // Never elide the first invocation — there is nothing to collapse against.
  if (!priorContent || !renderedContent) return messages

  const priorLocation = findPriorContent(contextMessages, priorContent)
  if (!priorLocation) return messages

  const argsSuffix = args ? ` Arguments: ${args}` : ''

  // Content changed (new args, or dynamic output): the body is not redundant,
  // so keep it and explain that this is a re-invocation.
  if (priorContent !== renderedContent) {
    const note = priorContent.endsWith(COMPACTION_TRUNCATION_SUFFIX)
      ? `Re-invocation of /${commandName} — the previously loaded copy was truncated by compaction; the full instructions follow.`
      : `Re-invocation of /${commandName} — the skill instructions were previously loaded; the arguments or dynamic output below are new.`
    return [createUserMessage({ content: note, isMeta: true }) as Message, ...messages]
  }

  // Byte-identical: replace the body with a pointer to the copy already above.
  const replacement =
    priorLocation === 'attachment'
      ? `Skill /${commandName} was loaded earlier (see the invoked-skills reminder above); this is a NEW invocation — follow those instructions now, including any setup steps.${argsSuffix}`
      : `Skill /${commandName} is already loaded above; instructions unchanged.${argsSuffix}`

  let replaced = false
  return messages.map(message => {
    if (pinMetaUserText(message) !== renderedContent) return message
    replaced = true
    return createUserMessage({ content: replacement, isMeta: true }) as Message
  })
}
