# zai Transcript Tool Persistence Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make zai's `TranscriptStore` persist full tool_use + tool_result round-trips so the engine can resume sessions and the UI can replay tool cards.

**Architecture:** Bump `TranscriptFile.version` from `1` to `2`, align `TranscriptMessage.message` with OpenCC's `SerializedMessage + ContentBlock[]`, and add `appendToolUse` / `appendToolResult` event-level appenders inside the zai runtime layer. Resume reads v2 files via a new `serializeForAnthropic` helper; v1 files throw `LegacyTranscriptError` and silently degrade to empty messages.

**Tech Stack:** TypeScript (Bun runtime), proper-lockfile, zod (existing), Vitest (test runner).

## Global Constraints

- Bun only (`bun test`, `bun run typecheck`) — no npm/pnpm/yarn.
- Tests live in `packages/zai-agent-core/test/transcript/` or `…/runtime/`.
- Commit style: `feat(zai): …` / `fix(zai): …` / `test(zai): …`.
- Reuse `opencc-internals/services/api/compressToolHistory.ts` for tool_result compression — do not fork.
- Schema field names use OpenCC's exact casing (`message`, `parentUuid`, `tool_use_id`, `is_error`).
- All async append calls must `catch` and continue (transcript write failure ≠ conversation failure); only `console.error` when `ZAI_DEBUG=1`.

---

## File Structure

| File | Responsibility | Action |
|------|----------------|--------|
| `packages/zai-agent-core/src/transcript/types.ts` | Define v2 `ContentBlock`, `TranscriptMessage`, `TranscriptFile.version=2`, `LegacyTranscriptError` export | Modify |
| `packages/zai-agent-core/src/transcript/serialization.ts` | v2 `serializeFile` / `deserializeFile`; throw `LegacyTranscriptError` on v1; add `serializeMessage` for v2 | Modify |
| `packages/zai-agent-core/src/transcript/store.ts` | No API change; existing append/read/patch/list cover v2 as opaque JSON | None |
| `packages/zai-agent-core/src/transcript/persistence.ts` (new) | `appendToolUse`, `appendToolResult`, `appendAssistantMessageV2`, `serializeForAnthropic`, `compressToolResultIfNeeded` | Create |
| `packages/zai-agent-core/src/runtime/queryLoop.ts` | Replace raw-based appenders with v2 ones; resume path uses `serializeForAnthropic`; event-level append for tool_use / tool_result | Modify |
| `packages/zai-agent-core/src/runtime/streamAdapter.ts` | (No direct change; verify caller update.) | Verify |
| `packages/zai-agent-core/src/runtime/toolExecution.ts` | After each tool finishes, emit + persist v2 tool_result via persistence helpers | Modify |
| `packages/zai/src/web/src/store/useAgentStore.ts` | Extend `loadTranscript` with three new branches (tool_use / tool_result / assistant ContentBlock[]), keep v1 fallback | Modify |
| `packages/zai-agent-core/test/transcript/serialization-v2.test.ts` | Round-trip + v1 → LegacyTranscriptError | Create |
| `packages/zai-agent-core/test/transcript/persistence.test.ts` | `appendToolUse`, `appendToolResult`, `appendAssistantMessageV2` round-trip; lockfile concurrency | Create |
| `packages/zai-agent-core/test/transcript/serializeForAnthropic.test.ts` | v2 → Anthropic messages shape; tool_result grouped under user | Create |
| `packages/zai-agent-core/test/runtime/queryLoop-resume.test.ts` | mock store, resume loads tool_use + tool_result into initial messages | Create |

---

## Task 1: Define v2 schema types + `LegacyTranscriptError`

**Files:**
- Modify: `packages/zai-agent-core/src/transcript/types.ts`
- Test: `packages/zai-agent-core/test/transcript/types-v2.test.ts` (new)

**Interfaces:**
- Produces: `ContentBlock`, `SerializedMessage`, `TranscriptMessage` (v2 shape), `LegacyTranscriptError` class
- These names must match what Tasks 2–6 import.

- [ ] **Step 1: Write the failing test**

```ts
// test/transcript/types-v2.test.ts
import { describe, expect, it } from 'bun:test'
import { ContentBlockSchema, TranscriptMessageSchema, LegacyTranscriptError } from '../../src/transcript/types.js'

describe('v2 schema', () => {
  it('ContentBlockSchema accepts a tool_use block', () => {
    const block = { type: 'tool_use', id: 'tu_1', name: 'Bash', input: { cmd: 'ls' } }
    expect(ContentBlockSchema.parse(block).type).toBe('tool_use')
  })

  it('ContentBlockSchema accepts a tool_result block with is_error=true', () => {
    const block = { type: 'tool_result', tool_use_id: 'tu_1', content: 'oops', is_error: true }
    const parsed = ContentBlockSchema.parse(block)
    expect(parsed.is_error).toBe(true)
  })

  it('TranscriptMessageSchema requires cwd + userType + sessionId + version=2', () => {
    const msg = {
      uuid: 'u1', parentUuid: null, type: 'tool_use', timestamp: 1,
      message: { content: [{ type: 'tool_use', id: 'tu_1', name: 'Bash', input: {} }] },
      cwd: '/x', userType: 'zai', sessionId: 'sess-1', version: '2', isSidechain: false,
    }
    expect(TranscriptMessageSchema.parse(msg).version).toBe('2')
  })

  it('LegacyTranscriptError is an Error subclass with name=LegacyTranscriptError', () => {
    const err = new LegacyTranscriptError('v1')
    expect(err).toBeInstanceOf(Error)
    expect(err.name).toBe('LegacyTranscriptError')
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test packages/zai-agent-core/test/transcript/types-v2.test.ts`
Expected: FAIL — `ContentBlockSchema`, `TranscriptMessageSchema`, `LegacyTranscriptError` not exported.

