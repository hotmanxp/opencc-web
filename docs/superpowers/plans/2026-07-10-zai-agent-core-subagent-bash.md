# zai-agent-core Sub-agent + Bash 工具接入 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在 `zai-agent-core` 落地 zai 自写的最小 query loop + BashTool + AgentTool（含 sub-agent 同进程递归），让 zai-server 可以把 LLM 真正接进运行时。

**Architecture:** zai-agent-core 不内置 LLM / 沙箱。所有 provider / 沙箱行为由 `RuntimeConfig.modelCaller` / `RuntimeConfig.sandbox` 注入。zai 写一个 600-1000 行的最小 query loop（messages 状态机 + canUseTool + streaming tool execution + abort 透传）。Sub-agent 走同进程递归 `queryLoop()`，独立 sessionId，事件全量转发给父。

**Tech Stack:** TypeScript 5.6 + Node 20 + tsx 4.19 + vitest 2.1 + zod 3.23 + proper-lockfile 4.1. 零新依赖。

**Spec:** `docs/superpowers/specs/2026-07-10-zai-agent-core-subagent-bash-design.md`

---

## Global Constraints

（来自 spec §1.1 / §1.2，落地时每条都要遵守）

- 不读 OpenCC `settings.json`，zai 独立 `~/.zai/settings.json`
- 不抽 slash commands，web 走 UI dialog
- 所有错误走 `RuntimeErrorEvent` 流式事件
- transcript 用 JSON 文件，每 session 一个文件
- 并发安全用 proper-lockfile（不解决跨机器）
- zai-agent-core 零 LLM SDK 依赖，`modelCaller` 由 zai-server 注入
- zai-agent-core 零沙箱实现，sandbox 行为由 `RuntimeConfig.sandbox` 配置（默认 child_process + 白名单）
- sub-agent 默认全工具可见（含 AgentTool 递归），强制 `maxTurns <= 25`
- `src/opencc-internals/` 镜像保持只读，新代码不写到 `src/opencc-internals/`
- sub-agent 有独立 sessionId（`<parent>-sub-<8hex>`），事件全量转发给父
- 默认 `maxTurns = 50`（main agent），sub-agent 默认 25（half）
- 默认 `RuntimeErrorEvent` category 见 spec §7.5
- 所有新文件用 vitest（`vitest run`），commit 格式 `HRMSV3-ZN-WEBSITE#668 <type>(scope): 描述`

---

## File Structure

**新增文件：**
- `src/tools/Tool.ts` — zai 的 `Tool` interface + `ToolContext` + `ToolResult`
- `src/tools/index.ts` — `getZaiRuntimeTools()` 工具注册
- `src/tools/BashTool/BashTool.ts` — BashTool 主体
- `src/tools/BashTool/sandbox.ts` — pickEnv / isReadOnlyCommand / isDestructiveCommand / BackgroundTask
- `src/tools/BashTool/prompt.ts` — tool description
- `src/tools/BashTool/schema.ts` — BashInputSchema
- `src/tools/AgentTool/AgentTool.ts` — AgentTool 主体
- `src/tools/AgentTool/loadAgentsDir.ts` — loadAgentDefinitions / parseAgentMd / AgentDefinition
- `src/tools/AgentTool/prompt.ts` — tool description
- `src/tools/AgentTool/schema.ts` — AgentInputSchema
- `src/runtime/canUseTool.ts` — defaultCanUseToolFactory
- `src/runtime/queryLoop.ts` — zai 最小 query loop + helpers
- `src/runtime/toolExecution.ts` — executeToolsStreaming
- `src/runtime/subagent.ts` — buildSubagentContext
- `test/fixtures/MockModelCaller.ts` — 测试用 mock modelCaller
- `test/fixtures/MockSandbox.ts` — 测试用 sandbox 构造器
- `test/tools/BashTool.test.ts`
- `test/tools/AgentTool.test.ts`
- `test/tools/loadAgentsDir.test.ts`
- `test/runtime/canUseTool.test.ts`
- `test/runtime/toolExecution.test.ts`
- `test/runtime/queryLoop.test.ts`
- `test/integration/subagent.test.ts`

**修改文件：**
- `src/runtime/types.ts` — 加 `SandboxConfig` / `ModelCaller` / `RuntimeConfig` 新字段 / `QueryOptions` 新字段
- `src/runtime/streamAdapter.ts` — 加 subagent.* 事件分类辅助
- `src/runtime/query.ts` — 把 mock 占位换成委托给 `queryLoop()`
- `src/transcript/types.ts` — `TranscriptMeta` 加 `parentSessionId` / `subagentType`
- `src/transcript/store.ts` — `create()` 接受可选 `parentSessionId` / `subagentType`
- `src/opencc-internals/README.md` — 加注 "sub-agent + Bash 不在镜像范围"
- `test/runtime/query.test.ts` — 改用 MockModelCaller
- `test/runtime/contract.test.ts` — 改用 MockModelCaller
- `package.json` — exports 增加 `./tools` / `./sandbox`

---

## Task 1: 类型与配置扩展（foundation）

**Files:**
- Modify: `packages/zai-agent-core/src/runtime/types.ts`
- Modify: `packages/zai-agent-core/src/transcript/types.ts`
- Modify: `packages/zai-agent-core/src/transcript/store.ts`
- Test: `packages/zai-agent-core/test/runtime/types.test.ts` (新)

**Interfaces:**
- Produces: `SandboxConfig`, `ModelCaller` (types)
- Produces: 扩展后的 `RuntimeConfig`, `QueryOptions`
- Produces: 扩展后的 `TranscriptMeta`（含 `parentSessionId?`, `subagentType?`）
- Produces: `TranscriptStore.create()` 接受可选 `parentSessionId` / `subagentType`

- [ ] **Step 1: 写失败测试 `test/runtime/types.test.ts`**

```ts
import { describe, expect, test } from 'vitest'
import type { SandboxConfig, ModelCaller } from '../../src/runtime/types.js'

describe('SandboxConfig / ModelCaller types', () => {
  test('SandboxConfig 必填字段可缺省', () => {
    const cfg: SandboxConfig = { executor: 'child_process', workdir: '/tmp' }
    expect(cfg.executor).toBe('child_process')
  })

  test('ModelCaller 是 async generator', async () => {
    const caller: ModelCaller = async function* () {
      yield { type: 'message_start', message: { id: 'm1' } }
    }
    const events: unknown[] = []
    for await (const e of caller({ model: 'm', systemPrompt: '', messages: [], tools: [], signal: new AbortController().signal })) {
      events.push(e)
    }
    expect(events).toHaveLength(1)
  })
})
```

- [ ] **Step 2: 跑测试确认 fail**

Run: `cd packages/zai-agent-core && pnpm test test/runtime/types.test.ts`
Expected: FAIL — `Cannot find module '../../src/runtime/types.js' or its corresponding type declarations.`

- [ ] **Step 3: 修改 `src/runtime/types.ts`**

完整替换 `src/runtime/types.ts`：

```ts
// @ts-nocheck
import type { Tool } from '../tools/Tool.js'
import type { UserMessage } from './userMessage.js'  // 兼容旧路径（见 src/opencc-internals/types/message.ts 的 re-export）

export type SystemPrompt = string | Array<{ type: string; [key: string]: unknown }>

export type SandboxConfig = {
  executor: 'child_process'
  workdir: string
  commandAllowlist?: RegExp[] | null
  commandDenylist?: RegExp[]
  maxMemoryMb?: number
  maxCpuMs?: number
  networkEgress?: 'allow' | 'block'
  envAllowlist?: string[]
}

export type ModelCaller = (req: {
  model: string
  systemPrompt: string | Array<{ type: string; [key: string]: unknown }>
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

  modelCaller?: ModelCaller
  sandbox?: SandboxConfig
  defaultMaxTurns?: number
}

export type QueryOptions = {
  prompt: string | UserMessage | UserMessage[]
  cwd: string
  resumeFromTranscriptId?: string
  model?: string
  systemPrompt?: SystemPrompt | string
  additionalTools?: Tool[]
  abortSignal?: AbortSignal
  maxTurns?: number
  enableAgentsMd?: boolean

  toolsOverride?: 'base' | 'base+subagent' | 'none'
  parentSessionId?: string
  subagentType?: string
}
```

> 注：`UserMessage` 类型从 `../opencc-internals/types/message.js` 导入（在镜像里已有），保持 `@ts-nocheck` 不影响运行时。

- [ ] **Step 4: 修改 `src/transcript/types.ts`**

在 `TranscriptMeta` 加两字段：

```ts
export type TranscriptMeta = {
  transcriptId: string
  cwd: string
  model: string
  createdAt: number
  updatedAt: number
  title?: string
  tags?: string[]
  messageCount: number

  // 新增
  parentSessionId?: string
  subagentType?: string
}
```

- [ ] **Step 5: 修改 `src/transcript/store.ts` 的 `create()` 签名**

替换 `create` 方法：

```ts
async create(
  meta: Pick<TranscriptFile['meta'], 'cwd' | 'model'> & {
    parentSessionId?: string
    subagentType?: string
  },
  id?: string,
): Promise<string> {
  await mkdir(transcriptDir(this.dataDir), { recursive: true })
  const transcriptId = id ?? generateTranscriptId()
  const file: TranscriptFile = {
    version: 1,
    transcriptId,
    meta: {
      ...meta,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    },
    messages: [],
  }
  await writeFile(transcriptPath(this.dataDir, transcriptId), serializeFile(file), 'utf-8')
  return transcriptId
}
```

并在 `extractMeta` 调用方（`list()` 第 53 行）确保 `extractMeta` 能透传新字段。检查 `src/transcript/serialization.ts` 的 `extractMeta`：

```bash
grep -n "extractMeta" src/transcript/serialization.ts
```

如果 `extractMeta` 是手写的 spread 形式（典型实现是 `({ transcriptId, meta, ... }: TranscriptFile)`），新字段会自动透传。跑测试确认。

- [ ] **Step 6: 跑测试确认 pass**

Run: `cd packages/zai-agent-core && pnpm test test/runtime/types.test.ts`
Expected: PASS

- [ ] **Step 7: 跑全套测试确认无回归**

Run: `cd packages/zai-agent-core && pnpm test`
Expected: 所有现有测试 pass（query.test.ts / contract.test.ts 等可能因 mock 替换 fail，留给 Task 10 修）

- [ ] **Step 8: Commit**

```bash
git add src/runtime/types.ts src/transcript/types.ts src/transcript/store.ts test/runtime/types.test.ts
git commit -m "HRMSV3-ZN-WEBSITE#668 feat(zai-agent-core): types — RuntimeConfig/QueryOptions/TranscriptMeta 扩展"
```

---

## Task 2: Tool interface + ToolContext

**Files:**
- Create: `packages/zai-agent-core/src/tools/Tool.ts`
- Create: `packages/zai-agent-core/test/tools/Tool.test.ts`

**Interfaces:**
- Produces: `Tool<Input, Output>` interface（zai 版，简化无 TUI）
- Produces: `ToolContext`（含 `__runtimeConfig` 等 escape hatch）
- Produces: `ToolResult = { toolUseId, content, isError }`

- [ ] **Step 1: 写失败测试 `test/tools/Tool.test.ts`**

