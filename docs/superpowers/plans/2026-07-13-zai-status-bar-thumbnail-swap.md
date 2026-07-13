# zai Status Bar / Thumbnail Swap Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Reorder the chat input area so uploaded image thumbnails render **above** the `● 就绪` status bar and are **right-aligned** within that row. When no attachments exist, the strip is `null` and the layout collapses to today.

**Architecture:** Two-file edit. `AttachmentStrip.tsx` gains an optional `align?: 'start' | 'end'` prop (default `'start'` preserves existing call sites). `Agent.tsx` swaps the vertical order of the drop-zone row and the status bar, and passes `align="end"` to the input-area `<AttachmentStrip />`. No new components, no server changes, no store / hook changes.

**Tech Stack:** React 18 + antd (existing). No new dependencies.

---

## Global Constraints

- The `<AttachmentStrip />` call inside `MessageBubble` (line 593 of `Agent.tsx`) is **not** touched — it must continue to render left-aligned inside its Card.
- `AttachmentStrip` keeps returning `null` when `attachments.length === 0` (no layout change in the empty state).
- No server / store / hook files are modified.
- Style-only change: `justifyContent` flips between `flex-start` and `flex-end`. Nothing else about the thumbnail card visuals changes.

---

## File Structure

| File | Role | Change |
|---|---|---|
| `packages/zai/src/web/src/components/AttachmentStrip.tsx` | Thumbnail row component (shared by input area + message bubbles) | Add optional `align` prop, route it to `justifyContent` |
| `packages/zai/src/web/src/pages/Agent.tsx` | Chat page | Swap drop-zone row above status bar; pass `align="end"` to the input-area `<AttachmentStrip />` |

No new files. No test files added — the change is pure visual + one optional prop defaulting to existing behavior, and there is no existing test for AttachmentStrip's flex layout to extend.

---

## Task 1: Add `align` prop to AttachmentStrip

**Files:**
- Modify: `packages/zai/src/web/src/components/AttachmentStrip.tsx:1-30`

**Interfaces:**
- Consumes: nothing (leaf component)
- Produces: `AttachmentStrip` accepts an optional `align?: 'start' | 'end'` (default `'start'`).

- [ ] **Step 1: Add the prop to the function signature**

In `packages/zai/src/web/src/components/AttachmentStrip.tsx`, update the destructured props. The current signature (lines 13–18) is:

```tsx
export function AttachmentStrip({
  attachments,
  onRemove,
}: {
  attachments: StripAttachment[]
  onRemove?: (localId: string) => void
}) {
```

Change it to:

```tsx
export function AttachmentStrip({
  attachments,
  onRemove,
  align = 'start',
}: {
  attachments: StripAttachment[]
  onRemove?: (localId: string) => void
  align?: 'start' | 'end'
}) {
```

- [ ] **Step 2: Route `align` to `justifyContent` on the outer flex container**

The current container (lines 21–29) is:

```tsx
<div
  style={{
    display: 'flex',
    gap: 8,
    flexWrap: 'wrap',
    padding: '8px 0',
  }}
>
```

Change it to:

```tsx
<div
  style={{
    display: 'flex',
    justifyContent: align === 'end' ? 'flex-end' : 'flex-start',
    gap: 8,
    flexWrap: 'wrap',
    padding: '8px 0',
  }}
>
```

- [ ] **Step 3: Run typecheck**

Run:
```bash
cd packages/zai && pnpm typecheck
```
Expected: PASS (no new type errors). The optional prop default keeps all existing call sites compiling unchanged.

- [ ] **Step 4: Commit**

```bash
git add packages/zai/src/web/src/components/AttachmentStrip.tsx
git commit -m "feat(zai-web): AttachmentStrip accepts align: 'start' | 'end'"
```

---

## Task 2: Swap row order and right-align input-area thumbnails in Agent.tsx

**Files:**
- Modify: `packages/zai/src/web/src/pages/Agent.tsx:1322-1405`

**Interfaces:**
- Consumes: `AttachmentStrip` with new `align?: 'start' | 'end'` prop (default `'start'`, set by Task 1).
- Produces: the chat input area renders in the order drop-zone → status bar → mode bar, with the input-area strip right-aligned.

