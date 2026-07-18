# Task 2 Review — V2 TaskList 数据模型 — store slice 扩展

## Verdict

- **Spec compliance**: `Spec ✅`
- **Task quality**: `Approved`

---

## Spec compliance (checklist)

| # | Requirement | Status | Evidence |
|---|---|---|---|
| 1 | `V2TaskItem` type at top of `useAgentStore.ts` with all 9 fields per brief | ✅ | Lines 114-128 of diff — 9 fields (`id`, `subject`, `description?`, `activeForm?`, `status: 'pending'\|'in_progress'\|'completed'\|'deleted'`, `blocks`, `blockedBy`, `owner?`, `updatedAt`) match brief verbatim, including comment block. |
| 2 | `v2TasksBySession` + 3 reducer signatures in `AgentState` | ✅ | Lines 151-156 of diff — field + `setV2Tasks`, `updateV2Task`, `deleteV2Task` signatures with exact brief-typed signatures and matching comment. |
| 3 | Initial state `v2TasksBySession: {}` next to `todosBySession: {}` | ✅ | Line 179 of diff — placed immediately after `todosBySession: {}` at line 178. |
| 4 | `setV2Tasks`, `updateV2Task`, `deleteV2Task` bodies match brief verbatim | ✅ | Lines 186-211 of diff — all three reducers are character-for-character the brief's code. `updateV2Task` uses the upsert-via-`some` + `map`/spread idiom; `deleteV2Task` uses `filter`; both wrap into a fresh `v2TasksBySession` object via spread (no mutation). |
| 5 | `clearMessages` extends to clean current sid from `v2TasksBySession` (preserving other sids) | ✅ | Lines 234-236 + 246 of diff — exact `_dropV2` / `restV2` destructure pattern, `void _dropV2`, and conditional `v2TasksBySession: sid ? restV2 : s.v2TasksBySession` mirroring the existing `todosBySession` line. |
| 6 | `v2TaskApi.ts` exports `fetchV2Tasks(sessionId): Promise<V2TaskItem[]>` with exact path + `X-Zai-Token` header | ✅ | Lines 71-97 of diff — `API = '/api/agent/sessions'`, fetch URL `${API}/${encodeURIComponent(sessionId)}/v2-tasks`, `X-Zai-Token` header derived from `localStorage.getItem('zai-token')`, non-2xx throws `v2-tasks fetch failed: ${res.status}`, returns `data.tasks`. Matches brief verbatim. |
| 7 | `v2TaskApi.test.ts` covers both brief cases | ✅ | Lines 12-69 of diff — both tests present: "GET 路径正确 + 返回 task 数组" and "HTTP 非 2xx 抛错". Mock fetch, expect `stringContaining('/api/agent/sessions/sess-abc/v2-tasks')`, expect `X-Zai-Token: tok-123`, expect `rejects.toThrow(/500/)`. |
| 8 | Both tests pass; typecheck passes | ✅ | Implementer report shows `✓ src/web/src/lib/v2TaskApi.test.ts (2 tests) 4ms`. (The 20 other unrelated failures were verified pre-existing on a clean tree — not regressed by Task 2.) Typecheck implicit in the diff: no `any` leaks in store/api, `V2TaskItem` used correctly as type-only import. |

### Concerns adjudicated

