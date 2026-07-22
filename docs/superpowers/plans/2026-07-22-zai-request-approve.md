# RequestApprove Tool Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a `RequestApprove` tool to zai that blocks the agent loop on human review of a markdown document (plan, spec, design, etc.) and resumes once the user clicks Approve or Reject (+ optional comment) in a new right-side drawer.

**Architecture:** Mirror the existing `AskUserQuestion` end-to-end. A new `RequestApproveTool` in `zai-agent-core` yields `tool_use:approve_pending` while the runtime awaits a server-side `ApproveRegistry` promise. The server registers that promise in a sibling to `AskRegistry`, then exposes `POST /api/agent/approve` to resolve it. The front-end receives a new SSE event `prompt.approve`, stores pending state in a new `pendingApprove` zustand slice, and renders `<ApproveDrawer>` using the existing `MarkdownText` component and AntD `Drawer`.

**Tech Stack:** zai-agent-core (vitest + zod), zai server (Express + zod), React + AntD + zustand on the web side, `react-markdown` + `remark-gfm` (already in use). No new dependencies.

**Spec:** `docs/superpowers/specs/2026-07-22-zai-request-approve-tool-design.md`

---

## Global Constraints

These apply to every task. Pulled verbatim from the spec — do not relax.

- Inline body hard-cap: **200 KB** (`max(200_000)` in zod).
- File path requirement: relative to session cwd, **must not** start with `/`.
- Title length: `1..120`. Summary length: `≤ 300`. Comment length: `1..2000` on reject; `0..2000` (optional) on approve.
- Approve comment is optional; **reject comment is required** (zod discriminated union enforces it).
- Server resolves file bodies server-side before SSE; the drawer must receive `content` always populated.
- 409 on `X-Session-Id` mismatch (defense-in-depth, parallel to `routes/answer.ts`).
- HARD_TIMEOUT unchanged (2h, per AGENTS.md known weak points).
- Drawer close does NOT auto-reject; state preserves across closes.
- Front-end always uses the primary `POST /api/agent/approve` endpoint (the `/reject` alias is server-side only).
- `tool_use:done` (not `:error`) for both approve and reject — they are valid business outcomes.

## File Structure

**New files (11):**
| Path | Responsibility |
|---|---|
| `packages/zai-agent-core/src/tools/RequestApproveTool/prompt.ts` | Tool name, description, system-prompt snippet |
| `packages/zai-agent-core/src/tools/RequestApproveTool/schema.ts` | zod input/output schemas, types |
| `packages/zai-agent-core/src/tools/RequestApproveTool/RequestApproveTool.ts` | `LegacyTool` impl — calls `ctx.awaitApprove` |
| `packages/zai-agent-core/test/tools/RequestApproveTool/RequestApproveTool.test.ts` | Unit tests for the tool |
| `packages/zai/src/server/services/approveRegistry.ts` | In-memory `ApproveRegistry` (mirror of `askRegistry.ts`) |
| `packages/zai/src/server/services/approveRegistry.test.ts` | Registry unit tests |
| `packages/zai/src/server/routes/approve.ts` | `POST /api/agent/approve` + `/reject` router |
| `packages/zai/src/server/routes/approve.test.ts` | Router tests |
| `packages/zai/src/web/src/components/ApproveDrawer.tsx` | AntD drawer + MarkdownText + Reject/Approve buttons |
| `packages/zai/src/web/src/components/ApproveDrawer.test.tsx` | Component tests |
| `packages/zai-agent-core/test/integration/agent/request-approve-turn-loop.test.ts` | E2E loop integration test |

**Modified files (15):**

| Path | Change |
|---|---|
| `packages/zai-agent-core/src/tools/Tool.ts` | Add `awaitApprove` to `LegacyToolContext` |
| `packages/zai-agent-core/src/runtime/types.ts` | Add `ApproveRegistryLike` type, add `approveRegistry?` to `RuntimeConfig` |
| `packages/zai-agent-core/src/runtime/toolExecution.ts` | New branch for `REQUEST_APPROVE_TOOL_NAME`, plumb `awaitApprove` bridge, accept `approveRegistry` |
| `packages/zai-agent-core/src/runtime/queryEngine.ts` | Add `approveRegistry` throw-placeholder to `makeToolContext`, pass through `executeToolsStreaming` |
| `packages/zai-agent-core/src/runtime/index.ts` | Export new types |
| `packages/zai-agent-core/src/index.ts` | Export the new tool's name constant + factory |
| `packages/zai/src/shared/events.ts` | Add `prompt.approve` to `PromptEvent` discriminated union |
| `packages/zai/src/server/services/agentRuntime.ts` | Export `getApproveRegistry()` singleton, wire into `initAgentRuntime` |
| `packages/zai/src/server/index.ts` | Mount `approveRouter`, plumb `_approveRegistry` like `_askRegistry` |
| `packages/zai/src/server/routes/agent.ts` | Translate `tool_use:approve_pending` → `prompt.approve`; call `approveRegistry.abortAll` in disconnect handler |
| `packages/zai/src/web/src/store/useAgentStore.ts` | Add `pendingApprove`, `applyPromptApprove`, `submitApprove`, `clearPendingApprove` |
| `packages/zai/src/web/src/store/useAgentStore.test.ts` | Add reducer/action tests |
| `packages/zai/src/web/src/store/useEventStream.ts` | Dispatch `prompt.approve` |
| `packages/zai/src/web/src/pages/Agent.tsx` | Mount `<ApproveDrawer />` |
| `packages/zai/src/web/src/pages/Agent.test.tsx` | Verify drawer mounts with pending state |

---

## Task 1: RequestApproveTool prompt constants

**Files:**
- Create: `packages/zai-agent-core/src/tools/RequestApproveTool/prompt.ts`

**Interfaces:** None — pure constants.

- [ ] **Step 1: Write the file**

```ts
// Mirror of AskUserQuestionTool/prompt.ts. These constants are the single
// source of truth for the tool name + description injected into the system
// prompt. The runtime resolves the tool by name, so changing this string is
// a breaking change for any model that has already tool-call-trained on it.

export const REQUEST_APPROVE_TOOL_NAME = 'RequestApprove'

export const DESCRIPTION = `Use this tool to gate the agent loop on a human review of a document you've produced (plan, spec, design doc, proposal, RFC, contract, etc.). The user will see the document rendered as markdown in a right-side drawer with three controls: Approve, Reject (with required comment), and an optional overall comment.`

export const REQUEST_APPROVE_TOOL_PROMPT = `Use this tool to gate the agent loop on a human review of a document you've produced (plan, spec, design doc, proposal, RFC, contract, etc.). The user will see the document rendered as markdown in a right-side drawer with three controls: Approve, Reject (with required comment), and an optional overall comment.

Use inline markdown for short documents (≤ a few thousand words). For long specs, write the document to a workspace file first (using the Write tool) and pass body.kind: 'file' with the relative path. Do NOT use this tool for short clarifying questions (use AskUserQuestion instead).`
```

- [ ] **Step 2: Verify the file compiles**

Run: `cd packages/zai-agent-core && npx tsc -b --noEmit`
Expected: no errors.

- [ ] **Step 3: Commit**

```bash
git add packages/zai-agent-core/src/tools/RequestApproveTool/prompt.ts
git commit -m "feat(core): add RequestApproveTool prompt constants"
```

---

## Task 2: RequestApproveTool zod schema

**Files:**
- Create: `packages/zai-agent-core/src/tools/RequestApproveTool/schema.ts`

**Interfaces:**
- Consumes: `REQUEST_APPROVE_TOOL_CHIP_WIDTH` constant style (not needed here; only AskUserQuestion uses chips).
- Produces: `RequestApproveInput` (zod input schema), `RequestApproveOutput` (zod output schema), `RequestApproveBody` (the discriminated union the AI sends), `RequestApproveDecision` type.

- [ ] **Step 1: Write the file**

```ts
import { z } from 'zod'

// 200KB hard cap on inline content. ~50k tokens is the practical maximum
// we want to allow through the SSE pipeline; anything larger should use the
// `file` variant and write the document to disk first.
const INLINE_BODY_MAX = 200_000
const TITLE_MAX = 120
const SUMMARY_MAX = 300
const COMMENT_MAX = 2000

// The body the AI submits. Discriminated by `kind`. Exactly one variant must
// be present per the runtime's parseAndExecute flow.
export const RequestApproveBody = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('inline'),
    content: z.string().min(1).max(INLINE_BODY_MAX),
  }),
  z.object({
    kind: z.literal('file'),
    // Path is relative to the session cwd. The runtime validates that this
    // doesn't start with '/' (an absolute path would escape the workspace).
    path: z.string().min(1),
  }),
])
export type RequestApproveBody = z.infer<typeof RequestApproveBody>

export const RequestApproveInput = z.strictObject({
  title: z.string().min(1).max(TITLE_MAX),
  summary: z.string().max(SUMMARY_MAX).optional(),
  body: RequestApproveBody,
}).refine(
  // File paths must be relative to the session cwd. Absolute paths are
  // rejected because they escape the workspace boundary that the runtime
  // already maintains for Read/Write.
  (d) => d.body.kind === 'inline' || !d.body.path.startsWith('/'),
  { message: 'file path must be relative to the session cwd', path: ['body', 'path'] },
)
export type RequestApproveInput = z.infer<typeof RequestApproveInput>

// Output is what the model sees in transcript after the user decides.
// - approve is unconditional; comment is optional (user may want to add
//   marginal notes, "looks good", etc.).
// - reject REQUIRES a non-empty comment. This is a hard product rule:
//   a reject-with-no-context is useless to the AI.
export const RequestApproveOutput = z.discriminatedUnion('decision', [
  z.object({
    decision: z.literal('approved'),
    comment: z.string().max(COMMENT_MAX).optional(),
  }),
  z.object({
    decision: z.literal('rejected'),
    comment: z.string().min(1).max(COMMENT_MAX),
  }),
])
export type RequestApproveOutput = z.infer<typeof RequestApproveOutput>

export type RequestApproveDecision = 'approved' | 'rejected'

// The shape the runtime resolves into before passing to the registry. The
// SSE event uses the same canonical shape — see shared/events.ts.
export type ResolvedBody =
  | { kind: 'inline'; displayPath: null;  content: string }
  | { kind: 'file';   displayPath: string; content: string }
```

- [ ] **Step 2: Verify it compiles**

Run: `cd packages/zai-agent-core && npx tsc -b --noEmit`
Expected: no errors.

- [ ] **Step 3: Commit**

```bash
git add packages/zai-agent-core/src/tools/RequestApproveTool/schema.ts
git commit -m "feat(core): add RequestApproveTool schema"
```

---

## Task 3: RequestApproveTool implementation

**Files:**
- Create: `packages/zai-agent-core/src/tools/RequestApproveTool/RequestApproveTool.ts`

**Interfaces:**
- Consumes: schema types from Task 2, `LegacyToolContext` from `../Tool.js`, prompts from Task 1.
- Produces: `RequestApproveTool: LegacyTool<any, string>` whose `call()` resolves the registry awaitApprove promise and serializes its result.

- [ ] **Step 1: Write the file**

```ts
import type { LegacyTool, LegacyToolContext } from '../Tool.js'
import type { z } from 'zod'
import { inputSchema, outputSchema, type RequestApproveOutput } from './schema.js'
import { REQUEST_APPROVE_TOOL_NAME, DESCRIPTION, REQUEST_APPROVE_TOOL_PROMPT } from './prompt.js'

// Re-export for system-prompt injection symmetry with AskUserQuestion.
export { REQUEST_APPROVE_TOOL_NAME, DESCRIPTION, REQUEST_APPROVE_TOOL_PROMPT }

export interface AwaitApproveInput {
  toolUseId: string
  title: string
  summary?: string
  body: import('./schema.js').ResolvedBody
}

export interface AwaitApproveResult {
  decision: 'approved' | 'rejected'
  comment?: string
}

