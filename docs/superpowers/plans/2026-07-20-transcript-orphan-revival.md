# Transcript Orphan tool_use Revival Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the existing orphan-bail-out behavior in `repairTranscriptToolPairs` with the §6a "orphan revival" algorithm, add `synthesizedOrphanToolUseIds` to the repair report, and expose the new field through the `/api/transcript/:sessionId/repair` endpoint and its UI consumer.

**Architecture:** Modify `packages/zai-agent-core/src/transcript/repair.ts` so orphan `tool_use` records (those whose `parentUuid` is missing from the active chain OR whose parent's type is not `assistant`) are re-attached to the most recent active-chain assistant that appears in source-array order before the orphan. Each revived orphan gets the existing `is_error: true` recovery record, with its tool_use id reported in a NEW `synthesizedOrphanToolUseIds` field. The existing `synthesizedToolUseIds` field continues to track active-chain orphans only.

**Tech Stack:** TypeScript, vitest, proper-lockfile (via store), Express (route). No new dependencies.

## Global Constraints

- Do NOT touch the modified files in the current working tree: `packages/zai/src/web/src/pages/Agent.tsx`, untracked `packages/zai-agent-core/test_repair_session.mjs`, untracked `packages/zai/src/web/src/components/transcript/MessageBubble.tsx`.
- Runtime tests run with `pnpm vitest run test/transcript/` from `packages/zai-agent-core`.
- Typecheck runs with `pnpm typecheck` from `packages/zai-agent-core`.
- The repair entry point signature must remain `repairTranscriptToolPairs(messages: TranscriptMessage[]) => TranscriptRepairResult` and `repairAndPersistTranscript(store, sessionId): Promise<TranscriptRepairResult>`.
- The recovery text in `is_error: true` tool_result blocks remains `'Transcript repair: tool execution did not complete.'` (existing constant `RECOVERY_TEXT`).
- queryLoop.ts:189-194 already logs `...repaired.report` under `ZAI_DEBUG=1` — adding a new field is automatically picked up there.
- Orphan revival only folds the `tool_use` record itself, not its sub-chain. (Spec §6a step 3: "为何不复制整个 orphan 子链".)
- `synthesizedOrphanToolUseIds` is UI/log-disambiguating; the existing `synthesizedToolUseIds` field must NOT include orphan-revived tools (decision #3).

---

## File Structure

| Path | Change | Responsibility |
|------|--------|----------------|
| `packages/zai-agent-core/src/transcript/repair.ts` | modify | Add `synthesizedOrphanToolUseIds` to `TranscriptRepairReport`; replace orphan-bail-out with orphan-revival logic at §6a |
| `packages/zai-agent-core/test/transcript/repair-orphan.test.ts` | create | Five spec §6a tests: single orphan revival, multi-orphan grouping, no-anchor bail-out, in-chain-non-assistant parent revival, post-revival validProtocol |
| `packages/zai-agent-core/test/transcript/repair.test.ts` | modify | Update "skips all repair when a tool_use parent is not an assistant in the active chain" test (line 130) to reflect new revival semantics; update "does not mutate input" test (line 158) which still passes |
| `packages/zai-agent-core/test/transcript/repair-persistence.test.ts` | modify | Add a test that an orphan-revived transcript persists under file lock and remains idempotent on second call |
| `packages/zai/src/server/routes/transcript.ts` | modify | Add `synthesizedOrphanToolUseIds` to the `/api/transcript/:sessionId/repair` JSON response |
| `packages/zai/src/web/src/components/AgentInputBox.tsx` | modify | Extend the typed response to read `synthesizedOrphanToolUseIds` and surface a separate toast line for orphans (so users can distinguish "active chain synthesized" from "orphan branch revived") |

(Per Glob result: `AgentInputBox.tsx` already exists with code at line 670-694 reading `data.synthesizedToolUseIds`. This file IS NOT in the protected uncommitted-file list — its only modification is `M`. Safe to edit. The OTHER modified file `packages/zai/src/web/src/pages/Agent.tsx` is protected and must be left alone.)

---

### Task 1: Add `synthesizedOrphanToolUseIds` to the repair report type

**Files:**
- Modify: `packages/zai-agent-core/src/transcript/repair.ts:3-8` (TranscriptRepairReport type), and the two bail-out paths at lines 144 and 238 that return empty reports
- Test: `packages/zai-agent-core/test/transcript/repair.test.ts` (existing tests will continue passing; the type widening does not break them)

**Interfaces:**
- Consumes: existing report typing.
- Produces: `TranscriptRepairReport.synthesizedOrphanToolUseIds: string[]` field; empty array `[]` in both bail-out returns.

- [ ] **Step 1: Update the type and bail-out returns**

Edit `repair.ts:3-8`:

```ts
export type TranscriptRepairReport = {
  repaired: boolean
  repairedToolUseIds: string[]
  synthesizedToolUseIds: string[]
  synthesizedOrphanToolUseIds: string[]
  droppedMessageUuids: string[]
}
```

Edit `repair.ts:144` (orphan bail-out) and `repair.ts:238` (validProtocol bail-out) to include `synthesizedOrphanToolUseIds: []` in the returned reports:

```ts
report: { repaired: false, repairedToolUseIds: [], synthesizedToolUseIds: [], synthesizedOrphanToolUseIds: [], droppedMessageUuids: [] },
```

- [ ] **Step 2: Run existing tests to verify they still pass**

Run: `cd packages/zai-agent-core && pnpm vitest run test/transcript/repair.test.ts test/transcript/repair-persistence.test.ts`
Expected: PASS (7 + 3 = 10 tests). The existing `'skips all repair when a tool_use parent is not an assistant in the active chain'` test will now FAIL because the bail-out was replaced — that is expected; we will update it in Task 3.

If the test fails with the spec's desired behavior (the test currently expects the bail-out), that is expected; we will rewrite it in Task 3.

- [ ] **Step 3: Commit**

```bash
git add packages/zai-agent-core/src/transcript/repair.ts
git commit -m "feat(transcript): add synthesizedOrphanToolUseIds to repair report"
```

---

### Task 2: Implement orphan revival algorithm in `repairTranscriptToolPairs`

**Files:**
- Modify: `packages/zai-agent-core/src/transcript/repair.ts:136-146` (orphan bail-out) → replace with revival; extend result building at `repair.ts:243-251` to populate `synthesizedOrphanToolUseIds`.

**Interfaces:**
- Consumes: the full message list and DAG indexes already built above.
- Produces: a `reviveOrphans` helper function and an additional pass that:
  1. Identifies orphan tool_use records (§6a definition).
  2. For each, selects an "anchor" assistant from the active chain whose source-array index is less than the orphan's index.
  3. If no anchor exists, the original bail-out applies (§6a step 1).
  4. Treats the anchor assistant's `childrenByParent.get(anchor.uuid)` list as if the orphan were a child, so the existing §4-7 logic synthesizes the recovery.
  5. Tracks recovered orphan tool_use ids into `synthesizedOrphanToolUseIds`.

- [ ] **Step 1: Write the failing tests**

Create the new test file at `packages/zai-agent-core/test/transcript/repair-orphan.test.ts` covering all five §6a cases:

```ts
import { describe, expect, it } from 'vitest'
import type { AnthropicMessage, TranscriptMessage } from '../../src/transcript/types.js'
import { repairTranscriptToolPairs } from '../../src/transcript/repair.js'

type MessageContent = AnthropicMessage['content']

const record = (
  uuid: string,
  type: TranscriptMessage['type'],
  content: MessageContent,
  parentUuid: string | null = null,
): TranscriptMessage => ({
  uuid,
  parentUuid,
  timestamp: Number(uuid.replace(/\D/g, '') || 1),
  cwd: '/x',
  userType: 'zai',
  sessionId: 's',
  version: '2',
  isSidechain: false,
  raw: null,
  type,
  message: { role: type === 'assistant' || type === 'tool_use' ? 'assistant' : 'user', content },
})

describe('repairTranscriptToolPairs orphan revival (spec §6a)', () => {
  it('revives a single orphan tool_use whose parentUuid is not on the active chain', () => {
    // a1 (assistant) is the active anchor; u900 (user, "continue") is a sibling
    // branch that became the active leaf; t1 is orphan (parent = u900, off the
    // active chain since u900 is not assistant). orphan revival should attach
    // t1 under a1 with a synthesized is_error tool_result.
    const a1 = record('a1', 'assistant', [])
    const orphanTool = record(
      't1',
      'tool_use',
      [{ type: 'tool_use', id: 'call-orphan-1', name: 'Bash', input: {} }],
      'u900',
    )
    const siblingResult = record(
      'r1',
      'user',
      [{ type: 'tool_result', tool_use_id: 'call-orphan-1', content: 'done', is_error: false }],
      't1',
    )
    const u900 = record('u900', 'user', 'continue', 'a1')

    const result = repairTranscriptToolPairs([a1, orphanTool, siblingResult, u900])

    expect(result.report.repaired).toBe(true)
    expect(result.report.synthesizedOrphanToolUseIds).toEqual(['call-orphan-1'])
    // orphan revived under a1 — its synthesized result message immediately follows.
    const types = result.messages.map(m => m.type)
    expect(types.indexOf('tool_use')).toBeGreaterThan(-1)
    // The revived tool is now under a1, so the result block must reference
    // an assistant anchor (parent → a1 or a descendant that precedes the result).
    const lastResult = result.messages.find(m =>
      Array.isArray(m.message?.content)
      && (m.message?.content as Array<{ type?: string }>).some(b => b.type === 'tool_result'),
    )
    expect(lastResult).toBeDefined()
    expect(lastResult?.message?.role).toBe('user')
    const blocks = lastResult?.message?.content as Array<{ type: string; is_error?: boolean; tool_use_id?: string }>
    expect(blocks.some(b => b.type === 'tool_result' && b.tool_use_id === 'call-orphan-1' && b.is_error === true)).toBe(true)
  })

  it('revives multiple orphans and groups their synthesized results into one user record', () => {
    const a1 = record('a1', 'assistant', [])
    const orphanA = record('t1', 'tool_use', [{ type: 'tool_use', id: 'orphan-a', name: 'Bash', input: {} }], 'u900')
    const orphanB = record('t2', 'tool_use', [{ type: 'tool_use', id: 'orphan-b', name: 'Read', input: {} }], 'u900')
    const u900 = record('u900', 'user', 'continue', 'a1')

    const result = repairTranscriptToolPairs([a1, orphanA, orphanB, u900])

    expect(result.report.repaired).toBe(true)
    expect(result.report.synthesizedOrphanToolUseIds.sort()).toEqual(['orphan-a', 'orphan-b'])
    // Exactly one user record carrying both tool_result blocks.
    const userResults = result.messages.filter(m => {
      const c = m.message?.content
      return Array.isArray(c) && (c as Array<{ type?: string }>).some(b => b.type === 'tool_result')
    })
    expect(userResults).toHaveLength(1)
    const ids = (userResults[0].message?.content as Array<{ tool_use_id: string }>).map(b => b.tool_use_id)
    expect(ids.sort()).toEqual(['orphan-a', 'orphan-b'])
  })

  it('keeps the bail-out behavior when an orphan appears before any active-chain assistant', () => {
    const orphanTool = record(
      't1',
      'tool_use',
      [{ type: 'tool_use', id: 'orphan-no-anchor', name: 'Bash', input: {} }],
      'root1',
    )
    const root = record('root1', 'user', 'orphan happened first', null)

    const input = [root, orphanTool]
    const result = repairTranscriptToolPairs(input)

    expect(result.report).toEqual({
      repaired: false,
      repairedToolUseIds: [],
      synthesizedToolUseIds: [],
      synthesizedOrphanToolUseIds: [],
      droppedMessageUuids: [],
    })
    expect(result.messages).toEqual(input.map(m => structuredClone(m)))
  })

  it('revives an in-chain orphan whose parent type is not assistant', () => {
    // The orphan's parentUuid IS on the active chain, but its parent is a
    // user/system/tool_use record (not an assistant). Revival should still
    // attach it to the most recent anchor assistant appearing earlier.
    const a1 = record('a1', 'assistant', [{ type: 'text', text: 'plan' }])
    const userMid = record('u1', 'user', 'mid prompt', 'a1')
    const orphanTool = record(
      't1',
      'tool_use',
      [{ type: 'tool_use', id: 'orphan-mid', name: 'Bash', input: {} }],
      'u1',
    )

    const result = repairTranscriptToolPairs([a1, userMid, orphanTool])

    expect(result.report.repaired).toBe(true)
    expect(result.report.synthesizedOrphanToolUseIds).toEqual(['orphan-mid'])
    // Orphan revived under a1; the user prompt u1 still appears after the
    // assistant's tool_pair group.
    const types = result.messages.map(m => m.type)
    const tIdx = types.indexOf('tool_use')
    const uIdx = types.indexOf('user')
    expect(tIdx).toBeLessThan(uIdx)
  })

  it('protocol remains valid after orphan revival', () => {
    const a1 = record('a1', 'assistant', [])
    const orphanA = record('t1', 'tool_use', [{ type: 'tool_use', id: 'orphan-a', name: 'Bash', input: {} }], 'u900')
    const orphanB = record('t2', 'tool_use', [{ type: 'tool_use', id: 'orphan-b', name: 'Read', input: {} }], 'u900')
    const u900 = record('u900', 'user', 'continue', 'a1')

    const result = repairTranscriptToolPairs([a1, orphanA, orphanB, u900])
    expect(result.report.repaired).toBe(true)

    // Re-running on already repaired messages must be idempotent (no further changes).
    const second = repairTranscriptToolPairs(result.messages)
    expect(second.report.repaired).toBe(false)
  })
})
```

- [ ] **Step 2: Run the new test file to verify the new algorithm doesn't exist**

Run: `cd packages/zai-agent-core && pnpm vitest run test/transcript/repair-orphan.test.ts`
Expected: 5 FAILURES (orphan revival not yet implemented; current code bails out).

- [ ] **Step 3: Implement orphan revival in `repair.ts`**

Modify `packages/zai-agent-core/src/transcript/repair.ts`. The structure is:

1. Remove the early-return at `repair.ts:136-146` (the existing orphan bail-out).
2. Before the existing chain-building loop (currently at `repair.ts:158`), insert a revival pass that:

```ts
  // ---- orphan revival (spec §6a) ---------------------------------------
  // Orphan tool_use records have either:
  //   - parentUuid not on the active chain, or
  //   - parentUuid on the chain but parent's type !== 'assistant'.
  // We re-attach each orphan to the most recent active-chain assistant that
  // appears in source-array order before the orphan. The orphan's tool_use
  // id is added to `synthesizedOrphanToolUseIds`; downstream §4-6 logic
  // synthesizes the recovery result.
  const revivedAnchors = new Map<string, TranscriptMessage[]>()
  for (let index = 0; index < messages.length; index += 1) {
    const message = messages[index]
    if (message.type !== 'tool_use') continue
    const parent = message.parentUuid ? byUuid.get(message.parentUuid) : undefined
    const parentOnChain = message.parentUuid ? chainUuids.has(message.parentUuid) : false
    const parentIsAssistant = parent?.type === 'assistant'
    if (parentOnChain && parentIsAssistant) continue

    // No anchor available when there's no assistant earlier than this
    // orphan on the active chain.
    const anchor = [...chain]
      .reverse()
      .find(candidate => candidate.type === 'assistant' && (originalIndex.get(candidate.uuid) ?? 0) < index)
    if (!anchor) {
      return {
        messages: original,
        report: {
          repaired: false,
          repairedToolUseIds: [],
          synthesizedToolUseIds: [],
          synthesizedOrphanToolUseIds: [],
          droppedMessageUuids: [],
        },
      }
    }
    const list = revivedAnchors.get(anchor.uuid) ?? []
    list.push(message)
    revivedAnchors.set(anchor.uuid, list)
  }
```

3. Inside the existing chain loop (at `repair.ts:169`), extend the children list with revived orphans. Replace:

```ts
    const children = (childrenByParent.get(message.uuid) ?? [])
      .filter(child => child.type === 'tool_use')
      .sort((left, right) => (originalIndex.get(left.uuid) ?? 0) - (originalIndex.get(right.uuid) ?? 0))
```

with:

```ts
    const children = [
      ...(childrenByParent.get(message.uuid) ?? []),
      ...(revivedAnchors.get(message.uuid) ?? []),
    ]
      .filter(child => child.type === 'tool_use')
      .sort((left, right) => (originalIndex.get(left.uuid) ?? 0) - (originalIndex.get(right.uuid) ?? 0))
```

4. After the existing `groupedResults` loop completes for an assistant whose children include orphans, push the synthesized orphan tool_use ids into `synthesizedOrphanToolUseIds`. The existing block:

```ts
        for (const block of toolUses(child)) {
          const results = resultsByToolUseId.get(block.id)
          if (results?.length) {
            groupedResults.push(...results.map(result => structuredClone(result)))
            repairedToolUseIds.push(block.id)
            continue
          }
          groupedResults.push({
            type: 'tool_result',
            tool_use_id: block.id,
            content: RECOVERY_TEXT,
            is_error: true,
          })
          synthesizedToolUseIds.push(block.id)
        }
```

becomes:

```ts
        const revivedFromHere = (revivedAnchors.get(message.uuid) ?? []).some(candidate => candidate.uuid === child.uuid)
        for (const block of toolUses(child)) {
          const results = resultsByToolUseId.get(block.id)
          if (results?.length) {
            groupedResults.push(...results.map(result => structuredClone(result)))
            repairedToolUseIds.push(block.id)
            continue
          }
          groupedResults.push({
            type: 'tool_result',
            tool_use_id: block.id,
            content: RECOVERY_TEXT,
            is_error: true,
          })
          if (revivedFromHere) synthesizedOrphanToolUseIds.push(block.id)
          else synthesizedToolUseIds.push(block.id)
        }
```

5. Declare `synthesizedOrphanToolUseIds: string[]` alongside `repairedToolUseIds` / `synthesizedToolUseIds` at the top of the function (currently at `repair.ts:155-156`):

```ts
  const repairedToolUseIds: string[] = []
  const synthesizedToolUseIds: string[] = []
  const synthesizedOrphanToolUseIds: string[] = []
```

6. Include `synthesizedOrphanToolUseIds: repaired ? synthesizedOrphanToolUseIds : []` in the final report (currently at `repair.ts:243-251`).

- [ ] **Step 4: Run new tests to verify they pass**

Run: `cd packages/zai-agent-core && pnpm vitest run test/transcript/repair-orphan.test.ts`
Expected: 5 PASS.

- [ ] **Step 5: Update the legacy orphan test**

Edit the test `'skips all repair when a tool_use parent is not an assistant in the active chain'` at `packages/zai-agent-core/test/transcript/repair.test.ts:130-156`. Replace it with a test that expects orphan revival:

```ts
  it('revives an orphan whose active-chain parent is not an assistant', () => {
    const a1 = record('a1', 'assistant', [])
    const userMid = record('u900', 'user', 'continue', 'a1')
    const orphan = record(
      't1',
      'tool_use',
      [{ type: 'tool_use', id: 'call-orphan', name: 'Bash', input: {} }],
      'u900',
    )
    const delayedResult = record(
      'r1',
      'user',
      [{ type: 'tool_result', tool_use_id: 'call-orphan', content: 'done', is_error: false }],
      't1',
    )
    const input = [a1, userMid, orphan, delayedResult]

    const result = repairTranscriptToolPairs(input)

    expect(result.report.repaired).toBe(true)
    expect(result.report.synthesizedOrphanToolUseIds).toEqual(['call-orphan'])
    const userResults = result.messages.filter(message => toolResults(message).length > 0)
    expect(userResults).toHaveLength(1)
    expect((userResults[0].message?.content as Array<{ tool_use_id: string; is_error?: boolean }>)[0])
      .toMatchObject({ tool_use_id: 'call-orphan', is_error: false })
  })
```

- [ ] **Step 6: Run the full repair test file**

Run: `cd packages/zai-agent-core && pnpm vitest run test/transcript/repair.test.ts`
Expected: 7 PASS (one test rewrote; one keeps "drops a disconnected branch" untouched; one keeps idempotency; four existing tests unchanged).

- [ ] **Step 7: Commit**

```bash
git add packages/zai-agent-core/src/transcript/repair.ts \
  packages/zai-agent-core/test/transcript/repair-orphan.test.ts \
  packages/zai-agent-core/test/transcript/repair.test.ts
git commit -m "feat(transcript): revive orphan tool_use under most recent anchor (spec §6a)"
```

---

### Task 3: Persistence test — orphan revival persists under file lock and is idempotent

**Files:**
- Modify: `packages/zai-agent-core/test/transcript/repair-persistence.test.ts`

**Interfaces:**
- Consumes: `repairAndPersistTranscript(store, sessionId)` (already exports the new field).
- Produces: a new `it()` block (does not touch existing 3 tests).

- [ ] **Step 1: Add a new test case**

Append to the `describe('repairAndPersistTranscript', ...)` block in `repair-persistence.test.ts`:

```ts
  it('persists orphan revival under file lock and stays idempotent on a second call', async () => {
    await appendAssistantMessageV2(
      store,
      sessionId,
      [{ type: 'text', text: 'plan' }],
      0,
      null,
      { cwd: '/x', sessionId },
    )
    const a1 = (await store.read(sessionId)).messages[0].uuid
    const u900 = (await appendUserMessageV2(
      store,
      sessionId,
      'continue',
      1,
      a1,
      { cwd: '/x', sessionId },
    ))!
    await appendToolUse(
      store,
      sessionId,
      { id: 'orphan-rid', name: 'Bash', input: {} },
      0,
      u900,
      '/x',
    )

    const first = await repairAndPersistTranscript(store, sessionId)
    const second = await repairAndPersistTranscript(store, sessionId)
    const onDisk = await store.read(sessionId)

    expect(first.report.repaired).toBe(true)
    expect(first.report.synthesizedOrphanToolUseIds).toEqual(['orphan-rid'])
    expect(second.report.repaired).toBe(false)
    expect(onDisk.messages).toEqual(first.messages)
  })
```

- [ ] **Step 2: Run the test**

Run: `cd packages/zai-agent-core && pnpm vitest run test/transcript/repair-persistence.test.ts`
Expected: 4 PASS.

- [ ] **Step 3: Commit**

```bash
git add packages/zai-agent-core/test/transcript/repair-persistence.test.ts
git commit -m "test(transcript): cover orphan revival persistence + idempotency"
```

---

### Task 4: Expose `synthesizedOrphanToolUseIds` via the `/api/transcript/:sessionId/repair` route

**Files:**
- Modify: `packages/zai/src/server/routes/transcript.ts:36-42` (response body)

- [ ] **Step 1: Add the field to the JSON response**

Replace the response body at `transcript.ts:36-42`:

```ts
    res.json({
      ok: true,
      sessionId,
      repaired: result.report.repaired,
      repairedToolUseIds: result.report.repairedToolUseIds,
      synthesizedToolUseIds: result.report.synthesizedToolUseIds,
    })
```

with:

```ts
    res.json({
      ok: true,
      sessionId,
      repaired: result.report.repaired,
      repairedToolUseIds: result.report.repairedToolUseIds,
      synthesizedToolUseIds: result.report.synthesizedToolUseIds,
      synthesizedOrphanToolUseIds: result.report.synthesizedOrphanToolUseIds,
    })
```

- [ ] **Step 2: Verify it compiles**

Run: `cd packages/zai-agent-core && pnpm typecheck`
Expected: 0 errors.

- [ ] **Step 3: Commit**

```bash
git add packages/zai/src/server/routes/transcript.ts
git commit -m "feat(transcript): expose synthesizedOrphanToolUseIds in repair API"
```

---

### Task 5: Update frontend toast to surface orphan-revived count separately

**Files:**
- Modify: `packages/zai/src/web/src/components/AgentInputBox.tsx:676-687` (the response type and toast message).

**Interfaces:**
- Consumes: the API response with the new field.
- Produces: a UI toast that distinguishes "active-chain synthesized" from "orphan revived" totals.

- [ ] **Step 1: Extend the typed response and toast logic**

Replace the block at `AgentInputBox.tsx:676-687`:

```tsx
                const data = (await res.json()) as {
                  repaired: boolean
                  repairedToolUseIds: string[]
                  synthesizedToolUseIds: string[]
                }
                if (data.repaired) {
                  message.success(
                    `已修复 ${data.synthesizedToolUseIds.length} 个孤立 tool_use`,
                  )
                } else {
                  message.info("transcript 健康,无需修复")
                }
```

with:

```tsx
                const data = (await res.json()) as {
                  repaired: boolean
                  repairedToolUseIds: string[]
                  synthesizedToolUseIds: string[]
                  synthesizedOrphanToolUseIds: string[]
                }
                if (data.repaired) {
                  const orphanCount = data.synthesizedOrphanToolUseIds.length
                  const activeCount = data.synthesizedToolUseIds.length
                  const summary = [
                    activeCount > 0 ? `孤立 tool_use ${activeCount}` : null,
                    orphanCount > 0 ? `孤儿分支复活 ${orphanCount}` : null,
                  ]
                    .filter(Boolean)
                    .join("、")
                  message.success(`已修复: ${summary}`)
                } else {
                  message.info("transcript 健康,无需修复")
                }
```

- [ ] **Step 2: Run web typecheck/build to confirm no regression**

Run: `cd packages/zai && pnpm tsc -b --noEmit` (or the equivalent web typecheck script — verify via `pnpm typecheck` if available).
Expected: 0 errors.

If the exact command differs, run `cd packages/zai && cat package.json | grep -A 20 '"scripts"'` to identify the script and use that.

- [ ] **Step 3: Commit**

```bash
git add packages/zai/src/web/src/components/AgentInputBox.tsx
git commit -m "feat(web): distinguish orphan-revived count in repair toast"
```

---

### Task 6: Final verification — full test suite + typecheck

**Files:** none (verification only).

- [ ] **Step 1: Run all transcript tests**

Run: `cd packages/zai-agent-core && pnpm vitest run test/transcript/`
Expected: All tests PASS (one new orphan test file with 5 cases; updated legacy repair test; new persistence case; pre-existing 9 untouched tests).

- [ ] **Step 2: Run typecheck**

Run: `cd packages/zai-agent-core && pnpm typecheck`
Expected: 0 errors.

- [ ] **Step 3: Confirm no unintended file changes**

Run: `git status --short`
Expected: ONLY the protected, pre-existing modifications remain (`M docs/superpowers/specs/...design.md`, `M packages/zai/src/web/src/pages/Agent.tsx`, `?? packages/zai-agent-core/test_repair_session.mjs`, `?? packages/zai/src/web/src/components/transcript/MessageBubble.tsx`) PLUS the commits from Tasks 1-5 (which `git status` will NOT re-show as they were committed).

---

## Self-Review

**1. Spec coverage:**

| Spec section | Task |
|---|---|
| §方案 signature + persistence under file lock | Task 1 (type widening) + pre-existing code |
| §DAG 线性化算法 steps 1-8 | Pre-existing implementation |
| §6a orphan revival (steps 1-3) | Task 2 (algorithm) |
| `synthesizedOrphanToolUseIds` field | Task 1 (type), Task 2 (population), Task 3 (persistence test), Task 4 (API), Task 5 (UI) |
| §集成点 (queryLoop already calls repairAndPersistTranscript; repaired: false fallback to original transcript, no blocking) | Pre-existing queryLoop.ts:189-194 already implements this; verified |
| §测试 — five §6a cases | Task 2 step 1 covers all five |
| §测试 — generic orphan cases (already covered previously) | Task 2 step 5 rewrites legacy test; Task 3 covers persistence |
| §验证命令 pnpm vitest run test/transcript/ test/runtime/ + pnpm typecheck | Task 6 |

**2. Placeholder scan:**

- No "TBD" / "TODO" / "fill in details".
- Every code step shows complete code (recovery text, type fields, recovery algorithm).
- No "Add appropriate error handling" hand-waves.

**3. Type consistency:**

- `TranscriptRepairReport.synthesizedOrphanToolUseIds` defined in Task 1 and used in Task 2 algorithm, Task 3 test, Task 4 route response, Task 5 frontend type.
- `RECOVERY_TEXT` constant referenced at step 4 of Task 2 (unchanged).
- `revivedAnchors` map shared between steps 2 and 4 of Task 2.
- File path protected-list verified before edits to `AgentInputBox.tsx` and `transcript.ts`.

**4. Plan-honest fallback:**

When `repair.repaired === false` (e.g., no anchor available), `repair.ts:241-251` returns the original `messages` and the report indicates no changes. `queryLoop.ts:189` already destructures `repaired.messages` and uses them directly, so the fallback (use original transcript on failure) is automatic. The spec text "持久化失败/校验不通过（repaired: false）时，沿用原 transcript 继续 resume（不阻断），但落盘未发生 → 下次 resume 仍会重试" is satisfied by existing code — no new code needed for fallback.

---

## Execution Handoff

Plan complete and saved to `docs/superpowers/plans/2026-07-20-transcript-orphan-revival.md`. Two execution options:

1. **Subagent-Driven (recommended)** — fresh subagent per task, review between tasks, fast iteration.
2. **Inline Execution** — execute tasks in this session using executing-plans, batch execution with checkpoints.

Which approach?
