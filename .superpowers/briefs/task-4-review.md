# Task 4 Review: Extract `ConfigStatusBar` Component

**Verdict**: Spec ✅ | Quality: Approved | 0 Critical / 0 Important / 1 Minor

Commit `3656591` on `main`. Diff at `/tmp/task4-diff.txt`.

---

## Spec Compliance

| Check | Status | Notes |
|---|---|---|
| New file `packages/zai/src/web/src/components/ConfigStatusBar.tsx` exists with default-exported `ConfigStatusBar` + correct `Props` | ✅ | File present (38 lines). `Props = { cwdName: string; branch: string; onTaskSelect: (taskId: string) => void }` matches spec verbatim. |
| Agent.tsx replaces inline `<div className="bottom-stack">` second child with `<ConfigStatusBar cwdName={cwdName} branch={branch} onTaskSelect={setSelectedTaskId} />` | ✅ | Diff hunk `@@ -1425,41 +1424,21 @@` shows the inline div removed and replaced with `<ConfigStatusBar cwdName={cwdName} branch={branch} onTaskSelect={setSelectedTaskId} />`. Sits as the second child of `<div className="bottom-stack">` after `<AgentInputBox />`. |
| JSX body inside `ConfigStatusBar` is byte-equivalent to inline | ✅ | Verified line-by-line against the removed hunk. Style object identical (borderTop/padding/fontSize/fontFamily/color/display/alignItems/gap). Child order identical: `<ModeStatusButton />` → cwdName span (`#eab308`) → `·` → branch span (`#22c55e`) → `·` → ModelStatusButton wrapper span (`#f97316`) → `·` → `<TaskDock onSelect={onTaskSelect} />`. All hex/rgba values preserved verbatim. The only wiring delta is `TaskDock onSelect={onTaskSelect}` (prop) vs inline `onSelect={setSelectedTaskId}` (closure) — semantically identical because the call site passes `onTaskSelect={setSelectedTaskId}`. |
| Import `import ConfigStatusBar from "../components/ConfigStatusBar";` added | ✅ | Inserted at line 46 of Agent.tsx, adjacent to other component imports. |
| Commit message verbatim | ✅ | `refactor(zai-web): extract inline bottom config bar into ConfigStatusBar component` — exact match. |
| Scope: only 2 listed files touched | ✅ | `git show --stat` confirms only `packages/zai/src/web/src/components/ConfigStatusBar.tsx` and `packages/zai/src/web/src/pages/Agent.tsx`. 45 insertions, 28 deletions. |

**Result**: ✅ All spec items pass.

---

## Quality Review

### Mechanical refactor hygiene

The implementer removed three imports from Agent.tsx that became dead after the extraction:
- `import ModelStatusButton from "../components/ModelStatusButton"`
- `ModeStatusButton` default import (replaced with `{ MODE_CYCLE_ORDER }` named import only — that constant is still used elsewhere)
- `import { TaskDock } from "../components/TaskDock"`

**Verified truly unused via grep**:
- `ModelStatusButton` → 0 matches remaining in Agent.tsx
- `ModeStatusButton` (default) → 0 matches; `MODE_CYCLE_ORDER` retained at line 45
- `TaskDock` → 0 matches

Removals are safe and required for typecheck exit 0. Sensible cleanup — not over-reach.

### Documented brief deviation (correctly handled)

The brief's snippet used **named imports** for `ModelStatusButton` and `ModeStatusButton`:
```tsx
import { ModelStatusButton } from "./ModelStatusButton";
import { ModeStatusButton } from "./ModeStatusButton";
```

The implementer used **default imports** instead:
```tsx
import ModelStatusButton from "./ModelStatusButton";
import ModeStatusButton from "./ModeStatusButton";
```

This is correct. Both sibling components use `export default function`, and Agent.tsx itself (and other files in the codebase) consistently default-imports them. The brief's snippet was a stylistic oversight; following actual file convention is the right call. The implementer documented this clearly in the report. `TaskDock` correctly stays as a named import since it uses `export function`.

### JSX fidelity

The new component's body is functionally identical to the inline div that was removed. Verified:
- Wrapper `<div>` props: identical style object
- 8 children in identical order with identical inline `style={{ color: ... }}` on each `<span>`
- `TaskDock` prop name change (`onSelect={setSelectedTaskId}` → `onSelect={onTaskSelect}`) is a pure renaming, not a behavior change

### Component shape

- Default export — matches the project's component convention (`ModelStatusButton`, `ModeStatusButton`, `TaskDrawer`, etc. all default-export)
- `Props` defined as a `type` alias — consistent with the brief's own snippet
- Destructured props on the function signature — clean and idiomatic

### No behavioral or visual change

- Same wrapper element (still a `<div>` inside `.bottom-stack`)
- Same style values, same child tree
- Same `setSelectedTaskId` closure flowing through `onTaskSelect` prop

The optional visual verification step (manual browser comparison at `/agent`) was not run by the implementer — they noted this as "visual claim" rather than executed step. Given the byte-equivalence of the JSX body, this is acceptable for a mechanical extraction, though flagging as a Minor below.

---

## Findings

### Minor (1)

1. **No missing newline at EOF in `ConfigStatusBar.tsx`** — File ends with `}` and no trailing newline (`xxd` confirms final byte is `0x7d`, not `0x0a`). Most editors and linters expect POSIX text files to end with a newline. The brief's `Write` operation would not have produced this; this looks like the implementer's `git commit` ran with content that lacked the final `\n`. Trivial to fix; some pre-commit hooks (Prettier, ESLint) may flag it. Cosmetic only — does not affect runtime, typecheck, or visual output.

### Critical: 0
### Important: 0
### Minor: 1

---

## Approval

**Status**: Approved.

This is a clean mechanical refactor. The extraction is byte-equivalent, scope is tight, the three orphan imports are correctly pruned, and the one brief deviation (default vs named imports) is actually a faithful fix — the brief's snippet was wrong about the existing convention, and the implementer correctly deferred to the codebase.

The single Minor finding (missing trailing newline) is cosmetic and not blocking. Recommend the implementer add the trailing `\n` at their convenience, but the task can be marked complete.