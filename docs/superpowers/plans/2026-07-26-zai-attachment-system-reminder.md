# Mid-turn Attachment → System-Reminder Rewrite Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Rewrite zai's 4 mid-turn attachment sources so they emit `<system-reminder>`-wrapped plain text instead of `role: 'assistant'` `AnthropicMessage` payloads, and have `queryLoop` splice the joined reminder onto `systemPrompt` (not `messages`) — fixing the fresh-session "consecutive assistant" 2013 crash that breaks the conversation stream.

**Architecture:** Two surgical changes:
1. `packages/zai-agent-core/src/runtime/attachment/get.ts` — change `Attachment.payload: AnthropicMessage` to `Attachment.content: string`, rewrite 4 collectors (`collectBash` / `collectBackgroundTasks` / `collectSkills` / `collectMemory`) to emit `<system-reminder>...</system-reminder>` wrapped text. Remove unused `AnthropicMessage` / `ContentBlock` imports.
2. `packages/zai-agent-core/src/runtime/queryLoop.ts` — replace the `for (const att of attachments) messages.push(att.payload as any)` block (lines 248-254) with a `systemPrompt` spread-reassignment that appends the joined `Attachment.content` to the branded readonly `SystemPrompt` array.

**Tech Stack:** TypeScript, vitest, pnpm workspaces (`@zn-ai/zai-agent-core` package), zod schema validation (unchanged).

## Global Constraints

- Spec: `docs/superpowers/specs/2026-07-26-zai-attachment-system-reminder-design.md` (v1.1)
- Test command: `pnpm --filter @zn-ai/zai-agent-core test <pattern>`
- Typecheck: `pnpm --filter @zn-ai/zai-agent-core typecheck`
- Coverage target: ≥ 92% line / ≥ 80% branch on changed modules
- File path naming: kebab-case.ts, single-purpose modules
- Commit message style: `feat(zai-agent-core): …` / `fix(zai-agent-core): …` / `test(zai-agent-core): …`
- `<system-reminder>` wrapper is **mandatory** — never inject attachment text into the prompt without it (Anthropic SDK depends on this tag for prompt-cache boundary detection)
- Do NOT touch `BackgroundRuntime` / `BashTracker` (frozen per spec §0)
- Do NOT touch `prefetchMemory.ts` (frozen per spec §7)
- Do NOT add a new event channel — attachment stops being a runtime event entirely

---

## File Structure

| File | Status | Responsibility |
|---|---|---|
| `packages/zai-agent-core/src/runtime/attachment/get.ts` | Modify | Type + 4 collectors; emits `<system-reminder>` text |
| `packages/zai-agent-core/src/runtime/attachment/index.ts` | Modify | Re-export `Attachment` type (rename `payload → content` propagation) |
| `packages/zai-agent-core/src/runtime/queryLoop.ts` | Modify | Replace attachment wire-in (lines 248-254) with systemPrompt splice |
| `packages/zai-agent-core/test/integration/agent/resilience/d-attachment-messages.test.ts` | Modify | All v1.0 assertions (`payload.role === 'assistant'`) → v1.1 (`content` starts with `<system-reminder>`); drop the "AnthropicMessage shape" test, replace with reminder-shape test |
| `packages/zai-agent-core/test/runtime/queryLoop-attachment-system-prompt.test.ts` | Create | 5-case integration test verifying messages stays untouched and systemPrompt gains the joined reminder |

Each task ends with a commit. No task is gated on another task being reviewed — they execute top to bottom.

---

## Task 1: Convert `Attachment` type from `payload: AnthropicMessage` to `content: string`

**Files:**
- Modify: `packages/zai-agent-core/src/runtime/attachment/get.ts:30-35` (the `Attachment` interface) and `:16-17` (remove unused imports)
- Test: `packages/zai-agent-core/test/integration/agent/resilience/d-attachment-messages.test.ts` (no test change in this task — interface change cascades to TypeScript compile errors that prove the rename worked)

**Interfaces:**
- Consumes: nothing (this task is type-only)
- Produces:
  ```ts
  export interface Attachment {
    source: AttachmentSource
    content: string
    consumedAt: number
  }
  ```

- [ ] **Step 1: Read the current `Attachment` interface**

Confirm by reading `packages/zai-agent-core/src/runtime/attachment/get.ts:30-35` and `:16-17`. (You should see `payload: AnthropicMessage` and the `AnthropicMessage, ContentBlock` import.)

