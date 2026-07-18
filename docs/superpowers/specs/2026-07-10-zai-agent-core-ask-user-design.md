# zai-agent-core: AskUserQuestionTool + Web RPC — 设计规格

> 文档版本: 1.0 · 2026-07-10 · 状态: 设计已敲定, 待用户 review

## 0. 背景

`@zn-ai/zai-agent-core` 是从 OpenCC 抽离的核心库, 当前**没有** AskUserQuestion 工具:

- `src/tools/` 下只有 Bash/Agent/FileRead/FileWrite/FileEdit/Glob/Grep — 不含交互式提问工具
- `src/tools/Tool.ts` 的 `CanUseToolResult` 已支持 `{behavior: 'ask'}`, 但 `src/runtime/toolExecution.ts:84-86` 实际把 ask 模式直接转成 `tool_use:denied` 错误("ask-mode not yet supported")
- `packages/zai/src/web/src/pages/Agent.tsx` 只渲染单向流(`assistant.text` / `tool_use:*` / `runtime.error` 等), 没有任何交互式提问组件
- `packages/zai/src/server/routes/agent.ts` 只有 `POST /agent/stream` (SSE)、`GET /agent/sessions*`、`POST /agent/abort`, 缺答案回传通道

OpenCC 已有完整实现可参考: `opencc/src/tools/AskUserQuestionTool/AskUserQuestionTool.tsx` + `opencc/src/components/permissions/AskUserQuestionPermissionRequest/AskUserQuestionPermissionRequest.tsx` 使用 `shouldDefer: true` + `requiresUserInteraction() = true` + `behavior: 'ask'`, 由 TUI 端 `toolUseConfirm.onAllow(updatedInput)` 注入 `answers` 完成回环。

`packages/zai` 是 web 形态, 没有 TUI 终端交互, 必须自己实现 core↔server↔web 的 RPC 回环。本 spec 决定如何把 OpenCC 的 `ask` 模式改造成 zai 的 REST + SSE 双向交互。

## 1. 高层架构

```
┌────────────┐  POST /agent/answer  ┌──────────┐  tool.call  ┌──────────────────────┐
│   web      │ ───────────────────► │  server  │ ──────────► │  zai-agent-core      │
│  (React)   │ ◄─────── SSE ──────► │ (Express)│ ◄──events── │  AskUserQuestionTool │
│            │                      │          │             │  + toolExecution     │
└────────────┘                      └──────────┘             └──────────────────────┘
     │                                   │
     │ store: pendingAsk                 │ AskRegistry: Map<toolUseId, resolver>
     ▼                                   ▼
QuestionCard                       askRegistry
(single component,                 (server-side, in-memory
 receives questions[])             cleaned on abort/disconnect)
```

**核心数据流**

1. LLM 调 `AskUserQuestion(questions)` → `tool.call` 内 `await ctx.awaitAskUserQuestion(input)`
2. core yield `tool_use:ask_pending { toolUseId, questions, metadata }` → SSE → web
3. web 渲染 `QuestionCard` → 用户填答案 → `POST /api/agent/answer {toolUseId, answers, annotations?}`
4. server `AskRegistry` 查 resolver → resolve → core 内 promise 继续
5. core 把 answers 注入 output, yield `tool_use:done { output: { questions, answers, annotations? } }`

**与现有事件流的关系**: `tool_use:ask_pending` 是新事件, 类型上比邻 `tool_use:start`; 它发出时 `toolExecution` 仍处于"该 tool 未完成"状态, 紧接其后是 `tool_use:done`(或 `tool_use:error` 当 reject/timeout)。

## 2. 核心约束

- 完整对齐 OpenCC 的 zod schema(inputSchema/outputSchema/questions/options/answers/annotations/metadata), 仅去掉 TUI/preview-html 检查
- 不引入新 npm 依赖
- core 不感知 web/server 的存在 — core 只暴露 `awaitAskUserQuestion` 接口, server 负责实现
- server 的 `AskRegistry` 是 in-memory, 重启会丢失(同步交互场景, 罕见)
- Web 端只交付 MVP + 预览(纯文本) + 注释, 不含 HTML preview 渲染/图片附件/auto-continue 倒计时/plan mode interview

