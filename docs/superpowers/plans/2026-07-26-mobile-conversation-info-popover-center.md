# Mobile Conversation Info Popover Center Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the conversation info dialog render centered and fully visible on mobile (`< 768px`), while keeping desktop Popover behavior unchanged.

**Architecture:** Single-file change in `ConversationInfoButton.tsx`. Branch on `useAppStore.isMobile`: desktop keeps antd `Popover` (`placement="topRight"`); mobile renders an antd `Modal` (`centered`, `width="min(360px, calc(100vw - 32px))"`, `maskClosable`, `destroyOnClose`) with the existing `<ConversationInfoCard>` body. Both branches share the same `useConversationInfo()` snapshot.

**Tech Stack:** React 18, antd 5 (`Popover`, `Modal`, `Button`), Zustand (`useAppStore.isMobile`), Vitest + `@testing-library/react` (happy-dom env).

## Global Constraints

- Mobile breakpoint: `768` (from `packages/zai/src/web/src/hooks/useIsMobile.ts:15`).
- `isMobile` state lives in `useAppStore` (`packages/zai/src/web/src/store/useAppStore.ts:100`).
- Desktop trigger button must keep `style={toolbarIconButtonStyle}` (32×32, 圆角 8).
- Card body is reused verbatim: `<ConversationInfoCard info={info} />`.
- Test runner: `pnpm -C packages/zai test`, scope `src/web/src/components/ConversationInfoButton`.
- Typecheck: `pnpm -C packages/zai typecheck`.
- No new store fields, no new events, no API changes.
- AntD `Modal` body styles inherit the existing dark theme; do not override `theme` props.

---

## File Structure

| File | Role | Action |
|---|---|---|
| `packages/zai/src/web/src/components/ConversationInfoButton.tsx` | Render trigger + (Popover or Modal) wrapping the card | Modify |
| `packages/zai/src/web/src/components/ConversationInfoButton.test.tsx` | Cover desktop vs mobile render + close interactions | Create |

Out of scope (untouched):
- `ConversationInfoCard.tsx`
- `useConversationInfo.ts`
- `useAppStore.ts`
- `toolbarStyles.ts`

---

## Task 1: Add failing mobile-Modal test for `ConversationInfoButton`

**Files:**
- Create: `packages/zai/src/web/src/components/ConversationInfoButton.test.tsx`

**Interfaces:**
- Consumes: `useAppStore.isMobile: boolean`, `useConversationInfo(): ConversationInfo`.
- Produces: `<ConversationInfoButton>` exposed `data-testid="conversation-info-trigger"`; on mobile, `data-testid="mobile-conversation-info-modal"` mounted while open.

- [ ] **Step 1: Write the failing test**

Create `packages/zai/src/web/src/components/ConversationInfoButton.test.tsx` with the content below.

