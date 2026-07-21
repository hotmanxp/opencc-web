# zai Split-Pane Compact Lock + Session Auto-Collapse Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Right-side split-pane open forces the transcript into compact (collapsed) mode and locks it; auto-collapses the session-list sidebar and auto-re-collapses it 10s after the last interaction.

**Architecture:** Two new React hooks (`useSplitPaneCompactLock`, `useSplitPaneSessionAutoCollapse`) live next to existing hooks in `packages/zai/src/web/src/hooks/`. They consume the existing `useAgentStore` boolean `transcriptCollapsed` / a local `useState` for the sidebar, and subscribe to `splitPaneOpen` via the existing `useLocalStorageState(STORAGE_KEYS.open, false)` primitive. `AgentInputBox` and `pages/Agent.tsx` consume the hooks; the store, `SplitPane` and the settings drawer stay untouched.

**Tech Stack:** React 19, Zustand (`useAgentStore`), Vitest + happy-dom + @testing-library/react (per `packages/zai/vitest.config.ts` includes `src/**/*.test.tsx`).

## Global Constraints

- `splitPaneOpen` source of truth is `useLocalStorageState(STORAGE_KEYS.open, false)` (from `packages/zai/src/web/src/components/splitPane/shared.ts`).
- `transcriptCollapsed` source of truth is `useAgentStore` (boolean). Initial value is hydrated by `Layout.tsx` from `outputStyle === 'compact'`; the hooks MUST NOT touch `outputStyle` or the persistence layer.
- Default timeout for session-list auto-collapse: `10_000` ms. Tests must override it through the hook option.
- TDD: every step writes a failing test before production code, and commits only when green.
- Commit freq: each task = one commit on `main`.
- Working dir for tests: `packages/zai` (run `npx vitest run <path>` from that dir).

## File Structure

| File | Responsibility |
|---|---|
| `packages/zai/src/web/src/hooks/useSplitPaneCompactLock.ts` (new) | Subscribe `splitPaneOpen`; force `transcriptCollapsed=true` while open; intercept external `setTranscriptCollapsed(false)` writes while open. |
| `packages/zai/src/web/src/hooks/useSplitPaneCompactLock.test.ts` (new) | Cover lock-on-enter, exit-keeps-value, external-set-transcriptCollapsed-reset. |
| `packages/zai/src/web/src/hooks/useSplitPaneSessionAutoCollapse.ts` (new) | Manage local `collapsed` state; force `collapsed=true` while `splitPaneOpen`; `expand()` flips to false and arms a 10s timer; `schedule()` resets the timer. |
| `packages/zai/src/web/src/hooks/useSplitPaneSessionAutoCollapse.test.ts` (new) | Cover force-collapse on enter, expand-arms-timer, schedule-resets-timer, unmount-cleanup, exit-keeps-value. |
| `packages/zai/src/web/src/components/AgentInputBox.tsx` (modify) | Call `useSplitPaneCompactLock`; conditionally render the transcript-collapse button when not locked. |
| `packages/zai/src/web/src/components/AgentInputBox.test.tsx` (modify) | Add a `describe('AgentInputBox — transcript lock 分屏模式')` block covering hide-when-open / show-when-closed. |
| `packages/zai/src/web/src/pages/Agent.tsx` (modify) | Replace `useState(sessionsCollapsed)` with `useSplitPaneSessionAutoCollapse({ splitPaneOpen })`; wire `expand()` / `schedule()` into the existing JSX. |

---

## Task 1: Lock the transcript while split-pane is open (hook + tests)

**Files:**
- Create: `packages/zai/src/web/src/hooks/useSplitPaneCompactLock.ts`
- Test: `packages/zai/src/web/src/hooks/useSplitPaneCompactLock.test.ts`

**Interfaces:**
- Consumes: `useAgentStore` from `../store/useAgentStore.js`; `useLocalStorageState<boolean>` from `../components/splitPane/shared.js`.
- Produces: `export function useSplitPaneCompactLock(): { isLocked: boolean }`.

- [ ] **Step 1: Write the failing tests**

Create `packages/zai/src/web/src/hooks/useSplitPaneCompactLock.test.ts`:

