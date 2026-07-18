# zai ModeStatusButton Popover Redesign Design

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Restyle the `ModeStatusButton` Popover to match the reference design (Modes title with `⇧ + tab` keycap hint + per-row icon block + bold title + dim description), while leaving behavior, the 5-mode list, and the trigger button unchanged.

**Scope:** **Style-only refactor** of `ModeStatusButton.tsx` Popover content. No new files, no store changes, no routes changes, no test infra additions. Behavior (shift+tab cycling, click-to-select, hover-follows-selectedIndex, current-mode ● marker, no-op on current mode, no-op with no sessionId) is preserved bit-for-bit. The trigger button (text button below the popover) and the bottom footer hint inside the popover are also unchanged.

**Architecture:** All visual state lives inside `ModeStatusButton.tsx` as inline JSX + style objects — no new hooks, no new components, no new CSS files. AntD is already a dependency; we add `@ant-design/icons` imports in the same file (already used in sibling components — verified by `grep -rn "@ant-design/icons" packages/zai/src/web/`).

**Tech Stack:** React 18 + antd 5 (Popover, `@ant-design/icons`) + zustand 4 (existing store). Tests use vitest + happy-dom + @testing-library/react — already configured for `packages/zai/test/web/`.

---

## Global Constraints

- **Visual-only change.** The `MODE_CYCLE` order, `MODE_META` key set (`label` / `badgeLabel` / `icon` / `color`), `pick()` callback, `selectedIndex` state, and `lastSeenModeRef` sync are untouched.
- **All 5 modes preserved.** Do NOT collapse or rename modes — user explicitly opted out of mode-count changes.
- **AntD icons only.** Use `@ant-design/icons` (already imported across the codebase); no new icon dependency. Icon-to-mode mapping below.
- **Trigger button unchanged.** The little text-button that toggles the popover keeps its label `▶▶ <badgeLabel> (shift+tab ↹)` (or `▮▮` for plan mode) verbatim.
- **Bottom footer preserved.** The "click to select · shift+tab to cycle" hint stays in place, styling unchanged.
- **Current-mode marker unchanged.** The purple `●` on the left of the current row stays. Behavior: clicking the current row is a no-op; clicking another row calls `patchSessionMode`.
- **Keyboard interaction unchanged.** Hover-follows-selectedIndex + click-to-select remains the only interactive mechanics; no ↑/↓/Enter added (user opted to keep existing).
- **No new tests file.** Existing tests for `ModeStatusButton` — none exist today; we add **one new test file** `packages/zai/test/web/ModeStatusButton.test.tsx` with the 10 cases below.

---

## File changes

**Modified**:
- `packages/zai/src/web/src/components/ModeStatusButton.tsx` — full rewrite (single file, ~200 lines, was 168)

**Added**:
- `packages/zai/test/web/ModeStatusButton.test.tsx` — 10 new tests (new file)

**No store / hook / route / dependency changes.**

---

## Visuals (after)

```
┌─────────────────────────────────────────────┐  width: 380px / radius: 10px / bg: #1f1f1f
│ Modes                            ⇧ + tab    │  ← header (keycap hint)
├─────────────────────────────────────────────┤
│ ●  [ Hand ]  default                        │
│             Claude will ask for approval…   │  ← current mode: tint border icon, bold title
│ ─────────────────────────────────────────── │
│    [ Code ]  accept edits                   │
│             Claude will edit your select…   │
│ ─────────────────────────────────────────── │
│    [ File ]  plan                           │
│             Claude will explore the code…   │
│ ─────────────────────────────────────────── │
│    [ ⚡  ]  bypass permissions               │  ← red tint for high-risk
│             Claude will approve all act…    │
│ ─────────────────────────────────────────── │
│    [ ❓ ]  don't ask                         │
│             Claude will not pause to ask…   │
├─────────────────────────────────────────────┤
│ click to select · shift+tab to cycle        │  ← footer unchanged
└─────────────────────────────────────────────┘
```

Trigger button (no change):

```
▶▶ default on (shift+tab ↹)
```

---

## Icon mapping

| mode key          | AntD icon component       | tint color (kept from MODE_META) |
|-------------------|---------------------------|-----------------------------------|
| `default`         | `HandOutlined`            | `rgba(255,255,255,0.65)`          |
| `acceptEdits`     | `CodeOutlined`            | `#a78bfa`                         |
| `plan`            | `FileTextOutlined`        | `#5eead4`                         |
| `bypassPermissions` | `ThunderboltOutlined`    | `#f43f5e`                         |
| `dontAsk`         | `QuestionCircleOutlined`  | `#f43f5e`                         |