export const RequestApproveTool: LegacyTool<any, string> = {
  name: REQUEST_APPROVE_TOOL_NAME,
  description: DESCRIPTION,
  inputSchema,

  // No filesystem side effects from the tool itself — file reading is done
  // by toolExecution.ts before this body is called. The tool simply awaits
  // the user.
  isReadOnly: () => true,

  // Parallel calls are safe: each is keyed by its own toolUseId via
  // the registry. The runtime serializes events, but two parallel
  // RequestApprove calls in one assistant turn each get their own drawer.
  isConcurrencySafe: () => true,

  async call(rawInput: any, ctx: LegacyToolContext): Promise<{ output: string; isError?: boolean }> {
    // The runtime supplies the resolved body (file path → file content) and
    // attaches it to ctx elsewhere; this entry point expects to be invoked
    // AFTER toolExecution.ts has already done the resolve. The input here
    // is the original AI input for transcript fidelity.
    const input = rawInput as z.infer<typeof inputSchema>

    const awaitApprove = (ctx as any).awaitApprove as
      | ((req: AwaitApproveInput) => Promise<AwaitApproveResult>)
      | undefined
    if (typeof awaitApprove !== 'function') {
      throw new Error('awaitApprove not available on tool context — runtime misconfigured')
    }

    // toolExecution.ts yields approve_pending with the resolved body in the
    // event stream; here we trust that the body has been resolved before
    // this call. We rebuild the AwaitApproveInput from rawInput since the
    // resolved body is stashed separately by the runtime — see the
    // toolExecution branch in Task 7.
    //
    // The runtime attaches the resolved body onto ctx for this call:
    const resolved = (ctx as any).__resolvedApproveBody as AwaitApproveInput['body']
    if (!resolved) {
      throw new Error('resolved body missing on tool context — runtime must attach it before calling this tool')
    }

    const result = await awaitApprove({
      toolUseId: (ctx as any).__toolUseId ?? 'unknown',
      title: input.title,
      ...(input.summary ? { summary: input.summary } : {}),
      body: resolved,
    })

    // Serialize to JSON string for transcript. The output schema enforces
    // shape; the runtime's TypeScript narrowing here is just for clarity.
    const output: RequestApproveOutput = result.comment !== undefined
      ? { decision: result.decision, comment: result.comment }
      : { decision: result.decision }

    const parsed = outputSchema.safeParse(output)
    if (!parsed.success) {
      // The runtime/registry should never give us output that violates our
      // own schema (the registry uses outputSchema as its contract surface).
      // Defensive throw so we get a clear stack trace instead of corrupt data.
      throw new Error(`invalid approve output: ${parsed.error.message}`)
    }

    return { output: JSON.stringify(parsed.data) }
  },
}
```

- [ ] **Step 2: Verify it compiles**

Run: `cd packages/zai-agent-core && npx tsc -b --noEmit`
Expected: no errors. There may be one warning about `inputSchema` typing — that's the same shape AskUserQuestionTool has and is intentional.

- [ ] **Step 3: Commit**

```bash
git add packages/zai-agent-core/src/tools/RequestApproveTool/RequestApproveTool.ts
git commit -m "feat(core): add RequestApproveTool implementation"
```

---

## Task 4: Extend LegacyToolContext and Tool.ts to carry `awaitApprove`

**Files:**
- Modify: `packages/zai-agent-core/src/tools/Tool.ts` (extend `LegacyToolContext`)

**Interfaces:**
- Consumes: `AwaitApproveInput`, `AwaitApproveResult` exported from Task 3.
- Produces: `awaitApprove` field on `LegacyToolContext` (optional, runtime fills it in).

- [ ] **Step 1: Read the current LegacyToolContext**

Confirm lines 36-56 contain the type definition. Then proceed to step 2.

- [ ] **Step 2: Extend the LegacyToolContext type**

Replace the `awaitAskUserQuestion: ...` block in `LegacyToolContext` with the addition below. Insert **after** the `awaitAskUserQuestion` field:

```ts
import type { AwaitApproveInput, AwaitApproveResult } from './RequestApproveTool/RequestApproveTool.js'

// ...inside LegacyToolContext type:
  awaitAskUserQuestion: (req: unknown) => Promise<{
    answers: Record<string, string>
    annotations?: Record<string, { notes?: string; preview?: string }>
  }>
  /**
   * Parallel of awaitAskUserQuestion, used by RequestApproveTool. The
   * runtime populates this with a closure capturing the approveRegistry
   * and the current toolUseId each time a `RequestApprove` tool_use is
   * dispatched, then clears it after tool.call returns.
   */
  awaitApprove?: (req: AwaitApproveInput) => Promise<AwaitApproveResult>
  /**
   * The runtime attaches the resolved body (file path → file content) onto
   * the context before invoking RequestApproveTool.call so the tool does
   * not need to re-resolve the file.
   */
  __resolvedApproveBody?: import('./RequestApproveTool/schema.js').ResolvedBody
  /** The current tool_use block id (set by toolExecution for RequestApprove). */
  __toolUseId?: string
```

- [ ] **Step 3: Verify it compiles**

Run: `cd packages/zai-agent-core && npx tsc -b --noEmit`
Expected: no errors. `awaitApprove` is optional, so existing tools don't need to change.

- [ ] **Step 4: Commit**

```bash
git add packages/zai-agent-core/src/tools/Tool.ts
git commit -m "feat(core): extend LegacyToolContext with awaitApprove"
```

---

## Task 5: RequestApproveTool unit tests

**Files:**
- Create: `packages/zai-agent-core/test/tools/RequestApproveTool/RequestApproveTool.test.ts`
- (Directory may not exist yet — create it.)

**Interfaces:**
- Consumes: types from `../Tool.js`, `RequestApproveTool` + `AwaitApproveInput/Result` from Task 3.

- [ ] **Step 1: Create the test directory**

```bash
mkdir -p packages/zai-agent-core/test/tools/RequestApproveTool
```

- [ ] **Step 2: Write the failing test**

```ts
// packages/zai-agent-core/test/tools/RequestApproveTool/RequestApproveTool.test.ts
import { describe, expect, test, vi } from 'vitest'
import type { LegacyToolContext } from '../../../src/tools/Tool.js'
import { RequestApproveTool, type AwaitApproveInput, type AwaitApproveResult } from '../../../src/tools/RequestApproveTool/RequestApproveTool.js'

function makeCtx(overrides: Partial<LegacyToolContext> = {}): LegacyToolContext {
  return {
    cwd: '/tmp', env: {}, abortSignal: new AbortController().signal,
    dataDir: '/d', state: {},
    canUseTool: async () => ({ behavior: 'allow' as const }),
    emitEvent: () => {},
    awaitAskUserQuestion: async () => ({ answers: {} }),
    ...overrides,
  } as any
}

const inlineInput = {
  title: 'Plan for the foo feature',
  summary: 'Brief one-liner',
  body: { kind: 'inline' as const, content: '# Plan\n\nThis is the plan.' },
}

const fileInput = {
  title: 'Design doc',
  body: { kind: 'file' as const, path: 'docs/design.md' },
}

const inlineResolved = {
  kind: 'inline' as const,
  displayPath: null,
  content: '# Plan\n\nThis is the plan.',
}

describe('RequestApproveTool', () => {
  test('approved without comment → output { decision: "approved" }, no comment field', async () => {
    const awaitApprove = vi.fn(async (_req: AwaitApproveInput): Promise<AwaitApproveResult> => ({
      decision: 'approved',
    }))
    const ctx = makeCtx({
      awaitApprove,
      __resolvedApproveBody: inlineResolved,
      __toolUseId: 'tu-1',
    } as any)
    const out = await RequestApproveTool.call(inlineInput as any, ctx as any)
    expect(out.isError).toBeFalsy()
    const parsed = JSON.parse(out.output)
    expect(parsed.decision).toBe('approved')
    expect(parsed.comment).toBeUndefined()
    expect(awaitApprove).toHaveBeenCalledWith(expect.objectContaining({
      toolUseId: 'tu-1',
      title: 'Plan for the foo feature',
      summary: 'Brief one-liner',
      body: inlineResolved,
    }))
  })

  test('approved WITH comment → output { decision: "approved", comment }', async () => {
    const ctx = makeCtx({
      awaitApprove: async () => ({ decision: 'approved', comment: 'looks solid' }),
      __resolvedApproveBody: inlineResolved,
      __toolUseId: 'tu-2',
    } as any)
    const out = await RequestApproveTool.call(inlineInput as any, ctx as any)
    const parsed = JSON.parse(out.output)
    expect(parsed).toEqual({ decision: 'approved', comment: 'looks solid' })
  })

  test('rejected with comment → output { decision: "rejected", comment }', async () => {
    const ctx = makeCtx({
      awaitApprove: async () => ({ decision: 'rejected', comment: 'fix the API section' }),
      __resolvedApproveBody: inlineResolved,
      __toolUseId: 'tu-3',
    } as any)
    const out = await RequestApproveTool.call(inlineInput as any, ctx as any)
    const parsed = JSON.parse(out.output)
    expect(parsed).toEqual({ decision: 'rejected', comment: 'fix the API section' })
  })

  test('file variant passes through resolved body with displayPath', async () => {
    const fileResolved = {
      kind: 'file' as const,
      displayPath: 'docs/design.md',
      content: '# Design\n\n...resolved file content...',
    }
    const captured: AwaitApproveInput[] = []
    const ctx = makeCtx({
      awaitApprove: async (req) => {
        captured.push(req)
        return { decision: 'approved' }
      },
      __resolvedApproveBody: fileResolved,
      __toolUseId: 'tu-4',
    } as any)
    await RequestApproveTool.call(fileInput as any, ctx as any)
    expect(captured[0]!.body).toEqual(fileResolved)
    expect(captured[0]!.summary).toBeUndefined()
  })

  test('isReadOnly true', () => {
    expect(RequestApproveTool.isReadOnly!({} as any)).toBe(true)
  })

  test('isConcurrencySafe true', () => {
    expect(RequestApproveTool.isConcurrencySafe!({} as any)).toBe(true)
  })

  test('schema rejects absolute file path', () => {
    const r = RequestApproveTool.inputSchema.safeParse({
      title: 'x',
      body: { kind: 'file', path: '/absolute/path.md' },
    })
    expect(r.success).toBe(false)
  })

  test('schema rejects inline over 200_000 chars', () => {
    const big = 'x'.repeat(200_001)
    const r = RequestApproveTool.inputSchema.safeParse({
      title: 'x',
      body: { kind: 'inline', content: big },
    })
    expect(r.success).toBe(false)
  })

  test('schema rejects empty title', () => {
    const r = RequestApproveTool.inputSchema.safeParse({
      title: '',
      body: { kind: 'inline', content: '# x' },
    })
    expect(r.success).toBe(false)
  })

  test('propagates abort error from awaitApprove', async () => {
    const ctx = makeCtx({
      awaitApprove: async () => { throw new Error('aborted') },
      __resolvedApproveBody: inlineResolved,
      __toolUseId: 'tu-x',
    } as any)
    await expect(RequestApproveTool.call(inlineInput as any, ctx as any))
      .rejects.toThrow('aborted')
  })

  test('awaitApprove not available → throws clearly', async () => {
    const ctx = makeCtx({ awaitApprove: undefined, __resolvedApproveBody: inlineResolved } as any)
    await expect(RequestApproveTool.call(inlineInput as any, ctx as any))
      .rejects.toThrow('awaitApprove not available')
  })
})
```

- [ ] **Step 3: Run the tests — verify they fail**

Run: `cd packages/zai-agent-core && npx vitest run test/tools/RequestApproveTool/RequestApproveTool.test.ts`
Expected: each test fails because the implementation already exists from Task 3; if running them **before** Task 3, they fail with "Cannot find module" — the test-first discipline here is documenting the contract, not gating Tasks 1–4.

(If you do Task 5 before Task 3 — you're encouraged to — verify the failure is the expected `'Cannot find module'` / `require('./RequestApproveTool')` not-found error. If a test passes because the module doesn't exist, something is wrong.)

- [ ] **Step 4: Run after Task 3 lands — verify all pass**

Run: `cd packages/zai-agent-core && npx vitest run test/tools/RequestApproveTool/RequestApproveTool.test.ts`
Expected: 11 passing.

- [ ] **Step 5: Commit**

```bash
git add packages/zai-agent-core/test/tools/RequestApproveTool/
git commit -m "test(core): RequestApproveTool unit tests"
```

---

## Task 6: ApproveRegistryLike type + RuntimeConfig field

**Files:**
- Modify: `packages/zai-agent-core/src/runtime/types.ts`

**Interfaces:**
- Consumes: existing `AskRegistryLike` and `AskUserAnswers` (mirror).
- Produces: `ApproveRegistryLike` type; `approveRegistry?: ApproveRegistryLike` field on `RuntimeConfig`.

- [ ] **Step 1: Read the file context**

Confirm `AskRegistryLike` (lines 38-40) and `RuntimeConfig.askRegistry` (line 75). The new code goes right after each.

- [ ] **Step 2: Add `ApproveRegistryLike` after `AskRegistryLike`**

Insert immediately after the existing `export type AskRegistryLike = { ... }` block:

```ts
/**
 * The shape RequestApprove's runtime needs from a server-side approve
 * registry. Mirrors AskRegistryLike but for the approve/reject decision
 * payload. The host server is responsible for resolving promises when the
 * user submits a decision via the HTTP API.
 */
