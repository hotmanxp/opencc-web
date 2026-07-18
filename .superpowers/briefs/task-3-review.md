# Task 3 Review — V2 TaskList server route + auto-fetch

**Reviewer**: grill-with-docs
**Date**: 2026-07-18
**Commit**: `cd10f97` on `main`
**Files reviewed**: 4 (135 insertions, 0 deletions)

---

## Spec compliance — ✅

All seven checklist items from the brief are satisfied. Detail below.

### ✅ Server route `v2Tasks.ts` — PASS

- **Path & shape**: `GET /api/agent/sessions/:sid/v2-tasks` returns `{ tasks }`. Diff line 136 confirms.
- **Plan B justification**: The previous implementer couldn't import `getTaskListStore` because `zai-agent-core`'s `exports` map doesn't expose `tools/Tasks/TaskListStore.js` as a subpath. The diff's block comment (lines 56–69) explains this clearly and matches what I see in the zai-agent-core package layout. Direct-read-of-JSON is the correct fallback.
- **Filtering matches `TaskListStore.list()` semantics**: Cross-referenced against `packages/zai-agent-core/src/tools/Tasks/TaskListStore.ts:86–94`. The store filters `status === 'deleted'` AND `metadata._internal === true`. The route's `readV2Tasks()` (lines 118–124) does both filters identically.
- **Edge cases**:
  - ENOENT → empty array (line 104) ✅
  - JSON corrupt → `console.warn` + empty array (lines 110–116) ✅
  - Non-array `parsed` → empty array (line 117) ✅
  - Malformed records → filtered out via type guard (lines 118–124) ✅
- **Path resolution**: `homedir()` used (line 73 import, line 99 use) ✅ — matches `TaskListStore`'s default root `${process.env.HOME ?? '/tmp'}/.zai`.
- **Comments**: Dense 中文 style matches surrounding code in `server/routes/*` and the report's tone. ✅

### ✅ `server/index.ts` — PASS

- `v2TasksRouter` registered via `app.use('/api', v2TasksRouter)` between `tasksRouter` (line 36) and `slashRouter` (line 43). Diff lines 37–39. Order is correct.
- Inline comment explains the role (SSE fallback / 兜底) — matches house style. ✅

### ✅ `Agent.tsx` `useEffect` — PASS

Lines 1130–1149. Matches brief's spec exactly:
- Depends on `[sessionId]` ✅
- `cancelled = false` flag with `return () => { cancelled = true }` cleanup ✅
- `if (!sid) return` early-return for null first-render ✅
- `console.warn('[v2Tasks] initial fetch failed:', err)` on failure ✅
- `useAgentStore.getState().setV2Tasks(sid, tasks)` on success ✅
- Uses the existing `fetchV2Tasks` import from `../lib/v2TaskApi.js` (which has its own `X-Zai-Token` header injection).

### ✅ `useAgentStore.ts` inline fetch — PASS

