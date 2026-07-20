# zai Transcript Collapse Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a fold/collapse view to the zai Agent transcript that merges consecutive tool calls into a single `ToolGroupCard` and clamps long text to 6 lines, toggled via a header button. Store gains only 1 boolean (`transcriptCollapsed`); the original `messages[]` array is never mutated.

**Architecture:** A pure function `deriveTranscriptNodes(messages)` walks the existing `messages[]` array and produces a node sequence (`TextNode | ToolGroupNode | ThinkingNode | AskNode`). A new `<MessageListView>` component subscribes to `messages` + `transcriptCollapsed` from the Zustand store and routes between the existing per-message `<MessageBubble>` (collapsed=false) and the new group/clamp view (collapsed=true). Render layer only — no SSE / transcript / model logic touched.

**Tech Stack:** TypeScript, React 18, Zustand, Ant Design (already in use), Vitest (already configured for `environment: 'node'`), pnpm workspace.

## Global Constraints

- **Engine:** Node ≥20 (from `packages/zai/package.json:engines.node`)
- **Test runner:** Vitest, config at `packages/zai/vitest.config.ts` (env: `node`, globals: true, includes `test/**/*.{test.ts,test.tsx}` and `src/**/*.{test.ts,test.tsx}`)
- **Test command:** `cd packages/zai && pnpm test <pattern>` for selective run; `pnpm test` for all
- **Typecheck:** `cd packages/zai && pnpm typecheck` (= `tsc -b --noEmit`)
- **No new dependencies** — Tailwind/AntD already available; no new npm install
- **Import suffix convention:** Use `.js` suffix on **all** relative imports of TS source — both cross-boundary (`'../../store/useAgentStore.js'`) and same-directory (`'./MessageBubble.js'`). The codebase is mix-matched but `.js` works everywhere under `"type":"module"` and is the safer default; follow the **specific path shown in each task's code block**, which has been pre-checked against the actual file structure. Test imports MUST use `.js` suffix (vitest needs ESM-style resolution).
- **Naming:** Components in PascalCase, files `.tsx`; pure functions `.ts`; tests `.test.ts`
- **CSS approach:** Inline styles + AntD `<Typography.Paragraph ellipsis>` for clamp; do NOT add new CSS files
- **commit-message style:** Conventional Commits (`feat:`, `test:`, `refactor:`, `fix:`); no `--no-verify`
- **frequently commit:** one commit per task (after tests green)

---

## File Structure

| File | Status | Responsibility |
|---|---|---|
| `packages/zai/src/web/src/components/transcript/deriveTranscriptNodes.ts` | **create** | Pure function: scan messages → node list. No React, no store. The single source of truth for grouping rules. |
| `packages/zai/test/web/transcript/deriveTranscriptNodes.test.ts` | **create** | Vitest unit tests (9 cases from spec §7.1). |
| `packages/zai/src/web/src/components/transcript/CollapsedMessageBubble.tsx` | **create** | Renders a single message in collapsed view. `line-clamp:6` via `<Typography.Paragraph ellipsis>`. Hidden thinking nodes. Error stripe stays visible. |
| `packages/zai/src/web/src/components/transcript/ToolGroupCard.tsx` | **create** | Renders a merged tool group. Header `N 个工具调用 · Bash, Read +N`. Failure badge. Expand toggles inline `<ToolRender>` per entry. |
| `packages/zai/src/web/src/components/transcript/MessageBubble.tsx` | **create** (move from Agent.tsx) | Extract the existing `MessageBubble = React.memo(function MessageBubble…){…}` (Agent.tsx:743-1155) verbatim into its own file. **Pure mechanical move** — no logic changes. |
| `packages/zai/src/web/src/components/transcript/MessageListView.tsx` | **create** | Subscribes to `messages` + `transcriptCollapsed` from `useAgentStore`. Routes to MessageBubble (collapsed=false) or derived nodes (collapsed=true). |
| `packages/zai/src/web/src/pages/Agent.tsx` | **modify** | Replace inline `messageList = messages.map(...)` useMemo with `<MessageListView messages={messages} streaming={...} />`. Add the toggle button on top of the message area. Remove `MessageBubble` definition (moved out). Update import. |
| `packages/zai/src/web/src/store/useAgentStore.ts` | **modify** | Add `transcriptCollapsed: boolean` field (default `false`) and `toggleTranscriptCollapsed` action. **Do not touch** any other field/reducer. Do not persist. Do not reset on session switch. |

Files that change together live together: `transcript/` houses all four new components + the pure function (UI derived view is one logical unit).

---

### Task 1: `deriveTranscriptNodes` — pure function with 9 vitest cases (TDD)

> **Execution order:** Tasks 1, 2, 3 have no inter-dependencies and **may be run in parallel** by a sub-agent dispatcher. Task 4 must wait for Task 3 (it imports `MessageBubble`). Tasks 5, 6, 7, 8 are strictly sequential (each depends on the prior). Sub-agent driven mode dispatches 1, 2, 3 in parallel, then chains 4→5→6→7→8.


**Files:**
- Create: `packages/zai/src/web/src/components/transcript/deriveTranscriptNodes.ts`
- Test: `packages/zai/test/web/transcript/deriveTranscriptNodes.test.ts`