export type ApproveRegistryLike = {
  register: (
    toolUseId: string,
    sessionId: string,
    abortSignal: AbortSignal,
  ) => Promise<{
    decision: 'approved' | 'rejected'
    comment?: string
  }>
}
```

- [ ] **Step 3: Add `approveRegistry` to `RuntimeConfig`**

Insert immediately after `askRegistry?: AskRegistryLike`:

```ts
  /** RequestApprove's pending-decision table, server-side. Optional. */
  approveRegistry?: ApproveRegistryLike
```

- [ ] **Step 4: Verify it compiles**

Run: `cd packages/zai-agent-core && npx tsc -b --noEmit`
Expected: no errors.

- [ ] **Step 5: Commit**

```bash
git add packages/zai-agent-core/src/runtime/types.ts
git commit -m "feat(core): add ApproveRegistryLike + RuntimeConfig.approveRegistry"
```

---

## Task 7: Wire approve_branch into toolExecution + plumb awaitApprove bridge

**Files:**
- Modify: `packages/zai-agent-core/src/runtime/toolExecution.ts` (3 sub-edits)

**Interfaces:**
- Consumes: `REQUEST_APPROVE_TOOL_NAME` (Task 1), `RequestApproveInput` (Task 2), `ApproveRegistryLike` (Task 6).
- Produces: `executeToolsStreaming(blocks, ctx, tools, meta, askRegistry, approveRegistry)` accepting a new param; yielding `tool_use:approve_pending` and a `tool_use:done` carrying `{decision, comment?}` for the approve case.

- [ ] **Step 1: Update the imports**

Add to the existing import block (around line 13):

```ts
import { REQUEST_APPROVE_TOOL_NAME } from '../tools/RequestApproveTool/prompt.js'
import { RequestApproveInput as RequestApproveInputType, type ResolvedBody } from '../tools/RequestApproveTool/schema.js'
import type { ApproveRegistryLike } from './types.js'
```

- [ ] **Step 2: Add `approveRegistry?` parameter to `executeToolsStreaming`**

Find the signature at line 83-89:

```ts
export async function* executeToolsStreaming(
  blocks: ToolUseBlock[],
  ctx: ToolContext,
  tools: Tool[],
  meta: EventMeta,
  askRegistry?: AskRegistryLike,
): AsyncGenerator<RuntimeEvent, void, void> {
```

Replace with:

```ts
export async function* executeToolsStreaming(
  blocks: ToolUseBlock[],
  ctx: ToolContext,
  tools: Tool[],
  meta: EventMeta,
  askRegistry?: AskRegistryLike,
  approveRegistry?: ApproveRegistryLike,
): AsyncGenerator<RuntimeEvent, void, void> {
```

If the file `runStreamingFastPath` (referenced inside, possibly private) takes the same args, propagate the param through its signature too — find with:

```bash
grep -n "runStreamingFastPath" packages/zai-agent-core/src/runtime/toolExecution.ts
```

and add `approveRegistry?: ApproveRegistryLike` as the trailing param.

- [ ] **Step 3: Insert the RequestApprove branch — find AskUserQuestion branch**

Locate the existing branch (line 238 in the file we read in task setup):

```ts
    if (tool.name === ASK_USER_QUESTION_TOOL_NAME) {
      if (!askRegistry) { ... }
      ...
    }
```

Add an `else if` block IMMEDIATELY after it:

```ts
    else if (tool.name === REQUEST_APPROVE_TOOL_NAME) {
      // RequestApproveTool mirrors AskUserQuestion: yield the pending event
      // BEFORE awaiting the user, plumb the registry handle to bridgedCtx,
      // and let the tool body resolve on user submit. Tool's input shape:
      // { title, summary?, body: { kind, content | path } }.
      //
      // The file variant requires resolving the body server-side; we do it
      // here so the runtime is the source of truth and so the front end
      // never sees raw filesystem paths via SSE.
      if (!approveRegistry) {
        const msg = 'approveRegistry not configured: cannot await RequestApprove decisions'
        yield buildEvent('tool_use:error', { toolUseId: block.id, error: msg })
        results[index] = { toolUseId: block.id, content: `error: ${msg}`, isError: true }
        for (const sub of drainSubQueue()) yield sub
        continue
      }

      const approveInput = parsed.data as RequestApproveInputType
      let resolved: ResolvedBody
      try {
        resolved = approveInput.body.kind === 'file'
          ? await resolveFileBody(approveInput.body.path, { cwd: meta.cwd ?? ctx.cwd, maxBytes: 200_000 })
          : { kind: 'inline', displayPath: null, content: approveInput.body.content }
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e)
        yield buildEvent('tool_use:invalid', { toolUseId: block.id, error: `file unreadable: ${msg}` })
        results[index] = { toolUseId: block.id, content: `error: ${msg}`, isError: true }
        for (const sub of drainSubQueue()) yield sub
        continue
      }

      yield buildEvent('tool_use:approve_pending', {
        toolUseId: block.id,
        title: approveInput.title,
        ...(approveInput.summary ? { summary: approveInput.summary } : {}),
        body: resolved,
      })

      // Bridge: provide the registry promise + resolved body to the tool.
      // The tool body itself does very little besides await this promise
      // and serialize the decision.
      bridgedCtx.awaitApprove = async (_req) => {
        return approveRegistry!.register(block.id, meta.sessionId, ctx.abortSignal)
      }
      bridgedCtx.__resolvedApproveBody = resolved
      bridgedCtx.__toolUseId = block.id
    }
```

- [ ] **Step 4: Add the `resolveFileBody` helper at the top of the file (under imports)**

Insert AFTER `import` statements, before the existing `EventMeta` type. This is a thin wrapper around the existing `Read` machinery — for now it just does `readFile` + size check + utf-8 decode:

```ts
/**
 * Resolve a file path to its UTF-8 content for the approve drawer.
 * Mirrors the path-resolution semantics of the existing Read tool:
 * - Relative paths resolve against meta.cwd (session cwd).
 * - Absolute paths are forbidden by the tool schema (enforced upstream).
 * - Files larger than maxBytes or non-utf8 throw an Error that the
 *   runtime surfaces via `tool_use:invalid`.
 */
async function resolveFileBody(
  path: string,
  opts: { cwd: string; maxBytes: number },
): Promise<ResolvedBody> {
  const fs = await import('node:fs/promises')
  const nodePath = await import('node:path')
  const abs = nodePath.isAbsolute(path)
    ? path
    : nodePath.resolve(opts.cwd, path)
  const stat = await fs.stat(abs)
  if (stat.size > opts.maxBytes) {
    throw new Error(`file too large: ${stat.size} > ${opts.maxBytes}`)
  }
  const buf = await fs.readFile(abs)
  if (!buf.toString('utf8').length) {
    // Empty file — allow it but make display explicit
    return { kind: 'file', displayPath: path, content: '' }
  }
  // Decode strictly as utf-8. Buffer.toString('utf8') is loose; use TextDecoder
  // and check for fatal errors (binary files trigger an exception).
  const td = new TextDecoder('utf-8', { fatal: true })
  let content: string
  try {
    content = td.decode(buf)
  } catch {
    throw new Error('file is not valid utf-8 (binary?)')
  }
  return { kind: 'file', displayPath: path, content }
}
```

- [ ] **Step 5: Verify it compiles**

Run: `cd packages/zai-agent-core && npx tsc -b --noEmit`
Expected: no errors. The `awaitApprove` field on `LegacyToolContext` was added in Task 4 — that bridges to this.

- [ ] **Step 6: Run the existing toolExecution tests — must still pass**

Run: `cd packages/zai-agent-core && npx vitest run test/runtime/toolExecution.test.ts`
Expected: all existing tests pass. We added a parameter — no behavior change for AskUserQuestion.

- [ ] **Step 7: Commit**

```bash
git add packages/zai-agent-core/src/runtime/toolExecution.ts
git commit -m "feat(core): wire RequestApprove branch in toolExecution"
```

---

## Task 8: queryEngine passes approveRegistry through; new types exported

**Files:**
- Modify: `packages/zai-agent-core/src/runtime/queryEngine.ts` (one param)
- Modify: `packages/zai-agent-core/src/runtime/index.ts` (one export)
- Modify: `packages/zai-agent-core/src/index.ts` (one or two exports)

**Interfaces:**
- Consumes: `RuntimeConfig.approveRegistry` (Task 6).
- Produces: `executeToolsStreaming` getting `config.approveRegistry`.

- [ ] **Step 1: queryEngine — find the call site**

Search the file:

```bash
grep -n "executeToolsStreaming\|askRegistry" packages/zai-agent-core/src/runtime/queryEngine.ts
```

You'll see a single call to `executeToolsStreaming(...)` near line 324 that passes `, config.askRegistry))`.

- [ ] **Step 2: Pass approveRegistry**

Replace `, config.askRegistry))` with:

```ts
    , config.askRegistry
    , config.approveRegistry
    ))
```

(matching indent of the existing line — exact whitespace matters less than `config.askRegistry` and `config.approveRegistry` both flowing through.)

- [ ] **Step 3: Re-export `ApproveRegistryLike` from runtime/index.ts**

In `packages/zai-agent-core/src/runtime/index.ts`, find:

```ts
export type { RuntimeConfig, QueryOptions, ModelCaller, AskRegistryLike, SandboxConfig } from './types.js'
```

Replace with:

```ts
export type { RuntimeConfig, QueryOptions, ModelCaller, AskRegistryLike, ApproveRegistryLike, SandboxConfig } from './types.js'
```

- [ ] **Step 4: Re-export from package root (zai-agent-core/src/index.ts)**

Find the existing block that re-exports `AskUserQuestionTool` (similar pattern) and add a `RequestApproveTool` re-export near it. If a barrel re-export block exists, follow the same style. Minimal form:

```ts
export { RequestApproveTool } from './tools/RequestApproveTool/RequestApproveTool.js'
export { REQUEST_APPROVE_TOOL_NAME } from './tools/RequestApproveTool/prompt.js'
export type { RequestApproveInput, RequestApproveOutput, RequestApproveBody, ResolvedBody } from './tools/RequestApproveTool/schema.js'
```

(Adjust naming if the codebase uses a different alias convention.)

- [ ] **Step 5: Verify it compiles**

Run: `cd packages/zai-agent-core && npx tsc -b --noEmit`
Expected: no errors.

- [ ] **Step 6: Run the existing queryEngine tests — must still pass**

Run: `cd packages/zai-agent-core && npx vitest run test/runtime/queryEngine.test.ts test/runtime/contract.test.ts`
Expected: all existing tests pass.

- [ ] **Step 7: Commit**

```bash
git add packages/zai-agent-core/src/runtime/queryEngine.ts packages/zai-agent-core/src/runtime/index.ts packages/zai-agent-core/src/index.ts
git commit -m "feat(core): queryEngine pass-through for approveRegistry + barrel exports"
```

---

## Task 9: ApproveRegistry on the server

**Files:**
- Create: `packages/zai/src/server/services/approveRegistry.ts`

**Interfaces:**
- Consumes: existing `AskRegistry` shape; all calls peer with it 1:1.
- Produces: `ApproveRegistry` class with `register / peek / answer / reject / abortAll`, plus a `Pending` type and a `listBySession` for SessionCwdBridge-style indicators (used in Task 14 later if needed).

- [ ] **Step 1: Write the file**

```ts
// services/approveRegistry.ts
// In-memory registry of pending RequestApprove decisions. Mirrors
// askRegistry.ts shape exactly so the runtime contract is symmetric.
//
// One Promise<{decision, comment?}> per toolUseId. The HTTP route
// /api/agent/approve resolves it; the runtime's bridged
// `ctx.awaitApprove` registers it; abortAll is called on session
// disconnect.

