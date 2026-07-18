# Task 7 Report

## Status
**DONE**

## Commits
```
06e2e99 feat(zai-web): add BottomStatusBar above input box for merged TODO + V2 task summary
```

`git log --oneline 9aa9082..HEAD`:
```
06e2e99 feat(zai-web): add BottomStatusBar above input box for merged TODO + V2 task summary
```

## Verification
- `pnpm --filter @zn-ai/zai typecheck` → **exit 0**
- Diff stats: **2 files changed, 96 insertions(+)** (1 new file + 7 lines in Agent.tsx)
- JSX insertion verified at line 1436: `<BottomStatusBar>` sits between `</div>` (messages container, line 1434) and `<div className="bottom-stack">` (line 1438) — **above the input box**, per brief.

## Component shape
- ✅ **Named export** (`export function BottomStatusBar(...)` at line 13) — NOT default; matches `TaskDock.tsx` sibling convention.
- ✅ Props: `{ todos: TodoItem[]; v2Tasks: V2TaskItem[]; label?: string }` — `label` defaults to `"任务"`.
- ✅ Data-testids present:
  - `bottom-status-trigger` (line 32) — wraps the clickable trigger row
  - `bottom-status-summary` (line 52) — wraps the `N/M 任务 · K 进行中 · J 待开始` summary
  - `bottom-status-popover` (line 74) — wraps the AntD Popover
- ✅ Color codes match palette: `#a78bfa` (in_progress accent), `#52c41a` (full-completion green), `rgba(255,255,255,0.55)` (muted text).
- ✅ Uses `CaretUpOutlined` from `@ant-design/icons` for upward caret (Popover placement="topRight").

## Agent.tsx patches applied (4 sub-patches, in order)
1. **Import**: added `V2TaskItem` to the `useAgentStore` type import block; added `import { BottomStatusBar } from "../components/BottomStatusBar";` (line 50).
2. **Store selector**: added `const v2TasksBySession = useAgentStore((s) => s.v2TasksBySession);` immediately after the `todosBySession` selector (same pattern as Task 2/3 wiring).
3. **Derived value**: added `const v2TasksForCurrentSession: V2TaskItem[] = sessionId != null ? (v2TasksBySession[sessionId] ?? []) : [];` directly below the existing `todosForCurrentSession` derivation.
4. **JSX insertion**: inserted `<BottomStatusBar todos={todosForCurrentSession} v2Tasks={v2TasksForCurrentSession} />` BEFORE `<div className="bottom-stack">` (line 1438), AFTER the messages container `</div>` (line 1434) — the red-box position.

## Brief checklist
- [x] Step 1: BottomStatusBar.tsx created with exact code from brief (named export, Popover+Tooltip+CaretUpOutlined wiring, summary formula, data-testids).
- [x] Step 2: Agent.tsx wired (import + store selector + derived value + JSX insertion at correct location).
- [x] Step 3: `pnpm --filter @zn-ai/zai typecheck` → pass.
- [ ] Step 4: Browser visual verification deferred (no dev server running in agent context).
- [x] Step 5: Commit with exact message from brief.

## Boundaries respected
- ✅ No edits outside `BottomStatusBar.tsx` (new) and `Agent.tsx` (modified).
- ✅ Did not modify `TodoDropdown.tsx` (Task 5's component).
- ✅ Did not modify the store (Task 2 already added `v2TasksBySession` slice).
- ✅ No new dependencies — `antd` and `@ant-design/icons` already in package.
- ✅ Did not push to remote.