**Interfaces:**
- Consumes: `AgentMessage` (exported from `packages/zai/src/web/src/store/useAgentStore.ts`)
- Produces:
  ```ts
  export type ToolGroupStatus = 'pending' | 'done' | 'error' | 'invalid' | 'denied'
  export type ToolGroupEntry = {
    message: AgentMessage
    index: number
    status: ToolGroupStatus
  }
  export type TranscriptNode =
    | { kind: 'text'; messages: AgentMessage[]; startIndex: number; endIndex: number }
    | { kind: 'toolGroup'; toolCalls: ToolGroupEntry[]; startIndex: number; endIndex: number }
    | { kind: 'thinking'; message: AgentMessage; index: number }
    | { kind: 'ask'; message: AgentMessage; index: number }
  export function deriveTranscriptNodes(messages: AgentMessage[]): TranscriptNode[]
  ```

- [ ] **Step 1: Create test file with the 9 cases**

Create the file `packages/zai/test/web/transcript/deriveTranscriptNodes.test.ts`:

```ts
import { describe, it, expect } from 'vitest'
import type { AgentMessage } from '../../../src/web/src/store/useAgentStore.js'
import { deriveTranscriptNodes } from '../../../src/web/src/components/transcript/deriveTranscriptNodes.js'

// Lightweight factory — only fields we read. Real AgentMessage has more.
function userMsg(text: string, idx: number): AgentMessage {
  return { type: 'user', text, eventId: `u-${idx}`, sendSeq: 0, turnIndex: 0, blockIndex: 0 } as AgentMessage
}
function assistantMsg(text: string, idx: number): AgentMessage {
  return { type: 'assistant', text, eventId: `a-${idx}`, sendSeq: 0, turnIndex: 0, blockIndex: 0 } as AgentMessage
}
function toolStart(name: string, idx: number, toolUseId: string): AgentMessage {
  return { type: 'tool_use:start', toolName: name, toolUseId, eventId: `t-${idx}`, sendSeq: 0, turnIndex: 0, blockIndex: 0 } as AgentMessage
}
function toolDone(name: string, idx: number, toolUseId: string): AgentMessage {
  return { type: 'tool_use:done', toolName: name, toolUseId, eventId: `d-${idx}`, sendSeq: 0, turnIndex: 0, blockIndex: 0 } as AgentMessage
}
function toolError(toolUseId: string, idx: number): AgentMessage {
  return { type: 'tool_use:error', toolUseId, eventId: `e-${idx}`, sendSeq: 0, turnIndex: 0, blockIndex: 0 } as AgentMessage
}
function thinkingMsg(text: string, idx: number): AgentMessage {
  return { type: 'assistant', thinking: text, eventId: `th-${idx}`, sendSeq: 0, turnIndex: 0, blockIndex: 0 } as AgentMessage
}
function askMsg(idx: number): AgentMessage {
  return { type: 'prompt.ask', questions: [{ question: 'q', header: 'h', options: [] }], toolUseId: `ask-${idx}`, sessionId: 's', eventId: `ask-${idx}` } as unknown as AgentMessage
}
function boundaryMsg(idx: number): AgentMessage {
  return { type: 'compact_boundary', eventId: `b-${idx}` } as unknown as AgentMessage
}

describe('deriveTranscriptNodes', () => {
  it('case 1: empty array', () => {
    expect(deriveTranscriptNodes([])).toEqual([])
  })

  it('case 2: single user text → single TextNode', () => {
    const out = deriveTranscriptNodes([userMsg('hi', 0)])
    expect(out).toHaveLength(1)
    expect(out[0].kind).toBe('text')
  })

  it('case 3: user + 1 tool + done → [text, toolGroup, text]', () => {
    const msgs = [
      userMsg('do', 0),
      toolStart('Bash', 1, 'tu1'),
      toolDone('Bash', 2, 'tu1'),
      assistantMsg('done', 3),
    ]
    const out = deriveTranscriptNodes(msgs)
    expect(out.map(n => n.kind)).toEqual(['text', 'toolGroup', 'text'])
    expect(out[1].kind === 'toolGroup' && out[1].toolCalls).toHaveLength(2)
  })

  it('case 4: user + 3 consecutive tools + user → [text, toolGroup(len=6 entries), text]', () => {
    const msgs = [
      userMsg('build', 0),
      toolStart('Bash', 1, 't1'), toolDone('Bash', 2, 't1'),
      toolStart('Read', 3, 't2'), toolDone('Read', 4, 't2'),
      toolStart('Edit', 5, 't3'), toolDone('Edit', 6, 't3'),
      assistantMsg('done', 7),
    ]
    const out = deriveTranscriptNodes(msgs)
    expect(out.map(n => n.kind)).toEqual(['text', 'toolGroup', 'text'])
    if (out[1].kind === 'toolGroup') {
      expect(out[1].toolCalls).toHaveLength(6)
    }
  })

  it('case 5: thinking pass-through separates tool groups', () => {
    const msgs = [
      userMsg('q', 0),
      toolStart('Bash', 1, 't1'), toolDone('Bash', 2, 't1'),
      thinkingMsg('hmm', 3),
      userMsg('q2', 4),
    ]
    const out = deriveTranscriptNodes(msgs)
    // thinking bumps startIndex — must NOT be inside the tool group
    expect(out.map(n => n.kind)).toEqual(['text', 'toolGroup', 'thinking', 'text'])
  })

  it('case 6: tool_use:start without :done → group with status:pending', () => {
    const msgs = [
      userMsg('q', 0),
      toolStart('Bash', 1, 't1'),
      userMsg('q2', 2),
    ]
    const out = deriveTranscriptNodes(msgs)
    expect(out.map(n => n.kind)).toEqual(['text', 'toolGroup', 'text'])
    if (out[1].kind === 'toolGroup') {
      expect(out[1].toolCalls[0].status).toBe('pending')
    }
  })

  it('case 7: tool_use:error counts toward failure badge', () => {
    const msgs = [
      userMsg('q', 0),
      toolStart('Bash', 1, 't1'), toolDone('Bash', 2, 't1'),
      toolStart('Read', 3, 't2'), toolError('t2', 4),
      toolStart('Edit', 5, 't3'), toolDone('Edit', 6, 't3'),
      userMsg('q2', 7),
    ]
    const out = deriveTranscriptNodes(msgs)
    const grp = out.find(n => n.kind === 'toolGroup')
    if (grp && grp.kind === 'toolGroup') {
      const errs = grp.toolCalls.filter(e => e.status === 'error')
      expect(errs).toHaveLength(1)
    }
  })

  it('case 8: compact_boundary renders as text-node entry', () => {
    const msgs = [userMsg('q', 0), boundaryMsg(1), userMsg('q2', 2)]
    const out = deriveTranscriptNodes(msgs)
    // boundary sits in the text bucket — ends one text-run, starts the next
    expect(out.filter(n => n.kind === 'text').length).toBeGreaterThanOrEqual(2)
  })

  it('case 9: AskUserQuestion stays ask, never joins toolGroup', () => {
    const msgs = [
      userMsg('q', 0),
      toolStart('Bash', 1, 't1'),
      askMsg(2),
      toolDone('Bash', 3, 't1'),
    ]
    const out = deriveTranscriptNodes(msgs)
    expect(out.some(n => n.kind === 'ask')).toBe(true)
    const grp = out.find(n => n.kind === 'toolGroup')
    if (grp && grp.kind === 'toolGroup') {
      expect(grp.toolCalls).toHaveLength(1) // only :start — :done is on the other side of ask
    }
  })
})
```