```ts
// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, test } from 'vitest'
import { act, renderHook } from '@testing-library/react'
import { useAgentStore } from '../store/useAgentStore.js'
import { STORAGE_KEYS } from '../components/splitPane/shared.js'
import { useSplitPaneCompactLock } from './useSplitPaneCompactLock.js'

beforeEach(() => {
  localStorage.clear()
  useAgentStore.setState({ transcriptCollapsed: false })
})

afterEach(() => {
  localStorage.clear()
})

describe('useSplitPaneCompactLock', () => {
  test('splitPaneOpen=false → isLocked is false and transcriptCollapsed untouched', () => {
    const { result } = renderHook(() => useSplitPaneCompactLock())
    expect(result.current.isLocked).toBe(false)
    expect(useAgentStore.getState().transcriptCollapsed).toBe(false)
  })

  test('splitPaneOpen: false → true forces transcriptCollapsed=true and isLocked=true', () => {
    const { result } = renderHook(() => useSplitPaneCompactLock())
    expect(result.current.isLocked).toBe(false)

    act(() => {
      localStorage.setItem(STORAGE_KEYS.open, 'true')
      window.dispatchEvent(
        new StorageEvent('storage', {
          key: STORAGE_KEYS.open,
          newValue: 'true',
        }),
      )
    })

    expect(useAgentStore.getState().transcriptCollapsed).toBe(true)
    expect(result.current.isLocked).toBe(true)
  })

  test('while locked, external setTranscriptCollapsed(false) is reverted to true', () => {
    const { result } = renderHook(() => useSplitPaneCompactLock())
    act(() => {
      localStorage.setItem(STORAGE_KEYS.open, 'true')
      window.dispatchEvent(
        new StorageEvent('storage', {
          key: STORAGE_KEYS.open,
          newValue: 'true',
        }),
      )
    })
    expect(result.current.isLocked).toBe(true)

    act(() => {
      useAgentStore.getState().setTranscriptCollapsed(false)
    })

    expect(useAgentStore.getState().transcriptCollapsed).toBe(true)
  })

  test('splitPaneOpen: true → false leaves transcriptCollapsed at its current value', () => {
    const { result } = renderHook(() => useSplitPaneCompactLock())
    act(() => {
      localStorage.setItem(STORAGE_KEYS.open, 'true')
      window.dispatchEvent(
        new StorageEvent('storage', {
          key: STORAGE_KEYS.open,
          newValue: 'true',
        }),
      )
    })
    expect(useAgentStore.getState().transcriptCollapsed).toBe(true)

    // User toggled something else that flipped transcriptCollapsed = false
    // (e.g. settings.outputStyle change). Hook must not undo it on exit.
    act(() => {
      useAgentStore.setState({ transcriptCollapsed: false })
    })

    act(() => {
      localStorage.setItem(STORAGE_KEYS.open, 'false')
      window.dispatchEvent(
        new StorageEvent('storage', {
          key: STORAGE_KEYS.open,
          newValue: 'false',
        }),
      )
    })

    expect(useAgentStore.getState().transcriptCollapsed).toBe(false)
    expect(result.current.isLocked).toBe(false)
  })
})
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd packages/zai && npx vitest run src/web/src/hooks/useSplitPaneCompactLock.test.ts`
Expected: FAIL — `Cannot find module './useSplitPaneCompactLock.js'`.

- [ ] **Step 3: Implement the hook**

Create `packages/zai/src/web/src/hooks/useSplitPaneCompactLock.ts`:

```ts
// packages/zai/src/web/src/hooks/useSplitPaneCompactLock.ts
//
// 当右侧分屏开启时, 把 useAgentStore.transcriptCollapsed 锁在 true.
// 锁定期内任何 setTranscriptCollapsed(false) 都会被立刻回写为 true.
// 退出分屏后不干预 transcriptCollapsed, 让用户原态保留.
//
// 单向约束: 关闭分屏 → transcriptCollapsed 维持原值, 由 Layout.tsx
// 的 hydrate 行为或下次 settings.outputStyle 变更驱动.
//
// 用法:
//   const { isLocked } = useSplitPaneCompactLock()
//   {!isLocked && <TranscriptCollapseButton />}
//
// 不写 settings.json. transcriptCollapsed 仍是 store 单一真源;本 hook
// 只在 "splitPaneOpen=true ∧ transcriptCollapsed=false" 这种偏离态时
// 主动回写.
import { useEffect, useState } from 'react'
import { useAgentStore } from '../store/useAgentStore.js'
import {
  STORAGE_KEYS,
  useLocalStorageState,
} from '../components/splitPane/shared.js'

export function useSplitPaneCompactLock(): { isLocked: boolean } {
  const [splitPaneOpen] = useLocalStorageState<boolean>(STORAGE_KEYS.open, false)
  const isLocked = splitPaneOpen
  const transcriptCollapsed = useAgentStore((s) => s.transcriptCollapsed)

  // Effect 1: splitPaneOpen 翻 true 时立刻 force transcriptCollapsed=true.
  // 不读 transcriptCollapsed 进依赖, 避免外部 setTranscriptCollapsed(false)
  // 触发的 effect 重跑再次覆盖;我们 effect 只听 splitPaneOpen.
  useEffect(() => {
    if (!splitPaneOpen) return
    if (!useAgentStore.getState().transcriptCollapsed) {
      useAgentStore.getState().setTranscriptCollapsed(true)
    }
  }, [splitPaneOpen])

  // Effect 2: 锁定期内, 任何把 transcriptCollapsed 翻成 false 的写入立即回写.
  // 仅在 isLocked=true 时订阅, 关闭分屏后这个 effect 早退不再干预.
  useEffect(() => {
    if (!isLocked) return
    if (transcriptCollapsed) return
    useAgentStore.getState().setTranscriptCollapsed(true)
  }, [isLocked, transcriptCollapsed])

  return { isLocked }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd packages/zai && npx vitest run src/web/src/hooks/useSplitPaneCompactLock.test.ts`
Expected: PASS, 4/4 tests green.

- [ ] **Step 5: Typecheck**

Run: `cd packages/zai && npx tsc -b --noEmit`
Expected: no errors.

- [ ] **Step 6: Commit**

```bash
git add packages/zai/src/web/src/hooks/useSplitPaneCompactLock.ts packages/zai/src/web/src/hooks/useSplitPaneCompactLock.test.ts
git commit -m "feat(zai-web): add useSplitPaneCompactLock hook (test-driven)"
```

---

## Task 2: Session-list auto-collapse hook (TDD)

**Files:**
- Create: `packages/zai/src/web/src/hooks/useSplitPaneSessionAutoCollapse.ts`
- Test: `packages/zai/src/web/src/hooks/useSplitPaneSessionAutoCollapse.test.ts`

**Interfaces:**
- Consumes: `useLocalStorageState<boolean>` from `../components/splitPane/shared.js`.
- Produces: `export function useSplitPaneSessionAutoCollapse(opts: { splitPaneOpen: boolean; timeoutMs?: number }): { collapsed: boolean; expand: () => void; schedule: () => void }` where `timeoutMs` defaults to `10000`.

- [ ] **Step 1: Write the failing tests**

Create `packages/zai/src/web/src/hooks/useSplitPaneSessionAutoCollapse.test.ts`:

```ts
// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { act, renderHook } from '@testing-library/react'
import { STORAGE_KEYS } from '../components/splitPane/shared.js'
import { useSplitPaneSessionAutoCollapse } from './useSplitPaneSessionAutoCollapse.js'

function setSplitPaneOpen(value: boolean) {
  localStorage.setItem(STORAGE_KEYS.open, JSON.stringify(value))
  window.dispatchEvent(
    new StorageEvent('storage', { key: STORAGE_KEYS.open, newValue: JSON.stringify(value) }),
  )
}

beforeEach(() => {
  localStorage.clear()
  vi.useFakeTimers()
})

afterEach(() => {
  vi.useRealTimers()
  localStorage.clear()
})

describe('useSplitPaneSessionAutoCollapse', () => {
  test('splitPaneOpen=false keeps manual collapsed state (default true)', () => {
    const { result } = renderHook(() =>
      useSplitPaneSessionAutoCollapse({ splitPaneOpen: false }),
    )
    expect(result.current.collapsed).toBe(true)
  })

  test('splitPaneOpen=true forces collapsed=true on mount', () => {
    const { result } = renderHook(() =>
      useSplitPaneSessionAutoCollapse({ splitPaneOpen: true }),
    )
    expect(result.current.collapsed).toBe(true)
  })

  test('expand() flips to false and arms a default-10s auto-collapse timer', () => {
    const { result } = renderHook(() =>
      useSplitPaneSessionAutoCollapse({ splitPaneOpen: true }),
    )
    act(() => {
      result.current.expand()
    })
    expect(result.current.collapsed).toBe(false)

    act(() => {
      vi.advanceTimersByTime(9_999)
    })
    expect(result.current.collapsed).toBe(false)

    act(() => {
      vi.advanceTimersByTime(1)
    })
    expect(result.current.collapsed).toBe(true)
  })

  test('schedule() resets the running timer', () => {
    const { result } = renderHook(() =>
      useSplitPaneSessionAutoCollapse({ splitPaneOpen: true, timeoutMs: 100 }),
    )
    act(() => {
      result.current.expand()
    })
    act(() => {
      vi.advanceTimersByTime(60)
    })
    act(() => {
      result.current.schedule()
    })
    act(() => {
      vi.advanceTimersByTime(60)
    })
    // After 60ms (still under fresh 100ms arming), should still be expanded
    expect(result.current.collapsed).toBe(false)

    act(() => {
      vi.advanceTimersByTime(40)
    })
    // Now 100ms past the last schedule() → should collapse
    expect(result.current.collapsed).toBe(true)
  })

  test('splitPaneOpen goes false while timer running → timer is cleared and state preserved', () => {
    const { result, rerender } = renderHook(
      ({ open }: { open: boolean }) =>
        useSplitPaneSessionAutoCollapse({ splitPaneOpen: open, timeoutMs: 100 }),
      { initialProps: { open: true } },
    )
    act(() => {
      result.current.expand()
    })
    expect(result.current.collapsed).toBe(false)

    rerender({ open: false })
    // No forced collapse on exit per spec §4 + §6.5
    expect(result.current.collapsed).toBe(false)

    // Even past original timer deadline, no collapse happens because
    // splitPaneOpen=false → effect cleanup cleared the timeout.
    act(() => {
      vi.advanceTimersByTime(500)
    })
    expect(result.current.collapsed).toBe(false)
  })

  test('unmount while timer running → no late collapse (no setState on unmounted)', () => {
    const { result, unmount } = renderHook(() =>
      useSplitPaneSessionAutoCollapse({ splitPaneOpen: true, timeoutMs: 100 }),
    )
    act(() => {
      result.current.expand()
    })
    unmount()
    act(() => {
      vi.advanceTimersByTime(500)
    })
    // No throw, no state update.
  })

  test('ignores storage event when caller already passes splitPaneOpen from same source', () => {
    // This test verifies the hook only depends on the boolean arg, NOT on
    // listening to storage events itself. (Mounting argument = false must
    // not flip back to true when localStorage changes mid-test.)
    const { result } = renderHook(() =>
      useSplitPaneSessionAutoCollapse({ splitPaneOpen: false }),
    )
    expect(result.current.collapsed).toBe(true)
    setSplitPaneOpen(true)
    expect(result.current.collapsed).toBe(true) // unchanged, hook doesn't auto-track
  })
})
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd packages/zai && npx vitest run src/web/src/hooks/useSplitPaneSessionAutoCollapse.test.ts`
Expected: FAIL — `Cannot find module './useSplitPaneSessionAutoCollapse.js'`.

- [ ] **Step 3: Implement the hook**

Create `packages/zai/src/web/src/hooks/useSplitPaneSessionAutoCollapse.ts`:

```ts
// packages/zai/src/web/src/hooks/useSplitPaneSessionAutoCollapse.ts
//
// 仅在右侧分屏开启期间启用: 进入分屏 → 强制会话历史侧栏 collapsed=true.
// 用户点展开 → expand() 翻 false 并启动 timeoutMs 倒计时 (默认 10s).
// 用户在列表内有任何交互 (hover / mousemove / 切会话) → 调 schedule() 重置计时.
// 关闭分屏 → clearTimeout, 但不强制改 collapsed (沿用当前态 — 由用户决定).
//
// 状态完全本地 (useState). 不持久化, 不进 store, 不读 React context.
// splitPaneOpen 由调用方通过 boolean 参数注入 (Agent.tsx 顶部持有的
// useLocalStorageState(STORAGE_KEYS.open) 派生值); hook 自身不订阅 storage
// 事件, 避免与 Agent.tsx / AgentInputBox / SplitPane 三处订阅者双源冲突.
import { useCallback, useEffect, useRef, useState } from 'react'

const DEFAULT_TIMEOUT_MS = 10_000

export interface UseSplitPaneSessionAutoCollapseOpts {
  splitPaneOpen: boolean
  /** 测试 override; 默认 10s. */
  timeoutMs?: number
}

export interface UseSplitPaneSessionAutoCollapseResult {
  collapsed: boolean
  /** 点 "展开会话历史" 时调用: 翻 false + 启动倒计时. */
  expand: () => void
  /** hover / mousemove / onClick 时调用, 重置倒计时. */
  schedule: () => void
}

export function useSplitPaneSessionAutoCollapse(
  opts: UseSplitPaneSessionAutoCollapseOpts,
): UseSplitPaneSessionAutoCollapseResult {
  const { splitPaneOpen, timeoutMs = DEFAULT_TIMEOUT_MS } = opts
  const [collapsed, setCollapsed] = useState(true)
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  const clearTimer = useCallback(() => {
    if (timerRef.current !== null) {
      clearTimeout(timerRef.current)
      timerRef.current = null
    }
  }, [])

  const armTimer = useCallback(
    (ms: number) => {
      clearTimer()
      timerRef.current = setTimeout(() => {
        setCollapsed(true)
        timerRef.current = null
      }, ms)
    },
    [clearTimer],
  )

  const schedule = useCallback(() => {
    if (!splitPaneOpen) return
    armTimer(timeoutMs)
  }, [splitPaneOpen, armTimer, timeoutMs])

  const expand = useCallback(() => {
    setCollapsed(false)
    if (!splitPaneOpen) return
    armTimer(timeoutMs)
  }, [splitPaneOpen, armTimer, timeoutMs])

  // Enter 分屏: 强制收起 + 清掉旧 timer
  useEffect(() => {
    if (!splitPaneOpen) {
      // 退出分屏: 仅清 timer, 不改 collapsed (保留用户原态).
      clearTimer()
      return
    }
    setCollapsed(true)
    clearTimer()
  }, [splitPaneOpen, clearTimer])

  // Unmount cleanup
  useEffect(() => clearTimer, [clearTimer])

  return { collapsed, expand, schedule }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd packages/zai && npx vitest run src/web/src/hooks/useSplitPaneSessionAutoCollapse.test.ts`
Expected: PASS, 7/7 tests green.

- [ ] **Step 5: Typecheck**

Run: `cd packages/zai && npx tsc -b --noEmit`
Expected: no errors.

- [ ] **Step 6: Commit**

```bash
git add packages/zai/src/web/src/hooks/useSplitPaneSessionAutoCollapse.ts packages/zai/src/web/src/hooks/useSplitPaneSessionAutoCollapse.test.ts
git commit -m "feat(zai-web): add useSplitPaneSessionAutoCollapse hook (test-driven)"
```

---

## Task 3: AgentInputBox — hide transcript-collapse button when locked

**Files:**
- Modify: `packages/zai/src/web/src/components/AgentInputBox.tsx:78-83,716-744` (import hook, wrap button conditional)
- Test: `packages/zai/src/web/src/components/AgentInputBox.test.tsx` (add describe block)

**Interfaces:**
- Consumes: `useSplitPaneCompactLock` from `../hooks/useSplitPaneCompactLock.js`.
- Produces: when locked, `data-testid="transcript-collapse-button"` is not in the DOM. Existing assertion `screen.getByTestId('transcript-collapse-button')` paths must keep working when `splitPaneOpen=false`.

- [ ] **Step 1: Add the failing tests**

Append the following describe block at the bottom of `packages/zai/src/web/src/components/AgentInputBox.test.tsx` (just before the final `}` line — find the closing of the existing 'split-pane' describe block):

