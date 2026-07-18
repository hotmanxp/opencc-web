# zai-agent-core: Sub-agent + Bash 工具接入 — 设计规格

> 文档版本: 1.0 · 2026-07-10 · 状态: 设计已敲定, 待用户 review

## 0. 背景

`@zn-ai/zai-agent-core` 当前是 process-internal agent runtime 的早期骨架。`runtime/query.ts` 还是 mock 占位（只发假事件），`src/opencc-internals/` 是 OpenCC 上游源码的只读镜像（含 TUI 剥除标记）。`getZaiBaseTools()` 引用了上游 8 个工具，但都在镜像里，没接入 zai 实际 runtime。

要让 zai 的 main agent 真正能用上 bash 命令执行和 sub-agent 派发，必须把两个核心 tool（`BashTool` / `AgentTool`）从 OpenCC 剥 TUI 提到 zai 自己的 runtime，并配套实现最小 query loop 让 sub-agent 能同进程递归调用。

## 1. 高层架构

```
┌──────────────────────────────────────────────────────────────┐
│                        zai-server (B)                         │
│   HTTP / SSE routes ─┐                                        │
│                      │ 注入 modelCaller (Anthropic SDK)        │
│                      │ 注入 sandboxExecutor (沙箱执行器)         │
└──────────────────────┼───────────────────────────────────────┘
                       │ new DefaultAgentRuntime({ dataDir, modelCaller, ... })
                       ▼
┌──────────────────────────────────────────────────────────────┐
│                  @zn-ai/zai-agent-core                        │
│                                                              │
│   ┌────────────────────────────────────────────────────┐    │
│   │  src/runtime/  (facade + 最小 query loop)            │    │
│   │  query() / abortSession() / DefaultAgentRuntime     │    │
│   │  wrapWithZaiMeta() / RuntimeEvent 流                  │    │
│   │  queryLoop.ts (zai 自写最小 loop)                    │    │
│   │  toolExecution.ts (streaming tool 调度)              │    │
│   │  subagent.ts (sub-agent 上下文 / fork)                │    │
│   └────────────────────┬─────────────────────────────────┘    │
│   ┌────────────────────▼─────────────────────────────────┐    │
│   │  src/tools/  (zai 真实实现, 不在镜像里)                 │    │
│   │  BashTool/         (BashTool.ts)                      │    │
│   │  AgentTool/        (AgentTool.ts + loadAgentsDir.ts)  │    │
│   │  (以及未来 FileRead / FileEdit / Glob / Grep / etc.)    │    │
│   └─────────────────────────────────────────────────────┘    │
│   ┌─────────────────────────────────────────────────────┐    │
│   │  src/opencc-internals/  (参考镜像, 仍只读)            │    │
│   │  Tool.ts / Task.ts / tools.ts / query.ts            │    │
│   │  ... 镜像保持原样, 不动. 注释只增不改.                   │    │
│   └─────────────────────────────────────────────────────┘    │
│   ┌─────────────────────────────────────────────────────┐    │
│   │  src/transcript/  (JSON 文件存储, 现有)                │    │
│   │  TranscriptStore: list / read / patch / remove        │    │
│   │  appendMessage / appendSubagentLink  (新增)            │    │
│   └─────────────────────────────────────────────────────┘    │
└──────────────────────────────────────────────────────────────┘
```

### 1.1 沿用的核心约束（来自 `docs/ARCHITECTURE.md`）

- 不读 OpenCC `settings.json`，zai 独立 `~/.zai/settings.json`
- 不抽 slash commands，web 走 UI dialog
- 所有错误走 `RuntimeErrorEvent` 流式事件
- transcript 用 JSON 文件，每 session 一个文件
- 并发安全用 proper-lockfile

### 1.2 新增约束（本 spec 决定）

- zai-agent-core 零 LLM SDK 依赖，modelCaller 由 zai-server 注入
- zai-agent-core 零沙箱实现，sandbox 行为由 `RuntimeConfig.sandbox` 配置（默认 child_process + 白名单）
- sub-agent 默认全工具可见（含 AgentTool 递归），但强制 `maxTurns <= 25` 防止失控
- `opencc-internals/` 镜像保持只读，新代码不写到 `src/opencc-internals/`
- sub-agent 有独立 sessionId（`<parent>-sub-<8hex>`），事件全量转发给父

## 2. 新模块布局 + RuntimeConfig 扩展

### 2.1 文件改动清单

```
packages/zai-agent-core/src/
├── runtime/
│   ├── contract.ts            (改) 增加 modelCaller / sandbox 配置
│   ├── types.ts               (改) RuntimeConfig / QueryOptions 增字段
│   ├── query.ts               (改) 替换 mock 占位 → 委托 queryLoop
│   ├── queryLoop.ts         (新) zai 自写最小 query loop
│   ├── toolExecution.ts       (新) streaming tool 调度 + canUseTool
│   ├── subagent.ts            (新) sub-agent context / fork / sessionId
│   ├── events.ts              (不改)
│   ├── streamAdapter.ts       (改) 增加 subagent.* 事件前缀
│   ├── abort.ts               (不改)
│   └── canUseTool.ts          (新) 默认 canUseTool 工厂
├── tools/                     (新目录, zai 真实实现)
│   ├── index.ts               (新) getZaiRuntimeTools() = base + BashTool + AgentTool
│   ├── Tool.ts                (新) zai 的 Tool interface (简化版)
│   ├── BashTool/
│   │   ├── BashTool.ts        (新) 主体, 含子进程执行 + 白名单
│   │   ├── sandbox.ts         (新) pickEnv / isReadOnlyCommand / isDestructiveCommand
│   │   ├── prompt.ts          (新) tool description
│   │   └── schema.ts          (新) zod schema
│   └── AgentTool/
│       ├── AgentTool.ts       (新) 主体, 调 queryLoop 递归
│       ├── loadAgentsDir.ts   (新) 从 ~/.zai/agents/ 加载 agent 定义
│       ├── prompt.ts          (新) tool description
│       └── schema.ts          (新) zod schema
├── opencc-internals/          (完全不动, 仍只读镜像)
└── transcript/
    ├── store.ts               (改) 增加 appendMessage / appendSubagentLink
    └── types.ts               (改) TranscriptMeta 加 parentSessionId / subagentType
```

### 2.2 `RuntimeConfig` 扩展

