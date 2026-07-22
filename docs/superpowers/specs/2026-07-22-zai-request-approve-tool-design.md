# RequestApprove Tool — Design Spec

**Status**: draft
**Date**: 2026-07-22
**Owners**: zai team
**Scope**: new tool `RequestApprove` for zai that blocks the agent loop until a human reviewer reads a markdown document (plan / spec / design / proposal / etc.) and either approves it or rejects it with feedback.

---

## 1. Problem

zai is repeatedly used to generate **plans, specs, and design docs** that the human must read and approve before implementation begins. Today the only mechanism is `AskUserQuestion`, which is structurally wrong:

- `AskUserQuestion` is designed for *short* multi-choice questions rendered as a chip-style card. It cannot render a multi-thousand-word markdown document.
- There is no notion of "approve" / "reject" semantics in `AskUserQuestion` — only "pick option A/B/C/D" + an optional per-question `notes` field.
- The reviewer cannot see formatting, code blocks, tables, headings, etc. — all of which are essential for reviewing plans.

We want a dedicated tool whose UI is **a right-side drawer** that:
1. Renders a markdown document (`react-markdown` + `remark-gfm`, the existing `MarkdownText` component already in zai).
2. Shows three actions: **Approve**, **Reject**, **Comment** (one optional overall comment, not PR-style anchored).
3. Blocks the agent loop on the user's decision (same semantics as `AskUserQuestion`'s pending-Promise) so the AI only proceeds after the user explicitly signs off.

Non-goals:
- Multi-threaded PR-style review with anchored comments. (Out of scope for v1.)
- Auto-approve / auto-reject heuristics on close. (Drawer close = defer.)
- Streaming markdown to the drawer. (Resolved to full content before SSE emission.)
- Replacing `permissionMode='plan'` (which restricts which *tools* the agent may invoke). `RequestApprove` is for *content* review, not tool-permission review.

---

## 2. Tool Contract

New directory `packages/zai-agent-core/src/tools/RequestApproveTool/`. Three files mirroring `AskUserQuestionTool/`:

- `prompt.ts` — `REQUEST_APPROVE_TOOL_NAME = 'RequestApprove'`, `DESCRIPTION`, `REQUEST_APPROVE_TOOL_PROMPT`.
- `schema.ts` — zod input schema, output schema, types.
- `RequestApproveTool.ts` — `LegacyTool<any, string>` implementation.

### 2.1 Input schema (zod)

```ts
const RequestApproveInput = z.strictObject({
  title: z.string().min(1).max(120),
  summary: z.string().max(300).optional(),
  body: z.discriminatedUnion('kind', [
    z.object({ kind: z.literal('inline'), content: z.string().min(1).max(200_000) }),
    z.object({ kind: z.literal('file'),   path:    z.string().min(1) }),
  ]),
}).refine(
  (d) => d.body.kind === 'inline' || !d.body.path.startsWith('/'),
  { message: 'file path must be relative to the session cwd', path: ['body', 'path'] },
)
```

- Inline content hard-capped at **200 KB** (~50k tokens). Anything larger must use `kind: 'file'`.
- File path is **relative to the session cwd** (same convention as the existing `Read` tool).
- `summary` is an optional one-liner (≤300 chars) shown above the rendered markdown in the drawer header. It is *not* a substitute for `title` and renders as a sub-header.

### 2.2 Output schema (zod)

```ts
const RequestApproveOutput = z.discriminatedUnion('decision', [
  z.object({ decision: z.literal('approved'), comment: z.string().max(2000).optional() }),
  z.object({ decision: z.literal('rejected'), comment: z.string().min(1).max(2000) }),
])
```

Comment **required** on reject (prevents the AI from getting a useless "rejected" signal with no actionable guidance). Comment optional on approve (for marginal notes / explicit sign-off reasoning that lands in the transcript).

### 2.3 `isReadOnly` / `isConcurrencySafe`

- `isReadOnly: () => true` (no side effects beyond blocking the loop).
- `isConcurrencySafe: () => true` (parallel calls are safe; the registry keeps them keyed by `toolUseId`).

### 2.4 Tool prompt (for system-prompt injection)