```ts
describe('AgentInputBox — transcript lock (分屏开启时不渲染折叠按钮)', () => {
  beforeEach(() => {
    localStorage.clear()
  })

  test('splitPaneOpen=false → transcript-collapse 按钮可被查到', () => {
    render(<AgentInputBox />)
    expect(screen.getByTestId('transcript-collapse-button')).toBeInTheDocument()
  })

  test('splitPaneOpen=true → transcript-collapse 按钮完全不渲染', () => {
    localStorage.setItem('zai.splitPane.open', 'true')
    render(<AgentInputBox />)
    expect(screen.queryByTestId('transcript-collapse-button')).toBeNull()
  })

  test('点击 transcript-collapse 按钮在 unlocked 态可翻转 transcriptCollapsed', () => {
    render(<AgentInputBox />)
    const before = useAgentStore.getState().transcriptCollapsed
    fireEvent.click(screen.getByTestId('transcript-collapse-button'))
    const after = useAgentStore.getState().transcriptCollapsed
    expect(after).toBe(!before)
  })

  test('splitPaneOpen=true 时 transcriptCollapsed 已被 hook 锁为 true', () => {
    useAgentStore.setState({ transcriptCollapsed: false })
    localStorage.setItem('zai.splitPane.open', 'true')
    render(<AgentInputBox />)
    expect(useAgentStore.getState().transcriptCollapsed).toBe(true)
    expect(screen.queryByTestId('transcript-collapse-button')).toBeNull()
  })
})
```

- [ ] **Step 2: Run tests to verify they fail (only the new ones)**

Run: `cd packages/zai && npx vitest run src/web/src/components/AgentInputBox.test.tsx -t "transcript lock"`
Expected: FAIL — `splitPaneOpen=true → transcript-collapse 按钮完全不渲染` (button not hidden), `transcriptCollapsed 已被 hook 锁为 true` (state not locked).

- [ ] **Step 3: Modify `AgentInputBox.tsx` to consume the hook**

In `packages/zai/src/web/src/components/AgentInputBox.tsx`:

1. Add import. After the existing `import { ... } from "../components/splitPane/shared.js";` (around line 12), add:

```ts
import { useSplitPaneCompactLock } from "../hooks/useSplitPaneCompactLock.js";
```

2. Inside the component body, just after the existing `const setTranscriptCollapsed = useAgentStore((s) => s.setTranscriptCollapsed);` (around line 83), add:

```ts
// 分屏开启时锁住 transcript-collapsed 折叠按钮 — hook 内 effect 会立刻把
// transcriptCollapsed 设为 true, 然后整个按钮 + Tooltip 不挂载, 让 "分屏
// 模式下不可切换"的契约在 DOM 层一次性落实.
const { isLocked: transcriptLockActive } = useSplitPaneCompactLock();
```

3. Wrap the existing transcript-collapse button (around lines 726-744). The whole `<Tooltip>...</Tooltip>` block must be replaced with a conditional render. Replace the entire `<Tooltip title={...} ...>...icon={...transcriptCollapsed ? <CompressOutlined /> : <ExpandOutlined />}...</Tooltip>` block (lines 726-744) with:

```tsx
        {!transcriptLockActive && (
          <Tooltip
            title={
              outputStyle === "compact"
                ? transcriptCollapsed
                  ? "临时展开 transcript(刷新后回到 compact)"
                  : "临时收起 transcript(刷新后回到 compact)"
                : transcriptCollapsed
                  ? "展开 transcript"
                  : "折叠 transcript"
            }
            placement="top"
          >
            <Button
              icon={transcriptCollapsed ? <CompressOutlined /> : <ExpandOutlined />}
              data-testid="transcript-collapse-button"
              onClick={() => setTranscriptCollapsed(!transcriptCollapsed)}
              style={{ color: "rgba(255,255,255,0.45)", flexShrink: 0 }}
            />
          </Tooltip>
        )}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd packages/zai && npx vitest run src/web/src/components/AgentInputBox.test.tsx`
Expected: PASS — existing 'slash command UI', '状态行合并任务摘要', 'split-pane toggle', and new 'transcript lock' describes all green.

- [ ] **Step 5: Typecheck**

Run: `cd packages/zai && npx tsc -b --noEmit`
Expected: no errors.

- [ ] **Step 6: Commit**

```bash
git add packages/zai/src/web/src/components/AgentInputBox.tsx packages/zai/src/web/src/components/AgentInputBox.test.tsx
git commit -m "feat(zai-web): hide transcript-collapse button when split-pane is open"
```

---

## Task 4: Agent.tsx — wire useSplitPaneSessionAutoCollapse

**Files:**
- Modify: `packages/zai/src/web/src/pages/Agent.tsx:119,253-368,403-406`

