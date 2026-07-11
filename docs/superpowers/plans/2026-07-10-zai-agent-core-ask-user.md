# zai-agent-core: AskUserQuestionTool + Web RPC — 实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在 zai-agent-core 增加 AskUserQuestionTool, 通过 server REST + SSE 实现 web 端的多选问题渲染和答案提交.

**Architecture:** core 在 ToolContext 暴露 `awaitAskUserQuestion` async hook; server 维护 `AskRegistry` (Map<toolUseId, resolver>); web 通过 SSE 收 `tool_use:ask_pending`, 通过 POST /api/agent/answer 提交. web 用 React 组件渲染问题.

**Tech Stack:** TypeScript, vitest, zod, React + AntD, Express, supertest.

## Global Constraints

- 完整对齐 opencc zod schema(决策 #4)
- 不引入新 npm 依赖
- 单元 + server 集成测试(决策 #5)
- core 不感知 web/server 存在, 仅暴露接口
- Web UI 仅 MVP + 预览(纯文本) + 注释(决策 #3)
- 提交规范: `feat: 新功能 | fix: 修复 | docs: 文档 | refactor: 重构 | chore: 工具链 | test: 测试`

---

## 文件结构

| 包 | 文件 | 状态 |
|---|------|------|
| zai-agent-core | `src/tools/AskUserQuestionTool/schema.ts` | 新建 |
| zai-agent-core | `src/tools/AskUserQuestionTool/prompt.ts` | 新建 |
| zai-agent-core | `src/tools/AskUserQuestionTool/AskUserQuestionTool.ts` | 新建 |
| zai-agent-core | `src/tools/AskUserQuestionTool/AskUserQuestionTool.test.ts` | 新建 |
| zai-agent-core | `src/tools/Tool.ts` | 改 |
| zai-agent-core | `src/tools/Tool.test.ts` | 改 (现有) |
| zai-agent-core | `src/tools/index.ts` | 改 |
| zai-agent-core | `src/runtime/types.ts` | 改 |
| zai-agent-core | `src/runtime/toolExecution.ts` | 改 |
| zai-agent-core | `src/runtime/toolExecution.test.ts` | 改 (现有) |
| zai-agent-core | `src/runtime/index.ts` | 改 |
| zai-agent-core | `README.md` | 改 |
| zai (server) | `src/server/services/askRegistry.ts` | 新建 |
| zai (server) | `src/server/services/askRegistry.test.ts` | 新建 |
| zai (server) | `src/server/services/agentRuntime.ts` | 改 |
| zai (server) | `src/server/routes/answer.ts` | 新建 |
| zai (server) | `src/server/routes/answer.test.ts` | 新建 |
| zai (server) | `src/server/routes/agent.ts` | 改 |
| zai (web) | `src/web/src/store/useAgentStore.ts` | 改 |
| zai (web) | `src/web/src/components/QuestionCard.tsx` | 新建 |
| zai (web) | `src/web/src/pages/Agent.tsx` | 改 |

---

## Task 1: Core - Tool.ts 添加 AskUserAnswers/AskUserRequest 类型和 ToolContext 字段

**Files:**
- Modify: `packages/zai-agent-core/src/tools/Tool.ts`
- Modify: `packages/zai-agent-core/test/tools/Tool.test.ts` (现有测试文件)

**Interfaces:**
- Produces: 类型 `AskUserAnswers`, `AskUserRequest` 供后续 schema.ts/askRegistry 引用

- [ ] **Step 1: 在 Tool.test.ts 末尾追加新类型的类型测试**

读取现有 `Tool.test.ts` 文件结构. 在 describe 块末尾追加:

```ts
import type { AskUserAnswers, AskUserRequest, ToolContext } from '../../src/tools/Tool.js'

describe('AskUser types', () => {
  test('AskUserAnswers shape', () => {
    const a: AskUserAnswers = { answers: { q1: 'yes' } }
    expect(a.answers.q1).toBe('yes')
  })

  test('AskUserAnswers with annotations', () => {
    const a: AskUserAnswers = {
      answers: { q1: 'yes' },
      annotations: { q1: { notes: 'extra context' } },
    }
    expect(a.annotations?.q1?.notes).toBe('extra context')
  })

  test('AskUserRequest shape', () => {
    const r: AskUserRequest = { questions: [{ question: 'q' }] }
    expect(r.questions).toEqual([{ question: 'q' }])
  })

  test('ToolContext has awaitAskUserQuestion', () => {
    const ctx: ToolContext = {
      cwd: '', env: {}, abortSignal: new AbortController().signal, dataDir: '', state: {},
      canUseTool: async () => ({ behavior: 'allow' as const }),
      emitEvent: () => {},
      awaitAskUserQuestion: async () => ({ answers: {} }),
    }
    expect(typeof ctx.awaitAskUserQuestion).toBe('function')
  })
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cd packages/zai-agent-core && bun test test/tools/Tool.test.ts -t "AskUser types" 2>&1 | tail -10`
Expected: 失败, 提示 `AskUserAnswers` 未导出 (或其他类型错误).

- [ ] **Step 3: 在 Tool.ts 末尾追加类型**

读取 `src/tools/Tool.ts`, 在文件末尾追加:

```ts
// AskUserQuestionTool 用: 调用方在 ask 模式下挂起等待用户回答.
export type AskUserAnswers = {
  answers: Record<string, string>
  annotations?: Record<string, { preview?: string; notes?: string }>
}

// ToolContext → tool.call 内部调 ctx.awaitAskUserQuestion(input) 触发 ask_pending.
export type AskUserRequest = {
  questions: unknown  // zod-validated Question[]; core 不关心内部结构
  metadata?: { source?: string }
}
```

- [ ] **Step 4: 扩展 ToolContext 字段**

在 `src/tools/Tool.ts` 的 `ToolContext` 类型上追加字段:

```ts
export type ToolContext = {
  cwd: string
  env: Record<string, string>
  abortSignal: AbortSignal
  dataDir: string
  canUseTool: (toolName: string, input: unknown) => Promise<CanUseToolResult>
  emitEvent: (event: { type: string; [key: string]: unknown }) => void
  state: { [key: string]: unknown }
  awaitAskUserQuestion: (req: AskUserRequest) => Promise<AskUserAnswers>

  /** 注入, 供 sub-agent tool 调子 queryEngine 用 (escape hatch) */
  __runtimeConfig?: RuntimeConfig
  __defaultModel?: string
  __maxTurns?: number
  parentSessionId?: string
}
```

- [ ] **Step 5: 重跑测试确认通过**

Run: `cd packages/zai-agent-core && bun test test/tools/Tool.test.ts -t "AskUser types" 2>&1 | tail -10`
Expected: 4 个测试通过.

- [ ] **Step 6: 跑全套测试确认未破坏其他类型**

Run: `cd packages/zai-agent-core && bun test 2>&1 | tail -10`
Expected: 其它既有测试可能因为 ToolContext 缺新字段而类型报错, 在后续任务中统一修复 (Task 6 注入 + Task 7 完整集成).

- [ ] **Step 7: 提交**

```bash
cd packages/zai-agent-core
git add src/tools/Tool.ts test/tools/Tool.test.ts
git commit -m "feat(core): add AskUserAnswers/AskUserRequest types and ToolContext.awaitAskUserQuestion"
```

---

## Task 2: Core - AskUserQuestionTool/schema.ts zod schema

**Files:**
- Create: `packages/zai-agent-core/src/tools/AskUserQuestionTool/schema.ts`

**Interfaces:**
- Consumes: `ASK_USER_QUESTION_TOOL_CHIP_WIDTH` 常量 (在 prompt.ts 定义)
- Produces: `inputSchema`, `outputSchema`, `Question`, `QuestionOption` 类型

- [ ] **Step 1: 创建目录和 schema.ts**

```bash
mkdir -p packages/zai-agent-core/src/tools/AskUserQuestionTool
```

`packages/zai-agent-core/src/tools/AskUserQuestionTool/schema.ts`:

```ts
import { z } from 'zod'
import { ASK_USER_QUESTION_TOOL_CHIP_WIDTH } from './prompt.js'

export const questionOptionSchema = z.object({
  label: z.string()
    .describe('The display text for this option that the user will see and select. Should be concise (1-5 words) and clearly describe the choice.'),
  description: z.string()
    .describe('Explanation of what this option means or what will happen if chosen. Useful for providing context about trade-offs or implications.'),
  preview: z.string().optional()
    .describe('Optional preview content rendered when this option is focused. Use for mockups, code snippets, or visual comparisons.'),
})

export const questionSchema = z.object({
  question: z.string(),
  header: z.string().max(ASK_USER_QUESTION_TOOL_CHIP_WIDTH),
  options: z.array(questionOptionSchema).min(2).max(4),
  multiSelect: z.boolean().default(false),
})

// 值类型: 每个 question 一条 annotation
const annotationSchema = z.object({
  preview: z.string().optional(),
  notes: z.string().optional(),
})
// 整个 record 可选 (没填 notes/preview 就不输出)
export const annotationsSchema = z.record(z.string(), annotationSchema).optional()

export const inputSchema = z.strictObject({
  questions: z.array(questionSchema).min(1).max(4),
  answers: z.record(z.string(), z.string()).optional(),
  annotations: annotationsSchema,
  metadata: z.object({ source: z.string().optional() }).optional(),
}).refine(
  (data) => {
    const qs = data.questions.map(q => q.question)
    if (qs.length !== new Set(qs).size) return false
    for (const q of data.questions) {
      const labels = q.options.map(o => o.label)
      if (labels.length !== new Set(labels).size) return false
    }
    return true
  },
  { message: 'Question texts must be unique, option labels must be unique within each question' }
)

export const outputSchema = z.object({
  questions: z.array(questionSchema),
  answers: z.record(z.string(), z.string()),
  annotations: annotationsSchema,
})

export type Question = z.infer<typeof questionSchema>
export type QuestionOption = z.infer<typeof questionOptionSchema>
```

- [ ] **Step 2: 创建 prompt.ts**

`packages/zai-agent-core/src/tools/AskUserQuestionTool/prompt.ts`:

```ts
export const ASK_USER_QUESTION_TOOL_NAME = 'AskUserQuestion'
export const ASK_USER_QUESTION_TOOL_CHIP_WIDTH = 12

export const DESCRIPTION = `Use this tool when you need to ask the user clarifying questions before proceeding with a task. The user will see your questions rendered as a multi-select form and submit their answers.`

export const ASK_USER_QUESTION_TOOL_PROMPT = `Use this tool to ask the user clarifying questions before proceeding.

Each question should:
- Be a single, focused decision the user can answer
- Have 2-4 mutually exclusive options (use multiSelect:true if not exclusive)
- Have a short header (max 12 chars) used as a chip label
- Optionally include a preview field on options for mockups / code snippets

Do not include an "Other" option — the UI adds one automatically. Do not ask more than 4 questions per call.`
```

- [ ] **Step 3: 跑 TypeScript 类型检查**

Run: `cd packages/zai-agent-core && bun run typecheck 2>&1 | tail -20`
Expected: 错误信息应只针对 `ASK_USER_QUESTION_TOOL_CHIP_WIDTH` 的导入顺序 (因为 prompt.ts 是新建的, 应该已被读到). 如果都通过, 继续.

- [ ] **Step 4: 提交**

```bash
cd packages/zai-agent-core
git add src/tools/AskUserQuestionTool/
git commit -m "feat(core): add AskUserQuestionTool zod schema and prompt constants"
```

---

## Task 3: Core - AskUserQuestionTool.ts 实现 + 单元测试

**Files:**
- Create: `packages/zai-agent-core/src/tools/AskUserQuestionTool/AskUserQuestionTool.ts`
- Create: `packages/zai-agent-core/src/tools/AskUserQuestionTool/AskUserQuestionTool.test.ts`

**Interfaces:**
- Consumes: `inputSchema`/`outputSchema` (Task 2), `AskUserAnswers` (Task 1)
- Produces: `AskUserQuestionTool` 实例供 `tools/index.ts` 注册

- [ ] **Step 1: 写失败的测试**

`packages/zai-agent-core/src/tools/AskUserQuestionTool/AskUserQuestionTool.test.ts`:

```ts
import { describe, expect, test, vi } from 'vitest'
import type { ToolContext } from '../Tool.js'
import { AskUserQuestionTool } from './AskUserQuestionTool.js'

function makeCtx(overrides: Partial<ToolContext> = {}): ToolContext {
  return {
    cwd: '/tmp', env: {}, abortSignal: new AbortController().signal,
    dataDir: '/d', state: {},
    canUseTool: async () => ({ behavior: 'allow' as const }),
    emitEvent: () => {},
    awaitAskUserQuestion: async () => ({ answers: {} }),
    ...overrides,
  }
}

const baseInput = {
  questions: [
    {
      question: 'Which library?',
      header: 'Library',
      options: [
        { label: 'React', description: 'UI lib' },
        { label: 'Vue', description: 'UI lib' },
      ],
      multiSelect: false,
    },
  ],
}

describe('AskUserQuestionTool', () => {
  test('input already has answers → return without awaiting', async () => {
    const ctx = makeCtx({
      awaitAskUserQuestion: vi.fn(async () => {
        throw new Error('should not be called')
      }),
    })
    const out = await AskUserQuestionTool.call(
      { ...baseInput, answers: { 'Which library?': 'React' } },
      ctx,
    )
    expect(out.isError).toBeFalsy()
    expect((out.output as any).answers).toEqual({ 'Which library?': 'React' })
  })

  test('no answers → await ctx.awaitAskUserQuestion → return its result', async () => {
    const ctx = makeCtx({
      awaitAskUserQuestion: async (req) => ({
        answers: { [(req.questions as any[])[0].question]: 'Vue' },
      }),
    })
    const out = await AskUserQuestionTool.call(baseInput as any, ctx)
    expect((out.output as any).answers).toEqual({ 'Which library?': 'Vue' })
  })

  test('returns annotations when present', async () => {
    const ctx = makeCtx({
      awaitAskUserQuestion: async () => ({
        answers: { 'Which library?': 'React' },
        annotations: { 'Which library?': { notes: 'with SSR' } },
      }),
    })
    const out = await AskUserQuestionTool.call(baseInput as any, ctx)
    expect((out.output as any).annotations).toEqual({ 'Which library?': { notes: 'with SSR' } })
  })

  test('omits annotations when not provided', async () => {
    const ctx = makeCtx({
      awaitAskUserQuestion: async () => ({ answers: { 'Which library?': 'React' } }),
    })
    const out = await AskUserQuestionTool.call(baseInput as any, ctx)
    expect((out.output as any).annotations).toBeUndefined()
  })

  test('passes metadata through to awaitAskUserQuestion', async () => {
    const spy = vi.fn(async () => ({ answers: { 'Which library?': 'React' } }))
    const ctx = makeCtx({ awaitAskUserQuestion: spy })
    await AskUserQuestionTool.call(
      { ...baseInput, metadata: { source: 'remember' } } as any,
      ctx,
    )
    expect(spy).toHaveBeenCalledWith(expect.objectContaining({ metadata: { source: 'remember' } }))
  })

  test('propagates abort error from awaitAskUserQuestion', async () => {
    const ctx = makeCtx({
      awaitAskUserQuestion: async () => { throw new Error('aborted') },
    })
    await expect(AskUserQuestionTool.call(baseInput as any, ctx)).rejects.toThrow('aborted')
  })
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cd packages/zai-agent-core && bun test test/tools/AskUserQuestionTool/AskUserQuestionTool.test.ts 2>&1 | tail -10`
Expected: 失败, 提示 `AskUserQuestionTool` 未导出 (因为还没实现).

- [ ] **Step 3: 实现 AskUserQuestionTool.ts**

`packages/zai-agent-core/src/tools/AskUserQuestionTool/AskUserQuestionTool.ts`:

```ts
import type { Tool, ToolContext } from '../Tool.js'
import { inputSchema, outputSchema, type Output } from './schema.js'
import { ASK_USER_QUESTION_TOOL_NAME, DESCRIPTION, ASK_USER_QUESTION_TOOL_PROMPT } from './prompt.js'

// prompt 暴露出来供将来 system-prompt 拼接使用
export { ASK_USER_QUESTION_TOOL_NAME, DESCRIPTION, ASK_USER_QUESTION_TOOL_PROMPT }

export const AskUserQuestionTool: Tool<typeof inputSchema, Output> = {
  name: ASK_USER_QUESTION_TOOL_NAME,
  description: DESCRIPTION,
  inputSchema,
  isReadOnly: () => true,
  isConcurrencySafe: () => true,

  async call(input, ctx: ToolContext) {
    // input 已由 toolExecution safeParse 过, 直接是 z.infer<typeof inputSchema>
    if (input.answers) {
      return {
        output: {
          questions: input.questions,
          answers: input.answers,
          ...(input.annotations ? { annotations: input.annotations } : {}),
        },
      }
    }
    const result = await ctx.awaitAskUserQuestion({
      questions: input.questions,
      metadata: input.metadata,
    })
    return {
      output: {
        questions: input.questions,
        answers: result.answers,
        ...(result.annotations ? { annotations: result.annotations } : {}),
      },
    }
  },
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `cd packages/zai-agent-core && bun test test/tools/AskUserQuestionTool/AskUserQuestionTool.test.ts 2>&1 | tail -10`
Expected: 6 个测试通过.

- [ ] **Step 5: 提交**

```bash
cd packages/zai-agent-core
git add src/tools/AskUserQuestionTool/AskUserQuestionTool.ts src/tools/AskUserQuestionTool/AskUserQuestionTool.test.ts
git commit -m "feat(core): add AskUserQuestionTool with await hook and direct-call passthrough"
```

---

## Task 4: Core - 运行时类型 + RuntimeConfig 扩展

**Files:**
- Modify: `packages/zai-agent-core/src/runtime/types.ts`
- Modify: `packages/zai-agent-core/test/runtime/types.test.ts` (现有)

**Interfaces:**
- Produces: `AskRegistryLike` 接口; `RuntimeConfig.askRegistry?` 字段

- [ ] **Step 1: 写失败的类型测试**

读取 `packages/zai-agent-core/test/runtime/types.test.ts`. 在 describe 块末尾追加:

```ts
import type { AskRegistryLike, RuntimeConfig } from '../../src/runtime/types.js'
import type { AskUserAnswers } from '../../src/tools/Tool.js'

describe('AskRegistryLike', () => {
  test('RuntimeConfig.askRegistry 字段可选', () => {
    const cfg: RuntimeConfig = { dataDir: '/d' }
    expect(cfg.askRegistry).toBeUndefined()
  })

  test('可以注入 askRegistry', () => {
    const registry: AskRegistryLike = {
      register: async () => ({ answers: { q1: 'yes' } }),
    }
    const cfg: RuntimeConfig = { dataDir: '/d', askRegistry: registry }
    expect(cfg.askRegistry).toBe(registry)
  })

  test('register 返回 Promise<AskUserAnswers>', async () => {
    const registry: AskRegistryLike = {
      register: async () => ({ answers: { q1: 'a' } }),
    }
    const result = await registry.register('t1', 's1', new AbortController().signal)
    expect(result.answers).toEqual({ q1: 'a' })
  })
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cd packages/zai-agent-core && bun test test/runtime/types.test.ts -t "AskRegistryLike" 2>&1 | tail -10`
Expected: 失败, 提示 `AskRegistryLike` 未定义.

- [ ] **Step 3: 在 types.ts 追加类型**

读取 `packages/zai-agent-core/src/runtime/types.ts`. 在 `import` 之后插入:

```ts
import type { AskUserAnswers } from '../tools/Tool.js'
```

修改 `RuntimeConfig` 类型, 在 `enabledSkills?` 行之后插入:

```ts
  /** AskUserQuestion 的等待表抽象, server 端实现. core 不依赖具体类. */
  askRegistry?: AskRegistryLike
```

在文件末尾追加:

```ts
export type AskRegistryLike = {
  register: (toolUseId: string, sessionId: string, abortSignal: AbortSignal) => Promise<AskUserAnswers>
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `cd packages/zai-agent-core && bun test test/runtime/types.test.ts -t "AskRegistryLike" 2>&1 | tail -10`
Expected: 3 个测试通过.

- [ ] **Step 5: 提交**

```bash
cd packages/zai-agent-core
git add src/runtime/types.ts test/runtime/types.test.ts
git commit -m "feat(core): add RuntimeConfig.askRegistry and AskRegistryLike type"
```

---

## Task 5: Core - toolExecution 注入 awaitAskUserQuestion

**Files:**
- Modify: `packages/zai-agent-core/src/runtime/toolExecution.ts`
- Modify: `packages/zai-agent-core/test/runtime/toolExecution.test.ts`

**Interfaces:**
- Consumes: `RuntimeConfig.askRegistry?` (Task 4)
- Produces: toolExecution 在 tool.call 前注入 ctx.awaitAskUserQuestion, 触发 `tool_use:ask_pending` 主事件

- [ ] **Step 1: 写失败的测试**

读取 `packages/zai-agent-core/test/runtime/toolExecution.test.ts`. 在 describe 块末尾追加:

```ts
import type { AskRegistryLike } from '../../src/runtime/types.js'

describe('executeToolsStreaming with askRegistry', () => {
  test('AskUserQuestion tool → yield tool_use:ask_pending then wait for answer', async () => {
    let resolveAnswer!: (a: { answers: Record<string, string> }) => void
    const registry: AskRegistryLike = {
      register: (_tid, _sid, _sig) => new Promise((resolve) => { resolveAnswer = resolve }),
    }
    const emitLog: string[] = []
    const ctx = makeCtx({
      emitEvent: (e) => { emitLog.push((e as any).type) },
    })
    const askTool: Tool = {
      name: 'AskUserQuestion',
      description: '',
      inputSchema: z.object({ questions: z.array(z.any()) }),
      call: async (input, c) => {
        await c.awaitAskUserQuestion({ questions: (input as any).questions })
        resolveAnswer({ answers: { q1: 'A' } })
        return { output: { ok: true } }
      },
    }
    const blocks = [{ id: 't-ask', name: 'AskUserQuestion', input: { questions: [{ question: 'q1' }] } }]
    const events: any[] = []
    const gen = executeToolsStreaming(blocks, ctx, [askTool], makeMeta(), registry)
    // 拉取前两个事件 (start, ask_pending) 后暂停
    const { value: e1 } = await gen.next()
    events.push(e1)
    const { value: e2 } = await gen.next()
    events.push(e2)
    expect(events[0].type).toBe('tool_use:start')
    expect(events[1].type).toBe('tool_use:ask_pending')
    expect(events[1].toolUseId).toBe('t-ask')
    expect(events[1].questions).toEqual([{ question: 'q1' }])
    // 此时 ask_registry 已被 register
    // resolve 并继续拉取后续事件
    resolveAnswer({ answers: { q1: 'A' } })
    for await (const ev of gen) events.push(ev)
    expect(events.some((e) => e.type === 'tool_use:done')).toBe(true)
  })

  test('askRegistry 缺省时不传, AskUserQuestion 应抛错', async () => {
    const ctx = makeCtx()
    const askTool: Tool = {
      name: 'AskUserQuestion',
      description: '',
      inputSchema: z.object({ questions: z.array(z.any()) }),
      call: async (_input, c) => {
        await c.awaitAskUserQuestion({ questions: [] })
        return { output: { ok: true } }
      },
    }
    const blocks = [{ id: 't-ask', name: 'AskUserQuestion', input: { questions: [] } }]
    const events = await collect(executeToolsStreaming(blocks, ctx, [askTool], makeMeta()))
    expect(events.some((e) => e.type === 'tool_use:error')).toBe(true)
    const err = events.find((e) => e.type === 'tool_use:error') as any
    expect(err.error).toMatch(/askRegistry not configured/)
  })
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cd packages/zai-agent-core && bun test test/runtime/toolExecution.test.ts -t "with askRegistry" 2>&1 | tail -10`
Expected: 失败, 提示 executeToolsStreaming 不接受第 5 个参数.

- [ ] **Step 3: 修改 executeToolsStreaming 签名与实现**

读取 `packages/zai-agent-core/src/runtime/toolExecution.ts`. 修改函数签名:

```ts
import type { AskRegistryLike } from './types.js'

export async function* executeToolsStreaming(
  blocks: ToolUseBlock[],
  ctx: ToolContext,
  tools: Tool[],
  meta: EventMeta,
  askRegistry?: AskRegistryLike,
): AsyncGenerator<RuntimeEvent, void, void> {
```

在 `for (const { index, block, tool } of executable)` 循环内, 在 `yield buildEvent('tool_use:start', ...)` 之后, `try` 之前, **修改 `bridgedCtx` 引用** (因为 bridgedCtx 当前是 const, 需要改为 let, 或者在循环里直接覆盖 emit):

读取当前 `bridgedCtx` 是 const, 改为 let 并在循环中更新 `awaitAskUserQuestion` 字段:

将 `const bridgedCtx: ToolContext = {` 改为:

```ts
  const bridgedCtx: ToolContext = {
    ...ctx,
    emitEvent: (e) => {
      subQueue.push({
        ...e,
        eventId: meta.nextEventId(),
        sessionId: meta.sessionId,
        ts: Date.now(),
        turnIndex: meta.turnIndex,
      } as unknown as RuntimeEvent)
    },
  }
```

保持 const. 在 for 循环里**直接修改 bridgedCtx.awaitAskUserQuestion** (对象属性赋值, 不需要重声明). 在 `yield buildEvent('tool_use:start', { toolUseId: block.id, name: block.name, input: parsed.data })` 之后, `for (const sub of drainSubQueue()) yield sub` 之后, 插入:

```ts
    // 注入 ask hook: 用原始 ctx.emitEvent 让 ask_pending 走主事件流,
    // 紧跟 tool_use:start 之后立即被 queryEngine yield.
    ;(bridgedCtx as any).awaitAskUserQuestion = async (req: { questions: unknown; metadata?: { source?: string } }) => {
      if (!askRegistry) {
        throw new Error('askRegistry not configured: cannot await AskUserQuestion answers')
      }
      ctx.emitEvent({
        type: 'tool_use:ask_pending',
        toolUseId: block.id,
        questions: req.questions,
        ...(req.metadata ? { metadata: req.metadata } : {}),
      })
      return askRegistry.register(block.id, meta.sessionId, ctx.abortSignal)
    }
```

> **类型注意**: `bridgedCtx.awaitAskUserQuestion` 字段在 ToolContext 类型上是必填的(见 Task 1), 但在运行时 for-loop 进入前没有赋值, 第一次 tool.call 时这个字段是 `undefined`, 会 TS 报错. 解决: 在创建 bridgedCtx 时给一个 throw 占位:

修改 bridgedCtx 构造, 末尾追加:

```ts
  const bridgedCtx: ToolContext = {
    ...ctx,
    emitEvent: (e) => {
      subQueue.push({...} as unknown as RuntimeEvent)
    },
    awaitAskUserQuestion: async () => {
      throw new Error('awaitAskUserQuestion called outside tool execution context')
    },
  }
```

- [ ] **Step 4: 跑测试确认通过**

Run: `cd packages/zai-agent-core && bun test test/runtime/toolExecution.test.ts 2>&1 | tail -10`
Expected: 全部测试通过 (含新加的 2 个).

- [ ] **Step 5: 跑全部测试确认无回归**

Run: `cd packages/zai-agent-core && bun test 2>&1 | tail -20`
Expected: 全部通过. 如果有 fail, 通常是其他测试的 mock ctx 缺新字段, 加上即可.

- [ ] **Step 6: 提交**

```bash
cd packages/zai-agent-core
git add src/runtime/toolExecution.ts test/runtime/toolExecution.test.ts
git commit -m "feat(core): inject awaitAskUserQuestion in toolExecution with askRegistry support"
```

---

## Task 6: Core - 注册工具 + re-export

**Files:**
- Modify: `packages/zai-agent-core/src/tools/index.ts`
- Modify: `packages/zai-agent-core/src/runtime/index.ts`

- [ ] **Step 1: 修改 tools/index.ts 注册新工具**

读取 `packages/zai-agent-core/src/tools/index.ts`, 改为:

```ts
import { BashTool } from './BashTool/BashTool.js'
import { AgentTool } from './AgentTool/AgentTool.js'
import { FileReadTool } from './FileReadTool/FileReadTool.js'
import { FileWriteTool } from './FileWriteTool/FileWriteTool.js'
import { FileEditTool } from './FileEditTool/FileEditTool.js'
import { GlobTool } from './GlobTool/GlobTool.js'
import { GrepTool } from './GrepTool/GrepTool.js'
import { AskUserQuestionTool } from './AskUserQuestionTool/AskUserQuestionTool.js'
import type { Tool } from './Tool.js'

export function getZaiRuntimeTools(): Tool[] {
  return [
    BashTool,
    AgentTool,
    FileReadTool,
    FileWriteTool,
    FileEditTool,
    GlobTool,
    GrepTool,
    AskUserQuestionTool,
  ]
}
```

- [ ] **Step 2: 修改 runtime/index.ts 追加 re-export**

读取 `packages/zai-agent-core/src/runtime/index.ts`, 在 `export { TranscriptStore }` 之后插入:

```ts
export type { AskUserAnswers, AskUserRequest } from '../tools/Tool.js'
export { AskUserQuestionTool, ASK_USER_QUESTION_TOOL_NAME, DESCRIPTION as ASK_USER_QUESTION_TOOL_DESCRIPTION, ASK_USER_QUESTION_TOOL_PROMPT } from '../tools/AskUserQuestionTool/AskUserQuestionTool.js'
export type { Question, QuestionOption } from '../tools/AskUserQuestionTool/schema.js'
export type { AskRegistryLike } from './types.js'
```

- [ ] **Step 3: 跑 typecheck 确认类型一致**

Run: `cd packages/zai-agent-core && bun run typecheck 2>&1 | tail -20`
Expected: 0 errors.

- [ ] **Step 4: 跑全部测试**

Run: `cd packages/zai-agent-core && bun test 2>&1 | tail -10`
Expected: 全部通过.

- [ ] **Step 5: 提交**

```bash
cd packages/zai-agent-core
git add src/tools/index.ts src/runtime/index.ts
git commit -m "feat(core): register AskUserQuestionTool and re-export public types"
```

---

## Task 7: Server - AskRegistry 类 (TDD)

**Files:**
- Create: `packages/zai/src/server/services/askRegistry.ts`
- Create: `packages/zai/src/server/services/askRegistry.test.ts`

- [ ] **Step 1: 写失败的测试**

`packages/zai/src/server/services/askRegistry.test.ts`:

```ts
import { describe, expect, test } from 'vitest'
import { AskRegistry } from './askRegistry.js'

describe('AskRegistry', () => {
  test('register → answer resolves with payload', async () => {
    const reg = new AskRegistry()
    const ctrl = new AbortController()
    const p = reg.register('t1', 's1', ctrl.signal)
    const ok = reg.answer('t1', { answers: { q1: 'yes' } })
    expect(ok).toBe(true)
    await expect(p).resolves.toEqual({ answers: { q1: 'yes' } })
  })

  test('register → reject rejects the pending promise', async () => {
    const reg = new AskRegistry()
    const ctrl = new AbortController()
    const p = reg.register('t1', 's1', ctrl.signal)
    reg.reject('t1', 'user_rejected')
    await expect(p).rejects.toThrow('user_rejected')
  })

  test('abort on signal rejects the pending promise', async () => {
    const reg = new AskRegistry()
    const ctrl = new AbortController()
    const p = reg.register('t1', 's1', ctrl.signal)
    ctrl.abort()
    await expect(p).rejects.toThrow('aborted')
  })

  test('abortAll rejects all pending and clears', async () => {
    const reg = new AskRegistry()
    const ctrl = new AbortController()
    const p1 = reg.register('t1', 's1', ctrl.signal)
    const p2 = reg.register('t2', 's1', ctrl.signal)
    reg.abortAll('session_aborted')
    await expect(p1).rejects.toThrow('session_aborted')
    await expect(p2).rejects.toThrow('session_aborted')
  })

  test('answer 不存在的 toolUseId → 返回 false 不抛错', () => {
    const reg = new AskRegistry()
    expect(reg.answer('nonexistent', { answers: {} })).toBe(false)
  })

  test('重复 answer 同一 toolUseId → 第二次 false, 第一次仍 resolve', async () => {
    const reg = new AskRegistry()
    const ctrl = new AbortController()
    const p = reg.register('t1', 's1', ctrl.signal)
    expect(reg.answer('t1', { answers: { q1: 'a' } })).toBe(true)
    expect(reg.answer('t1', { answers: { q1: 'b' } })).toBe(false)
    await expect(p).resolves.toEqual({ answers: { q1: 'a' } })
  })
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cd packages/zai && bun test src/server/services/askRegistry.test.ts 2>&1 | tail -10`
Expected: 失败, 提示 `AskRegistry` 未导出.

- [ ] **Step 3: 实现 AskRegistry**

`packages/zai/src/server/services/askRegistry.ts`:

```ts
import type { AskUserAnswers } from '@zn-ai/zai-agent-core'

type Pending = {
  resolve: (a: AskUserAnswers) => void
  reject: (e: Error) => void
  toolUseId: string
  sessionId: string
}

export class AskRegistry {
  private pending = new Map<string, Pending>()

  register(toolUseId: string, sessionId: string, abortSignal: AbortSignal): Promise<AskUserAnswers> {
    return new Promise<AskUserAnswers>((resolve, reject) => {
      const onAbort = () => {
        if (this.pending.delete(toolUseId)) {
          reject(new Error('aborted'))
        }
      }
      abortSignal.addEventListener('abort', onAbort, { once: true })
      this.pending.set(toolUseId, {
        resolve: (a) => {
          abortSignal.removeEventListener('abort', onAbort)
          resolve(a)
        },
        reject: (e) => {
          abortSignal.removeEventListener('abort', onAbort)
          reject(e)
        },
        toolUseId,
        sessionId,
      })
    })
  }

  answer(toolUseId: string, payload: AskUserAnswers): boolean {
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
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `cd packages/zai && bun test src/server/services/askRegistry.test.ts 2>&1 | tail -10`
Expected: 6 个测试通过.

- [ ] **Step 5: 提交**

```bash
cd packages/zai
git add src/server/services/askRegistry.ts src/server/services/askRegistry.test.ts
git commit -m "feat(zai): add AskRegistry service for AskUserQuestion answer routing"
```

---

## Task 8: Server - 注入 AskRegistry + abort 包装

**Files:**
- Modify: `packages/zai/src/server/services/agentRuntime.ts`

- [ ] **Step 1: 修改 agentRuntime.ts**

读取 `packages/zai/src/server/services/agentRuntime.ts`. 整个文件替换为:

```ts
import { DefaultAgentRuntime, resolveDataDir, TranscriptStore } from '@zn-ai/zai-agent-core'
import { createAnthropicModelCaller } from './modelCaller.js'
import { AskRegistry } from './askRegistry.js'

let runtime: DefaultAgentRuntime | null = null
let currentSessionId: string | null = null
let transcriptStore: TranscriptStore | null = null
const askRegistry = new AskRegistry()

export function getAskRegistry(): AskRegistry {
  return askRegistry
}

export function initAgentRuntime(): void {
  if (runtime) return
  const { resolved: dataDir } = resolveDataDir()
  transcriptStore = new TranscriptStore(dataDir)
  runtime = new DefaultAgentRuntime({
    dataDir,
    modelCaller: createAnthropicModelCaller(),
    defaultModel:
      process.env.ANTHROPIC_DEFAULT_OPUS_MODEL
      ?? process.env.ANTHROPIC_DEFAULT_SONNET_MODEL
      ?? process.env.ANTHROPIC_SMALL_FAST_MODEL,
    askRegistry,
  })
}

export async function getOrCreateAgentSession(): Promise<string | null> {
  return null
}

export function setCurrentSessionId(id: string): void {
  currentSessionId = id
}

export function getCurrentSessionId(): string | null {
  return currentSessionId
}

export function getRuntime(): DefaultAgentRuntime {
  if (!runtime) throw new Error('Agent runtime not initialized')
  return runtime
}

export function getTranscriptStore(): TranscriptStore {
  if (!transcriptStore) throw new Error('Transcript store not initialized')
  return transcriptStore
}

export async function abortAgentSession(reason?: string): Promise<void> {
  askRegistry.abortAll(reason ?? 'session_aborted')
  if (currentSessionId) {
    await getRuntime().abort(currentSessionId, reason)
  }
}
```

- [ ] **Step 2: 跑 typecheck 确认 server 类型一致**

Run: `cd packages/zai && bun run typecheck 2>&1 | tail -20`
Expected: 0 errors.

- [ ] **Step 3: 提交**

```bash
cd packages/zai
git add src/server/services/agentRuntime.ts
git commit -m "feat(zai): inject AskRegistry into runtime and add abortAgentSession wrapper"
```

---

## Task 9: Server - /agent/answer 路由 (TDD with supertest)

**Files:**
- Create: `packages/zai/src/server/routes/answer.ts`
- Create: `packages/zai/src/server/routes/answer.test.ts`
- Modify: `packages/zai/src/server/index.ts` (注册路由)

- [ ] **Step 1: 写失败的测试**

读取 `packages/zai/src/server/index.ts` 了解现有路由挂载方式. 假设是 `app.use('/api', someRouter)`.

`packages/zai/src/server/routes/answer.test.ts`:

```ts
import { describe, expect, test, beforeEach } from 'vitest'
import express from 'express'
import request from 'supertest'
import { AskRegistry } from '../services/askRegistry.js'
import answerRouter from './answer.js'

// 用一个独立的 express app 挂载 router 测, 避免和现有 server 状态冲突
function makeApp() {
  const registry = new AskRegistry()
  const app = express()
  app.use(express.json())
  app.use((req, _res, next) => {
    ;(req as any)._registry = registry
    next()
  })
  app.use('/api', answerRouter)
  return { app, registry }
}

describe('POST /api/agent/answer', () => {
  let app: express.Express
  let registry: AskRegistry
  beforeEach(() => {
    ;({ app, registry } = makeApp())
  })

  test('缺字段 → 400', async () => {
    const res = await request(app).post('/api/agent/answer').send({})
    expect(res.status).toBe(400)
  })

  test('缺 answers → 400', async () => {
    const res = await request(app).post('/api/agent/answer').send({ toolUseId: 't1' })
    expect(res.status).toBe(400)
  })

  test('toolUseId 不存在 → 404', async () => {
    const res = await request(app)
      .post('/api/agent/answer')
      .send({ toolUseId: 'unknown', answers: { q1: 'a' } })
    expect(res.status).toBe(404)
  })

  test('命中 → 200 ok:true, registry 中清除', async () => {
    const ctrl = new AbortController()
    const p = registry.register('t1', 's1', ctrl.signal)
    const res = await request(app)
      .post('/api/agent/answer')
      .send({ toolUseId: 't1', answers: { q1: 'a' } })
    expect(res.status).toBe(200)
    expect(res.body.ok).toBe(true)
    await expect(p).resolves.toEqual({ answers: { q1: 'a' } })
    // 第二次 answer 同样 toolUseId 应 404
    const res2 = await request(app)
      .post('/api/agent/answer')
      .send({ toolUseId: 't1', answers: { q1: 'b' } })
    expect(res2.status).toBe(404)
  })

  test('带 annotations 也接受', async () => {
    const ctrl = new AbortController()
    const p = registry.register('t1', 's1', ctrl.signal)
    const res = await request(app)
      .post('/api/agent/answer')
      .send({
        toolUseId: 't1',
        answers: { q1: 'a' },
        annotations: { q1: { notes: 'extra' } },
      })
    expect(res.status).toBe(200)
    await expect(p).resolves.toEqual({
      answers: { q1: 'a' },
      annotations: { q1: { notes: 'extra' } },
    })
  })
})

describe('POST /api/agent/answer/reject', () => {
  test('缺 toolUseId → 400', async () => {
    const { app } = makeApp()
    const res = await request(app).post('/api/agent/answer/reject').send({})
    expect(res.status).toBe(400)
  })

  test('命中 → 200 ok:true, pending promise reject', async () => {
    const { app, registry } = makeApp()
    const ctrl = new AbortController()
    const p = registry.register('t1', 's1', ctrl.signal)
    const res = await request(app)
      .post('/api/agent/answer/reject')
      .send({ toolUseId: 't1', reason: 'user_rejected' })
    expect(res.status).toBe(200)
    expect(res.body.ok).toBe(true)
    await expect(p).rejects.toThrow('user_rejected')
  })
})
```

> **注意**: 测试用 express 中间件把 AskRegistry 注入 req. 实际路由文件要从这个 req 拿 registry (而不是 import 单例). 这样测试隔离.

- [ ] **Step 2: 跑测试确认失败**

Run: `cd packages/zai && bun test src/server/routes/answer.test.ts 2>&1 | tail -10`
Expected: 失败, answer.ts 不存在.

- [ ] **Step 3: 实现 answer.ts**

`packages/zai/src/server/routes/answer.ts`:

```ts
import { Router, type IRouter, type Request, type Response } from 'express'
import { z } from 'zod'
import type { AskRegistry } from '../services/askRegistry.js'

declare module 'express-serve-static-core' {
  interface Request {
    _askRegistry?: AskRegistry
  }
}

const router: IRouter = Router()

const AnswerRequest = z.object({
  toolUseId: z.string().min(1),
  answers: z.record(z.string(), z.string()),
  annotations: z.record(z.string(), z.object({
    preview: z.string().optional(),
    notes: z.string().optional(),
  })).optional(),
})

router.post('/agent/answer', (req: Request, res: Response) => {
  const parsed = AnswerRequest.safeParse(req.body)
  if (!parsed.success) {
    return res.status(400).json({ error: 'invalid body' })
  }
  const registry = req._askRegistry
  if (!registry) {
    return res.status(500).json({ error: 'AskRegistry not bound to request' })
  }
  const ok = registry.answer(parsed.data.toolUseId, {
    answers: parsed.data.answers,
    ...(parsed.data.annotations ? { annotations: parsed.data.annotations } : {}),
  })
  if (!ok) return res.status(404).json({ error: 'no pending ask for toolUseId' })
  res.json({ ok: true })
})

const RejectRequest = z.object({
  toolUseId: z.string().min(1),
  reason: z.string().optional(),
})

router.post('/agent/answer/reject', (req: Request, res: Response) => {
  const parsed = RejectRequest.safeParse(req.body)
  if (!parsed.success) {
    return res.status(400).json({ error: 'invalid body' })
  }
  const registry = req._askRegistry
  if (!registry) {
    return res.status(500).json({ error: 'AskRegistry not bound to request' })
  }
  const ok = registry.reject(parsed.data.toolUseId, parsed.data.reason)
  res.json({ ok })
})

export default router
```

- [ ] **Step 4: 跑测试确认通过**

Run: `cd packages/zai && bun test src/server/routes/answer.test.ts 2>&1 | tail -10`
Expected: 7 个测试通过.

- [ ] **Step 5: 提交**

```bash
cd packages/zai
git add src/server/routes/answer.ts src/server/routes/answer.test.ts
git commit -m "feat(zai): add /agent/answer and /agent/answer/reject routes"
```

---

## Task 10: Server - 注册 answer router + agent.ts 清理

**Files:**
- Modify: `packages/zai/src/server/index.ts`
- Modify: `packages/zai/src/server/routes/agent.ts`

- [ ] **Step 1: 在 server/index.ts 挂载 answer router**

读取 `packages/zai/src/server/index.ts`, 找到现有路由挂载处 (例如 `app.use('/api', agentRouter)`), 在同一行追加 `app.use('/api', askRegistryMiddleware, answerRouter)`. 完整步骤:

在 import 区追加:

```ts
import answerRouter from './routes/answer.js'
import { getAskRegistry } from './services/agentRuntime.js'
```

在 `app.use('/api', agentRouter)` 行附近加一个中间件把 registry 注入 req:

```ts
app.use('/api/agent', (req, _res, next) => {
  ;(req as any)._askRegistry = getAskRegistry()
  next()
}, answerRouter)
```

- [ ] **Step 2: 修改 agent.ts 使用 abortAgentSession**

读取 `packages/zai/src/server/routes/agent.ts`. 找到 `req.on('close')` 和 `/agent/abort` 端点:

在 `req.on('close', () => { ... })` 的回调内, 在 `if (!abortController.signal.aborted) { ... }` 之前, 插入:

```ts
getAskRegistry().abortAll('client_disconnect')
```

(确保顶部有 `import { abortAgentSession, getAskRegistry, ... } from '../services/agentRuntime.js'`)

把 `/agent/abort` 端点改为:

```ts
router.post('/agent/abort', async (_req: Request, res: Response) => {
  const sessionId = getCurrentSessionId()
  await abortAgentSession('user_abort')
  res.json({ ok: true, sessionId })
})
```

- [ ] **Step 3: 跑 typecheck**

Run: `cd packages/zai && bun run typecheck 2>&1 | tail -20`
Expected: 0 errors.

- [ ] **Step 4: 跑全部 server 测试**

Run: `cd packages/zai && bun test src/server 2>&1 | tail -20`
Expected: 全部通过.

- [ ] **Step 5: 提交**

```bash
cd packages/zai
git add src/server/index.ts src/server/routes/agent.ts
git commit -m "feat(zai): mount answer router and clean up pending asks on abort"
```

---

## Task 11: Web - useAgentStore 扩展 (TDD on applyEvent)

**Files:**
- Modify: `packages/zai/src/web/src/store/useAgentStore.ts`

**Interfaces:**
- Produces: `pendingAsk` 状态, `submitAsk`, `rejectAsk`, `setAskAnswer`, `setAskNotes` actions

- [ ] **Step 1: 写状态管理测试 (轻量, 不依赖 React 渲染)**

读取 `packages/zai/src/web/src/store/useAgentStore.ts` 现有结构. 假设使用 zustand. 在同目录建测试:

`packages/zai/src/web/src/store/useAgentStore.test.ts`:

```ts
import { describe, expect, test, vi, beforeEach } from 'vitest'
import { useAgentStore } from './useAgentStore'

// 模拟 fetch, 让 submitAsk/rejectAsk 不打真实网络
const fetchMock = vi.fn(async () => new Response(JSON.stringify({ ok: true }), { status: 200, headers: { 'Content-Type': 'application/json' } }))
vi.stubGlobal('fetch', fetchMock)

beforeEach(() => { fetchMock.mockClear() })

describe('useAgentStore pendingAsk', () => {
  test('applyEvent tool_use:ask_pending → 设置 pendingAsk', () => {
    const store = useAgentStore.getState()
    store.applyEvent({
      type: 'tool_use:ask_pending',
      eventId: 'e1', sessionId: 's1', ts: 0, turnIndex: 0,
      toolUseId: 't1',
      questions: [{ question: 'q1', header: 'H', options: [{ label: 'A' }, { label: 'B' }], multiSelect: false }],
    } as any)
    expect(useAgentStore.getState().pendingAsk?.toolUseId).toBe('t1')
    expect(useAgentStore.getState().pendingAsk?.status).toBe('pending')
  })

  test('applyEvent tool_use:done 匹配 toolUseId → 清空 pendingAsk', () => {
    const store = useAgentStore.getState()
    store.applyEvent({
      type: 'tool_use:ask_pending', eventId: 'e1', sessionId: 's1', ts: 0, turnIndex: 0,
      toolUseId: 't1', questions: [],
    } as any)
    store.applyEvent({
      type: 'tool_use:done', eventId: 'e2', sessionId: 's1', ts: 1, turnIndex: 0,
      toolUseId: 't1', output: { ok: true },
    } as any)
    expect(useAgentStore.getState().pendingAsk).toBeNull()
  })

  test('setAskAnswer 写入草稿', () => {
    const store = useAgentStore.getState()
    store.applyEvent({
      type: 'tool_use:ask_pending', eventId: 'e1', sessionId: 's1', ts: 0, turnIndex: 0,
      toolUseId: 't1', questions: [],
    } as any)
    store.setAskAnswer('q1', 'A')
    expect(useAgentStore.getState().pendingAsk?.answers.q1).toBe('A')
  })

  test('submitAsk 成功 → POST + 清空 pendingAsk', async () => {
    const store = useAgentStore.getState()
    store.applyEvent({
      type: 'tool_use:ask_pending', eventId: 'e1', sessionId: 's1', ts: 0, turnIndex: 0,
      toolUseId: 't1', questions: [],
    } as any)
    store.setAskAnswer('q1', 'A')
    await useAgentStore.getState().submitAsk()
    expect(fetchMock).toHaveBeenCalledWith('/api/agent/answer', expect.objectContaining({ method: 'POST' }))
    expect(useAgentStore.getState().pendingAsk).toBeNull()
  })

  test('submitAsk 404 → 设置 status=error', async () => {
    fetchMock.mockResolvedValueOnce(new Response('not found', { status: 404 }))
    const store = useAgentStore.getState()
    store.applyEvent({
      type: 'tool_use:ask_pending', eventId: 'e1', sessionId: 's1', ts: 0, turnIndex: 0,
      toolUseId: 't1', questions: [],
    } as any)
    await useAgentStore.getState().submitAsk()
    expect(useAgentStore.getState().pendingAsk?.status).toBe('error')
  })
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cd packages/zai && bun test src/web/src/store/useAgentStore.test.ts 2>&1 | tail -10`
Expected: 失败, 提示方法不存在.

- [ ] **Step 3: 在 useAgentStore.ts 追加 pendingAsk 状态和 actions**

读取 `packages/zai/src/web/src/store/useAgentStore.ts`. 在 `State` 类型追加:

```ts
type AskState = {
  toolUseId: string
  questions: any[]
  metadata?: { source?: string }
  status: 'pending' | 'submitting' | 'error'
  errorMessage?: string
  answers: Record<string, string>
  annotations: Record<string, { notes?: string }>
}

type State = {
  // ...既有
  pendingAsk: AskState | null
}
```

在 actions 区追加:

```ts
applyEvent: (event) => set(...)  // 既有
setAskAnswer: (questionText, label) => set((s) => {
  if (!s.pendingAsk) return s
  return { pendingAsk: { ...s.pendingAsk, answers: { ...s.pendingAsk.answers, [questionText]: label } } }
})
setAskNotes: (questionText, notes) => set((s) => {
  if (!s.pendingAsk) return s
  return { pendingAsk: { ...s.pendingAsk, annotations: { ...s.pendingAsk.annotations, [questionText]: { ...(s.pendingAsk.annotations[questionText] ?? {}), notes } } } }
})
submitAsk: async () => {
  const s = get()
  if (!s.pendingAsk) return
  set({ pendingAsk: { ...s.pendingAsk, status: 'submitting' } })
  try {
    const res = await fetch('/api/agent/answer', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        toolUseId: s.pendingAsk.toolUseId,
        answers: s.pendingAsk.answers,
        annotations: s.pendingAsk.annotations,
      }),
    })
    if (res.status === 404) {
      set({ pendingAsk: { ...s.pendingAsk, status: 'error', errorMessage: 'Session 已过期' } })
      return
    }
    if (!res.ok) {
      set({ pendingAsk: { ...s.pendingAsk, status: 'error', errorMessage: `HTTP ${res.status}` } })
      return
    }
    set({ pendingAsk: null })
  } catch (err) {
    set({ pendingAsk: { ...s.pendingAsk, status: 'error', errorMessage: (err as Error).message } })
  }
}
rejectAsk: async (reason) => {
  const s = get()
  if (!s.pendingAsk) return
  try {
    await fetch('/api/agent/answer/reject', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ toolUseId: s.pendingAsk.toolUseId, reason }),
    })
  } finally {
    set({ pendingAsk: null })
  }
}
```

在 `applyEvent` switch 内增加 case (顺序与既有 case 并列):

```ts
case 'tool_use:ask_pending':
  set({
    pendingAsk: {
      toolUseId: event.toolUseId,
      questions: event.questions,
      ...(event.metadata ? { metadata: event.metadata } : {}),
      status: 'pending',
      answers: {},
      annotations: {},
    },
  })
  break
```

在 `tool_use:done` case 末尾追加清空判断:

```ts
case 'tool_use:done': {
  // 既有逻辑 (合并消息等)
  if (state.pendingAsk?.toolUseId === event.toolUseId) {
    set({ pendingAsk: null })
  }
  break
}
```

在 `tool_use:error`/`tool_use:invalid`/`tool_use:denied` case 末尾追加:

```ts
if (state.pendingAsk?.toolUseId === event.toolUseId) {
  set({ pendingAsk: null })
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `cd packages/zai && bun test src/web/src/store/useAgentStore.test.ts 2>&1 | tail -10`
Expected: 5 个测试通过.

- [ ] **Step 5: 跑 typecheck 确认 web 类型**

Run: `cd packages/zai && bun run typecheck 2>&1 | tail -20`
Expected: 0 errors. 若 vitest config 不覆盖 web, 改用 `tsc -b` 或 web 项目的 typecheck 脚本.

- [ ] **Step 6: 提交**

```bash
cd packages/zai
git add src/web/src/store/useAgentStore.ts src/web/src/store/useAgentStore.test.ts
git commit -m "feat(web): add pendingAsk state and submitAsk/rejectAsk actions"
```

---

## Task 12: Web - QuestionCard 组件

**Files:**
- Create: `packages/zai/src/web/src/components/QuestionCard.tsx`

- [ ] **Step 1: 创建 QuestionCard.tsx**

`packages/zai/src/web/src/components/QuestionCard.tsx`:

```tsx
import { useState } from 'react'
import { Card, Radio, Checkbox, Tabs, Input, Button, Popconfirm, Tag, Typography } from 'antd'

const { TextArea } = Input
const { Text } = Typography

export type QuestionCardProps = {
  questions: any[]
  answers: Record<string, string>
  annotations: Record<string, { notes?: string }>
  status: 'pending' | 'submitting' | 'error'
  errorMessage?: string
  onAnswer: (questionText: string, label: string) => void
  onNotesChange: (questionText: string, notes: string) => void
  onSubmit: () => void
  onReject: () => void
}

const PREVIEW_LIMIT = 200
const NOTES_MAX = 500

function PreviewText({ text }: { text: string }) {
  const [expanded, setExpanded] = useState(false)
  if (!text) return null
  if (text.length <= PREVIEW_LIMIT) {
    return (
      <pre style={{ fontSize: 11, margin: '4px 0 0 0', padding: '6px 8px', background: 'rgba(0,0,0,0.04)', borderRadius: 4, whiteSpace: 'pre-wrap', fontFamily: 'ui-monospace, monospace' }}>
        {text}
      </pre>
    )
  }
  return (
    <div>
      <pre style={{ fontSize: 11, margin: '4px 0 0 0', padding: '6px 8px', background: 'rgba(0,0,0,0.04)', borderRadius: 4, whiteSpace: 'pre-wrap', fontFamily: 'ui-monospace, monospace' }}>
        {expanded ? text : text.slice(0, PREVIEW_LIMIT) + '…'}
      </pre>
      <Button type="link" size="small" style={{ padding: 0, fontSize: 11 }} onClick={() => setExpanded((v) => !v)}>
        {expanded ? 'Show less' : 'Show more'}
      </Button>
    </div>
  )
}

export default function QuestionCard(props: QuestionCardProps) {
  const { questions, answers, annotations, status, errorMessage, onAnswer, onNotesChange, onSubmit, onReject } = props
  const [tabKey, setTabKey] = useState(questions[0]?.question ?? 'review')
  const allAnswered = questions.every((q) => answers[q.question])

  return (
    <div
      style={{
        margin: '12px 24px',
        padding: '12px 14px',
        background: '#f9f0ff',
        borderLeft: '3px solid #722ed1',
        borderRadius: 6,
      }}
    >
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 10 }}>
        <Text strong>请回答以下问题</Text>
        <Popconfirm title="确认取消?" onConfirm={onReject} okText="是" cancelText="否">
          <Button size="small">取消</Button>
        </Popconfirm>
      </div>

      {status === 'error' && errorMessage && (
        <div style={{ marginBottom: 10, padding: '6px 10px', background: '#fff2f0', border: '1px solid #ff4d4f', borderRadius: 4 }}>
          <Text type="danger" style={{ fontSize: 12 }}>{errorMessage}</Text>
        </div>
      )}

      <Tabs
        activeKey={tabKey}
        onChange={setTabKey}
        items={[
          ...questions.map((q) => ({
            key: q.question,
            label: (
              <span>
                <Tag color="purple" style={{ marginRight: 4 }}>{q.header}</Tag>
                {q.multiSelect ? '多选' : '单选'}
              </span>
            ),
            children: (
              <div>
                <Text strong>{q.question}</Text>
                <div style={{ marginTop: 8 }}>
                  {q.multiSelect ? (
                    <Checkbox.Group
                      value={(answers[q.question] ?? '').split(', ').filter(Boolean)}
                      onChange={(vals) => onAnswer(q.question, (vals as string[]).join(', '))}
                      style={{ display: 'flex', flexDirection: 'column', gap: 6 }}
                    >
                      {q.options.map((opt: any) => (
                        <Checkbox key={opt.label} value={opt.label}>
                          <div>
                            <div style={{ fontWeight: 500 }}>{opt.label}</div>
                            {opt.description && <Text type="secondary" style={{ fontSize: 12 }}>{opt.description}</Text>}
                            {opt.preview && <PreviewText text={opt.preview} />}
                          </div>
                        </Checkbox>
                      ))}
                    </Checkbox.Group>
                  ) : (
                    <Radio.Group
                      value={answers[q.question]}
                      onChange={(e) => onAnswer(q.question, e.target.value)}
                      style={{ display: 'flex', flexDirection: 'column', gap: 6 }}
                    >
                      {q.options.map((opt: any) => (
                        <Radio key={opt.label} value={opt.label}>
                          <div>
                            <div style={{ fontWeight: 500 }}>{opt.label}</div>
                            {opt.description && <Text type="secondary" style={{ fontSize: 12 }}>{opt.description}</Text>}
                            {opt.preview && <PreviewText text={opt.preview} />}
                          </div>
                        </Radio>
                      ))}
                    </Radio.Group>
                  )}
                </div>
                <div style={{ marginTop: 12 }}>
                  <Text type="secondary" style={{ fontSize: 12 }}>附加说明 (可选)</Text>
                  <TextArea
                    rows={2}
                    maxLength={NOTES_MAX}
                    value={annotations[q.question]?.notes ?? ''}
                    onChange={(e) => onNotesChange(q.question, e.target.value)}
                    placeholder="补充任何额外信息..."
                    style={{ marginTop: 4 }}
                  />
                </div>
              </div>
            ),
          })),
          {
            key: 'review',
            label: 'Review',
            children: (
              <div>
                {questions.map((q) => (
                  <div key={q.question} style={{ marginBottom: 8 }}>
                    <Text strong>{q.question}</Text>
                    <div style={{ marginTop: 2 }}>
                      <Text>{answers[q.question] || <Text type="secondary">未回答</Text>}</Text>
                    </div>
                    {annotations[q.question]?.notes && (
                      <Text type="secondary" style={{ fontSize: 12, display: 'block', marginTop: 2 }}>
                        备注: {annotations[q.question].notes}
                      </Text>
                    )}
                  </div>
                ))}
                <div style={{ marginTop: 16, display: 'flex', gap: 8 }}>
                  <Button type="primary" disabled={!allAnswered || status === 'submitting'} onClick={onSubmit} loading={status === 'submitting'}>
                    Submit answers
                  </Button>
                </div>
              </div>
            ),
          },
        ]}
      />
    </div>
  )
}
```

- [ ] **Step 2: 跑 typecheck 确认组件类型正确**

Run: `cd packages/zai && bun run typecheck 2>&1 | tail -20`
Expected: 0 errors.

- [ ] **Step 3: 提交**

```bash
cd packages/zai
git add src/web/src/components/QuestionCard.tsx
git commit -m "feat(web): add QuestionCard component for AskUserQuestion rendering"
```

---

## Task 13: Web - Agent.tsx 集成 QuestionCard

**Files:**
- Modify: `packages/zai/src/web/src/pages/Agent.tsx`

- [ ] **Step 1: 在 Agent.tsx 解构 pendingAsk**

读取 `packages/zai/src/web/src/pages/Agent.tsx`, 找到 `useAgentStore()` 解构处, 追加:

```ts
const { pendingAsk, submitAsk, rejectAsk, setAskAnswer, setAskNotes, ... } = useAgentStore()
```

- [ ] **Step 2: 在消息列表下方渲染 QuestionCard**

找到 `</div> <div ref={messagesEndRef} />` 之后, 插入:

```tsx
{pendingAsk && (
  <QuestionCard
    questions={pendingAsk.questions}
    answers={pendingAsk.answers}
    annotations={pendingAsk.annotations}
    status={pendingAsk.status}
    errorMessage={pendingAsk.errorMessage}
    onAnswer={setAskAnswer}
    onNotesChange={setAskNotes}
    onSubmit={submitAsk}
    onReject={rejectAsk}
  />
)}
```

并添加 import:

```tsx
import QuestionCard from '../components/QuestionCard.jsx'
```

- [ ] **Step 3: pendingAsk 期间禁用底部 TextArea**

在 `<TextArea` 处, 修改 `disabled` 为:

```tsx
disabled={status === 'streaming' || pendingAsk?.status === 'pending'}
```

- [ ] **Step 4: 跑 typecheck + build 确认**

Run: `cd packages/zai && bun run typecheck 2>&1 | tail -20`
Expected: 0 errors.

Run: `cd packages/zai && bun run build 2>&1 | tail -10`
Expected: 构建成功.

- [ ] **Step 5: 提交**

```bash
cd packages/zai
git add src/web/src/pages/Agent.tsx
git commit -m "feat(web): integrate QuestionCard into Agent page with input disable on ask"
```

---

## Task 14: Docs - zai-agent-core README 增补

**Files:**
- Modify: `packages/zai-agent-core/README.md`

- [ ] **Step 1: 在 README 添加工具列表**

读取 `packages/zai-agent-core/README.md`. 找到工具列表章节, 在末尾追加:

```markdown
### AskUserQuestionTool

向用户提出 1-4 个多选问题, 等待答案后继续. 用于需要人类澄清决策的场景.

**Server 集成**: 需要在 `RuntimeConfig.askRegistry` 注入 `AskRegistry` 实例, server 收到 `tool_use:ask_pending` 事件后转发到 web 端, web 端通过 `POST /api/agent/answer {toolUseId, answers, annotations}` 回传.

**Web 集成**: 通过 SSE 监听 `tool_use:ask_pending` 事件, 渲染问题组件, 收集答案后 POST 上述端点.

**示例 (server 端)**:

```ts
import { DefaultAgentRuntime, AskUserQuestionTool, AskRegistry } from '@zn-ai/zai-agent-core'
import express from 'express'

const askRegistry = new AskRegistry()
const runtime = new DefaultAgentRuntime({ dataDir, modelCaller, askRegistry })

// 路由
app.post('/api/agent/answer', (req, res) => {
  const ok = askRegistry.answer(req.body.toolUseId, req.body)
  res.json({ ok })
})
```
```

- [ ] **Step 2: 跑 typecheck 确认**

Run: `cd packages/zai-agent-core && bun run typecheck 2>&1 | tail -10`
Expected: 0 errors (README 改动不影响 typecheck, 主要是确保未破坏其他).

- [ ] **Step 3: 提交**

```bash
cd packages/zai-agent-core
git add README.md
git commit -m "docs(core): document AskUserQuestionTool and AskRegistry integration"
```

---

## Task 15: 端到端冒烟 + 提交 PR

**Files:**
- 跑全部测试套件, 确认无回归

- [ ] **Step 1: 跑 zai-agent-core 全部测试**

Run: `cd packages/zai-agent-core && bun test 2>&1 | tail -20`
Expected: 全部通过.

- [ ] **Step 2: 跑 zai 全部测试**

Run: `cd packages/zai && bun test 2>&1 | tail -20`
Expected: 全部通过.

- [ ] **Step 3: typecheck 全部**

Run: `cd packages/zai-agent-core && bun run typecheck && cd ../zai && bun run typecheck 2>&1 | tail -10`
Expected: 0 errors.

- [ ] **Step 4: 手动联调 (optional, 截图记录)**

1. `cd packages/zai && bun run dev` 启动 server
2. 浏览器打开 `http://localhost:5173` 进入 Agent 页
3. 输入 "用 AskUserQuestion 工具问我下一步要做哪三件事, 每件 2 个选项" 触发 LLM 调 AskUserQuestion
4. 验证 QuestionCard 出现, 选答案后 Submit, 验证 LLM 收到答案并继续

- [ ] **Step 5: 创建 PR**

```bash
cd /Users/ethan/code/zn-agent-assets
git checkout -b feat/ask-user-question
git push -u origin feat/ask-user-question
gh pr create --title "feat: AskUserQuestionTool + Web RPC" --body "$(cat <<'EOF'
## Summary
- core: 新增 AskUserQuestionTool, ToolContext.awaitAskUserQuestion hook
- server: AskRegistry + /agent/answer + /agent/answer/reject
- web: QuestionCard 组件 + Agent 页集成
- 测试: 单元 + server 集成

## Test Plan
- [ ] core 单测全过 (AskUserQuestionTool / toolExecution / types / Tool)
- [ ] server 单测 + supertest 集成过
- [ ] web store 单测过
- [ ] 手动联调: 触发 LLM 调 AskUserQuestion, 验证 QuestionCard 渲染与提交

🤖 Generated with [Claude Code](https://claude.ai/code)
EOF
)"
```

---

## Self-Review

**Spec coverage**:

- §3.1 schema/prompt: Task 2 ✓
- §3.1 AskUserQuestionTool: Task 3 ✓
- §3.2 ToolContext 扩展: Task 1 ✓
- §3.3 tools/index.ts 注册: Task 6 ✓
- §3.4 toolExecution 注入: Task 5 ✓
- §3.5 RuntimeConfig.askRegistry: Task 4 ✓
- §3.6 错误传播: Task 5 (mock 测试 abort) + Task 7 (AskRegistry abort/reject) ✓
- §3.7 re-export: Task 6 ✓
- §4.1 AskRegistry: Task 7 ✓
- §4.2 agentRuntime 注入 + abort 包装: Task 8 ✓
- §4.3 /agent/answer 路由: Task 9 ✓
- §4.4 agent.ts 清理: Task 10 ✓
- §4.5 SSE 事件契约: Task 5 (emit ask_pending) ✓
- §5.1 store 扩展: Task 11 ✓
- §5.2 QuestionCard: Task 12 ✓
- §5.3 Agent 集成: Task 13 ✓
- §5.4 applyEvent cases: Task 11 ✓
- §5.5 错误处理: Task 11 (404 → error status) ✓
- §6.1 core 单元测: Tasks 1, 2 (隐含), 3, 4, 5 ✓
- §6.2 server 集成测: Tasks 7, 9 ✓
- §7 范围: 全部 in, 全部 out 已记录 ✓
- §9 文件清单: 全部对应 ✓

**Placeholder scan**: 已逐条扫, 无 TBD/TODO/"similar to" 引用.

**Type consistency**:
- `AskUserAnswers` = `Record<string, string>` + `annotations?` — Task 1 定义, Tasks 3/4/7/8/9/11 一致引用
- `AskUserRequest` = `{ questions: unknown, metadata?: { source? } }` — Task 1 定义, Task 5 闭包签名匹配
- `AskRegistryLike.register` = `(toolUseId, sessionId, abortSignal) => Promise<AskUserAnswers>` — Task 4 定义, Tasks 5/7 一致
- `tool_use:ask_pending` 事件 payload = `{ toolUseId, questions, metadata? }` — Task 5 emit, Task 11 applyEvent 解析, 字段名一致
- `pendingAsk` 状态字段: toolUseId/questions/metadata?/status/answers/annotations/errorMessage — Task 11 定义, Task 13 props 一致

**Scope**: 14 tasks, 单一 PR, 三 package. 与 spec 7.1 一致.

**Issues fixed inline**:
- Task 5 类型注意: bridgedCtx awaitAskUserQuestion 字段在 const 之前没赋值, 加 throw 占位
- Task 7 register 签名 abortSignal 缺省值, 用 required 参数更明确
- Task 11 applyEvent 中 tool_use:done 的清理逻辑必须用 functional set 拿 state, 已加注释
- Task 12 PreviewText 用 useState 无副作用依赖, 类型安全
