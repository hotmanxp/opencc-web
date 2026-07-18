# zai ModeStatusButton Popover Redesign Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Restyle the `ModeStatusButton` Popover content to match the reference design (header keycap hint + icon block + bold title + dim description rows) while preserving all behavior, the 5-mode list, the trigger button, and the bottom footer.

**Architecture:** Style-only refactor of a single existing component (`ModeStatusButton.tsx`). Inline JSX + style objects within the file; the trigger `<Button>`, the bottom footer hint, `MODE_CYCLE`, `MODE_META`, `pick()`, `selectedIndex`, and `lastSeenModeRef` are preserved verbatim. A sibling `MODE_BODY` constant added for the new title/description text in the popover body. AntD icons imported from `@ant-design/icons` (already used across the codebase; verified by `grep -rn "@ant-design/icons" packages/zai/src/web/`).

**Tech Stack:** React 18 + antd 5 + zustand 4 (existing store) + vitest + happy-dom + @testing-library/react. Tests live in `packages/zai/test/web/`.

---

## Global Constraints

- **Visual-only refactor.** `MODE_CYCLE` order, `MODE_META` key set (`label` / `badgeLabel` / `icon` / `color`), `pick()` callback (early-returns on current mode / missing sessionId), `selectedIndex` state, and `lastSeenModeRef` sync block stay identical to the current file.
- **All 5 modes preserved.** Do NOT collapse or rename modes. The 5-mode `PermissionMode` set (`default` / `acceptEdits` / `plan` / `bypassPermissions` / `dontAsk`) stays exactly as today.
- **AntD icons only.** Use icons from `@ant-design/icons`: `HandOutlined`, `CodeOutlined`, `FileTextOutlined`, `ThunderboltOutlined`, `QuestionCircleOutlined`. No new icon dependency.
- **Trigger button unchanged.** The little text-`<Button>` inside `<Popover>` keeps its label `▶▶ <badgeLabel> (shift+tab ↹)` (or `▮▮` for plan mode).
- **Bottom footer preserved.** The "click to select · shift+tab to cycle" hint stays at the bottom of the popover content, with the same styling it has today.
- **Current-mode marker unchanged.** The purple `●` on the left of the current row stays. Clicking the current row is a no-op; clicking another row calls `patchSessionMode`.
- **Keyboard interaction unchanged.** Hover-follows-selectedIndex + click-to-select is the only interactive mechanic. No ↑/↓/Enter keyboard nav added.
- **TypeScript path style**: `.js` import suffix on project-relative imports (matches sibling files in this component dir).
- **Test environment**: vitest with `@vitest-environment happy-dom` per-file override (matches the sibling `ModelStatusButton.test.tsx`).
- **PR scope**: only `packages/zai/src/web/src/components/ModeStatusButton.tsx` is modified and `packages/zai/test/web/ModeStatusButton.test.tsx` is added. No store / hook / route / dependency changes.

---

## File changes

**Modified**:
- `packages/zai/src/web/src/components/ModeStatusButton.tsx` — full rewrite (current 168 lines → ~250 lines)

**Added**:
- `packages/zai/test/web/ModeStatusButton.test.tsx` — new file (~180 lines, 10 tests)

**No store / hook / route / dependency changes.**

---

### Task 1: Rewrite `ModeStatusButton.tsx` to the reference design

**Files:**
- Modify: `packages/zai/src/web/src/components/ModeStatusButton.tsx` (full rewrite)

**Interfaces:**
- Consumes `PermissionMode` from `@zn-ai/zai-agent-core/runtime` (already exists; import unchanged).
- Consumes `useAgentStore` for `sessions`, `activeSessionId`, `sessionId`, `patchSessionMode` (existing fields; see `packages/zai/src/web/src/store/useAgentStore.ts:127` for `patchSessionMode` signature `(sid: string, mode: PermissionMode) => Promise<void>`).
- Produces no new exports beyond the existing `MODE_CYCLE_ORDER` (which is preserved).

- [ ] **Step 1: Read the existing file to anchor the rewrite**