- [ ] **Step 1: Reorder the three sibling rows**

In `packages/zai/src/web/src/pages/Agent.tsx`, find the outer `<div>` that holds the status bar, drop zone, and mode bar (currently lines 1322–1430). The current order is:

```tsx
<div>
  {/* 1. 状态栏 (lines 1322-1385) */}
  <div style={{ borderTop: '1px solid rgba(255,255,255,0.10)', borderBottom: '...', ... }}>
    ...status indicator, esc hint, upload, info...
  </div>

  {/* 2. drop zone (lines 1387-1405) */}
  <div onDrop={handleDrop} onDragOver={(e) => e.preventDefault()}>
    <AttachmentStrip attachments={attachments} onRemove={removeAttachment} />
    <div style={{ display: 'flex', alignItems: 'stretch' }}>
      <TextArea ... />
    </div>
  </div>

  {/* 3. 模式栏 (lines 1407-1429) */}
  <div style={{ borderTop: '1px solid rgba(255,255,255,0.10)', ... }}>
    ▶▶ zai · cwd · master · ModelStatusBadge
  </div>
</div>
```

Replace the entire `<div>` content so the three rows render in this order:

```tsx
<div>
  {/* 1. drop zone — moved to top so attachments appear above the status bar */}
  <div onDrop={handleDrop} onDragOver={(e) => e.preventDefault()}>
    <AttachmentStrip attachments={attachments} onRemove={removeAttachment} align="end" />
    <div style={{ display: 'flex', alignItems: 'stretch' }}>
      <TextArea
        ref={textareaRef}
        value={input}
        onChange={(e) => setInput(e.target.value)}
        onKeyDown={handleKeyDown}
        onPaste={handlePaste}
        placeholder="输入消息, 按 Enter 发送, Shift+Enter 换行. 可直接粘贴或拖拽图片."
        rows={3}
        disabled={status === 'streaming' || pendingAsk?.status === 'pending'}
        style={{ resize: 'none', flex: 1 }}
      />
    </div>
  </div>

  {/* 2. 状态栏 — moved below the drop zone */}
  <div
    style={{
      borderTop: '1px solid rgba(255,255,255,0.10)',
      borderBottom: '1px solid rgba(255,255,255,0.10)',
      padding: '6px 10px',
      fontSize: 12,
      fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace',
      color: 'rgba(255,255,255,0.45)',
      display: 'flex',
      alignItems: 'center',
      gap: 8,
    }}
  >
    <span
      style={{
        color:
          status === 'idle'
            ? '#22c55e'
            : status === 'streaming'
              ? '#ff6600'
              : 'inherit',
      }}
    >
      {status === 'streaming'
        ? SPINNER[spinnerIdx]
        : status === 'error'
          ? '✗'
          : status === 'aborted'
            ? '◼'
            : '●'}
    </span>
    <span>
      {status === 'idle' && '就绪'}
      {status === 'streaming' && `对话中… (${elapsed}s)`}
      {status === 'aborted' && '已中止'}
      {status === 'error' && '错误'}
    </span>
    {status === 'streaming' && (
      <span style={{ color: 'rgba(255,255,255,0.45)' }}>· esc 中断</span>
    )}
    <span style={{ flex: 1 }} />
    <Button
      icon={<PictureOutlined />}
      onClick={() => fileInputRef.current?.click()}
      title="上传图片"
      disabled={status === 'streaming' || pendingAsk?.status === 'pending'}
      style={{ color: 'rgba(255,255,255,0.45)' }}
    />
    <ConversationInfoButton />
    <input
      ref={fileInputRef}
      type="file"
      accept="image/*"
      multiple
      style={{ display: 'none' }}
      onChange={handleFilePick}
    />
  </div>

  {/* 3. 模式栏 — unchanged, stays at bottom */}
  <div
    style={{
      borderTop: '1px solid rgba(255,255,255,0.10)',
      padding: '6px 10px',
      fontSize: 12,
      fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace',
      color: 'rgba(255,255,255,0.45)',
      display: 'flex',
      alignItems: 'center',
      gap: 8,
    }}
  >
    <span style={{ color: '#a78bfa' }}>▶▶</span>
    <span>zai</span>
    <span style={{ color: 'rgba(255,255,255,0.25)' }}>·</span>
    <span>{cwd || '~'}</span>
    <span style={{ color: 'rgba(255,255,255,0.25)' }}>·</span>
    <span>master</span>
    <span style={{ color: 'rgba(255,255,255,0.25)' }}>·</span>
    <ModelStatusBadge />
  </div>
</div>
```