type PendingDecision = 'approved' | 'rejected'

type Pending = {
  resolve: (d: { decision: PendingDecision; comment?: string }) => void
  reject: (e: Error) => void
  toolUseId: string
  sessionId: string
  title: string
}

export class ApproveRegistry {
  private pending = new Map<string, Pending>()

  register(
    toolUseId: string,
    sessionId: string,
    title: string,
    abortSignal: AbortSignal,
  ): Promise<{ decision: PendingDecision; comment?: string }> {
    return new Promise((resolve, reject) => {
      const onAbort = () => {
        if (this.pending.delete(toolUseId)) {
          reject(new Error('aborted'))
        }
      }
      abortSignal.addEventListener('abort', onAbort, { once: true })
      this.pending.set(toolUseId, {
        resolve: (d) => {
          abortSignal.removeEventListener('abort', onAbort)
          resolve(d)
        },
        reject: (e) => {
          abortSignal.removeEventListener('abort', onAbort)
          reject(e)
        },
        toolUseId,
        sessionId,
        title,
      })
    })
  }

  // Read-only peek. Used by the HTTP route for sid-mismatch defense
  // (before calling answer / reject).
  peek(toolUseId: string): Pending | undefined {
    return this.pending.get(toolUseId)
  }

  answer(
    toolUseId: string,
    payload: { decision: PendingDecision; comment?: string },
  ): boolean {
    const p = this.pending.get(toolUseId)
    if (!p) return false
    this.pending.delete(toolUseId)
    p.resolve(payload)
    return true
  }

  reject(toolUseId: string, reason = 'user_rejected'): boolean {
    const p = this.pending.get(toolUseId)
    if (!p) return false
    this.pending.delete(toolUseId)
    p.reject(new Error(reason))
    return true
  }

  abortAll(reason = 'session_aborted'): void {
    for (const p of this.pending.values()) {
      this.pending.delete(p.toolUseId)
      p.reject(new Error(reason))
    }
  }

  // For diagnostics / future session-replay; not used in v1 hot path.
  listBySession(sessionId: string): Pending[] {
    const out: Pending[] = []
    for (const p of this.pending.values()) {
      if (p.sessionId === sessionId) out.push(p)
    }
    return out
  }
}
```

- [ ] **Step 2: Verify it compiles**

Run: `cd packages/zai && npx tsc -b --noEmit`
Expected: no errors.

- [ ] **Step 3: Commit**

```bash
git add packages/zai/src/server/services/approveRegistry.ts
git commit -m "feat(server): add ApproveRegistry"
```

---

## Task 10: ApproveRegistry unit tests

**Files:**
- Create: `packages/zai/src/server/services/approveRegistry.test.ts`

**Interfaces:**
- Consumes: `ApproveRegistry` from Task 9.

- [ ] **Step 1: Write the file (mirror of askRegistry.test.ts)**

```ts
import { describe, expect, test } from 'vitest'
import { ApproveRegistry } from './approveRegistry.js'

describe('ApproveRegistry', () => {
  test('register + answer resolves with payload', async () => {
    const reg = new ApproveRegistry()
    const ctrl = new AbortController()
    const p = reg.register('t1', 's1', 'Plan for X', ctrl.signal)
    const ok = reg.answer('t1', { decision: 'approved', comment: 'looks good' })
    expect(ok).toBe(true)
    await expect(p).resolves.toEqual({ decision: 'approved', comment: 'looks good' })
  })

  test('register + reject rejects with default reason', async () => {
    const reg = new ApproveRegistry()
    const ctrl = new AbortController()
    const p = reg.register('t1', 's1', 'Plan', ctrl.signal)
    reg.reject('t1')
    await expect(p).rejects.toThrow('user_rejected')
  })

  test('answer / reject on unknown toolUseId → false, no throw', () => {
    const reg = new ApproveRegistry()
    expect(reg.answer('nope', { decision: 'approved' })).toBe(false)
    expect(reg.reject('nope')).toBe(false)
  })

  test('abort signal rejects pending Promise and removes it', async () => {
    const reg = new ApproveRegistry()
    const ctrl = new AbortController()
    const p = reg.register('t1', 's1', 'P', ctrl.signal)
    expect(reg.peek('t1')).toBeDefined()
    ctrl.abort()
    await expect(p).rejects.toThrow('aborted')
    expect(reg.peek('t1')).toBeUndefined()
  })

  test('abortAll rejects every pending entry', async () => {
    const reg = new ApproveRegistry()
    const ctrl = new AbortController()
    const p1 = reg.register('t1', 's1', 'A', ctrl.signal)
    const p2 = reg.register('t2', 's1', 'B', ctrl.signal)
    reg.abortAll('session_aborted')
    await expect(p1).rejects.toThrow('session_aborted')
    await expect(p2).rejects.toThrow('session_aborted')
  })

  test('listBySession filters correctly', () => {
    const reg = new ApproveRegistry()
    const ctrl = new AbortController()
    reg.register('t1', 'sess-A', 'A', ctrl.signal)
    reg.register('t2', 'sess-A', 'B', ctrl.signal)
    reg.register('t3', 'sess-B', 'C', ctrl.signal)
    expect(reg.listBySession('sess-A').map((p) => p.toolUseId).sort()).toEqual(['t1', 't2'])
    expect(reg.listBySession('sess-B').map((p) => p.toolUseId)).toEqual(['t3'])
    expect(reg.listBySession('sess-X')).toEqual([])
  })

  test('peek returns Pending with title', () => {
    const reg = new ApproveRegistry()
    const ctrl = new AbortController()
    reg.register('t1', 's1', 'MyPlan', ctrl.signal)
    expect(reg.peek('t1')).toEqual(expect.objectContaining({ title: 'MyPlan', sessionId: 's1' }))
  })

  test('X-Session-Id defense: peek allows read before answer', () => {
    const reg = new ApproveRegistry()
    const ctrl = new AbortController()
    reg.register('t1', 'sess-A', 'X', ctrl.signal)
    // The route uses peek + sid comparison; here just verify the data shape.
    expect(reg.peek('t1')?.sessionId).toBe('sess-A')
    expect(reg.peek('unknown')).toBeUndefined()
  })

  test('approved without comment is allowed', async () => {
    const reg = new ApproveRegistry()
    const ctrl = new AbortController()
    const p = reg.register('t1', 's1', 'P', ctrl.signal)
    reg.answer('t1', { decision: 'approved' })
    await expect(p).resolves.toEqual({ decision: 'approved' })
  })
})
```

- [ ] **Step 2: Run the tests**

Run: `cd packages/zai && npx vitest run src/server/services/approveRegistry.test.ts`
Expected: 9 passing.

- [ ] **Step 3: Commit**

```bash
git add packages/zai/src/server/services/approveRegistry.test.ts
git commit -m "test(server): ApproveRegistry unit tests"
```

---

## Task 11: POST /api/agent/approve router

**Files:**
- Create: `packages/zai/src/server/routes/approve.ts`

**Interfaces:**
- Consumes: `ApproveRegistry` from Task 9.
- Produces: Two routes mounted on the same router (`/agent/approve` + `/agent/answer/reject` alias).

- [ ] **Step 1: Write the file (mirror of `routes/answer.ts`)**

```ts
// /api/agent/approve — primary decision submission (approve OR reject).
// /api/agent/approve/reject — server-side alias, kept parallel to
// /api/agent/answer/reject. The front-end always uses the primary endpoint.
//
// Defense-in-depth: client-supplied X-Session-Id is checked against the
// pending entry's sessionId. Mismatch → 409, not 404 (the pending is NOT
// consumed). Without X-Session-Id we fall back to toolUseId uniqueness
// (legacy / hot-reload path).

import { Router, type IRouter, type Request, type Response } from 'express'
import { z } from 'zod'
import type { ApproveRegistry } from '../services/approveRegistry.js'

const router: IRouter = Router()

const PRIMARY_REQUEST = z.discriminatedUnion('decision', [
  z.object({
    toolUseId: z.string().min(1),
    decision: z.literal('approved'),
    comment: z.string().max(2000).optional(),
  }),
  z.object({
    toolUseId: z.string().min(1),
    decision: z.literal('rejected'),
    comment: z.string().min(1).max(2000),
  }),
])

const REJECT_REQUEST = z.object({
  toolUseId: z.string().min(1),
  comment: z.string().min(1).max(2000),
  reason: z.string().optional(),
})

function getRegistry(req: Request): ApproveRegistry | undefined {
  return (req as unknown as { _approveRegistry?: ApproveRegistry })._approveRegistry
}

function readClaimedSid(req: Request): string | null {
  const h = req.headers['x-session-id']
  return typeof h === 'string' && h.length > 0 ? h : null
}

router.post('/agent/approve', (req: Request, res: Response) => {
  const parsed = PRIMARY_REQUEST.safeParse(req.body)
  if (!parsed.success) {
    return res.status(400).json({ error: 'invalid_body' })
  }
  const registry = getRegistry(req)
  if (!registry) {
    return res.status(500).json({ error: 'ApproveRegistry not bound to request' })
  }
  const claimedSid = readClaimedSid(req)
  if (claimedSid) {
    const pending = registry.peek(parsed.data.toolUseId)
    if (pending && pending.sessionId !== claimedSid) {
      return res.status(409).json({
        error: 'session_mismatch',
        detail: `toolUseId belongs to a different session`,
      })
    }
  }
  const ok = registry.answer(
    parsed.data.toolUseId,
    parsed.data.decision === 'approved'
      ? { decision: 'approved', ...(parsed.data.comment ? { comment: parsed.data.comment } : {}) }
      : { decision: 'rejected', comment: parsed.data.comment },
  )
  if (!ok) return res.status(404).json({ error: 'no_pending_review' })
  res.json({ ok: true })
})

router.post('/agent/approve/reject', (req: Request, res: Response) => {
  const parsed = REJECT_REQUEST.safeParse(req.body)
  if (!parsed.success) {
    return res.status(400).json({ error: 'invalid_body' })
  }
  const registry = getRegistry(req)
  if (!registry) {
    return res.status(500).json({ error: 'ApproveRegistry not bound to request' })
  }
  const claimedSid = readClaimedSid(req)
  if (claimedSid) {
    const pending = registry.peek(parsed.data.toolUseId)
    if (pending && pending.sessionId !== claimedSid) {
      return res.status(409).json({
        error: 'session_mismatch',
        detail: `toolUseId belongs to a different session`,
      })
    }
  }
  const ok = registry.reject(parsed.data.toolUseId, parsed.data.reason ?? 'user_rejected')
  res.json({ ok })
})