Use Read on `packages/zai/src/web/src/components/ModeStatusButton.tsx` (168 lines). Confirm the exact lines for:
- `MODE_CYCLE` (5-element array of `PermissionMode`)
- `MODE_META` (4-field record: `label` / `badgeLabel` / `icon` / `color`)
- The `lastSeenModeRef` sync block (the imperative `if (lastSeenModeRef.current !== currentMode) { ... setSelectedIndex(...) }` block)
- The `pick()` early-returns (`if (mode === currentMode) return` and `if (!currentSessionId) return`)

These blocks must be copied into the new file **verbatim** to preserve behavior.

- [ ] **Step 2: Replace the file content with the rewritten version**

Use `Write` to overwrite `packages/zai/src/web/src/components/ModeStatusButton.tsx` with the exact content below. The component:
1. Keeps the imports (drop nothing, add `@ant-design/icons` icons).
2. Keeps `MODE_CYCLE`, `MODE_META`, `export const MODE_CYCLE_ORDER = MODE_CYCLE` **verbatim**.
3. Adds a new sibling `MODE_BODY` constant (title + description per mode).
4. Adds an `IconFor` helper component (5-arm switch).
5. The main `ModeStatusButton` keeps all state (`selectedIndex`, `lastSeenModeRef`) and behavior (`pick`, sync) verbatim.
6. The popover content gets a new header (title + keycap `⇧ + tab`) and a new `Row` component.
7. The trigger `<Button>` JSX is unchanged.
8. The bottom footer `<div>` (with text "click to select · shift+tab to cycle") is unchanged.