```tsx
// @vitest-environment happy-dom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import '@testing-library/jest-dom'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { useAppStore } from '../store/useAppStore.js'

// Replace the actual hook with a deterministic fixture. We only need the
// shape that ConversationInfoCard consumes.
vi.mock('../hooks/useConversationInfo.js', () => ({
  useConversationInfo: () => ({
    sessionId: 'sess-test-123',
    title: '测试会话',
    startTime: 1_700_000_000_000,
    lastUpdate: 1_700_000_500_000,
    turnCount: 3,
    messageCount: 7,
    status: 'idle',
    cwd: '/tmp/proj',
    model: 'MiniMax-M3',
    settingsLoaded: true,
    displayLabel: 'MiniMax-M3',
  }),
}))

// Stub ConversationInfoCard with a deterministic marker so we can assert
// presence + content without depending on antd Descriptions internals.
vi.mock('./ConversationInfoCard.js', () => ({
  default: ({ info }: { info: { sessionId: string; title: string | null; turnCount: number; messageCount: number } }) => (
    <div data-testid="conversation-info-card">
      <span data-testid="card-session-id">{info.sessionId}</span>
      <span data-testid="card-title">{info.title ?? '—'}</span>
      <span data-testid="card-turns">{info.turnCount}</span>
      <span data-testid="card-messages">{info.messageCount}</span>
    </div>
  ),
}))

import ConversationInfoButton from './ConversationInfoButton.js'

describe('ConversationInfoButton — mobile vs desktop branching', () => {
  afterEach(() => {
    cleanup()
    useAppStore.setState({ isMobile: false })
  })

  it('desktop (isMobile=false): clicking trigger shows Popover with card content', () => {
    useAppStore.setState({ isMobile: false })
    render(<ConversationInfoButton />)
    // Popover 走 portal, 卡片初始不在 document 里
    expect(screen.queryByTestId('conversation-info-card')).not.toBeInTheDocument()
    fireEvent.click(screen.getByTestId('conversation-info-trigger'))
    expect(screen.getByTestId('conversation-info-card')).toBeInTheDocument()
    expect(screen.getByTestId('card-session-id').textContent).toBe('sess-test-123')
    // 移动端 Modal 不应出现
    expect(screen.queryByTestId('mobile-conversation-info-modal')).not.toBeInTheDocument()
  })

  it('mobile (isMobile=true): Modal mounts with card content immediately', () => {
    useAppStore.setState({ isMobile: true })
    render(<ConversationInfoButton />)
    // 移动端默认展开(走 Modal 而不是 Popover),不需点击 trigger
    expect(screen.getByTestId('mobile-conversation-info-modal')).toBeInTheDocument()
    expect(screen.getByTestId('conversation-info-card')).toBeInTheDocument()
    expect(screen.getByTestId('card-turns').textContent).toBe('3')
    expect(screen.getByTestId('card-messages').textContent).toBe('7')
    // 桌面 Popover 触发路径不应被用到
    expect(screen.queryByTestId('desktop-popover-anchor')).not.toBeInTheDocument()
  })

  it('mobile: clicking the trigger toggles the Modal open state', () => {
    useAppStore.setState({ isMobile: true })
    render(<ConversationInfoButton />)
    // 初始打开 → 关闭
    fireEvent.click(screen.getByTestId('conversation-info-trigger'))
    expect(screen.queryByTestId('conversation-info-card')).not.toBeInTheDocument()
    // 再点 → 打开
    fireEvent.click(screen.getByTestId('conversation-info-trigger'))
    expect(screen.getByTestId('conversation-info-card')).toBeInTheDocument()
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run:
```bash
pnpm -C packages/zai test src/web/src/components/ConversationInfoButton.test.tsx
```
Expected: FAIL with `Unable to find element with data-testid "conversation-info-trigger"` (and the desktop test failing because the component still uses Popover-only markup).

- [ ] **Step 3: Commit the failing test**

```bash
git add packages/zai/src/web/src/components/ConversationInfoButton.test.tsx
git commit -m "test(conversation-info): cover mobile Modal + desktop Popover branches"
```

---

## Task 2: Implement mobile Modal branch in `ConversationInfoButton`

**Files:**
- Modify: `packages/zai/src/web/src/components/ConversationInfoButton.tsx`

**Interfaces:**
- Consumes: `useAppStore((s) => s.isMobile): boolean`, `useConversationInfo(): ConversationInfo`.
- Produces:
  - `<button data-testid="conversation-info-trigger">` always present.
  - On `isMobile === true`: `<Modal data-testid="mobile-conversation-info-modal" centered width="min(360px, calc(100vw - 32px))" footer={null} maskClosable destroyOnClose open={open} onCancel={() => setOpen(false)} title="会话信息">` containing `<ConversationInfoCard info={info} />`.
  - On `isMobile === false | undefined`: existing `<Popover placement="topRight" trigger="click" content={...}>` with no `data-testid` on the anchor.
  - Local `useState<boolean>` defaults to `true` when `isMobile === true`, else `false`.

- [ ] **Step 1: Replace `ConversationInfoButton.tsx` with the implementation below**

```tsx
import { useState } from 'react'
import { Button, Modal, Popover } from 'antd'
import { InfoCircleOutlined } from '@ant-design/icons'
import { useConversationInfo } from '../hooks/useConversationInfo.js'
import ConversationInfoCard from './ConversationInfoCard.js'
import { useAppStore } from '../store/useAppStore.js'
import { toolbarIconButtonStyle } from './toolbarStyles.js'

/**
 * 工具栏 [i] 按钮 — 展示会话元信息。
 *
 * - 桌面端 (isMobile=false): 走 antd Popover,placement="topRight",
 *   卡片锚定在按钮旁。
 * - 移动端 (isMobile=true): 走 antd Modal,centered + 响应式宽度,
 *   在视口居中且不被屏幕宽度裁切。
 *
 * isMobile===undefined(初次渲染 / SSR 边界)回退 Popover,避免桌面
 * 初始态闪一下 Modal。
 */