```ts
// src/runtime/types.ts (新增片段)
export type SandboxConfig = {
  executor: 'child_process'
  workdir: string
  commandAllowlist?: RegExp[] | null
  commandDenylist?: RegExp[]
  maxMemoryMb?: number         // 默认 512
  maxCpuMs?: number            // 默认 600_000 (10 分钟)
  networkEgress?: 'allow' | 'block'  // 默认 'allow'
  envAllowlist?: string[]      // 默认 ['PATH', 'HOME', 'LANG', 'TZ', 'USER']
}

export type ModelCaller = (req: {
  model: string
  systemPrompt: string | Array<{ type: string; [k: string]: unknown }>
  messages: Array<{ role: 'user' | 'assistant'; content: unknown }>
  tools: Tool[]
  signal: AbortSignal
}) => AsyncGenerator<{
  type: 'message_start' | 'content_block_start' | 'content_block_delta' | 'content_block_stop' | 'message_delta' | 'message_stop' | 'error'
  [key: string]: unknown
}>

export type RuntimeConfig = {
  dataDir: string
  defaultModel?: string
  defaultPermissions?: Record<string, unknown>
  mcpServers?: Array<{ name: string; command?: string; args?: string[]; url?: string }>
  enabledSkills?: string[]

  // 新增
  modelCaller?: ModelCaller
  sandbox?: SandboxConfig
  defaultMaxTurns?: number               // 默认 50
}
```

### 2.3 `QueryOptions` 扩展

```ts
// src/runtime/types.ts (新增片段)
export type QueryOptions = {
  // ... 现有
  prompt: string | UserMessage | UserMessage[]
  cwd: string
  resumeFromTranscriptId?: string
  model?: string
  systemPrompt?: SystemPrompt | string
  additionalTools?: Tool[]
  abortSignal?: AbortSignal
  maxTurns?: number
  enableAgentsMd?: boolean

  // 新增
  toolsOverride?: 'base' | 'base+subagent' | 'none'  // 默认 'base+subagent'
  parentSessionId?: string
  subagentType?: string
}
```

### 2.4 `Tool` interface（zai 版，简化）

```ts
// src/tools/Tool.ts
import type { z } from 'zod'

export type ToolProgress = { [key: string]: unknown }

export type ToolContext = {
  cwd: string
  env: Record<string, string>
  abortSignal: AbortSignal
  dataDir: string
  canUseTool: (toolName: string, input: unknown) => Promise<{
    behavior: 'allow' | 'deny' | 'ask'
    reason?: string
  }>
  emitEvent: (event: { type: string; [k: string]: unknown }) => void
  state: { [key: string]: unknown }
  /** 注入, 供 sub-agent tool 调子 queryLoop 用 */
  __runtimeConfig?: RuntimeConfig
  __defaultModel?: string
  __maxTurns?: number
  parentSessionId?: string
}

export type Tool<Input extends z.ZodType = z.ZodType, Output = unknown> = {
  name: string
  description: string
  inputSchema: Input
  call(input: z.infer<Input>, ctx: ToolContext): Promise<{ output: Output; isError?: boolean }>
  isConcurrencySafe?: (input: z.infer<Input>) => boolean
  isReadOnly?: (input: z.infer<Input>) => boolean
  isDestructive?: (input: z.infer<Input>) => boolean
}
```

### 2.5 决策要点

- 默认 `maxTurns = 50`（main agent），sub-agent 默认 25（half）
- `additionalTools` 保留，与 `toolsOverride` 正交（前者叠加，后者替换）
- `__runtimeConfig` 等下划线字段是 ToolContext 内部的 escape hatch，不进入 public API
- `ToolContext.canUseTool` 是同步返回 Promise 的 callback（不阻塞主流程），zai-server 注入时可桥接 UI

## 3. 最小 query loop

### 3.1 入口 `src/runtime/queryLoop.ts`

