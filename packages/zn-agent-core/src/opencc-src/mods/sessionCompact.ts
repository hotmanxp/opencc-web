import type { Message } from '../types/message.js'
import { logForDebugging } from '../utils/debug.js'
import { dispatchModEngineResult, hasModHandlersFor } from './dispatch.js'

/**
 * Upstream `session.compact` — "fires when the conversation is about to be
 * compacted (`/compact`, the threshold, a plugin, or ahead of time)".
 *
 * `SessionCompactTrigger` upstream is `'manual' | 'auto' | 'plugin' |
 * 'precompute'`. opencc reaches two of the four: `/compact` is `manual`, and
 * the token threshold in `autoCompactIfNeeded` is `auto`. There is no
 * `plugin` because `$.session.compact()` is not a noun here — a mod cannot ask
 * for a compaction, only observe or veto one — and no `precompute`, which
 * upstream documents as "the one dispatch that installs nothing: its result is
 * kept for the compaction that comes". Naming either here would tell a hook
 * `{trigger: 'plugin'}` about a compaction no plugin asked for.
 *
 * What is honoured, and what is not, is deliberate and worth stating plainly
 * because upstream's contract has four moving parts:
 *
 *   - `{ skip: reason }`  → honoured. The compaction does not run. This is
 *     the load-bearing half: the one real hook of it in the wild is a veto
 *     (`on("session.compact", {trigger: "precompute"}, () => ({skip: "off"}))`).
 *   - `instructions` / `messages` rewritten on the way down → honoured. Both
 *     are read back out of the event the caller runs on.
 *   - `messages` rewritten on the way UP, or a hook's own `{ messages }` as
 *     the answer → **not** honoured, and deliberately so. opencc's compaction
 *     result is categorised (`boundaryMarker`, `summaryMessages`,
 *     `attachments`, `hookResults`, `messagesToKeep` — see `CompactionResult`),
 *     not the flat post-compaction transcript upstream's `SessionCompacted`
 *     describes. Accepting a bare `{messages}` array here would mean either
 *     dropping the summary/attachment split — a corrupt transcript — or
 *     inventing a mapping that is not upstream's. The honest reading is that
 *     this half needs `buildPostCompactMessages` to be exposed as the
 *     round-trip shape first; until then a hook that tries it sees its answer
 *     ignored, and `logForDebugging` says so rather than letting it wonder.
 */

export type SessionCompactTrigger = 'manual' | 'auto'

/** What the veto function hands back to its caller. */
export type SessionCompactDecision<T> =
  | { type: 'compact'; result: T }
  | { type: 'skipped'; reason: string }

/**
 * Ask the mods whether this compaction may run, and hand back the transcript
 * and instructions they settled on.
 *
 * `run` is NOT called when a hook vetoes — that is the entire point, and it is
 * why the veto sits outside rather than inside a `core` that would run the
 * summariser and then have its result thrown away.
 */
export async function gateSessionCompact<T>(args: {
  trigger: SessionCompactTrigger
  messages: readonly Message[]
  instructions?: string
  agentId?: string
  run: (e: {
    messages: Message[]
    instructions: string | undefined
  }) => Promise<T>
}): Promise<SessionCompactDecision<T>> {
  if (!hasModHandlersFor('session.compact')) {
    return {
      type: 'compact',
      result: await args.run({
        messages: [...args.messages],
        instructions: args.instructions,
      }),
    }
  }

  const answer = await dispatchModEngineResult<
    | { skip?: string; messages?: Message[]; instructions?: string }
    | undefined
  >(
    'session.compact',
    {
      trigger: args.trigger,
      messages: [...args.messages],
      ...(args.instructions !== undefined
        ? { instructions: args.instructions }
        : {}),
      ...(args.agentId !== undefined ? { agentId: args.agentId } : {}),
    },
    // `dispatchModEngineResult`'s terminal is core: the compaction has not run
    // yet, so there is nothing for `next(e)` to resolve to but the event. A
    // hook that awaits `next(e)` gets the transcript and instructions it was
    // handed, which is what upstream's "rewrite `instructions` or `messages`
    // on the way down" needs.
    async current => current,
  )

  const skip = answer?.skip
  if (typeof skip === 'string' && skip !== '') {
    logForDebugging(
      `[mods] session.compact (${args.trigger}) was skipped by a mod: ${skip}`,
    )
    return { type: 'skipped', reason: skip }
  }

  if (answer?.messages !== undefined) {
    logForDebugging(
      '[mods] session.compact: a hook answered with its own `messages`; opencc ' +
        'compacts into a categorised result, not a flat transcript, so the answer ' +
        'is ignored. Return `{ skip }` to veto, or rewrite `messages` on the way down.',
    )
  }

  const messages =
    answer?.messages !== undefined ? [...answer.messages] : [...args.messages]
  const instructions =
    typeof answer?.instructions === 'string'
      ? answer.instructions
      : args.instructions

  return { type: 'compact', result: await args.run({ messages, instructions }) }
}