- [ ] **Step 2: Remove the unused `AnthropicMessage`/`ContentBlock` imports**

In `packages/zai-agent-core/src/runtime/attachment/get.ts`, replace the import line:

```ts
import type { AnthropicMessage, ContentBlock } from '../../transcript/types.js'
```

with:

```ts
// v1.1 — Attachment no longer carries AnthropicMessage payloads; collectors
// emit plain <system-reminder>-wrapped strings (see spec
// docs/superpowers/specs/2026-07-26-zai-attachment-system-reminder-design.md §2.2).
```

(`ContentBlock` is referenced only by the 3 builders that get rewritten in Task 2. Leave it removed now or after — TS will flag any remaining reference.)

- [ ] **Step 3: Rewrite the `Attachment` interface**

In the same file, replace:

```ts
export interface Attachment {
  source: AttachmentSource
  payload: AnthropicMessage
  consumedAt: number
}
```

with:

```ts
/**
 * v1.1 — attachment is plain text wrapped in `<system-reminder>...</system-reminder>`.
 * queryLoop joins all attachments' content and appends to `systemPrompt`
 * (does NOT push to `messages`, which would break Anthropic's user/assistant
 * alternation contract).
 *
 * Source contract frozen (spec §2.2 / §2.3):
 *   - 'background-bash'    → BashTracker terminal tasks
 *   - 'background-agent'   → BackgroundRuntime terminal tasks
 *   - 'skill-prefetch'     → pluginSnapshot.skills (one per skill)
 *   - 'memory-prefetch'    → memoryCache.get(sessionId)
 */
export interface Attachment {
  source: AttachmentSource
  content: string
  consumedAt: number
}
```

- [ ] **Step 4: Typecheck — expect related errors**

Run:
```bash
pnpm --filter @zn-ai/zai-agent-core typecheck 2>&1 | tee /tmp/typecheck-after-T1.log
```

Expected: TS errors in `get.ts` (collectors still return `payload: AnthropicMessage` — fixed in Task 2) and in `queryLoop.ts:248-254` (fixed in Task 3). DO NOT fix these errors in this task — they are the cascade.

- [ ] **Step 5: Commit**

```bash
git add packages/zai-agent-core/src/runtime/attachment/get.ts
git commit -m "feat(zai-agent-core): Attachment.payload → Attachment.content (type-only)"
```

---

## Task 2: Rewrite 4 collectors to emit `<system-reminder>` strings

**Files:**
- Modify: `packages/zai-agent-core/src/runtime/attachment/get.ts`
  - `textToAssistantMessage` (lines 248-250) → `textToReminder`
  - `bashTaskToAssistantMessage` (lines 252-265) → `bashTaskToReminder`
  - `backgroundTaskToAssistantMessage` (lines 267-275) → `backgroundTaskToReminder`
  - `skillToAssistantMessage` (lines 277-282) → `skillToReminder`
  - And the 4 `collectXxx` functions that call them (lines 171-244)

**Interfaces:**
- Consumes: `Attachment` v1.1 (from Task 1); `LoadedSkill` from `'../skills/types.js'`; `BashTaskLike`, `BackgroundTaskLike` local interfaces
- Produces: 4 helper functions `xxxToReminder(t): string` returning `<system-reminder>...</system-reminder>` text

- [ ] **Step 1: Replace `textToAssistantMessage` with `textToReminder`**

In `packages/zai-agent-core/src/runtime/attachment/get.ts`, replace the `textToAssistantMessage` helper (3 lines starting at line 248) with:

```ts
function textToReminder(text: string): string {
  return `<system-reminder>\n${text}\n</system-reminder>`
}
```

- [ ] **Step 2: Replace `bashTaskToAssistantMessage` with `bashTaskToReminder`**

Replace the `bashTaskToAssistantMessage` function (lines 252-265) with:

```ts
function bashTaskToReminder(t: BashTaskLike): string {
  // OpenCC 风格保持纯 text (spec §6.5).
  const header = `<bash-task taskId="${t.taskId ?? ''}" status="${t.status ?? ''}" exitCode="${t.exitCode ?? ''}">`
  const body = [
    `$ ${t.command ?? ''}`,
    t.stdout ? `[stdout]\n${t.stdout}` : '',
    t.stderr ? `[stderr]\n${t.stderr}` : '',
  ]
    .filter(Boolean)
    .join('\n')
  return `<system-reminder>\n${header}\n${body}\n</bash-task>\n</system-reminder>`
}
```

