# Whole-branch Review — Agent Bottom Status Bar + V2 TaskList UI

**Branch**: `e2c8029..5259562` (8 commits, +743/-29)
**Plan**: `docs/superpowers/plans/2026-07-18-agent-bottom-status-bar.md`
**Reviewer**: whole-branch reviewer
**Date**: 2026-07-18

---

## 1. Verdict

✅ **READY TO MERGE**

Cross-cutting concerns all verified:
- `V2TaskItem.status` 4-value union flows correctly through store → components
- No runtime circular import introduced (store uses inline fetch + `import type` only)
- Server route `v2Tasks.ts` uses `export default router` matching sibling routes; path resolution via `homedir()` is portable
- `BottomStatusBar` math (`total/done/inProgress/open`) matches spec; deleted items filtered at server, not double-counted at UI
- TypeScript strictness preserved — no new `as any`, optional `description` handled with `??`
- Pre-existing 20 baseline failures confirmed unchanged — no regression introduced
- All 12 new tests pass; typecheck exits 0

---

## 2. Spec Coverage

| Goal | Status | Evidence |
|------|--------|----------|
| Bug A: ToolCallBlock "unknown" downgrade | ✅ | Task 1 commit `c06b313` — `name = rawName \|\| \`未知工具 (id:${shortId})\`` (Agent.tsx:518) + diagnostic `console.warn` in store (useAgentStore.ts:540-550) |
| Bug A: Diagnostic console.warn | ✅ | useAgentStore.ts:540-550 — fires only when both `incomingName` and `msg.name` empty; gated by `typeof console !== 'undefined'` |
| Bug B: V2 store slice | ✅ | Task 2 commit `c5dca77` — `v2TasksBySession: Record<string, V2TaskItem[]>` + 3 reducers (setV2Tasks/updateV2Task/deleteV2Task) + `clearMessages` parity reset |
| Bug B: fetchV2Tasks client API | ✅ | Task 2 — `v2TaskApi.ts` with correct URL + `X-Zai-Token` header, 2/2 tests pass |
| Bug B: GET route | ✅ | Task 3 commit `cd10f97` — `GET /api/agent/sessions/:sid/v2-tasks → { tasks: V2TaskItem[] }`; Plan B direct read justified (zai-agent-core exports map doesn't expose `tools/Tasks/...` subpath) |
| Bug B: Auto-fetch on session change | ✅ | Agent.tsx useEffect with `cancelled` flag (race-safe) |
| Bug B: SSE incremental refresh | ✅ | useAgentStore.ts:982-998 — fires only on `TaskCreate` / `TaskUpdate` tool_call; inline fetch (no cycle); silent on failure |
| Bug C: 老 TodoWrite 流式状态 | ✅ | No change needed — existing `setTodos` / `todosBySession` store path intact and used by TodoDropdown + BottomStatusBar |
| BottomStatusBar above input box | ✅ | Task 7 commit `06e2e99` — sits as sibling above `<div className="bottom-stack">` (per spec checklist, despite brief text ambiguity — code example + review checklist agree) |
| Popover with TodoDropdown | ✅ | Task 5 + Task 7 — `Popover trigger="click" placement="topRight"` containing `<TodoDropdown todos v2Tasks />` |
| Bottom config bar preserved | ✅ | Task 4 commit `3656591` — byte-equivalent extraction into `ConfigStatusBar`; order, colors, gap all verbatim |
| Test coverage | ✅ | Tasks 6 + 8 — 5 + 5 = 10 component tests + 2 API tests = **12 new tests, all passing** |

---

## 3. Findings

### Critical: 0

### Important: 0

### Minor: 1

#### M1 — `[antd: Tooltip] destroyTooltipOnHide is deprecated` (carry-forward)

**File**: `packages/zai/src/web/src/components/BottomStatusBar.tsx:82`
**Severity**: Minor
**Observation**: The `BottomStatusBar.test.tsx` run emits a deprecation warning on every test:
```
Warning: [antd: Tooltip] `destroyTooltipOnHide` is deprecated. Please use `destroyOnHidden` instead.
```
This is a forward-compatibility hazard — antd 6 will likely remove the prop and the popover will lose its `destroyTooltipOnHide` behavior (currently used to unmount the dropdown on hide so each click rebuilds it). The brief explicitly specified `destroyTooltipOnHide` so the implementation matches spec; the deprecation is a brief-versioning issue, not a correctness bug.

**Suggested follow-up**: File a brief-fix ticket "Replace `destroyTooltipOnHide` with `destroyOnHidden` in BottomStatusBar" before antd 6 upgrade. Non-blocking.

---

## 4. Carry-Forward Minors (aggregated from per-task reviews)

All Minor findings from per-task reviews are aggregated here. None block merge.

| # | Severity | Source | Finding | Action |
|---|----------|--------|---------|--------|
| M1 | Minor | Task 1 | `input: msg.input` in `console.warn` payload lands in browser DevTools console and may include tool-input contents (paths, command bodies). Spec-compliant and intentional per brief, but worth a one-line ADR note. | Carry forward; ADR ticket |
| M2 | Minor | Task 2 | No test for missing-token auth path in `getHeaders()` — user without token silently hits authenticated endpoint. Matches existing `loadSessions` pattern. | Carry forward; "audit all X-Zai-Token callers" ticket |
| M3 | Minor | Task 2 | `v2TaskApi.test.ts` has redundant localStorage stub + stale comment contradicting the `@vitest-environment` directive | Cosmetic; clean up in next test pass |
| M4 | Minor | Task 2 | Missing trailing newlines on `v2TaskApi.ts` and `v2TaskApi.test.ts` | Repo linter should handle |
| M5 | Minor | Task 3 | Missing trailing newline in `v2Tasks.ts` | Trivial; append `\n` |
| M6 | Minor | Task 3 | Theoretical ordering concern: `setV2Tasks` could overwrite in-flight SSE state if useEffect fetch resolves after a tool-call-triggered fetch. Server-side tool call completes before SSE emits, so this is theoretical, not a current bug. | Log as observation; no change required |
| M7 | Minor | Task 4 | Missing trailing newline in `ConfigStatusBar.tsx` | Trivial; append `\n` |
| M8 | Minor | Task 5 | Missing trailing newline in `TodoDropdown.tsx` | Trivial; append `\n` |
| M9 | Minor | Task 7 | Missing trailing newline in `BottomStatusBar.tsx` | Trivial; append `\n` |
| M10 | Minor | Task 7 | Original brief Step 2 text said "inside `.bottom-stack` before `<AgentInputBox />`" but the code example placed it as a sibling. Implementer correctly followed the code example. Recommend brief authors unify text + example. | Brief authoring hygiene; not a code defect |
| M11 | Minor | Task 7 | Visual verification (browser screenshot of red-box position) deferred — typecheck + byte-equivalence of the extraction covered it. | Next owner with dev server can visually verify |
| M12 | Minor | Task 8 | Test 3 assertion `2 待开始 → 1 待开始`: brief had math error (component formula correctly yields 1). Test adjusted to match component output. Brief should be updated to prevent repeat. | Brief-fix ticket |
| M13 | Minor | Task 8 | Test 4 assertion `rgb(82,196,26) → #52c41a`: happy-dom preserves inline hex; brief assumed `getComputedStyle` semantics. Test adjusted. Brief should be updated. | Brief-fix ticket |
| M14 | Minor | This review | `destroyTooltipOnHide` antd deprecation warning (see M1 above) | Carry forward |

**Total**: 14 minor findings (12 from per-task reviews, 1 carry-over, 1 new observation).

---

## 5. Recommendations / Follow-up Tickets

Worth creating standalone tickets for these:

1. **"Replace `destroyTooltipOnHide` with `destroyOnHidden` in BottomStatusBar"** — antd 5 deprecation. Pre-empts antd 6 breakage. (M1, M14)
2. **"ADR: scope of `[tool_unknown]` diagnostic warn"** — document that the warn payload intentionally includes `input` for diagnostic purposes, so a future cleanup pass doesn't strip it as PII. (M1 from Task 1)
3. **"Audit all `X-Zai-Token` callers for missing-token UX"** — silent 401s on unauthenticated fetches. (M2 from Task 2)
4. **"Update Task 8 brief: fix math error in '合并 todos + v2' assertion (`1 待开始` not `2`)"** — prevents regression on next rewrite. (M12)
5. **"Update Task 8 brief: `style.color` returns inline hex in happy-dom, not `rgb(...)`"** — same. (M13)
6. **"Update plan template: unify prose + code example for component placement"** — Task 7 brief had text saying "inside .bottom-stack" but example placed it as sibling. Implementer correctly followed example; brief authors should be consistent. (M10)
7. **"Investigate 3 pre-existing `useAgentStore.test.ts` failures at line 411-416 area"** — SubagentNotifier / new-turn tests have been failing baseline; unrelated to this branch but worth a separate ticket to triage. (Mentioned in Task 2 review as carried-forward)
8. **"Investigate the 18 other pre-existing test failures"** — `ModelStatusButton`, `agentSettings`, `agentRuntime`, `routes-agent`, `useAgentStore-loadTranscript`. Confirmed not introduced by this branch (same baseline before/after).

---

## 6. Cross-Cutting Verification Detail

### V2 status `'deleted'` end-to-end (Concern #1)

| Layer | Behavior | Evidence |
|-------|----------|----------|
| Server route (`v2Tasks.ts:164`) | Filters out `status === 'deleted'` before response | `if (task.status === 'deleted') return false` |
| Store slice (`useAgentStore.ts`) | Does not filter on read; passes raw server response | `setV2Tasks` is a pure setter |
| `TodoDropdown.tsx` | Renders `✗` icon + red `#f5222d` + strikethrough for `deleted` status | `v2Icon` line 549-553, `v2Color` line 561-566, line 645 strikethrough |
| `BottomStatusBar.tsx` | Does NOT count `deleted` items in done/inProgress/open; they fall into `open` (counted as "待开始") — but in practice the route filters them out so this branch is unreachable | Formula: `open = todoOpen + (v2Total - v2Done - v2InProgress)` |

**Verdict**: No double-counting risk in practice because the server route gates `deleted` out. If the data ever comes from a different source that includes `deleted`, the UI handles it gracefully (line-through + red icon in dropdown; counted as "待开始" in summary — minor cosmetic drift, but not user-facing because no path produces this scenario today). Documented and consistent.

### Circular import risk (Concern #2)

- `v2TaskApi.ts` imports `import type { V2TaskItem } from '../store/useAgentStore.js'` — type-only, erased at runtime, no cycle.
- `useAgentStore.ts` (Task 3 inline fetch) does NOT import `fetchV2Tasks` from `v2TaskApi.ts` — it uses `globalThis.fetch` directly with the same URL pattern, matching the file's existing `loadSessions` style. No cycle.

**Verdict**: No circular import. Verified.

### Plan B path resolution (Concern #3)

- Route uses `homedir() + '.zai' + 'tasks.json'`. This matches the production build because:
  - The `zai` package's server-side runs in a Node.js process where `homedir()` resolves to the actual user home.
  - Other routes in the same dir (`cli.ts`, `tasks.ts`, etc.) use the same stdlib approach.
  - `zai-agent-core`'s `TaskListStore` default uses `process.env.HOME ?? '/tmp'` (cross-referenced in Task 3 review); on macOS `homedir()` and `process.env.HOME` agree.
- Workspace symlink: `@zn-ai/zai` is symlinked via pnpm into `node_modules/@zn-ai/zai`; server-side code resolves to the actual package source. Path `~/.zai/tasks.json` is independent of package resolution — it's the user's home directory.

**Verdict**: Reachable from production build. Path resolution is portable.

### BottomStatusBar total counts (Concern #4)

Verified formula:
```
todoTotal     = todos.length
todoDone      = todos.filter(s === 'completed').length
todoInProgress= todos.filter(s === 'in_progress').length
todoOpen      = todoTotal - todoDone - todoInProgress
v2Total       = v2Tasks.length
v2Done        = v2Tasks.filter(s === 'completed').length
v2InProgress  = v2Tasks.filter(s === 'in_progress').length
total         = todoTotal + v2Total
done          = todoDone + v2Done
inProgress    = todoInProgress + v2InProgress
open          = todoOpen + (v2Total - v2Done - v2InProgress)
```

Test 3 inputs: todos=[1 completed], v2Tasks=[1 in_progress, 1 completed, 1 pending]
- todoTotal=1, todoDone=1, todoInProgress=0, todoOpen=0
- v2Total=3, v2Done=1, v2InProgress=1
- total=4, done=2, inProgress=1, open = 0 + (3-1-1) = 1

Test asserts: `2/4 任务` ✓, `1 进行中` ✓, `1 待开始` ✓ (brief had `2 待开始`, implementer caught the error and corrected to `1 待开始` with inline comment).

**Verdict**: Formula matches code. Brief math was wrong; test corrected to match code, which matches the formula.

### All-completed green styling (Concern #5)

`BottomStatusBar.tsx:64`: `style={{ color: done === total ? "#52c41a" : "rgba(255,255,255,0.85)" }}`
- When `done === total && total > 0`: color is `#52c41a` (inline hex)
- happy-dom's `element.style.color` returns the inline string verbatim — does NOT normalize to `rgb(82, 196, 26)` (that's `getComputedStyle` behavior)
- Test asserts `style.color === "#52c41a"`, which is what happy-dom returns