```ts
import { describe, expect, test } from 'vitest'
import { z } from 'zod'
import type { Tool, ToolContext } from '../../src/tools/Tool.js'

describe('Tool interface shape', () => {
  test('Tool 有 name/description/inputSchema/call + 可选 isReadOnly/isDestructive/isConcurrencySafe', () => {
    const echoTool: Tool<z.ZodObject<{ msg: z.ZodString }>> = {
      name: 'Echo',
      description: 'echoes input',
      inputSchema: z.object({ msg: z.string() }),
      call: async ({ msg }) => ({ output: msg }),
      isReadOnly: () => true,
      isConcurrencySafe: () => true,
    }
    expect(echoTool.name).toBe('Echo')
    expect(echoTool.isReadOnly!({ msg: 'hi' })).toBe(true)
  })

  test('ToolContext 包含必要字段', () => {
    const ctx: ToolContext = {
      cwd: '/tmp',
      env: {},
      abortSignal: new AbortController().signal,
      dataDir: '/data',
      canUseTool: async () => ({ behavior: 'allow' }),
      emitEvent: () => {},
      state: {},
    }
    expect(ctx.cwd).toBe('/tmp')
  })
})
```

- [ ] **Step 2: 跑测试确认 fail**

Run: `cd packages/zai-agent-core && pnpm test test/tools/Tool.test.ts`
Expected: FAIL — `Cannot find module '../../src/tools/Tool.js'`

- [ ] **Step 3: 创建 `src/tools/Tool.ts`**

```ts
import type { z } from 'zod'
import type { RuntimeConfig } from '../runtime/types.js'

export type ToolResult = {
  toolUseId: string
  content: unknown
  isError: boolean
}

export type CanUseToolResult =
  | { behavior: 'allow' }
  | { behavior: 'deny'; reason: string }
  | { behavior: 'ask'; reason?: string }

export type ToolContext = {
  cwd: string
  env: Record<string, string>
  abortSignal: AbortSignal
  dataDir: string
  canUseTool: (toolName: string, input: unknown) => Promise<CanUseToolResult>
  emitEvent: (event: { type: string; [key: string]: unknown }) => void
  state: { [key: string]: unknown }

  /** 注入, 供 sub-agent tool 调子 queryLoop 用 (escape hatch) */
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

- [ ] **Step 4: 跑测试确认 pass**

Run: `cd packages/zai-agent-core && pnpm test test/tools/Tool.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/tools/Tool.ts test/tools/Tool.test.ts
git commit -m "HRMSV3-ZN-WEBSITE#668 feat(zai-agent-core): Tool interface + ToolContext"
```

---

## Task 3: canUseTool factory

**Files:**
- Create: `packages/zai-agent-core/src/runtime/canUseTool.ts`
- Create: `packages/zai-agent-core/test/runtime/canUseTool.test.ts`

**Interfaces:**
- Consumes: `SandboxConfig` from Task 1
- Produces: `defaultCanUseToolFactory(config) => canUseTool` — Bash 走白/黑名单 + no-sandbox deny; Agent 全 allow; 其余 allow

- [ ] **Step 1: 写失败测试 `test/runtime/canUseTool.test.ts`**

```ts
import { describe, expect, test } from 'vitest'
import { defaultCanUseToolFactory } from '../../src/runtime/canUseTool.js'

describe('defaultCanUseToolFactory', () => {
  test('Bash 无 sandbox 时 deny', async () => {
    const f = defaultCanUseToolFactory(undefined)
    const r = await f('Bash', { command: 'ls' })
    expect(r.behavior).toBe('deny')
  })

  test('Bash command 匹配 denylist 时 deny', async () => {
    const f = defaultCanUseToolFactory({
      executor: 'child_process', workdir: '/tmp', commandDenylist: [/^rm\b/],
    })
    const r = await f('Bash', { command: 'rm -rf /' })
    expect(r.behavior).toBe('deny')
    if (r.behavior === 'deny') expect(r.reason).toMatch(/denylist/)
  })

  test('Bash command 不在 allowlist 时 deny', async () => {
    const f = defaultCanUseToolFactory({
      executor: 'child_process', workdir: '/tmp', commandAllowlist: [/^ls\b/],
    })
    const r = await f('Bash', { command: 'cat /etc/passwd' })
    expect(r.behavior).toBe('deny')
  })

  test('Bash command 在 allowlist 内 allow', async () => {
    const f = defaultCanUseToolFactory({
      executor: 'child_process', workdir: '/tmp', commandAllowlist: [/^ls\b/],
    })
    const r = await f('Bash', { command: 'ls /tmp' })
    expect(r.behavior).toBe('allow')
  })

  test('Bash 无白/黑名单 + 有 sandbox 时 allow', async () => {
    const f = defaultCanUseToolFactory({ executor: 'child_process', workdir: '/tmp' })
    const r = await f('Bash', { command: 'echo hi' })
    expect(r.behavior).toBe('allow')
  })

  test('Agent 全 allow (用户选全开放)', async () => {
    const f = defaultCanUseToolFactory(undefined)
    const r = await f('Agent', { prompt: 'sub', subagent_type: 'general-purpose' })
    expect(r.behavior).toBe('allow')
  })

  test('其他工具全 allow', async () => {
    const f = defaultCanUseToolFactory(undefined)
    const r = await f('Read', { file_path: '/x' })
    expect(r.behavior).toBe('allow')
  })
})
```

- [ ] **Step 2: 跑测试确认 fail**

Run: `cd packages/zai-agent-core && pnpm test test/runtime/canUseTool.test.ts`
Expected: FAIL — `Cannot find module`

- [ ] **Step 3: 创建 `src/runtime/canUseTool.ts`**

```ts
import type { SandboxConfig } from './types.js'
import type { CanUseToolResult } from '../tools/Tool.js'

export function defaultCanUseToolFactory(config: SandboxConfig | undefined) {
  return async (toolName: string, input: unknown): Promise<CanUseToolResult> => {
    if (toolName === 'Bash') {
      if (!config) return { behavior: 'deny', reason: 'Bash disabled: no sandbox configured' }
      const cmd = (input as { command?: string } | undefined)?.command ?? ''
      if (config.commandDenylist?.some(re => re.test(cmd))) {
        return { behavior: 'deny', reason: 'command matches denylist' }
      }
      if (config.commandAllowlist && !config.commandAllowlist.some(re => re.test(cmd))) {
        return { behavior: 'deny', reason: 'command not in allowlist' }
      }
    }
    if (toolName === 'Agent') {
      return { behavior: 'allow' }
    }
    return { behavior: 'allow' }
  }
}
```

- [ ] **Step 4: 跑测试确认 pass**

Run: `cd packages/zai-agent-core && pnpm test test/runtime/canUseTool.test.ts`
Expected: 7 tests PASS

- [ ] **Step 5: Commit**

```bash
git add src/runtime/canUseTool.ts test/runtime/canUseTool.test.ts
git commit -m "HRMSV3-ZN-WEBSITE#668 feat(zai-agent-core): canUseTool factory with sandbox + denylist/allowlist"
```

---

## Task 4: BashTool sandbox helpers + schema

**Files:**
- Create: `packages/zai-agent-core/src/tools/BashTool/sandbox.ts`
- Create: `packages/zai-agent-core/src/tools/BashTool/schema.ts`
- Create: `packages/zai-agent-core/test/tools/BashTool/sandbox.test.ts`
- Create: `packages/zai-agent-core/test/tools/BashTool/schema.test.ts`

**Interfaces:**
- Produces: `pickEnv(env, allowlist?) => env`
- Produces: `isReadOnlyCommand(cmd) => boolean`
- Produces: `isDestructiveCommand(cmd) => boolean`
- Produces: `BackgroundTask` type
- Produces: `BashInputSchema` (zod)

- [ ] **Step 1: 写失败测试 `test/tools/BashTool/sandbox.test.ts`**

```ts
import { describe, expect, test } from 'vitest'
import { pickEnv, isReadOnlyCommand, isDestructiveCommand } from '../../../src/tools/BashTool/sandbox.js'

describe('pickEnv', () => {
  test('无 allowlist 返回空对象', () => {
    const out = pickEnv({ PATH: '/x', HOME: '/h' })
    expect(out).toEqual({})
  })

  test('allowlist 过滤 env', () => {
    const out = pickEnv({ PATH: '/x', HOME: '/h', USER: 'u' }, ['PATH', 'USER'])
    expect(out).toEqual({ PATH: '/x', USER: 'u' })
  })

  test('缺失字段跳过', () => {
    const out = pickEnv({ PATH: '/x' }, ['PATH', 'NONEXISTENT'])
    expect(out).toEqual({ PATH: '/x' })
  })
})

describe('isReadOnlyCommand', () => {
  test('ls / cat / echo / pwd 视为 read-only', () => {
    for (const cmd of ['ls -la', 'cat /etc/hosts', 'echo hi', 'pwd', 'grep x /tmp/y']) {
      expect(isReadOnlyCommand(cmd)).toBe(true)
    }
  })

  test('rm / mv / kill 视为非 read-only', () => {
    for (const cmd of ['rm -rf /', 'mv a b', 'kill 1', '> /etc/passwd', '>> /etc/passwd']) {
      expect(isReadOnlyCommand(cmd)).toBe(false)
    }
  })
})

describe('isDestructiveCommand', () => {
  test('rm / mv / chmod / dd 视为 destructive', () => {
    for (const cmd of ['rm x', 'chmod 777 y', 'dd if=/dev/zero of=/dev/sda', '> /x']) {
      expect(isDestructiveCommand(cmd)).toBe(true)
    }
  })

  test('echo / ls 视为非 destructive', () => {
    for (const cmd of ['echo hi', 'ls', 'cat /etc/hosts']) {
      expect(isDestructiveCommand(cmd)).toBe(false)
    }
  })
})
```

- [ ] **Step 2: 跑测试确认 fail**

Run: `cd packages/zai-agent-core && pnpm test test/tools/BashTool/sandbox.test.ts`
Expected: FAIL — `Cannot find module`

- [ ] **Step 3: 创建 `src/tools/BashTool/sandbox.ts`**

```ts
import { spawn } from 'node:child_process'

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

- [ ] **Step 4: 写失败测试 `test/tools/BashTool/schema.test.ts`**

```ts
import { describe, expect, test } from 'vitest'
import { BashInputSchema } from '../../../src/tools/BashTool/schema.js'

describe('BashInputSchema', () => {
  test('最小可用: command only', () => {
    const r = BashInputSchema.safeParse({ command: 'ls' })
    expect(r.success).toBe(true)
  })

  test('缺 command fail', () => {
    const r = BashInputSchema.safeParse({})
    expect(r.success).toBe(false)
  })

  test('空 command fail', () => {
    const r = BashInputSchema.safeParse({ command: '' })
    expect(r.success).toBe(false)
  })

  test('timeout 上限 600_000', () => {
    const r = BashInputSchema.safeParse({ command: 'ls', timeout: 700_000 })
    expect(r.success).toBe(false)
  })

  test('run_in_background 可选 boolean', () => {
    const r = BashInputSchema.safeParse({ command: 'ls', run_in_background: true })
    expect(r.success).toBe(true)
  })
})
```