Imports:
```ts
import {
  HandOutlined,
  CodeOutlined,
  FileTextOutlined,
  ThunderboltOutlined,
  QuestionCircleOutlined,
} from '@ant-design/icons'
```

---

## Label & description mapping (display text only — `MODE_META` stays as-is; new text rendered in the Popover body via a sibling `MODE_BODY` map)

`MODE_META` keeps its current schema (`label` / `badgeLabel` / `icon` / `color`) — those are still used for the trigger button. We introduce a sibling constant **in the same file** for the Popover body:

```ts
interface ModeBody {
  title: string
  description: string
}

const MODE_BODY: Record<PermissionMode, ModeBody> = {
  default: {
    title: 'default',
    description: 'Claude will ask for approval before each edit',
  },
  acceptEdits: {
    title: 'accept edits',
    description: 'Claude will edit your selected text or the whole file',
  },
  plan: {
    title: 'plan',
    description: 'Claude will explore the code and present a plan before editing',
  },
  bypassPermissions: {
    title: 'bypass permissions',
    description: 'Claude will approve all actions without asking',
  },
  dontAsk: {
    title: "don't ask",
    description: 'Claude will not pause to ask any questions',
  },
}
```

Descriptions for `bypassPermissions` and `dontAsk` are **drafted** during brainstorming (not from the reference screenshot, which has only 4 modes). They capture the semantic distinction: "approve everything" vs. "no questions at all".

---

## Layout structure

```tsx
<Popover content={<div onClick={(e) => e.stopPropagation()}>{content}</div>} trigger="click" placement="topRight" destroyTooltipOnHide>
  <Button /* unchanged trigger */ />
</Popover>

content = (
  <div data-testid="mode-picker-content" tabIndex={-1} style={...}>
    {/* Header */}
    <div style={{ display:'flex', justifyContent:'space-between', alignItems:'center', marginBottom: 8 }}>
      <span data-testid="mode-picker-title">Modes</span>
      <span style={{ display:'inline-flex', alignItems:'center', gap:4 }}>
        <span style={kbdStyle}>⇧</span>
        <span style={plusStyle}>+</span>
        <span style={kbdStyle}>tab</span>
      </span>
    </div>

    {/* Rows */}
    {MODE_CYCLE.map((m, i) => (
      <Row /* per-row markup, see below */ />
    ))}

    {/* Footer (unchanged behavior, same text, identical styles) */}
    <div style={{ /* unchanged from current file */ }}>
      click to select · shift+tab to cycle
    </div>
  </div>
)
```

### Header styles

```ts
const titleStyle: React.CSSProperties = {
  fontSize: 13,
  fontWeight: 600,
  color: 'rgba(255,255,255,0.85)',
}

const kbdStyle: React.CSSProperties = {
  padding: '2px 6px',
  fontSize: 11,
  background: 'rgba(255,255,255,0.08)',
  border: '1px solid rgba(255,255,255,0.18)',
  borderRadius: 4,
  color: 'rgba(255,255,255,0.85)',
  fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace',
  lineHeight: 1.2,
  minWidth: 18,
  textAlign: 'center',
}

const plusStyle: React.CSSProperties = {
  color: 'rgba(255,255,255,0.45)',
  fontSize: 11,
}
```

### Row markup (replaces the current single-line row)