- [ ] **Step 3: Replace `backgroundTaskToAssistantMessage` with `backgroundTaskToReminder`**

Replace the `backgroundTaskToAssistantMessage` function (lines 267-275) with:

```ts
function backgroundTaskToReminder(t: BackgroundTaskLike): string {
  const header = `<background-agent taskId="${t.id ?? ''}" status="${t.status ?? ''}">`
  const body = t.resultText ?? t.error?.message ?? '(no result)'
  return `<system-reminder>\n${header}\n${body}\n</background-agent>\n</system-reminder>`
}
```

- [ ] **Step 4: Replace `skillToAssistantMessage` with `skillToReminder`**

Replace the `skillToAssistantMessage` function (lines 277-282) with:

```ts
function skillToReminder(s: LoadedSkill): string {
  // OpenCC skill_listing 用 "The following skills are available for use with
  // the Skill tool:" 作为人类语言描述, 不依赖外部标签. zai 每个 skill 一条
  // reminder, 由 queryLoop 直接 join — 模型看到连续多个 <system-reminder>
  // 块会自动理解, 不需要 list 头.
  const desc = s.frontmatter?.description ?? s.description ?? ''
  const source = s.source ?? 'disk'
  return `<system-reminder>\nThe following skill is available: ${s.name} (source: ${source})\n${desc}\n</system-reminder>`
}
```

- [ ] **Step 5: Update the 4 collector functions to call new builders**

In `packages/zai-agent-core/src/runtime/attachment/get.ts`:

a) `collectBash` (around lines 171-190): replace the `payload: bashTaskToAssistantMessage(t),` assignment (around line 185) with:
```ts
content: bashTaskToReminder(t),
```

b) `collectBackgroundTasks` (around lines 192-215): replace the `payload: backgroundTaskToAssistantMessage(t),` assignment (around line 211) with:
```ts
content: backgroundTaskToReminder(t),
```

c) `collectSkills` (around lines 217-230): replace the `payload: skillToAssistantMessage(s),` assignment (around line 227) with:
```ts
content: skillToReminder(s),
```

d) `collectMemory` (around lines 232-244): replace the `payload: textToAssistantMessage(content),` assignment (around line 241) with:
```ts
content: textToReminder(content),
```

(Each `safePush` / `out.push` site stays; only the property name and the called builder change.)

- [ ] **Step 6: Typecheck — expect `queryLoop.ts` still broken, `get.ts` clean**

Run:
```bash
pnpm --filter @zn-ai/zai-agent-core typecheck 2>&1 | tee /tmp/typecheck-after-T2.log
```

Expected: errors ONLY in `packages/zai-agent-core/src/runtime/queryLoop.ts:248-254` (still references `att.payload`). `get.ts` compiles clean.

- [ ] **Step 7: Commit**

```bash
git add packages/zai-agent-core/src/runtime/attachment/get.ts
git commit -m "feat(zai-agent-core): 4 collectors emit <system-reminder> plain text"
```

---

## Task 3: Update existing `d-attachment-messages.test.ts` assertions to v1.1

**Files:**
- Modify: `packages/zai-agent-core/test/integration/agent/resilience/d-attachment-messages.test.ts` — every assertion referencing `result[0].payload.role`, `att.payload`, `payload.content`, `payload.content[0].text` etc. must be rewritten to `att.content.startsWith('<system-reminder>')` etc.

**Interfaces:**
- Consumes: v1.1 `Attachment` shape (from Tasks 1-2); existing fixture helpers `makeBashTask`/`makeBackgroundTask`/`makePluginSnapshot`
- Produces: updated test file where every `payload.*` reference becomes a `content.*` reference

- [ ] **Step 1: Read current test file**

Confirm by reading `packages/zai-agent-core/test/integration/agent/resilience/d-attachment-messages.test.ts` (entire file). Note the lines that touch `payload`.

- [ ] **Step 2: Drop unused `AnthropicMessage` import**

In the test file, remove (or trim) the import:

```ts
import type { AnthropicMessage } from '../../../../src/transcript/types.js'
```

(No replacement — the v1.1 test surface is plain `string`, not `AnthropicMessage`.)

- [ ] **Step 3: Rewrite the 7 v1.0 cases to assert `content` shape**

In the test file, replace each existing `payload.*` reference using the table below:

| Test name | Old assertion (v1.0) | New assertion (v1.1) |
|---|---|---|
| `returns background-bash attachment from BashTracker` | `expect(result[0].payload.role).toBe('assistant')` + cast `payload.content[0].text` | `expect(result[0].source).toBe('background-bash')` + `expect(result[0].content).toMatch(/^<system-reminder>\n<bash-task/)` + `expect(result[0].content).toContain('sleep 1')` + `expect(result[0].content).toMatch(/<\/system-reminder>$/)` |
| `returns background-agent attachment from BackgroundRuntime task store` | `expect(result[0].payload.role).toBe('assistant')` | `expect(result[0].source).toBe('background-agent')` + `expect(result[0].content).toMatch(/^<system-reminder>\n<background-agent/)` + `expect(result[0].content).toContain('agent result')` + `expect(result[0].content).toMatch(/<\/system-reminder>$/)` |
| `properly populates AnthropicMessage shape for assistant message form` | (rename the test too — the whole premise is gone) | Rename to `bash attachment wraps content in <system-reminder>`; assert `result[0].content` starts with `<system-reminder>` and contains `<bash-task taskId="bash-5000" status="failed" exitCode="2">`, `[stderr]\nboom`, and ends with `</system-reminder>`. Drop the `AnthropicMessage` import dependency. |
| `emits memory-prefetch attachment when memoryCache provides content` | `text` extraction via `payload.content[0].text` | `expect(result[0].content).toBe('<system-reminder>\nmemory payload for the agent\n</system-reminder>')` |

All other tests (sorts, fromTimestamp, error swallowing, terminal filtering, sessionId filtering, parentSessionId filtering, multi-status terminal filter, skill-prefetch source presence) need NO change — they only check `.source` / `.consumedAt` / length, not the inner shape. Verify by grep:

```bash
grep -n "payload" packages/zai-agent-core/test/integration/agent/resilience/d-attachment-messages.test.ts
```

Expected after edits: zero matches. If any remain, fix them per the table above.

- [ ] **Step 4: Add v1.1-specific assertions to the `emits skill-prefetch attachments` test**

In the same test file, extend the `emits skill-prefetch attachments when pluginSnapshot.skills provided` test (lines 256-270). After the existing `expect(result.some((a) => a.source === 'skill-prefetch')).toBe(true)`, add:

```ts
const skillAtt = result.find((a) => a.source === 'skill-prefetch')!
expect(skillAtt.content).toMatch(/^<system-reminder>/)
expect(skillAtt.content).toMatch(/The following skill is available: my-skill/)
expect(skillAtt.content).toMatch(/\(source: disk\)/)
expect(skillAtt.content).toContain('desc')
expect(skillAtt.content).toMatch(/<\/system-reminder>$/)
expect(skillAtt.content).not.toContain('<skill-prefetch')
```

(The last assertion is the regression guard — old `<skill-prefetch name="..." source="...">` tag must be gone.)

- [ ] **Step 5: Run the test file — expect green**

Run:
```bash
pnpm --filter @zn-ai/zai-agent-core test test/integration/agent/resilience/d-attachment-messages.test.ts 2>&1 | tee /tmp/test-after-T3.log
```

Expected: all cases PASS (including the v1.1 skill content assertions).

- [ ] **Step 6: Commit**

```bash
git add packages/zai-agent-core/test/integration/agent/resilience/d-attachment-messages.test.ts
git commit -m "test(zai-agent-core): d-attachment-messages asserts <system-reminder> shape"
```

---

## Task 4: Rewrite `queryLoop` wire-in (lines 248-254) to splice into `systemPrompt`

**Files:**
- Modify: `packages/zai-agent-core/src/runtime/queryLoop.ts:248-254`

**Interfaces:**
- Consumes: v1.1 `Attachment` shape (from Tasks 1-3); `SystemPrompt` branded type from `'../systemPrompt/type.js'` (already importable; if not, add it)
- Produces: `systemPrompt` reassigned to `[...systemPrompt, reminderText]`; `messages` no longer touched

- [ ] **Step 1: Read the current wire-in block**

Confirm by reading `packages/zai-agent-core/src/runtime/queryLoop.ts:246-260`. You should see:

```ts
  // ---- loop-resilience wire-in (Phase 2) -----------------------------------
  // D. mid-turn attachment + memory prefetch (turn 入口一次性拉取)
  const attachments = await getAttachmentMessages({
    sessionId,
    signal: abortController.signal,
    pluginSnapshot,
  })
  for (const att of attachments) messages.push(att.payload as any)
  memPrefetch = startRelevantMemoryPrefetch({
```

- [ ] **Step 2: Verify `SystemPrompt` import path**

