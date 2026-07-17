/**
 * Fold top-level `type=tool_use` transcript messages back into their parent
 * assistant message before the API request builder sees them.
 *
 * Background — sess-013f9f87 regression
 * -------------------------------------
 * The transcript v2 protocol persists a single assistant turn (which may
 * contain thinking + N parallel tool_use blocks) as a sequence of top-level
 * `TranscriptMessage` records: one parent `assistant` (content = [
 * thinking ]) plus N children each with `type=tool_use`, `parentUuid=
 * parentAssistantUuid`, and `message.content = [ tool_use block ]`.
 *
 * `appendToolUse` in `transcript/persistence.ts` writes this shape because
 * it appends each tool_use as a separate store record. That is fine for the
 * UI (which walks the parentUuid DAG and re-renders tool_use blocks under
 * their assistant). But `normalizeMessagesForAPI` (the API-prep pipeline
 * reached from `claude.ts`/`openaiShim.ts`) reads messages as a flat array
 * and dispatches on `message.type`. Its switch covers
 * `system | user | assistant | attachment` — there is no `case 'tool_use'`.
 * Top-level `type=tool_use` records silently fall through the default
 * branch and disappear. Their matching user `tool_result` records stay in
 * the array (they go through `case 'user'`), so the request body sent to
 * the model contains `tool_result` blocks whose `tool_use_id` has no
 * corresponding `tool_use` in any preceding assistant content.
 *
 * Anthropic rejects this with HTTP 400, error code 2013:
 *   "invalid params, tool result's tool id(<id>) not found"
 *
 * Fix
 * ---
 * This helper is a pure fold over the (already filtered) messages array:
 * for every record with `type=tool_use` whose `parentUuid` resolves to a
 * retained assistant message, the tool_use blocks from
 * `record.message.content` are appended to the parent assistant message's
 * `message.content` IN ORDER. Records whose parent is not in scope (or
 * whose parent is a non-retained type) are returned as synthesized
 * standalone assistant messages — never silently dropped, so that a
 * misuse here is visible (Anthropic will 400 anyway, but at least the
 * transcript rewrite is reproducible).
 *
 * The function is intentionally side-effect-free so it can be unit-tested
 * without dragging in the analytics service chain that
 * `utils/messages.ts` pulls in (which breaks the bun test resolver with
 * `src/services/analytics/index.js` path-style imports).
 */

export type FoldableContentBlock = {
  type: string
  id?: string
  tool_use_id?: string
  name?: string
  input?: unknown
  thinking?: string
  text?: string
  [extra: string]: unknown
}

/**
 * Minimal shape we need from a transcript record. Defined inline so the
 * helper does not have to import from the heavy utils/messages.ts module
 * (which transitively imports src/services/analytics/...).
 */
export type FoldableMessage = {
  uuid: string
  parentUuid?: string | null
  type: string
  message?: {
    content?: FoldableContentBlock[] | string
  }
  [extra: string]: unknown
}

const isToolUseBlock = (b: FoldableContentBlock): boolean =>
  b.type === 'tool_use' && typeof b.id === 'string'

const isAssistantLike = (m: FoldableMessage): boolean =>
  m.type === 'assistant'

const getBlocks = (m: FoldableMessage): FoldableContentBlock[] => {
  const c = m.message?.content
  if (!Array.isArray(c)) return []
  return c
}

const clonedBlocks = (blocks: FoldableContentBlock[]): FoldableContentBlock[] =>
  blocks.map(b => ({ ...b }))

/**
 * Walk `messages` in order and fold every top-level `type=tool_use` record
 * into the assistant message it references via `parentUuid`.
 *
 * Behaviour:
 * - An assistant message that already exists in the input keeps its
 *   original blocks. Tool_use blocks from its children are appended to its
 *   `message.content` AFTER all existing blocks, in source order.
 * - A `type=tool_use` record whose `parentUuid` does not resolve to a
 *   retained assistant message is converted into a standalone assistant
 *   message at the same index the tool_use occupied. This preserves
 *   audit visibility — the operator can observe the orphan in logs
 *   instead of silently losing tool_use blocks.
 * - The function returns a new array; the input is not mutated. Existing
 *   blocks of retained parent messages are also deep-cloned, so the
 *   returned `parent.message.content` array does not share references
 *   with the input.
 */
export function foldTopLevelToolUses<T extends FoldableMessage>(
  messages: T[],
): T[] {
  const byUuid = new Map<string, T>()
  for (const m of messages) {
    if (typeof m.uuid === 'string') byUuid.set(m.uuid, m)
  }

  // Collect children grouped by parent uuid, in source order.
  const childrenByParent = new Map<string, T[]>()

  for (const m of messages) {
    if (m.type === 'tool_use' && typeof m.parentUuid === 'string') {
      const existing = childrenByParent.get(m.parentUuid)
      if (existing) {
        existing.push(m)
      } else {
        childrenByParent.set(m.parentUuid, [m])
      }
    }
  }

  // Walk the input once, emitting per-position output. When we encounter
  // a retained (non-tool_use) record we either emit it as-is, or, if it is
  // an assistant message with children waiting on it, we emit a deep-cloned
  // version whose `message.content` includes the children's tool_use
  // blocks.
  const out: T[] = []
  for (let i = 0; i < messages.length; i++) {
    const m = messages[i]
    if (m.type === 'tool_use') {
      const parent = byUuid.get(m.parentUuid ?? '')
      if (parent && isAssistantLike(parent)) {
        // This tool_use is a child of an assistant we will see later (or
        // have already seen — both are handled: when seen, the assistant
        // emission already appended all children via childrenByParent).
        // De-duplicate emission so the tool_use does not produce a second
        // synthetic message in addition to the parent's already-merged
        // version. We do this by tracking which parent uuid we have
        // already emitted in this pass.
        continue
      }
      // Orphan: no parent assistant. Reify as a standalone assistant.
      out.push({
        ...m,
        type: 'assistant',
        message: {
          ...(m.message ?? {}),
          content: clonedBlocks(getBlocks(m)),
        },
      } as T)
      continue
    }

    if (isAssistantLike(m)) {
      const children = childrenByParent.get(m.uuid) ?? []
      const toolUseBlocks = children
        .flatMap(c => getBlocks(c))
        .filter(isToolUseBlock)
      if (toolUseBlocks.length === 0) {
        out.push(m)
        continue
      }
      const parentBlocks = getBlocks(m)
      const seen = new Set<string>()
      const merged: FoldableContentBlock[] = clonedBlocks(parentBlocks)
      for (const b of merged) if (b.id) seen.add(b.id)
      for (const b of toolUseBlocks) {
        if (b.id && seen.has(b.id)) continue
        merged.push({ ...b })
        if (b.id) seen.add(b.id)
      }
      out.push({
        ...(m as object),
        message: {
          ...(m.message ?? {}),
          content: merged,
        },
      } as T)
      continue
    }

    out.push(m)
  }

  return out
}