```tsx
const Row = ({ mode, isCurrent, isSelected, onClick, onMouseEnter }: RowProps) => {
  const tint = MODE_META[mode].color
  const body = MODE_BODY[mode]
  return (
    <div
      key={mode}
      data-testid={`mode-row-${mode}`}
      data-current={isCurrent ? 'true' : 'false'}
      data-selected={isSelected ? 'true' : 'false'}
      onClick={onClick}
      onMouseEnter={onMouseEnter}
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 10,
        padding: '8px 10px',
        borderRadius: 6,
        cursor: isCurrent ? 'default' : 'pointer',
        background: isSelected ? 'rgba(168,139,250,0.10)' : 'transparent',
        border: isSelected ? '1px solid rgba(168,139,250,0.35)' : '1px solid transparent',
        marginBottom: 2,
      }}
    >
      {/* Current-mode ● marker (kept from current implementation) */}
      <span
        style={{
          width: 8,
          color: '#a78bfa',
          fontSize: 12,
          textAlign: 'center',
          visibility: isCurrent ? 'visible' : 'hidden',
        }}
      >
        ●
      </span>

      {/* Icon block */}
      <span
        style={{
          width: 32,
          height: 32,
          borderRadius: 6,
          background: 'rgba(255,255,255,0.05)',
          border: '1px solid rgba(255,255,255,0.08)',
          display: 'inline-flex',
          alignItems: 'center',
          justifyContent: 'center',
          color: tint,
          fontSize: 16,
          flexShrink: 0,
        }}
      >
        <IconFor mode={mode} />
      </span>

      {/* Two-line text */}
      <div style={{ display: 'flex', flexDirection: 'column', minWidth: 0, flex: 1 }}>
        <span
          style={{
            fontSize: 13,
            fontWeight: isCurrent ? 600 : 500,
            color: '#fff',
            lineHeight: 1.3,
            whiteSpace: 'nowrap',
            overflow: 'hidden',
            textOverflow: 'ellipsis',
          }}
        >
          {body.title}
        </span>
        <span
          style={{
            fontSize: 11,
            color: 'rgba(255,255,255,0.55)',
            lineHeight: 1.3,
            whiteSpace: 'nowrap',
            overflow: 'hidden',
            textOverflow: 'ellipsis',
          }}
        >
          {body.description}
        </span>
      </div>
    </div>
  )
}
```

`<IconFor mode={mode} />` is a tiny inline switch:

```tsx
const IconFor = ({ mode }: { mode: PermissionMode }) => {
  switch (mode) {
    case 'default': return <HandOutlined />
    case 'acceptEdits': return <CodeOutlined />
    case 'plan': return <FileTextOutlined />
    case 'bypassPermissions': return <ThunderboltOutlined />
    case 'dontAsk': return <QuestionCircleOutlined />
  }
}
```

### Container style

```ts
const containerStyle: React.CSSProperties = {
  width: 380,
  background: '#1f1f1f',
  color: '#fff',
  borderRadius: 10,
  padding: 10,
}
```

(Padding reduced from 8 → 10 to better seat the 32px icon blocks; width increased from 280 → 380 to fit "Claude will explore the code and present a plan before editing" without ellipsis on standard widths.)

---

## Component structure (final)

```tsx
import { useMemo, useRef, useState } from 'react'
import { Button, Popover } from 'antd'
import {
  HandOutlined,
  CodeOutlined,
  FileTextOutlined,
  ThunderboltOutlined,
  QuestionCircleOutlined,
} from '@ant-design/icons'
import { useAgentStore } from '../store/useAgentStore.js'
import type { PermissionMode } from '@zn-ai/zai-agent-core/runtime'

const MODE_CYCLE: PermissionMode[] = [/* unchanged */]
const MODE_META: Record<PermissionMode, { label, badgeLabel, icon, color }> = {/* unchanged */}

interface ModeBody { title: string; description: string }
const MODE_BODY: Record<PermissionMode, ModeBody> = {/* see table above */}

export const MODE_CYCLE_ORDER = MODE_CYCLE  // unchanged export

function IconFor({ mode }: { mode: PermissionMode }) {/* switch */}

export default function ModeStatusButton() {
  /* state, sync logic, pick callback — UNCHANGED from current file */

  return (
    <Popover
      content={
        <div onClick={(e) => e.stopPropagation()}>
          <div /* header */ />
          {MODE_CYCLE.map((m, i) => (
            <Row
              key={m}
              mode={m}
              isCurrent={m === currentMode}
              isSelected={i === selectedIndex}
              onClick={() => pick(m)}
              onMouseEnter={() => setSelectedIndex(i)}
            />
          ))}
          <div /* footer unchanged */>
            click to select · shift+tab to cycle
          </div>
        </div>
      }
      trigger="click"
      placement="topRight"
      destroyTooltipOnHide
    >
      <Button /* unchanged trigger */ />
    </Popover>
  )
}
```

---

## Edge cases