```ts
import { randomUUID } from 'node:crypto'
import type { QueryOptions, RuntimeConfig, Tool } from './types.js'
import type { RuntimeEvent } from './events.js'
import { TranscriptStore } from '../transcript/store.js'
import { wrapWithZaiMeta, toRuntimeErrorEvent } from './streamAdapter.js'
import { loadAgentsMd, buildAgentsMdSystemPrompt } from '../agents/agentsMdLoader.js'
import { executeToolsStreaming } from './toolExecution.js'
import { buildSubagentContext } from './subagent.js'
import { getZaiRuntimeTools } from '../tools/index.js'

const DEFAULT_MAX_TURNS = 50

export async function* queryLoop(
  options: QueryOptions,
  config: RuntimeConfig,
): AsyncGenerator<RuntimeEvent> {
  const sessionId = options.resumeFromTranscriptId ?? `sess-${randomUUID()}`
  const store = new TranscriptStore(config.dataDir)
  const abortController = new AbortController()
  const maxTurns = options.maxTurns ?? config.defaultMaxTurns ?? DEFAULT_MAX_TURNS
  const sessionStartTs = Date.now()

  // 0. abort 透传
  options.abortSignal?.addEventListener('abort',
    () => abortController.abort(options.abortSignal?.reason), { once: true })

  // 1. 解析 sub-agent 上下文
  const subCtx = options.parentSessionId
    ? buildSubagentContext(options, config, sessionId)
    : null

  // 2. 解析 tool pool
  const tools = resolveToolPool(options, config)

  // 3. 创建/恢复 transcript
  if (!options.resumeFromTranscriptId) {
    await store.create({ cwd: options.cwd, model: options.model ?? config.defaultModel ?? 'default' }, sessionId)
  }

  // 4. system prompt 装配
  const systemPrompt = await buildSystemPrompt(options)

  // 5. messages 装配
  const messages: Array<{ role: 'user' | 'assistant'; content: unknown }> = []
  if (options.resumeFromTranscriptId) {
    const t = await store.read(options.resumeFromTranscriptId)
    messages.push(...t.messages)
  }
  if (subCtx?.initialUserMessage) {
    messages.push(subCtx.initialUserMessage)
  } else if (typeof options.prompt === 'string') {
    messages.push({ role: 'user', content: options.prompt })
  } else if (Array.isArray(options.prompt)) {
    messages.push(...(options.prompt as any))
  }

  // 6. 主循环
  let turn = 0
  while (turn < maxTurns) {
    turn++
    if (abortController.signal.aborted) break

    // 6a. 调 model
    const modelStream = config.modelCaller?.({
      model: options.model ?? config.defaultModel ?? 'default',
      systemPrompt,
      messages,
      tools,
      signal: abortController.signal,
    })
    if (!modelStream) {
      yield toRuntimeErrorEvent(new Error('no modelCaller configured'),
        { sessionId, turnIndex: turn })
      return
    }

    // 6b. 流式收 model 输出
    let assistantText = ''
    const toolUseBlocks: Array<{ id: string; name: string; input: unknown }> = []
    for await (const ev of modelStream) {
      if (abortController.signal.aborted) break
      yield* wrapWithZaiMeta(assembleSingleEvent(ev), { sessionId, sessionStartTs })
      if (ev.type === 'content_block_delta' && (ev.delta as any)?.type === 'text_delta') {
        assistantText += (ev.delta as any).text
      } else if (ev.type === 'content_block_start' && (ev.content_block as any)?.type === 'tool_use') {
        toolUseBlocks.push({ id: (ev.content_block as any).id, name: (ev.content_block as any).name, input: {} })
      } else if (ev.type === 'content_block_delta' && (ev.delta as any)?.type === 'input_json_delta') {
        const cur = toolUseBlocks[toolUseBlocks.length - 1]
        if (cur) mergeInputDelta(cur, (ev.delta as any).partial_json)
      }
    }

    // 6c. 解析累积的 input_json (model 流结束后一次性 parse)
    for (const b of toolUseBlocks) {
      const raw = (b.input as any).__rawJson
      if (typeof raw === 'string') {
        try { b.input = JSON.parse(raw) } catch { b.input = {} }
      }
    }

    // 6d. 推 assistant message
    if (toolUseBlocks.length > 0) {
      messages.push({ role: 'assistant', content: [
        ...(assistantText ? [{ type: 'text', text: assistantText }] : []),
        ...toolUseBlocks.map(t => ({ type: 'tool_use', id: t.id, name: t.name, input: t.input })),
      ]})
    } else {
      messages.push({ role: 'assistant', content: [{ type: 'text', text: assistantText }] })
      yield { type: 'runtime.done', eventId: '', sessionId, ts: Date.now(), turnIndex: turn } as any
      return
    }

    // 6e. 调工具 (streaming, 结果通过 ctx.state.__lastToolResults 回传)
    const toolCtx = makeToolContext(options, config, sessionId, abortController)
    for await (const ev of executeToolsStreaming(toolUseBlocks, toolCtx, tools)) {
      yield ev as RuntimeEvent
    }
    const lastResults: ToolResult[] = (toolCtx.state.__lastToolResults as ToolResult[]) ?? []

    // 6f. 推 tool results
    messages.push({ role: 'user', content: toolUseBlocks.map((t, i) => ({
      type: 'tool_result',
      tool_use_id: t.id,
      content: lastResults[i]?.content ?? '',
      is_error: lastResults[i]?.isError ?? false,
    })) })

    // 6g. maxTurns 收尾
    if (turn >= maxTurns) {
      yield toRuntimeErrorEvent(new Error(`maxTurns=${maxTurns} reached`),
        { sessionId, turnIndex: turn })
      return
    }
  }
}
```

### 3.2 子循环要点

- **不实现** microcompact / reactive compact / auto compact（zai 暂时不需要 context 压缩）
- **不实现** stop hooks / pre/post hooks（OpenCC 的 hooks 全 TUI 绑死）
- **不实现** provider fallback（zai-server 在 modelCaller 内部处理）
- **不实现** tool result 截断（BashTool 自己在 sandbox 限制 maxCpuMs）
- **不实现** fork / resume（`resumeFromTranscriptId` 拉历史后单次跑完）

### 3.3 helpers（与 queryLoop 同文件）

```ts
import type { ToolContext } from '../tools/Tool.js'
import { loadAgentsMd, buildAgentsMdSystemPrompt } from '../agents/agentsMdLoader.js'
import { defaultCanUseToolFactory } from './canUseTool.js'

type ToolResult = { toolUseId: string; content: unknown; isError: boolean }

function makeToolContext(
  options: QueryOptions,
  config: RuntimeConfig,
  sessionId: string,
  abortController: AbortController,
): ToolContext {
  return {
    cwd: options.cwd,
    env: process.env as Record<string, string>,
    abortSignal: abortController.signal,
    dataDir: config.dataDir,
    canUseTool: defaultCanUseToolFactory(config.sandbox),
    emitEvent: () => { /* 事件已通过 yield 出去, 这里 noop */ },
    state: {},
    __runtimeConfig: config,
    __defaultModel: options.model ?? config.defaultModel ?? 'default',
    __maxTurns: options.maxTurns ?? config.defaultMaxTurns ?? DEFAULT_MAX_TURNS,
    parentSessionId: options.parentSessionId,
  }
}

async function buildSystemPrompt(options: QueryOptions): Promise<string> {
  const parts: string[] = []
  if (options.systemPrompt) {
    parts.push(typeof options.systemPrompt === 'string'
      ? options.systemPrompt
      : options.systemPrompt.map(b => JSON.stringify(b)).join('\n'))
  }
  if (options.enableAgentsMd !== false) {
    const agentsMd = await loadAgentsMd(options.cwd)
    parts.push(buildAgentsMdSystemPrompt(agentsMd))
  }
  return parts.filter(Boolean).join('\n\n')
}

function assembleSingleEvent(ev: { type: string; [k: string]: unknown }): RuntimeEvent {
  return ev as RuntimeEvent
}

function mergeInputDelta(block: { input: unknown }, partialJson: string): void {
  // 累积所有 partial_json, 下一轮 input_json_delta 触发时再合并
  // 实现: 把所有 delta 字符串拼接, 在 content_block_stop 后 zod parse 整个 input
  const acc = (block.input as any).__rawJson ?? ''
  ;(block.input as any).__rawJson = acc + partialJson
}
```

### 3.4 关键决策

- `wrapWithZaiMeta` 给每个事件加 `eventId` / `sessionId` / `ts` / `turnIndex`，BashTool 事件计数从 `tool_use:start` 起算
- `mergeInputDelta` 累积 `input_json_delta.partial_json` 到 `toolUseBlocks[i].input`，最后 zod parse 时一次性校验
- maxTurns 触发后发 `runtime.error(code: 'max_turns_reached')`，不返回 `runtime.done`