```tsx
import { useMemo, useRef, useState } from 'react'
import { Button, Popover } from 'antd'
import {
  CodeOutlined,
  FileTextOutlined,
  HandOutlined,
  QuestionCircleOutlined,
  ThunderboltOutlined,
} from '@ant-design/icons'
import { useAgentStore } from '../store/useAgentStore.js'
import type { PermissionMode } from '@zn-ai/zai-agent-core/runtime'

// Canonical cycle order (matches OpenCC TUI shift+tab order).
const MODE_CYCLE: PermissionMode[] = [
  'default',
  'acceptEdits',
  'plan',
  'bypassPermissions',
  'dontAsk',
]

// Display labels, icon, and color tints — match OpenCC TUI conventions.
// - `label`      : popover row text (e.g., "accept edits on")
// - `badgeLabel` : bottom-bar badge text suffix (e.g., "accept edits on")
// - `icon`       : "▶▶" for most modes, "▮▮" for plan mode
// - `color`      : per-mode tint; red is reserved for the two high-risk modes
//                  (bypassPermissions / dontAsk).
const MODE_META: Record<PermissionMode, {
  label: string
  badgeLabel: string
  icon: string
  color: string
}> = {
  default:           { label: 'default on',     badgeLabel: 'default on',     icon: '▶▶', color: 'rgba(255,255,255,0.65)' },
  acceptEdits:       { label: 'accept edits on', badgeLabel: 'accept edits on', icon: '▶▶', color: '#a78bfa' },
  plan:              { label: 'plan mode on',    badgeLabel: 'plan mode on',    icon: '▮▮', color: '#5eead4' },
  bypassPermissions: { label: 'bypass on',       badgeLabel: 'bypass on',       icon: '▶▶', color: '#f43f5e' },
  dontAsk:           { label: "don't ask on",    badgeLabel: "don't ask on",    icon: '▶▶', color: '#f43f5e' },
}

// Popover body text — title + description rendered in the two-line row.
// Distinct from MODE_META.label which is used by the trigger badge.
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

export const MODE_CYCLE_ORDER = MODE_CYCLE

function IconFor({ mode }: { mode: PermissionMode }) {
  switch (mode) {
    case 'default': return <HandOutlined />
    case 'acceptEdits': return <CodeOutlined />
    case 'plan': return <FileTextOutlined />
    case 'bypassPermissions': return <ThunderboltOutlined />
    case 'dontAsk': return <QuestionCircleOutlined />
  }
}

// Reusable kbd-style span for the header keycap hint.
const KBD_BASE: React.CSSProperties = {
  padding: '2px 6px',
  fontSize: 11,
  background: 'rgba(255,255,255,0.08)',
  border: '1px solid rgba(255,255,255,0.18)',
  borderRadius: 4,
  color: 'rgba(255,255,255,0.85)',
  fontFamily:
    'ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace',
  lineHeight: 1.2,
  minWidth: 18,
  textAlign: 'center',
}

interface RowProps {
  mode: PermissionMode
  isCurrent: boolean
  isSelected: boolean
  onClick: () => void
  onMouseEnter: () => void
}

function Row({ mode, isCurrent, isSelected, onClick, onMouseEnter }: RowProps) {
  const tint = MODE_META[mode].color
  const body = MODE_BODY[mode]
  return (
    <div
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
        border: isSelected
          ? '1px solid rgba(168,139,250,0.35)'
          : '1px solid transparent',
        marginBottom: 2,
      }}
    >
      {/* Current-mode ● marker — kept verbatim from the original implementation. */}
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

      {/* Icon block. */}
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

      {/* Two-line text. */}
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

export default function ModeStatusButton() {
  const sessions = useAgentStore((s) => s.sessions)
  const activeSessionId = useAgentStore((s) => s.activeSessionId)
  const sessionId = useAgentStore((s) => s.sessionId)
  const patchSessionMode = useAgentStore((s) => s.patchSessionMode)

  const currentSessionId = sessionId ?? activeSessionId ?? null
  const currentSession = useMemo(
    () => sessions.find((s) => s.transcriptId === currentSessionId) ?? null,
    [sessions, currentSessionId],
  )
  const currentMode: PermissionMode = currentSession?.permissionMode ?? 'default'
  const meta = MODE_META[currentMode]

  const [selectedIndex, setSelectedIndex] = useState(() => {
    const idx = MODE_CYCLE.indexOf(currentMode)
    return idx === -1 ? 0 : idx
  })
  // Keep selectedIndex in sync with the actual current mode (e.g. when
  // a PATCH response lands and the store updates while the popover is open).
  const lastSeenModeRef = useRef(currentMode)
  if (lastSeenModeRef.current !== currentMode) {
    lastSeenModeRef.current = currentMode
    const idx = MODE_CYCLE.indexOf(currentMode)
    if (idx !== -1 && idx !== selectedIndex) setSelectedIndex(idx)
  }

  const pick = (mode: PermissionMode) => {
    if (mode === currentMode) return
    if (!currentSessionId) return
    void patchSessionMode(currentSessionId, mode)
  }

  const content = (
    <div
      data-testid="mode-picker-content"
      tabIndex={-1}
      style={{
        width: 380,
        background: '#1f1f1f',
        color: '#fff',
        borderRadius: 10,
        padding: 10,
      }}
    >
      {/* Header: "Modes" title + keycap hint */}
      <div
        style={{
          display: 'flex',
          justifyContent: 'space-between',
          alignItems: 'center',
          marginBottom: 8,
        }}
      >
        <span
          data-testid="mode-picker-title"
          style={{
            fontSize: 13,
            fontWeight: 600,
            color: 'rgba(255,255,255,0.85)',
          }}
        >
          Modes
        </span>
        <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}>
          <span style={KBD_BASE}>⇧</span>
          <span style={{ color: 'rgba(255,255,255,0.45)', fontSize: 11 }}>+</span>
          <span style={KBD_BASE}>tab</span>
        </span>
      </div>

      {/* Mode rows */}
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

      {/* Footer — unchanged text + styling */}
      <div
        style={{
          fontSize: 11,
          color: 'rgba(255,255,255,0.30)',
          borderTop: '1px solid rgba(255,255,255,0.08)',
          paddingTop: 6,
          marginTop: 4,
        }}
      >
        click to select · shift+tab to cycle
      </div>
    </div>
  )

  return (
    <Popover
      content={content}
      trigger="click"
      placement="topRight"
      destroyTooltipOnHide
    >
      <Button
        type="text"
        size="small"
        data-testid="mode-status-button"
        title={`当前 mode: ${meta.label}\n点击切换`}
        style={{
          color: meta.color,
          opacity: 0.9,
          fontSize: 12,
          fontFamily:
            'ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace',
          padding: '0 6px',
        }}
      >
        <span style={{ color: meta.color }}>{meta.icon} {meta.badgeLabel}</span>
        <span style={{ color: 'rgba(255,255,255,0.35)' }}> (shift+tab ↹)</span>
      </Button>
    </Popover>
  )
}
```