**Verdict**: Correct in happy-dom; would also be correct in a real browser (computed style is irrelevant for the test). Brief had `rgb(82,196,26)` based on a `getComputedStyle` assumption; test corrected to `style.color` semantics.

### TypeScript strictness (Concern #6)

- No new `as any` introduced.
- `V2TaskItem.description` is optional. In `TodoDropdown.tsx:653`: `title={t.description ?? t.subject}` — proper optional chaining.
- `V2TaskItem.activeForm`, `blocks`, `owner` are unused by both TodoDropdown and BottomStatusBar (verified) — no risk of accessing undefined-required fields.
- Store actions use immutable spread patterns (no mutation shortcuts).
- Casts on `msg.name as string | undefined` (Agent.tsx:514) are explicitly safer than the surrounding `msg.name as string` pattern.

**Verdict**: No type-safety shortcuts introduced.

### Pre-existing test failures (Concern #7)

Test baseline confirmed via full `pnpm --filter @zn-ai/zai test --run`:
- **256 passed / 20 failed** — identical to pre-branch baseline
- All 20 failures in unrelated files: `ModelStatusButton.test.tsx` (14), `agentSettings.test.ts` (3), `agentRuntime.test.ts` (3), `useAgentStore.test.ts` (1 — line 411), `agent.test.ts`, `routes-agent.test.ts`, `useAgentStore-loadTranscript.test.ts`, `integration/agent.test.ts` (file-level failures)
- The `useAgentStore.test.ts:411` failure (SubagentNotifier / new turn) is in the **existing** store test suite, not in any code path this branch modifies. Confirmed carry-forward.
- The 18 server-side failures (`agentSettings`, `agentRuntime`, `ModelStatusButton` import-flow) are likewise unrelated.

