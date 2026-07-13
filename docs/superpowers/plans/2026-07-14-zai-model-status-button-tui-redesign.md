# zai ModelStatusButton TUI Redesign Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the flat-list ModelStatusButton with an OpenCC TUI-style picker: top search box, Recent section derived from `useAgentStore.sessions`, provider-grouped entries (`<profile> (<host>)`) with keyboard navigation (ArrowUp/Down + Enter + Esc).

**Architecture:** All picker state (searchQuery, selectedIndex) lives inside the component as React `useState` — no separate hook, no Context. `recentModels` / `filteredModels` / `groups` / `flatList` are inline `useMemo` derivations. `selectedIndex` walks a flat list (Recent first, then each Provider group's entries) so keyboard nav is single-counter. Provider title is reverse-parsed from `entry.alias` (`<profile>-<suffix>`) + `extractHost(entry.baseUrl)`.

**Tech Stack:** React 18 + antd 5 (Popover, Input) + zustand 4 (existing store). Existing `useConversationInfo` / `useAgentStore` / `ModelEntry` types — no new files. Tests use vitest + happy-dom + @testing-library/react.

---

## Global Constraints

- **No new files** — component + test only. State lives in component.
- **No new settings schema** — `ModelEntry.alias` is the only signal for "profile name" (sync script generates `<profile>-<suffix>`). `ModelEntry.baseUrl` provides the host.
- **No localStorage for Recent** — derived from `useAgentStore.sessions` (recency-weighted, deduped by entry.model, max 5).
- **Recent hidden when search is active** — typing in search filters out Recent; clearing the box restores it.
- **Existing 4 component tests preserved verbatim** (renders label / opens popover / calls patchSessionModel / no-op for current). New 7 tests added.
- **`displayLabel`** is the badge label (computed in `useConversationInfo`); picker shows `m.label ?? m.alias` inside list items.
- **Visual style**: dark popover (`#1f1f1f` body, matching existing `ConversationInfoButton`); provider headers in violet `#a78bfa`; selected entry in violet tint `rgba(168,139,250,0.15)`; current-selection ● marker in violet; short text in `rgba(255,255,255,0.55)`, description in `rgba(255,255,255,0.40)`.
- **Keyboard**: ArrowDown/ArrowUp move `selectedIndex` in flat list; Enter calls `patchSessionModel`; Esc bubbles to antd Popover (default close).
- **AutoFocus**: search `<Input>` gets focus on Popover open; clearing search resets `selectedIndex` to 0.
- **TypeScript path style**: `.js` import suffix.
- **Test environment**: vitest + `@vitest-environment happy-dom` (already in place at top of `ModelStatusButton.test.tsx` from Task 6).
- **Branch context**: implementation happens on `feat/model-picker-tui` (tracking `origin/main` + 2 cherry-picked commits for Tasks 5+6). The 7 task commits for Tasks 1-4 already exist on `origin/main` from the parallel `feat/code-lj` PR merge.

---

## File changes

**Modified**:
- `packages/zai/src/web/src/components/ModelStatusButton.tsx` — full rewrite (current ~90 lines → ~280 lines)
- `packages/zai/test/web/ModelStatusButton.test.tsx` — extend with 7 new tests (existing 4 stay)

**No new files.**

---

### Task 1: ModelStatusButton TUI rewrite + 7 new tests

**Files:**
- Modify: `packages/zai/src/web/src/components/ModelStatusButton.tsx` (full rewrite)
- Modify: `packages/zai/test/web/ModelStatusButton.test.tsx` (extend)

**Interfaces:**
- Consumes `ModelEntry` from `src/shared/settings.js` (already exists).
- Consumes `useConversationInfo` for `displayLabel`, `model`, `sessionId` (already exists).
- Consumes `useAgentStore` for `availableModels`, `sessions`, `patchSessionModel` (already exists; `sessions` was already added as a public field via Task 4's Session widening).
- Produces no new exports.

- [ ] **Step 1: Create TaskCreate entries for sub-steps**

Use the TaskCreate tool to track these 6 sub-steps **before** doing anything else. This prevents the early-stopping pattern observed in earlier SDD runs:

```
1. Read existing ModelStatusButton.tsx + ModelStatusButton.test.tsx
2. Rewrite ModelStatusButton.tsx (TUI version)
3. Run existing 4 tests, verify still pass
4. Add 7 new tests to test file
5. Run all 11 tests, verify pass
6. Run tsc -b --noEmit, verify clean
7. Commit
```

Mark each in_progress as you start, completed as you finish.

- [ ] **Step 2: Read the two files to understand the existing structure**

Use Read (no `pages` parameter) on:
- `packages/zai/src/web/src/components/ModelStatusButton.tsx` (90 lines, the current flat-list version)
- `packages/zai/test/web/ModelStatusButton.test.tsx` (~86 lines, 4 tests with `// @vitest-environment happy-dom`)

This is so the test stubs (e.g. `useAgentStore.setState({ sessions: [...], availableModels: [...] })`) match the new component's expectations.

- [ ] **Step 3: Rewrite ModelStatusButton.tsx**

Replace the entire content of `packages/zai/src/web/src/components/ModelStatusButton.tsx` with the code below. The new component:

- Holds `searchQuery` (string) and `selectedIndex` (number) as `useState`.
- Derives `recentModels`, `filteredModels`, `groups`, `flatList` via `useMemo`.
- Renders Search `<Input>` with `autoFocus` and `onChange` updating `searchQuery`.
- Renders Recent section when `!searchQuery && recentModels.length > 0`.
- Renders each Provider group with a violet header and list rows.
- Each row has `●` marker if `entry.model === currentModel`; keyboard-selected row gets violet background.
- `onKeyDown` on the popover content wrapper handles ArrowUp/Down/Enter.
- Wires click handlers to `patchSessionModel(sessionId, entry.model)` for non-current entries.

```tsx
import { useEffect, useMemo, useRef, useState } from 'react'
import { Button, Input, Popover } from 'antd'
import { CheckOutlined } from '@ant-design/icons'
import { useConversationInfo } from '../hooks/useConversationInfo.js'
import { useAgentStore } from '../store/useAgentStore.js'
import type { ModelEntry } from '../../../shared/settings.js'

/**
 * OpenCC TUI-style model picker.
 *
 * Replaces the flat-list ModelStatusButton. Layout (top to bottom):
 *   1. "Select model" header with esc hint
 *   2. Search <Input> (autoFocus)
 *   3. Recent section (only when no search query AND recentModels > 0)
 *   4. Provider groups sorted by title
 *
 * Each row shows ● marker when entry.model === currentModel, plus
 * violet-tint background when keyboard-selectedIndex matches.
 *
 * Keyboard: ArrowUp/Down move selectedIndex in flatList (Recent first,
 * then each group's entries in order); Enter calls patchSessionModel;
 * Esc bubbles to antd Popover default close.
 */
export default function ModelStatusButton() {
  const { displayLabel, model: currentModel, sessionId } = useConversationInfo()
  const availableModels = useAgentStore((s) => s.availableModels)
  const sessions = useAgentStore((s) => s.sessions)
  const patchSessionModel = useAgentStore((s) => s.patchSessionModel)

  const [searchQuery, setSearchQuery] = useState('')
  const [selectedIndex, setSelectedIndex] = useState(0)
  const selectedRowRef = useRef<HTMLDivElement | null>(null)
  const searchInputRef = useRef<any>(null)

  // Derived: recent models from sessions, recency-weighted, deduped, max 5.
  const recentModels = useMemo<ModelEntry[]>(() => {
    const seen = new Set<string>()
    const out: ModelEntry[] = []
    const sorted = [...sessions].sort((a, b) => b.updatedAt - a.updatedAt)
    for (const s of sorted) {
      if (!s.model || s.model === 'unknown') continue
      if (seen.has(s.model)) continue
      const entry = availableModels.find((m) => m.model === s.model)
      if (!entry) continue
      seen.add(s.model)
      out.push(entry)
      if (out.length >= 5) break
    }
    return out
  }, [sessions, availableModels])

  // Derived: search-filtered models.
  const filteredModels = useMemo<ModelEntry[]>(() => {
    const q = searchQuery.trim().toLowerCase()
    if (!q) return availableModels
    return availableModels.filter((m) =>
      m.model.toLowerCase().includes(q) ||
      m.alias.toLowerCase().includes(q) ||
      (m.label ?? '').toLowerCase().includes(q) ||
      extractHost(m.baseUrl).toLowerCase().includes(q),
    )
  }, [availableModels, searchQuery])

  // Derived: provider-grouped entries.
  const groups = useMemo<Array<[string, ModelEntry[]]>>(() => {
    const m = new Map<string, ModelEntry[]>()
    for (const e of filteredModels) {
      const title = formatProviderTitle(e)
      const list = m.get(title) ?? []
      list.push(e)
      m.set(title, list)
    }
    return [...m.entries()].sort(([a], [b]) => a.localeCompare(b))
  }, [filteredModels])

  const showRecent = !searchQuery.trim() && recentModels.length > 0

  // Flat list: Recent first (if visible), then each group in order.
  const flatList = useMemo<ModelEntry[]>(() => {
    const out: ModelEntry[] = []
    if (showRecent) out.push(...recentModels)
    for (const [, items] of groups) out.push(...items)
    return out
  }, [recentModels, groups, showRecent])

  // Clamp selectedIndex when flatList shape changes (search/Recent toggle).
  useEffect(() => {
    if (flatList.length === 0) {
      setSelectedIndex(0)
    } else if (selectedIndex >= flatList.length) {
      setSelectedIndex(flatList.length - 1)
    }
  }, [flatList, selectedIndex])

  // Auto-scroll selected row into view.
  useEffect(() => {
    selectedRowRef.current?.scrollIntoView({ block: 'nearest' })
  }, [selectedIndex])

  // Reset search + selectedIndex on popover mount (covers re-open case
  // since destroyTooltipOnHide resets component state on remount).
  // No explicit reset needed — initial state already ('', 0).

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'ArrowDown') {
      e.preventDefault()
      setSelectedIndex((i) => Math.min(i + 1, Math.max(0, flatList.length - 1)))
    } else if (e.key === 'ArrowUp') {
      e.preventDefault()
      setSelectedIndex((i) => Math.max(i - 1, 0))
    } else if (e.key === 'Enter') {
      e.preventDefault()
      const entry = flatList[selectedIndex]
      if (entry && entry.model !== currentModel && sessionId) {
        void patchSessionModel(sessionId, entry.model)
      }
    }
    // Esc: let antd Popover default handle (close)
  }

  const pickEntry = (entry: ModelEntry) => {
    if (entry.model === currentModel) return
    if (!sessionId) return
    void patchSessionModel(sessionId, entry.model)
  }

  const content = (
    <div
      data-testid="model-picker-content"
      tabIndex={-1}
      onKeyDown={onKeyDown}
      style={{
        width: 360,
        background: '#1f1f1f',
        color: '#fff',
        borderRadius: 6,
        padding: 8,
        maxHeight: 480,
        overflowY: 'auto',
      }}
    >
      <div
        style={{
          display: 'flex',
          justifyContent: 'space-between',
          alignItems: 'center',
          marginBottom: 6,
        }}
      >
        <span style={{ fontSize: 12, fontWeight: 600, color: 'rgba(255,255,255,0.55)' }}>
          Select model
        </span>
        <span style={{ fontSize: 11, color: 'rgba(255,255,255,0.30)' }}>esc</span>
      </div>

      {availableModels.length === 0 ? (
        <div style={{ fontSize: 12, color: 'rgba(255,255,255,0.45)', padding: '12px 4px' }}>
          ~/.zai/settings.json 未配置 models[]
        </div>
      ) : (
        <>
          <Input
            ref={searchInputRef}
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            placeholder="Search"
            autoFocus
            allowClear
            size="small"
            style={{ marginBottom: 8 }}
          />

          {filteredModels.length === 0 && (
            <div style={{ fontSize: 12, color: 'rgba(255,255,255,0.45)', textAlign: 'center', padding: '12px 0' }}>
              无匹配模型
            </div>
          )}

          {showRecent && (
            <div style={{ marginBottom: 8 }}>
              <div style={{ fontSize: 10, fontWeight: 600, color: '#a78bfa', textTransform: 'uppercase', letterSpacing: 0.5, padding: '4px 4px' }}>
                Recent
              </div>
              {recentModels.map((m) => {
                const flatIdx = flatList.indexOf(m)
                return (
                  <Row
                    key={`recent-${m.alias}`}
                    entry={m}
                    isCurrent={m.model === currentModel}
                    isSelected={flatIdx === selectedIndex}
                    onClick={() => pickEntry(m)}
                    rowRef={flatIdx === selectedIndex ? selectedRowRef : undefined}
                  />
                )
              })}
            </div>
          )}

          {groups.map(([title, items]) => (
            <div key={title} style={{ marginBottom: 6 }}>
              <div style={{ fontSize: 10, fontWeight: 600, color: '#a78bfa', textTransform: 'uppercase', letterSpacing: 0.5, padding: '4px 4px' }}>
                {title}
              </div>
              {items.map((m) => {
                const flatIdx = flatList.indexOf(m)
                return (
                  <Row
                    key={`group-${title}-${m.alias}`}
                    entry={m}
                    isCurrent={m.model === currentModel}
                    isSelected={flatIdx === selectedIndex}
                    onClick={() => pickEntry(m)}
                    rowRef={flatIdx === selectedIndex ? selectedRowRef : undefined}
                  />
                )
              })}
            </div>
          ))}

          <div
            style={{
              fontSize: 11,
              color: 'rgba(255,255,255,0.30)',
              borderTop: '1px solid rgba(255,255,255,0.08)',
              paddingTop: 6,
              marginTop: 4,
              display: 'flex',
              gap: 12,
            }}
          >
            <span>↑↓ Navigate</span>
            <span>⏎ Select</span>
            <span>esc Close</span>
          </div>
        </>
      )}
    </div>
  )

  return (
    <Popover
      content={<div onClick={(e) => e.stopPropagation()}>{content}</div>}
      trigger="click"
      placement="topRight"
      destroyTooltipOnHide
    >
      <Button
        type="text"
        size="small"
        title={`当前模型: ${displayLabel ?? '未知'}\n点击切换`}
        style={{
          color: currentModel ? 'rgba(255,255,255,0.55)' : 'rgba(255,255,255,0.30)',
          fontFamily:
            'ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace',
        }}
      >
        {displayLabel ?? '未知'}
      </Button>
    </Popover>
  )
}

interface RowProps {
  entry: ModelEntry
  isCurrent: boolean
  isSelected: boolean
  onClick: () => void
  rowRef?: React.MutableRefObject<HTMLDivElement | null>
}

function Row({ entry, isCurrent, isSelected, onClick, rowRef }: RowProps) {
  return (
    <div
      ref={rowRef ?? undefined}
      onClick={onClick}
      data-testid={`model-row-${entry.alias}`}
      data-selected={isSelected ? 'true' : 'false'}
      data-current={isCurrent ? 'true' : 'false'}
      style={{
        padding: '5px 8px',
        borderRadius: 4,
        cursor: isCurrent ? 'default' : 'pointer',
        background: isSelected ? 'rgba(168, 139, 250, 0.15)' : 'transparent',
        display: 'flex',
        flexDirection: 'column',
        gap: 1,
      }}
    >
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 6 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 6, minWidth: 0, flex: 1 }}>
          {isCurrent ? (
            <span style={{ color: '#a78bfa', fontSize: 12, lineHeight: 1 }}>●</span>
          ) : (
            <span style={{ width: 7 }} />
          )}
          <span
            style={{
              fontSize: 13,
              color: '#fff',
              fontWeight: isCurrent ? 600 : 400,
              whiteSpace: 'nowrap',
              overflow: 'hidden',
              textOverflow: 'ellipsis',
            }}
          >
            {entry.label ?? entry.alias}
          </span>
        </div>
        {isCurrent && <CheckOutlined style={{ color: '#a78bfa', fontSize: 11 }} />}
      </div>
      {entry.description && (
        <span style={{ fontSize: 11, color: 'rgba(255,255,255,0.40)', paddingLeft: 13 }}>
          {entry.description}
        </span>
      )}
    </div>
  )
}

function formatProviderTitle(entry: ModelEntry): string {
  // alias 形如 "<profile>-<suffix>" (由 sync 脚本生成)
  // e.g. "anthropic-mix-m3" → profile "anthropic-mix"
  const lastDash = entry.alias.lastIndexOf('-')
  const profile = lastDash > 0 ? entry.alias.slice(0, lastDash) : entry.alias
  return `${profile} (${extractHost(entry.baseUrl)})`
}

function extractHost(baseUrl: string | undefined): string {
  if (!baseUrl) return 'default'
  try {
    return new URL(baseUrl).host
  } catch {
    return 'default'
  }
}
```

- [ ] **Step 4: Run existing 4 tests, verify still pass**

Run: `cd packages/zai && node_modules/.bin/vitest run test/web/ModelStatusButton.test.tsx`
Expected: 4 passed (existing tests still green). If any fail, debug before adding new tests — they likely need their mock state adjusted to set `model: 'MiniMax-M3'` on the current session.

- [ ] **Step 5: Add 7 new tests to the test file**

Append the following to `packages/zai/test/web/ModelStatusButton.test.tsx` (after the existing 4 tests, inside a new `describe` block):

```ts
describe('ModelStatusButton TUI picker (extended)', () => {
  // Reuse the existing beforeEach that sets up sessions / availableModels / fetch.
  // Existing beforeEach sets:
  //   - sessions: [{ transcriptId: 'sess-1', model: 'MiniMax-M3', cwd: '/x', updatedAt: 1 }]
  //   - availableModels: 2 models (M3, M2.7-highspeed)
  //   - globalThis.fetch mocked to return settings with defaultModel: 'MiniMax-M3'

  it('filters entries by search query', async () => {
    render(<ModelStatusButton />)
    await new Promise((r) => setTimeout(r, 0))
    fireEvent.click(screen.getByText('M3 · 默认最强')) // open popover
    const search = screen.getByPlaceholderText(/Search/i) as HTMLInputElement
    fireEvent.change(search, { target: { value: 'M2' } })
    // M2.7 entry still shown, M3 hidden
    expect(screen.queryByTestId('model-row-anthropic-mix-m3')).toBeNull()
    expect(screen.getByTestId('model-row-anthropic-mix-highspeed')).toBeInTheDocument()
  })

  it('shows no-match message when search returns empty', async () => {
    render(<ModelStatusButton />)
    await new Promise((r) => setTimeout(r, 0))
    fireEvent.click(screen.getByText('M3 · 默认最强'))
    const search = screen.getByPlaceholderText(/Search/i) as HTMLInputElement
    fireEvent.change(search, { target: { value: 'xyz' } })
    expect(screen.getByText('无匹配模型')).toBeInTheDocument()
  })

  it('renders Recent section with session-derived models', async () => {
    // Existing beforeEach already has sessions[0].model = 'MiniMax-M3', so Recent
    // should render anthropic-mix-m3.
    render(<ModelStatusButton />)
    await new Promise((r) => setTimeout(r, 0))
    fireEvent.click(screen.getByText('M3 · 默认最强'))
    expect(screen.getByText('Recent')).toBeInTheDocument()
    // Recent entry is the same M3 alias as current
    const recentRow = screen.getByTestId('model-row-anthropic-mix-m3')
    expect(recentRow).toBeInTheDocument()
  })

  it('dedupes Recent — same model in multiple sessions appears once', async () => {
    // Override sessions to have 3 entries all with model 'MiniMax-M3'.
    useAgentStore.setState({
      sessions: [
        { transcriptId: 's-1', title: 'a', updatedAt: 3, model: 'MiniMax-M3' },
        { transcriptId: 's-2', title: 'b', updatedAt: 2, model: 'MiniMax-M3' },
        { transcriptId: 's-3', title: 'c', updatedAt: 1, model: 'MiniMax-M2.7-highspeed' },
      ],
    })
    render(<ModelStatusButton />)
    await new Promise((r) => setTimeout(r, 0))
    fireEvent.click(screen.getByText('M3 · 默认最强'))
    // M3 should appear once in Recent (the 2 sessions with M3 collapse to 1 entry).
    // Total M3 occurrences: 1 in Recent + 1 in Anthropic-Mix group = 2.
    const m3Rows = screen.getAllByTestId('model-row-anthropic-mix-m3')
    expect(m3Rows.length).toBe(2) // 1 in Recent + 1 in provider group
  })

  it('formats provider title as "<profile> (<host>)"', async () => {
    render(<ModelStatusButton />)
    await new Promise((r) => setTimeout(r, 0))
    fireEvent.click(screen.getByText('M3 · 默认最强'))
    expect(screen.getByText(/Anthropic-Mix \(minimaxi\.com\)/i)).toBeInTheDocument()
  })

  it('handles Enter key to select highlighted entry', async () => {
    const patchSpy = vi.spyOn(useAgentStore.getState(), 'patchSessionModel')
      .mockResolvedValue(undefined)
    render(<ModelStatusButton />)
    await new Promise((r) => setTimeout(r, 0))
    fireEvent.click(screen.getByText('M3 · 默认最强')) // open popover
    // Initial selectedIndex = 0, which is the current model (M3) — no-op on Enter.
    // ArrowDown to move to next entry (M2.7).
    const content = screen.getByTestId('model-picker-content')
    fireEvent.keyDown(content, { key: 'ArrowDown' })
    // Now selectedIndex = 1, the M2.7 entry.
    fireEvent.keyDown(content, { key: 'Enter' })
    expect(patchSpy).toHaveBeenCalledWith('sess-1', 'MiniMax-M2.7-highspeed')
  })

  it('handles ArrowDown to move selection', async () => {
    render(<ModelStatusButton />)
    await new Promise((r) => setTimeout(r, 0))
    fireEvent.click(screen.getByText('M3 · 默认最强'))
    const content = screen.getByTestId('model-picker-content')
    // Initially selectedIndex = 0 (M3 row is current — selected because it's first in flatList).
    const initialSelected = content.querySelector('[data-selected="true"]')
    expect(initialSelected?.getAttribute('data-testid')).toBe('model-row-anthropic-mix-m3')
    // ArrowDown → selectedIndex = 1 (M2.7).
    fireEvent.keyDown(content, { key: 'ArrowDown' })
    const afterDown = content.querySelector('[data-selected="true"]')
    expect(afterDown?.getAttribute('data-testid')).toBe('model-row-anthropic-mix-highspeed')
  })
})
```

- [ ] **Step 6: Run all 11 tests, verify pass**

Run: `cd packages/zai && node_modules/.bin/vitest run test/web/ModelStatusButton.test.tsx`
Expected: 11 passed (4 existing + 7 new).

If any fail:
- **"Cannot find data-testid"** — the row's `data-testid` is `model-row-${entry.alias}`. The existing beforeEach sets `availableModels` with aliases `M3` (alias) and `haiku` (alias), model `MiniMax-M3` and `MiniMax-M2.7-highspeed`. The test data-testid would be `model-row-M3` and `model-row-haiku`, NOT `model-row-anthropic-mix-m3`. **Update the test data-testid strings to match the actual beforeEach aliases**: `model-row-M3` and `model-row-haiku`.

  Wait — check the existing beforeEach in `test/web/ModelStatusButton.test.tsx`. The plan assumed aliases `M3` and `haiku`, but the existing tests may use different names. **Read the actual test file** before committing to data-testid strings. Adjust as needed.

- [ ] **Step 7: Run typecheck**

Run: `cd packages/zai && node_modules/.bin/tsc -b --noEmit`
Expected: clean output (no errors). The pre-existing `session.renamed` event type warning is unrelated to this task and may still show — ignore it.

- [ ] **Step 8: Run full web test suite to catch regressions**

Run: `cd packages/zai && node_modules/.bin/vitest run test/web/`
Expected: all pass. The 4 pre-existing failures in `routes-agent.test.ts` are server-side and won't appear here.

- [ ] **Step 9: Commit**

```bash
cd packages/zai/..
git add packages/zai/src/web/src/components/ModelStatusButton.tsx \
        packages/zai/test/web/ModelStatusButton.test.tsx
git commit -m "feat(zai-web): ModelStatusButton TUI redesign — search, Recent, provider groups, keyboard nav"
```

- [ ] **Step 10: Write the report file**

Write to `/Users/ethan/code/opencc-web/.superpowers/sdd/task-7-report.md` (or appropriate next number). Include:
- Status (DONE / DONE_WITH_CONCERNS / NEEDS_CONTEXT / BLOCKED)
- Commits made
- One-line test summary
- Concerns (if any)

Return only status, commits, test summary, and concerns to me in your final message.

---

## Final verification

```bash
cd packages/zai && node_modules/.bin/tsc -b --noEmit
cd packages/zai && node_modules/.bin/vitest run test/web/ModelStatusButton.test.tsx
cd packages/zai && node_modules/.bin/vitest run test/web/
```

All three clean. Then:

```bash
cd /Users/ethan/code/opencc-web
git push origin feat/model-picker-tui   # user will trigger this manually
```

(Per project convention, push is a user action — do not auto-push.)

Manual smoke (user step, after merge to main):
1. Edit `~/.zai/settings.json` to have `models: [...]` with at least 2 entries.
2. Restart `zai` server, open chat.
3. Click model badge in lower status bar — popover opens, search auto-focused.
4. Type `M2` — only M2.7 entry shows.
5. Clear search — Recent + provider groups render.
6. ArrowDown → highlight moves.
7. Enter on a non-current entry → badge updates, popover closes.

---

## Self-Review

**Spec coverage:**
- ✓ Search box — Task Step 3
- ✓ Recent from sessions — Task Step 3 (recentModels useMemo)
- ✓ Provider groups — Task Step 3 (groups useMemo + formatProviderTitle)
- ✓ Keyboard ArrowUp/Down + Enter — Task Step 3 (onKeyDown)
- ✓ Esc bubbles to Popover — Task Step 3 (no Esc handler)
- ✓ AutoFocus on search — Task Step 3 (`autoFocus` on `<Input>`)
- ✓ Visual style (violet accent, ● marker, current highlight) — Task Step 3 (Row component)
- ✓ Edge cases (empty models, no search match, current-not-in-list) — Task Step 3
- ✓ 7 new tests + 4 existing — Task Step 5

**Placeholder scan:** No TBD/TODO/"add appropriate error handling" placeholders. All code blocks complete.

**Type consistency:**
- `ModelEntry` imported from `src/shared/settings.js` — matches existing imports in the project.
- `useConversationInfo` returns `displayLabel`, `model`, `sessionId` (all from Task 5 + earlier).
- `useAgentStore.availableModels` and `useAgentStore.sessions` — both public fields added in Task 4.
- `useAgentStore.patchSessionModel` — added in Task 4.
- `data-testid` values follow `model-row-${entry.alias}` pattern — depends on actual `availableModels` test data; flagged in Step 6 for adjustment if needed.