- [ ] **Step 3: Typecheck the rewritten component**

Run: `cd packages/zai && node_modules/.bin/tsc -b --noEmit`
Expected: clean output. If there are errors, the most common cause is a missing icon import — verify all 5 icons are imported from `@ant-design/icons`.

- [ ] **Step 4: Confirm typecheck on the parent project (smoke)**

Run: `cd /Users/ethan/code/opencc-web && node_modules/.bin/tsc -b --noEmit 2>&1 | tail -20`
Expected: empty output or only pre-existing unrelated warnings. The component lives in `packages/zai/src/web/`, so any import path errors surface here.

- [ ] **Step 5: Commit Task 1**

```bash
cd /Users/ethan/code/opencc-web
git add packages/zai/src/web/src/components/ModeStatusButton.tsx
git commit -m "feat(zai-web): restyle ModeStatusButton popover to reference design

- Add header keycap hint (⇧ + tab) and 'Modes' title
- Two-line rows: icon block + bold title + dim description
- Add @ant-design/icons: HandOutlined, CodeOutlined, FileTextOutlined,
  ThunderboltOutlined, QuestionCircleOutlined
- Preserve behavior: 5 modes, trigger button, footer, current-mode ● marker"
```

- [ ] **Step 6: Manual smoke (browser, optional but recommended before Task 2)**

1. `cd packages/zai && node_modules/.bin/vite` (or `pnpm --filter zai dev` from root).
2. Open `http://localhost:5173`, trigger the mode picker by clicking the badge in the bottom bar.
3. Visual checklist:
   - Container width looks ~380px
   - "Modes" left, `⇧ + tab` keycap right
   - 5 rows: ● marker + 32×32 icon block + bold title + dim description
   - Current mode has ● + bold title
   - Hover any row: subtle violet background + 1px violet border
   - Trigger button label is still `▶▶ <badgeLabel> (shift+tab ↹)` (or `▮▮` for plan)
   - Bottom footer reads "click to select · shift+tab to cycle"
4. Behavioral checklist (no regression):
   - Click another row → mode updates, popover closes
   - Shift+tab cycles mode → badge text updates

If any visual check fails, fix the JSX in this task before proceeding to Task 2.

---

### Task 2: Add 10 unit tests for the restyled popover

**Files:**
- Create: `packages/zai/test/web/ModeStatusButton.test.tsx`

**Interfaces:**
- Consumes `useAgentStore` from `../../src/web/src/store/useAgentStore.js` to seed sessions state (mock minimal stub).
- Consumes `PermissionMode` and `MODE_CYCLE_ORDER` (not directly — uses the 5 modes by name).
- Renders `ModeStatusButton` (default export from `../../src/web/src/components/ModeStatusButton.js`).

- [ ] **Step 1: Create the test file with the full content below**

Use `Write` to create `packages/zai/test/web/ModeStatusButton.test.tsx` with the exact content below. The file uses `@vitest-environment happy-dom` to override the parent `vitest.config.ts` `environment: 'node'` (matches the sibling `ModelStatusButton.test.tsx`).