export default router
```

- [ ] **Step 2: Verify it compiles**

Run: `cd packages/zai && npx tsc -b --noEmit`
Expected: no errors.

- [ ] **Step 3: Commit**

```bash
git add packages/zai/src/server/routes/approve.ts
git commit -m "feat(server): POST /api/agent/approve router"
```

---

## Task 12: Router tests for /api/agent/approve

**Files:**
- Create: `packages/zai/src/server/routes/approve.test.ts`

**Interfaces:**
- Consumes: `ApproveRegistry` from Task 9, `approveRouter` from Task 11.

- [ ] **Step 1: Write the file (mirror of `answer.test.ts`)**

```ts
import { describe, expect, test, beforeEach } from 'vitest'
import express from 'express'
import request from 'supertest'
import { ApproveRegistry } from '../services/approveRegistry.js'
import approveRouter from './approve.js'

function makeApp(): { app: express.Express; registry: ApproveRegistry } {
  const registry = new ApproveRegistry()
  const app = express()
  app.use(express.json())
  app.use((req, _res, next) => {
    ;(req as any)._approveRegistry = registry
    next()
  })
  app.use('/api', approveRouter)
  return { app, registry }
}

describe('POST /api/agent/approve', () => {
  let app: express.Express
  let registry: ApproveRegistry
  beforeEach(() => {
    ;({ app, registry } = makeApp())
  })

  test('缺字段 → 400', async () => {
    const res = await request(app).post('/api/agent/approve').send({})
    expect(res.status).toBe(400)
  })

  test('缺 decision → 400', async () => {
    const res = await request(app).post('/api/agent/approve').send({ toolUseId: 't1' })
    expect(res.status).toBe(400)
  })

  test('rejected 但缺 comment → 400', async () => {
    const res = await request(app)
      .post('/api/agent/approve')
      .send({ toolUseId: 't1', decision: 'rejected' })
    expect(res.status).toBe(400)
  })

  test('comment > 2000 chars → 400', async () => {
    const res = await request(app)
      .post('/api/agent/approve')
      .send({ toolUseId: 't1', decision: 'approved', comment: 'x'.repeat(2001) })
    expect(res.status).toBe(400)
  })

  test('toolUseId 不存在 → 404', async () => {
    const res = await request(app)
      .post('/api/agent/approve')
      .send({ toolUseId: 'unknown', decision: 'approved' })
    expect(res.status).toBe(404)
  })

  test('approved with comment → 200, promise resolves', async () => {
    const ctrl = new AbortController()
    const p = registry.register('t1', 's1', 'Plan', ctrl.signal)
    const res = await request(app)
      .post('/api/agent/approve')
      .send({ toolUseId: 't1', decision: 'approved', comment: 'lgtm' })
    expect(res.status).toBe(200)
    expect(res.body.ok).toBe(true)
    await expect(p).resolves.toEqual({ decision: 'approved', comment: 'lgtm' })
  })

  test('approved without comment → 200', async () => {
    const ctrl = new AbortController()
    const p = registry.register('t1', 's1', 'Plan', ctrl.signal)
    const res = await request(app)
      .post('/api/agent/approve')
      .send({ toolUseId: 't1', decision: 'approved' })
    expect(res.status).toBe(200)
    await expect(p).resolves.toEqual({ decision: 'approved' })
  })

  test('rejected with comment → 200, promise resolves', async () => {
    const ctrl = new AbortController()
    const p = registry.register('t1', 's1', 'Plan', ctrl.signal)
    const res = await request(app)
      .post('/api/agent/approve')
      .send({ toolUseId: 't1', decision: 'rejected', comment: 'fix X' })
    expect(res.status).toBe(200)
    await expect(p).resolves.toEqual({ decision: 'rejected', comment: 'fix X' })
  })

  test('X-Session-Id 匹配 → 200', async () => {
    const ctrl = new AbortController()
    const p = registry.register('t1', 'sess-A', 'Plan', ctrl.signal)
    const res = await request(app)
      .post('/api/agent/approve')
      .set('X-Session-Id', 'sess-A')
      .send({ toolUseId: 't1', decision: 'approved' })
    expect(res.status).toBe(200)
    await expect(p).resolves.toEqual({ decision: 'approved' })
  })

  test('X-Session-Id 不匹配 → 409, pending 不消费', async () => {
    const ctrl = new AbortController()
    const p = registry.register('t1', 'sess-A', 'Plan', ctrl.signal)
    let settled = false
    void p.then(() => { settled = true }).catch(() => { settled = true })
    const res = await request(app)
      .post('/api/agent/approve')
      .set('X-Session-Id', 'sess-B')
      .send({ toolUseId: 't1', decision: 'approved' })
    expect(res.status).toBe(409)
    expect(res.body.error).toBe('session_mismatch')
    await new Promise((r) => setTimeout(r, 20))
    expect(settled).toBe(false)
    // cleanup
    registry.answer('t1', { decision: 'approved' })
  })

  test('不带 X-Session-Id → 维持旧行为', async () => {
    const ctrl = new AbortController()
    const p = registry.register('t1', 'sess-A', 'Plan', ctrl.signal)
    const res = await request(app)
      .post('/api/agent/approve')
      .send({ toolUseId: 't1', decision: 'approved' })
    expect(res.status).toBe(200)
    await expect(p).resolves.toEqual({ decision: 'approved' })
  })
})

describe('POST /api/agent/approve/reject', () => {
  test('缺 toolUseId → 400', async () => {
    const { app } = makeApp()
    const res = await request(app).post('/api/agent/approve/reject').send({})
    expect(res.status).toBe(400)
  })

  test('命中 → 200 ok:true, promise reject', async () => {
    const { app, registry } = makeApp()
    const ctrl = new AbortController()
    const p = registry.register('t1', 's1', 'Plan', ctrl.signal)
    const res = await request(app)
      .post('/api/agent/approve/reject')
      .send({ toolUseId: 't1', comment: 'no', reason: 'not_ready' })
    expect(res.status).toBe(200)
    expect(res.body.ok).toBe(true)
    await expect(p).rejects.toThrow('not_ready')
  })

  test('reject 不存在的 toolUseId → 200 ok:false', async () => {
    const { app } = makeApp()
    const res = await request(app)
      .post('/api/agent/approve/reject')
      .send({ toolUseId: 'nope', comment: 'no' })
    expect(res.status).toBe(200)
    expect(res.body.ok).toBe(false)
  })
})
```

- [ ] **Step 2: Run the tests**

Run: `cd packages/zai && npx vitest run src/server/routes/approve.test.ts`
Expected: 14 passing.

- [ ] **Step 3: Commit**

```bash
git add packages/zai/src/server/routes/approve.test.ts
git commit -m "test(server): /api/agent/approve router tests"
```

---

## Task 13: Add `prompt.approve` to ServerEvent union

**Files:**
- Modify: `packages/zai/src/shared/events.ts`

**Interfaces:**
- Consumes: existing `PromptEvent` discriminated union.
- Produces: One more variant: `{type:'prompt.approve', sessionId, toolUseId, title, summary?, body: ResolvedBody}`. Match the canonical `ResolvedBody` shape from Task 2.

- [ ] **Step 1: Locate `PromptEvent`**

Find in `packages/zai/src/shared/events.ts`:

```ts
const PromptEvent = z.discriminatedUnion('type', [
  z.object({ ...Base.shape, type: z.literal('prompt.ask'),
             sessionId: z.string(), toolUseId: z.string(),
             questions: z.array(z.object({
               question: z.string(), header: z.string(),
               options: z.array(z.object({
                 label: z.string(), description: z.string().optional(),
               })),
             })) }),
])
```

- [ ] **Step 2: Add the new variant**

Add a second member to the array (after the existing `prompt.ask`):

```ts
  z.object({
    ...Base.shape,
    type: z.literal('prompt.approve'),
    sessionId: z.string(),
    toolUseId: z.string(),
    title: z.string(),
    summary: z.string().optional(),
    // Canonical shape — matches ResolvedBody from
    // packages/zai-agent-core/src/tools/RequestApproveTool/schema.ts.
    body: z.discriminatedUnion('kind', [
      z.object({
        kind: z.literal('inline'),
        displayPath: z.null(),
        content: z.string(),
      }),
      z.object({
        kind: z.literal('file'),
        displayPath: z.string(),
        content: z.string(),
      }),
    ]),
  }),
```

- [ ] **Step 3: Verify it compiles**

Run: `cd packages/zai && npx tsc -b --noEmit`
Expected: no errors.

- [ ] **Step 4: Commit**

```bash
git add packages/zai/src/shared/events.ts
git commit -m "feat(shared): prompt.approve SSE event"
```

---

## Task 14: Wire ApproveRegistry into agentRuntime + index + disconnect

**Files:**
- Modify: `packages/zai/src/server/services/agentRuntime.ts` (3 edits)
- Modify: `packages/zai/src/server/index.ts` (mount router + bind registry)
- Modify: `packages/zai/src/server/routes/agent.ts` (add translator branch + `abortAll`)

**Interfaces:**
- Consumes: `ApproveRegistry` from Task 9, `approveRouter` from Task 11.
- Produces: Singleton registry wired into `DefaultAgentRuntime`'s `RuntimeConfig`; mount the router at `/api`; abortAll on disconnect; translate upstream `tool_use:approve_pending` → `prompt.approve`.

- [ ] **Step 1: agentRuntime.ts — import + singleton + getter**

Add to the imports near the top:

```ts
import { ApproveRegistry } from './approveRegistry.js'
```

Add the singleton right after `const askRegistry = new AskRegistry()`:

```ts
const approveRegistry = new ApproveRegistry()
```

Add the getter next to `getAskRegistry`:

```ts
export function getApproveRegistry(): ApproveRegistry {
  return approveRegistry
}
```

- [ ] **Step 2: agentRuntime.ts — wire into `DefaultAgentRuntime`**

Find the `initAgentRuntime` block where `new DefaultAgentRuntime({...})` is constructed and `askRegistry` is passed. Add `approveRegistry` next to it:

```ts
    approveRegistry,
```

(same shape as the existing `askRegistry,` line).

- [ ] **Step 3: agentRuntime.ts — abortAll on `abortAgentSession`**

Find:

```ts
export async function abortAgentSession(reason?: string): Promise<void> {
  askRegistry.abortAll(reason ?? 'session_aborted')
  ...
}
```

Add right after `askRegistry.abortAll`:

```ts
  approveRegistry.abortAll(reason ?? 'session_aborted')
```

- [ ] **Step 4: server/index.ts — mount router + bind registry**

Find the `app.use('/api', (req, _res, next) => { (req as any)._askRegistry = ...; next() }, answerRouter)` block (around line 109).

Add right BEFORE it:

```ts
import approveRouter from './routes/approve.js'
```

(Or add to the existing import line at the top.)

Add immediately AFTER the existing AskRegistry binding line:

```ts
    ;(req as any)._approveRegistry = getApproveRegistry()
```

Add immediately AFTER the `app.use('/api', ..., answerRouter)` call:

```ts
  app.use('/api', approveRouter)
```

(Mounting at `/api` matches the existing pattern; the router's internal paths already start with `/agent/approve`.)

- [ ] **Step 5: routes/agent.ts — translate `tool_use:approve_pending`**

Find the `case "tool_use:ask_pending":` block (line 244 in agent.ts).

Right after it, add:

```ts
      case "tool_use:approve_pending": {
        // RequestApprove: zai-agent-core yield 的 approve_pending 路径.
        // 翻译成前端的 prompt.approve 事件, ApproveDrawer 才能渲染 +
        // 用户点击 Approve/Reject → POST /api/agent/approve → registry answer
        // → promise resolve → tool.call 续走.
        const toolUseId = ((ev.id as string) ??
          (ev.toolUseId as string) ??
          "") as string;
        const body = (ev.body as any) ?? { kind: 'inline', displayPath: null, content: '' };
        yield {
          type: "prompt.approve",
          sessionId,
          toolUseId,
          title: String(ev.title ?? ''),
          ...(ev.summary ? { summary: String(ev.summary) } : {}),
          body,
        } as any;
        break;
      }