## 4. Streaming tool execution + canUseTool

### 4.1 `src/runtime/toolExecution.ts`

```ts
import type { Tool, ToolContext } from '../tools/Tool.js'
import type { RuntimeEvent } from './events.js'

type ToolUseBlock = { id: string; name: string; input: unknown }
type ToolResult = { toolUseId: string; content: unknown; isError: boolean }

export async function* executeToolsStreaming(
  blocks: ToolUseBlock[],
  ctx: ToolContext,
  tools: Tool[],
): AsyncGenerator<RuntimeEvent, void, void> {
  // 结果回写到 ctx.state.__lastToolResults, 不通过 generator return (async gen 的 return 难以被 for-await-of 捕获)
  const results: ToolResult[] = new Array(blocks.length)
  ctx.state.__lastToolResults = results

  // 1. canUseTool 预检 (并发)
  const permissionResults = await Promise.all(blocks.map(async b => {
    const tool = findTool(tools, b.name)
    if (!tool) return { behavior: 'deny' as const, reason: `unknown tool: ${b.name}` }
    return ctx.canUseTool(b.name, b.input)
  }))

  // 2. 拒掉 / 不存在的 tool_use 直接吐错误
  const executable: Array<{ index: number; block: ToolUseBlock; tool: Tool }> = []
  blocks.forEach((b, i) => {
    const pr = permissionResults[i]
    const tool = findTool(tools, b.name)
    if (pr.behavior === 'deny') {
      ctx.emitEvent({ type: 'tool_use:denied', toolUseId: b.id, reason: pr.reason })
      results[i] = { toolUseId: b.id, content: `permission denied: ${pr.reason}`, isError: true }
    } else if (pr.behavior === 'ask') {
      ctx.emitEvent({ type: 'tool_use:denied', toolUseId: b.id, reason: 'ask-mode not yet supported' })
      results[i] = { toolUseId: b.id, content: 'permission ask-mode not supported', isError: true }
    } else if (!tool) {
      results[i] = { toolUseId: b.id, content: `unknown tool: ${b.name}`, isError: true }
    } else {
      executable.push({ index: i, block: b, tool })
    }
  })

  // 3. 并发执行
  await Promise.all(executable.map(async ({ index, block, tool }) => {
    const parsed = tool.inputSchema.safeParse(block.input)
    if (!parsed.success) {
      ctx.emitEvent({ type: 'tool_use:invalid', toolUseId: block.id, error: parsed.error.message })
      results[index] = { toolUseId: block.id, content: `invalid input: ${parsed.error.message}`, isError: true }
      return
    }
    ctx.emitEvent({ type: 'tool_use:start', toolUseId: block.id, name: block.name, input: parsed.data })
    try {
      const out = await tool.call(parsed.data, ctx)
      ctx.emitEvent({ type: 'tool_use:done', toolUseId: block.id, output: out.output })
      results[index] = { toolUseId: block.id, content: out.output, isError: out.isError ?? false }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      ctx.emitEvent({ type: 'tool_use:error', toolUseId: block.id, error: msg })
      results[index] = { toolUseId: block.id, content: `error: ${msg}`, isError: true }
    }
  }))
}
```

### 4.2 默认 canUseTool 工厂 `src/runtime/canUseTool.ts`

```ts
import type { SandboxConfig } from './types.js'

export function defaultCanUseToolFactory(config: SandboxConfig | undefined) {
  return async (toolName: string, input: unknown) => {
    if (toolName === 'Bash') {
      if (!config) return { behavior: 'deny' as const, reason: 'Bash disabled: no sandbox configured' }
      const cmd = (input as any)?.command ?? ''
      if (config.commandDenylist?.some(re => re.test(cmd))) {
        return { behavior: 'deny' as const, reason: 'command matches denylist' }
      }
      if (config.commandAllowlist && !config.commandAllowlist.some(re => re.test(cmd))) {
        return { behavior: 'deny' as const, reason: 'command not in allowlist' }
      }
    }
    if (toolName === 'Agent') {
      // 用户选全开放, sub-agent 可递归派发
      return { behavior: 'allow' as const }
    }
    return { behavior: 'allow' as const }
  }
}
```

### 4.3 ToolContext.state 跨调用共享

`state.background_tasks`: `Map<taskId, BackgroundTask>`，BashTool `run_in_background=true` 时注册。后续 issue 加 `BashOutput` / `KillBash` tool 读 buffer。

### 4.4 决策要点

- **不实现 ask-mode**——zai 是非交互 web，真要 ask 走 zai-server 的 UI 桥接
- **不实现 tool_use:delta**——Bash stdout 累积在 tool_use:done 一次吐
- **error 不打断后续 tool**——一个失败, 同 batch 其他继续跑
- **并发执行**——同 batch 的多个 tool_use 并发跑（OpenCC 同），按 `executable.index` 写回 `results[]`

## 5. BashTool 设计

### 5.1 主体 `src/tools/BashTool/BashTool.ts`

```ts
import { z } from 'zod'
import { spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import type { Tool, ToolContext } from '../Tool.js'
import { renderPrompt } from './prompt.js'
import { BashInputSchema } from './schema.js'
import { pickEnv, isReadOnlyCommand, isDestructiveCommand } from './sandbox.js'

export const BashTool: Tool<typeof BashInputSchema, string> = {
  name: 'Bash',
  description: renderPrompt(),
  inputSchema: BashInputSchema,
  isConcurrencySafe: () => false,
  isReadOnly: ({ input }) => isReadOnlyCommand(input.command),
  isDestructive: ({ input }) => isDestructiveCommand(input.command),

  async call(input, ctx) {
    const cfg = ctx.__runtimeConfig?.sandbox
    if (!cfg) return { output: 'Bash disabled: no sandbox configured in RuntimeConfig', isError: true }
    if (cfg.executor !== 'child_process') {
      return { output: `unsupported executor: ${cfg.executor}`, isError: true }
    }
    if (input.run_in_background) return runInBackground(input, cfg, ctx)
    return runForeground(input, cfg, ctx)
  },
}
```

### 5.2 Foreground 执行