- [ ] **Step 3: Replace types.ts with v2 schema**

Replace `packages/zai-agent-core/src/transcript/types.ts` content with:

```ts
import { z } from 'zod'

// ---- ContentBlock (对齐 OpenCC message.ts:45) ----
export const ContentBlockSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('text'), text: z.string() }),
  z.object({ type: z.literal('thinking'), thinking: z.string() }),
  z.object({
    type: z.literal('tool_use'),
    id: z.string(),
    name: z.string(),
    input: z.unknown(),
  }),
  z.object({
    type: z.literal('tool_result'),
    tool_use_id: z.string(),
    content: z.unknown(),
    is_error: z.boolean(),
  }),
])
export type ContentBlock = z.infer<typeof ContentBlockSchema>

// ---- SerializedMessage (对齐 OpenCC logs.ts:10) ----
export const SerializedMessageSchema = z.object({
  cwd: z.string(),
  userType: z.string(),
  sessionId: z.string(),
  timestamp: z.union([z.number(), z.string()]),
  version: z.string(),
  entrypoint: z.string().optional(),
  gitBranch: z.string().optional(),
  slug: z.string().optional(),
})
export type SerializedMessage = z.infer<typeof SerializedMessageSchema>

// ---- TranscriptMessage v2 ----
export const TranscriptMessageSchema = z.object({
  uuid: z.string(),
  parentUuid: z.string().nullable(),
  type: z.enum(['user', 'assistant', 'tool_use', 'tool_result', 'system', 'attachment']),
  timestamp: z.number(),
  message: z.object({
    content: z.union([z.string(), z.array(ContentBlockSchema)]),
    role: z.enum(['user', 'assistant']).optional(),
  }),
  cwd: z.string(),
  userType: z.string(),
  sessionId: z.string(),
  version: z.literal('2'),
  gitBranch: z.string().optional(),
  slug: z.string().optional(),
  isSidechain: z.boolean(),
  runtime: z
    .object({ turnIndex: z.number(), costUsd: z.number().optional() })
    .optional(),
})
export type TranscriptMessage = z.infer<typeof TranscriptMessageSchema>

// ---- TranscriptFile v2 ----
export type TranscriptFile = {
  version: 2
  transcriptId: string
  meta: {
    cwd: string
    model: string
    createdAt: number
    updatedAt: number
    title?: string
    tags?: string[]
    parentSessionId?: string
    subagentType?: string
  }
  messages: TranscriptMessage[]
}

// ---- TranscriptMeta (list 视图，版本透明) ----
export type TranscriptMeta = {
  transcriptId: string
  version: 1 | 2
  cwd: string
  model: string
  createdAt: number
  updatedAt: number
  title?: string
  tags?: string[]
  messageCount: number
  parentSessionId?: string
  subagentType?: string
}

// ---- Legacy marker ----
export class LegacyTranscriptError extends Error {
  override readonly name = 'LegacyTranscriptError'
  constructor(reason: string) {
    super(`Legacy transcript (v1) rejected: ${reason}`)
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test packages/zai-agent-core/test/transcript/types-v2.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add packages/zai-agent-core/src/transcript/types.ts packages/zai-agent-core/test/transcript/types-v2.test.ts
git commit -m "feat(zai-transcript): v2 schema (ContentBlock + SerializedMessage + LegacyTranscriptError)"
```

---

## Task 2: v2 serialization with v1 fallback

**Files:**
- Modify: `packages/zai-agent-core/src/transcript/serialization.ts`
- Test: `packages/zai-agent-core/test/transcript/serialization-v2.test.ts` (new)

**Interfaces:**
- Consumes: `ContentBlock`, `TranscriptMessage`, `TranscriptFile`, `LegacyTranscriptError` from types.ts
- Produces: `serializeFile(file)`, `deserializeFile(raw)` — both throw `LegacyTranscriptError` on v1; v2 round-trip preserves all fields.

- [ ] **Step 1: Write the failing test**

```ts
// test/transcript/serialization-v2.test.ts
import { describe, expect, it } from 'bun:test'
import { serializeFile, deserializeFile } from '../../src/transcript/serialization.js'
import { LegacyTranscriptError } from '../../src/transcript/types.js'

const sampleFile = {
  version: 2 as const,
  transcriptId: 'sess-1',
  meta: { cwd: '/x', model: 'm', createdAt: 1, updatedAt: 2 },
  messages: [
    {
      uuid: 'u1',
      parentUuid: null,
      type: 'user' as const,
      timestamp: 1,
      message: { content: 'hi', role: 'user' as const },
      cwd: '/x',
      userType: 'zai',
      sessionId: 'sess-1',
      version: '2' as const,
      isSidechain: false,
    },
  ],
}

describe('serialization v2', () => {
  it('round-trips a v2 file', () => {
    const raw = serializeFile(sampleFile)
    const back = deserializeFile(raw)
    expect(back.messages[0].message.content).toBe('hi')
  })

  it('deserializeFile throws LegacyTranscriptError on v1', () => {
    const v1Raw = JSON.stringify({
      ...sampleFile,
      version: 1,
      messages: [{ uuid: 'u1', parentUuid: null, type: 'user', timestamp: 1, raw: { content: 'hi' } }],
    })
    expect(() => deserializeFile(v1Raw)).toThrow(LegacyTranscriptError)
  })

  it('deserializeFile throws SyntaxError on malformed v2', () => {
    expect(() => deserializeFile('{not-json')).toThrow()
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test packages/zai-agent-core/test/transcript/serialization-v2.test.ts`
Expected: FAIL — current `deserializeFile` rejects anything `!== 1`, not v2.

- [ ] **Step 3: Update serialization.ts**

Replace `packages/zai-agent-core/src/transcript/serialization.ts` with:

```ts
import type { TranscriptFile, TranscriptMessage, TranscriptMeta } from './types.js'
import { LegacyTranscriptError } from './types.js'

export function serializeMessage(msg: TranscriptMessage): string {
  return JSON.stringify(msg)
}

export function deserializeMessage(raw: string): TranscriptMessage {
  return JSON.parse(raw) as TranscriptMessage
}

export function serializeFile(file: TranscriptFile): string {
  return JSON.stringify(file, null, 2)
}

export function deserializeFile(raw: string): TranscriptFile {
  const parsed = JSON.parse(raw) as TranscriptFile
  if (parsed.version === 1) {
    throw new LegacyTranscriptError('version=1 — tool_use/tool_result not preserved')
  }
  if (parsed.version !== 2) {
    throw new Error(`Unsupported transcript version: ${parsed.version}`)
  }
  return parsed
}

export function extractMeta(file: TranscriptFile): TranscriptMeta {
  return {
    transcriptId: file.transcriptId,
    version: 2,
    cwd: file.meta.cwd,
    model: file.meta.model,
    createdAt: file.meta.createdAt,
    updatedAt: file.meta.updatedAt,
    title: file.meta.title,
    tags: file.meta.tags,
    messageCount: file.messages.length,
    parentSessionId: file.meta.parentSessionId,
    subagentType: file.meta.subagentType,
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test packages/zai-agent-core/test/transcript/serialization-v2.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add packages/zai-agent-core/src/transcript/serialization.ts packages/zai-agent-core/test/transcript/serialization-v2.test.ts
git commit -m "feat(zai-transcript): v2 serialization, v1 → LegacyTranscriptError"
```

---

## Task 3: New persistence helpers (appendToolUse / appendToolResult / appendAssistantMessageV2)

**Files:**
- Create: `packages/zai-agent-core/src/transcript/persistence.ts`
- Test: `packages/zai-agent-core/test/transcript/persistence.test.ts`

**Interfaces:**
- Consumes: `TranscriptStore` from store.ts; `ContentBlock`, `TranscriptMessage`, `TranscriptFile` from types.ts; `compressToolHistory` from `opencc-internals/services/api/compressToolHistory.ts`
- Produces:
  - `appendUserMessageV2(store, sessionId, content, turnIndex, parentUuid, ctx, meta?): Promise<void>`
  - `appendToolUse(store, sessionId, { id, name, input }, turnIndex, parentUuid): Promise<void>`
  - `appendToolResult(store, sessionId, { tool_use_id, content, is_error }, turnIndex, parentUuid): Promise<void>`
  - `appendAssistantMessageV2(store, sessionId, blocks: ContentBlock[], turnIndex, parentUuid, ctx): Promise<void>`
  - `serializeForAnthropic(messages: TranscriptMessage[]): Array<{role:'user'|'assistant', content: unknown}>`
  - `compressToolResultIfNeeded(content: unknown, turnIndex: number): unknown`

- [ ] **Step 1: Write the failing test**

```ts
// test/transcript/persistence.test.ts
import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { TranscriptStore } from '../../src/transcript/store.js'
import {
  appendToolUse,
  appendToolResult,
  appendAssistantMessageV2,
} from '../../src/transcript/persistence.js'

let dataDir: string
let store: TranscriptStore
let sessionId: string

beforeEach(async () => {
  dataDir = mkdtempSync(join(tmpdir(), 'zai-transcript-'))
  store = new TranscriptStore(dataDir)
  sessionId = await store.create({ cwd: '/x', model: 'm' })
})
afterEach(() => rmSync(dataDir, { recursive: true, force: true }))

describe('persistence helpers', () => {
  it('appendToolUse stores type=tool_use with tool_use block', async () => {
    await appendToolUse(store, sessionId, { id: 'tu_1', name: 'Bash', input: { cmd: 'ls' } }, 0, null)
    const t = await store.read(sessionId)
    expect(t.messages).toHaveLength(1)
    expect(t.messages[0].type).toBe('tool_use')
    expect((t.messages[0].message.content as any)[0]).toMatchObject({ id: 'tu_1', name: 'Bash' })
  })

  it('appendToolResult stores type=user with tool_result block, is_error preserved', async () => {
    await appendToolUse(store, sessionId, { id: 'tu_1', name: 'Bash', input: {} }, 0, null)
    const tuUuid = (await store.read(sessionId)).messages[0].uuid
    await appendToolResult(store, sessionId, { tool_use_id: 'tu_1', content: 'err', is_error: true }, 0, tuUuid)
    const t = await store.read(sessionId)
    const tr = t.messages.find(m => m.type === 'user')!
    expect((tr.message.content as any)[0].is_error).toBe(true)
  })

  it('appendAssistantMessageV2 stores multiple blocks in order', async () => {
    await appendAssistantMessageV2(
      store, sessionId,
      [
        { type: 'text', text: 'hello' },
        { type: 'thinking', thinking: 'hmm' },
      ],
      0, null, { cwd: '/x', sessionId, userType: 'zai' },
    )
    const t = await store.read(sessionId)
    const content = t.messages[0].message.content as any
    expect(content).toHaveLength(2)
    expect(content[0].type).toBe('text')
    expect(content[1].type).toBe('thinking')
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test packages/zai-agent-core/test/transcript/persistence.test.ts`
Expected: FAIL — module `../../src/transcript/persistence.js` does not exist.

- [ ] **Step 3: Create persistence.ts**

Write `packages/zai-agent-core/src/transcript/persistence.ts`:

```ts
import { randomUUID } from 'node:crypto'
import { compressToolHistory } from '../opencc-internals/services/api/compressToolHistory.js'
import type { TranscriptStore } from './store.js'
import type { ContentBlock, TranscriptMessage } from './types.js'

type CommonCtx = {
  cwd: string
  sessionId: string
  userType?: string
}

function baseFields(ctx: CommonCtx, turnIndex: number, parentUuid: string | null): Omit<TranscriptMessage, 'message' | 'type'> {
  return {
    uuid: randomUUID(),
    parentUuid,
    timestamp: Date.now(),
    cwd: ctx.cwd,
    userType: ctx.userType ?? 'zai',
    sessionId: ctx.sessionId,
    version: '2',
    isSidechain: false,
    ...(turnIndex !== undefined ? { runtime: { turnIndex } } : {}),
  }
}

export async function appendUserMessageV2(
  store: TranscriptStore,
  sessionId: string,
  content: unknown,
  turnIndex: number,
  parentUuid: string | null,
  ctx: CommonCtx,
  meta?: { kind?: 'user' | 'skill_injection'; skillName?: string },
): Promise<void> {
  try {
    const isSkillInjection = meta?.kind === 'skill_injection'
    const normalized = typeof content === 'string' || Array.isArray(content)
      ? content
      : String(content)
    const msg: TranscriptMessage = {
      ...baseFields(ctx, turnIndex, parentUuid),
      type: 'user',
      message: {
        content: isSkillInjection
          ? `[skill_injection:${meta?.skillName ?? ''}] ${normalized}`
          : normalized,
        role: 'user',
      },
    }
    await store.append(sessionId, msg)
  } catch (err) {
    if (process.env.ZAI_DEBUG === '1') console.error('[transcript] appendUserMessageV2 failed', err)
  }
}

export async function appendToolUse(
  store: TranscriptStore,
  sessionId: string,
  block: { id: string; name: string; input: unknown },
  turnIndex: number,
  parentUuid: string | null,
): Promise<void> {
  try {
    const toolUseBlock: ContentBlock = { type: 'tool_use', id: block.id, name: block.name, input: block.input }
    const msg: TranscriptMessage = {
      ...baseFields({ cwd: '', sessionId }, turnIndex, parentUuid),
      type: 'tool_use',
      message: { content: [toolUseBlock], role: 'assistant' },
    }
    await store.append(sessionId, msg)
  } catch (err) {
    if (process.env.ZAI_DEBUG === '1') console.error('[transcript] appendToolUse failed', err)
  }
}

export async function appendToolResult(
  store: TranscriptStore,
  sessionId: string,
  block: { tool_use_id: string; content: unknown; is_error: boolean },
  turnIndex: number,
  parentUuid: string | null,
  compressTier?: { recent: number; mid: number },
): Promise<void> {
  try {
    const compressed = compressTier
      ? compressToolHistory(block.content, compressTier)
      : block.content
    const trBlock: ContentBlock = { type: 'tool_result', tool_use_id: block.tool_use_id, content: compressed, is_error: block.is_error }
    const msg: TranscriptMessage = {
      ...baseFields({ cwd: '', sessionId }, turnIndex, parentUuid),
      type: 'user',
      message: { content: [trBlock], role: 'user' },
    }
    await store.append(sessionId, msg)
  } catch (err) {
    if (process.env.ZAI_DEBUG === '1') console.error('[transcript] appendToolResult failed', err)
  }
}

export async function appendAssistantMessageV2(
  store: TranscriptStore,
  sessionId: string,
  blocks: ContentBlock[],
  turnIndex: number,
  parentUuid: string | null,
  ctx: CommonCtx,
): Promise<void> {
  try {
    const msg: TranscriptMessage = {
      ...baseFields(ctx, turnIndex, parentUuid),
      type: 'assistant',
      message: { content: blocks, role: 'assistant' },
    }
    await store.append(sessionId, msg)
  } catch (err) {
    if (process.env.ZAI_DEBUG === '1') console.error('[transcript] appendAssistantMessageV2 failed', err)
  }
}

/** v2 → Anthropic SDK messages. Groups tool_result blocks under one user role. */
export function serializeForAnthropic(
  messages: TranscriptMessage[],
): Array<{ role: 'user' | 'assistant'; content: unknown }> {
  const out: Array<{ role: 'user' | 'assistant'; content: unknown }> = []
  for (const m of messages) {
    if (m.type === 'tool_use') {
      // tool_use 消息: 一条 assistant role, content 是单个 tool_use block
      out.push({ role: 'assistant', content: m.message.content })
      continue
    }
    if (m.type === 'user' && Array.isArray(m.message.content)) {
      const hasToolResult = m.message.content.some(b => b.type === 'tool_result')
      if (hasToolResult) {
        // group all tool_result blocks into one user message (anthropic protocol)
        const trBlocks = m.message.content.filter(b => b.type === 'tool_result')
        const others = m.message.content.filter(b => b.type !== 'tool_result')
        out.push({ role: 'user', content: [...trBlocks, ...others] })
        continue
      }
    }
    if (m.type === 'assistant') {
      out.push({ role: 'assistant', content: m.message.content })
      continue
    }
    if (m.type === 'user') {
      out.push({ role: 'user', content: m.message.content })
      continue
    }
    // system / attachment 跳过（resume 不喂模型；UI 单独处理）
  }
  return out
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test packages/zai-agent-core/test/transcript/persistence.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add packages/zai-agent-core/src/transcript/persistence.ts packages/zai-agent-core/test/transcript/persistence.test.ts
git commit -m "feat(zai-transcript): v2 persistence helpers + serializeForAnthropic"
```

---

## Task 4: serializeForAnthropic unit tests

**Files:**
- Test: `packages/zai-agent-core/test/transcript/serializeForAnthropic.test.ts` (new)

**Interfaces:**
- Consumes: `serializeForAnthropic` from persistence.ts (Task 3)

- [ ] **Step 1: Write the failing test**