```

(Note: `body` is already in canonical ResolvedBody shape — server-side file resolution happens in Task 7's `resolveFileBody` before this event. No need to re-resolve here.)

- [ ] **Step 6: Verify it compiles**

Run: `cd packages/zai && npx tsc -b --noEmit`
Expected: no errors.

- [ ] **Step 7: Run existing server tests — must still pass**

Run: `cd packages/zai && npx vitest run src/server`
Expected: 100% passing including the new `approveRegistry.test.ts` and `approve.test.ts`.

- [ ] **Step 8: Commit**

```bash
git add packages/zai/src/server/services/agentRuntime.ts packages/zai/src/server/index.ts packages/zai/src/server/routes/agent.ts
git commit -m "feat(server): wire approveRegistry into runtime, mount /api/agent/approve, translate SSE"
```

---


## Task 15: pendingApprove slice in useAgentStore

**Files:**
- Modify: `packages/zai/src/web/src/store/useAgentStore.ts`

**Interfaces:**
- Consumes: existing `AskState` (mirror).
- Produces: `pendingApprove` slice, `applyPromptApprove` reducer, `submitApprove` action, `clearPendingApprove(toolUseId)` action; `tool_use:done` for a matching toolUseId clears both `pendingAsk` and `pendingApprove`.

- [ ] **Step 1: Add `ApproveState` type alongside `AskState`**

Find `export type AskState = ...` (around line 104). Add directly after:

```ts
export type ApproveState = {
  toolUseId: string
  sessionId: string
  title: string
  summary?: string
  content: string
  displayPath: string | null
  decision: 'approved' | 'rejected' | null
  comment: string
  status: 'pending' | 'submitting' | 'error'
  errorMessage?: string
}
```

- [ ] **Step 2: Add the field + actions to `AgentState` interface**

Find `pendingAsk: AskState | null` (around line 169). Add directly after:

```ts
  pendingApprove: ApproveState | null
  setApproveComment: (comment: string) => void
  submitApprove: (decision: 'approved' | 'rejected') => Promise<void>
  applyPromptApprove: (event: any) => void
  clearPendingApprove: (toolUseId: string) => void
```

- [ ] **Step 3: Initialize the field in the store**

Find `pendingAsk: null,` initialization. Add directly after:

```ts
  pendingApprove: null,
```

- [ ] **Step 4: Implement `applyPromptApprove` reducer**

Find the existing `applyPromptAsk:` reducer (around line 1407). Add directly after it:

```ts
  applyPromptApprove: (event) => set((state) => {
    if (!event || event.type !== 'prompt.approve') return state
    // Replace any existing pendingApprove (parallel to applyPromptAsk's
    // overwrite semantics; simultaneous approvals are not a feature).
    const body = event.body ?? { kind: 'inline', displayPath: null, content: '' }
    return {
      ...state,
      pendingApprove: {
        toolUseId: event.toolUseId,
        sessionId: event.sessionId,
        title: event.title,
        ...(event.summary ? { summary: event.summary } : {}),
        content: String(body.content ?? ''),
        displayPath: body.kind === 'file' ? String(body.displayPath ?? '') : null,
        decision: null,
        comment: '',
        status: 'pending',
      },
    }
  }),

  setApproveComment: (comment) => set((s) => {
    if (!s.pendingApprove) return s
    return { ...s, pendingApprove: { ...s.pendingApprove, comment } }
  }),

  submitApprove: async (decision) => {
    const s = get()
    if (!s.pendingApprove) return
    if (decision === 'rejected' && s.pendingApprove.comment.trim().length === 0) {
      set({ pendingApprove: { ...s.pendingApprove, status: 'error', errorMessage: 'Rejection comment is required.' } })
      return
    }
    set({ pendingApprove: { ...s.pendingApprove, status: 'submitting', decision } })
    try {
      const headers: Record<string, string> = { 'Content-Type': 'application/json' }
      const claimSid = s.pendingApprove.sessionId ?? s.sessionId
      if (claimSid) headers['X-Session-Id'] = claimSid
      const res = await fetch('/api/agent/approve', {
        method: 'POST',
        headers,
        body: JSON.stringify({
          toolUseId: s.pendingApprove.toolUseId,
          decision,
          comment: s.pendingApprove.comment || undefined,
        }),
      })
      if (res.status === 404) {
        set({ pendingApprove: { ...s.pendingApprove, status: 'error', errorMessage: 'Review expired (no pending)' } })
        return
      }
      if (res.status === 409) {
        set({ pendingApprove: { ...s.pendingApprove, status: 'error', errorMessage: 'Session mismatch — refresh?' } })
        return
      }
      if (!res.ok) {
        set({ pendingApprove: { ...s.pendingApprove, status: 'error', errorMessage: `HTTP ${res.status}` } })
        return
      }
      // Clear now — the runtime will follow up with tool_use:done but in
      // case of clock skew or order swap, we don't want a stale drawer.
      set({ pendingApprove: null })
    } catch (err) {
      set({ pendingApprove: { ...s.pendingApprove, status: 'error', errorMessage: (err as Error).message } })
    }
  },

  clearPendingApprove: (toolUseId) => set((s) => {
    if (!s.pendingApprove || s.pendingApprove.toolUseId !== toolUseId) return s
    return { ...s, pendingApprove: null }
  }),
```

- [ ] **Step 5: Clear `pendingApprove` on `tool_use:done` in `upsertToolCall`**

Find the `shouldClearPending` block inside `upsertToolCall` (around line 672-677):

```ts
      const shouldClearPending =
        s.pendingAsk &&
        (t === 'tool_use:done' || t === 'tool_use:error' ||
         t === 'tool_use:invalid' || t === 'tool_use:denied') &&
        s.pendingAsk.toolUseId === toolUseId
```

Replace with:

```ts
      const clearApproveMatch =
        s.pendingApprove &&
        (t === 'tool_use:done' || t === 'tool_use:error' ||
         t === 'tool_use:invalid' || t === 'tool_use:denied') &&
        s.pendingApprove.toolUseId === toolUseId
      const shouldClearPending =
        (s.pendingAsk && (t === 'tool_use:done' || t === 'tool_use:error' ||
         t === 'tool_use:invalid' || t === 'tool_use:denied') &&
         s.pendingAsk.toolUseId === toolUseId) ||
        clearApproveMatch
```

Then in the same `upsertToolCall` where `updates.pendingAsk = null` is set (search for `if (shouldClearPending) updates.pendingAsk = null`), add:

```ts
      if (clearApproveMatch) updates.pendingApprove = null
```

(Exact line numbers depend on imports — use `Grep` to find the exact spots. Don't refactor; just splice the new lines.)

- [ ] **Step 6: Verify it compiles**

Run: `cd packages/zai && npx tsc -b --noEmit`
Expected: no errors.

- [ ] **Step 7: Run existing store tests — must still pass**

Run: `cd packages/zai && npx vitest run src/web/src/store/useAgentStore.test.ts`
Expected: all existing tests pass.

- [ ] **Step 8: Commit**

```bash
git add packages/zai/src/web/src/store/useAgentStore.ts
git commit -m "feat(web): pendingApprove slice + applyPromptApprove + submitApprove"
```

---

## Task 16: Dispatch `prompt.approve` in useEventStream

**Files:**
- Modify: `packages/zai/src/web/src/store/useEventStream.ts`

**Interfaces:**
- Consumes: `applyPromptApprove` from Task 15.

- [ ] **Step 1: Add a case in the dispatch switch**

Find:

```ts
    case 'prompt.ask':
      useAgentStore.getState().applyPromptAsk(event)
      break
```

Add directly after:

```ts
    case 'prompt.approve':
      useAgentStore.getState().applyPromptApprove(event as any)
      break
```

- [ ] **Step 2: Verify it compiles**

Run: `cd packages/zai && npx tsc -b --noEmit`
Expected: no errors.

- [ ] **Step 3: Commit**

```bash
git add packages/zai/src/web/src/store/useEventStream.ts
git commit -m "feat(web): dispatch prompt.approve to applyPromptApprove"
```

---

## Task 17: ApproveDrawer component + tests

**Files:**
- Create: `packages/zai/src/web/src/components/ApproveDrawer.tsx`
- Create: `packages/zai/src/web/src/components/ApproveDrawer.test.tsx`

**Interfaces:**
- Consumes: `useAgentStore.pendingApprove`, `submitApprove`, `setApproveComment` from Task 15; `MarkdownText` from `../components/markdown/MarkdownText.tsx`.

- [ ] **Step 1: Write the component**

```tsx
// ApproveDrawer.tsx — right-side drawer for human review of an AI-generated
// markdown document. Closes without rejecting (state preserved in store).

import { Drawer, Button, Input, Popconfirm, Typography } from 'antd'
import { useState, useEffect } from 'react'
import MarkdownText from './markdown/MarkdownText.tsx'
import { useAgentStore } from '../store/useAgentStore.js'

const { TextArea } = Input
const { Text } = Typography

const COMMENT_MAX = 2000

export default function ApproveDrawer(): JSX.Element {
  const pending = useAgentStore((s) => s.pendingApprove)
  const setComment = useAgentStore((s) => s.setApproveComment)
  const submitApprove = useAgentStore((s) => s.submitApprove)
  // Local mirror so the textarea is fast even before the store commits.
  // The store is still the source of truth; on remount, the value comes
  // back from the store.
  const [localComment, setLocalComment] = useState('')

  useEffect(() => {
    setLocalComment(pending?.comment ?? '')
  }, [pending?.toolUseId])

  const onCommentChange = (v: string) => {
    const truncated = v.length > COMMENT_MAX ? v.slice(0, COMMENT_MAX) : v
    setLocalComment(truncated)
    setComment(truncated)
  }

  const open = pending !== null
  const title = pending?.title ?? ''
  const summary = pending?.summary
  const content = pending?.content ?? ''
  const displayPath = pending?.displayPath ?? null
  const comment = localComment
  const commentEmpty = comment.trim().length === 0
  const submitting = pending?.status === 'submitting'
  const errorMessage = pending?.errorMessage
  const error = pending?.status === 'error'

  return (
    <Drawer
      title={title}
      placement="right"
      width="min(720px, 50vw)"
      open={open}
      // destroyOnClose=false so comment survives a temporary close.
      destroyOnClose={false}
      maskClosable={!submitting}
      keyboard={!submitting}
      // Close does NOT auto-reject. State preserved in store.
      onClose={() => { /* no-op; user must Approve or Reject */ }}
      data-testid="approve-drawer"
      footer={
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 8 }}>
          <div style={{ flex: 1 }}>
            {error && errorMessage && (
              <Text type="danger" style={{ fontSize: 12 }}>{errorMessage}</Text>
            )}
          </div>
          {commentEmpty ? (
            <Popconfirm
              title="Reject without a comment?"
              description="The AI won't know what to fix."
              okText="Reject anyway"
              cancelText="Cancel"
              onConfirm={() => { void submitApprove('rejected') }}
            >
              <Button danger disabled={!pending || submitting}>Reject</Button>
            </Popconfirm>
          ) : (
            <Button danger disabled={!pending || submitting} onClick={() => { void submitApprove('rejected') }}>
              Reject
            </Button>
          )}
          <Button type="primary" disabled={!pending || submitting} loading={submitting} onClick={() => { void submitApprove('approved') }}>
            Approve
          </Button>
        </div>
      }
    >
      <div style={{ display: 'flex', flexDirection: 'column', height: '100%' }}>
        {summary && (
          <div style={{ marginBottom: 12, padding: 12, background: 'rgba(0,0,0,0.04)', borderRadius: 4 }}>
            <Text type="secondary" style={{ fontSize: 13 }}>{summary}</Text>
          </div>
        )}
        {displayPath && (
          <div style={{ marginBottom: 8, fontSize: 11, color: '#8c8c8c', fontFamily: 'ui-monospace, monospace' }}>
            Loaded from {displayPath}
          </div>
        )}
        <div style={{ flex: 1, overflow: 'auto', padding: '12px 0' }}>
          {content ? <MarkdownText content={content} /> : <Text type="secondary">No content.</Text>}
        </div>
        <div style={{ marginTop: 16, borderTop: '1px solid #f0f0f0', paddingTop: 16 }}>
          <Text strong style={{ display: 'block', marginBottom: 6 }}>Comment (optional on Approve, required on Reject)</Text>
          <TextArea
            value={comment}
            maxLength={COMMENT_MAX}
            onChange={(e) => onCommentChange(e.target.value)}
            placeholder="Optional on Approve. Required on Reject — leave feedback for the AI."
            rows={4}
            data-testid="approve-drawer-comment"
          />
          <Text type="secondary" style={{ fontSize: 11 }}>{comment.length}/{COMMENT_MAX}</Text>
        </div>
      </div>
    </Drawer>
  )
}
```

- [ ] **Step 2: Write the failing tests first (component)**

```tsx
import { describe, expect, test, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, waitFor, cleanup } from '@testing-library/react'
import ApproveDrawer from './ApproveDrawer.jsx'
import { useAgentStore } from '../store/useAgentStore.js'