- [ ] **Step 2: Run the test to verify it FAILS (function not defined)**

Run: `cd packages/zai && pnpm test deriveTranscriptNodes`
Expected: fail with `Failed to resolve import "../../../src/web/src/components/transcript/deriveTranscriptNodes.js"` (file does not exist yet).

- [ ] **Step 3: Create the empty file so the import resolves**

Create `packages/zai/src/web/src/components/transcript/deriveTranscriptNodes.ts` with this stub:

```ts
import type { AgentMessage } from '../../store/useAgentStore.js'

export type ToolGroupStatus = 'pending' | 'done' | 'error' | 'invalid' | 'denied'

export type ToolGroupEntry = {
  message: AgentMessage
  index: number
  status: ToolGroupStatus
}

export type TranscriptNode =
  | { kind: 'text'; messages: AgentMessage[]; startIndex: number; endIndex: number }
  | { kind: 'toolGroup'; toolCalls: ToolGroupEntry[]; startIndex: number; endIndex: number }
  | { kind: 'thinking'; message: AgentMessage; index: number }
  | { kind: 'ask'; message: AgentMessage; index: number }

const TOOL_TYPES = new Set(['tool_use:start', 'tool_use:done', 'tool_use:error', 'tool_use:invalid', 'tool_use:denied'])

function statusOf(msg: AgentMessage): ToolGroupStatus {
  switch (msg.type) {
    case 'tool_use:start': return 'pending'
    case 'tool_use:done': return 'done'
    case 'tool_use:error': return 'error'
    case 'tool_use:invalid': return 'invalid'
    case 'tool_use:denied': return 'denied'
    default: return 'done'
  }
}

function pushText(buf: AgentMessage[], out: TranscriptNode[], startIndex: number, idx: number) {
  if (buf.length === 0) return
  out.push({ kind: 'text', messages: buf.slice(), startIndex, endIndex: idx - 1 })
  buf.length = 0
}

export function deriveTranscriptNodes(messages: AgentMessage[]): TranscriptNode[] {
  const out: TranscriptNode[] = []
  let textBuf: AgentMessage[] = []
  let groupBuf: ToolGroupEntry[] = []
  let groupStart = -1
  let textStart = -1

  const flushGroup = (endIdx: number) => {
    if (groupBuf.length === 0) return
    out.push({ kind: 'toolGroup', toolCalls: groupBuf.slice(), startIndex: groupStart, endIndex: endIdx })
    groupBuf = []
    groupStart = -1
  }

  for (let i = 0; i < messages.length; i++) {
    const m = messages[i] as any
    const t = m?.type as string
    if (TOOL_TYPES.has(t)) {
      if (textBuf.length) pushText(textBuf, out, textStart, i)
      if (groupBuf.length === 0) groupStart = i
      groupBuf.push({ message: m, index: i, status: statusOf(m) })
      continue
    }
    if (t === 'prompt.ask') {
      flushGroup(i - 1)
      if (textBuf.length) pushText(textBuf, out, textStart, i)
      out.push({ kind: 'ask', message: m, index: i })
      textStart = -1
      continue
    }
    // Assistant message: if it carries a `thinking` field, treat as thinking pass-through.
    if (t === 'assistant' && typeof m.thinking === 'string' && m.thinking.length > 0) {
      flushGroup(i - 1)
      if (textBuf.length) pushText(textBuf, out, textStart, i)
      out.push({ kind: 'thinking', message: m, index: i })
      textStart = -1
      continue
    }
    // Otherwise text bucket (user / assistant text / compact_boundary / unknown)
    flushGroup(i - 1)
    if (textBuf.length === 0) textStart = i
    textBuf.push(m)
  }

  // tail flush
  flushGroup(messages.length - 1)
  if (textBuf.length) pushText(textBuf, out, textStart, messages.length - 1)

  return out
}
```