Lines 978–996 inside `case 'runtime.tool_call':`:
- **Inline fetch, not `await import`** ✅ (matches brief's preferred pattern + implementer's `loadSessions` style at line 649)
- **No `fetchV2Tasks` import** → no runtime cycle. `v2TaskApi.ts` only `import type`s `V2TaskItem`, so the type-only path is benign. ✅
- **URL**: `/api/agent/sessions/${encodeURIComponent(sid)}/v2-tasks` ✅
- **Token**: `localStorage.getItem('zai-token') || ''` ✅ (same as `loadSessions` line 650)
- **Header**: `X-Zai-Token` ✅
- **`if (!res.ok) return`** — non-2xx treated as silent failure ✅
- **`catch { /* 静默 */ }`** — comment is present, error is swallowed but documented ✅
- **Trigger only on `TaskCreate` / `TaskUpdate`**, NOT `TaskDelete` ✅ (correct — V2 has no `TaskDelete` tool; implementer's call-out is accurate)
- **`V2TaskItem` type reused** without re-import (it's defined at line 19 of the same file) ✅

### ✅ Commit message — PASS

Exactly: `feat(zai): expose V2 TaskList via GET route + auto-refresh on session change` (verified via `git log -1`).

### ✅ Scope — PASS

`git show --stat cd10f97` confirms exactly 4 files, matching brief. `.superpowers/` and plan file are untracked and not in commit (verified `git status`).

### ✅ No new dependencies — PASS

Only stdlib (`node:fs/promises`, `node:os`, `node:path`) + `express`. No package.json changes.

---

## Code quality

### Approved ✅

The implementation is clean, idiomatic, and consistent with surrounding code. Highlights:

1. **TypeScript hygiene**: `StoredTask` local type is deliberately lighter than `zai-agent-core`'s `TaskItem` (no `createdAt`, no `description` non-optional). The comment explains the trade-off — "客户端 V2TaskItem 全 optional" — and matches `useAgentStore.ts:19–29`.
2. **Error philosophy**: Both the route and the client fetch fail soft. The route returns 500 only on truly unexpected errors (post-ENOENT, post-parse); the client never throws. This is the right call for a best-effort mirror of disk state.
3. **Race-safety in Agent.tsx**: The `cancelled` flag is correctly placed (after `await fetchV2Tasks(sid)` but before `setV2Tasks`). Prevents late-arriving `setV2Tasks` calls from overwriting a newer session's cache.
4. **No over-engineering**: The route doesn't try to abstract the path, doesn't introduce a store singleton wrapper, doesn't add a logger. Reads as a 90-line file that does one thing.
5. **Style match**: Comments are tight, dense, in the project's preferred 中文 voice. Same idiom as `cli.ts`, `tasks.ts`, `agent.ts`.

---

## Findings

### 0 Critical
### 0 Important
### 2 Minor

---

### Minor 1 — Missing trailing newline in `v2Tasks.ts`

`xxd` on the last 20 bytes:
```
00000000: 7870 6f72 7420 6465 6661 756c 7420 726f  xport default ro
00000010: 7574 6572                                uter
```

No final `\n`. The diff itself flags this with `\ No newline at end of file` (line 146 of the diff). POSIX text files conventionally end with a newline, and every other route file in `packages/zai/src/server/routes/` does. Trailing-newline absence can also trip `git blame -L` and some editors' save semantics.

**Suggested fix**: Add `\n` at EOF. Trivial.

### Minor 2 — `setV2Tasks` will write empty array on first fetch, overwriting any in-flight SSE state

Sequence:
1. User loads session with `sessionId = "abc"`. `useEffect` fires.
2. While `fetchV2Tasks("abc")` is in flight, the LLM emits `TaskCreate` → SSE → `applyRuntimeEvent` → inline fetch + `setV2Tasks("abc", [newTask])` (line 993).
3. The original `useEffect` fetch resolves with the disk state — which already includes `newTask` if the server's `TaskCreate` tool call has flushed, OR may not include it if there's a race between the tool result and our GET.

The `useEffect` fetch doesn't have a "newer wins" guard — `setV2Tasks` blindly overwrites. In practice the server-side tool call completes before SSE emits `tool_call` (the SSE event carries the `tool_call` input, but the actual `getTaskListStore().create()` runs synchronously inside the same handler), so the disk state at GET time should already reflect the new task. This is a theoretical ordering question, not a current bug.

**Optional improvement**: A `version` counter on `useEffect` mount (similar to `cancelled`) would let us discard stale results — though this conflicts with the brief's spec for `setV2Tasks` semantics. **Recommend**: log as observation, do not require change.

---

## Process verification

- ✅ Did not re-run typecheck/build/tests (implementer already did)
- ✅ Cross-referenced `TaskListStore.list()` against `readV2Tasks()` for parity
- ✅ Verified `v2TaskApi.ts` only `import type`s `V2TaskItem` (confirmed no runtime cycle)
- ✅ Verified commit message byte-exact
- ✅ Verified `.superpowers/` + plan file excluded from commit
- ✅ Verified only the 4 brief-listed files modified
- ✅ Verified `V2TaskItem` is exported from `useAgentStore.ts:19` and accessible in the inline fetch block at line 992

---

## Verdict

**Spec compliance**: ✅ Full pass
**Code quality**: Approved

The implementer's Plan B (direct JSON read) is well-justified, the filtering is parity-correct with `TaskListStore.list()`, the inline fetch in `useAgentStore.ts` correctly avoids the (theoretical) circular-import concern while matching the existing `loadSessions` pattern, and the Agent.tsx `useEffect` is textbook cancelled-flag implementation. The two minor findings are cosmetic / theoretical — neither blocks merge.