beforeEach(() => {
  cleanup()
  useAgentStore.setState({
    pendingApprove: null,
    pendingAsk: null,
    sessionId: 's1',
  } as any)
  // @ts-ignore — silence fetch mock
  global.fetch = vi.fn(async () => ({ ok: true, status: 200, json: async () => ({ ok: true }) }))
})

function setPendingWith(content = '# Hello\n\nThis is content.'): void {
  useAgentStore.setState({
    pendingApprove: {
      toolUseId: 'tu-1',
      sessionId: 's1',
      title: 'My Plan',
      summary: 'Quick summary',
      content,
      displayPath: null,
      decision: null,
      comment: '',
      status: 'pending',
    },
  } as any)
}

describe('ApproveDrawer', () => {
  test('no pending → drawer closed (cannot find open button text)', () => {
    render(<ApproveDrawer />)
    // AntD renders title text inside drawer header only when open.
    expect(screen.queryByText('My Plan')).toBeNull()
  })

  test('renders markdown content when pending', () => {
    setPendingWith()
    render(<ApproveDrawer />)
    expect(screen.getByText('My Plan')).toBeDefined()
    expect(screen.getByText('Hello')).toBeDefined()
    expect(screen.getByText('Quick summary')).toBeDefined()
  })

  test('shows file source path when displayPath is set', () => {
    useAgentStore.setState({
      pendingApprove: {
        toolUseId: 'tu-1', sessionId: 's1', title: 'Plan',
        content: 'content', displayPath: 'docs/plan.md',
        decision: null, comment: '', status: 'pending',
      },
    } as any)
    render(<ApproveDrawer />)
    expect(screen.getByText(/docs\/plan\.md/)).toBeDefined()
  })

  test('approve button calls submitApprove("approved") with empty comment', async () => {
    setPendingWith()
    render(<ApproveDrawer />)
    const approveBtn = screen.getByRole('button', { name: /approve/i })
    fireEvent.click(approveBtn)
    await waitFor(() => {
      expect(useAgentStore.getState().pendingApprove?.status).toBe('submitting')
    })
    expect(global.fetch).toHaveBeenCalledWith(
      '/api/agent/approve',
      expect.objectContaining({
        method: 'POST',
        headers: expect.objectContaining({ 'X-Session-Id': 's1' }),
        body: JSON.stringify({ toolUseId: 'tu-1', decision: 'approved' }),
      }),
    )
  })

  test('reject with comment → POST decision="rejected", comment included', async () => {
    setPendingWith()
    render(<ApproveDrawer />)
    const ta = screen.getByTestId('approve-drawer-comment') as HTMLTextAreaElement
    fireEvent.change(ta, { target: { value: 'fix the API section' } })
    // Comment now non-empty → reject button enabled and direct (no Popconfirm).
    const rejBtn = screen.getByRole('button', { name: /reject/i })
    fireEvent.click(rejBtn)
    await waitFor(() => {
      expect(global.fetch).toHaveBeenCalled()
    })
    expect(global.fetch).toHaveBeenCalledWith(
      '/api/agent/approve',
      expect.objectContaining({
        body: JSON.stringify({ toolUseId: 'tu-1', decision: 'rejected', comment: 'fix the API section' }),
      }),
    )
  })

  test('reject with empty comment → submits will error out client-side', async () => {
    setPendingWith()
    render(<ApproveDrawer />)
    // Empty comment means a Popconfirm wraps the Reject button. Click it.
    const rejBtn = screen.getByRole('button', { name: /reject/i })
    fireEvent.click(rejBtn)
    // The Popconfirm's "Reject anyway" appears.
    const confirm = await screen.findByText('Reject anyway')
    fireEvent.click(confirm)
    await waitFor(() => {
      expect(useAgentStore.getState().pendingApprove?.status).toBe('submitting')
    })
  })
})
```

- [ ] **Step 3: Mount fetch mock in test setup**

The test setup needs `@testing-library/react` and `vitest`. Verify they exist:

```bash
grep -l "@testing-library/react" packages/zai/package.json
grep -l "happy-dom\|jsdom" packages/zai/package.json
```

If missing, skip and write the same tests in Task 17 once they exist — for now rely on the existing QuestionCard.test.tsx pattern and reuse its setup.

(If environment is missing jsdom, scaffold one with: add `"@testing-library/react": "^14"`, `"@testing-library/jest-dom": "^6"`, `"happy-dom": "^14"` as devDependencies and a vitest `environment: 'happy-dom'` block in `vitest.config.ts`. Adjust to whatever is already used.)

- [ ] **Step 4: Run the tests**

Run: `cd packages/zai && npx vitest run src/web/src/components/ApproveDrawer.test.tsx`
Expected: 6 passing.

- [ ] **Step 5: Commit**

```bash
git add packages/zai/src/web/src/components/ApproveDrawer.tsx packages/zai/src/web/src/components/ApproveDrawer.test.tsx
git commit -m "feat(web): ApproveDrawer component + tests"
```

---

## Task 18: Mount ApproveDrawer in Agent.tsx

**Files:**
- Modify: `packages/zai/src/web/src/pages/Agent.tsx`

**Interfaces:**
- Consumes: `ApproveDrawer` from Task 17.

- [ ] **Step 1: Add the import**

Find the line:

```tsx
import QuestionCard from "../components/QuestionCard.jsx";
```

Add directly below:

```tsx
import ApproveDrawer from "../components/ApproveDrawer.jsx";
```

- [ ] **Step 2: Mount the drawer**

Find the `<TaskDrawer ...>` line (around the other Drawers) and add:

```tsx
      <ApproveDrawer />
```

right after `</TaskDrawer>`. Pattern:

```tsx
      <TaskDrawer taskId={selectedTaskId} onClose={() => setSelectedTaskId(null)} />
      <ApproveDrawer />
      <SettingsDrawer />
      <SessionCwdBridge />
```

- [ ] **Step 3: Verify it compiles**

Run: `cd packages/zai && npx tsc -b --noEmit`
Expected: no errors.

- [ ] **Step 4: Run Agent tests — must still pass**

Run: `cd packages/zai && npx vitest run src/web/src/pages/Agent.test.tsx`
Expected: all passing.

- [ ] **Step 5: Commit**

```bash
git add packages/zai/src/web/src/pages/Agent.tsx
git commit -m "feat(web): mount ApproveDrawer in Agent page"
```

---

## Task 19: Store tests for applyPromptApprove + submitApprove + clearPendingApprove

**Files:**
- Modify: `packages/zai/src/web/src/store/useAgentStore.test.ts`

**Interfaces:**
- Consumes: `useAgentStore` from Task 15.

- [ ] **Step 1: Read existing test patterns**

Find the `describe('useAgentStore.applyPromptAsk', ...)` block to mirror its shape.

- [ ] **Step 2: Add a new describe block at the end of the file**

```ts
describe('useAgentStore.applyPromptApprove', () => {
  beforeEach(() => {
    useAgentStore.setState({ pendingApprove: null } as any)
  })

  test('event with inline body → pendingApprove populated correctly', () => {
    useAgentStore.getState().applyPromptApprove({
      type: 'prompt.approve',
      sessionId: 's1',
      toolUseId: 'tu-1',
      title: 'Plan',
      summary: 'brief',
      body: { kind: 'inline', displayPath: null, content: '# Plan\n\ncontent' },
      eventId: 'e1',
      ts: 0,
    } as any)
    const p = useAgentStore.getState().pendingApprove
    expect(p).toBeTruthy()
    expect(p!.toolUseId).toBe('tu-1')
    expect(p!.title).toBe('Plan')
    expect(p!.summary).toBe('brief')
    expect(p!.content).toContain('content')
    expect(p!.displayPath).toBeNull()
    expect(p!.status).toBe('pending')
    expect(p!.decision).toBeNull()
    expect(p!.comment).toBe('')
  })

  test('event with file body → displayPath populated', () => {
    useAgentStore.getState().applyPromptApprove({
      type: 'prompt.approve',
      sessionId: 's1',
      toolUseId: 'tu-2',
      title: 'Design',
      body: { kind: 'file', displayPath: 'docs/design.md', content: 'resolved file content' },
      eventId: 'e2',
      ts: 0,
    } as any)
    expect(useAgentStore.getState().pendingApprove!.displayPath).toBe('docs/design.md')
  })

  test('event without summary → undefined', () => {
    useAgentStore.getState().applyPromptApprove({
      type: 'prompt.approve',
      sessionId: 's1',
      toolUseId: 'tu-3',
      title: 'NoSummary',
      body: { kind: 'inline', displayPath: null, content: 'x' },
      eventId: 'e3',
      ts: 0,
    } as any)
    expect(useAgentStore.getState().pendingApprove!.summary).toBeUndefined()
  })

  test('setApproveComment writes comment', () => {
    useAgentStore.getState().applyPromptApprove({
      type: 'prompt.approve',
      sessionId: 's1',
      toolUseId: 'tu-c',
      title: 'T',
      body: { kind: 'inline', displayPath: null, content: 'x' },
      eventId: 'e-c',
      ts: 0,
    } as any)
    useAgentStore.getState().setApproveComment('hello')
    expect(useAgentStore.getState().pendingApprove!.comment).toBe('hello')
  })

  test('clearPendingApprove(toolUseId) clears matching pending', () => {
    useAgentStore.getState().applyPromptApprove({
      type: 'prompt.approve',
      sessionId: 's1', toolUseId: 'tu-x', title: 'T',
      body: { kind: 'inline', displayPath: null, content: 'x' },
      eventId: 'e-x', ts: 0,
    } as any)
    useAgentStore.getState().clearPendingApprove('tu-x')
    expect(useAgentStore.getState().pendingApprove).toBeNull()
  })

  test('clearPendingApprove with non-matching toolUseId is a no-op', () => {
    useAgentStore.getState().applyPromptApprove({
      type: 'prompt.approve',
      sessionId: 's1', toolUseId: 'tu-y', title: 'T',
      body: { kind: 'inline', displayPath: null, content: 'x' },
      eventId: 'e-y', ts: 0,
    } as any)
    useAgentStore.getState().clearPendingApprove('tu-other')
    expect(useAgentStore.getState().pendingApprove).not.toBeNull()
  })
})

