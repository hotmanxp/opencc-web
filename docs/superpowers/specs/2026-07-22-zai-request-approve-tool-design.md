# RequestApprove Tool — Design Spec

**Status**: implemented (filePath-only mode)
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
- `schema.ts` — zod input schema (filePath-only), output schema, types.
- `RequestApproveTool.ts` — `LegacyTool<any, string>` implementation.

### 2.1 Input schema (zod)

```ts
const RequestApproveInput = z.strictObject({
  title: z.string().min(1).max(120),
  summary: z.string().max(300).optional(),
  filePath: z.string().min(1).max(1024),
})
```

- filePath is an **absolute path** (unix `/...` or windows `C:\...` / `C:/...`); the server route resolves it literally without anchoring to the session cwd. Callers are responsible for supplying a path the reviewer can actually see — workspace-boundary enforcement moved out of the route and onto the calling agent (typically via sandbox / file-tool policy).
- filePath length capped at 1024 chars.
- The drawer fetches the document body via `/api/agent/approve/file` when it mounts; SSE only carries the path so traffic stays flat regardless of document size and the reviewer always sees the freshest content (the AI may keep editing the file between approve_pending and submit).

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

Pass filePath as the relative path to the document in the workspace (e.g.
"docs/plan.md"). Use inline markdown for short documents (≤ a few thousand
words) by writing them to a temp file first. Do NOT use this tool for short
clarifying questions (use AskUserQuestion instead).
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
  filePath: string
}) => Promise<{ decision: 'approved' | 'rejected'; comment?: string }>
```

This mirrors the existing `awaitAskUserQuestion` (toolExecution.ts:128). The runtime populates this with a closure capturing the approveRegistry and the current toolUseId each time a `RequestApprove` tool_use is dispatched, then clears it after tool.call returns.

### 3.2 `toolExecution.ts`

`packages/zai-agent-core/src/runtime/toolExecution.ts` adds a branch (parallel to the existing `ASK_USER_QUESTION_TOOL_NAME` branch at line 239). The tool's runtime echoes the filePath through a `tool_use:approve_pending` event so the SSE payload stays small and the drawer can fetch lazily.

```ts
if (tool.name === REQUEST_APPROVE_TOOL_NAME) {
  if (!approveRegistry) {
    const msg = 'approveRegistry not configured: cannot await RequestApprove decisions'
    yield buildEvent('tool_use:error', { toolUseId: block.id, error: msg })
    results[index] = { toolUseId: block.id, content: `error: ${msg}`, isError: true }
    for (const sub of drainSubQueue()) yield sub
    continue
  }
  const approveInput = parsed.data as RequestApproveInputType
  yield buildEvent('tool_use:approve_pending', {
    toolUseId: block.id,
    title: approveInput.title,
    ...(approveInput.summary ? { summary: approveInput.summary } : {}),
    filePath: approveInput.filePath,
  })
  bridgedCtx.awaitApprove = async (_req) => {
    return approveRegistry!.register(block.id, meta.sessionId, approveInput.filePath, ctx.abortSignal)
  }
  ;(bridgedCtx as any).__toolUseId = block.id
}
```

The `output` shape is what the model eventually sees in transcript — i.e. `{decision, comment?}` JSON. We use `tool_use:done` (not `tool_use:error`) because a rejection is a *successful* business outcome, not a tool failure. The `comment` field is included only when present (omit on approve with no comment; always present on reject, since reject *requires* a comment).

### 3.3 Concurrency note

`ApproveRegistry` already supports parallel `register` calls keyed by `toolUseId`. Multiple parallel `RequestApprove` calls in one assistant turn each get a separate pending promise / drawer tab.

---

## 4. Server registry & routes

### 4.1 `services/approveRegistry.ts`

```ts
type Pending = {
  resolve: (d: { decision: 'approved' | 'rejected'; comment?: string }) => void
  reject: (e: Error) => void
  toolUseId: string
  sessionId: string
  filePath: string
}

export class ApproveRegistry {
  private pending = new Map<string, Pending>()

  register(toolUseId, sessionId, filePath, abortSignal): Promise<{ decision, comment? }>
  peek(toolUseId): Pending | undefined                     // defense-in-depth for sid mismatch
  getFilePath(toolUseId): string | undefined               // for the /file GET handler
  answer(toolUseId, payload: { decision, comment? }): boolean
  reject(toolUseId, reason = 'user_rejected'): boolean
  abortAll(reason = 'session_aborted'): void
}
```

`abortAll` rejects with `Error('session_aborted')` — same convention as `AskRegistry`. Called from `routes/agent.ts` (the disconnect handler).

### 4.2 `routes/approve.ts`

Four routes, mounted at `/api/agent/approve{,/reject,/file}`:

**`POST /api/agent/approve`** — primary submission
```ts
Request = { toolUseId: string, decision: 'approved' | 'rejected', comment?: string }
Response:
  200 → { ok: true }
  400 → { error: 'invalid_body' }          // zod failed (incl. missing comment on reject)
  404 → { error: 'no_pending_review' }     // toolUseId not in registry
  409 → { error: 'session_mismatch' }      // X-Session-Id mismatch defense