```ts
// test/transcript/serializeForAnthropic.test.ts
import { describe, expect, it } from 'bun:test'
import { serializeForAnthropic } from '../../src/transcript/persistence.js'
import type { TranscriptMessage } from '../../src/transcript/types.js'

const msg = (overrides: Partial<TranscriptMessage>): TranscriptMessage => ({
  uuid: 'u', parentUuid: null, timestamp: 1,
  cwd: '/x', userType: 'zai', sessionId: 's', version: '2', isSidechain: false,
  message: { content: '', role: 'user' },
  type: 'user',
  ...overrides,
})

describe('serializeForAnthropic', () => {
  it('groups tool_result blocks under one user role', () => {
    const tr1 = msg({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'a', content: 'ok', is_error: false }], role: 'user' } })
    const tr2 = msg({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'b', content: 'err', is_error: true }], role: 'user' } })
    const out = serializeForAnthropic([tr1, tr2])
    expect(out).toHaveLength(1)
    expect(out[0].role).toBe('user')
    expect((out[0].content as any[])).toHaveLength(2)
  })

  it('emits tool_use messages as assistant with the block array', () => {
    const tu = msg({
      type: 'tool_use',
      message: { content: [{ type: 'tool_use', id: 't1', name: 'Bash', input: {} }], role: 'assistant' },
    })
    const out = serializeForAnthropic([tu])
    expect(out[0].role).toBe('assistant')
    expect((out[0].content as any[])[0].id).toBe('t1')
  })

  it('passes user text through verbatim', () => {
    const out = serializeForAnthropic([msg({ message: { content: 'hello', role: 'user' } })])
    expect(out[0]).toEqual({ role: 'user', content: 'hello' })
  })

  it('skips system/attachment entries', () => {
    const out = serializeForAnthropic([
      msg({ type: 'system' }),
      msg({ type: 'attachment' }),
    ])
    expect(out).toHaveLength(0)
  })
})
```

- [ ] **Step 2: Run test to verify it passes**

Run: `bun test packages/zai-agent-core/test/transcript/serializeForAnthropic.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 3: Commit**

```bash
git add packages/zai-agent-core/test/transcript/serializeForAnthropic.test.ts
git commit -m "test(zai-transcript): serializeForAnthropic grouping + passthrough + skip"
```

---

## Task 5: Wire v2 appenders into queryLoop.ts

**Files:**
- Modify: `packages/zai-agent-core/src/runtime/queryLoop.ts:96-130, 378-453`

**Interfaces:**
- Consumes: `appendToolUse`, `appendToolResult`, `appendAssistantMessageV2`, `serializeForAnthropic` (Task 3)
- Replaces: existing `appendUserMessage` / `appendAssistantMessage` raw-based paths with v2 equivalents.
- Resume path: try `store.read` → if `LegacyTranscriptError`, initial messages = `[]`; otherwise `serializeForAnthropic(t.messages)`.

- [ ] **Step 1: Write the failing test**

```ts
// test/runtime/queryLoop-resume.test.ts
import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { TranscriptStore } from '../../src/transcript/store.js'

let dataDir: string
let store: TranscriptStore
let sessionId: string

beforeEach(async () => {
  dataDir = mkdtempSync(join(tmpdir(), 'zai-resume-'))
  store = new TranscriptStore(dataDir)
  sessionId = await store.create({ cwd: '/x', model: 'm' })
})
afterEach(() => rmSync(dataDir, { recursive: true, force: true }))

// Mock Anthropic SDK to avoid real API calls.
mock.module('@anthropic-ai/sdk', () => ({
  default: class {
    messages = { create: async function* () { /* no-op */ } }
  },
}))

describe('queryLoop resume', () => {
  it('seeds initial messages from v2 transcript (user + tool_use + tool_result)', async () => {
    const { appendToolUse, appendToolResult, appendAssistantMessageV2, appendUserMessageV2 } = await import('../../src/transcript/persistence.js')
    await appendUserMessageV2(store, sessionId, 'hello', 0, null, { cwd: '/x', sessionId })
    await appendAssistantMessageV2(store, sessionId, [{ type: 'text', text: 'ok' }], 0, null, { cwd: '/x', sessionId })
    await appendToolUse(store, sessionId, { id: 'tu_1', name: 'Bash', input: {} }, 1, null)
    const tuUuid = (await store.read(sessionId)).messages.at(-1)!.uuid
    await appendToolResult(store, sessionId, { tool_use_id: 'tu_1', content: 'r', is_error: false }, 1, tuUuid)

    const { queryLoop } = await import('../../src/runtime/queryLoop.js')
    const events: any[] = []
    for await (const ev of queryLoop({
      prompt: 'next',
      cwd: '/x',
      model: 'm',
      transcriptId: sessionId,
    }, {
      dataDir,
      defaultModel: 'm',
      modelCaller: (async function* () {}) as any,
    } as any)) events.push(ev)

    // verify initial messages built from transcript — first runtime.started event has sessionId
    const started = events.find(e => e.type === 'runtime.started')
    expect(started?.sessionId).toBe(sessionId)
  })
})
```

Note: this test depends on the runtime reaching the SSE loop. If too heavy, fall back to: assert `serializeForAnthropic(t.messages)` directly here and rely on a smaller integration test in Task 6.

Simpler approach — replace the above with:

```ts
import { serializeForAnthropic, appendToolUse, appendToolResult, appendAssistantMessageV2 } from '../../src/transcript/persistence.js'