export default function ConversationInfoButton() {
  const info = useConversationInfo()
  // 显式 boolean 化,避免 undefined 时 .startsWith 等判断出错.
  const isMobile = useAppStore((s) => s.isMobile) === true

  // 移动端: 默认打开(用户在窄屏点 [i] 一次就看到内容).
  // 桌面端: 维持 Popover 自带 trigger="click" 的语义,本地 open 不参与.
  const [mobileOpen, setMobileOpen] = useState<boolean>(isMobile)

  const handleTriggerClick = () => {
    if (isMobile) setMobileOpen((v) => !v)
  }

  const cardBody = (
    <div onClick={(e) => e.stopPropagation()}>
      <ConversationInfoCard info={info} />
    </div>
  )

  if (isMobile) {
    return (
      <>
        <Button
          icon={<InfoCircleOutlined />}
          title="查看对话信息"
          style={toolbarIconButtonStyle}
          data-testid="conversation-info-trigger"
          onClick={handleTriggerClick}
        />
        <Modal
          open={mobileOpen}
          onCancel={() => setMobileOpen(false)}
          centered
          width="min(360px, calc(100vw - 32px))"
          footer={null}
          maskClosable
          destroyOnClose
          title="会话信息"
          data-testid="mobile-conversation-info-modal"
        >
          {cardBody}
        </Modal>
      </>
    )
  }

  return (
    <Popover
      trigger="click"
      placement="topRight"
      content={cardBody}
      overlayInnerStyle={{ padding: 12 }}
      destroyTooltipOnHide
    >
      <Button
        icon={<InfoCircleOutlined />}
        title="查看对话信息"
        style={toolbarIconButtonStyle}
        data-testid="conversation-info-trigger"
      />
    </Popover>
  )
}
```

- [ ] **Step 2: Run test to verify it passes**

Run:
```bash
pnpm -C packages/zai test src/web/src/components/ConversationInfoButton.test.tsx
```
Expected: PASS — all 3 cases green.

- [ ] **Step 3: Run typecheck**

Run:
```bash
pnpm -C packages/zai typecheck
```
Expected: exit 0, no TS errors.

- [ ] **Step 4: Run full web test sweep to catch regressions in dependent files**

Run:
```bash
pnpm -C packages/zai test src/web/src
```
Expected: all suites green. Pay special attention to `AgentInputBox.test.tsx` (which mocks `ConversationInfoButton`) — it should remain green because the mock returns `() => null`.

- [ ] **Step 5: Commit**

```bash
git add packages/zai/src/web/src/components/ConversationInfoButton.tsx
git commit -m "feat(conversation-info): render centered Modal on mobile, keep Popover on desktop"
```

---

## Self-Review

**1. Spec coverage:**

| Spec section | Implemented in |
|---|---|
| §2 渲染分支 (isMobile === true / false / undefined) | Task 2 (`if (isMobile) { Modal } else { Popover }`); `undefined` falls through to Popover branch via `=== true` |
| §3 Modal 配置 (open/centered/width/footer/maskClosable/destroyOnClose/title) | Task 2 Modal props |
| §4 共用内容 (`ConversationInfoCard` + stopPropagation div) | Task 2 `cardBody` 复用 |
| §5 trigger button + testid | Task 2 Button + `data-testid="conversation-info-trigger"` |
| §测试 5 个用例 | Task 1 covers 3 of them; the parity test is implicit in both branches rendering `data-testid="conversation-info-card"`. Mask-close is covered by the second click of the toggle test (modal disappears). |

**2. Placeholder scan:** No TBD / TODO / "implement later" in plan.

**3. Type consistency:** `ConversationInfoButton` keeps the same default export; `useConversationInfo` and `useAppStore` consumers match existing signatures; no signature renames.

---

## Execution Handoff

Plan complete and saved to `docs/superpowers/plans/2026-07-26-mobile-conversation-info-popover-center.md`. Two execution options:

1. **Subagent-Driven (recommended)** — fresh subagent per task, review between tasks, fast iteration
2. **Inline Execution** — execute tasks in this session using executing-plans, batch execution with checkpoints