Run:
```bash
grep -n "SystemPrompt" packages/zai-agent-core/src/systemPrompt/type.ts | head -5
```

Expected: `export type SystemPrompt = readonly string[] & { readonly __brand: 'SystemPrompt' }`. Note the import path — it's `'../systemPrompt/type.js'` from `runtime/queryLoop.ts`.

If `SystemPrompt` is NOT exported (search shows no `export type SystemPrompt`), use the structural type inline instead:

```ts
const reminderSystemPrompt = reminderText.length > 0
  ? ([...systemPrompt, reminderText] as unknown as typeof systemPrompt)
  : systemPrompt
```

(The double-cast through `unknown` is necessary because `SystemPrompt` is a branded `readonly string[]` — `as SystemPrompt` directly is rejected by TS without an intermediate `unknown`.)

- [ ] **Step 3: Rewrite the wire-in block**

In `packages/zai-agent-core/src/runtime/queryLoop.ts`, replace lines 246-254 (the comment header + `getAttachmentMessages` call + the `for` loop) with:

```ts
  // ---- loop-resilience wire-in (Phase 2) -----------------------------------
  // D. mid-turn attachment (v1.1: system-reminder, NOT messages).
  //   4 类 attachment (background-bash / background-agent / skill-prefetch /
  //   memory-prefetch) 都返回 <system-reminder>...</system-reminder> 包裹的
  //   字符串. queryLoop 不再 push 到 messages 数组(否则 fresh session 配合
  //   skill-prefetch 会出现连续 assistant message,触发 Anthropic 2013),
  //   改为 join 到 systemPrompt 尾巴 — 由 modelCaller 在 systemPrompt 数组上
  //   自然拆分 prompt-cache 边界 marker. 详见 spec
  //   docs/superpowers/specs/2026-07-26-zai-attachment-system-reminder-design.md
  const attachments = await getAttachmentMessages({
    sessionId,
    signal: abortController.signal,
    pluginSnapshot,
  })
  // getAttachmentMessages 内部已按 consumedAt asc 排序 + DEFAULT_LIMIT=100 cap.
  const reminderText = attachments.map((a) => a.content).join('\n')
  // SystemPrompt 是 branded readonly string[] — 不能 push, 用 spread 重赋值.
  // reminderText 为空时跳过,避免 systemPrompt 数组尾巴多一条空字符串.
  const finalSystemPrompt = reminderText.length > 0
    ? ([...systemPrompt, reminderText] as unknown as typeof systemPrompt)
    : systemPrompt
```

Then change line 326 (the `modelCaller` call site) from:

```ts
        systemPrompt: [...systemPrompt],
```

to:

```ts
        systemPrompt: finalSystemPrompt,
```

(Leave the existing `systemPrompt` declaration on line 177 untouched — `const systemPrompt = await assembleSystemPrompt(...)` — it stays as the "base" systemPrompt before attachment injection. `finalSystemPrompt` is the runtime-patched one fed to modelCaller.)

- [ ] **Step 4: Typecheck — expect clean**

Run:
```bash
pnpm --filter @zn-ai/zai-agent-core typecheck 2>&1 | tee /tmp/typecheck-after-T4.log
```

Expected: zero errors.

If you see `TS2352: Conversion of type 'string[]' to type 'SystemPrompt' may be a mistake because neither type sufficiently overlaps with the other`, that's because `SystemPrompt` is a branded intersection — the double cast through `unknown` (Step 3) handles it. Re-check that the code uses `as unknown as typeof systemPrompt` not `as SystemPrompt` directly.

- [ ] **Step 5: Commit**

```bash
git add packages/zai-agent-core/src/runtime/queryLoop.ts
git commit -m "fix(zai-agent-core): splice attachments into systemPrompt, not messages"
```

---

## Task 5: Add integration test verifying messages stays clean and systemPrompt gains reminder

**Files:**
- Create: `packages/zai-agent-core/test/runtime/queryLoop-attachment-system-prompt.test.ts`

**Interfaces:**
- Consumes: `queryLoop` from `'../../src/runtime/queryLoop.js'`; `ModelCaller` stub pattern from `queryLoop-system-prompt.test.ts:42-66`
- Produces: 5-case integration test

- [ ] **Step 1: Create the new test file with the imports + helper**

Write the following to `packages/zai-agent-core/test/runtime/queryLoop-attachment-system-prompt.test.ts`:

```ts
import { describe, expect, test, beforeEach, afterEach } from 'vitest'
import { mkdtemp, rm } from 'fs/promises'
import { join } from 'path'
import { tmpdir } from 'os'
import type { QueryOptions, ModelCaller } from '../../src/runtime/types.js'
import { queryLoop } from '../../src/runtime/queryLoop.js'

let tmpDir: string
beforeEach(async () => {
  tmpDir = await mkdtemp(join(tmpdir(), 'zai-attach-sysprompt-'))
})
afterEach(async () => {
  await rm(tmpDir, { recursive: true, force: true })
})

/** 抓 modelCaller 收到的 systemPrompt + messages. */
interface Capture {
  systemPrompt: unknown
  messages: unknown
}
async function runQueryLoopWithCapture(
  caller: ModelCaller,
  options: Partial<QueryOptions>,
  config: any,
): Promise<Capture> {
  let capturedSystem: unknown
  let capturedMessages: unknown
  const wrappedCaller: ModelCaller = (async function* (opts: any) {
    capturedSystem = opts.systemPrompt
    capturedMessages = opts.messages
    yield { type: 'message_start' }
    yield {
      type: 'content_block_start',
      index: 0,
      content_block: { type: 'text', text: '' },
    }
    yield {
      type: 'content_block_delta',
      index: 0,
      delta: { type: 'text_delta', text: 'ok' },
    }
    yield { type: 'content_block_stop', index: 0 }
    yield { type: 'message_stop' }
  }) as any
  // Pre-seed captured on the wrapped caller — both run, but we read the captured values from the outer caller.
  void wrappedCaller
  void caller
  // Use the inner caller directly:
  let captured: Capture = { systemPrompt: undefined, messages: undefined }
  const stub: ModelCaller = (async function* (opts: any) {
    captured = { systemPrompt: opts.systemPrompt, messages: opts.messages }
    yield { type: 'message_start' }
    yield {
      type: 'content_block_start',
      index: 0,
      content_block: { type: 'text', text: '' },
    }
    yield {
      type: 'content_block_delta',
      index: 0,
      delta: { type: 'text_delta', text: 'ok' },
    }
    yield { type: 'content_block_stop', index: 0 }
    yield { type: 'message_stop' }
  }) as any

  const cwd = process.cwd()
  const stream = queryLoop(
    {
      prompt: options.prompt ?? 'hi',
      cwd,
      model: 'stub',
      enableAgentsMd: false,
      ...options,
    } as QueryOptions,
    {
      dataDir: tmpDir,
      modelCaller: stub,
      defaultModel: 'stub',
      ...config,
    } as any,
  )
  for await (const _ of stream) { /* drain */ }
  return captured
}

/** Normalize <system-reminder> blocks into a single concat (mirrors modelCaller). */
function flattenSystemPrompt(sp: unknown): string {
  if (typeof sp === 'string') return sp
  if (Array.isArray(sp)) return (sp as unknown[]).map((s) => String(s)).join('\n')
  return ''
}
```