- [ ] **Step 4: Run the test, verify all 9 cases PASS**

Run: `cd packages/zai && pnpm test deriveTranscriptNodes`
Expected: 9 passed.

- [ ] **Step 5: Run typecheck, verify clean**

Run: `cd packages/zai && pnpm typecheck`
Expected: no errors.

- [ ] **Step 6: Commit**

```bash
cd /Users/ethan/code/opencc-web
git add packages/zai/src/web/src/components/transcript/deriveTranscriptNodes.ts packages/zai/test/web/transcript/deriveTranscriptNodes.test.ts
git commit -m "feat(transcript): add deriveTranscriptNodes pure function with 9 vitest cases"
```

---

### Task 2: Store — add `transcriptCollapsed` boolean

**Files:**
- Modify: `packages/zai/src/web/src/store/useAgentStore.ts`

**Interfaces:**
- Consumes: (existing `create<…>` Zustand store creator)
- Produces: a new top-level field `transcriptCollapsed: boolean` (default `false`) and an action `toggleTranscriptCollapsed: () => void`

- [ ] **Step 1: Locate the field-set block and the actions block**

Open `packages/zai/src/web/src/store/useAgentStore.ts`. The store is a Zustand `create<…>((set, get) => ({ … }))` block. The actions currently end around `clearMessages` near the file tail (~line 838-859 in current revision). Find the `return {` immediately before the first action (search for `setStatus: (status: AgentStatus) => set({ status }),`) — we'll insert next to it.

- [ ] **Step 2: Add the field to the initial-state portion**

In the same `create` call, find the line that ends the initial state object before the actions section begins (the boundary is the comment block `// ========== Actions ==========` or similar — search for the action `setStatus:`). Just above `setStatus:`, add:

```ts
  // Transcript collapse toggle (UI layer). 不写 localStorage, 不持久化.
  // 刷新归零, 切 session 不重置 (因为是全局布尔, 不属于 messagesBySession).
  // 仅本次会话 (刷新后归零).
  transcriptCollapsed: false,
```

The exact insertion point must be a property of the object literal passed to `create()`. Do not add it inside an action. Do not add it inside a nested object.

- [ ] **Step 3: Add the action next to `setStatus`**

After `setStatus: (status: AgentStatus) => set({ status }),` add a comma (if not already), and a new line:

```ts
  toggleTranscriptCollapsed: () =>
    set((s) => ({ transcriptCollapsed: !s.transcriptCollapsed })),
```

- [ ] **Step 4: Run typecheck, verify clean**

Run: `cd packages/zai && pnpm typecheck`
Expected: no errors. If `transcriptCollapsed`/`toggleTranscriptCollapsed` is missing in the store type, it means you put it inside the wrong scope — fix and retry.

- [ ] **Step 5: Commit**

```bash
cd /Users/ethan/code/opencc-web
git add packages/zai/src/web/src/store/useAgentStore.ts
git commit -m "feat(store): add transcriptCollapsed boolean + toggleTranscriptCollapsed action"
```

---

### Task 3: Extract `MessageBubble` from Agent.tsx into its own file (mechanical move)

**Files:**
- Create: `packages/zai/src/web/src/components/transcript/MessageBubble.tsx`
- Modify: `packages/zai/src/web/src/pages/Agent.tsx` (delete the inline `MessageBubble = React.memo(function MessageBubble…)` definition; add an import)

**Interfaces:**
- Consumes: (existing `AgentMessage` type, `getRenderer` from `../components/toolRenderers/registry.js`, `useAgentStore`, AntD components, all currently imported inside Agent.tsx around lines 1-60)
- Produces:
  ```ts
  export const MessageBubble: React.NamedExoticComponent<{
    msg: AgentMessage
    streaming?: boolean
  }>
  ```
  This component does **not** subscribe to `transcriptCollapsed`. It renders exactly what the current inline `MessageBubble` renders, byte-identical.

- [ ] **Step 1: Read the existing MessageBubble body in full**

Open `packages/zai/src/web/src/pages/Agent.tsx` and locate the `MessageBubble = React.memo(function MessageBubble({` line (currently line 743 in the repo). Read from that line through the closing `)` of the memo callback. Note every import it references — many of these are referenced via outer-scope captures.

- [ ] **Step 2: Copy the body verbatim**

Create `packages/zai/src/web/src/components/transcript/MessageBubble.tsx`. At the top, paste the imports **used by MessageBubble only** (do not blindly copy all imports from Agent.tsx — only the symbols that appear inside the function body). Common ones likely needed:
- `React`, `{ useMemo, useState }` from `react`
- `AgentMessage`, `useAgentStore`, possibly other zustand-derived stores
- AntD components actually referenced (`Typography`, `Card`, `Tag`, `Button`, `Space`, `Alert`)
- `getRenderer` from `../toolRenderers/registry.js`
- Any helpers used by the renderContent switch

Then paste the body verbatim, exporting it:
```ts
export const MessageBubble = React.memo(function MessageBubble({
  msg,
  streaming,
}: { msg: AgentMessage; streaming?: boolean }) {
  // ... pasted body, unchanged ...
})
```