describe('useAgentStore.submitApprove', () => {
  beforeEach(() => {
    useAgentStore.setState({ pendingApprove: null, sessionId: 's1' } as any)
    // @ts-ignore — replace fetch in test
    global.fetch = vi.fn(async () => ({ ok: true, status: 200, json: async () => ({ ok: true }) }))
  })

  test('approved without comment → POST without comment field', async () => {
    useAgentStore.getState().applyPromptApprove({
      type: 'prompt.approve',
      sessionId: 's1', toolUseId: 'tu', title: 'T',
      body: { kind: 'inline', displayPath: null, content: 'x' },
      eventId: 'e', ts: 0,
    } as any)
    await useAgentStore.getState().submitApprove('approved')
    expect(global.fetch).toHaveBeenCalledWith(
      '/api/agent/approve',
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({ toolUseId: 'tu', decision: 'approved', comment: undefined }),
      }),
    )
    expect(useAgentStore.getState().pendingApprove).toBeNull()
  })

  test('rejected without comment → status=error, no fetch', async () => {
    useAgentStore.getState().applyPromptApprove({
      type: 'prompt.approve',
      sessionId: 's1', toolUseId: 'tu', title: 'T',
      body: { kind: 'inline', displayPath: null, content: 'x' },
      eventId: 'e', ts: 0,
    } as any)
    await useAgentStore.getState().submitApprove('rejected')
    expect(useAgentStore.getState().pendingApprove?.status).toBe('error')
    expect(global.fetch).not.toHaveBeenCalled()
  })

  test('404 → status=error, errorMessage set, not cleared', async () => {
    // @ts-ignore — 404 mock
    global.fetch = vi.fn(async () => ({ ok: false, status: 404, json: async () => ({}) }))
    useAgentStore.getState().applyPromptApprove({
      type: 'prompt.approve',
      sessionId: 's1', toolUseId: 'tu', title: 'T',
      body: { kind: 'inline', displayPath: null, content: 'x' },
      eventId: 'e', ts: 0,
    } as any)
    useAgentStore.getState().setApproveComment('fix')
    await useAgentStore.getState().submitApprove('rejected')
    expect(useAgentStore.getState().pendingApprove?.status).toBe('error')
    expect(useAgentStore.getState().pendingApprove?.errorMessage).toContain('expired')
  })
})
```

- [ ] **Step 3: Run the tests**

Run: `cd packages/zai && npx vitest run src/web/src/store/useAgentStore.test.ts`
Expected: 9 passing.

- [ ] **Step 4: Commit**

```bash
git add packages/zai/src/web/src/store/useAgentStore.test.ts
git commit -m "test(web): applyPromptApprove + submitApprove + clearPendingApprove"
```

---

## Task 20: Integration test — RequestApprove blocks loop, resumes on user

**Files:**
- Create: `packages/zai-agent-core/test/integration/agent/request-approve-turn-loop.test.ts`

**Interfaces:**
- Consumes: full runtime — `executeToolsStreaming`, `ApproveRegistryLike`, run a turn-loop flow with a stubbed model that emits one `RequestApprove` tool_use.

- [ ] **Step 1: Read auto-compact-turn-loop.test.ts as a reference**

Use it as the structural template — it stubs `modelCaller`, runs `queryLoop`, awaits events, asserts transcript.

- [ ] **Step 2: Write the test**

```ts
import { describe, expect, test } from 'vitest'
import { executeToolsStreaming } from '../../../src/runtime/toolExecution.js'
import { REQUEST_APPROVE_TOOL_NAME } from '../../../src/tools/RequestApproveTool/prompt.js'
import type { ApproveRegistryLike } from '../../../src/runtime/types.js'

// Same minimal in-memory registry shape as zai's services/approveRegistry.ts
// — reimplemented here to avoid a cross-package import in tests.
class TestApproveRegistry implements ApproveRegistryLike {
  pending = new Map<string, { resolve: (d: any) => void; reject: (e: Error) => void; sessionId: string }>()
  register(toolUseId: string, sessionId: string, _sig: AbortSignal): Promise<any> {
    return new Promise<any>((resolve, reject) => {
      this.pending.set(toolUseId, { resolve, reject, sessionId })
    })
  }
  answer(toolUseId: string, payload: any) {
    const p = this.pending.get(toolUseId)
    if (!p) return false
    this.pending.delete(toolUseId)
    p.resolve(payload)
    return true
  }
}

describe('RequestApprove end-to-end turn loop', () => {
  test('approve_pending yields, await blocks, decision resumes tool with {decision:approved}', async () => {
    const reg = new TestApproveRegistry()
    const blocks = [
      {
        id: 'tu-1',
        name: REQUEST_APPROVE_TOOL_NAME,
        input: {
          title: 'My plan',
          body: { kind: 'inline', content: '# Plan\n\nA plan.' },
        },
      },
    ]

    // Pre-register a synthetic decision so the await resolves.
    setTimeout(() => reg.answer('tu-1', { decision: 'approved', comment: 'looks good' }), 5)

    const collected: any[] = []
    await (async () => {
      for await (const ev of executeToolsStreaming(
        blocks as any,
        { cwd: '/tmp', env: {}, abortSignal: new AbortController().signal, dataDir: '/d',
          state: {}, canUseTool: async () => ({ behavior: 'allow' }),
          emitEvent: () => {}, awaitAskUserQuestion: async () => ({ answers: {} }),
        } as any,
        [],  // no tools — we exercise the runtime branch only, not the tool body
        { sessionId: 's1', turnIndex: 0, nextEventId: () => 'e' + collected.length },
        undefined,
        reg,
      )) {
        collected.push(ev)
      }
    })()

    const approvePending = collected.find((e) => e.type === 'tool_use:approve_pending')
    expect(approvePending).toBeTruthy()
    expect(approvePending.toolUseId).toBe('tu-1')
    expect(approvePending.title).toBe('My plan')
    expect(approvePending.body).toEqual({ kind: 'inline', displayPath: null, content: '# Plan\n\nA plan.' })
    const done = collected.find((e) => e.type === 'tool_use:done')
    expect(done).toBeTruthy()
  })

  test('file path with displayPath preserved in approve_pending event', async () => {
    const reg = new TestApproveRegistry()
    const blocks = [
      {
        id: 'tu-2',
        name: REQUEST_APPROVE_TOOL_NAME,
        input: {
          title: 'design',
          body: { kind: 'file', path: 'docs/design.md' },
        },
      },
    ]
    setTimeout(() => reg.answer('tu-2', { decision: 'approved' }), 5)

    const collected: any[] = []
    await (async () => {
      for await (const ev of executeToolsStreaming(
        blocks as any,
        { cwd: '/tmp', env: {}, abortSignal: new AbortController().signal, dataDir: '/d',
          state: {}, canUseTool: async () => ({ behavior: 'allow' }),
          emitEvent: () => {}, awaitAskUserQuestion: async () => ({ answers: {} }),
        } as any,
        [],
        { sessionId: 's1', turnIndex: 0, nextEventId: () => 'e' + collected.length },
        undefined,
        reg,
      )) {
        collected.push(ev)
      }
    })()

    const approvePending = collected.find((e) => e.type === 'tool_use:approve_pending')
    expect(approvePending.body.kind).toBe('file')
    expect(approvePending.body.displayPath).toBe('docs/design.md')
  })

  test('approveRegistry not configured → tool_use:error yielded, promise not awaited', async () => {
    const blocks = [
      {
        id: 'tu-3',
        name: REQUEST_APPROVE_TOOL_NAME,
        input: { title: 'T', body: { kind: 'inline', content: 'x' } },
      },
    ]

    const collected: any[] = []
    await (async () => {
      for await (const ev of executeToolsStreaming(
        blocks as any,
        { cwd: '/tmp', env: {}, abortSignal: new AbortController().signal, dataDir: '/d',
          state: {}, canUseTool: async () => ({ behavior: 'allow' }),
          emitEvent: () => {}, awaitAskUserQuestion: async () => ({ answers: {} }),
        } as any,
        [],
        { sessionId: 's1', turnIndex: 0, nextEventId: () => 'e' + collected.length },
        undefined,
        // intentionally undefined
      )) {
        collected.push(ev)
      }
    })()

    const err = collected.find((e) => e.type === 'tool_use:error')
    expect(err).toBeTruthy()
    expect(String(err.error)).toMatch(/approveRegistry/)
  })
})
```

- [ ] **Step 3: Run the tests**

Run: `cd packages/zai-agent-core && npx vitest run test/integration/agent/request-approve-turn-loop.test.ts`
Expected: 3 passing.

- [ ] **Step 4: Commit**

```bash
git add packages/zai-agent-core/test/integration/agent/request-approve-turn-loop.test.ts
git commit -m "test(core): RequestApprove end-to-end turn-loop integration"
```

---

## Task 21: Final verification — typecheck + full test suite

**Files:** None — verification only.

- [ ] **Step 1: Typecheck both packages**

```bash
cd packages/zai-agent-core && npx tsc -b --noEmit
cd ../zai && npx tsc -b --noEmit
```

Expected: no errors in either.

- [ ] **Step 2: Full test suite (both packages)**

```bash
cd packages/zai-agent-core && npx vitest run
cd ../zai && npx vitest run
```

Expected: all tests pass, including all new tests created in Tasks 5, 10, 12, 17, 19, 20.

- [ ] **Step 3: Verify new files exist**

```bash
git status
```

Expected to see all new files listed:
- `packages/zai-agent-core/src/tools/RequestApproveTool/{prompt,schema,RequestApproveTool}.ts`
- `packages/zai-agent-core/test/tools/RequestApproveTool/RequestApproveTool.test.ts`
- `packages/zai-agent-core/test/integration/agent/request-approve-turn-loop.test.ts`
- `packages/zai/src/server/services/approveRegistry.{ts,_test}.ts`
- `packages/zai/src/server/routes/approve.{ts,_test}.ts`
- `packages/zai/src/web/src/components/ApproveDrawer.{tsx,_test.tsx}`

- [ ] **Step 4: Manual smoke test (optional but recommended)**

In `packages/zai`, start the dev server with `npm run dev`, send a prompt that triggers a tool_use of `RequestApprove` (e.g. "show me a plan for X before you start coding"), confirm:
- The drawer opens on the right.
- Markdown renders correctly.
- Reject without comment shows a Popconfirm.
- Approve clears the drawer and continues the loop.

If you don't have a model able to call this tool yet, skip — unit + integration coverage is the gate.

- [ ] **Step 5: Final commit (if any uncommitted) + summary**

```bash
git status
# Stage and commit any uncommitted files
git add -A
git commit -m "feat: RequestApprove tool — complete"
```

(If `git status` is empty, skip the commit — Tasks 1-20 each made their own commit.)

- [ ] **Step 6: Final summary log**

Print a summary of the full feature:

```
RequestApprove tool — DONE
- 8 new files in zai-agent-core (tool + tests + integration)
- 6 new files in zai (registry + route + tests + component + tests)
- 11 modified files (toolContext, runtime, queryEngine, server, store, eventStream, Agent.tsx, etc.)
- All tasks committed.
- All tests passing.
```

---

## Self-Review (run after writing the plan, before commit)

If you wrote this plan top-to-bottom, run these checks now:

1. **Spec coverage:**
   - §2 Tool Contract → Tasks 1, 2, 3
   - §3 Runtime Wiring → Tasks 4, 7, 8
   - §4 Server Routes → Tasks 9, 11, 14
   - §5 SSE Event → Tasks 13, 14
   - §6 UI Drawer → Tasks 17, 18
   - §7 Error Handling → Tasks 7 (tool_use:invalid on bad file), 11 (400 on bad body / missing comment), 14 (abortAll on disconnect), 15 (404/409 client-side handling)
   - §8 Testing → Tasks 5, 10, 12, 17, 19, 20
   - §9 Files Touched → confirmed by Step 3 above

2. **Placeholder scan:** No TODOs, no "fill in details", no "implement later." Each step has either exact code or exact commands.

3. **Type consistency:**
   - `ResolvedBody` defined in schema (Task 2), referenced by name in toolExecution (Task 7), SSE schema (Task 13).
   - `ApproveRegistryLike` defined Task 6, threaded Task 7/8, supplied Task 14.
   - `AwaitApproveInput / AwaitApproveResult` defined Task 3, consumed in `LegacyToolContext.awaitApprove` Task 4, produced by Task 7 bridge.
   - Front-end `pendingApprove` slice (Task 15) cleared by both `tool_use:done` and `submitApprove` (Task 15 step 4+5).
   - `__resolvedApproveBody` and `__toolUseId` set on bridgedCtx (Task 7), read by tool body (Task 3).

   No inconsistencies.

4. **Constraint enforcement:**
   - 200 KB inline cap (Task 2 schema + Task 7 `resolveFileBody` size check).
   - Absolute path rejected (Task 2 `.refine`).
   - Reject comment required (Task 2 schema + Task 11 + Task 15 client validation + Task 19 test).
   - 409 on sid mismatch (Task 11 + Task 12 test).