```
Use this tool to gate the agent loop on a human review of a document you've
produced (plan, spec, design doc, proposal, RFC, contract, etc.). The user
will see the document rendered as markdown in a right-side drawer with three
controls: Approve, Reject (with required comment), and an optional overall
comment.

Use inline markdown for short documents (≤ a few thousand words). For long
specs, write the document to a workspace file first (using the Write tool)
and pass `body.kind: 'file'` with the relative path. Do NOT use this tool
for short clarifying questions (use AskUserQuestion instead).
```

---

## 3. Runtime Wiring (zai-agent-core)

### 3.1 `toolContext`

`packages/zai-agent-core/src/tools/Tool.ts` gains a new field on the `ToolContext` injected during execution:

```ts
awaitApprove: (req: {
  toolUseId: string
  title: string
  summary?: string
  body: { kind: 'inline', content: string } | { kind: 'file', displayPath: string, content: string }
}) => Promise<{ decision: 'approved' | 'rejected'; comment?: string }>
```

This mirrors the existing `awaitAskUserQuestion` (toolExecution.ts:128).

The runtime pre-resolves `body`:
- `kind: 'inline'` → passed through unchanged.
- `kind: 'file'` → server-side reads the file (via the existing `Read` tool's path-resolution code) and substitutes the body's `content` with the file's UTF-8 text. The original `path` is preserved as `displayPath` so the drawer can show "Loaded from `<path>`".

If the file is missing / unreadable / too large (>200 KB) / binary → the tool yields `tool_use:invalid` (same shape as `AskUserQuestion`'s invalid path).

### 3.2 `toolExecution.ts`

`packages/zai-agent-core/src/runtime/toolExecution.ts` adds a branch (parallel to the existing `ASK_USER_QUESTION_TOOL_NAME` branch at line 239).

The tool's runtime produces a **resolved body** in a single canonical shape:

```ts
type ResolvedBody =
  | { kind: 'inline'; displayPath: null;  content: string }
  | { kind: 'file';   displayPath: string; content: string }
```

```ts
if (tool.name === REQUEST_APPROVE_TOOL_NAME) {
  const resolved: ResolvedBody = input.body.kind === 'file'
    ? { kind: 'file',
        displayPath: input.body.path,
        content: await resolveFileBody(input.body.path, { maxBytes: 200_000 }) }
    : { kind: 'inline',
        displayPath: null,
        content: input.body.content }

  yield {
    type: 'tool_use:approve_pending',
    toolUseId,
    sessionId,
    title: input.title,
    summary: input.summary,
    body: resolved,
  }

  const decision = await bridgedCtx.awaitApprove({ toolUseId, title, summary, body: resolved })

  yield {
    type: 'tool_use:done',
    toolUseId,
    name: REQUEST_APPROVE_TOOL_NAME,
    input,
    output: {
      decision: decision.decision,
      ...(decision.comment !== undefined ? { comment: decision.comment } : {}),
    },
  }
}
```

The `output` shape is what the model eventually sees in transcript — i.e. `{decision, comment?}` JSON. We use `tool_use:done` (not `tool_use:error`) because a rejection is a *successful* business outcome, not a tool failure. The `comment` field is included only when present (omit on approve with no comment; always present on reject, since reject *requires* a comment).

### 3.3 Concurrency note

`AskRegistry` already supports parallel `register` calls keyed by `toolUseId`. The new `ApproveRegistry` inherits the same semantics — multiple parallel `RequestApprove` calls in one assistant turn each get a separate pending promise / drawer tab.

---

## 4. Server registry & routes

### 4.1 `services/approveRegistry.ts`

```ts
type Pending = {
  resolve: (d: { decision: 'approved' | 'rejected'; comment?: string }) => void
  reject: (e: Error) => void
  toolUseId: string
  sessionId: string
  title: string
}

export class ApproveRegistry {
  private pending = new Map<string, Pending>()

  register(toolUseId, sessionId, title, abortSignal): Promise<...>  // same shape as AskRegistry
  peek(toolUseId): Pending | undefined                                // defense-in-depth for sid mismatch
  answer(toolUseId, payload: { decision, comment? }): boolean         // resolves the promise
  reject(toolUseId, reason = 'user_rejected'): boolean                // explicit rejection (alias for clarity)
  abortAll(reason = 'session_aborted'): void
}
```

`abortAll` rejects with `Error('session_aborted')` — same convention as `AskRegistry`. Called from `routes/agent.ts:394` (the existing disconnect handler).

### 4.2 `routes/approve.ts`

Two routes, mounted at `/api/agent/approve` and `/api/agent/approve/reject`:

**`POST /api/agent/approve`** — primary submission
```ts
Request = { toolUseId: string, decision: 'approved' | 'rejected', comment?: string }
Response:
  200 → { ok: true }
  400 → { error: 'invalid_body' }          // zod failed (incl. missing comment on reject)
  404 → { error: 'no_pending_review' }     // toolUseId not in registry (TTL passed / wrong session)
  409 → { error: 'session_mismatch' }      // X-Session-Id mismatch defense (parallel to answer.ts)
```

**`POST /api/agent/approve/reject`** — convenience alias (parallel to `/api/agent/answer/reject`). Body: `{ toolUseId, comment, reason? }`. Returns `{ ok: true }` or the same 404/409.

### 4.3 `services/agentRuntime.ts`

- New `const approveRegistry = new ApproveRegistry()` (singleton, alongside `askRegistry`).
- `getApproveRegistry(): ApproveRegistry` exported.
- `initAgentRuntime` injection unchanged shape.

### 4.4 `server/index.ts`

- After `initAgentRuntime()`: mount `/api/agent/approve` router.
- The route gets the registry via `(req as any)._approveRegistry = getApproveRegistry()` (parallel to the existing askRegistry injection at line 108).
- `client_disconnect` handler in `routes/agent.ts:394` calls `approveRegistry.abortAll('client_disconnect')` *in addition to* `askRegistry.abortAll(...)`.

---

## 5. SSE event

### 5.1 `shared/events.ts`

Add to the `ServerEvent` discriminated union:

```ts
| {
    type: 'prompt.approve'
    sessionId: string
    toolUseId: string
    title: string
    summary?: string
    body: {
      kind: 'inline'
      displayPath: null                       // no source path for inline content
      content: string                         // resolved server-side
    } | {
      kind: 'file'
      displayPath: string                     // e.g. "./docs/plan.md"
      content: string                         // resolved server-side
    }
  }
```

The drawer always receives `content` populated. We do not lazily fetch files from the client because the workspace file system lives server-side and exposing `?path=` to the client opens a read-any-file-as-SSE-stream attack vector. The shape matches the `ResolvedBody` produced in §3.2 exactly so the front end can share one TypeScript alias for both.

### 5.2 `translateRuntimeEvents`

The existing translator in `routes/agent.ts` converts a `tool_use:approve_pending` upstream event into the `prompt.approve` SSE event (parallel to how `tool_use:ask_pending` becomes `prompt.ask`).

### 5.3 `applyPromptApprove` (zustand)

`packages/zai/src/web/src/store/useAgentStore.ts` gains:
- New `pendingApprove: { toolUseId, sessionId, title, summary?, content, displayPath?, decision?, comment?, status }` slice (parallel to `pendingAsk`).
- `applyPromptApprove(event)` reducer (parallel to `applyPromptAsk`).
- A single `submitApprove({decision: 'approved' | 'rejected', comment?: string})` action — used by **both** Approve and Reject buttons in the drawer. It POSTs to `/api/agent/approve` with the chosen decision. (The `/api/agent/approve/reject` alias route is server-side only; the front end always uses the primary endpoint.)
- `clearPendingApprove(toolUseId)` for `tool_use:done` clearing (same hook as the `pendingAsk` clear in `upsertToolCall`).

`upsertToolCall` in the store gets a new line: when the runtime event for this `toolUseId` is `tool_use:done` / `:error`, also call `clearPendingApprove(toolUseId)`.

---

## 6. UI — ApproveDrawer

`packages/zai/src/web/src/components/ApproveDrawer.tsx` (new).

### 6.1 Layout

Right-side AntD `Drawer` (`placement="right"`, `width="min(720px, 50vw)"`, `open={!!pendingApprove}`, `destroyOnClose={false}` so comment-state survives temporary closes).

```
┌─────────────────────────────────────────────┐
│  [×]  TITLE                       [Optional: ✕ close] │
│       summary (one-liner)                   │
├─────────────────────────────────────────────┤
│                                          ▲ │
│   <MarkdownText content />               │ │
│                                          │ │  ← scroll area, flex:1
│                                          │ │
│                                          ▼ │
├─────────────────────────────────────────────┤
│  Comment (optional overall feedback)       │
│  ┌─────────────────────────────────────┐    │
│  │ <TextArea maxLength=2000>           │    │
│  └─────────────────────────────────────┘    │
│            [Reject]   [Approve]             │  ← footer (sticky)
└─────────────────────────────────────────────┘
```

The drawer uses the existing `MarkdownText` component (`components/markdown/MarkdownText.tsx`) — same renderer used inside chat bubbles, full `react-markdown` + `remark-gfm` + Prism syntax highlighting. No new markdown deps.

### 6.2 Buttons

- **Reject** (danger style): requires confirmation `Popconfirm` *unless* the comment textarea is non-empty (then the comment is the rejection feedback). Clicking calls `submitApprove({decision:'rejected', comment})` — comment required (zod enforces it server-side too; the front end client-side validates before sending).
- **Approve** (primary): direct. Calls `submitApprove({decision:'approved', comment})` where `comment` may be empty.

Both buttons disabled while `status === 'submitting'`.

### 6.3 Close behavior

- Clicking `[×]` / mask / `Escape` does **not** auto-reject. `pendingApprove` remains in the store.
- A small persistent indicator (zuzhang-like badge in `ConfigStatusBar` or a `Badge` on a review icon in the sidebar) shows "1 pending review".
- Re-opening — clicking the indicator or visiting the session afresh — re-opens the drawer with state preserved.
- The agent loop remains blocked on the registry promise until the user explicitly picks Approve / Reject.

### 6.4 Mounted

`Agent.tsx` adds `<ApproveDrawer />` next to `<TaskDrawer />` and `<SettingsDrawer />`. Read from `useAgentStore.pendingApprove`. No props needed.

### 6.5 Pending review badge

`ConfigStatusBar.tsx` (or a new `PendingReviewDot` in `BottomStatusBar`) shows a clickable bell icon with a `Badge` count of `1` when `pendingApprove !== null`. Click → opens drawer.

---

## 7. Error handling

| Scenario | Behavior |
|----------|----------|
| File missing / binary / >200 KB | Tool emits `tool_use:invalid` with reason. AI sees "RequestApprove failed: file unreadable" and can try `kind:'inline'` instead. |
| Inline body >200 KB | Same as above at the schema level (zod refinement). |
| Title / summary empty | Same (zod). |
| Reject with empty comment | Front end disables Reject button until comment ≥ 1 char; server-side zod catches bypass. |
| Backend timeout (2h HARD_TIMEOUT) | Existing `/agent/prompt` timeout — propagates as `runtime.aborted`. `pendingApprove` cleared client-side in the `runtime.aborted` reducer. |
| SSE disconnect mid-review | Front end shows drawer in `status:'disconnected'`. On reconnect, drawer re-fetches via `loadPendingApprove(sessionId)` (a small new endpoint that returns the in-flight approve state from `ApproveRegistry.peek` filtered by sessionId). |
| Cross-sid answer (race) | X-Session-Id check in routes/approve.ts, returns 409 → front end shows inline error and refetches `pendingApprove` for the correct sid. |
| User closes drawer mid-session | Defer (see §6.3). |
| HARD_TIMEOUT aborts the agent mid-Promise | Same path as `AskRegistry.abortAll` ('session_aborted'). The AI sees a tool error and can retry. |

---

## 8. Testing

### 8.1 Unit (zai-agent-core)

- `tools/RequestApproveTool/RequestApproveTool.test.ts`
  - Schema validation: rejects inline + file mixed; rejects absolute paths; comment required on reject.
  - Tool call resolves with `{decision:'approved', comment:undefined}` after `ctx.awaitApprove` resolves with `{decision:'approved'}`.
  - Tool call resolves with `{decision:'rejected', comment:'fix X'}` after `ctx.awaitApprove` resolves with reject.
  - `isReadOnly` / `isConcurrencySafe` true.

- `services/approveRegistry.test.ts` (mirror of `askRegistry.test.ts`)
  - register / answer / reject / abortAll / concurrent / sid-mismatch.
- `routes/approve.test.ts`
  - 200 happy path (approved with comment, approved without, rejected).
  - 400 invalid_body (comment missing on reject).
  - 404 unknown toolUseId.
  - 409 sid mismatch.
  - Approve rejects with comment → `comment` length > 2000 → 400.

### 8.2 Front end

- `components/ApproveDrawer.test.tsx`
  - Renders title, summary, markdown body.
  - Reject button disabled when comment empty; enabled when comment ≥ 1 char.
  - Approve always enabled.
  - Click Approve → calls `submitApprove({decision:'approved', comment})`.
  - Click Reject with comment → calls `submitApprove({decision:'rejected', comment})`.
  - Close button does NOT submit.
- `store/useAgentStore.test.ts` extensions
  - `applyPromptApprove` sets `pendingApprove` correctly.
  - `submitApprove` POSTs and clears state on success.
  - `submitApprove` 404 → `status:'error'`, `errorMessage` set.
  - `clearPendingApprove` is called on `tool_use:done` for matching `toolUseId`.

### 8.3 Integration (zai-agent-core test/integration)

End-to-end (mirrors `auto-compact-turn-loop.test.ts`):

```
test('RequestApprove blocks loop and resumes on user decision', async () => {
  const loop = startQueryLoop(...)
  await loop.assumeSession()
  // user prompt: "write a plan for X"
  waitFor(() => pendingApprove !== null)
  expect(markdownIncludes('Plan for X'))
  submitApprove({decision:'approved', comment:'looks good'})
  waitFor(() => loop.status === 'idle')
  expect(loop.transcriptLastToolResult).toMatchObject({decision:'approved'})
})
```

---

## 9. Files Touched

| Layer | File | Change |
|-------|------|--------|
| Tool | `packages/zai-agent-core/src/tools/RequestApproveTool/{prompt,schema,RequestApproveTool}.ts` | NEW |
| Tool test | `packages/zai-agent-core/src/tools/RequestApproveTool/RequestApproveTool.test.ts` | NEW |
| Runtime | `packages/zai-agent-core/src/tools/Tool.ts` | Add `awaitApprove` to `ToolContext` |
| Runtime | `packages/zai-agent-core/src/runtime/toolExecution.ts` | New branch for `REQUEST_APPROVE_TOOL_NAME` |
| Server | `packages/zai/src/server/services/approveRegistry.ts` | NEW |
| Server test | `packages/zai/src/server/services/approveRegistry.test.ts` | NEW |
| Server | `packages/zai/src/server/services/agentRuntime.ts` | Add `getApproveRegistry` |
| Server | `packages/zai/src/server/routes/approve.ts` | NEW router |
| Server | `packages/zai/src/server/index.ts` | Mount `/api/agent/approve` |
| Server | `packages/zai/src/server/routes/agent.ts` | Call `approveRegistry.abortAll('client_disconnect')` in disconnect handler; translate `tool_use:approve_pending` → `prompt.approve` |
| Routes test | `packages/zai/src/server/routes/approve.test.ts` | NEW |
| Shared | `packages/zai/src/shared/events.ts` | Add `prompt.approve` to discriminated union |
| Web store | `packages/zai/src/web/src/store/useAgentStore.ts` | Add `pendingApprove`, `applyPromptApprove`, `submitApprove`, `clearPendingApprove`; clear in `upsertToolCall` on `tool_use:done` |
| Web store test | `packages/zai/src/web/src/store/useAgentStore.test.ts` | Add apply/submit/clear tests |
| Web component | `packages/zai/src/web/src/components/ApproveDrawer.tsx` | NEW |
| Web component test | `packages/zai/src/web/src/components/ApproveDrawer.test.tsx` | NEW |
| Web page | `packages/zai/src/web/src/pages/Agent.tsx` | Mount `<ApproveDrawer />` |
| Web indicator | `packages/zai/src/web/src/components/ConfigStatusBar.tsx` (or new) | Pending-review Badge |
| Integration | `packages/zai-agent-core/test/integration/agent/request-approve-turn-loop.test.ts` | NEW |

Total: 8 new files, 6-7 modified files. Net diff is mostly additive and bounded.

---

## 10. Out of Scope (follow-up specs)

- Generalize `AskRegistry` + `ApproveRegistry` into a single `PendingDecisionRegistry` (Approach C). Clean long-term, but a refactor of well-tested code — separate plan.
- PR-style anchored line comments (selection-captured markdown review). Different feature, much higher UI complexity, separate spec.
- Streaming the markdown into the drawer (lock+rewrite, replace). Today the tool resolves the full body before SSE. Streaming requires a two-phase protocol the AskUserQuestion tool doesn't have.
- Caching reviewer decisions across sessions (e.g. "approve all plans titled X" rule). Premature.
- Adding the same tool to sub-agents. Decision deferred until we see whether sub-agents in BackgroundRuntime need gated reviews.