Two things change versus the existing file:

- The drop-zone `<div>` is the **first** child of the outer wrapper (was second).
- The status bar is the **second** child (was first).
- The input-area `<AttachmentStrip />` gains `align="end"`.
- The mode bar stays last.

The `<AttachmentStrip />` inside `MessageBubble` (around line 593) is **not** touched.

- [ ] **Step 2: Run typecheck**

Run:
```bash
cd packages/zai && pnpm typecheck
```
Expected: PASS. The `align` prop is optional; existing call sites default to `'start'` and continue to compile.

- [ ] **Step 3: Run existing web unit tests**

Run:
```bash
cd packages/zai && pnpm test -- src/web
```
Expected: all existing tests pass (no behavioral change to the components under test). Test files exercised:
- `packages/zai/src/web/src/store/useAgentStore.test.ts`
- `packages/zai/src/web/src/store/useAppStore.test.ts`
- `packages/zai/src/web/src/lib/eventSource.test.ts`

- [ ] **Step 4: Commit**

```bash
git add packages/zai/src/web/src/pages/Agent.tsx
git commit -m "fix(zai-web): move attachment thumbnails above status bar, right-align"
```

---

## Task 3: Manual smoke verification

**Files:** none (read-only verification)

- [ ] **Step 1: Start the dev server**

Run:
```bash
cd packages/zai && pnpm dev
```
Expected: Vite reports `Local: http://localhost:<port>/` and the server is reachable.

- [ ] **Step 2: Empty-state check**

Open `/agent` in a browser. Verify:
- No attachments: layout looks identical to before — `● 就绪` status bar directly above the textarea, mode bar at the bottom.

- [ ] **Step 3: With-attachment check**

Paste an image into the textarea. Verify:
- The thumbnail row appears **above** the `● 就绪` status bar.
- The thumbnail row is **right-aligned** within its container.
- The status bar still shows the live status indicator, esc interrupt hint, picture upload button, and conversation info button.

- [ ] **Step 4: Remove-thumbnail check**

Click the `X` on one thumbnail. Verify:
- Strip shrinks; remaining thumbnails stay right-aligned.
- After removing the last thumbnail, the strip disappears and the status bar returns to the empty-state position (directly above textarea).

- [ ] **Step 5: Send-with-attachments check**

Send a message that includes the attachment. Verify:
- The user-message bubble in the conversation stream renders its attached images **left-aligned** inside its Card (unchanged from before).
- The input area is empty again; status bar returns to the empty-state position.

- [ ] **Step 6: Drag-and-drop check**

Drag an image file from the desktop over the textarea + status bar area. Verify:
- The drop still triggers `handleDrop` (thumbnails appear in the strip above the status bar).
- No double-fire of `handleDrop` (only one set of thumbnails is created for the drop).

---

## Self-Review

**1. Spec coverage:**
- ✓ Swap drop-zone row above status bar → Task 2, Step 1
- ✓ Right-align thumbnails → Task 1, Step 2 + Task 2, Step 1 (`align="end"` passed)
- ✓ Default `'start'` keeps message-bubble usage unchanged → Task 1, Step 1 (default param) + Task 2, Step 1 (explicit comment that line 593 is untouched)
- ✓ Empty-state parity → Task 3, Step 2 (manual smoke)
- ✓ No server / store / hook changes → out of scope noted in Constraints + Tasks 1–2 explicitly do not touch those paths

**2. Placeholder scan:** No TBD / TODO / "similar to" / "implement later" markers in the plan. All code blocks are concrete.

**3. Type consistency:** `align?: 'start' | 'end'` is the single source of truth — defined as the prop type in Task 1, used as a string literal in Task 2 (`align="end"`), no conflicting names anywhere.