```

**`POST /api/agent/approve/reject`** — convenience alias. Same as Answer's reject alias.

**`GET /api/agent/approve/file?toolUseId=...&sessionId=...`** — fetch the document body. Looked up by toolUseId against the registry (the registry stores the filePath). The endpoint is a sealed channel: it's only useful to a reader who already has a valid toolUseId for an in-flight approval. We never trust `?filePath=` directly.

```ts
Response:
  200 → { toolUseId, filePath, content, bytes }
  400 → { error: 'missing_toolUseId' }
  403 → { error: 'session_mismatch' }     // claimed sid doesn't match the registry entry
  404 → { error: 'no_pending_review' }    // already answered / timed out / unknown id
  404 → { error: 'file_unreadable' }
  413 → { error: 'file_too_large', max: 200_000, actual }
  415 → { error: 'binary_file' }          // not valid utf-8
```

The path is the absolute path the agent submitted; the route resolves it literally (`path.resolve(filePath)`) without anchoring to the session cwd. Workspace-boundary enforcement is the agent's responsibility (typically via sandbox / file-tool policy), not this route's.

### 4.3 `services/agentRuntime.ts`

- New `const approveRegistry = new ApproveRegistry()` (singleton).
- `getApproveRegistry(): ApproveRegistry` exported.
- `initAgentRuntime` injection unchanged shape.

### 4.4 `server/index.ts`

- After `initAgentRuntime()`: mount `/api/agent/approve` router.
- The route gets the registry via `(req as any)._approveRegistry = getApproveRegistry()` (parallel to the existing askRegistry injection).
- `client_disconnect` handler in `routes/agent.ts` calls `approveRegistry.abortAll('client_disconnect')` *in addition to* `askRegistry.abortAll(...)`.

---

## 5. SSE event

### 5.1 `shared/events.ts`

Add to the `ServerEvent` discriminated union (`PromptEvent`):

```ts
| {
    type: 'prompt.approve'
    sessionId: string
    toolUseId: string
    title: string
    summary?: string
    filePath: string           // drawer fetches body via /api/agent/approve/file
  }