```ts
async function runForeground(
  input: z.infer<typeof BashInputSchema>,
  cfg: SandboxConfig,
  ctx: ToolContext,
): Promise<{ output: string; isError: boolean }> {
  return new Promise(resolve => {
    const child = spawn('sh', ['-c', input.command], {
      cwd: cfg.workdir,
      env: pickEnv(process.env, cfg.envAllowlist),
      timeout: input.timeout ?? cfg.maxCpuMs ?? 600_000,
      signal: ctx.abortSignal,
      maxBuffer: 10 * 1024 * 1024,
    })
    let stdout = '', stderr = ''
    child.stdout!.on('data', d => { stdout += d.toString() })
    child.stderr!.on('data', d => { stderr += d.toString() })
    child.on('close', (code, signal) => {
      const output = [
        stdout && `<stdout>${stdout}</stdout>`,
        stderr && `<stderr>${stderr}</stderr>`,
        `exit code: ${code ?? signal ?? 'unknown'}`,
      ].filter(Boolean).join('\n')
      resolve({ output, isError: code !== 0 })
    })
    child.on('error', err => resolve({ output: `spawn error: ${err.message}`, isError: true }))
  })
}
```

### 5.3 Background 执行

```ts
async function runInBackground(
  input: z.infer<typeof BashInputSchema>,
  cfg: SandboxConfig,
  ctx: ToolContext,
): Promise<{ output: string; isError: boolean }> {
  const taskId = `bash-${randomUUID().slice(0, 8)}`
  const child = spawn('sh', ['-c', input.command], {
    cwd: cfg.workdir,
    env: pickEnv(process.env, cfg.envAllowlist),
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  const tasks = ((ctx.state.background_tasks ??= new Map()) as Map<string, BackgroundTask>)
  const task: BackgroundTask = {
    taskId, pid: child.pid!,
    description: input.description ?? input.command.slice(0, 60),
    startedAt: Date.now(), stdout: '', stderr: '',
    status: 'running', child,
  }
  child.stdout!.on('data', d => { task.stdout += d.toString() })
  child.stderr!.on('data', d => { task.stderr += d.toString() })
  child.on('close', (code, signal) => {
    task.status = code === 0 ? 'completed' : 'failed'
    task.exitCode = code ?? undefined
    task.signal = signal ?? undefined
  })
  tasks.set(taskId, task)
  return {
    output: `<task_id>${taskId}</task_id>\n<status>running</status>\n<description>${task.description}</description>`,
    isError: false,
  }
}
```

### 5.4 沙箱工具 `src/tools/BashTool/sandbox.ts`

```ts
import { spawn } from 'node:child_process'
import type { SandboxConfig } from '../../runtime/types.js'

export function pickEnv(env: NodeJS.ProcessEnv, allowlist?: string[]): NodeJS.ProcessEnv {
  if (!allowlist) return {}
  const out: NodeJS.ProcessEnv = {}
  for (const k of allowlist) if (env[k] != null) out[k] = env[k]
  return out
}

const READ_ONLY_RE = /^\s*(ls|cat|head|tail|echo|pwd|whoami|date|grep|find|rg|ag|wc|file|stat|test|true|false)\b/
const DESTRUCTIVE_RE = /^\s*(rm|mv|chmod|chown|dd|mkfs|kill|killall|pkill|shutdown|reboot|halt)\b|>\s*\/|>>\s*\//

export function isReadOnlyCommand(cmd: string): boolean {
  return READ_ONLY_RE.test(cmd) && !DESTRUCTIVE_RE.test(cmd)
}

export function isDestructiveCommand(cmd: string): boolean {
  return DESTRUCTIVE_RE.test(cmd)
}

export type BackgroundTask = {
  taskId: string
  pid: number
  description: string
  startedAt: number
  stdout: string
  stderr: string
  status: 'running' | 'completed' | 'failed' | 'killed'
  exitCode?: number
  signal?: NodeJS.Signals
  child: ReturnType<typeof spawn>
}
```

### 5.5 schema / prompt（节选）

```ts
// schema.ts
export const BashInputSchema = z.object({
  command: z.string().min(1),
  description: z.string().optional(),
  timeout: z.number().int().positive().max(600_000).optional(),
  run_in_background: z.boolean().optional(),
})

// prompt.ts
export function renderPrompt(): string {
  return `Executes a shell command in a sandboxed child process.

  Args:
    - command: The shell command to run (passed to sh -c)
    - description: Optional human-readable description
    - timeout: Milliseconds before SIGTERM (default 600_000, max 600_000)
    - run_in_background: If true, returns taskId immediately and runs async

  Output: <stdout>...</stdout>\\n<stderr>...</stderr>\\nexit code: N

  Constraints:
    - Command runs in sandbox.workdir
    - Environment restricted to sandbox.envAllowlist
    - Stdout+stderr capped at 10 MB; longer output truncated

  This tool is NOT concurrency safe and IS destructive by default.`
}
```

### 5.6 决策要点

- **不实现 BashOutput / KillBash tool**——本轮不实现 background task 的查询/终止
- **不实现 PTY**——sandbox 不支持交互式 shell
- **network egress 控制**——通过 env 删 NODE_ENV / HTTPS_PROXY 等实现, 真正的 firewall 由 zai-server 在外层做
- **timeout 强杀**——child_process `timeout` 不强杀, zai 简化: 5s 后 SIGKILL
- **`run_in_background` 的 tool_result** 形如 `<task_id>bash-xxxxxxxx</task_id>...`，subsequent Bash call 不通过此 taskId 引用

## 6. AgentTool + sub-agent 接入

### 6.1 主体 `src/tools/AgentTool/AgentTool.ts`