## 3. zai-agent-core 改动

### 3.1 新增 `src/tools/AskUserQuestionTool/`

照搬 OpenCC 的 zod schema(决策 #4):

**`schema.ts`**

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

// 值类型: 每个 question 一条 annotation, 不是 optional 自身
const annotationSchema = z.object({
  preview: z.string().optional(),
  notes: z.string().optional(),
})
// 整个 record 可选 (没填 notes/preview 就不输出)
const annotationsSchema = z.record(z.string(), annotationSchema).optional()

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
```

**`prompt.ts`**

```ts
export const ASK_USER_QUESTION_TOOL_NAME = 'AskUserQuestion'
export const ASK_USER_QUESTION_TOOL_CHIP_WIDTH = 12
export const DESCRIPTION = 'Use this tool when you need to ask the user clarifying questions...'
export const ASK_USER_QUESTION_TOOL_PROMPT = `Use this tool...`
```

**`AskUserQuestionTool.ts`**

```ts
import type { Tool, ToolContext, AskUserAnswers } from '../Tool.js'
import { inputSchema, outputSchema, type Output, type Question } from './schema.js'
import { ASK_USER_QUESTION_TOOL_NAME, DESCRIPTION, ASK_USER_QUESTION_TOOL_PROMPT } from './prompt.js'

export const AskUserQuestionTool: Tool<typeof inputSchema, Output> = {
  name: ASK_USER_QUESTION_TOOL_NAME,
  description: DESCRIPTION,
  inputSchema,
  isReadOnly: () => true,
  isConcurrencySafe: () => true,

  async call(input, ctx) {
    // input 已由 toolExecution safeParse 过, 直接是 z.infer<typeof inputSchema>
    // 已带 answers(测试或直调), 直接返回
    if (input.answers) {
      return {
        output: {
          questions: input.questions,
          answers: input.answers,
          ...(input.annotations ? { annotations: input.annotations } : {}),
        },
      }
    }
    // 等待 web 端答案
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

> **注意**: `awaitAskUserQuestion` 由 `queryLoop`/`toolExecution` 在构造 `ToolContext` 时注入, 实现是一个 Promise, 内部从 `AskRegistry` 拿到 resolver 后挂起。`AskUserAnswers` 类型定义在 `src/tools/Tool.ts`（见 §3.2），本文件 re-use 不重复定义。

### 3.2 `src/tools/Tool.ts` 扩展 `ToolContext`

```ts
export type AskUserAnswers = {
  answers: Record<string, string>
  annotations?: Record<string, { preview?: string; notes?: string }>
}

export type AskUserRequest = {
  questions: unknown  // zod-validated Question[]
  metadata?: { source?: string }
}

export type ToolContext = {
  // ...既有字段保持不变
  awaitAskUserQuestion: (req: AskUserRequest) => Promise<AskUserAnswers>
}
```

### 3.3 `src/tools/index.ts` 注册

```ts
import { AskUserQuestionTool } from './AskUserQuestionTool/AskUserQuestionTool.js'

export function getZaiRuntimeTools() {
  return [
    ...,
    AskUserQuestionTool,
  ]
}
```

### 3.4 `src/runtime/toolExecution.ts` 注入 `awaitAskUserQuestion`

**做法**: 不改 `toolExecution` 的核心 yield 顺序。在 `executeToolsStreaming` 构造 `bridgedCtx` 时, 把 `awaitAskUserQuestion` 用闭包绑定到**当前 block** 的 `toolUseId`。tool.call 内 `await ctx.awaitAskUserQuestion(req)` 时, 闭包先通过**原始 ctx** 的 `emitEvent` 投递 `tool_use:ask_pending` 事件(queryLoop 把它作为主事件流 yield), 然后从 `askRegistry` 拿 resolver 挂起。server 收到事件后注入答案, resolver 触发, tool.call 继续返回。

```ts
// toolExecution.ts 内, 构造 bridgedCtx 处:
const bridgedCtx: ToolContext = {
  ...ctx,
  emitEvent: (e) => { subQueue.push(...) },  // 现有逻辑, 不变
  awaitAskUserQuestion: async (req) => {
    if (!config.askRegistry) {
      throw new Error('askRegistry not configured: cannot await AskUserQuestion answers')
    }
    // 用原始 ctx.emitEvent, 不走 bridgedCtx 的 subQueue 桥;
    // 这样 ask_pending 作为主事件流 yield, 紧跟 tool_use:start
    ctx.emitEvent({
      type: 'tool_use:ask_pending',
      toolUseId: currentToolUseId,  // 闭包捕获自 for-loop 的 block.id
      questions: req.questions,
      ...(req.metadata ? { metadata: req.metadata } : {}),
    })
    return config.askRegistry.register(currentToolUseId, sessionId, abortSignal)
  },
}
```

> `currentToolUseId` 来自外层 `for (const { block, ... } of executable)` 的 `block.id`。

`toolExecution.ts` 的核心 yield 顺序不变 — 仍是 `tool_use:start` → `[ask_pending]` → `tool_use:done`。`ask_pending` 紧贴 `tool_use:start` 是关键: web 端 store 在收到 `tool_use:start` 后, 期待下一个事件要么是 `ask_pending`(交互型 tool) 要么是 `tool_use:done`(普通 tool)。

> **注意**: 由于 ask_pending 在主事件流上, 必须在 `tool_use:start` yield 之后**立即**触发。`ctx.emitEvent` 是同步 push(由 queryLoop 接管, 在外层循环里 yield), 我们的 await 不会卡死 — ask_pending 走 queryLoop 那边的事件流, toolExecution 这边只 await askRegistry.register 返回的 Promise。

### 3.5 `src/runtime/types.ts` 扩展 `RuntimeConfig`

```ts
export type AskRegistryLike = {
  register: (toolUseId: string, sessionId: string, abortSignal: AbortSignal) => Promise<AskUserAnswers>
}

export type RuntimeConfig = {
  // ...既有字段
  askRegistry?: AskRegistryLike
}
```

> 抽象 `AskRegistryLike` 让 core 不依赖 server 端的具体类, 也方便单测时 mock。

### 3.6 错误传播

- `awaitAskUserQuestion` 抛错 → `tool.call` 抛错 → `toolExecution` 走 catch 分支 → yield `tool_use:error`
- web 拒绝答案: server 调 `askRegistry.reject(toolUseId, 'user_rejected')` → 抛 `Error('user_rejected')` → 走 error 分支
- 客户端 SSE 断开: `req.on('close')` → server `askRegistry.abortAll('client_disconnect')` → 所有 pending promise reject

### 3.7 `src/runtime/index.ts` 新增 re-export

让 server 端可 `@zn-ai/zai-agent-core` 拿到 AskUserAnswers/AskUserRequest 类型:

```ts
export type { AskUserAnswers, AskUserRequest } from '../tools/Tool.js'
export { AskUserQuestionTool } from '../tools/AskUserQuestionTool/AskUserQuestionTool.js'
export type { Question, QuestionOption } from '../tools/AskUserQuestionTool/schema.js'
```

## 4. server 端改动

### 4.1 新建 `packages/zai/src/server/services/askRegistry.ts`

```ts
import type { AskUserAnswers } from '@zn-ai/zai-agent-core'

type Pending = {
  resolve: (a: AskUserAnswers) => void
  reject: (e: Error) => void
  abortHandler: () => void
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
        abortHandler: onAbort,
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

### 4.2 `services/agentRuntime.ts` 注入

```ts
import { AskRegistry } from './askRegistry.js'

let askRegistry: AskRegistry | null = null

export function initAgentRuntime() {
  if (runtime) return
  askRegistry = new AskRegistry()
  runtime = new DefaultAgentRuntime({
    ...,
    askRegistry,
  })
}

export function getAskRegistry(): AskRegistry {
  if (!askRegistry) throw new Error('AskRegistry not initialized')
  return askRegistry
}

// 包装 abort 路径
export async function abortAgentSession(sid: string, reason?: string): Promise<void> {
  askRegistry?.abortAll(reason ?? 'session_aborted')
  await getRuntime().abort(sid, reason)
}
```

### 4.3 新建 `routes/answer.ts`

```ts
import { z } from 'zod'
import { getAskRegistry } from '../services/agentRuntime.js'

const AnswerRequest = z.object({
  toolUseId: z.string().min(1),
  answers: z.record(z.string(), z.string()),
  annotations: z.record(z.string(), z.object({
    preview: z.string().optional(),
    notes: z.string().optional(),
  })).optional(),
})

router.post('/agent/answer', (req, res) => {
  const parsed = AnswerRequest.safeParse(req.body)
  if (!parsed.success) return res.status(400).json({ error: 'invalid body' })
  const ok = getAskRegistry().answer(parsed.data.toolUseId, {
    answers: parsed.data.answers,
    annotations: parsed.data.annotations,
  })
  if (!ok) return res.status(404).json({ error: 'no pending ask for toolUseId' })
  res.json({ ok: true })
})

const RejectRequest = z.object({
  toolUseId: z.string().min(1),
  reason: z.string().optional(),
})

router.post('/agent/answer/reject', (req, res) => {
  const parsed = RejectRequest.safeParse(req.body)
  if (!parsed.success) return res.status(400).json({ error: 'invalid body' })
  const ok = getAskRegistry().reject(parsed.data.toolUseId, parsed.data.reason)
  res.json({ ok })
})
```

### 4.4 `routes/agent.ts` 改动

- `req.on('close')` 调 `askRegistry.abortAll('client_disconnect')` 后再 abort
- `/agent/abort` 端点改用 `abortAgentSession` (见 4.2)
- `tool_use:ask_pending` 事件已由 core 在主事件流上 yield(详见 §3.4), 走现有 SSE 透传管道, 无需额外处理

### 4.5 SSE 事件契约

| Event | Payload | 触发时机 |
|-------|---------|---------|
| `tool_use:start` | `{toolUseId, name, input}` | 现有 |
| `tool_use:ask_pending` | `{toolUseId, questions, metadata?}` | AskUserQuestion tool 进入 await |
| `tool_use:done` | `{toolUseId, output}` | 现有(含 answers 输出) |
| `tool_use:error` | `{toolUseId, error}` | 现有(aborted/rejected 也走这里) |
| `tool_use:denied` | `{toolUseId, reason}` | 现有(保留) |

## 5. web 端改动

### 5.1 `store/useAgentStore.ts` 扩展

```ts
import type { Question } from '@zn-ai/zai-agent-core'

type AskState = {
  toolUseId: string
  questions: Question[]
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

actions:
- `setAsk(toolUseId, questions, metadata?)` — 由 `applyEvent` 收到 `tool_use:ask_pending` 时调用
- `setAskAnswer(questionText, label)` — 写草稿
- `setAskNotes(questionText, notes)` — 写草稿
- `submitAsk()` — POST `/api/agent/answer {toolUseId, answers, annotations}`; 成功后 `pendingAsk = null`
- `rejectAsk(reason?)` — POST `/api/agent/answer/reject`

### 5.2 新建 `components/QuestionCard.tsx`

要点(在 MVP + 预览 + 注释 范围内):
- props: `{ questions, answers, annotations, status, onAnswer, onNotesChange, onSubmit, onReject }`
- 每个问题一个 Card:
  - `header` 作 chip 标签(超 12 字符截断)
  - `question` 作问题文本(支持 markdown)
  - `options` 列表: `Radio.Group`(multiSelect=false) / `Checkbox.Group`(multiSelect=true); label 主, description 次
  - **preview**: 纯文本渲染, 截断 200 字符 + "Show more" 展开(HTML 渲染延后)
  - **notes**: 每个问题下方一个 `TextArea`, 最多 500 字符
  - "Other" 选项自动追加: 选中后展开一个 `Input` 输入自定义文本(写入 `answers[questionText]`)
- 多问题上方一个 `Tabs` 组件切换, 最后一个 Tab "Review" 汇总所有答案
- 提交按钮 "Submit answers" — 单问题且非 multiSelect 时, 选中 answer 即触发 submit
- 拒绝按钮 "Cancel" — 弹 `Popconfirm` 二次确认

样式: 浅紫底(`#f9f0ff`) + 紫罗兰左边条(`#722ed1`), 与现有 `ToolCallBlock`/`ThinkingBlock` 风格脱钩, 用独立视觉标识"等待用户回答"。

### 5.3 `pages/Agent.tsx` 集成

```tsx
const { pendingAsk, ... } = useAgentStore()

return (
  <div>
    {orderedMessages.map(...)}
    {pendingAsk && (
      <QuestionCard
        questions={pendingAsk.questions}
        answers={pendingAsk.answers}
        annotations={pendingAsk.annotations}
        status={pendingAsk.status}
        onAnswer={...}
        onNotesChange={...}
        onSubmit={submitAsk}
        onReject={rejectAsk}
      />
    )}
  </div>
)
```

要点:
- `pendingAsk` 与 `orderedMessages` **互斥**展示区(避免和流式气泡视觉冲突)
- 当 `pendingAsk.status === 'pending'` 时, 底部 `TextArea` 禁用(仿 opencc 提问时不让用户再打字)
- 提交时 `submitting` 状态锁住, 按钮 disabled, 提示 "Submitting..."
- 错误时显示错误条 + 重试按钮

### 5.4 store `applyEvent` 新增 case

```ts
case 'tool_use:ask_pending':
  set({ pendingAsk: {
    toolUseId: event.toolUseId,
    questions: event.questions,
    ...(event.metadata ? { metadata: event.metadata } : {}),
    status: 'pending',
    answers: {},
    annotations: {},
  }})
  break
case 'tool_use:done':
  if (state.pendingAsk?.toolUseId === event.toolUseId) {
    set({ pendingAsk: null })
  }
  break
case 'tool_use:error':
case 'tool_use:invalid':
case 'tool_use:denied':
  if (state.pendingAsk?.toolUseId === event.toolUseId) {
    set({ pendingAsk: null })
  }
  break
```

### 5.5 错误处理

- POST `/agent/answer` 返回 404 → store `set({ pendingAsk: { ..., status: 'error', errorMessage: '...' } })`, QuestionCard 显示重试条
- 网络异常 → toast 错误 + 保留 pendingAsk 让用户重试
- SSE 断开 → 保留 pendingAsk, 重连后由 stream 状态决定(与现有行为一致)

## 6. 测试

### 6.1 单元测试(vitest, `packages/zai-agent-core/test/`)

1. **AskUserQuestionTool**(`AskUserQuestionTool.test.ts`)
   - schema 校验: questions 1-4、options 2-4、unique 约束
   - `call()` 直调(input 已含 answers): 不 await, 直接返回
   - `call()` + mock `awaitAskUserQuestion`: 等 → resolve 后输出含 answers/annotations
   - 异常: mock 抛 abort → call() reject

2. **toolExecution**(更新既有)
   - AskUserQuestion + mock 慢答: yield `tool_use:start` → `tool_use:ask_pending`(子事件) → 等 → `tool_use:done`
   - AskUserQuestion + abort: yield `tool_use:error`, tool_result isError=true

3. **queryLoop**(更新既有)
   - 注入 `askRegistry` mock, 验证同一 toolUseId 的 resolver 与 answer() 串联
   - 未注入 askRegistry 时, AskUserQuestion 抛 "askRegistry not configured"

### 6.2 server 集成测试(vitest, `packages/zai/src/server/test/`)

1. **AskRegistry**(`askRegistry.test.ts`)
   - register → answer 正常 resolve
   - register → reject 正常 reject
   - abortAll 触发所有 pending reject
   - 重复 answer 同一 toolUseId → 第二次 false, 不抛

2. **routes/answer**(`answer.test.ts`, supertest)
   - POST /agent/answer 缺字段 → 400
   - POST /agent/answer 命中 → 200 ok:true, registry 中清除
   - POST /agent/answer 不存在 toolUseId → 404
   - POST /agent/answer/reject 正常 reject
   - SSE 流中 AskUserQuestion 端到端: mock modelCaller 返回 tool_use → 验证收到 `tool_use:ask_pending` → POST answer → 验证 `tool_use:done` 含 answers

## 7. 范围

### 7.1 包含(本 spec 交付)

- zai-agent-core: AskUserQuestionTool + ToolContext 扩展 + RuntimeConfig 扩展 + 事件透传
- server: AskRegistry + /agent/answer + /agent/answer/reject + agent.ts 清理
- web: store 扩展 + QuestionCard + Agent.tsx 集成 + 事件适配
- 单元 + server 集成测试
- spec 文档(本文件)

### 7.2 不包含(后续 PR 单独做)

- HTML preview 渲染(现仅纯文本截断)
- Image paste 附件
- Auto-continue 倒计时(`questionAutoContinueTimeoutSec`)
- Plan mode interview 流程
- Web 端 React Testing Library 组件测
- `scripts/sync-from-opencc.ts` 自动同步增强

## 8. 实施顺序

1. **core**: schema → tool → ToolContext 扩展 → RuntimeConfig 扩展 → queryLoop 注入 → 单元测
2. **server**: AskRegistry → /agent/answer → routes/agent.ts 清理 → 集成测
3. **web**: store 扩展 → QuestionCard → Agent.tsx 集成 → 手动联调
4. **docs**: README 增补 + sync 脚本注释
5. **commit + PR**: 单一 PR, 三 package 一起改, 描述里写清三段改动

## 9. 关键文件改动清单

| 文件 | 类型 | 改动 |
|------|------|------|
| `packages/zai-agent-core/src/tools/AskUserQuestionTool/AskUserQuestionTool.ts` | 新建 | tool 实现 |
| `packages/zai-agent-core/src/tools/AskUserQuestionTool/schema.ts` | 新建 | zod schema |
| `packages/zai-agent-core/src/tools/AskUserQuestionTool/prompt.ts` | 新建 | 工具常量与 description |
| `packages/zai-agent-core/src/tools/AskUserQuestionTool/AskUserQuestionTool.test.ts` | 新建 | 单元测 |
| `packages/zai-agent-core/src/tools/index.ts` | 改 | 注册新工具 |
| `packages/zai-agent-core/src/tools/Tool.ts` | 改 | ToolContext 加 awaitAskUserQuestion |
| `packages/zai-agent-core/src/runtime/types.ts` | 改 | RuntimeConfig 加 askRegistry |
| `packages/zai-agent-core/src/runtime/queryLoop.ts` | 改 | 构造 ctx 时注入 awaitAskUserQuestion |
| `packages/zai-agent-core/README.md` | 改 | 增补 AskUserQuestionTool 章节 |
| `packages/zai/src/server/services/askRegistry.ts` | 新建 | AskRegistry 类 |
| `packages/zai/src/server/services/askRegistry.test.ts` | 新建 | 单元测 |
| `packages/zai/src/server/services/agentRuntime.ts` | 改 | 注入 registry + abort 包装 |
| `packages/zai/src/server/routes/answer.ts` | 新建 | /agent/answer + /agent/answer/reject |
| `packages/zai/src/server/routes/answer.test.ts` | 新建 | 集成测 |
| `packages/zai/src/server/routes/agent.ts` | 改 | 清理逻辑 |
| `packages/zai/src/web/src/store/useAgentStore.ts` | 改 | pendingAsk 状态 + actions |
| `packages/zai/src/web/src/components/QuestionCard.tsx` | 新建 | 问题组件 |
| `packages/zai/src/web/src/pages/Agent.tsx` | 改 | 集成 QuestionCard |
| `docs/superpowers/specs/2026-07-10-zai-agent-core-ask-user-design.md` | 新建 | 本 spec |