```

The drawer always receives `filePath` populated; the body is fetched on demand. The shape matches the `RequestApproveInput.filePath` exactly, so the front end can re-use one TypeScript type.

### 5.2 `translateRuntimeEvents`

`routes/agent.ts` translates a `tool_use:approve_pending` upstream event into the `prompt.approve` SSE event (parallel to how `tool_use:ask_pending` becomes `prompt.ask`).

### 5.3 `applyPromptApprove` (zustand)

`packages/zai/src/web/src/store/useAgentStore.ts` gains:
- `pendingApprove: { toolUseId, sessionId, title, summary?, filePath, content, fetchStatus, fetchError?, decision?, comment, status }` (parallel to `pendingAsk`).
- `applyPromptApprove(event)` reducer; sets `fetchStatus: 'loading'` initially.
- A single `submitApprove({decision, comment?})` action — used by both Approve and Reject buttons.
- `setApproveFetchResult(toolUseId, result)` reducer — drawer fires this when the `GET /api/agent/approve/file` resolves.
- `clearPendingApprove(toolUseId)` for `tool_use:done` clearing.

`upsertToolCall` in the store gets a new line: when the runtime event for this `toolUseId` is `tool_use:done` / `:error`, also call `clearPendingApprove(toolUseId)`.

---

## 6. UI — ApproveDrawer

`packages/zai/src/web/src/components/ApproveDrawer.tsx` (new).

### 6.1 Layout

Right-side AntD `Drawer` (`placement="right"`, `width="min(720px, 50vw)"`, `open={!!pendingApprove}`, `destroyOnClose={false}` so comment-state survives temporary closes).

```
┌─────────────────────────────────────────────┐
│  [×]  TITLE                                 │
│       summary (one-liner)                   │
│       "Loaded from docs/plan.md"            │
├─────────────────────────────────────────────┤
│  ◐ Loading document...                       │  ← fetchStatus: 'loading' (Spin + text)
│  ─ OR ─                                      │
│  <MarkdownText content />                  │  ← fetchStatus: 'ready'
│  ─ OR ─                                      │
│  ⚠ Could not load document: ...            │  ← fetchStatus: 'error' (footer still
│                                              works; AI gets the decision without
│                                              the body)
├─────────────────────────────────────────────┤
│  Comment (optional on Approve, required on Reject)
│  ┌─────────────────────────────────────┐    │
│  │ <TextArea maxLength=2000>           │    │
│  └─────────────────────────────────────┘    │
│            [Reject]   [Approve]             │
└─────────────────────────────────────────────┘
```

The drawer mounts a `useEffect` on `pending?.toolUseId + fetchStatus='loading'`; that effect fetches `/api/agent/approve/file` and dispatches `setApproveFetchResult`. The MarkdownText component is the same one used inside chat bubbles (`components/markdown/MarkdownText.tsx`).

### 6.2 Buttons

- **Reject** (danger style): requires confirmation `Popconfirm` *unless* the comment textarea is non-empty (then the comment is the rejection feedback). Clicking calls `submitApprove('rejected')` — comment required (zod enforces it server-side too; the front end client-side validates before sending).
- **Approve** (primary): direct. Calls `submitApprove('approved')` where `comment` may be empty.

Both buttons disabled while `status === 'submitting'`.

### 6.3 Close behavior

- Clicking `[×]` / mask / `Escape` does **not** auto-reject. `pendingApprove` remains in the store.
- A small persistent indicator (badge in `ConfigStatusBar` or `BottomStatusBar`) shows "1 pending review".
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
| filePath not relative (or absolute) | zod input refinement rejects at tool-call time → `tool_use:invalid` before the agent loop blocks. |
| File missing / binary / >200 KB | `tool_use:invalid` with reason from the GET endpoint. AI sees "RequestApprove failed: file X" and can try a different path. |
| Reject with empty comment | Front end disables Reject button until comment ≥ 1 char; server-side zod catches bypass. |
| Backend timeout (2h HARD_TIMEOUT) | Existing `/agent/prompt` timeout — propagates as `runtime.aborted`. `pendingApprove` cleared client-side in the `runtime.aborted` reducer. |
| SSE disconnect mid-review | Front end shows drawer in `status:'disconnected'`. On reconnect, drawer re-fetches via `loadPendingApprove(sessionId)` (a small new endpoint that returns the in-flight approve state from `ApproveRegistry.peek` filtered by sessionId). |
| Cross-sid answer (race) | `X-Session-Id` check in routes/approve.ts, returns 409 → front end shows inline error and refetches `pendingApprove` for the correct sid. |
| User closes drawer mid-session | Defer (see §6.3). |
| HARD_TIMEOUT aborts the agent mid-Promise | Same path as `AskRegistry.abortAll` ('session_aborted'). The AI sees a tool error and can retry. |

---

## 8. Testing

### 8.1 Unit (zai-agent-core)

- `tools/RequestApproveTool/RequestApproveTool.test.ts`
  - Schema validation: rejects unix + windows absolute paths; rejects empty title; rejects filePath > 1024 chars.
  - Tool call resolves with `{decision:'approved', comment:undefined}` after `ctx.awaitApprove` resolves with `{decision:'approved'}`.
  - Tool call resolves with `{decision:'rejected', comment:'fix X'}` after `ctx.awaitApprove` resolves with reject.
  - `isReadOnly` / `isConcurrencySafe` true.
  - The `awaitApprove` shim receives `title` / `summary` / `filePath` matching the input.

- `services/approveRegistry.test.ts` (mirror of `askRegistry.test.ts`)
  - register / answer / reject / abortAll / concurrent / sid-mismatch.
  - `getFilePath` returns the path supplied at register time; cleared after answer / reject.

### 8.2 Unit (zai)

- `routes/approve.test.ts`
  - POST happy path (approved with comment, approved without, rejected).
  - 400 invalid_body (comment missing on reject).
  - 404 unknown toolUseId.
  - 409 sid mismatch.
  - POST /approve/reject alias.
  - GET /approve/file happy path (writes file to temp dir, asserts content + bytes).
  - GET /approve/file missing-toolUseId → 400.
  - GET /approve/file unknown toolUseId → 404.
  - GET /approve/file sid mismatch → 403.
  - GET /approve/file path traversal (`../../etc/passwd`) → 403.

### 8.3 Front end

- `components/ApproveDrawer.test.tsx`
  - Renders title, summary, filePath label.
  - Loading state shows Spin + "Loading document...".
  - Error state shows danger banner; footer (Approve / Reject) still enabled.
  - Reject button disabled when comment empty; enabled when comment ≥ 1 char.
  - Approve always enabled.
  - Click Approve → calls `submitApprove('approved')`.
  - Click Reject with comment → calls `submitApprove('rejected')`.
  - Close button does NOT submit.
- `store/useAgentStore.test.ts` extensions
  - `applyPromptApprove` sets `pendingApprove` with `filePath` and `fetchStatus: 'loading'`.
  - `setApproveFetchResult` flows content into `pendingApprove.content`.
  - `submitApprove` POSTs and clears state on success.
  - `submitApprove` 404 → `status:'error'`, `errorMessage` set.
  - `clearPendingApprove` is called on `tool_use:done` for matching `toolUseId`.

### 8.4 Integration (zai-agent-core test/integration)

End-to-end (mirrors `auto-compact-turn-loop.test.ts`):

```
test('RequestApprove blocks loop and resumes on user decision', async () => {
  const loop = startQueryLoop(...)
  await loop.assumeSession()
  // user prompt: "write a plan for X"
  waitFor(() => pendingApprove !== null)
  expect(pendingApprove.filePath).toBe('docs/plan.md')
  submitApprove({decision:'approved', comment:'looks good'})
  waitFor(() => loop.status === 'idle')
  expect(loop.transcriptLastToolResult).toMatchObject({decision:'approved'})
})
```

---

## 9. Files Touched

| Layer | File | Change |
|-------|------|--------|
| Tool | `packages/zai-agent-core/src/tools/RequestApproveTool/{prompt,schema,RequestApproveTool}.ts` | UPDATED — schema reduced to `{title, summary?, filePath}`; resolved body deletion |
| Tool test | `packages/zai-agent-core/test/tools/RequestApproveTool/RequestApproveTool.test.ts` | UPDATED |
| Runtime | `packages/zai-agent-core/src/tools/Tool.ts` | `awaitApprove` typed to `AwaitApproveInput` (no body) |
| Runtime | `packages/zai-agent-core/src/runtime/toolExecution.ts` | New branch for `REQUEST_APPROVE_TOOL_NAME`; yields `filePath` only |
| Runtime | `packages/zai-agent-core/src/runtime/types.ts` | `ApproveRegistryLike.register` adds `filePath` |
| Runtime tests | `packages/zai-agent-core/test/runtime/queryLoop-request-approve.test.ts` | UPDATED |
| Integration | `packages/zai-agent-core/test/integration/agent/request-approve-turn-loop.test.ts` | UPDATED |
| Mock | `packages/zai-agent-core/test/fixtures/MockModelCaller.ts` | request-approve scenario emits `filePath` |
| Server | `packages/zai/src/server/services/approveRegistry.ts` | `Pending.filePath` added; `getFilePath` API |
| Server test | `packages/zai/src/server/services/approveRegistry.test.ts` | UPDATED + add `getFilePath` tests |
| Server | `packages/zai/src/server/routes/approve.ts` | UPDATED + new `GET /agent/approve/file` |
| Routes test | `packages/zai/src/server/routes/approve.test.ts` | UPDATED + 7 new tests for `/file` |
| Server | `packages/zai/src/server/services/agentRuntime.ts` | `approveRegistry` cast to `ApproveRegistryLike` |
| Shared | `packages/zai/src/shared/events.ts` | `prompt.approve` schema reduced to `{filePath}` |
| Translator | `packages/zai/src/server/routes/agent.ts` | `tool_use:approve_pending` translator emits `filePath` |
| Web store | `packages/zai/src/web/src/store/useAgentStore.ts` | `ApproveState.filePath` + `setApproveFetchResult` |
| Web component | `packages/zai/src/web/src/components/ApproveDrawer.tsx` | New — fetch effect + loading / error states |

Total: 2 modified files (schema, registered types), 5 new / rewritten test files, 1 new GET route, 1 new server-side reducer, 1 new front-end component, 1 updated spec. Net diff is mostly additive and bounded.

---

## 10. Out of Scope (follow-up specs)

- Generalize `AskRegistry` + `ApproveRegistry` into a single `PendingDecisionRegistry` (Approach C). Clean long-term, but a refactor of well-tested code — separate plan.
- PR-style anchored line comments (selection-captured markdown review). Different feature, much higher UI complexity, separate spec.
- Streaming the markdown into the drawer (lock+rewrite, replace). Today the tool resolves the full body before SSE. Streaming requires a two-phase protocol the AskUserQuestion tool doesn't have.
- Caching reviewer decisions across sessions (e.g. "approve all plans titled X" rule). Premature.
- Adding the same tool to sub-agents. Decision deferred until we see whether sub-agents in BackgroundRuntime need gated reviews.
- Embedding the body bytes inline for offline / no-HTTP scenarios. Today's always-fetched approach assumes the web shell is connected.