```ts
import { z } from 'zod'
import { randomUUID } from 'node:crypto'
import type { Tool, ToolContext } from '../Tool.js'
import { renderPrompt } from './prompt.js'
import { AgentInputSchema } from './schema.js'
import { loadAgentDefinitions } from './loadAgentsDir.js'
import { queryLoop } from '../../runtime/queryLoop.js'

export const AgentTool: Tool<typeof AgentInputSchema, string> = {
  name: 'Agent',
  description: renderPrompt(),
  inputSchema: AgentInputSchema,
  isConcurrencySafe: () => false,
  isReadOnly: () => true,
  isDestructive: () => false,

  async call(input, ctx) {
    if (!ctx.__runtimeConfig) {
      return { output: 'AgentTool disabled: no __runtimeConfig in ToolContext', isError: true }
    }
    // 1. 解析 agent definition
    const def = await loadAgentDefinitions(ctx.dataDir)
    const agent = def.agents.find(a => a.name === input.subagent_type)
                 ?? def.agents.find(a => a.name === 'general-purpose')

    // 2. sub-agent sessionId
    const parentSessionId = ctx.parentSessionId ?? 'sess-unknown'
    const subSessionId = `${parentSessionId}-sub-${randomUUID().slice(0, 8)}`

    // 3. 子 query 配置
    const subConfig = ctx.__runtimeConfig
    const subOpts = {
      prompt: input.prompt,
      cwd: ctx.cwd,
      model: agent?.model ?? ctx.__defaultModel,
      systemPrompt: agent?.systemPrompt,
      additionalTools: agent?.additionalTools,
      parentSessionId,
      subagentType: input.subagent_type,
      maxTurns: agent?.maxTurns ?? ctx.__maxTurns ?? 25,
      abortSignal: ctx.abortSignal,
    }

    // 4. 发 start 事件
    ctx.emitEvent({
      type: 'subagent:start',
      subSessionId,
      subagentType: input.subagent_type,
      description: input.description ?? input.prompt.slice(0, 60),
    })

    // 5. 跑子 query, 事件全量转发
    const subStream = queryLoop(subOpts, subConfig)
    let finalOutput = ''
    let exitReason: 'completed' | 'aborted' | 'max_turns' | 'error' = 'completed'
    try {
      for await (const ev of subStream) {
        ctx.emitEvent({ type: 'subagent:event', subSessionId, event: ev })
        if ((ev as any).type === 'runtime.done') { exitReason = 'completed'; break }
        if ((ev as any).type === 'runtime.aborted') { exitReason = 'aborted'; break }
        if ((ev as any).type === 'runtime.error') {
          exitReason = ((ev as any).error?.code === 'max_turns_reached') ? 'max_turns' : 'error'
        }
        if ((ev as any).type === 'assistant_text') finalOutput = (ev as any).text
      }
    } catch (err) {
      exitReason = 'error'
      finalOutput = `error: ${err instanceof Error ? err.message : String(err)}`
    }

    // 6. 发 done 事件
    ctx.emitEvent({ type: 'subagent:done', subSessionId, output: finalOutput, exitReason })

    return {
      output: `<subagent_result agent_type="${input.subagent_type}" exit_reason="${exitReason}">\n${finalOutput}\n</subagent_result>`,
      isError: exitReason === 'error',
    }
  },
}
```

### 6.2 Agent definition loader `src/tools/AgentTool/loadAgentsDir.ts`

```ts
import { readFile, readdir } from 'node:fs/promises'
import { join } from 'node:path'
import type { Tool } from '../Tool.js'

export type AgentDefinition = {
  name: string
  description: string
  systemPrompt: string
  model?: string
  maxTurns?: number
  additionalTools?: Tool[]
}

export async function loadAgentDefinitions(dataDir: string): Promise<{ agents: AgentDefinition[] }> {
  const dir = join(dataDir, 'agents')
  let entries: string[]
  try { entries = await readdir(dir) } catch { return { agents: [] } }
  const agents: AgentDefinition[] = []
  for (const entry of entries) {
    if (entry.endsWith('.md')) {
      const content = await readFile(join(dir, entry), 'utf8')
      const parsed = parseAgentMd(entry.replace(/\.md$/, ''), content)
      if (parsed) agents.push(parsed)
    } else {
      try {
        const content = await readFile(join(dir, entry, 'AGENT.md'), 'utf8')
        const parsed = parseAgentMd(entry, content)
        if (parsed) agents.push(parsed)
      } catch { /* skip */ }
    }
  }
  return { agents }
}

function parseAgentMd(name: string, content: string): AgentDefinition | null {
  const m = content.match(/^---\n([\s\S]+?)\n---\n([\s\S]+)$/)
  if (!m) return null
  const meta: Record<string, string> = {}
  for (const line of m[1].split('\n')) {
    const idx = line.indexOf(':')
    if (idx > 0) meta[line.slice(0, idx).trim()] = line.slice(idx + 1).trim()
  }
  return {
    name: meta.name ?? name,
    description: meta.description ?? '',
    systemPrompt: m[2].trim(),
    model: meta.model,
    maxTurns: meta.maxTurns ? Number(meta.maxTurns) : undefined,
  }
}
```

### 6.3 `src/runtime/subagent.ts`

```ts
import type { QueryOptions, RuntimeConfig } from './types.js'

export function buildSubagentContext(
  options: QueryOptions,
  _config: RuntimeConfig,
  sessionId: string,
): { initialUserMessage?: { role: 'user'; content: string } } {
  return {
    initialUserMessage: typeof options.prompt === 'string'
      ? { role: 'user', content: options.prompt }
      : undefined,
  }
  // sessionId 在 transcript 写入时与 parentSessionId 关联
}
```

### 6.4 Agent definition 格式

单文件 `<name>.md`：

```markdown
---
name: statusline-setup
description: Generates a custom statusline for the agent
model: claude-sonnet-4-6
maxTurns: 15
---

You are a statusline generator. Output JSON with {text, color, bgColor}.
...
```

或目录 `<name>/AGENT.md`：同格式（多文件场景放 `~/.zai/agents/<name>/tools/` 等）。

### 6.5 决策要点

- **agent definition 格式**——OpenCC `~/.claude/agents/` 形态, zai 同样放 `~/.zai/agents/`
- **sub-agent 全工具可见**（含 AgentTool）——用户选全开放, spec 强制 maxTurns=25 兜底
- **abort signal 透传**——父 abort 时子同步 abort；子 abort 不影响父
- **`run_in_background` 本轮不实现**——schema 保留, .call 走同步路径
- **不实现 sub-agent ↔ 父 send-message**——OpenCC TeamCreate / SendMessage 机制太重, zai 这轮跳过

## 7. 事件流 + transcript + 错误流

### 7.1 事件流（zai 完整流图）