| Case | Behavior |
|---|---|
| `currentSession` is `null` | All 5 rows render; clicking any row is a no-op (early return in `pick()` is unchanged). |
| `currentMode` not in `MODE_CYCLE` (shouldn't happen — `default` is fallback) | `selectedIndex` initializer → 0 via existing fallback (`=== -1 ? 0 : idx`). |
| PATCH response updates store while popover open | `lastSeenModeRef` sync block reconciles `selectedIndex` to current mode (unchanged). |
| Popover close + reopen | `destroyTooltipOnHide` resets component state on remount. |
| Long description overflow | `white-space: nowrap` + `text-overflow: ellipsis` clips at right edge of `380px` width. |
| High-contrast / accessibility | Icon inherited from `tint` provides 3:1+ contrast against `#1f1f1f` background. `currentMode ●` is the canonical "current" indicator (keyboard-screen-reader-friendly). |
| Plan mode `▮▮` badge | Trigger button still uses `▮▮` while `plan` mode is active — unchanged. Popover row uses `FileTextOutlined` (the 2-row layout makes the icon a separate concern from the badge). |

---

## Error handling

- **AntD icon missing import**: addressed at import site — all 5 icons imported. `tsc` catches a missing import.
- **`PermissionMode` exhaustiveness**: the `IconFor` `switch` covers all 5 keys; if a 6th is ever added, `tsc` will flag the missing case (TS will infer `never` on the implicit fallthrough). A defensive `default: return null` is **NOT** added (avoids masking an unhandled future mode).
- **All other behaviors preserved verbatim** — `pick()` returns early on current mode and missing sessionId (unchanged).

---

## Test plan (10 cases in `packages/zai/test/web/ModeStatusButton.test.tsx`)

| # | Test | Assertion |
|---|---|---|
| T1 | renders trigger button with current mode badge | Trigger `<button>` exists with text containing the current mode label (e.g. "default on"). |
| T2 | clicking trigger opens popover with 5 rows | After click, 5 elements with `data-testid="mode-row-*"` render. |
| T3 | current-mode row carries `data-current="true"` and the bold title | `data-current="true"` on the matching row; the body title for that row has fontWeight ≥ 600 (inline-style inspect). |
| T4 | non-current rows carry `data-current="false"` | All other 4 rows have `data-current="false"`. |
| T5 | hover row updates `data-selected="true"` | `fireEvent.mouseEnter(row)` on row #2 → that row's `data-selected="true"`, others false. |
| T6 | clicking non-current row calls `patchSessionMode` with that mode | Spy on store; click row 2; expect `patchSessionMode(sessionId, 'plan')` (or whichever). |
| T7 | clicking current-mode row is no-op (does NOT call `patchSessionMode`) | Click current-mode row → spy not called. |
| T8 | with no sessionId, click is no-op | Set session state to `null`; click any row → spy not called. |
| T9 | header shows "Modes" and renders two kbd-like spans | `data-testid="mode-picker-title"` text equals "Modes"; two `<span>` with keycap styles exist (visually verified via inline style inspection on `border: 1px solid rgba(255,255,255,0.18)`). |
| T10 | icon block for `bypassPermissions` row contains `ThunderboltOutlined` SVG | Query the row's icon container; expect an `<svg>` with the `anticon` class and the icon name (`data-icon="thunderbolt"` or similar). Spot-check at least one icon per type to keep tests fast. |

Test infra follows the existing `ModelStatusButton.test.tsx` pattern: render via `@testing-library/react`, mock `useAgentStore` with a minimal stub. `happy-dom` + `@testing-library/dom` already configured in `vitest.config.ts` (verified).

---

## Out of scope

- Trigger button label / icon changes — explicitly kept unchanged per user decision.
- Bottom footer (click to select · shift+tab to cycle) — explicitly kept unchanged per user decision.
- Keyboard navigation expansion (↑/↓/Enter) — explicitly kept unchanged per user decision.
- Mode semantics, mode count, mode keys — explicitly preserved.
- `ModelStatusButton` (the sibling component) — different file; out of scope.
- Stripping the `MODE_CYCLE_ORDER` export — keep it because something (or some test) may import it; the contract change is not authorized.

---

## Verification

After implementation:

```bash
# In repo root
pnpm --filter zai typecheck
pnpm --filter zai lint
pnpm --filter zai test
```

Manual sanity check (browser):
1. Open `http://localhost:5173` (dev server)
2. Trigger mode picker (click the mode badge in the bottom bar)
3. Confirm: 380px wide, "Modes" header, `⇧ + tab` keycap hint
4. Confirm: 5 rows each with icon block + bold title + dim description
5. Confirm: current-mode row has ● + bold title; non-current rows do not
6. Confirm: hover any row → background `rgba(168,139,250,0.10)` + border `rgba(168,139,250,0.35)`
7. Confirm: clicking another row updates current mode (visible in badge) and closes popover
8. Confirm: shift+tab cycles current mode (unchanged behavior)
9. Confirm: trigger button label is still `▶▶ <badgeLabel> (shift+tab ↹)` (or `▮▮` for plan)
10. Confirm: footer hint still reads "click to select · shift+tab to cycle"