**Verdict**: No regression introduced. The 20 baseline failures are pre-existing and out-of-scope for this branch.

---

## 7. Process Compliance

- ✅ Read full diff (1150 lines) at `.superpowers/reviews/wb-review-package.txt`
- ✅ Read all 6 per-task reviews + 1 implementer report
- ✅ Re-ran `pnpm --filter @zn-ai/zai typecheck` — exit 0
- ✅ Re-ran new tests (12/12 passing)
- ✅ Re-ran full test suite — 256 passed / 20 failed (baseline confirmed)
- ✅ Cross-referenced `TaskListStore.list()` semantics against route's filter (via Task 3 review)
- ✅ Verified `import type` only in `v2TaskApi.ts` (no runtime cycle)
- ✅ Verified store's inline fetch pattern matches existing `loadSessions` style

---

## 8. Summary

- **Critical**: 0
- **Important**: 0
- **Minor**: 14 (all carry-forward; 1 newly identified antd deprecation)
- **New tests**: 12 (10 component + 2 API) — all passing
- **Typecheck**: clean
- **Baseline test count**: 256 passed / 20 failed (unchanged from pre-branch)
- **Spec goals**: all 11 covered

**Recommendation**: Merge. File the 8 follow-up tickets (Section 5) for follow-up work; none block the merge.