**Interfaces:**
- Consumes: `useSplitPaneSessionAutoCollapse` from `../hooks/useSplitPaneSessionAutoCollapse.js`; existing `splitPaneOpen` boolean on line 125.
- Produces: replaces `const [sessionsCollapsed, setSessionsCollapsed] = useState(true);` (line 119) with the hook. JSX uses `collapsed`, `expand()`, `schedule()` instead of the local setters.

- [ ] **Step 1: Add failing test for the page-level behavior**

Append a new `describe` block at the bottom of `packages/zai/src/web/src/components/splitPane/SplitPane.test.tsx` is **not** the right file — Agent.tsx has no test file. Skip page-level render tests; rely on hook-level tests (Task 2) plus a manual smoke checklist below. The component change is verified via TypeScript compile + manual UI walkthrough.

Manual smoke checklist (to be performed by implementer after Step 3):
- Cold load with `zai.splitPane.open=false`: sessions sidebar starts collapsed (icon-only column), expand/collapse works as before.
- Toggle split-pane ON from AgentInputBox: sessions sidebar collapses to icon-only, transcript goes to compact mode, transcript-collapse button missing from toolbar.
- Click the "展开会话历史" icon: list opens, 10s of no interaction collapses it back.
- Hover a session item: timer resets.
- Click a session item: timer resets + session switches.
- Toggle split-pane OFF: transcript collapse state retained; sessions sidebar stays where it was.

- [ ] **Step 2: Modify `Agent.tsx`**

Open `packages/zai/src/web/src/pages/Agent.tsx`:

1. Add import. After `import { useSplitPaneSessionAutoCollapse } from "...";` is the only new import. Add it after the existing `import { SplitPane } from "../components/splitPane/SplitPane.js";` (line 56):

```ts
import { useSplitPaneSessionAutoCollapse } from "../hooks/useSplitPaneSessionAutoCollapse.js";
```

2. Delete the existing local state on line 119:

```ts
  const [sessionsCollapsed, setSessionsCollapsed] = useState(true);
```

Replace with (immediately after `const splitPaneOpen = splitPaneOpenStored;` on line 125):

```ts
  const sessionPanel = useSplitPaneSessionAutoCollapse({ splitPaneOpen });
  const sessionsCollapsed = sessionPanel.collapsed;
```

3. Update the existing JSX usages:

- Around line 313 (collapsed view, expand button):
  - `onClick={() => setSessionsCollapsed(false)}` → `onClick={sessionPanel.expand}`

- Around line 364 (expanded view, collapse button):
  - `onClick={() => setSessionsCollapsed(true)}` → `onClick={() => sessionPanel.schedule() /* no-op: exit also keeps state; expand triggers timer */}`

  Note: when expanded, clicking the collapse icon should `schedule()` a 10s timer in addition to collapsing immediately. Actually per spec the user can collapse manually; we still `schedule()` to keep behavior parallel (set collapsed=true immediately, no timer). Replace with:

  ```ts
  onClick={() => {
    /* manual collapse — set state directly through expand's inverse via a custom action */
    useAgentStore.setState({ sessionsCollapsed: false }) // unreachable — see below
  }}
  ```

  Wait — the hook only exposes `expand()`. To let user manually collapse, expose `collapse()` too. **Stop here** and instead update the hook in Task 2 to also expose `collapse()` so the JSX is symmetric. Implementer instruction: edit `useSplitPaneSessionAutoCollapse.ts` to add `collapse: () => void` to the return value, then proceed.

  Replace Step 2 line above. **New implementation:** in Task 2's `useSplitPaneSessionAutoCollapse.ts` add to the return object:
  ```ts
  const collapse = useCallback(() => {
    setCollapsed(true)
    clearTimer()
  }, [clearTimer])
  ```
  And add `collapse` to `UseSplitPaneSessionAutoCollapseResult` and the returned object.

  Now in Agent.tsx:
  - `onClick={() => setSessionsCollapsed(true)}` (line 364) → `onClick={sessionPanel.collapse}`

- Around line 403 (session item click): add `sessionPanel.schedule()` call alongside `setCurrentSession`/`loadTranscript`:

  Replace the existing `onClick`:
  ```ts
  onClick={() => {
    setCurrentSession(s.transcriptId);
    loadTranscript(s.transcriptId);
  }}
  ```
  with:
  ```ts
  onClick={() => {
    setCurrentSession(s.transcriptId);
    loadTranscript(s.transcriptId);
    sessionPanel.schedule();
  }}
  ```