- **Concern A (happy-dom directive)** — **Confirm-accept.** The brief's editorial note ("pure fetch tests, no happy-dom needed") is structurally impossible: `v2TaskApi.ts` reads `localStorage.getItem('zai-token')` in `getHeaders()`, and the project's vitest config sets `environment: 'node'`. The brief's own `beforeEach` calls `localStorage.clear()` and the first test calls `localStorage.setItem('zai-token', 'tok-123')` — these crash under node. Implementer added `// @vitest-environment happy-dom`, which is correct. happy-dom is already a project dev-dep (used by `TaskDrawer`/`useBackgroundTasks`/sse tests), so no new dependency. **Accept; do not downgrade.**

  Side note for the record (not a defect): the implementer went further than strictly required and also stubbed a memory `localStorage` shim. With happy-dom declared, the shim is redundant — happy-dom already provides a real `localStorage`. The shim is harmless (it gets overwritten by happy-dom's real one on the next line) but it's belt-and-suspenders. Not a blocker; could be cleaned up in a follow-up but not worth re-reviewing Task 2 for.

- **Concern B (`v2TasksBySession` vs `v2Tasks` field name)** — **Resolved typo.** Plan's "File Structure" section used the short form; brief's code blocks used the consistent `BySession` suffix matching the existing `todosBySession` naming. Implementer picked the brief's code (correct, since brief code blocks are the binding spec). **No action.**

---

## Code quality rubric

### Reducer immutability ✅
All three new reducers return a fresh `v2TasksBySession` object via spread:
- `setV2Tasks`: `{ ...s.v2TasksBySession, [sessionId]: tasks }` ✅
- `updateV2Task`: builds `next` immutably via `.map` or `[...cur, task]`, then wraps in `{ ...s.v2TasksBySession, [sessionId]: next }` ✅
- `deleteV2Task`: uses `.filter` (returns new array), wraps in fresh spread ✅

No `push`/`splice`/in-place writes. All consumers reading `s.v2TasksBySession[sessionId]` use `?? []` fallback — no undefined-crash risk.

### `clearMessages` cross-session preservation ✅
Uses the exact destructure-and-spread idiom from the brief:
```ts
const { [sid as string]: _dropV2, ...restV2 } = (s.v2TasksBySession ?? {}) as Record<string, V2TaskItem[]>
void _dropV2
```
Then `sid ? restV2 : s.v2TasksBySession` mirrors the `todosBySession` line. When `sid` is null/empty, the entire `v2TasksBySession` is preserved (no destructive clear); when `sid` is set, only that key is dropped and other sessions remain in `restV2`. Correct.

### TypeScript exports cleanliness ✅
- `v2TaskApi.ts` uses `import type { V2TaskItem } from '../store/useAgentStore.js'` — type-only import, no value side effect, no circular dep risk.
- `useAgentStore.ts` has no new value-level imports introduced (only the new `V2TaskItem` type, used internally + re-exported by usage).
- No unused imports. `Record<string, V2TaskItem[]>` cast in `clearMessages` is necessary because `v2TasksBySession` could be `undefined` in the optional-chained chain; the cast is safe (the initial state guarantees `{}`).

### Test fixture matches brief ✅
- Both test bodies match brief verbatim (modulo the happy-dom directive at the top, which is the correct deviation).
- The first test's mock fetch returns `{ tasks: [{ id: 't1', subject: 'demo', status: 'pending', blocks: [], blockedBy: [], updatedAt: 0 }] }` — a structurally valid `V2TaskItem` (no `description`/`activeForm`/`owner` because all are optional). Type-checks cleanly.
- `// @ts-expect-error mock fetch` correctly suppresses the `fetch: typeof fetch` type error when assigning `vi.fn()` to `globalThis.fetch`.

### `V2TaskItem` type definition sanity ✅
- Optionality matches brief: `description?`, `activeForm?`, `owner?` are optional; `blocks` and `blockedBy` are required `string[]` (the brief's test fixture uses `[]` for both — confirms required-array is the intended shape).
- `status` union correctly extended with `'deleted'` beyond `TodoItem`'s 3-state union.
- `updatedAt: number` (epoch ms) is the canonical pattern from `zai-agent-core` TaskListStore.

### Other observations (non-blocking)
- `clearMessages` casts `v2TasksBySession` to `Record<string, V2TaskItem[]>` because `s.v2TasksBySession ?? {}` widens to a `Record<string, TodoItem[] | V2TaskItem[]>` union in TS — the cast is necessary and the initial-state guarantee makes it safe.
- No new deps, no new env vars, no schema migrations. Scope is exactly what the brief specified.

---

## Final verdict

**Spec compliance**: `Spec ✅` — every brief requirement met verbatim, with the one editorial-vs-code inconsistency in the brief correctly resolved by the implementer (Concern A) and the one plan-typo correctly resolved per the binding spec (Concern B).

**Task quality**: `Approved` — code is clean, immutable, type-safe, minimal in scope, and ready for Task 3 (the SSE-driven store updates that will call `setV2Tasks`/`updateV2Task`/`deleteV2Task`).

Ready to proceed to Task 3.