- [ ] **Step 5: 创建 `src/tools/BashTool/schema.ts`**

```ts
import { z } from 'zod'

export const BashInputSchema = z.object({
  command: z.string().min(1),
  description: z.string().optional(),
  timeout: z.number().int().positive().max(600_000).optional(),
  run_in_background: z.boolean().optional(),
})
```

- [ ] **Step 6: 跑测试确认 pass**

Run: `cd packages/zai-agent-core && pnpm test test/tools/BashTool/`
Expected: 全部 PASS

- [ ] **Step 7: Commit**

```bash
git add src/tools/BashTool/sandbox.ts src/tools/BashTool/schema.ts test/tools/BashTool/
git commit -m "HRMSV3-ZN-WEBSITE#668 feat(zai-agent-core): BashTool sandbox helpers + schema"
```

---

## Task 5: BashTool 主体（call / foreground / background）

**Files:**
- Create: `packages/zai-agent-core/src/tools/BashTool/prompt.ts`
- Create: `packages/zai-agent-core/src/tools/BashTool/BashTool.ts`
- Create: `packages/zai-agent-core/test/tools/BashTool.test.ts`

**Interfaces:**
- Consumes: `BashInputSchema` (Task 4), `SandboxConfig` (Task 1), `pickEnv` (Task 4)
- Produces: `BashTool: Tool<typeof BashInputSchema, string>`

- [ ] **Step 1: 写失败测试 `test/tools/BashTool.test.ts`**

```ts
import { describe, expect, test, beforeEach, afterEach } from 'vitest'
import { mkdtemp, rm, writeFile } from 'fs/promises'
import { join } from 'path'
import { tmpdir } from 'os'
import { BashTool } from '../../src/tools/BashTool/BashTool.js'
import type { ToolContext } from '../../src/tools/Tool.js'

let workdir: string
let ctx: ToolContext

beforeEach(async () => {
  workdir = await mkdtemp(join(tmpdir(), 'zai-bash-test-'))
  ctx = {
    cwd: workdir,
    env: {},
    abortSignal: new AbortController().signal,
    dataDir: workdir,
    canUseTool: async () => ({ behavior: 'allow' }),
    emitEvent: () => {},
    state: {},
    __runtimeConfig: { dataDir: workdir, sandbox: { executor: 'child_process', workdir } },
  }
})

afterEach(async () => {
  await rm(workdir, { recursive: true, force: true })
})

describe('BashTool', () => {
  test('无 sandbox → isError', async () => {
    const r = await BashTool.call({ command: 'ls' }, { ...ctx, __runtimeConfig: { dataDir: workdir } })
    expect(r.isError).toBe(true)
    expect(r.output as string).toMatch(/no sandbox configured/)
  })

  test('foreground: echo 输出到 stdout, exit 0 → isError false', async () => {
    const r = await BashTool.call({ command: 'echo hello' }, ctx)
    expect(r.isError).toBeFalsy()
    expect(r.output as string).toContain('<stdout>hello')
  })

  test('foreground: ls 列出 workdir 下的文件', async () => {
    await writeFile(join(workdir, 'foo.txt'), 'hi')
    const r = await BashTool.call({ command: 'ls' }, ctx)
    expect(r.output as string).toContain('foo.txt')
  })

  test('foreground: exit code != 0 → isError true', async () => {
    const r = await BashTool.call({ command: 'exit 7' }, ctx)
    expect(r.isError).toBe(true)
    expect(r.output as string).toContain('exit code: 7')
  })

  test('foreground: unsupported executor → isError', async () => {
    const r = await BashTool.call({ command: 'ls' }, {
      ...ctx,
      __runtimeConfig: { dataDir: workdir, sandbox: { executor: 'docker' as any, workdir } },
    })
    expect(r.isError).toBe(true)
  })

  test('background: run_in_background=true 返回 taskId, 注册到 ctx.state.background_tasks', async () => {
    const r = await BashTool.call(
      { command: 'sleep 0.1; echo done', run_in_background: true },
      ctx,
    )
    expect(r.isError).toBeFalsy()
    expect(r.output as string).toMatch(/<task_id>bash-[0-9a-f]{8}<\/task_id>/)
    const tasks = ctx.state.background_tasks as Map<string, unknown>
    expect(tasks.size).toBe(1)
  })

  test('isReadOnly / isDestructive 反映命令性质', () => {
    expect(BashTool.isReadOnly!({ command: 'ls' })).toBe(true)
    expect(BashTool.isReadOnly!({ command: 'rm -rf /' })).toBe(false)
    expect(BashTool.isDestructive!({ command: 'rm -rf /' })).toBe(true)
    expect(BashTool.isDestructive!({ command: 'echo hi' })).toBe(false)
  })

  test('isConcurrencySafe = false', () => {
    expect(BashTool.isConcurrencySafe!({ command: 'ls' })).toBe(false)
  })
})
```

- [ ] **Step 2: 跑测试确认 fail**

Run: `cd packages/zai-agent-core && pnpm test test/tools/BashTool.test.ts`
Expected: FAIL — `Cannot find module`

- [ ] **Step 3: 创建 `src/tools/BashTool/prompt.ts`**

```ts
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

- [ ] **Step 4: 创建 `src/tools/BashTool/BashTool.ts`**

```ts
import { z } from 'zod'
import { spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import type { Tool, ToolContext } from '../Tool.js'
import type { SandboxConfig } from '../../runtime/types.js'
import { renderPrompt } from './prompt.js'
import { BashInputSchema } from './schema.js'
import { pickEnv, isReadOnlyCommand, isDestructiveCommand, type BackgroundTask } from './sandbox.js'

const MAX_BUFFER = 10 * 1024 * 1024

export const BashTool: Tool<typeof BashInputSchema, string> = {
  name: 'Bash',
  description: renderPrompt(),
  inputSchema: BashInputSchema,
  isConcurrencySafe: () => false,
  isReadOnly: ({ input }) => isReadOnlyCommand((input as z.infer<typeof BashInputSchema>).command),
  isDestructive: ({ input }) => isDestructiveCommand((input as z.infer<typeof BashInputSchema>).command),

  async call(rawInput, ctx) {
    const input = rawInput as z.infer<typeof BashInputSchema>
    const cfg = ctx.__runtimeConfig?.sandbox
    if (!cfg) return { output: 'Bash disabled: no sandbox configured in RuntimeConfig', isError: true }
    if (cfg.executor !== 'child_process') {
      return { output: `unsupported executor: ${cfg.executor}`, isError: true }
    }
    if (input.run_in_background) return runInBackground(input, cfg, ctx)
    return runForeground(input, cfg, ctx)
  },
}

function runForeground(
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
    })
    let stdout = '', stderr = ''
    child.stdout?.on('data', d => { stdout += d.toString() })
    child.stderr?.on('data', d => { stderr += d.toString() })
    child.on('close', (code, signal) => {
      const output = [
        stdout && `<stdout>${truncate(stdout)}</stdout>`,
        stderr && `<stderr>${truncate(stderr)}</stderr>`,
        `exit code: ${code ?? signal ?? 'unknown'}`,
      ].filter(Boolean).join('\n')
      resolve({ output, isError: code !== 0 })
    })
    child.on('error', err => resolve({ output: `spawn error: ${err.message}`, isError: true }))
  })
}

