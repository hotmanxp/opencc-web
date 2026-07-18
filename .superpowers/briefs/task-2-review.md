# Task 2 Review — V2 TaskList store slice + fetchV2Tasks client API

**Commit**: `c5dca77` on `main`
**Status**: DONE_WITH_CONCERNS (implementer-flagged: vitest directive + naming, both pre-documented)
**Reviewer**: independent code review

---

## Spec Compliance Checklist

| Item | Status | Evidence |
|------|--------|----------|
| `V2TaskItem` type after `TodoItem` | ✅ | Diff line 102-116, matches brief lines 23-33 verbatim (id, subject, description?, activeForm?, 4-status enum, blocks, blockedBy, owner?, updatedAt) |
| `AgentState` interface extended | ✅ | Diff line 139-144, four new fields with correct signatures |
| Initial state `v2TasksBySession: {}` | ✅ | Diff line 167 |
| Three action functions verbatim | ✅ | Diff lines 174-199, byte-for-byte match to brief (immutable spread pattern used in all three) |
| `clearMessages` resets v2TasksBySession for current sid | ✅ | Diff lines 222-224 + line 234; placement matches todosBySession pattern (declared right after, returns together) |
| `v2TaskApi.ts` with correct URL + token header | ✅ | Diff lines 78-85: `/api/agent/sessions/${encodeURIComponent(sessionId)}/v2-tasks`, `X-Zai-Token` header via `getHeaders()` |
| 2 tests, both pass | ✅ | Implementer report: 2/2 pass. Pre-existing 20 unrelated failures verified not caused by this change. |
| Commit message exact | ✅ | `c5dca77 feat(zai-web): add v2TasksBySession store slice + fetchV2Tasks client API` (exact match to brief line 167) |
| Scope: only 3 listed files touched | ✅ | `git show --stat c5dca77` confirms 3 files, +128 lines |

**Spec verdict**: ✅ Full compliance.

---

## Code Quality Review

### Store actions immutability (the high-risk area)

All three actions use the immutable spread pattern `{ ...s.v2TasksBySession, [sessionId]: ... }`. No direct mutation detected.

- `setV2Tasks` (lines 174-177): pure spread replacement — safe
- `updateV2Task` (lines 179-188): reads current list, builds `next` via `.map()` or spread, spreads into new session-keyed object — safe
- `deleteV2Task` (lines 190-198): reads current list, `.filter()` produces new array, spreads into new session-keyed object — safe

**No mutation bug**. Matches the `setTodos` precedent in the same file.

### TypeScript safety

- `V2TaskItem.status` covers all 4 enum values: `'pending' | 'in_progress' | 'completed' | 'deleted'` ✅
- No `any` casts in production code (only `// @ts-expect-error mock fetch` in tests, which is correct)
- `as Record<string, V2TaskItem[]>` in `clearMessages` is consistent with the pre-existing `as Record<string, TodoItem[]>` cast for `todosBySession` — same pattern, no new issue

### `clearMessages` ordering

The v2 destructuring runs **after** the todos destructuring but **before** the `return`. Both produce independent `rest` and `restV2` constants then are returned together. Order is fine and consistent with the brief's intent (matches todosBySession shape).

### Test coverage gap (worth flagging as Minor)

The brief's `getHeaders()` falls back to `{}` when no token is in localStorage. This means a user who hasn't authenticated (or whose token expired) will silently hit `/api/agent/sessions/.../v2-tasks` with **no auth header**. The server presumably returns 401, which `fetchV2Tasks` will surface as a generic error (`v2-tasks fetch failed: 401`). This is:

1. **A missed test case**: no test covers the missing-token path. The brief specified only 2 tests, so this is technically in-spec, but a 3rd test asserting `getHeaders` is empty without a token (or that `fetch` is called with no `X-Zai-Token` header) would lock down auth behavior.
2. **A minor auth concern**: silently hitting an authenticated endpoint without a token is a fragile pattern. A future caller could misinterpret the resulting 401 as a server bug. However, this matches the existing `loadSessions` pattern in the same file (line 240-242), so it's consistent with project convention — not a regression.

Severity: **Minor**. Carry forward; do not block merge. Worth a future ticket: "audit all `X-Zai-Token` callers for missing-token error UX" — likely outside Task 2's scope.

### Test file: redundant localStorage stub

`v2TaskApi.test.ts` declares `// @vitest-environment happy-dom` AND defines a `memoryStorage` stub that is then assigned to `globalThis.localStorage` in `beforeEach`. With happy-dom active, `localStorage` is already a real Storage implementation, so the stub is redundant — it overrides the real one with an in-memory equivalent.

Functionally harmless (both support the same API surface), but the comment at line 5-8 contradicts the directive at line 1 (says "不加 @vitest-environment happy-dom 是为了..." but then the file IS using happy-dom). The comment is stale.

Severity: **Minor** (cosmetic). Either:
- Drop the `memoryStorage` stub + assignment (rely on happy-dom's real localStorage), and fix the misleading comment, OR
- Drop the `// @vitest-environment happy-dom` directive + rewrite the comment to explain the stub choice.

Either resolution is fine; both achieve the same test outcome. Not a blocker.

### Trailing newline missing

Both `v2TaskApi.ts` (line 86 of diff: `\ No newline at end of file`) and `v2TaskApi.test.ts` (line 58 of diff: same) lack a trailing newline. The brief's code blocks also lack them in the rendered diff, so this matches the brief. Worth a future lint rule, but not a defect introduced by this change.

---

## Findings Summary

| # | Severity | Finding | Action |
|---|----------|---------|--------|
| 1 | Minor | No test for missing-token auth path in `getHeaders()` | Carry forward; add a `getHeaders` unit test in a future task |
| 2 | Minor | `v2TaskApi.test.ts` has redundant localStorage stub + stale comment contradicting the `@vitest-environment` directive | Carry forward; clean up in next test file pass |
| 3 | Minor | Missing trailing newlines on two new files | Carry forward; repo linter should handle |

No Critical or Important findings.

---

## Final Verdicts

- **Spec compliance**: ✅
- **Code quality**: Approved

The implementer's two flagged concerns (vitest directive necessity, `v2TasksBySession` naming) are correctly documented and well-resolved. The diff is clean, immutable, type-safe, and exactly matches the brief's code blocks. Recommend merge.