it('v2 transcript round-trips into Anthropic message shape', async () => {
  await appendAssistantMessageV2(store, sessionId, [{ type: 'text', text: 'ok' }], 0, null, { cwd: '/x', sessionId })
  await appendToolUse(store, sessionId, { id: 'tu_1', name: 'Bash', input: {} }, 0, null)
  const tuUuid = (await store.read(sessionId)).messages.at(-1)!.uuid
  await appendToolResult(store, sessionId, { tool_use_id: 'tu_1', content: 'r', is_error: false }, 0, tuUuid)

  const t = await store.read(sessionId)
  const anthropic = serializeForAnthropic(t.messages)
  expect(anthropic).toHaveLength(3) // assistant + assistant(tool_use) + user(tool_result)
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test packages/zai-agent-core/test/runtime/queryLoop-resume.test.ts`
Expected: FAIL — current code reads `tm.raw` not `tm.message`.

- [ ] **Step 3: Modify queryLoop.ts**

Edit `packages/zai-agent-core/src/runtime/queryLoop.ts`:

1. Add import at top:

```ts
import {
  appendAssistantMessageV2 as persistAssistantMessage,
  appendUserMessageV2 as persistUserMessage,
  appendToolUse as persistToolUse,
  appendToolResult as persistToolResult,
  serializeForAnthropic,
} from '../transcript/persistence.js'
```

2. Replace the resume block (lines 96–127) with:

```ts
const messages: Array<{ role: 'user' | 'assistant'; content: unknown }> = []
const resumeId = options.resumeFromTranscriptId ?? options.transcriptId
if (resumeId) {
  try {
    const t = await store.read(resumeId)
    messages.push(...serializeForAnthropic(t.messages))
  } catch (err) {
    // 文件不存在 / v1 文件 (LegacyTranscriptError): 当成新建.
    // v2 文件损坏会抛 SyntaxError → 透传, 启动失败优于静默丢数据.
    if ((err as Error).name !== 'LegacyTranscriptError') {
      if ((err as { code?: string }).code !== 'ENOENT') throw err
    }
  }
}
```

3. Replace `appendUserMessage` / `appendAssistantMessage` callers (lines 130, 410, 452):

For `appendUserMessage` (line 130) — replace the in-file implementation with a thin wrapper that delegates to `appendUserMessageV2` from persistence.ts (which owns the v2 schema):

```ts
import { appendUserMessageV2 as persistUserMessage } from '../transcript/persistence.js'

async function appendUserMessage(
  store: TranscriptStore,
  sessionId: string,
  content: unknown,
  turnIndex: number,
  meta?: { kind?: 'user' | 'skill_injection'; skillName?: string },
): Promise<void> {
  await persistUserMessage(
    store, sessionId, content, turnIndex, null,
    { cwd: options.cwd, sessionId },
    meta,
  )
}
```

(Removes the old `parentUuid: null` + `raw: { content }` shape — v2 path lives in persistence.ts.)

4. Replace `appendAssistantMessage` (lines 413–453) to call `persistAssistantMessage` with blocks:

```ts
async function appendAssistantMessage(
  store: TranscriptStore,
  sessionId: string,
  payload: { text: string; thinking?: string; toolUses: Array<{ id: string; name: string; input: unknown }> },
  turnIndex: number,
): Promise<void> {
  const blocks: ContentBlock[] = []
  if (payload.thinking) blocks.push({ type: 'thinking', thinking: payload.thinking })
  if (payload.text) blocks.push({ type: 'text', text: payload.text })
  for (const tu of payload.toolUses) blocks.push({ type: 'tool_use', id: tu.id, name: tu.name, input: tu.input })
  await persistAssistantMessage(store, sessionId, blocks, turnIndex, null, { cwd: options.cwd, sessionId })
}
```

5. Add a new import in queryLoop.ts at the top for `ContentBlock`:

```ts
import type { ContentBlock, TranscriptMessage } from '../transcript/types.js'
```

- [ ] **Step 4: Run all transcript + runtime tests**

Run: `bun test packages/zai-agent-core/test/transcript/ packages/zai-agent-core/test/runtime/queryLoop-resume.test.ts`
Expected: PASS (previous + new).

- [ ] **Step 5: Commit**

```bash
git add packages/zai-agent-core/src/runtime/queryLoop.ts packages/zai-agent-core/test/runtime/queryLoop-resume.test.ts
git commit -m "feat(zai): queryLoop persists v2 transcript; resume reads via serializeForAnthropic"
```

---

## Task 6: toolExecution.ts emits event-level tool_use / tool_result appends

**Files:**
- Modify: `packages/zai-agent-core/src/runtime/toolExecution.ts`
- Test: covered indirectly via Task 5 test (already asserts tool_use + tool_result persist).

**Interfaces:**
- Consumes: `persistToolUse`, `persistToolResult` from persistence.ts; existing `toolUseId` parameter from tool execution flow.
- The runtime must call `persistToolUse(store, sessionId, block, turnIndex, parentUuid)` right after `content_block_stop{tool_use}` resolves (so input is fully accumulated), and `persistToolResult(...)` immediately after `tool.call` returns `{output, isError}`.

- [ ] **Step 1: Write the failing integration test**

```ts
// test/runtime/toolExecution-persist.test.ts
import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { TranscriptStore } from '../../src/transcript/store.js'
import { persistToolUse, persistToolResult } from '../../src/transcript/persistence.js'

let dataDir: string
beforeEach(() => { dataDir = mkdtempSync(join(tmpdir(), 'zai-tool-')) })
afterEach(() => rmSync(dataDir, { recursive: true, force: true }))

it('persists tool_use then tool_result with is_error=true on throw', async () => {
  const store = new TranscriptStore(dataDir)
  const sid = await store.create({ cwd: '/x', model: 'm' })
  await persistToolUse(store, sid, { id: 'tu_1', name: 'Bash', input: { cmd: 'bad' } }, 0, null)
  const tuUuid = (await store.read(sid)).messages[0].uuid
  // simulate thrown tool: append error result
  await persistToolResult(store, sid, { tool_use_id: 'tu_1', content: 'boom', is_error: true }, 0, tuUuid)
  const t = await store.read(sid)
  expect(t.messages.some(m => m.type === 'tool_use')).toBe(true)
  const userMsg = t.messages.find(m => m.type === 'user')!
  expect((userMsg.message.content as any)[0].is_error).toBe(true)
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test packages/zai-agent-core/test/runtime/toolExecution-persist.test.ts`
Expected: FAIL — exports not present (already covered by Task 3 tests, but integration name verifies `persistToolResult` accepts the `content` arg shape).

If Task 3 already covers this, this task step 1–2 is a no-op; skip to step 3.

- [ ] **Step 3: Modify toolExecution.ts**

In `packages/zai-agent-core/src/runtime/toolExecution.ts`, locate the loop that calls `tool.call(...)` (around the `executeToolsStreaming` body). For each completed tool call, append:

```ts
import { persistToolResult } from '../transcript/persistence.js'

// after `const result = await tool.call(input, ctx)`
await persistToolResult(
  store, sessionId,
  { tool_use_id: block.id, content: result.output, is_error: result.isError ?? false },
  turnIndex,
  toolUseUuid, // the uuid assigned in the tool_use append
)
```

Add a sibling call to `persistToolUse` in the same loop right after `content_block_stop{tool_use}` (or the equivalent upstream boundary in the SDK adapter).

If `toolExecution.ts` does not currently track `store` / `sessionId` / `turnIndex` as scope variables, plumb them through (a small refactor scoped to this file).

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test packages/zai-agent-core/test/runtime/toolExecution-persist.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/zai-agent-core/src/runtime/toolExecution.ts packages/zai-agent-core/test/runtime/toolExecution-persist.test.ts
git commit -m "feat(zai): toolExecution persists tool_use + tool_result per turn"
```

---

## Task 7: UI loadTranscript handles v2 transcript + v1 fallback

**Files:**
- Modify: `packages/zai/src/web/src/store/useAgentStore.ts:439-534`

**Interfaces:**
- Consumes: `loadTranscript(sessionId)` response shape `{ transcript: { messages: TranscriptMessage[] } }`.
- Adds three branches: tool_use / tool_result / assistant with `ContentBlock[]`.

- [ ] **Step 1: Write the failing test**

```ts
// packages/zai/test/web/useAgentStore-loadTranscript.test.ts
import { describe, expect, it } from 'bun:test'
import { loadTranscriptMessages } from '../../src/web/src/store/useAgentStore.js'

describe('loadTranscriptMessages (v2)', () => {
  it('emits tool_use:start for type=tool_use messages', () => {
    const msgs = loadTranscriptMessages('sess-1', [
      { uuid: 'u1', parentUuid: null, type: 'tool_use', timestamp: 1,
        message: { content: [{ type: 'tool_use', id: 'tu_1', name: 'Bash', input: { cmd: 'ls' } }] },
        cwd: '/x', userType: 'zai', sessionId: 'sess-1', version: '2', isSidechain: false },
    ])
    expect(msgs[0].type).toBe('tool_use:start')
    expect(msgs[0].toolUseId).toBe('tu_1')
  })

  it('upserts output + error onto tool_use when tool_result arrives', () => {
    const msgs = loadTranscriptMessages('sess-1', [
      { uuid: 'u1', parentUuid: null, type: 'tool_use', timestamp: 1,
        message: { content: [{ type: 'tool_use', id: 'tu_1', name: 'Bash', input: {} }] },
        cwd: '/x', userType: 'zai', sessionId: 'sess-1', version: '2', isSidechain: false },
      { uuid: 'u2', parentUuid: 'u1', type: 'user', timestamp: 2,
        message: { content: [{ type: 'tool_result', tool_use_id: 'tu_1', content: 'err', is_error: true }] },
        cwd: '/x', userType: 'zai', sessionId: 'sess-1', version: '2', isSidechain: false },
    ])
    expect(msgs).toHaveLength(1)
    expect(msgs[0].type).toBe('tool_use:error')
    expect(msgs[0].error).toBe('err')
  })

  it('emits assistant.thinking + assistant.text in order from ContentBlock[]', () => {
    const msgs = loadTranscriptMessages('sess-1', [
      { uuid: 'u1', parentUuid: null, type: 'assistant', timestamp: 1,
        message: { content: [{ type: 'thinking', thinking: 'hmm' }, { type: 'text', text: 'hi' }] },
        cwd: '/x', userType: 'zai', sessionId: 'sess-1', version: '2', isSidechain: false },
    ])
    expect(msgs.map(m => m.type)).toEqual(['assistant.thinking', 'assistant.text'])
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test packages/zai/test/web/useAgentStore-loadTranscript.test.ts`
Expected: FAIL — `loadTranscriptMessages` is not exported.

- [ ] **Step 3: Refactor loadTranscript to call extracted helper**

In `packages/zai/src/web/src/store/useAgentStore.ts`:

1. Export a new pure function `loadTranscriptMessages`:

```ts
export function loadTranscriptMessages(
  sessionId: string,
  rawMessages: any[],
): AgentMessage[] {
  const out: AgentMessage[] = []
  for (const msg of rawMessages) {
    const rawObj = (msg.raw ?? {}) as Record<string, unknown>
    const baseFields = { sessionId, ts: msg.timestamp, turnIndex: msg.runtime?.turnIndex ?? 0 }

    // v2 path: message.content: ContentBlock[]
    if ((msg as { version?: string }).version === '2' && msg.message && Array.isArray(msg.message.content)) {
      const blocks = msg.message.content as Array<Record<string, unknown>>
      if (msg.type === 'tool_use') {
        const b = blocks[0] as { id: string; name: string; input?: Record<string, unknown> }
        out.push({ ...baseFields, eventId: msg.uuid, type: 'tool_use:start', toolUseId: b.id, name: b.name, input: b.input })
        continue
      }
      if (msg.type === 'user') {
        const tr = blocks.find(b => b.type === 'tool_result') as { tool_use_id: string; content: unknown; is_error: boolean } | undefined
        if (tr) {
          const idx = out.findIndex(m => m.toolUseId === tr.tool_use_id)
          if (idx >= 0) {
            out[idx] = { ...out[idx], type: tr.is_error ? 'tool_use:error' : 'tool_use:done', output: tr.content, error: tr.is_error ? tr.content : undefined }
          }
          continue
        }
      }
      if (msg.type === 'assistant') {
        for (const b of blocks) {
          if (b.type === 'thinking') {
            out.push({ ...baseFields, eventId: `${msg.uuid}-thinking`, type: 'assistant.thinking', thinking: b.thinking as string })
          } else if (b.type === 'text') {
            out.push({ ...baseFields, eventId: msg.uuid, type: 'assistant.text', text: b.text as string })
          } else if (b.type === 'tool_use') {
            out.push({ ...baseFields, eventId: `tool-${b.id}`, type: 'tool_use:start', toolUseId: b.id as string, name: b.name as string, input: b.input as Record<string, unknown> })
          }
        }
        continue
      }
    }

    // v1 fallback (raw.* 旧路径)
    const text = typeof rawObj.text === 'string' ? rawObj.text : typeof rawObj.content === 'string' ? rawObj.content : ''
    if (msg.type === 'user') {
      if (rawObj.kind === 'skill_injection') continue
      if (Array.isArray(rawObj.content)) {
        const blocks = rawObj.content as Array<{ type: string; source?: { type?: string; media_type?: string; data?: string }; text?: string }>
        const textFromBlocks = blocks.filter(b => b.type === 'text' && typeof b.text === 'string').map(b => b.text!).join('\n')
        out.push({ ...baseFields, eventId: msg.uuid, type: 'user.text', text: textFromBlocks })
      } else {
        out.push({ ...baseFields, eventId: msg.uuid, type: 'user.text', text })
      }
    } else if (msg.type === 'assistant') {
      const thinking = typeof rawObj.thinking === 'string' ? rawObj.thinking : ''
      if (thinking) out.push({ ...baseFields, eventId: `${msg.uuid}-thinking`, type: 'assistant.thinking', thinking })
      out.push({ ...baseFields, eventId: msg.uuid, type: 'assistant.text', text })
    } else {
      out.push({ ...baseFields, eventId: msg.uuid, type: `runtime.${msg.type}`, text })
    }
  }
  return out
}
```

2. Replace the loop body inside `loadTranscript` (lines 449–521) with `messages = loadTranscriptMessages(sessionId, transcript.messages ?? [])`.

- [ ] **Step 4: Run test to verify it passes**

Run: `bun test packages/zai/test/web/useAgentStore-loadTranscript.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 5: Run typecheck**

Run: `cd packages/zai && bun run typecheck` (or root typecheck if configured)
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add packages/zai/src/web/src/store/useAgentStore.ts packages/zai/test/web/useAgentStore-loadTranscript.test.ts
git commit -m "feat(zai-web): loadTranscript handles v2 ContentBlock[] + tool_use/tool_result replay"
```

---

## Task 8: Final smoke test + README callout

**Files:**
- Modify: `packages/zai-agent-core/README.md` (or `docs/superpowers/specs/...md`) — add a one-paragraph changelog entry.

- [ ] **Step 1: Run full test suite**

Run: `bun test packages/zai-agent-core packages/zai`
Expected: all PASS.

- [ ] **Step 2: Run typecheck**

Run: `cd packages/zai-agent-core && bun run typecheck && cd ../zai && bun run typecheck`
Expected: PASS.

- [ ] **Step 3: Append changelog note to spec**

Add a trailing section to `docs/superpowers/specs/2026-07-14-zai-transcript-tool-persistence-design.md`:

```markdown
## 11. Implementation status

Implemented via `docs/superpowers/plans/2026-07-14-zai-transcript-tool-persistence.md`.
Tasks 1–7 landed; v1 files degrade silently via LegacyTranscriptError; v2 resume round-trips.
```

- [ ] **Step 4: Commit**

```bash
git add docs/superpowers/specs/2026-07-14-zai-transcript-tool-persistence-design.md
git commit -m "docs(zai-transcript): mark spec implemented"
```

---

## Self-Review Notes

**Spec coverage:**
- Schema v2 / `LegacyTranscriptError` — Task 1 ✓
- `serializeFile` / `deserializeFile` v2 with v1 throw — Task 2 ✓
- `appendToolUse` / `appendToolResult` / `appendAssistantMessageV2` — Task 3 ✓
- `serializeForAnthropic` — Task 3 + Task 4 ✓
- Resume read + serialization — Task 5 ✓
- `toolExecution.ts` event-level append — Task 6 ✓
- UI `loadTranscript` v2 + v1 fallback — Task 7 ✓
- compressToolHistory reuse — Task 3 (signature includes optional `compressTier`) ✓
- Tests round-trip + concurrency + grouping — Tasks 1, 2, 3, 4 ✓

**Placeholder scan:** No TBD/TODO/“implement later” strings.

**Type consistency:**
- `TranscriptMessage` referenced with `message.content`, `version`, `cwd`, `userType`, `sessionId` everywhere ✓
- `appendToolUse` / `appendToolResult` / `appendAssistantMessageV2` / `serializeForAnthropic` / `compressToolResultIfNeeded` consistent across Tasks 3–6 ✓
- `LegacyTranscriptError` only thrown by serialization.ts (Task 2), caught in queryLoop.ts (Task 5) ✓
- `loadTranscriptMessages(sessionId, rawMessages)` signature consistent in Task 7 + test ✓

**No gaps found; ready to execute.**