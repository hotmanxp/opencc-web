# zai ModelStatusButton TUI Redesign Design

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the flat-list ModelStatusButton with an OpenCC TUI-style picker: top search box, a Recent section derived from `useAgentStore.sessions`, and entries grouped by provider (`<profile name> (<host>)`) with keyboard navigation (ArrowUp/Down + Enter + Esc).

**Architecture:** All picker state (search query, selected flat-list index) lives inside the `ModelStatusButton` component as React useState — no separate hook, no Context. `recentModels` is a `useMemo` derivation from `sessions` (already in the store, `loadSessions` populates from `GET /api/agent/sessions` which returns `TranscriptMeta[]` with `model` field). Provider titles are computed from each entry's `alias` (reverse-parse `<profile>-<suffix>`) and `baseUrl` host.

**Tech Stack:** React 18 + antd 5 (Popover, Input) + zustand 4 (existing store). Existing `useConversationInfo` / `useAgentStore` / `ModelEntry` types — no new files. `ModelStatusButton.tsx` is the only component touched. Tests use vitest + happy-dom + @testing-library/react.

---

## Global Constraints

- **No new files** for state — keep state inside the component. YAGNI for a separate hook.
- **No new settings schema** — `ModelEntry.alias` is the only signal for "profile name" (the sync script already generates `<profile>-<suffix>` form). `ModelEntry.baseUrl` provides the host.
- **No localStorage for Recent** — derived from `useAgentStore.sessions` (recency-weighted, deduplicated, max 5).
- **Recent hidden when search is active** — typing in search filters out Recent; clearing the box restores it.
- **Existing 4 component tests preserved** (renders label / opens popover / calls patchSessionModel / no-op for current). New 7 tests added (search filter / no-match / Recent dedupe / Recent shows / provider title format / keyboard Enter / keyboard Arrow).
- **`displayLabel` is the badge label** (already computed in `useConversationInfo`); the picker shows `m.label ?? m.alias` inside list items.
- **Visual style**: dark popover (`#1f1f1f` body, matching existing `ConversationInfoButton`); provider headers in violet `#a78bfa`; selected entry in violet tint `rgba(168,139,250,0.15)`; current-selection ● marker in violet; short text in `rgba(255,255,255,0.55)`, description in `rgba(255,255,255,0.40)`.
- **Keyboard convention**: ArrowDown/ArrowUp move `selectedIndex` in the **flattened** list (Recent first, then each Provider group's entries in order); Enter calls `patchSessionModel`; Esc bubbles to antd Popover default close.
- **AutoFocus**: search `<Input>` gets focus on Popover open; clearing search resets `selectedIndex` to 0.

---

## File changes

**Modified**:
- `packages/zai/src/web/src/components/ModelStatusButton.tsx` — full rewrite (single file, ~280 lines)
- `packages/zai/test/web/ModelStatusButton.test.tsx` — extend with 7 new tests (existing 4 stay)

**No new files.** No store / hook / route changes.

---

## Component structure

```tsx
ModelStatusButton
  └─ Popover (trigger="click", placement="topRight", destroyTooltipOnHide)
       └─ <div tabIndex={-1} onKeyDown={handleKey}>
            ├─ Header: "切换模型" + "esc" hint
            ├─ <Input> Search — autoFocus, searchQuery
            ├─ Recent section (when !searchQuery && recentModels.length > 0)
            │   └─ Recent header: "Recent" (violet, small caps)
            │   └─ For each recentModel: Row
            └─ Provider groups (sorted by title)
                └─ For each group:
                    ├─ Group header: "<profile name> (<host>)" (violet, small caps)
                    └─ For each entry in group: Row
```

**Row** (used for both Recent and Provider entries):
```
● (current marker)  Name (white, 13px, weight 600 if current)  · description (gray, 11px)
                       [highlight background if keyboard-selected]
                       [no pointer cursor if entry is current model]
```

The `●` is only shown when `entry.model === currentModel`. The highlight background is only shown when the row is at `selectedIndex` in the flat list.

---

## Derived data (all inline `useMemo` in the component)

```ts
// Recent: walk sessions sorted by updatedAt desc, dedupe by entry.model, max 5.
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

// Search-filtered: match model/alias/label/host substring (case-insensitive).
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

// Group by provider title.
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

// Flat list for keyboard nav: Recent (if no search) + each provider group's entries.
const showRecent = !searchQuery.trim() && recentModels.length > 0
const flatList = useMemo<ModelEntry[]>(() => {
  const out: ModelEntry[] = []
  if (showRecent) out.push(...recentModels)
  for (const [, items] of groups) out.push(...items)
  return out
}, [recentModels, groups, showRecent])
```

`selectedIndex` is clamped to `[0, flatList.length - 1]` whenever `flatList` changes.

---

## Provider title derivation

```ts
function formatProviderTitle(entry: ModelEntry): string {
  // alias 形如 "<profile>-<suffix>" (由 sync 脚本生成)
  // e.g. "anthropic-mix-m3" → "anthropic-mix"
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

Falls back to `'default'` if `baseUrl` is missing or unparseable — never throws.

---

## Keyboard handler

```tsx
const onKeyDown = (e: React.KeyboardEvent) => {
  if (e.key === 'ArrowDown') {
    e.preventDefault()
    setSelectedIndex((i) => Math.min(i + 1, Math.max(0, flatList.length - 1)))
    return
  }
  if (e.key === 'ArrowUp') {
    e.preventDefault()
    setSelectedIndex((i) => Math.max(i - 1, 0))
    return
  }
  if (e.key === 'Enter') {
    e.preventDefault()
    const entry = flatList[selectedIndex]
    if (entry && entry.model !== currentModel && sessionId) {
      void patchSessionModel(sessionId, entry.model)
    }
    return
  }
  // Esc: do nothing — let antd Popover handle it (default close)
}
```

Each `setSelectedIndex` is followed by a `useEffect` that calls `selectedRowRef.current?.scrollIntoView({ block: 'nearest' })` to keep the highlighted row in view.

---

## Edge cases

| Case | Behavior |
|---|---|
| `availableModels.length === 0` | Hide Search input. Show `~/.zai/settings.json 未配置 models[]` placeholder. |
| `sessions.length === 0` | Recent section not rendered. |
| Current model not in `availableModels` (e.g. legacy `'unknown'`) | No `●` marker on any row. Picking any row triggers `patchSessionModel`. |
| Search empty | `showRecent = true` (subject to length). |
| Search non-empty | `showRecent = false`; only `filteredModels` rendered, grouped. |
| Search no match | Render centered gray `无匹配模型`. `selectedIndex` clamped to 0. |
| `flatList` length changes (search/Recent toggle) | `selectedIndex` clamped to `[0, length-1]`. |
| `extractHost` throws (bad URL) | Returns `'default'` instead of throwing. |
| Popover close + reopen | `destroyTooltipOnHide` resets state on remount; `autoFocus` puts cursor in Search. |
| Enter on current model | No-op (early return in handler). |
| Enter with no `sessionId` | No-op. |
| Recent > 5 entries | Cap at 5. |
| All sessions have `model === undefined` / `'unknown'` | Recent section not rendered. |

---

## Error handling

- **`extractHost` failure**: caught try/catch → `'default'`. Never throws.
- **`formatProviderTitle` with no `'-' in alias`**: returns `alias` as-is (defensive — sync script always inserts a dash).
- **Search input losing focus during keyboard nav**: Search input keeps focus (no `onBlur` that releases); ArrowUp/Down stays captured.
- **Popover `destroyTooltipOnHide`**: state is reset on remount (no manual `useEffect` cleanup needed).

---

## Out of scope (v1)

- Favorite entries (截图中未出现)
- "Connect provider" footer entry (zai 单 provider 架构, 跨 provider 切换不在范围内)
- Per-entry metadata badges (Free / price tier) — `ModelEntry` 当前不含此字段, schema 扩展 YAGNI
- 跨 baseUrl 的真实 provider 切换 — 当前 v1 限制: 选中 "anthropic-m3" 实际仍走 `env.ANTHROPIC_BASE_URL` (active profile 的 baseUrl). 这与 sync 任务的 v1 限制一致, 已在 progress.md 标注为 follow-up.
- LocalStorage 持久化 Recent — 派生于 sessions, 刷新自动恢复.
- 异步 typing 搜索 (debounce) — 5 个 entry 不需要.

---

## Testing strategy

`packages/zai/test/web/ModelStatusButton.test.tsx` extends with 7 new tests. Total 11 tests.

| # | Test | Assertion |
|---|---|---|
| 1 | Renders badge label (existing) | `displayLabel` text shown in badge |
| 2 | Opens Popover (existing) | Clicking badge shows the list |
| 3 | Calls `patchSessionModel` on click (existing) | Non-current entry triggers store call |
| 4 | No-op on current entry (existing) | `●` row click does not call |
| 5 | Search filter | Typing `M2` shows only `MiniMax-M2.7-highspeed` entry; others hidden |
| 6 | Search no match | Typing `xyz` shows `无匹配模型` |
| 7 | Recent section appears | When sessions list has 1 model, Recent block renders that entry |
| 8 | Recent dedup | Multiple sessions with same model → Recent shows it once |
| 9 | Provider title format | Title is `anthropic-mix (minimaxi.com)` style |
| 10 | Keyboard Enter | `fireEvent.keyDown(Enter)` → `patchSessionModel` called for selectedIndex=0 |
| 11 | Keyboard ArrowDown | After ArrowDown, highlight moves to index 1 |

All tests use `// @vitest-environment happy-dom` (already in place from Task 6).

The existing 4 tests' `setState` mocks must be updated to set `model: 'MiniMax-M3'` on session[0] (the current model) so the "current" check still resolves correctly. Existing test data has `model: 'MiniMax-M3'` already.

For test #10 / #11, the keyboard handler is on the popover content wrapper div. Tests use `screen.getByPlaceholderText(/输入|搜索|Search/i)` (the search input) as the `fireEvent.keyDown` target — search input keeps focus on popover open (via `autoFocus` + no `onBlur` handler), so the event bubbles to the wrapper's `onKeyDown` listener. Alternative: target the wrapper directly via a `data-testid="model-picker-content"`.

---

## Final verification

```bash
cd packages/zai && node_modules/.bin/tsc -b --noEmit
cd packages/zai && node_modules/.bin/vitest run test/web/ModelStatusButton.test.tsx
cd packages/zai && node_modules/.bin/vitest run test/web/   # regression
```

Manual smoke (user step):
1. Click badge in lower status bar → popover opens, Search auto-focused.
2. Type `M2` → filtered list, keyboard Enter selects.
3. Clear search → Recent section appears (if sessions have models).
4. ArrowDown 2x → highlight moves across Recent + Provider rows.
5. Click a row in a provider group → patch fires, badge updates, popover closes.