```tsx
// @vitest-environment happy-dom
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import ModeStatusButton from '../../src/web/src/components/ModeStatusButton.js'
import { useAgentStore } from '../../src/web/src/store/useAgentStore.js'

// Default mode for all tests below; the default session has no explicit
// permissionMode, so useAgentStore returns 'default' (the fallback in the component).
beforeEach(() => {
  useAgentStore.setState({
    sessionId: 'sess-1',
    activeSessionId: 'sess-1',
    sessions: [{
      transcriptId: 'sess-1',
      title: 'test',
      updatedAt: 1,
      cwd: '/x',
      // No permissionMode → component falls back to 'default'.
    }],
    availableModels: [],
  })
})

describe('ModeStatusButton', () => {
  // T1: trigger button shows current-mode badge
  it('renders the trigger button with current mode badge', () => {
    render(<ModeStatusButton />)
    // The default mode is 'default'. MODE_META.default.badgeLabel === 'default on'.
    const trigger = screen.getByTestId('mode-status-button')
    expect(trigger.textContent).toContain('default on')
    expect(trigger.textContent).toContain('shift+tab')
  })

  // T2: clicking the trigger opens the popover with 5 rows
  it('opens the popover with 5 rows on click', () => {
    render(<ModeStatusButton />)
    fireEvent.click(screen.getByTestId('mode-status-button'))
    // Five distinct rows, one per mode.
    expect(screen.getByTestId('mode-row-default')).toBeDefined()
    expect(screen.getByTestId('mode-row-acceptEdits')).toBeDefined()
    expect(screen.getByTestId('mode-row-plan')).toBeDefined()
    expect(screen.getByTestId('mode-row-bypassPermissions')).toBeDefined()
    expect(screen.getByTestId('mode-row-dontAsk')).toBeDefined()
  })

  // T3: current-mode row carries data-current="true" and bold title
  it('marks the current mode row with data-current="true"', () => {
    render(<ModeStatusButton />)
    fireEvent.click(screen.getByTestId('mode-status-button'))
    const currentRow = screen.getByTestId('mode-row-default')
    expect(currentRow.getAttribute('data-current')).toBe('true')
    // Title element is the first <span> inside the title block; bold weight = 600 inline.
    const titleSpan = currentRow.querySelector('span > span') as HTMLSpanElement | null
    // The first nested <span> in the row is the ● marker; the title is in
    // a child <div> → first <span> there. Query via querySelectorAll.
    const allSpans = currentRow.querySelectorAll('span')
    const titleEl = Array.from(allSpans).find((s) => s.textContent === 'default')
    expect(titleEl).toBeDefined()
    expect((titleEl as HTMLSpanElement | undefined)?.style.fontWeight).toBe('600')
  })

  // T4: non-current rows carry data-current="false"
  it('marks non-current mode rows with data-current="false"', () => {
    render(<ModeStatusButton />)
    fireEvent.click(screen.getByTestId('mode-status-button'))
    expect(screen.getByTestId('mode-row-acceptEdits').getAttribute('data-current')).toBe('false')
    expect(screen.getByTestId('mode-row-plan').getAttribute('data-current')).toBe('false')
    expect(screen.getByTestId('mode-row-bypassPermissions').getAttribute('data-current')).toBe('false')
    expect(screen.getByTestId('mode-row-dontAsk').getAttribute('data-current')).toBe('false')
  })

  // T5: hovering a row updates data-selected on that row only
  it('marks the hovered row with data-selected="true"', () => {
    render(<ModeStatusButton />)
    fireEvent.click(screen.getByTestId('mode-status-button'))
    const planRow = screen.getByTestId('mode-row-plan')
    fireEvent.mouseEnter(planRow)
    expect(planRow.getAttribute('data-selected')).toBe('true')
    expect(screen.getByTestId('mode-row-default').getAttribute('data-selected')).toBe('false')
    expect(screen.getByTestId('mode-row-acceptEdits').getAttribute('data-selected')).toBe('false')
  })

  // T6: clicking a non-current row calls patchSessionMode
  it('calls patchSessionMode when a non-current mode row is clicked', () => {
    const patchSpy = vi.spyOn(useAgentStore.getState(), 'patchSessionMode')
      .mockResolvedValue(undefined)
    render(<ModeStatusButton />)
    fireEvent.click(screen.getByTestId('mode-status-button'))
    fireEvent.click(screen.getByTestId('mode-row-plan'))
    expect(patchSpy).toHaveBeenCalledWith('sess-1', 'plan')
  })

  // T7: clicking the current-mode row is a no-op
  it('does not call patchSessionMode when the current mode row is clicked', () => {
    const patchSpy = vi.spyOn(useAgentStore.getState(), 'patchSessionMode')
      .mockResolvedValue(undefined)
    render(<ModeStatusButton />)
    fireEvent.click(screen.getByTestId('mode-status-button'))
    // Current mode is 'default' (no permissionMode set on session) → row is a no-op.
    fireEvent.click(screen.getByTestId('mode-row-default'))
    expect(patchSpy).not.toHaveBeenCalled()
  })

  // T8: with no active session, click is a no-op
  it('does not call patchSessionMode when there is no active session', () => {
    const patchSpy = vi.spyOn(useAgentStore.getState(), 'patchSessionMode')
      .mockResolvedValue(undefined)
    useAgentStore.setState({ sessionId: null, activeSessionId: null })
    render(<ModeStatusButton />)
    fireEvent.click(screen.getByTestId('mode-status-button'))
    fireEvent.click(screen.getByTestId('mode-row-acceptEdits'))
    expect(patchSpy).not.toHaveBeenCalled()
  })

  // T9: header shows "Modes" and renders the two keycap-style spans
  it('renders the header with "Modes" title and the ⇧ + tab keycaps', () => {
    render(<ModeStatusButton />)
    fireEvent.click(screen.getByTestId('mode-status-button'))
    // Title
    const title = screen.getByTestId('mode-picker-title')
    expect(title.textContent).toBe('Modes')
    // Two keycap spans exist: ⇧ and tab. The "+" in between is a plain span.
    const content = screen.getByTestId('mode-picker-content')
    const kbdSpans = Array.from(content.querySelectorAll('span')).filter(
      (s) => s.textContent === '⇧' || s.textContent === 'tab',
    )
    expect(kbdSpans).toHaveLength(2)
    // Both have a border style applied (the KBD_BASE constant).
    kbdSpans.forEach((s) => {
      const inline = (s as HTMLSpanElement).style.border
      expect(inline).toContain('1px solid')
    })
  })

  // T10: each row renders its corresponding antd icon as an SVG
  it('renders an antd icon SVG inside every mode row', () => {
    render(<ModeStatusButton />)
    fireEvent.click(screen.getByTestId('mode-status-button'))
    // Every row should contain an <svg class="anticon ...">.
    const rows = [
      'mode-row-default',
      'mode-row-acceptEdits',
      'mode-row-plan',
      'mode-row-bypassPermissions',
      'mode-row-dontAsk',
    ]
    for (const testid of rows) {
      const row = screen.getByTestId(testid)
      const svg = row.querySelector('svg.anticon')
      expect(svg, `expected SVG icon in ${testid}`).toBeTruthy()
    }
  })
})
```