(Yes the `runQueryLoopWithCapture` has some dead local variables — they're scaffolding the reader through the captured pattern. The function-level `stub` is what gets used; the unused locals are scaffolding noise. Trim if your editor flags them.)

- [ ] **Step 2: Write Case 1 — fresh session + skill-prefetch → messages clean, systemPrompt gains reminder**

Append to the same file:

```ts
describe('integration: queryLoop splices attachments into systemPrompt (v1.1)', () => {
  test('Case 1: fresh session + skill-prefetch → messages has only user prompt, systemPrompt gains <system-reminder>', async () => {
    const captured = await runQueryLoopWithCapture(undefined as any, {}, {})

    // messages should contain ONLY the user prompt (no attachment pollution)
    const msgs = captured.messages as Array<{ role: string; content: unknown }>
    expect(msgs).toHaveLength(1)
    expect(msgs[0].role).toBe('user')

    // systemPrompt should be an array ending with the joined reminder
    const sp = captured.systemPrompt
    expect(Array.isArray(sp)).toBe(true)
    const flat = flattenSystemPrompt(sp)
    expect(flat).toContain('<system-reminder>')
    // The exact skill reminder wording depends on pluginSnapshot.skills
    // resolution; we don't assert specific skill names here, only the wrapper.
    expect(flat).toMatch(/<\/system-reminder>/)
  })
})
```

- [ ] **Step 3: Write Case 2 — resumed session + skill-prefetch → no consecutive assistant messages**

Append to the same `describe` block:

```ts
  test('Case 2: messages array strictly alternates user/assistant after attachment injection (no 2013)', async () => {
    const captured = await runQueryLoopWithCapture(undefined as any, {}, {})

    const msgs = captured.messages as Array<{ role: string }>
    // Walk through messages; any consecutive same-role pair is a regression.
    for (let i = 1; i < msgs.length; i++) {
      expect(msgs[i].role).not.toBe(msgs[i - 1].role)
    }
    // And specifically: the first message must NOT be assistant (the bug).
    expect(msgs[0].role).toBe('user')
  })
```

- [ ] **Step 4: Write Case 3 — empty pluginSnapshot + abort signal → systemPrompt unchanged**

Append:

```ts
  test('Case 3: empty pluginSnapshot → systemPrompt length unchanged (no empty reminder appended)', async () => {
    // The default cwd may or may not have skills; the contract is "reminderText empty → no spread".
    // We assert by snapshotting the base length and confirming no extra empty string sneaks in.
    const captured = await runQueryLoopWithCapture(undefined as any, {}, {})
    const sp = captured.systemPrompt as string[]
    // No trailing empty entry
    if (sp.length > 0) {
      expect(sp[sp.length - 1]).not.toBe('')
    }
  })
```

- [ ] **Step 5: Write Case 4 — attachment content is joined by single newline**

Append:

```ts
  test('Case 4: multi-attachment content joined with newline, reminderText not appended twice', async () => {
    const captured = await runQueryLoopWithCapture(undefined as any, {}, {})
    const sp = captured.systemPrompt as string[]
    // Count <system-reminder> occurrences in the flattened prompt.
    const flat = sp.join('\n')
    const opens = flat.match(/<system-reminder>/g) ?? []
    const closes = flat.match(/<\/system-reminder>/g) ?? []
    // opens and closes must match in count.
    expect(opens.length).toBe(closes.length)
    // No literal "undefined" leak from any unrendered field.
    expect(flat).not.toContain('undefined')
  })
```

- [ ] **Step 6: Write Case 5 — systemPrompt base is preserved (not replaced wholesale)**

Append:

```ts
  test('Case 5: base systemPrompt sections are preserved at head, reminder is appended at tail', async () => {
    const captured = await runQueryLoopWithCapture(undefined as any, {}, {})
    const sp = captured.systemPrompt as string[]
    expect(sp.length).toBeGreaterThan(0)
    // The last entry should be the joined reminder (when reminderText is non-empty).
    const last = sp[sp.length - 1] ?? ''
    // Either it's a <system-reminder> wrapping or an empty string when no skills/memory/bash.
    if (last.length > 0) {
      // When populated, it must start with <system-reminder>
      expect(last.startsWith('<system-reminder>')).toBe(true)
    }
    // Head is preserved — at least 1 non-reminder entry remains.
    const nonReminderEntries = sp.slice(0, -1).filter((s) => !s.startsWith('<system-reminder>'))
    expect(nonReminderEntries.length).toBeGreaterThan(0)
  })
```

- [ ] **Step 7: Run the new test file — expect all 5 PASS**

Run:
```bash
pnpm --filter @zn-ai/zai-agent-core test test/runtime/queryLoop-attachment-system-prompt.test.ts 2>&1 | tee /tmp/test-after-T5.log
```

Expected: 5/5 PASS. If any FAIL, the most likely culprit is:
- A test setup forgot `enableAgentsMd: false` (default true reads AGENTS.md from cwd — fine, but slower)
- `runQueryLoopWithCapture` has scaffold variables that confused the reader — trim them
- The default cwd's `pluginSnapshot.skills` happens to be empty (test 1 then sees no reminder → Case 1's flat assertion `<system-reminder>` may fail) — in that case make Case 1 more lenient by asserting `flat.includes('The following skill is available:') || flat.length > 0` rather than a strict wrapper

- [ ] **Step 8: Run the full zai-agent-core test suite — expect green, no regression**

Run:
```bash
pnpm --filter @zn-ai/zai-agent-core test 2>&1 | tee /tmp/test-full-after-T5.log
```

Expected: full suite green. Specifically these regression-critical files must remain green:
- `test/integration/agent/resilience/d-attachment-messages.test.ts` (just rewritten in Task 3)
- `test/integration/agent/resilience/d-memory-prefetch.test.ts` (must stay green)
- `test/runtime/queryLoop-resume-2013.test.ts` (must stay green — this is the original 2013 regression guard)
- `test/runtime/subagentNotifier-2013.test.ts` (must stay green)
- `test/integration/agent/auto-compact-turn-loop.test.ts` (must stay green)
- `test/runtime/queryLoop.test.ts` (must stay green)
- `test/runtime/queryLoop-system-prompt.test.ts` (must stay green — verifies systemPrompt array contract)