```
zai-server.SSE ── RuntimeEvent (envelope) ──► 浏览器
                    │
                    ├── message_start                       (model 启动)
                    ├── content_block_start                 (text / tool_use)
                    ├── content_block_delta                 (text_delta / input_json_delta)
                    ├── content_block_stop
                    ├── message_stop
                    │
                    ├── tool_use:start          (zai 自定义)
                    ├── tool_use:denied         (zai 自定义)
                    ├── tool_use:invalid        (zai 自定义)
                    ├── tool_use:done           (zai 自定义, 含 output)
                    ├── tool_use:error          (zai 自定义)
                    │
                    ├── subagent:start          (zai 自定义, 主 agent 派生子 agent)
                    ├── subagent:event          (zai 自定义, 子事件转发)
                    ├── subagent:done           (zai 自定义, 含 output + exitReason)
                    │
                    ├── runtime.done            (query 正常结束)
                    ├── runtime.aborted         (abort 触发)
                    └── runtime.error           (含 ErrorCategory)
```

### 7.2 Sub-agent 事件转发协议

```ts
// 主 agent 流中, 当 AgentTool.call() 启动子 query:
ctx.emitEvent({
  type: 'subagent:start',
  subSessionId: 'sess-abc-sub-xyz',
  subagentType: 'general-purpose',
  description: 'fix the test file',
})

// 子 query 内部所有事件被 AgentTool 抓取并转:
ctx.emitEvent({
  type: 'subagent:event',
  subSessionId: 'sess-abc-sub-xyz',
  event: { ...ev, sessionId: 'sess-abc-sub-xyz' },
})

// 子结束:
ctx.emitEvent({
  type: 'subagent:done',
  subSessionId: 'sess-abc-sub-xyz',
  output: '...',
  exitReason: 'completed' | 'aborted' | 'max_turns' | 'error',
})
```

### 7.3 transcript 扩展 `src/transcript/store.ts`

```ts
export class TranscriptStore {
  // ... 现有 create / read / patch / remove

  async appendMessage(sessionId: string, msg: TranscriptMessage): Promise<void> {
    // 加锁, 读 JSON, push, 写 JSON, 释放锁
  }

  async appendSubagentLink(parentSessionId: string, subSessionId: string, meta: {
    subagentType: string
    description?: string
    startedAt: number
  }): Promise<void> {
    // 在父 transcript 末尾追加虚拟消息:
    // { type: 'subagent_link', subSessionId, subagentType, description, startedAt }
  }
}
```

### 7.4 TranscriptMeta 扩展

```ts
// transcript/types.ts
export type TranscriptMeta = {
  sessionId: string
  title?: string
  tags?: string[]
  createdAt: number
  updatedAt: number
  cwd: string
  model: string

  // 新增
  parentSessionId?: string
  subagentType?: string
}
```

### 7.5 错误流（ErrorCategory 分配）

| 触发场景 | category | recoverable |
|---------|----------|-------------|
| modelCaller 返回 error event | `llm_provider` | false |
| modelCaller 抛 401/403/429/5xx/timeout | `llm_provider` | true（zai-server 重试）|
| modelCaller 未注入 | `llm_provider` `no modelCaller configured` | false |
| tool input 不通过 zod 校验 | `tool_execution` `invalid input` | true |
| tool.call() throw | `tool_execution` | true |
| canUseTool 拒绝 | `permission_denied` | false（自动注入 is_error tool_result）|
| ask-mode（本轮未实现） | `permission_denied` `ask-mode not yet supported` | false |
| sandbox 未配置 | `tool_execution` `Bash disabled: no sandbox configured` | false |
| maxTurns 触发 | `internal` (code: `max_turns_reached`) | false |
| abort signal | `aborted` | n/a（发 `runtime.aborted`）|
| 子 query 异常 | `tool_execution` (从 sub-agent 上抛) | true |
| transcript lock 失败 | `transcript_io` | true |
| AGENTS.md 读失败 | `skill_load` | true（降级到无 AGENTS.md）|

### 7.6 决策要点

- **sub-agent 事件全量转发**——SSE 流量是 OpenCC REPL 的 2-3x, zai-server 端 SSE handler 需要 backpressure
- **subagent_link 虚拟消息**——父 transcript 末尾追加一条 link 记录, 列表/详情页能跳到子 session
- **不实现 message-level retry**——OpenCC 的 reactiveCompact / providerFallback / max_output_tokens_recovery 全砍
- **abort 透传**——子 abort 不影响父（子在分支上独立结束），父 abort 强杀子（ctx.abortSignal 同一信号）

## 8. 测试策略 + 风险 + 验收

### 8.1 测试分层

| 层级 | 工具 | 覆盖 | 位置 |
|------|------|------|------|
| **Unit** | vitest | BashTool.sandbox: pickEnv / isReadOnlyCommand / isDestructiveCommand; AgentTool.loadAgentsDir.parseAgentMd; defaultCanUseTool; subagent.buildSubagentContext | `test/unit/` |
| **Integration** | vitest + MockModelCaller | queryLoop happy path; tool call; 2-turn loop; sub-agent 调用 + 事件转发; sandbox 拒绝; canUseTool 拒绝; maxTurns 触发; abort 透传 | `test/integration/` |
| **E2E (manual)** | tsx + 真实 LLM | AgentTool 派生子 agent 完成真实任务; BashTool 真跑 `ls` / `cat`; run_in_background 启动 + 状态查; maxTurns 触发 | `test/e2e/manual/` |

### 8.2 MockModelCaller fixture

```ts
// test/fixtures/MockModelCaller.ts
export function makeMockModelCaller(scenario: 'text-only' | 'one-tool' | 'multi-tool' | 'subagent' | 'error' | 'infinite-loop'): ModelCaller {
  return async function* (req) {
    if (scenario === 'text-only') {
      yield { type: 'message_start', message: { id: 'm1' } }
      yield { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } }
      yield { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'hello' } }
      yield { type: 'content_block_stop', index: 0 }
      yield { type: 'message_stop' }
      return
    }
    if (scenario === 'one-tool') {
      yield { type: 'message_start', message: { id: 'm1' } }
      yield { type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id: 't1', name: 'Bash', input: {} } }
      yield { type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: '{"command":"ls"}' } }
      yield { type: 'content_block_stop', index: 0 }
      yield { type: 'message_stop' }
      return
    }
    // ... subagent / error / infinite-loop 实现略
  }
}
```

### 8.3 关键集成测试用例