- [ ] **Step 2: Run the new test file in isolation**

Run: `cd packages/zai && node_modules/.bin/vitest run test/web/ModeStatusButton.test.tsx`
Expected: 10 passed.

If any test fails, common causes:
- **"Cannot find data-testid mode-row-XXX"** — the row component sets `data-testid={...}` per row; verify the rewrite in Task 1 uses `mode-row-${mode}` (it does).
- **T3 font-weight assertion fails** — the inline style on `currentMode` rows is `fontWeight: isCurrent ? 600 : 500`, which renders as `style="font-weight: 600;"`. The test reads `style.fontWeight` which returns `"600"`. If the browser/dom implementation normalizes this differently, adjust the comparison to also accept numeric `600` or use `getComputedStyle` (last resort).
- **T9 keycap spans fail** — verify the header uses `<span style={KBD_BASE}>⇧</span>` and `<span style={KBD_BASE}>tab</span>` (no string-concat variation). If the rewrite lost the `KBD_BASE` reference, copy it back verbatim.
- **T10 SVG check fails** — verify the `IconFor` component renders `<HandOutlined />` etc. (not `<Icon component={...} />`); antdesign icons render `<svg>` tags.

- [ ] **Step 3: Run the full zai web test suite to catch regressions**

Run: `cd packages/zai && node_modules/.bin/vitest run test/web/`
Expected: all green. The 4 pre-existing failures in `routes-agent.test.ts` live outside `test/web/` so they don't appear here.