Resolve any unclear imports during this step by reading the symbol's usage inside the body. If a value is captured from the outer Agent component closure (rare — the existing component is standalone), inline a `useAgentStore(...)` selector instead so MessageBubble has no closure dependencies.

- [ ] **Step 3: Delete the inline definition from Agent.tsx**

In `packages/zai/src/web/src/pages/Agent.tsx`:
- Delete the entire `const MessageBubble = React.memo(...) { ... }` block (everything from `const MessageBubble = React.memo(` through the matching close `)`).
- Add (or update existing imports near the top of Agent.tsx):
```ts
import { MessageBubble } from "../components/transcript/MessageBubble";
```
(Use the same import path style already in use elsewhere in Agent.tsx — bare relative.)

- [ ] **Step 4: Run typecheck — both files must remain clean**

Run: `cd packages/zai && pnpm typecheck`
Expected: no errors. If typecheck fails inside MessageBubble, the missing import was not copied — go back to Step 2, identify the symbol via the error message, and add the import.

- [ ] **Step 5: Smoke check by booting dev server**

```bash
cd packages/zai && pnpm dev
```
Open the URL printed. Send a chat message that triggers a tool call (e.g. `run pwd and date`). Verify the transcript visually is byte-identical to before this task: same fonts, same code blocks, same question cards. If anything looks different, you broke a ref during the move — diff `MessageBubble.tsx` against the deleted range to find the drift.

Stop the server with Ctrl-C after visual confirmation.

- [ ] **Step 6: Commit**

```bash
cd /Users/ethan/code/opencc-web
git add packages/zai/src/web/src/components/transcript/MessageBubble.tsx packages/zai/src/web/src/pages/Agent.tsx
git commit -m "refactor(transcript): extract MessageBubble into its own file"
```

---

### Task 4: `CollapsedMessageBubble` + `ToolGroupCard`

**Files:**
- Create: `packages/zai/src/web/src/components/transcript/CollapsedMessageBubble.tsx`
- Create: `packages/zai/src/web/src/components/transcript/ToolGroupCard.tsx`

**Interfaces:**
- Consumes: `AgentMessage`, `ToolGroupEntry`, `getRenderer` from `../toolRenderers/registry.js`
- Produces:
  ```ts
  // CollapsedMessageBubble
  export function CollapsedMessageBubble(props: { message: AgentMessage }): JSX.Element

  // ToolGroupCard
  export function ToolGroupCard(props: { entries: ToolGroupEntry[] }): JSX.Element
  ```

- [ ] **Step 1: Write `CollapsedMessageBubble.tsx`**

Create `packages/zai/src/web/src/components/transcript/CollapsedMessageBubble.tsx`:

```tsx
import { Typography } from 'antd'
import type { AgentMessage } from '../../store/useAgentStore.js'

const { Paragraph } = Typography

const CLAMP_LINES = 6

export function CollapsedMessageBubble({ message }: { message: AgentMessage }) {
  const m = message as any
  const text: string =
    (m.text as string) ?? (m.content as string) ?? ''

  // tool_use:error is a non-text message — render a red stripe, full text.
  const isError = (m.type as string) === 'tool_use:error'
  if (isError) {
    return (
      <div data-collapsed-error style={{ color: '#cf1322', padding: '4px 8px', borderLeft: '3px solid #cf1322' }}>
        <strong>Tool error</strong>
        <Paragraph style={{ marginBottom: 0, color: '#cf1322' }}>{text || '(no message)'}</Paragraph>
      </div>
    )
  }

  // Thinking: even in collapsed view, render full text.
  if ((m.type as string) === 'assistant' && typeof m.thinking === 'string' && m.thinking.length > 0) {
    return (
      <div style={{ padding: '4px 8px', background: '#fafafa', borderLeft: '3px solid #d9d9d9' }}>
        <em style={{ color: '#8c8c8c' }}>thinking:</em>
        <Paragraph style={{ marginBottom: 0 }}>{m.thinking as string}</Paragraph>
      </div>
    )
  }

  return (
    <div style={{ padding: '4px 8px' }}>
      <Paragraph
        ellipsis={{ rows: CLAMP_LINES, expandable: true, symbol: '显示更多' }}
        style={{ marginBottom: 0 }}
      >
        {text}
      </Paragraph>
    </div>
  )
}
```

- [ ] **Step 2: Write `ToolGroupCard.tsx`**

Create `packages/zai/src/web/src/components/transcript/ToolGroupCard.tsx`:

```tsx
import { useState } from 'react'
import { Button, Card, Tag } from 'antd'
import type { ToolGroupEntry } from './deriveTranscriptNodes.js'
import { MessageBubble } from './MessageBubble.js'

function summarizeNames(entries: ToolGroupEntry[]): string {
  const names = entries
    .map((e) => ((e.message as any).toolName as string) ?? 'Tool')
    .filter(Boolean)
  // Dedup consecutive duplicates: "Bash, Bash, Read" → "Bash, Read +1"
  const seen: string[] = []
  for (const n of names) if (seen[seen.length - 1] !== n) seen.push(n)
  if (seen.length <= 3) return seen.join(', ')
  return `${seen.slice(0, 3).join(', ')} +${seen.length - 3}`
}

function errorCount(entries: ToolGroupEntry[]): number {
  return entries.filter((e) => e.status === 'error' || e.status === 'invalid' || e.status === 'denied').length
}

export function ToolGroupCard({ entries }: { entries: ToolGroupEntry[] }) {
  const [expanded, setExpanded] = useState(false)
  const errs = errorCount(entries)
  const summary = summarizeNames(entries)
  const titleText = entries.length === 1
    ? `1 个工具调用 · ${summary}`
    : `${entries.length} 个工具调用`

  return (
    <Card
      size="small"
      style={{ marginBottom: 8 }}
      title={
        <span>
          {titleText}
          {summary && entries.length > 1 && (
            <span style={{ marginLeft: 8, color: '#8c8c8c' }}>· {summary}</span>
          )}
          {errs > 0 && (
            <Tag color="red" style={{ marginLeft: 8 }}>{errs} 个失败</Tag>
          )}
        </span>
      }
      extra={
        <Button size="small" onClick={() => setExpanded((x) => !x)}>
          {expanded ? '收起' : `展开 ${entries.length} 个工具`}
        </Button>
      }
    >
      {expanded &&
        entries.map((e, i) => {
          const evtId = ((e.message as any).eventId as string) ?? `tool-${e.index}`
          return (
            <MessageBubble
              key={evtId}
              msg={e.message}
              streaming={e.status === 'pending'}
            />
          )
        })}
      {!expanded && (
        <div style={{ color: '#8c8c8c', fontSize: 12 }}>
          {entries.some((e) => e.status === 'pending') ? '工具调用中…' : '折叠显示'}
        </div>
      )}
    </Card>
  )
}
```

> **Why MessageBubble here, not getRenderer?** Agent.tsx already routes tool rendering through MessageBubble which uses the `getRenderer(...).renderFull` (or preview/renderInput/renderOutput) path — see `toolRenderers/types.ts:ToolRenderer`. Reusing MessageBubble guarantees byte-identical rendering with the expanded view; reimplementing the toolRenderers dispatch is out of scope and would risk regressions.

- [ ] **Step 3: Typecheck**

Run: `cd packages/zai && pnpm typecheck`
Expected: no errors.

- [ ] **Step 4: Commit**

```bash
cd /Users/ethan/code/opencc-web
git add packages/zai/src/web/src/components/transcript/CollapsedMessageBubble.tsx packages/zai/src/web/src/components/transcript/ToolGroupCard.tsx
git commit -m "feat(transcript): add CollapsedMessageBubble and ToolGroupCard components"
```

> **Ordering note:** Task 4 depends on Task 3 (`MessageBubble` import), so Task 3 must land before Task 4 executes.

---

### Task 5: `MessageListView` — collapsed/expanded router

**Files:**
- Create: `packages/zai/src/web/src/components/transcript/MessageListView.tsx`

**Interfaces:**
- Consumes: `useAgentStore` (subscribes to `messages` and `transcriptCollapsed`), `<MessageBubble>` from `./MessageBubble`, `<CollapsedMessageBubble>` and `<ToolGroupCard>` from this directory, `deriveTranscriptNodes` from `./deriveTranscriptNodes`
- Produces:
  ```ts
  export function MessageListView(props: {
    messages: AgentMessage[]
    streaming?: boolean
  }): JSX.Element
  ```

- [ ] **Step 1: Write `MessageListView.tsx`**

Create `packages/zai/src/web/src/components/transcript/MessageListView.tsx`:

```tsx
import { useMemo } from 'react'
import { useAgentStore, type AgentMessage } from '../../store/useAgentStore.js'
import { MessageBubble } from './MessageBubble.js'
import { CollapsedMessageBubble } from './CollapsedMessageBubble.js'
import { ToolGroupCard } from './ToolGroupCard.js'
import { deriveTranscriptNodes } from './deriveTranscriptNodes.js'

interface Props {
  messages: AgentMessage[]
  streaming?: boolean
}

export function MessageListView({ messages, streaming }: Props) {
  const collapsed = useAgentStore((s) => s.transcriptCollapsed)

  if (!collapsed) {
    // expanded: byte-identical to the original Agent.tsx map.
    return (
      <>
        {messages.map((msg, idx) => {
          const t = msg.type as string
          const toolUseId = t.startsWith('tool_use:')
            ? (msg as any).toolUseId
            : undefined
          const reactKey =
            (toolUseId ? `tool-${toolUseId}` : (msg as any).eventId) || String(idx)
          return (
            <MessageBubble
              key={reactKey}
              msg={msg}
              streaming={streaming && idx === messages.length - 1}
            />
          )
        })}
      </>
    )
  }

  // collapsed: derive nodes, fall back to expanded on any derive error.
  let nodes
  try {
    nodes = deriveTranscriptNodes(messages)
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error('deriveTranscriptNodes failed; falling back to expanded view', err)
    return (
      <>
        {messages.map((msg, idx) => (
          <MessageBubble key={(msg as any).eventId || String(idx)} msg={msg} streaming={false} />
        ))}
      </>
    )
  }

  return (
    <>
      {nodes.map((node, i) => {
        if (node.kind === 'toolGroup') {
          // group key spans its indices so streaming updates don't churn keys
          return (
            <ToolGroupCard
              key={`grp-${node.startIndex}-${node.endIndex}-${i}`}
              entries={node.toolCalls}
            />
          )
        }
        if (node.kind === 'thinking') {
          // Thinking in collapsed view: full render via CollapsedMessageBubble (no clamp).
          return (
            <CollapsedMessageBubble
              key={`think-${node.index}-${i}`}
              message={node.message}
            />
          )
        }
        if (node.kind === 'ask') {
          // AskUserQuestion must stay full-width; route through MessageBubble for parity.
          return (
            <MessageBubble
              key={`ask-${node.index}-${i}`}
              msg={node.message}
              streaming={false}
            />
          )
        }
        // text node: render each contained message through CollapsedMessageBubble (single-msg view)
        return (
          <div key={`txt-${node.startIndex}-${node.endIndex}-${i}`}>
            {node.messages.map((m, mi) => {
              const evtId = ((m as any).eventId as string) ?? `txt-${node.startIndex}-${mi}`
              return <CollapsedMessageBubble key={evtId} message={m} />
            })}
          </div>
        )
      })}
    </>
  )
}
```

