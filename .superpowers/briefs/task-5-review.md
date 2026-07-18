# Task 5 Review — TodoDropdown component

**Reviewer**: agent
**Date**: 2026-07-18
**Commit reviewed**: `af827fb` on `main`
**Diff**: `/tmp/task5-diff.txt` (1 file, +176 lines)
**File on disk**: `packages/zai/src/web/src/components/TodoDropdown.tsx`

---

## Verdict

**Spec compliance**: ✅
**Quality**: Approved
**Findings**: 0 Critical / 0 Important / 1 Minor

---

## Spec checklist

| # | Requirement | Status | Evidence |
|---|-------------|--------|----------|
| 1 | New file `TodoDropdown.tsx` default-exports `TodoDropdown` with `Props = { todos: TodoItem[]; v2Tasks: V2TaskItem[] }` | ✅ | file line 2 (`type Props = { todos: TodoItem[]; v2Tasks: V2TaskItem[] }`) + line 74 (`export default function TodoDropdown({ todos, v2Tasks }: Props)`) |
| 2 | Empty state: both arrays empty → render `<div data-testid="todo-dropdown-empty">暂无任务或 TODO</div>` and early-return | ✅ | lines 79–87 — `isEmpty` short-circuits before the two-section render. Wrapper carries `data-testid="todo-dropdown-empty"` and body renders the exact Chinese copy `暂无任务或 TODO` |
| 3 | Two-section render: TODO section only when `todos.length > 0`; V2 section only when `v2Tasks.length > 0`; divider between when both | ✅ | lines 91–126 (TODO branch) + 128–172 (V2 branch). Divider at line 130 is *inside* the V2 branch, so it only renders when both arrays have content. Correct. |
| 4 | Status icons match `TodoZone.tsx` (`☐ / ■ / ✓`) | ✅ | `todoIcon` lines 48–52 returns `☐ / ■ / ✓`. `v2Icon` lines 54–59 adds `✗` for `deleted` (correct per brief — V2 has 4 statuses vs TODO's 3). |
| 5 | Colors — in_progress `#a78bfa`, completed `#52c41a`, pending `rgba(255,255,255,0.40)`, V2 deleted `#f5222d` | ✅ | `todoColor` lines 61–65 + `v2Color` lines 67–72 — all four hex/rgba values match spec verbatim |
| 6 | data-testids exactly `todo-dropdown`, `todo-dropdown-empty`, `todo-dropdown-item-${status}`, `v2-task-dropdown-item-${status}` | ✅ | line 83 (`todo-dropdown-empty`), line 90 (`todo-dropdown`), line 104 (`todo-dropdown-item-${t.status}`), line 142 (`v2-task-dropdown-item-${t.status}`). All four strings match Task 6's brief verbatim — critical for the planned tests |
| 7 | Helper functions `todoIcon`, `todoColor`, `v2Icon`, `v2Color` map statuses correctly | ✅ | All four functions present (lines 48–72); behaviour matches spec table |
| 8 | `blockedBy` chip when `t.blockedBy.length > 0` → render `依赖 N` | ✅ | lines 163–167 — chip text `依赖 {t.blockedBy.length}` with subdued color |
| 9 | Completed text styling: `line-through` for completed TODO | ✅ | TODO row: line 117 sets `textDecoration: 'line-through'` only when `status === 'completed'`. V2 row: lines 155–157 extend strikethrough to `'completed' \|\| 'deleted'` (correct — deleted is also visually de-emphasized) |
| 10 | TypeScript imports `V2TaskItem` and `TodoItem` from `../store/useAgentStore.js` | ✅ | line 0 — `import type { TodoItem, V2TaskItem } from '../store/useAgentStore.js'`. Verified the types are exported from `packages/zai/src/web/src/store/useAgentStore.ts` lines 10 and 20. |
| 11 | Commit message `feat(zai-web): TodoDropdown panel covers legacy TodoWrite + V2 TaskList` | ✅ | Reported in task report line 9, matches brief's Step 3 commit string |
| 12 | No zustand inside component — presentation only | ✅ | No `import { useAgentStore }` or any value import from the store. Only `import type` for type definitions. No `useState`, `useEffect`, no store hooks. Pure prop-driven render. |

**Result**: 12/12 spec items met.

---

## Code quality rubric

### Test id names match brief's exact strings — **PASS**
Verified all four `data-testid` strings against the brief text (Step 1's JSX block + the spec checklist bullets). Strings are byte-identical:
- `todo-dropdown-empty` (line 83) ✓
- `todo-dropdown` (line 90) ✓
- `todo-dropdown-item-${status}` (line 104) ✓
- `v2-task-dropdown-item-${status}` (line 142) ✓

Task 6's test plan can plug in without modification.

### No TypeScript `any` or unsafe casts — **PASS**
- `Props` is fully typed against the store's exported types
- `t.description ?? t.subject` (line 159) correctly handles the optional `description` field with optional chaining rather than `!` or `as`
- `t.status` accessed via typed `TodoItem['status']` / `V2TaskItem['status']` indexes — exhaustive-enough for the runtime check
- No `as`, `any`, `@ts-ignore`, or non-null assertions anywhere in the file

### No unused imports / dead code — **PASS**
Single import line: `import type { TodoItem, V2TaskItem } from '../store/useAgentStore.js'` — both names used in `Props`. No dead branches; the `if (status === 'deleted')` path in `todoIcon` is unreachable but the function signature is intentionally limited to `TodoItem['status']` which excludes `'deleted'` — TypeScript guarantees it never fires. The two helper pairs (`todoIcon`/`v2Icon` and `todoColor`/`v2Color`) duplicate code but per brief "Ambiguities" §5 the implementer correctly preserved this for type-system isolation between the two statuses — reasonable choice for 4 short functions.

### No `useAgentStore` value import — **PASS**
Only `import type { ... }`. Component is pure presentation with props as the single data source.

---

## Findings

### Critical
*(none)*

### Important
*(none)*

### Minor

**M1. Missing trailing newline at EOF**
- **File**: `packages/zai/src/web/src/components/TodoDropdown.tsx` (last byte)
- **Observation**: `tail -c 5` shows the file ends with `}` and no `\n`. The sibling file `packages/zai/src/web/src/components/TodoZone.tsx` does end with a newline. Most lint configs and `git diff` ergonomics expect a POSIX-style trailing newline on `.tsx` files.
- **Impact**: Cosmetic / git-diff noise. Some pre-commit hooks (Prettier, ESLint `eol-last` rule) may flag this and reformat the file on next run, producing an unintended dirty diff. No behavioural impact.
- **Fix**: append a single `\n` at EOF.
- **Why Minor, not Important**: doesn't affect compile, runtime, or test pass/fail; the typecheck and tests succeed.

---

## Deviations from brief (acknowledged & correct)

The implementer flagged three intentional deviations in `task-5-report.md` §5. I confirmed each is correct:

1. **`.js` extension on import path** (`'../store/useAgentStore.js'` vs brief's `'../store/useAgentStore'`) — correct: matches the codebase convention seen in `TodoZone.tsx`. `tsc` resolves both equivalently under the project's `moduleResolution`; keeping `.js` honours `TodoZone.tsx`'s style.
2. **Single `styles` const vs per-row inline `style={{}}`**: the brief's own reference snippet mixes both styles. The implementer kept brief's per-row inline overrides verbatim (lines 109–118 and 153–158) and consolidated only the truly shared entries into `styles`. No drift.
3. **Separate `todoIcon/todoColor` and `v2Icon/v2Color`**: brief explicitly said "don't refactor". Code duplication is bounded (4 small functions), and the type difference (`TodoItem['status']` excludes `'deleted'`) makes a generic helper awkward. Correctly left alone.

No new deviations introduced beyond the report's three.

---

## Type safety cross-check against the store

Cross-referenced `useAgentStore.ts`:

```ts
export type TodoItem = {
  content: string
  status: 'pending' | 'in_progress' | 'completed'
  activeForm: string
}
export type V2TaskItem = {
  id: string
  subject: string
  description?: string
  activeForm?: string
  status: 'pending' | 'in_progress' | 'completed' | 'deleted'
  blocks: string[]
  blockedBy: string[]
  owner?: string
}
```

Every field the component touches is handled correctly:
- `t.content` (line 120) — required, no guard needed ✓
- `t.subject` (line 161) — required, no guard needed ✓
- `t.description ?? t.subject` (line 159) — optional, properly coalesced ✓
- `t.status` (multiple lines) — union typed; helpers are exhaustive ✓
- `t.id` (line 138) — required for `key` ✓
- `t.blockedBy` (line 163) — required `string[]`, `.length > 0` is type-safe ✓
- Unused fields (`activeForm`, `blocks`, `owner`) are correctly not touched ✓

---

## Recommended actions

1. **Optional (cleanup)**: add trailing newline to `TodoDropdown.tsx` to match sibling files and most lint configs. One-character change. If the project has Prettier/eslint configured, this may auto-fix on next format pass.

**No blocking changes.** Task 5 is ready to merge and Task 6 (tests against these exact testids) can proceed.