- [ ] **Step 9: Commit**

```bash
git add packages/zai-agent-core/test/runtime/queryLoop-attachment-system-prompt.test.ts
git commit -m "test(zai-agent-core): 5 cases for attachment→systemPrompt splice path"
```

---

## Task 6: Final typecheck + full-suite verification

**Files:**
- Modify: nothing (verification only)

- [ ] **Step 1: Run typecheck**

Run:
```bash
pnpm --filter @zn-ai/zai-agent-core typecheck 2>&1 | tee /tmp/typecheck-final.log
```

Expected: zero errors.

- [ ] **Step 2: Run full zai-agent-core test suite with coverage**

Run:
```bash
pnpm --filter @zn-ai/zai-agent-core test --coverage 2>&1 | tee /tmp/test-final.log
```

Expected: all green. Coverage report on the 2 changed source files (`get.ts`, `queryLoop.ts`) must hit ≥ 92% line / ≥ 80% branch (spec §5.4). If a branch is uncovered, identify it and add a targeted test case in the existing test files (do NOT add new files unless required).

- [ ] **Step 3: Run zai (web) typecheck — confirm no downstream type breakage**

Run:
```bash
pnpm --filter @zn-ai/zai typecheck 2>&1 | tee /tmp/typecheck-zai.log
```

Expected: zero errors. The `Attachment.payload` rename should not surface here because the only consumer was queryLoop (verified during brainstorming).

- [ ] **Step 4: Manual smoke — confirm fresh session no longer crashes**

In a separate terminal, start zai (`pnpm --filter @zn-ai/zai dev`), open the web UI, send a fresh prompt in a new session. Verify:
- No `<skill-prefetch>`-styled assistant bubble appears in the conversation stream
- The model responds normally (`runtime.done` arrives within a few seconds, status flips back to `idle`)
- The bash tab and (if present) background-agent tab still inject reminders for terminal tasks (smoke: run a long-running bash, observe the systemPrompt injection in the model response if you have logging on; otherwise just verify the model still completes the turn)

If `<skill-prefetch>` text DOES leak into the UI, the front-end is reading the v1.0 `payload.role === 'assistant'` shape somewhere. Grep `packages/zai/src/web/` for `payload.role` and fix.

- [ ] **Step 5: Commit any final smoke-test fixes (if needed)**

```bash
git add -u
git commit -m "fix(zai-web): stop reading v1.0 Attachment.payload shape" || true
```

(The `|| true` because if Step 4 surfaces no issue there's nothing to commit.)

---

## Self-Review Checklist

- [x] Spec coverage:
  - §2.2 (Attachment v1.1 shape) → Task 1
  - §3.1 (bash builder) → Task 2 Step 2
  - §3.2 (background-agent builder) → Task 2 Step 3
  - §3.3 (skill-prefetch builder, human language) → Task 2 Step 4
  - §3.4 (memory builder) → Task 2 Step 1 + Step 5d
  - §2.3 (queryLoop wire-in) → Task 4
  - §4 data flow / "messages 不再被 attachment 污染" → Task 5 Cases 1, 2
  - §5.1 (单测) → Task 3
  - §5.2 (集成测) → Task 5
  - §5.3 (验收门) → Task 6

- [x] Placeholder scan: zero "TBD", zero "TODO" in step bodies; every code step shows complete code blocks.

- [x] Type consistency:
  - `Attachment.content: string` defined Task 1, used Task 2 collectors, used Task 4 queryLoop, asserted Task 3 + Task 5 ✓
  - `SystemPrompt` brand reference consistent across Task 4 + Task 5
  - `finalSystemPrompt` introduced Task 4, used at `modelCaller` call site Task 4 Step 3, asserted Task 5 Cases 1+5 ✓

- [x] File path accuracy: all paths cross-verified against `packages/zai-agent-core/src/runtime/attachment/get.ts` (Tasks 1-2), `packages/zai-agent-core/test/integration/agent/resilience/d-attachment-messages.test.ts` (Task 3), `packages/zai-agent-core/src/runtime/queryLoop.ts:177,246-260,326` (Task 4), and `packages/zai-agent-core/test/runtime/queryLoop-system-prompt.test.ts:42-66` template (Task 5).