- [ ] **Step 2: Typecheck**

Run: `cd packages/zai && pnpm typecheck`
Expected: no errors. If `useAgentStore` selectors complain, check whether `streaming` prop has a default — leave optional with `?` and call sites provide `false` when omitted.

- [ ] **Step 3: Commit**

```bash
cd /Users/ethan/code/opencc-web
git add packages/zai/src/web/src/components/transcript/MessageListView.tsx
git commit -m "feat(transcript): add MessageListView collapsed/expanded router"
```

---

### Task 6: Wire toggle button into Agent.tsx

**Files:**
- Modify: `packages/zai/src/web/src/pages/Agent.tsx`

**Interfaces:**
- Consumes: `useAgentStore` (already imported), `toggleTranscriptCollapsed` action (new), `transcriptCollapsed` field (new)
- Produces: a small AntD `<Button>` placed above the messages area, with icon/label that swap based on the boolean

- [ ] **Step 1: Locate the messages-render block and the `messageList` useMemo**

Find the block that currently contains `const messageList = useMemo(() => messages.map(...))` (currently around line 1092 in the file). Note the surrounding JSX so you know where the message list `<div>` wrapper sits in the JSX tree.

- [ ] **Step 2: Add the toggle button above the messages list**

Just before the `{messageList}` (or wherever the JSX renders the messages array), add a small toolbar row. **Do not move existing elements** — only insert. The exact JSX to add:

```tsx
<div style={{ display: 'flex', justifyContent: 'flex-end', marginBottom: 4 }}>
  <Button
    size="small"
    icon={transcriptCollapsed ? <CompressOutlined /> : <ExpandOutlined />}
    onClick={() => toggleTranscriptCollapsed()}
  >
    {transcriptCollapsed ? '展开 transcript' : '折叠 transcript'}
  </Button>
</div>
```

- [ ] **Step 3: Subscribe to the store fields inside the Agent component**

In the existing `useAgentStore(...)` selector block (already scattered throughout Agent.tsx around lines 1058-1090), add (just below any existing selector):

```tsx
  const transcriptCollapsed = useAgentStore((s) => s.transcriptCollapsed);
  const toggleTranscriptCollapsed = useAgentStore((s) => s.toggleTranscriptCollapsed);
```

- [ ] **Step 4: Add the AntD icon import**

Find the import block at the top of `Agent.tsx` (around line 1-60). Add if missing:

```tsx
import { CompressOutlined, ExpandOutlined } from "@ant-design/icons";
```

If `@ant-design/icons` is not currently imported in this file, search the codebase for prior use of AntD icons (`grep -r "@ant-design/icons" packages/zai/src/web/src/`) and follow the same import path style. If no prior icon use, run `cd packages/zai && pnpm typecheck` and resolve any missing-package errors by following the existing icon import convention.

- [ ] **Step 5: Run typecheck and lint**

Run: `cd packages/zai && pnpm typecheck && pnpm lint 2>/dev/null || pnpm eslint packages/zai/src/web/src/pages/Agent.tsx`
Expected: no errors.

- [ ] **Step 6: Commit**

```bash
cd /Users/ethan/code/opencc-web
git add packages/zai/src/web/src/pages/Agent.tsx
git commit -m "feat(transcript): add collapse toggle button to Agent.tsx"
```

---

### Task 7: Replace inline `messageList` with `<MessageListView>` in Agent.tsx

**Files:**
- Modify: `packages/zai/src/web/src/pages/Agent.tsx`

**Interfaces:**
- Consumes: `<MessageListView>` (new, accepts `messages` + `streaming` props)
- Produces: the JSX that previously rendered `{messageList}` now renders `<MessageListView messages={messages} streaming={status === 'streaming'} />`

- [ ] **Step 1: Locate the `messageList` declaration and usage**

Find `const messageList = useMemo(...)` (line ~1092 today) and the JSX that renders `{messageList}`. The useMemo returns a fragment of `<MessageBubble>` elements keyed by `tool-${toolUseId}` / `eventId` / index.

- [ ] **Step 2: Replace the useMemo with a direct call**

Delete the entire `const messageList = useMemo(...)` declaration. In the JSX (where `{messageList}` is rendered), replace with:

```tsx
<MessageListView
  messages={messages}
  streaming={status === 'streaming'}
/>
```

Do **not** wrap in a fragment if the surrounding JSX already provides one.

- [ ] **Step 3: Add the import**

In the imports block at the top of Agent.tsx, add:

```tsx
import MessageListView from "../components/transcript/MessageListView";
```