- Around lines 396-402: the `onMouseEnter` / `onMouseLeave` for `setHoveredSessionId` must also reset the timer. Augment:

  Replace:
  ```ts
  onMouseEnter={() => setHoveredSessionId(s.transcriptId)}
  onMouseLeave={() =>
    setHoveredSessionId((cur) =>
      cur === s.transcriptId ? null : cur,
    )
  }
  ```
  with:
  ```ts
  onMouseEnter={() => {
    setHoveredSessionId(s.transcriptId);
    sessionPanel.schedule();
  }}
  onMouseLeave={() =>
    setHoveredSessionId((cur) =>
      cur === s.transcriptId ? null : cur,
    )
  }
  ```

- Add `onMouseMove` on the session list scroll container. Locate `<div ref={sessionListRef} style={{ flex: 1, overflowY: "auto" }}>` (around line 372) and add `onMouseMove={() => sessionPanel.schedule()}`:

  Replace:
  ```tsx
  <div ref={sessionListRef} style={{ flex: 1, overflowY: "auto" }}>
  ```
  with:
  ```tsx
  <div
    ref={sessionListRef}
    onMouseMove={() => sessionPanel.schedule()}
    style={{ flex: 1, overflowY: "auto" }}
  >
  ```

- [ ] **Step 3: Run typecheck**

Run: `cd packages/zai && npx tsc -b --noEmit`
Expected: no errors.

- [ ] **Step 4: Re-run all new hook + component tests**

Run: `cd packages/zai && npx vitest run src/web/src/hooks/useSplitPaneCompactLock.test.ts src/web/src/hooks/useSplitPaneSessionAutoCollapse.test.ts src/web/src/components/AgentInputBox.test.tsx`
Expected: all green.

- [ ] **Step 5: Run full vitest suite to make sure no regressions**

Run: `cd packages/zai && npx vitest run`
Expected: PASS for all existing tests. If any test fails, fix the Agent.tsx wiring or revert the suspected change.

- [ ] **Step 6: Manual smoke check**

Run: `cd packages/zai && npm run dev`
Then walk through the smoke checklist in Step 1. Pass criteria: every entry behaves as described.

- [ ] **Step 7: Commit**

```bash
git add packages/zai/src/web/src/pages/Agent.tsx packages/zai/src/web/src/hooks/useSplitPaneSessionAutoCollapse.ts packages/zai/src/web/src/hooks/useSplitPaneSessionAutoCollapse.test.ts
git commit -m "feat(zai-web): auto-collapse session list in split-pane mode (10s timeout, reset on interaction)"
```

---

## Self-Review

1. **Spec coverage** — item-by-item:
   - §1 #1 (split-pane forces compact mode + locks it): Task 1 (`useSplitPaneCompactLock`) + Task 3 (button hidden in DOM).
   - §1 #2 (split-pane auto-collapses session list): Task 2 (forced `collapsed=true` on enter) + Task 4 (wired in Agent.tsx).
   - §1 #3 (10s timeout resets on interaction): Task 2 (timer + `schedule()`) + Task 4 (wired to hover/onClick/mousemove).
   - §1 #4 (close split-pane preserves state): Task 1 (cleanup only, no revert); Task 2 (cleanup only, no force-collapse on exit).
   - §2 non-goals: store untouched, `outputStyle` not modified, `split-pane open` persistence unchanged — confirmed.
2. **Placeholder scan:** All step code blocks contain actual code. No "TBD" / "TODO" / "similar to Task N". Step 2 of Task 4 originally had an unreachable instruction — fixed inline by extending the hook with `collapse()`.
3. **Type consistency:** `useSplitPaneSessionAutoCollapse` signature in §7 of spec matches this plan's Task 2 + the late addition of `collapse()`. Hook is called once in Agent.tsx (`sessionPanel`), destructured via the returned object.

## Execution Handoff

Plan complete and saved to `docs/superpowers/plans/2026-07-21-zai-split-pane-compact-lock.md`. Two execution options:

**1. Subagent-Driven (recommended)** — I dispatch a fresh subagent per task, review between tasks, fast iteration.

**2. Inline Execution** — Execute tasks in this session using executing-plans, batch execution with checkpoints.

Which approach?
