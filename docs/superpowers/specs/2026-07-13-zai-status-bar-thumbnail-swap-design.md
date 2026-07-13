# zai Status Bar / Thumbnail Swap Design

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Reorder the chat input area so uploaded image thumbnails render **above** the `● 就绪` status bar and are **right-aligned** within that row. When no attachments exist, the strip is `null` and the layout collapses to today.

**Architecture:** Two small edits in `Agent.tsx` + one prop extension in `AttachmentStrip.tsx`. No new components, no server changes. The drop zone stays as the single drag/drop receiver.

**Tech Stack:** React 18 + antd (existing).

---

## Background

The Agent chat page (`packages/zai/src/web/src/pages/Agent.tsx`) currently lays out three rows above the mode bar:

1. **Status bar** (lines 1322–1385) — `borderTop` + `borderBottom`, holds the live status indicator, elapsed timer, esc-interrupt hint, picture upload button, and `ConversationInfoButton`.
2. **Drop zone** wrapping `<AttachmentStrip />` + `<TextArea>` (lines 1387–1405).
3. **Mode bar** (lines 1407–1429) — `borderTop`, holds `▶▶ zai · cwd · master · <ModelStatusBadge />`.

`AttachmentStrip` (`packages/zai/src/web/src/components/AttachmentStrip.tsx`) is also used in `MessageBubble` for rendering user-message image attachments (line 593). It currently uses `display: 'flex'` with default `flex-direction: row` (left-to-right, left-aligned) and `flexWrap: 'wrap'`.

User wants two layout changes:

- The thumbnails in the **input area** render above the status bar (status bar moves below the drop zone).
- The thumbnails are right-aligned (`justify-content: flex-end`).

The message-bubble thumbnail usage stays left-aligned (it sits inside the user message Card which is itself right-aligned by flex parent).

---

## Changes

### File 1: `packages/zai/src/web/src/components/AttachmentStrip.tsx`

Add an optional `align` prop with two values: `'start'` (default, current behavior) and `'end'` (right-aligned). Apply as `justifyContent` on the outer flex container.

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
  if (attachments.length === 0) return null
  return (
    <div
      style={{
        display: 'flex',
        justifyContent: align === 'end' ? 'flex-end' : 'flex-start',
        gap: 8,
        flexWrap: 'wrap',
        padding: '8px 0',
      }}
    >
      {/* …unchanged thumbnail cards… */}
    </div>
  )
}
```

Default keeps message-bubble usage identical to today; only the call site in `Agent.tsx` opts in to `'end'`.

### File 2: `packages/zai/src/web/src/pages/Agent.tsx`

Two edits:

1. **Swap sibling order.** Move the drop zone `<div onDrop onDragOver>...</div>` to the top, status bar to the middle, mode bar stays last. The three rows are still siblings inside the same outer wrapper.

2. **Pass `align="end"`** to the input-area `<AttachmentStrip />`:

```tsx
<AttachmentStrip
  attachments={attachments}
  onRemove={removeAttachment}
  align="end"
/>
```

The message-bubble call (`<AttachmentStrip attachments={msgAttachments} />`) is **not** touched — it continues to use the default `align="start"`.

### Resulting layout

When attachments exist:

```
[📷 📷 📷]                                ← right-aligned thumbnails (align="end")
[● 就绪 · esc 中断 · [图片上传] · [info]]  ← status bar (borderTop + borderBottom)
[textarea input box]
[▶▶ zai · cwd · master · MiniMax-M3]
```

When no attachments (strip is `null`):

```
[● 就绪 · esc 中断 · [图片上传] · [info]]  ← status bar
[textarea input box]
[▶▶ zai · cwd · master · MiniMax-M3]
```

Visually identical to today in the empty case.

---

## Why this design

- **Smallest blast radius:** two-file edit, no new components, no new state, no behavior change for drag/drop or for the message-bubble thumbnail rendering.
- **Localized alignment control:** `align` is a per-call-site prop, so the message-bubble usage (which lives inside a right-aligned Card) keeps its left-to-right internal layout — wrapping in reverse would look odd against the bubble's own left edge.
- **Empty-state parity:** `AttachmentStrip` still returns `null` when empty, so users without an image see the same layout as before.
- **Drop zone unchanged:** the drop receiver is still the single `<div onDrop onDragOver>` wrapping strip + textarea, so drag/drop semantics don't shift.

---

## Out of scope

- Visual restyling of the status bar, attachment cards, or mode bar.
- Moving the mode bar or relocating the status bar above the conversation stream.
- Any server / store / hook changes.

---

## Testing strategy

Pure visual + one optional prop. Existing tests must continue to pass:

- `useAgentStore.test.ts` — no change to store API.
- `useConversationInfo.test.ts` — no change to conversation info hook.
- `eventSource.test.ts` — no change to event stream parsing.

Manual smoke:

1. Open `/agent`, send a plain text message. Layout identical to today (status bar above textarea, mode bar below).
2. Paste / drag an image. Thumbnails appear right-aligned in a row above the status bar; status bar still shows live indicator + esc hint + upload + info buttons.
3. Remove one thumbnail with its `X`. Strip shrinks; remaining thumbs stay right-aligned.
4. Remove all thumbnails. Strip disappears; layout collapses back to pre-attachment state.
5. Send the message with attachments. User-message bubble in the conversation stream still shows thumbnails left-aligned inside its Card (unchanged from today).