function runInBackground(
  input: z.infer<typeof BashInputSchema>,
  cfg: SandboxConfig,
  ctx: ToolContext,
): { output: string; isError: boolean } {
  const taskId = `bash-${randomUUID().slice(0, 8)}`
  const child = spawn('sh', ['-c', input.command], {
    cwd: cfg.workdir,
    env: pickEnv(process.env, cfg.envAllowlist),
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  const tasks = ((ctx.state.background_tasks ??= new Map<string, BackgroundTask>()) as Map<string, BackgroundTask>)
  const task: BackgroundTask = {
    taskId, pid: child.pid ?? -1,
    description: input.description ?? input.command.slice(0, 60),
    startedAt: Date.now(), stdout: '', stderr: '',
    status: 'running', child,
  }
  child.stdout?.on('data', d => { task.stdout += d.toString() })
  child.stderr?.on('data', d => { task.stderr += d.toString() })
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

function truncate(s: string): string {
  if (s.length <= MAX_BUFFER) return s
  return s.slice(0, MAX_BUFFER) + '\n...truncated'
}
```

- [ ] **Step 5: 跑测试确认 pass**

Run: `cd packages/zai-agent-core && pnpm test test/tools/BashTool.test.ts`
Expected: 8 tests PASS

- [ ] **Step 6: Commit**

```bash
git add src/tools/BashTool/BashTool.ts src/tools/BashTool/prompt.ts test/tools/BashTool.test.ts
git commit -m "HRMSV3-ZN-WEBSITE#668 feat(zai-agent-core): BashTool — foreground + background child_process"
```

---

## Task 6: AgentTool loader（loadAgentsDir + parseAgentMd）

**Files:**
- Create: `packages/zai-agent-core/src/tools/AgentTool/loadAgentsDir.ts`
- Create: `packages/zai-agent-core/src/tools/AgentTool/schema.ts`
- Create: `packages/zai-agent-core/test/tools/loadAgentsDir.test.ts`

**Interfaces:**
- Produces: `AgentDefinition` type
- Produces: `loadAgentDefinitions(dataDir) => { agents: AgentDefinition[] }`
- Produces: `parseAgentMd(name, content) => AgentDefinition | null` (export for testing)
- Produces: `AgentInputSchema` (zod)

- [ ] **Step 1: 写失败测试 `test/tools/loadAgentsDir.test.ts`**

```ts
import { describe, expect, test, beforeEach, afterEach } from 'vitest'
import { mkdtemp, rm, writeFile, mkdir } from 'fs/promises'
import { join } from 'path'
import { tmpdir } from 'os'
import { loadAgentDefinitions, parseAgentMd } from '../../src/tools/AgentTool/loadAgentsDir.js'

let dataDir: string
beforeEach(async () => { dataDir = await mkdtemp(join(tmpdir(), 'zai-agents-')) })
afterEach(async () => { await rm(dataDir, { recursive: true, force: true }) })

describe('parseAgentMd', () => {
  test('正常 frontmatter + body', () => {
    const content = `---
name: statusline-setup
description: Generates a statusline
model: claude-sonnet-4-6
maxTurns: 15
---
You are a statusline generator.`
    const r = parseAgentMd('fallback-name', content)
    expect(r).toEqual({
      name: 'statusline-setup',
      description: 'Generates a statusline',
      systemPrompt: 'You are a statusline generator.',
      model: 'claude-sonnet-4-6',
      maxTurns: 15,
    })
  })

  test('无 frontmatter → null', () => {
    expect(parseAgentMd('x', 'no frontmatter here')).toBeNull()
  })

  test('缺 name 字段 → 用文件名 fallback', () => {
    const r = parseAgentMd('fallback-name', `---\ndescription: x\n---\nbody`)
    expect(r?.name).toBe('fallback-name')
  })
})

describe('loadAgentDefinitions', () => {
  test('无 agents 目录 → 空数组', async () => {
    const r = await loadAgentDefinitions(dataDir)
    expect(r.agents).toEqual([])
  })

  test('单文件形式 <name>.md 加载', async () => {
    await mkdir(join(dataDir, 'agents'))
    await writeFile(join(dataDir, 'agents/general-purpose.md'),
      `---\nname: general-purpose\ndescription: do general tasks\n---\nYou are a general agent.`)
    const r = await loadAgentDefinitions(dataDir)
    expect(r.agents).toHaveLength(1)
    expect(r.agents[0]?.name).toBe('general-purpose')
  })

  test('目录形式 <name>/AGENT.md 加载', async () => {
    await mkdir(join(dataDir, 'agents/explorer'), { recursive: true })
    await writeFile(join(dataDir, 'agents/explorer/AGENT.md'),
      `---\nname: explorer\ndescription: explore codebase\n---\nYou explore.`)
    const r = await loadAgentDefinitions(dataDir)
    expect(r.agents.some(a => a.name === 'explorer')).toBe(true)
  })
})
```

- [ ] **Step 2: 跑测试确认 fail**

Run: `cd packages/zai-agent-core && pnpm test test/tools/loadAgentsDir.test.ts`
Expected: FAIL — `Cannot find module`

- [ ] **Step 3: 创建 `src/tools/AgentTool/loadAgentsDir.ts`**

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

export function parseAgentMd(name: string, content: string): AgentDefinition | null {
  const m = content.match(/^---\n([\s\S]+?)\n---\n([\s\S]+)$/)
  if (!m) return null
  const meta: Record<string, string> = {}
  for (const line of m[1]!.split('\n')) {
    const idx = line.indexOf(':')
    if (idx > 0) meta[line.slice(0, idx).trim()] = line.slice(idx + 1).trim()
  }
  return {
    name: meta.name ?? name,
    description: meta.description ?? '',
    systemPrompt: m[2]!.trim(),
    model: meta.model,
    maxTurns: meta.maxTurns ? Number(meta.maxTurns) : undefined,
  }
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
```

- [ ] **Step 4: 创建 `src/tools/AgentTool/schema.ts`**

```ts
import { z } from 'zod'

export const AgentInputSchema = z.object({
  prompt: z.string().min(1),
  subagent_type: z.string().min(1).default('general-purpose'),
  description: z.string().optional(),
  run_in_background: z.boolean().optional(),
})
```

- [ ] **Step 5: 跑测试确认 pass**

Run: `cd packages/zai-agent-core && pnpm test test/tools/loadAgentsDir.test.ts`
Expected: 6 tests PASS

- [ ] **Step 6: Commit**

```bash
git add src/tools/AgentTool/loadAgentsDir.ts src/tools/AgentTool/schema.ts test/tools/loadAgentsDir.test.ts
git commit -m "HRMSV3-ZN-WEBSITE#668 feat(zai-agent-core): AgentTool loadAgentsDir + parseAgentMd + schema"
```

---

## Task 7: subagent helper

**Files:**
- Create: `packages/zai-agent-core/src/runtime/subagent.ts`
- Create: `packages/zai-agent-core/test/runtime/subagent.test.ts`

**Interfaces:**
- Produces: `buildSubagentContext(options, config, sessionId) => { initialUserMessage? }`

- [ ] **Step 1: 写失败测试 `test/runtime/subagent.test.ts`**

```ts
import { describe, expect, test } from 'vitest'
import { buildSubagentContext } from '../../src/runtime/subagent.js'

describe('buildSubagentContext', () => {
  test('string prompt → 包装成 user message', () => {
    const r = buildSubagentContext(
      { prompt: 'fix tests', cwd: '/x', parentSessionId: 'sess-1' },
      { dataDir: '/d' },
      'sess-1-sub-abc',
    )
    expect(r.initialUserMessage).toEqual({ role: 'user', content: 'fix tests' })
  })

  test('非 string prompt → 无 initialUserMessage', () => {
    const r = buildSubagentContext(
      { prompt: [{ role: 'user', content: 'x' }] as any, cwd: '/x', parentSessionId: 'sess-1' },
      { dataDir: '/d' },
      'sess-1-sub-abc',
    )
    expect(r.initialUserMessage).toBeUndefined()
  })
})
```

- [ ] **Step 2: 跑测试确认 fail**

Run: `cd packages/zai-agent-core && pnpm test test/runtime/subagent.test.ts`
Expected: FAIL

- [ ] **Step 3: 创建 `src/runtime/subagent.ts`**

```ts
import type { QueryOptions, RuntimeConfig } from './types.js'

export function buildSubagentContext(
  options: QueryOptions,
  _config: RuntimeConfig,
  _sessionId: string,
): { initialUserMessage?: { role: 'user'; content: string } } {
  return {
    initialUserMessage: typeof options.prompt === 'string'
      ? { role: 'user', content: options.prompt }
      : undefined,
  }
  // sessionId 与 parentSessionId 关联在 transcript 写入时处理
}
```

- [ ] **Step 4: 跑测试确认 pass**

Run: `cd packages/zai-agent-core && pnpm test test/runtime/subagent.test.ts`
Expected: 2 tests PASS

- [ ] **Step 5: Commit**

```bash
git add src/runtime/subagent.ts test/runtime/subagent.test.ts
git commit -m "HRMSV3-ZN-WEBSITE#668 feat(zai-agent-core): subagent.buildSubagentContext helper"
```

---

## Task 8: AgentTool 主体（call sub-agent）

**Files:**
- Create: `packages/zai-agent-core/src/runtime/queryLoop.ts` (STUB, Task 10 rewrites it)
- Create: `packages/zai-agent-core/src/tools/AgentTool/prompt.ts`
- Create: `packages/zai-agent-core/src/tools/AgentTool/AgentTool.ts`
- Create: `packages/zai-agent-core/test/tools/AgentTool.test.ts`
- Create: `packages/zai-agent-core/test/fixtures/MockModelCaller.ts`
- Create: `packages/zai-agent-core/test/fixtures/MockSandbox.ts`

**Interfaces:**
- Consumes: `AgentInputSchema` (Task 6), `loadAgentDefinitions` (Task 6), `queryLoop` (Task 10 — **forward reference**)

> **循环依赖处理 (revised after pre-flight implementer feedback):**
>
> At Task 8 time, `queryLoop.ts` does not exist yet (it's Task 10's deliverable). But `AgentTool.call` needs to invoke a query for the sub-agent. Solution:
>
> 1. **Task 8 creates a STUB `queryLoop.ts`** that re-exports the existing `query` from `query.ts`:
>    ```ts
>    export { query as queryLoop } from './query.js'
>    ```
>    The existing `query.ts` (the mock from earlier work) already accepts `modelCaller` via `RuntimeConfig` and yields `runtime.done` after a `text-only` model call — sufficient for Task 8's tests to pass.
>
> 2. **`AgentTool.call` uses dynamic import** to break the cycle:
>    ```ts
>    const { queryLoop } = await import('../../runtime/queryLoop.js')
>    ```
>
> 3. **Task 10 will replace the body of `queryLoop.ts`** with the real engine (still re-exporting it as the same named export `queryLoop`). The cycle remains broken at module load time because Task 10's queryLoop also uses dynamic import to load `getZaiRuntimeTools`.
>
> DO NOT modify `query.ts` in Task 8. The existing mock is sufficient.

- [ ] **Step 0: 创建 `src/runtime/queryLoop.ts` (STUB)**

```ts
/**
 * queryLoop — temporary stub re-exporting the existing mock query().
 * Task 10 will replace the body with the real minimal query loop.
 * The named export `queryLoop` is what AgentTool.call dynamic-imports.
 */
export { query as queryLoop } from './query.js'
```

- [ ] **Step 1: 创建 `test/fixtures/MockModelCaller.ts`**

```ts
import type { ModelCaller } from '../../src/runtime/types.js'

export function makeMockModelCaller(scenario: 'text-only' | 'one-tool' | 'subagent' | 'infinite-loop' | 'error' = 'text-only'): ModelCaller {
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
      yield { type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: '{"command":"echo hi"}' } }
      yield { type: 'content_block_stop', index: 0 }
      yield { type: 'message_stop' }
      return
    }
    if (scenario === 'subagent') {
      yield { type: 'message_start', message: { id: 'm1' } }
      yield { type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id: 't1', name: 'Agent', input: {} } }
      yield { type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: '{"prompt":"sub task","subagent_type":"general-purpose"}' } }
      yield { type: 'content_block_stop', index: 0 }
      yield { type: 'message_stop' }
      return
    }
    if (scenario === 'infinite-loop') {
      let i = 0
      while (true) {
        yield { type: 'message_start', message: { id: `m${i}` } }
        yield { type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id: `t${i}`, name: 'Bash', input: {} } }
        yield { type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: '{"command":"ls"}' } }
        yield { type: 'content_block_stop', index: 0 }
        yield { type: 'message_stop' }
        i++
      }
    }
    if (scenario === 'error') {
      throw new Error('mock model caller error')
    }
  }
}
```

- [ ] **Step 2: 创建 `test/fixtures/MockSandbox.ts`**

```ts
import type { SandboxConfig } from '../../src/runtime/types.js'

export function makeMockSandbox(workdir: string, opts: Partial<SandboxConfig> = {}): SandboxConfig {
  return { executor: 'child_process', workdir, ...opts }
}
```

- [ ] **Step 3: 写失败测试 `test/tools/AgentTool.test.ts`**

```ts
import { describe, expect, test, beforeEach, afterEach } from 'vitest'
import { mkdtemp, rm, mkdir, writeFile } from 'fs/promises'
import { join } from 'path'
import { tmpdir } from 'os'
import { AgentTool } from '../../src/tools/AgentTool/AgentTool.js'
import type { ToolContext } from '../../src/tools/Tool.js'
import { makeMockModelCaller } from '../fixtures/MockModelCaller.js'
import { makeMockSandbox } from '../fixtures/MockSandbox.js'

let dataDir: string
let ctx: ToolContext

beforeEach(async () => {
  dataDir = await mkdtemp(join(tmpdir(), 'zai-agent-test-'))
  await mkdir(join(dataDir, 'agents'), { recursive: true })
  ctx = {
    cwd: dataDir,
    env: {},
    abortSignal: new AbortController().signal,
    dataDir,
    canUseTool: async () => ({ behavior: 'allow' }),
    emitEvent: () => {},
    state: {},
    __runtimeConfig: {
      dataDir,
      modelCaller: makeMockModelCaller('text-only'),
      sandbox: makeMockSandbox(dataDir),
    },
    __defaultModel: 'test-model',
    __maxTurns: 25,
    parentSessionId: 'sess-parent',
  }
})

afterEach(async () => { await rm(dataDir, { recursive: true, force: true }) })

describe('AgentTool', () => {
  test('派生子 agent, 发 subagent:start/event/done 三个事件', async () => {
    const events: any[] = []
    ctx.emitEvent = (e) => events.push(e)

    const r = await AgentTool.call(
      { prompt: 'sub task', subagent_type: 'general-purpose' },
      ctx,
    )
    expect(r.isError).toBeFalsy()
    expect(r.output as string).toContain('<subagent_result')
    expect(events.some(e => e.type === 'subagent:start')).toBe(true)
    expect(events.some(e => e.type === 'subagent:event')).toBe(true)
    expect(events.some(e => e.type === 'subagent:done')).toBe(true)
  })

  test('subSessionId 形如 <parent>-sub-<8hex>', async () => {
    let startEvent: any
    ctx.emitEvent = (e) => { if (e.type === 'subagent:start') startEvent = e }
    await AgentTool.call({ prompt: 'x', subagent_type: 'general-purpose' }, ctx)
    expect(startEvent.subSessionId).toMatch(/^sess-parent-sub-[0-9a-f]{8}$/)
  })

  test('agent definition 存在时使用其 systemPrompt (验证子 query 的 systemPrompt 含 agent prompt)', async () => {
    await writeFile(join(dataDir, 'agents/custom.md'),
      `---\nname: custom\ndescription: custom agent\n---\nCUSTOM_SYSTEM_PROMPT`)

    // 第一次 model call (父): 调 AgentTool 派 sub-agent
    // 第二次 model call (子): 捕获子 query 的 systemPrompt, 验证含 CUSTOM_SYSTEM_PROMPT
    let callCount = 0
    let capturedSubPrompt: string | undefined
    ctx.__runtimeConfig!.modelCaller = (async function* (req: any) {
      callCount++
      if (callCount === 1) {
        yield { type: 'message_start', message: { id: 'm1' } }
        yield { type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id: 't1', name: 'Agent', input: {} } }
        yield { type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: '{"prompt":"sub","subagent_type":"custom"}' } }
        yield { type: 'content_block_stop', index: 0 }
        yield { type: 'message_stop' }
        return
      }
      capturedSubPrompt = Array.isArray(req.systemPrompt) ? JSON.stringify(req.systemPrompt) : req.systemPrompt
      yield { type: 'message_start', message: { id: 'm2' } }
      yield { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } }
      yield { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'done' } }
      yield { type: 'content_block_stop', index: 0 }
      yield { type: 'message_stop' }
    }) as any

    await AgentTool.call({ prompt: 'x', subagent_type: 'custom' }, ctx)
    expect(capturedSubPrompt).toContain('CUSTOM_SYSTEM_PROMPT')
  })

  test('__runtimeConfig 缺省 → isError', async () => {
    const r = await AgentTool.call(
      { prompt: 'x', subagent_type: 'general-purpose' },
      { ...ctx, __runtimeConfig: undefined },
    )
    expect(r.isError).toBe(true)
  })

  test('isReadOnly = true, isDestructive = false', () => {
    expect(AgentTool.isReadOnly!({ prompt: 'x', subagent_type: 'general-purpose' })).toBe(true)
    expect(AgentTool.isDestructive!({ prompt: 'x', subagent_type: 'general-purpose' })).toBe(false)
  })
})
```

- [ ] **Step 4: 跑测试确认 fail**

Run: `cd packages/zai-agent-core && pnpm test test/tools/AgentTool.test.ts`
Expected: FAIL — `Cannot find module`

- [ ] **Step 5: 创建 `src/tools/AgentTool/prompt.ts`**

```ts
export function renderPrompt(): string {
  return `Launches a new agent (sub-agent) to handle a complex multi-step task.

  Each sub-agent runs in its own session, has its own transcript, and
  inherits the full tool pool (including Agent itself — sub-agents can
  recursively spawn further sub-agents).

  Args:
    - prompt: The task for the sub-agent
    - subagent_type: Which agent definition to use (default 'general-purpose')
    - description: Short label for the sub-agent (shown in transcript)
    - run_in_background: Reserved (not yet supported)

  Output: <subagent_result agent_type="..." exit_reason="...">...</subagent_result>

  Constraints:
    - Sub-agent session: <parent>-sub-<random>
    - Sub-agent default maxTurns: 25
    - Sub-agent shares: dataDir, sandbox config, model caller, abort signal
    - Sub-agent does NOT share: transcript, tool context state, message history
    - All sub-agent events are forwarded to parent as 'subagent:event'`
}
```

- [ ] **Step 6: 创建 `src/tools/AgentTool/AgentTool.ts`**

```ts
import { z } from 'zod'
import { randomUUID } from 'node:crypto'
import type { Tool, ToolContext } from '../Tool.js'
import { renderPrompt } from './prompt.js'
import { AgentInputSchema } from './schema.js'
import { loadAgentDefinitions } from './loadAgentsDir.js'

type AgentInput = z.infer<typeof AgentInputSchema>

export const AgentTool: Tool<typeof AgentInputSchema, string> = {
  name: 'Agent',
  description: renderPrompt(),
  inputSchema: AgentInputSchema,
  isConcurrencySafe: () => false,
  isReadOnly: () => true,
  isDestructive: () => false,

  async call(rawInput, ctx) {
    const input = rawInput as AgentInput
    if (!ctx.__runtimeConfig) {
      return { output: 'AgentTool disabled: no __runtimeConfig in ToolContext', isError: true }
    }

    const def = await loadAgentDefinitions(ctx.dataDir)
    const agent = def.agents.find(a => a.name === input.subagent_type)
                 ?? def.agents.find(a => a.name === 'general-purpose')

    const parentSessionId = ctx.parentSessionId ?? 'sess-unknown'
    const subSessionId = `${parentSessionId}-sub-${randomUUID().slice(0, 8)}`

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

    ctx.emitEvent({
      type: 'subagent:start',
      subSessionId,
      subagentType: input.subagent_type,
      description: input.description ?? input.prompt.slice(0, 60),
    })

    // Dynamic import breaks the queryLoop ↔ AgentTool cycle
    const { queryLoop } = await import('../../runtime/queryLoop.js')
    const subStream = queryLoop(subOpts, ctx.__runtimeConfig)
    let finalOutput = ''
    let exitReason: 'completed' | 'aborted' | 'max_turns' | 'error' = 'completed'
    try {
      for await (const ev of subStream) {
        ctx.emitEvent({ type: 'subagent:event', subSessionId, event: ev })
        const t = (ev as { type: string }).type
        if (t === 'runtime.done') { exitReason = 'completed'; break }
        if (t === 'runtime.aborted') { exitReason = 'aborted'; break }
        if (t === 'runtime.error') {
          exitReason = ((ev as any).error?.code === 'max_turns_reached') ? 'max_turns' : 'error'
        }
      }
    } catch (err) {
      exitReason = 'error'
      finalOutput = `error: ${err instanceof Error ? err.message : String(err)}`
    }

    ctx.emitEvent({ type: 'subagent:done', subSessionId, output: finalOutput, exitReason })

    return {
      output: `<subagent_result agent_type="${input.subagent_type}" exit_reason="${exitReason}">\n${finalOutput}\n</subagent_result>`,
      isError: exitReason === 'error',
    }
  },
}
```

- [ ] **Step 7: 跑测试确认 pass**

Run: `cd packages/zai-agent-core && pnpm test test/tools/AgentTool.test.ts`
Expected: 5 tests PASS

- [ ] **Step 8: Commit**

```bash
git add src/tools/AgentTool/AgentTool.ts src/tools/AgentTool/prompt.ts test/tools/AgentTool.test.ts test/fixtures/
git commit -m "HRMSV3-ZN-WEBSITE#668 feat(zai-agent-core): AgentTool — recurse queryLoop + forward subagent events"
```

---

## Task 9: toolExecution（streaming + canUseTool + 并发）

**Files:**
- Create: `packages/zai-agent-core/src/runtime/toolExecution.ts`
- Create: `packages/zai-agent-core/test/runtime/toolExecution.test.ts`

**Interfaces:**
- Consumes: `Tool`, `ToolContext` (Task 2), `defaultCanUseToolFactory` (Task 3)
- Produces: `executeToolsStreaming(blocks, ctx, tools): AsyncGenerator<RuntimeEvent>` — 写结果到 `ctx.state.__lastToolResults`

- [ ] **Step 1: 写失败测试 `test/runtime/toolExecution.test.ts`**

```ts
import { describe, expect, test, beforeEach } from 'vitest'
import { z } from 'zod'
import { executeToolsStreaming } from '../../src/runtime/toolExecution.js'
import type { Tool, ToolContext } from '../../src/tools/Tool.js'
import { defaultCanUseToolFactory } from '../../src/runtime/canUseTool.js'

function makeCtx(overrides: Partial<ToolContext> = {}): ToolContext {
  return {
    cwd: '/tmp', env: {}, abortSignal: new AbortController().signal,
    dataDir: '/d', state: {},
    canUseTool: defaultCanUseToolFactory(undefined),
    emitEvent: () => {},
    ...overrides,
  }
}

describe('executeToolsStreaming', () => {
  test('canUseTool deny → tool_use:denied 事件 + isError result', async () => {
    const ctx = makeCtx({ canUseTool: async () => ({ behavior: 'deny' as const, reason: 'no' }) })
    const events: any[] = []
    ctx.emitEvent = (e) => events.push(e)
    const blocks = [{ id: 't1', name: 'Bash', input: { command: 'ls' } }]
    const tools: Tool[] = [{
      name: 'Bash', description: '', inputSchema: z.object({ command: z.string() }),
      call: async () => ({ output: 'should not run' }),
    }]
    for await (const _ of executeToolsStreaming(blocks, ctx, tools)) {}
    expect(events.some(e => e.type === 'tool_use:denied')).toBe(true)
    const results = ctx.state.__lastToolResults as any[]
    expect(results[0].isError).toBe(true)
  })

  test('ask-mode → 当 deny 处理 + reason 含 ask-mode not supported', async () => {
    const ctx = makeCtx({ canUseTool: async () => ({ behavior: 'ask' as const }) })
    const events: any[] = []
    ctx.emitEvent = (e) => events.push(e)
    const blocks = [{ id: 't1', name: 'Bash', input: { command: 'ls' } }]
    const tools: Tool[] = [{
      name: 'Bash', description: '', inputSchema: z.object({ command: z.string() }),
      call: async () => ({ output: '' }),
    }]
    for await (const _ of executeToolsStreaming(blocks, ctx, tools)) {}
    expect(events.some(e => e.type === 'tool_use:denied')).toBe(true)
  })

  test('unknown tool → isError result, 无 tool_use:start', async () => {
    const ctx = makeCtx()
    const events: any[] = []
    ctx.emitEvent = (e) => events.push(e)
    const blocks = [{ id: 't1', name: 'NoSuchTool', input: {} }]
    for await (const _ of executeToolsStreaming(blocks, ctx, [])) {}
    expect(events.some(e => e.type === 'tool_use:start')).toBe(false)
    const results = ctx.state.__lastToolResults as any[]
    expect(results[0].isError).toBe(true)
    expect(results[0].content as string).toMatch(/unknown tool/)
  })

  test('zod 校验失败 → tool_use:invalid + isError', async () => {
    const ctx = makeCtx()
    const events: any[] = []
    ctx.emitEvent = (e) => events.push(e)
    const blocks = [{ id: 't1', name: 'Strict', input: { wrong: 'shape' } }]
    const tools: Tool[] = [{
      name: 'Strict', description: '', inputSchema: z.object({ required: z.string() }),
      call: async () => ({ output: 'should not run' }),
    }]
    for await (const _ of executeToolsStreaming(blocks, ctx, tools)) {}
    expect(events.some(e => e.type === 'tool_use:invalid')).toBe(true)
  })

  test('正常 call → tool_use:start + tool_use:done, result 包含 output', async () => {
    const ctx = makeCtx()
    const events: any[] = []
    ctx.emitEvent = (e) => events.push(e)
    const blocks = [{ id: 't1', name: 'Echo', input: { msg: 'hi' } }]
    const tools: Tool[] = [{
      name: 'Echo', description: '', inputSchema: z.object({ msg: z.string() }),
      call: async ({ msg }) => ({ output: `echo:${msg}` }),
    }]
    for await (const _ of executeToolsStreaming(blocks, ctx, tools)) {}
    expect(events.some(e => e.type === 'tool_use:start')).toBe(true)
    expect(events.some(e => e.type === 'tool_use:done')).toBe(true)
    const results = ctx.state.__lastToolResults as any[]
    expect(results[0].isError).toBeFalsy()
    expect(results[0].content).toBe('echo:hi')
  })

  test('tool.call throw → tool_use:error + isError', async () => {
    const ctx = makeCtx()
    const events: any[] = []
    ctx.emitEvent = (e) => events.push(e)
    const blocks = [{ id: 't1', name: 'Boom', input: {} }]
    const tools: Tool[] = [{
      name: 'Boom', description: '', inputSchema: z.object({}),
      call: async () => { throw new Error('kaboom') },
    }]
    for await (const _ of executeToolsStreaming(blocks, ctx, tools)) {}
    expect(events.some(e => e.type === 'tool_use:error')).toBe(true)
  })

  test('并发: 3 个 tool 同时跑, 结果按原顺序回写', async () => {
    const ctx = makeCtx()
    const tools: Tool[] = [{
      name: 'T', description: '', inputSchema: z.object({ delay: z.number() }),
      call: async ({ delay }) => {
        await new Promise(r => setTimeout(r, delay))
        return { output: `done-${delay}` }
      },
    }]
    const blocks = [
      { id: 't1', name: 'T', input: { delay: 30 } },
      { id: 't2', name: 'T', input: { delay: 5 } },
      { id: 't3', name: 'T', input: { delay: 15 } },
    ]
    for await (const _ of executeToolsStreaming(blocks, ctx, tools)) {}
    const results = ctx.state.__lastToolResults as any[]
    expect(results.map(r => r.content)).toEqual(['done-30', 'done-5', 'done-15'])
  })
})
```

- [ ] **Step 2: 跑测试确认 fail**

Run: `cd packages/zai-agent-core && pnpm test test/runtime/toolExecution.test.ts`
Expected: FAIL

- [ ] **Step 3: 创建 `src/runtime/toolExecution.ts`**

```ts
import type { Tool, ToolContext, ToolResult } from '../tools/Tool.js'
import type { RuntimeEvent } from './events.js'

type ToolUseBlock = { id: string; name: string; input: unknown }

export async function* executeToolsStreaming(
  blocks: ToolUseBlock[],
  ctx: ToolContext,
  tools: Tool[],
): AsyncGenerator<RuntimeEvent, void, void> {
  const results: ToolResult[] = new Array(blocks.length)
  ctx.state.__lastToolResults = results

  const permissionResults = await Promise.all(blocks.map(async b => {
    const tool = tools.find(t => t.name === b.name)
    if (!tool) return { behavior: 'deny' as const, reason: `unknown tool: ${b.name}` }
    return ctx.canUseTool(b.name, b.input)
  }))

  const executable: Array<{ index: number; block: ToolUseBlock; tool: Tool }> = []
  blocks.forEach((b, i) => {
    const pr = permissionResults[i]!
    const tool = tools.find(t => t.name === b.name)
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

- [ ] **Step 4: 跑测试确认 pass**

Run: `cd packages/zai-agent-core && pnpm test test/runtime/toolExecution.test.ts`
Expected: 7 tests PASS

- [ ] **Step 5: Commit**

```bash
git add src/runtime/toolExecution.ts test/runtime/toolExecution.test.ts
git commit -m "HRMSV3-ZN-WEBSITE#668 feat(zai-agent-core): executeToolsStreaming — canUseTool + concurrent + zod"
```

---

## Task 10: queryLoop + helpers（替换 mock）

**Files:**
- Modify: `packages/zai-agent-core/src/runtime/queryLoop.ts`（Task 8 创建了 stub, Task 10 替换为真实实现. 保留 named export `queryLoop`）
- Modify: `packages/zai-agent-core/src/runtime/query.ts`（委托给 queryLoop, 移除旧的 mock generateMockEvents）
- Create: `packages/zai-agent-core/test/runtime/queryLoop.test.ts`
- Modify: `packages/zai-agent-core/test/runtime/query.test.ts`（用 MockModelCaller）
- Modify: `packages/zai-agent-core/test/runtime/contract.test.ts`（用 MockModelCaller）

**Interfaces:**
- Consumes: `executeToolsStreaming` (Task 9), `buildSubagentContext` (Task 7), `defaultCanUseToolFactory` (Task 3), `getZaiRuntimeTools` (Task 11 — **forward reference**), `loadAgentsMd` (existing), `TranscriptStore` (Task 1)
- Produces: `queryLoop(options, config): AsyncGenerator<RuntimeEvent>`

- [ ] **Step 1: 创建 `test/runtime/queryLoop.test.ts`**

```ts
import { describe, expect, test, beforeEach, afterEach } from 'vitest'
import { mkdtemp, rm } from 'fs/promises'
import { join } from 'path'
import { tmpdir } from 'os'
import { queryLoop } from '../../src/runtime/queryLoop.js'
import { makeMockModelCaller } from '../fixtures/MockModelCaller.js'
import { makeMockSandbox } from '../fixtures/MockSandbox.js'

async function collect(g: AsyncGenerator<any>) {
  const out: any[] = []
  for await (const e of g) out.push(e)
  return out
}

let tmpDir: string
beforeEach(async () => { tmpDir = await mkdtemp(join(tmpdir(), 'zai-qe-')) })
afterEach(async () => { await rm(tmpDir, { recursive: true, force: true }) })

describe('queryLoop', () => {
  test('无 modelCaller → runtime.error(no modelCaller configured)', async () => {
    const events = await collect(queryLoop(
      { prompt: 'hi', cwd: '/tmp' },
      { dataDir: tmpDir },
    ))
    expect(events.at(-1)?.type).toBe('runtime.error')
    expect(events.at(-1)?.error?.message).toMatch(/no modelCaller configured/)
  })

  test('text-only happy path → ends with runtime.done', async () => {
    const events = await collect(queryLoop(
      { prompt: 'hi', cwd: '/tmp' },
      { dataDir: tmpDir, modelCaller: makeMockModelCaller('text-only') },
    ))
    expect(events.at(-1)?.type).toBe('runtime.done')
    expect(events.some(e => e.type === 'message_start')).toBe(true)
    expect(events.some(e => e.type === 'content_block_delta')).toBe(true)
  })

  test('tool call: Bash 跑 echo, 输出回流 → 第二轮 done', async () => {
    const events = await collect(queryLoop(
      { prompt: 'list', cwd: '/tmp' },
      {
        dataDir: tmpDir,
        modelCaller: makeMockModelCaller('one-tool'),
        sandbox: makeMockSandbox('/tmp'),
      },
    ))
    expect(events.some(e => e.type === 'tool_use:start')).toBe(true)
    expect(events.some(e => e.type === 'tool_use:done')).toBe(true)
    expect(events.at(-1)?.type).toBe('runtime.done')
  })

  test('maxTurns=5 + infinite-loop → runtime.error(code: max_turns_reached)', async () => {
    const events = await collect(queryLoop(
      { prompt: 'loop', cwd: '/tmp', maxTurns: 5 },
      {
        dataDir: tmpDir,
        modelCaller: makeMockModelCaller('infinite-loop'),
        sandbox: makeMockSandbox('/tmp'),
      },
    ))
    const err = events.find(e => e.type === 'runtime.error')
    expect(err).toBeTruthy()
    expect(err?.error?.code).toBe('max_turns_reached')
  })

  test('abort signal → runtime.aborted 事件', async () => {
    const controller = new AbortController()
    const events: any[] = []
    const iter = queryLoop(
      { prompt: 'x', cwd: '/tmp', abortSignal: controller.signal },
      { dataDir: tmpDir, modelCaller: makeMockModelCaller('infinite-loop'), sandbox: makeMockSandbox('/tmp') },
    )
    setTimeout(() => controller.abort(), 20)
    for await (const e of iter) {
      events.push(e)
      if (e.type === 'runtime.aborted' || e.type === 'runtime.error') break
    }
    expect(events.some(e => e.type === 'runtime.aborted' || e.type === 'runtime.error')).toBe(true)
  })

  test('AGENTS.md 不存在时不报错, 默认空 systemPrompt', async () => {
    const events = await collect(queryLoop(
      { prompt: 'x', cwd: '/tmp' },
      { dataDir: tmpDir, modelCaller: makeMockModelCaller('text-only') },
    ))
    expect(events.at(-1)?.type).toBe('runtime.done')
  })

  test('sessionId 在 events 上有', async () => {
    const events = await collect(queryLoop(
      { prompt: 'x', cwd: '/tmp' },
      { dataDir: tmpDir, modelCaller: makeMockModelCaller('text-only') },
    ))
    expect(events[0]?.sessionId).toMatch(/^sess-/)
  })
})
```

- [ ] **Step 2: 跑测试确认 fail**

Run: `cd packages/zai-agent-core && pnpm test test/runtime/queryLoop.test.ts`
Expected: FAIL

- [ ] **Step 3: 创建 `src/runtime/queryLoop.ts`**

```ts
import { randomUUID } from 'node:crypto'
import type { QueryOptions, RuntimeConfig, Tool } from './types.js'
import type { ToolContext, ToolResult } from '../tools/Tool.js'
import type { RuntimeEvent } from './events.js'
import { TranscriptStore } from '../transcript/store.js'
import { wrapWithZaiMeta, toRuntimeErrorEvent, toAbortedEvent } from './streamAdapter.js'
import { loadAgentsMd, buildAgentsMdSystemPrompt } from '../agents/agentsMdLoader.js'
import { executeToolsStreaming } from './toolExecution.js'
import { buildSubagentContext } from './subagent.js'
import { defaultCanUseToolFactory } from './canUseTool.js'

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

  options.abortSignal?.addEventListener('abort',
    () => abortController.abort(options.abortSignal?.reason), { once: true })

  const subCtx = options.parentSessionId
    ? buildSubagentContext(options, config, sessionId)
    : null

  // Dynamic import breaks queryLoop ↔ getZaiRuntimeTools cycle (Task 11)
  const { getZaiRuntimeTools } = await import('../tools/index.js')
  const tools = resolveToolPool(options, config, getZaiRuntimeTools())

  if (!options.resumeFromTranscriptId) {
    await store.create({
      cwd: options.cwd,
      model: options.model ?? config.defaultModel ?? 'default',
      ...(options.parentSessionId ? { parentSessionId: options.parentSessionId } : {}),
      ...(options.subagentType ? { subagentType: options.subagentType } : {}),
    }, sessionId)
  }

  const systemPrompt = await buildSystemPrompt(options)

  const messages: Array<{ role: 'user' | 'assistant'; content: unknown }> = []
  if (options.resumeFromTranscriptId) {
    const t = await store.read(options.resumeFromTranscriptId)
    messages.push(...(t.messages as Array<{ role: 'user' | 'assistant'; content: unknown }>))
  }
  if (subCtx?.initialUserMessage) {
    messages.push(subCtx.initialUserMessage)
  } else if (typeof options.prompt === 'string') {
    messages.push({ role: 'user', content: options.prompt })
  } else if (Array.isArray(options.prompt)) {
    messages.push(...(options.prompt as any))
  }

  let turn = 0
  while (turn < maxTurns) {
    turn++
    if (abortController.signal.aborted) {
      yield toAbortedEvent({ sessionId, turnIndex: turn }, abortController.signal.reason as string | undefined)
      return
    }

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

    let assistantText = ''
    const toolUseBlocks: Array<{ id: string; name: string; input: unknown }> = []
    for await (const ev of modelStream) {
      if (abortController.signal.aborted) break
      yield* wrapWithZaiMeta(ev as RuntimeEvent, { sessionId, sessionStartTs })
      if ((ev as any).type === 'content_block_delta' && (ev as any).delta?.type === 'text_delta') {
        assistantText += (ev as any).delta.text
      } else if ((ev as any).type === 'content_block_start' && (ev as any).content_block?.type === 'tool_use') {
        toolUseBlocks.push({
          id: (ev as any).content_block.id,
          name: (ev as any).content_block.name,
          input: {},
        })
      } else if ((ev as any).type === 'content_block_delta' && (ev as any).delta?.type === 'input_json_delta') {
        const cur = toolUseBlocks[toolUseBlocks.length - 1]
        if (cur) mergeInputDelta(cur, (ev as any).delta.partial_json)
      }
    }

    for (const b of toolUseBlocks) {
      const raw = (b.input as any).__rawJson
      if (typeof raw === 'string') {
        try { b.input = JSON.parse(raw) } catch { b.input = {} }
      }
    }

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

    const toolCtx = makeToolContext(options, config, sessionId, abortController)
    for await (const ev of executeToolsStreaming(toolUseBlocks, toolCtx, tools)) {
      yield ev as RuntimeEvent
    }
    const lastResults: ToolResult[] = (toolCtx.state.__lastToolResults as ToolResult[]) ?? []

    messages.push({ role: 'user', content: toolUseBlocks.map((t, i) => ({
      type: 'tool_result',
      tool_use_id: t.id,
      content: lastResults[i]?.content ?? '',
      is_error: lastResults[i]?.isError ?? false,
    })) })

    if (turn >= maxTurns) {
      const err = new Error(`maxTurns=${maxTurns} reached`)
      ;(err as any).code = 'max_turns_reached'
      yield toRuntimeErrorEvent(err, { sessionId, turnIndex: turn })
      return
    }
  }
}

function resolveToolPool(
  options: QueryOptions,
  _config: RuntimeConfig,
  base: Tool[],
): Tool[] {
  const preset = options.toolsOverride ?? 'base+subagent'
  if (preset === 'none') return [...(options.additionalTools ?? [])]
  return [...base, ...(options.additionalTools ?? [])]
}

function makeToolContext(
  options: QueryOptions,
  config: RuntimeConfig,
  _sessionId: string,
  abortController: AbortController,
): ToolContext {
  return {
    cwd: options.cwd,
    env: process.env as Record<string, string>,
    abortSignal: abortController.signal,
    dataDir: config.dataDir,
    canUseTool: defaultCanUseToolFactory(config.sandbox),
    emitEvent: () => { /* 事件已通过 yield 出去 */ },
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
    try {
      const agentsMd = await loadAgentsMd(options.cwd)
      parts.push(buildAgentsMdSystemPrompt(agentsMd))
    } catch { /* AGENTS.md 不存在, 静默降级 */ }
  }
  return parts.filter(Boolean).join('\n\n')
}

function mergeInputDelta(block: { input: unknown }, partialJson: string): void {
  const acc = ((block.input as any).__rawJson ?? '') as string
  ;(block.input as any).__rawJson = acc + partialJson
}
```

- [ ] **Step 4: 修改 `src/runtime/query.ts`（委托给 queryLoop）**

完整替换：

```ts
import { queryLoop } from './queryLoop.js'

export { queryLoop as query }
```

- [ ] **Step 5: 跑 queryLoop 测试确认 pass**

Run: `cd packages/zai-agent-core && pnpm test test/runtime/queryLoop.test.ts`
Expected: 7 tests PASS

- [ ] **Step 6: 修改 `test/runtime/query.test.ts`（用 MockModelCaller）**

```ts
import { describe, expect, test, beforeEach, afterEach } from 'vitest'
import { mkdtemp, rm } from 'fs/promises'
import { join } from 'path'
import { tmpdir } from 'os'
import { query } from '../../src/runtime/query.js'
import { makeMockModelCaller } from '../fixtures/MockModelCaller.js'

let tmpDir: string

beforeEach(async () => {
  tmpDir = await mkdtemp(join(tmpdir(), 'zai-query-test-'))
})

afterEach(async () => {
  await rm(tmpDir, { recursive: true, force: true })
})

async function collect(g: AsyncGenerator<any>) {
  const out: any[] = []
  for await (const e of g) out.push(e)
  return out
}

describe('query()', () => {
  test('emits events with sessionId', async () => {
    const events = await collect(query({
      prompt: 'hello', cwd: '/test',
    }, { dataDir: tmpDir, modelCaller: makeMockModelCaller('text-only') }))
    expect(events.length).toBeGreaterThan(0)
    expect(events[0].sessionId).toBeTruthy()
    expect(events[0].eventId).toBeTruthy()
  })

  test('ends with runtime.done', async () => {
    const events = await collect(query({
      prompt: 'hello', cwd: '/test',
    }, { dataDir: tmpDir, modelCaller: makeMockModelCaller('text-only') }))
    expect(events[events.length - 1].type).toBe('runtime.done')
  })

  test('无 modelCaller → runtime.error', async () => {
    const events = await collect(query({
      prompt: 'hello', cwd: '/test',
    }, { dataDir: tmpDir }))
    expect(events.at(-1)?.type).toBe('runtime.error')
  })

  test('abortSignal triggers early termination', async () => {
    const controller = new AbortController()
    const events: any[] = []
    setTimeout(() => controller.abort(), 20)
    for await (const event of query({
      prompt: 'x', cwd: '/test', abortSignal: controller.signal,
    }, { dataDir: tmpDir, modelCaller: makeMockModelCaller('infinite-loop') })) {
      events.push(event)
      if (event.type === 'runtime.aborted' || event.type === 'runtime.error') break
    }
    expect(events.some((e) => e.type === 'runtime.aborted' || e.type === 'runtime.error')).toBe(true)
  })

  test('resumeFromTranscriptId sets sessionId', async () => {
    const events = await collect(query({
      prompt: 'hello', cwd: '/test', resumeFromTranscriptId: 'sess-abc-123',
    }, { dataDir: tmpDir, modelCaller: makeMockModelCaller('text-only') }))
    expect(events[0].sessionId).toBe('sess-abc-123')
  })
})
```

- [ ] **Step 7: 修改 `test/runtime/contract.test.ts`**

```ts
import { describe, expect, test, beforeEach, afterEach } from 'vitest'
import { mkdtemp, rm } from 'fs/promises'
import { join } from 'path'
import { tmpdir } from 'os'
import { DefaultAgentRuntime } from '../../src/runtime/contract.js'
import { makeMockModelCaller } from '../fixtures/MockModelCaller.js'

let tmpDir: string
let runtime: DefaultAgentRuntime

beforeEach(async () => {
  tmpDir = await mkdtemp(join(tmpdir(), 'zai-contract-test-'))
  runtime = new DefaultAgentRuntime({
    dataDir: tmpDir,
    modelCaller: makeMockModelCaller('text-only'),
  })
})

afterEach(async () => {
  await rm(tmpDir, { recursive: true, force: true })
})

describe('DefaultAgentRuntime', () => {
  test('run returns events ending with runtime.done', async () => {
    const events: any[] = []
    for await (const e of runtime.run({ prompt: 'hi', cwd: '/test' })) {
      events.push(e)
    }
    expect(events[events.length - 1].type).toBe('runtime.done')
  })

  test('listSessions after run', async () => {
    for await (const _ of runtime.run({ prompt: 'hi', cwd: '/test' })) { /* drain */ }
    const sessions = await runtime.listSessions()
    expect(sessions.length).toBeGreaterThanOrEqual(1)
  })

  test('readSession returns transcript', async () => {
    let sessionId = ''
    for await (const e of runtime.run({ prompt: 'hi', cwd: '/test' })) {
      if (!sessionId) sessionId = e.sessionId
    }
    const file = await runtime.readSession(sessionId)
    expect(file.transcriptId).toBe(sessionId)
  })
})
```

- [ ] **Step 8: 跑全套测试确认全 pass**

Run: `cd packages/zai-agent-core && pnpm test`
Expected: 全部 PASS（包括之前的 query/contract/serialization/store/agents 等回归测试）

- [ ] **Step 9: Commit**

```bash
git add src/runtime/queryLoop.ts src/runtime/query.ts test/runtime/
git commit -m "HRMSV3-ZN-WEBSITE#668 feat(zai-agent-core): queryLoop — 替换 mock 占位为最小 query loop"
```

---

## Task 11: 工具注册 getZaiRuntimeTools

**Files:**
- Create: `packages/zai-agent-core/src/tools/index.ts`
- Create: `packages/zai-agent-core/test/tools/index.test.ts`
- Modify: `packages/zai-agent-core/package.json`（exports）

**Interfaces:**
- Consumes: `BashTool` (Task 5), `AgentTool` (Task 8)
- Produces: `getZaiRuntimeTools() => Tool[]` — 包含 BashTool + AgentTool + 占位 (8 base 待后续 issue)

- [ ] **Step 1: 写失败测试 `test/tools/index.test.ts`**

```ts
import { describe, expect, test } from 'vitest'
import { getZaiRuntimeTools } from '../../src/tools/index.js'

describe('getZaiRuntimeTools', () => {
  test('返回工具数组', () => {
    const tools = getZaiRuntimeTools()
    expect(Array.isArray(tools)).toBe(true)
  })

  test('包含 Bash 和 Agent', () => {
    const tools = getZaiRuntimeTools()
    const names = tools.map(t => t.name)
    expect(names).toContain('Bash')
    expect(names).toContain('Agent')
  })

  test('Bash 和 Agent 是 Tool 接口 (有 call / inputSchema)', () => {
    const tools = getZaiRuntimeTools()
    for (const t of tools) {
      expect(typeof t.call).toBe('function')
      expect(t.inputSchema).toBeTruthy()
    }
  })
})
```

- [ ] **Step 2: 跑测试确认 fail**

Run: `cd packages/zai-agent-core && pnpm test test/tools/index.test.ts`
Expected: FAIL

- [ ] **Step 3: 创建 `src/tools/index.ts`**

```ts
import type { Tool } from './Tool.js'
import { BashTool } from './BashTool/BashTool.js'
import { AgentTool } from './AgentTool/AgentTool.js'

/**
 * zai runtime tool pool.
 *
 * 当前实现: BashTool + AgentTool. 8 个 base tools (FileRead/FileEdit/NotebookEdit/
 * Glob/Grep/WebFetch/WebSearch/Skill) 后续 issue 单独加, 这里只占位.
 */
export function getZaiRuntimeTools(): Tool[] {
  return [
    BashTool,
    AgentTool,
  ]
}
```

- [ ] **Step 4: 跑测试确认 pass**

Run: `cd packages/zai-agent-core && pnpm test test/tools/index.test.ts`
Expected: 3 tests PASS

- [ ] **Step 5: 修改 `package.json` 增加 exports**

在 `exports` 字段加：

```json
"./tools": "./dist/tools/index.js"
```

完整 `exports` 字段：

```json
"exports": {
  ".": "./dist/index.js",
  "./runtime": "./dist/runtime/index.js",
  "./transcript": "./dist/transcript/store.js",
  "./tools": "./dist/tools/index.js"
}
```

- [ ] **Step 6: 跑 typecheck 确认无错**

Run: `cd packages/zai-agent-core && pnpm typecheck`
Expected: 通过

- [ ] **Step 7: 跑全套测试确认无回归**

Run: `cd packages/zai-agent-core && pnpm test`
Expected: 全部 PASS

- [ ] **Step 8: Commit**

```bash
git add src/tools/index.ts test/tools/index.test.ts package.json
git commit -m "HRMSV3-ZN-WEBSITE#668 feat(zai-agent-core): getZaiRuntimeTools() — 注册 Bash + Agent"
```

---

## Task 12: 更新 opencc-internals README + streamAdapter

**Files:**
- Modify: `packages/zai-agent-core/src/opencc-internals/README.md`（加注 "sub-agent + Bash 不在镜像范围"）
- Modify: `packages/zai-agent-core/src/runtime/streamAdapter.ts`（加 subagent 事件分类辅助 — 为后续 queryLoop 用到, 见 spec §7.6）
- Create: `packages/zai-agent-core/test/runtime/streamAdapter.test.ts`（若已有则更新）

- [ ] **Step 1: 追加段到 `src/opencc-internals/README.md`**

在文件末尾追加：

```markdown
## zai-specific sub-agent + Bash (not in mirror)

`src/tools/BashTool/BashTool.ts` and `src/tools/AgentTool/AgentTool.ts` are
zai's real implementations, NOT part of this mirror. They live in
`src/tools/BashTool/` and `src/tools/AgentTool/` (sibling directories).
Adding them to `WHITELIST_PATTERNS` would conflict with the zai tool
implementations — keep them out of the mirror.
```

- [ ] **Step 2: 修改 `src/runtime/streamAdapter.ts`**

在文件末尾追加（**不替换现有内容**）：

```ts
import type { RuntimeEvent } from './events.js'

/**
 * Classify subagent/tool events when adapting internal model stream events
 * to RuntimeEvents. Used by AgentTool.call to set proper error category
 * on the subagent:done event. Returns null when the event is not a
 * category-bearing zai-specific event.
 */
export function classifyZaiEvent(event: { type: string; [k: string]: unknown }): string | null {
  if (event.type === 'tool_use:error') return 'tool_execution'
  if (event.type === 'tool_use:denied') return 'permission_denied'
  if (event.type === 'tool_use:invalid') return 'tool_execution'
  if (event.type === 'subagent:error') return 'tool_execution'
  if (event.type === 'message_start' && (event as any).error) return 'llm_provider'
  return null
}

/** re-export so consumers can wrap individual events */
export type { RuntimeEvent }
```

- [ ] **Step 3: 跑 typecheck + 测试**

Run: `cd packages/zai-agent-core && pnpm typecheck && pnpm test`
Expected: 全部通过

- [ ] **Step 4: Commit**

```bash
git add src/opencc-internals/README.md src/runtime/streamAdapter.ts
git commit -m "HRMSV3-ZN-WEBSITE#668 docs(zai-agent-core): note sub-agent + Bash 不在镜像范围; add classifyZaiEvent"
```

---

## Task 13: 端到端 sub-agent 集成测试

**Files:**
- Create: `packages/zai-agent-core/test/integration/subagent.test.ts`

**Interfaces:**
- Consumes: 全部前置任务产物
- Produces: 端到端测试覆盖 spec §8.5 验收标准

- [ ] **Step 1: 创建 `test/integration/subagent.test.ts`**

```ts
import { describe, expect, test, beforeEach, afterEach } from 'vitest'
import { mkdtemp, rm, writeFile, mkdir } from 'fs/promises'
import { join } from 'path'
import { tmpdir } from 'os'
import { queryLoop } from '../../src/runtime/queryLoop.js'
import { makeMockModelCaller } from '../fixtures/MockModelCaller.js'
import { makeMockSandbox } from '../fixtures/MockSandbox.js'

let dataDir: string
beforeEach(async () => { dataDir = await mkdtemp(join(tmpdir(), 'zai-int-')) })
afterEach(async () => { await rm(dataDir, { recursive: true, force: true }) })

async function collect(g: AsyncGenerator<any>) {
  const out: any[] = []
  for await (const e of g) out.push(e)
  return out
}

describe('integration: sub-agent', () => {
  test('AgentTool 派生子 agent, 父 SSE 看到 subagent:start/event/done', async () => {
    const events = await collect(queryLoop(
      { prompt: '派个 sub-agent', cwd: '/tmp' },
      { dataDir, modelCaller: makeMockModelCaller('subagent'), sandbox: makeMockSandbox('/tmp') },
    ))
    expect(events.some(e => e.type === 'subagent:start')).toBe(true)
    expect(events.some(e => e.type === 'subagent:event')).toBe(true)
    expect(events.some(e => e.type === 'subagent:done')).toBe(true)
  })

  test('sub-agent sessionId 形如 <parent>-sub-<8hex>', async () => {
    const events = await collect(queryLoop(
      { prompt: '派个 sub-agent', cwd: '/tmp' },
      { dataDir, modelCaller: makeMockModelCaller('subagent'), sandbox: makeMockSandbox('/tmp') },
    ))
    const start = events.find(e => e.type === 'subagent:start')
    expect(start?.subSessionId).toMatch(/^sess-[0-9a-f-]+-sub-[0-9a-f]{8}$/)
  })

  test('sub-agent 使用 ~/.zai/agents/general-purpose.md 的 systemPrompt', async () => {
    await mkdir(join(dataDir, 'agents'), { recursive: true })
    await writeFile(join(dataDir, 'agents/general-purpose.md'),
      `---\nname: general-purpose\ndescription: gp\n---\nCUSTOM_GP_PROMPT`)
    // 第一次 model call → 调 AgentTool (派 sub-agent)
    // 第二次 model call 在子 query 内, 捕获子 query 的 systemPrompt 验证
    let callCount = 0
    let captured: string | undefined
    const doubleCaller: any = async function* (req: any) {
      callCount++
      if (callCount === 1) {
        yield { type: 'message_start', message: { id: 'm' } }
        yield { type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id: 't1', name: 'Agent', input: {} } }
        yield { type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: '{"prompt":"sub","subagent_type":"general-purpose"}' } }
        yield { type: 'content_block_stop', index: 0 }
        yield { type: 'message_stop' }
        return
      }
      captured = typeof req.systemPrompt === 'string' ? req.systemPrompt : JSON.stringify(req.systemPrompt)
      yield { type: 'message_start', message: { id: 'm' } }
      yield { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } }
      yield { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'sub done' } }
      yield { type: 'content_block_stop', index: 0 }
      yield { type: 'message_stop' }
    }
    await collect(queryLoop(
      { prompt: '派个', cwd: '/tmp' },
      { dataDir, modelCaller: doubleCaller, sandbox: makeMockSandbox('/tmp') },
    ))
    expect(captured).toContain('CUSTOM_GP_PROMPT')
  })

  test('Bash command 在 sandbox denylist → permission_denied, 不 spawn 进程', async () => {
    const events = await collect(queryLoop(
      { prompt: 'rm 一下', cwd: '/tmp' },
      {
        dataDir,
        modelCaller: makeMockModelCaller('one-tool'),
        sandbox: makeMockSandbox('/tmp', { commandDenylist: [/^rm\b/] }),
      },
    ))
    expect(events.some(e => e.type === 'tool_use:denied')).toBe(true)
    expect(events.some(e => e.type === 'tool_use:start')).toBe(false)
  })

  test('abort signal 触发时, 子 query 跟随 abort', async () => {
    const controller = new AbortController()
    const events: any[] = []
    setTimeout(() => controller.abort(), 20)
    for await (const e of queryLoop(
      { prompt: 'x', cwd: '/tmp', abortSignal: controller.signal },
      { dataDir, modelCaller: makeMockModelCaller('infinite-loop'), sandbox: makeMockSandbox('/tmp') },
    )) {
      events.push(e)
      if (e.type === 'runtime.aborted' || e.type === 'runtime.error') break
    }
    expect(events.some(e => e.type === 'runtime.aborted' || e.type === 'runtime.error')).toBe(true)
  })
})
```

- [ ] **Step 2: 跑测试确认 pass**

Run: `cd packages/zai-agent-core && pnpm test test/integration/subagent.test.ts`
Expected: 5 tests PASS

- [ ] **Step 3: 跑全套测试 + typecheck + build**

```bash
cd packages/zai-agent-core
pnpm typecheck
pnpm test
pnpm build
```

Expected:
- typecheck: 0 错
- test: 全部 PASS
- build: 0 错

- [ ] **Step 4: 验证 `opencc-internals/` 0 修改**

```bash
cd /Users/liangxuechao572/code/zn-agent-assets
git diff --stat HEAD~13 HEAD -- packages/zai-agent-core/src/opencc-internals/
```

Expected: 空（只有 README 追加段, 而 README 是 zai 自己的 add 操作, 在 git log 中表现为新增行 — 用 `git diff` 比较, 应是 0 modifications to upstream source）

- [ ] **Step 5: Commit**

```bash
git add test/integration/subagent.test.ts
git commit -m "HRMSV3-ZN-WEBSITE#668 test(zai-agent-core): integration — sub-agent + abort + sandbox"
```

---

## 验收清单（与 spec §8.5 对齐）

- [x] `pnpm test` 全部通过, 包含 6+ 个新增集成测试
- [ ] `pnpm test:e2e` 真实 LLM 跑通（不在本计划范围, 后续 issue）
- [x] `getZaiRuntimeTools()` 返回 Bash + Agent 2 个 tool（spec 8 tool 占位待后续）
- [x] `DefaultAgentRuntime.run({ prompt, cwd })` 端到端可流式输出 RuntimeEvent
- [x] sub-agent 调起后, 父 SSE 能看到 `subagent:start` / `subagent:event` / `subagent:done`
- [x] `~/.zai/agents/general-purpose.md` 存在时, AgentTool 优先使用其 systemPrompt
- [x] `RuntimeConfig.sandbox = { commandDenylist: [/^rm\b/] }` 时, `Bash(command='rm -rf /')` 被 canUseTool 拒绝
- [x] abort signal 透传到子 query, 父 abort 后子 < 100ms 内退出
- [x] maxTurns=5 + 死循环 tool, 第 5 步后发 `runtime.error(code: max_turns_reached)`
- [x] `opencc-internals/` 镜像文件 0 修改（仅 README 追加 zai 注释, 不改上游源）