If MessageBubble's import was modified by Task 6 (it was — it now imports the extracted file), the existing `import { MessageBubble } from "../components/transcript/MessageBubble"` line should already be present — leave it (it's still used by `<MessageListView>` internally).

- [ ] **Step 4: Run the full test + typecheck suite**

Run:
```bash
cd packages/zai && pnpm test deriveTranscriptNodes
cd packages/zai && pnpm typecheck
```

Expected: 9 vitest cases pass, typecheck clean.

- [ ] **Step 5: Smoke — boot dev server, verify both states**

```bash
cd packages/zai && pnpm dev
```

- Open the URL.
- Send a prompt that triggers ≥ 5 tool calls (e.g. `find packages/zai/src/web/src/components -type f | head -20`).
- Confirm the **expanded view** (default) looks visually identical to a fresh checkout before this plan ran.
- Click the toggle button. Confirm the transcript switches to the collapsed view, with `ToolGroupCard`s merged for consecutive tools. Click again — back to expanded.
- Reload the page. Confirm `transcriptCollapsed` resets to `false` (expanded).

Stop the server with Ctrl-C.

- [ ] **Step 6: Commit**

```bash
cd /Users/ethan/code/opencc-web
git add packages/zai/src/web/src/pages/Agent.tsx
git commit -m "refactor(transcript): replace inline messageList with MessageListView"
```

---

### Task 8: Final verification — full test suite + grep regression + coverage check

**Files:** (no code changes expected; verification only)

- [ ] **Step 1: Run the full vitest suite**

Run: `cd packages/zai && pnpm test`
Expected: every test passes — including the new 9 in `deriveTranscriptNodes.test.ts`, and pre-existing `useAgentStore-loadTranscript`, `eventStream-dispatch`, `diff`, `toolRenderers/*`. No flaky timers; no `.skip`s left behind.

- [ ] **Step 2: Coverage check on the new pure function**

Run: `cd packages/zai && pnpm test:coverage -- deriveTranscriptNodes`
Expected: 100% lines, 100% branches for `deriveTranscriptNodes.ts` (it's pure and the 9 cases exercise every branch).

- [ ] **Step 3: Regression grep — ensure no reference to old inline `MessageBubble` survives outside its new file**

```bash
grep -nE "const MessageBubble|function MessageBubble" packages/zai/src/web/src/pages/Agent.tsx
```
Expected: no matches. The grep above should only find the import line, not any declaration.

- [ ] **Step 4: Typecheck + lint full repo**

```bash
cd packages/zai && pnpm typecheck && (pnpm lint 2>/dev/null || pnpm eslint packages/zai/src/web/src)
```
Expected: clean. If lint flags unused imports introduced by intermediate tasks, fix them as part of this task.

- [ ] **Step 5: Commit any fixups (if needed)**

If step 3 or 4 surfaced issues, fix them in the relevant file (no code in this task should be authored — this is verification only). Commit:
```bash
git add -A packages/zai/src/web/src
git commit -m "chore(transcript): post-implementation cleanups (lint + unused imports)"
```
Skip this step if Step 1-4 are all clean.

- [ ] **Step 6: Final summary commit referencing the spec**

```bash
git commit --allow-empty -m "chore(transcript): plan 2026-07-20-zai-transcript-collapse complete (8 tasks)"
```

---

## Self-Review (run after writing this plan)

- **Spec coverage:** §2.1/2.2 → Task 1, 5. §2.3 → Task 1. §2.4 → Tasks 1, 3, 4, 5. §2.5 → Task 2. §3.1 → Task 1. §3.2 → Task 5. §3.3 → Task 4. §3.4 → Task 4. §3.5 → Task 3. §4.1 / 4.2 → Task 5, 6, 7. §4.3 → Task 1 (group-boundary rule) + Task 5 (fallback). §5 streaming → Task 1 case 6 + Task 4 ToolGroupCard pending. §5 AskUserQuestion → Task 1 case 9 + Task 5 `kind:'ask'` route. §5 compact_boundary → Task 1 case 8. §5 toggle semantics → Task 2. §5.2 button position → Task 6. §6 error handling → Task 5 try/catch + Task 1 unknown-type fallthrough. §7.1 tests → Task 1. §7.5 verification → Task 8. §8.1 8 tasks → all tasks 1-8.
- **No gaps.** Every spec section maps to ≥1 task.
- **Type consistency:** `TranscriptNode` defined Task 1. `ToolGroupCard` consumes `ToolGroupEntry` from Task 1 (re-import). `MessageListView` imports both from `./deriveTranscriptNodes.js`. `<MessageBubble>` props unchanged from Agent.tsx — same `{ msg, streaming }`.
- **Placeholder scan:** No TBD / TODO / "implement later". All code is shown verbatim.
- **Naming consistency:** `transcriptCollapsed` used identically everywhere (spec §1.3, §2.5, §5.1; Task 2; Task 6; Task 7 smoke). `toggleTranscriptCollapsed` identical. `deriveTranscriptNodes` identical. `MessageListView` identical. `ToolGroupCard` identical. `CollapsedMessageBubble` identical.
- **`renderContent` extraction:** Spec §3.5 said "抽出原 `renderContent` from Agent.tsx". The current Agent.tsx has `MessageBubble = React.memo(function…)` already separate; the function body INCLUDES renderContent inline. Task 3 keeps it as-is to avoid breaking the swipe typing. The pure-function/tool-group/clamp changes don't touch renderContent, which means expanded view (collapsed=false) renders byte-identical content. ✅