```ts
// test/integration/queryLoop.test.ts
test('happy path: text-only response emits done event', async () => {
  const config = makeConfig({ modelCaller: makeMockModelCaller('text-only') })
  const events = await collect(runQuery({ prompt: 'hi', cwd: '/tmp' }, config))
  expect(events.at(-1)?.type).toBe('runtime.done')
})

test('tool call: Bash 跑 ls, 输出回流到 messages, 下一轮得到 done', async () => {
  const config = makeConfig({
    modelCaller: makeMockModelCaller('one-tool-then-text'),
    sandbox: { executor: 'child_process', workdir: '/tmp' },
  })
  const events = await collect(runQuery({ prompt: 'list /tmp', cwd: '/tmp' }, config))
  const stdout = events.find(e => e.type === 'tool_use:done')?.output
  expect(stdout).toContain('<stdout>')
})

test('sandbox: command matches denylist, canUseTool returns deny', async () => {
  const config = makeConfig({
    sandbox: { executor: 'child_process', workdir: '/tmp', commandDenylist: [/^rm\b/] },
  })
  const result = await canUseToolFactory(config)('Bash', { command: 'rm -rf /' })
  expect(result.behavior).toBe('deny')
})

test('sub-agent: AgentTool 派生子 agent, 事件全量转发', async () => {
  const config = makeConfig({ modelCaller: makeMockModelCaller('subagent') })
  const events = await collect(runQuery({ prompt: '请子 agent 干 X', cwd: '/tmp' }, config))
  expect(events.some(e => e.type === 'subagent:start')).toBe(true)
  expect(events.some(e => e.type === 'subagent:event')).toBe(true)
  expect(events.some(e => e.type === 'subagent:done')).toBe(true)
  const subId = events.find(e => e.type === 'subagent:start')?.subSessionId
  expect(subId).toMatch(/-sub-[0-9a-f]{8}$/)
})

test('maxTurns: 强制 50 步收尾, 发 runtime.error(code: max_turns_reached)', async () => {
  const config = makeConfig({ modelCaller: makeMockModelCaller('infinite-loop'), defaultMaxTurns: 5 })
  const events = await collect(runQuery({ prompt: 'loop', cwd: '/tmp' }, config))
  const err = events.find(e => e.type === 'runtime.error')
  expect(err?.error.code).toBe('max_turns_reached')
})

test('abort: abort signal 透传到子 query', async () => {
  // mock 5s delay modelCaller, 1s 后 abort, 验证子 < 100ms 退出
})
```

### 8.4 风险清单 + 缓解

| 风险 | 缓解 |
|------|------|
| **sub-agent 无限递归**（用户选全开放）| maxTurns 默认 25 强制兜底；zai-server 端可注入更严 `RuntimeConfig.defaultMaxTurns` |
| **SSE 流量爆炸**（sub-agent 事件全量转发）| zai-server 端可加 backpressure；zai-agent-core 暴露 `RuntimeConfig.maxSubagentDepth` 软限制（v1 不实现, 留字段） |
| **sandbox child_process 逃逸**（沙箱不严）| 本轮只用 env 隔离 + workdir + 白名单；docker/gVisor 留后续；不实现 root 用户运行 |
| **modelCaller 兼容性**（各家 SDK 流 delta 顺序不同）| RuntimeConfig 接受 `normalizeOutputStream` 回调, zai-server 注入把各家流归一到 Anthropic 形态（v1 不实现, 留字段） |
| **transcript 并发**（proper-lockfile 跨进程不行）| zai-server 假设单进程多 session, 跨进程 zai 不支持（README 注明） |
| **AGENTS.md 大文件** | loadAgentsMd 限制 1MB, 超大文件发 warning 跳过 |
| **OpenCC 镜像漂移**（将来 sync-from-opencc 跑一次可能冲掉注释）| 镜像 README 加注: 'sub-agent + Bash 不在镜像范围' |

### 8.5 验收标准

- [ ] `pnpm test` 全部通过, 包含 6 个新增集成测试
- [ ] `pnpm test:e2e` 真实 LLM 跑通 "sub-agent 修复测试文件" 任务
- [ ] `getZaiRuntimeTools()` 返回 10 个 tool（Bash + 8 base + AgentTool）注册到 RuntimeConfig
- [ ] `DefaultAgentRuntime.run({ prompt, cwd })` 端到端可流式输出 RuntimeEvent
- [ ] sub-agent 调起后, 父 SSE 能看到 `subagent:start` / `subagent:event` / `subagent:done` 三段
- [ ] `~/.zai/agents/general-purpose.md` 存在时, AgentTool 优先使用其 systemPrompt
- [ ] `RuntimeConfig.sandbox = { commandDenylist: [/^rm\b/] }` 时, `Bash(command='rm -rf /')` 被 canUseTool 拒绝
- [ ] abort signal 透传到子 query, 父 abort 后子 < 100ms 内退出
- [ ] maxTurns=5 + 死循环 tool, 第 5 步后发 `runtime.error(code: max_turns_reached)`
- [ ] `opencc-internals/` 镜像文件 0 修改（git diff 干净）

## 9. 关键决策汇总

| 维度 | 选择 |
|------|------|
| 范围 | BashTool + AgentTool + sub-agent 接入 (spawn / createSubagentContext / canUseTool / streaming) |
| Sub-agent 执行模型 | 同进程递归 query |
| Query loop | zai 自写最小 loop (~600-1000 行) |
| LLM 客户端 | `RuntimeConfig.modelCaller` 注入, zai-agent-core 零 SDK |
| BashTool 沙箱 | child_process + 白/黑名单 + env 隔离 + workdir |
| Sub-agent 工具可见性 | 全开放 (含 AgentTool 递归) |
| Sub-agent 事件/转写 | 独立 session + 全部事件转发 + transcript subagent_link |
| Sub-agent maxTurns | 25 (主 agent 50 的一半) |
| OpenCC 镜像 | 完全不动, 新代码写到 `src/tools/` |

## 10. 未来扩展（本 spec 不实现，留 hook）

- `BashOutput` / `KillBash` 工具（查询 background task）
- `RuntimeConfig.maxSubagentDepth` 软限制
- `RuntimeConfig.normalizeOutputStream` 多 provider 归一
- ask-mode UI 桥接
- pre/post tool hooks
- microcompact / reactive compact
- tool search (deferred loading)
- sub-agent `run_in_background`
- sub-agent `TeamCreate` / `SendMessage` 协调模式