- [ ] **Step 4: Typecheck the project once more**

Run: `cd packages/zai && node_modules/.bin/tsc -b --noEmit`
Expected: clean output.

- [ ] **Step 5: Commit Task 2**

```bash
cd /Users/ethan/code/opencc-web
git add packages/zai/test/web/ModeStatusButton.test.tsx
git commit -m "test(zai-web): add 10 unit tests for ModeStatusButton popover redesign

Covers: trigger badge, 5 rows render, current-mode marker, hover-selected
highlight, click-no-op for current, click-patch for non-current, no-session
no-op, header keycap hint, antd icon SVGs in every row."
```

---

## Self-Review

**1. Spec coverage:** each spec requirement is mapped to a task step:
- Header keycap hint ✓ Task 1 Step 2 (header JSX)
- Two-line row (icon block + title + description) ✓ Task 1 Step 2 (`Row` component)
- 5 modes preserved ✓ Task 1 Step 2 (`MODE_CYCLE` verbatim, `MODE_BODY` covers all 5)
- AntD icons ✓ Task 1 Step 2 (icons + `IconFor` switch)
- Container 380px width / 10px radius / #1f1f1f ✓ Task 1 Step 2 (container style)
- Current-mode ● marker ✓ Task 1 Step 2 (Row keeps the ● span verbatim)
- Trigger button unchanged ✓ Task 1 Step 2 (trigger `<Button>` JSX copied)
- Footer unchanged ✓ Task 1 Step 2 (footer `<div>` text + style copied verbatim)
- 10 tests ✓ Task 2 Step 1

**2. Placeholder scan:** grep for `TBD|TODO|FIXME|XXX|placeholder|further|sensible default|appropriate ...` → none found.

**3. Type / ID consistency:**
- `data-testid` strings: `mode-picker-content`, `mode-picker-title`, `mode-row-${mode}` (5 modes), `mode-status-button`. All defined in Task 1 Step 2; all referenced in Task 2 Step 1.
- Icon component names: `HandOutlined` / `CodeOutlined` / `FileTextOutlined` / `ThunderboltOutlined` / `QuestionCircleOutlined` — same set in Task 1 imports and `IconFor` switch.
- `useAgentStore.patchSessionMode` signature `(sid: string, mode: PermissionMode) => Promise<void>` — matches the spy assertion `expect(patchSpy).toHaveBeenCalledWith('sess-1', 'plan')`.
- `MODE_BODY` keys: all 5 modes present, same set as `MODE_META` and `MODE_CYCLE` — exhaustive.
- Pre-existing `MODE_CYCLE_ORDER` export kept — Task 1 Step 2 retains `export const MODE_CYCLE_ORDER = MODE_CYCLE`.

No cross-task name drift detected.

---

## Final verification

```bash
cd packages/zai && node_modules/.bin/tsc -b --noEmit
cd packages/zai && node_modules/.bin/vitest run test/web/ModeStatusButton.test.tsx
cd packages/zai && node_modules/.bin/vitest run test/web/
```

All three commands clean. Then:

```bash
cd /Users/ethan/code/opencc-web
git push origin main   # user will trigger this manually
```

(Per project convention, push is a user action — do not auto-push.)

Manual smoke (user step):
1. `cd packages/zai && node_modules/.bin/vite` (dev server)
2. Open `http://localhost:5173`, click the mode badge in the bottom bar
3. Visual checklist as in Task 1 Step 6
4. Confirm 10 unit tests pass in CI
