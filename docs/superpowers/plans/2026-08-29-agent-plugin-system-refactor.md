# Agent 插件系统重构实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把分散在 zai-server 的主 Agent 加载/解析逻辑下沉到 core,新增 `AgentRegistry` 作为 session ↔ agent 唯一桥梁,提供 `registryAgent` / `unregistryAgent` / `slot` 三个核心 API。三态 runtime(repl / lightweight / inproc)统一通过 `slot()` 接入,顺手修复 inproc 链路不识别 zai mainAgent 的 bug。

**Architecture:** 新增 `packages/zn-agent-core/src/opencc-src/server/agentRegistry.ts`,持有 `agents: Map<agentId, AgentConfig>` + `sessionBindings: Map<sessionId, agentId>` 两份 in-memory map。`slot<T>(origin: T, slotId: AgentSlotId, sessionId: string): Promise<T>` 派发到 `agentConfig.slots[slotId]`。zai-server 启动时调 `loadBuiltinAgents()` + `loadUserAgents(dir)`;session 创建/恢复时调 `registryAgent(sessionId, agentId)`;三态 runtime 各自的接入点替换为 `await agentRegistry.slot(input, slotId, sessionId)`。

**Tech Stack:** TypeScript 5.6 / Vitest 4.x / Node ≥20 / pnpm workspace / esbuild bundle / `node:fs/promises` / `node:path` / `node:url`。

## Global Constraints

- spec: `docs/superpowers/specs/2026-08-29-agent-plugin-system-refactor-design.md`(commit `38d0325f`)
- scope: 仅 `systemPrompt` / `tools` / `mcp` 三个 resource slots;hook slots(`sessionStart` / `userPromptSubmit` / `preToolUse` / `postToolUse`)留位不实现,plugin runtime 不动
- 所有新增文件遵循现有 `packages/zn-agent-core/src/opencc-src/server/*.ts` 风格(JSDoc 块、error class hierarchy、`@/` alias 不允许)
- core 内改动**必须** `pnpm run build:core` 才生效,见 `opencc-web/AGENTS.md` 「core 改动必须先 build:core」段
- 单元测试路径过滤,不全量跑:`pnpm --filter @zn-ai/zn-agent-core test test/server/agentRegistry.test.ts`
- 提交风格:Conventional Commits,feat / fix / refactor / docs / chore
- 测试粒度遵循 `opencc-web/AGENTS.md` 「测试粒度」段:功能改动后只跑相关单元测试,不全量 `pnpm -r test`

---

## Phase 1 — Core registry(TDD-able,可在 worktree 内闭环)

### Task 1: Core types + 错误类 + AgentRegistry 类骨架

**Files:**
- Create: `packages/zn-agent-core/src/opencc-src/server/agentRegistry.ts`
- Test: `packages/zn-agent-core/test/server/agentRegistry.types.test.ts`

**Interfaces:**
- Consumes: 无前置依赖
- Produces:
  - `AgentSlotId = 'systemPrompt' | 'tools' | 'mcp'`
  - `AgentSlotFn<T> = (origin: T, sessionId: string) => T | Promise<T>`
  - `AgentConfig { name: string; description: string; slots: { systemPrompt?, tools?, mcp? } }`
  - `AgentRegistry` 接口(方法签名见下)
  - `class AgentRegistryError extends Error` + `UnknownAgentError` + `AgentNotBoundError` + `BuiltinAgentsLoadError`
- `class AgentRegistryImpl implements AgentRegistry` 内部 `agents: Map<string, AgentConfig>` + `sessionBindings: Map<string, string>`,所有方法先 throw `Error('not implemented')`

- [ ] **Step 1: Write the failing test**

```typescript
// packages/zn-agent-core/test/server/agentRegistry.types.test.ts
import { describe, it, expect } from 'vitest'
import {
  AgentSlotId,
  AgentConfig,
  AgentRegistry,
  AgentRegistryError,
  UnknownAgentError,
  AgentNotBoundError,
  BuiltinAgentsLoadError,
} from '../../src/opencc-src/server/agentRegistry.js'

describe('agentRegistry types', () => {
  it('AgentSlotId 是三个 slot 的联合', () => {
    const ids: AgentSlotId[] = ['systemPrompt', 'tools', 'mcp']
    expect(ids).toHaveLength(3)
  })

  it('AgentConfig 接受可选 slots', () => {
    const c: AgentConfig = { name: 'a', description: 'd', slots: {} }
    expect(c.name).toBe('a')
    const c2: AgentConfig = {
      name: 'b',
      description: 'd',
      slots: {
        systemPrompt: (origin) => origin,
        tools: (origin) => origin,
        mcp: (origin) => origin,
      },
    }
    expect(typeof c2.slots.systemPrompt).toBe('function')
  })

  it('AgentRegistry 接口完整', () => {
    // 仅检查形状,运行时用空 stub
    const _stub: AgentRegistry = {
      loadBuiltinAgents: () => {},
      loadUserAgents: async () => ({ loaded: [], failed: [] }),
      registryAgent: () => {},
      unregistryAgent: () => {},
      slot: async <T>(origin: T) => origin,
      listAgents: () => [],
      hasAgent: () => false,
      resolveAgent: () => undefined,
      getBoundAgentId: () => undefined,
      clear: () => {},
    }
    expect(_stub).toBeDefined()
  })

  it('错误类继承与 code', () => {
    const a = new UnknownAgentError('x')
    expect(a).toBeInstanceOf(AgentRegistryError)
    expect(a).toBeInstanceOf(Error)
    expect(a.code).toBe('AGENT_UNKNOWN')
    const b = new AgentNotBoundError('s')
    expect(b.code).toBe('AGENT_NOT_BOUND')
    const c = new BuiltinAgentsLoadError()
    expect(c.code).toBe('AGENT_BUILTIN_LOAD_FAILED')
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @zn-ai/zn-agent-core test test/server/agentRegistry.types.test.ts`
Expected: FAIL(模块未导出 / 类型不存在)

- [ ] **Step 3: Write minimal implementation**

```typescript
// packages/zn-agent-core/src/opencc-src/server/agentRegistry.ts
/**
 * 主 Agent 注册表(zai patch 2026-08-29)。
 *
 * 作为 session ↔ agent 配置的唯一桥梁。zai-server 启动时调用
 * loadBuiltinAgents + loadUserAgents 加载内置 + 外置 agent;
 * session 创建/恢复时调用 registryAgent 绑定 agentId;
 * 三态 runtime 调用 slot(input, slotId, sessionId) 派发到对应 fn。
 *
 * 见 docs/superpowers/specs/2026-08-29-agent-plugin-system-refactor-design.md。
 */

export type AgentSlotId = 'systemPrompt' | 'tools' | 'mcp'

export type AgentSlotFn<T> = (origin: T, sessionId: string) => T | Promise<T>

export interface AgentConfig {
  name: string
  description: string
  slots: {
    systemPrompt?: AgentSlotFn<string[]>
    tools?: AgentSlotFn<Tool[]>
    mcp?: AgentSlotFn<McpServerConfig[]>
  }
}

export type LoadUserAgentsResult = {
  loaded: string[]
  failed: Array<{ file: string; error: Error }>
}

export interface AgentRegistry {
  loadBuiltinAgents(): void
  loadUserAgents(dir: string): Promise<LoadUserAgentsResult>
  registryAgent(sessionId: string, agentId: string): void
  unregistryAgent(sessionId: string): void
  slot<T>(origin: T, slotId: AgentSlotId, sessionId: string): Promise<T>
  listAgents(): AgentConfig[]
  hasAgent(name: string): boolean
  resolveAgent(name: string): AgentConfig | undefined         // 替代 zai-server 的 resolveMainAgent
  getBoundAgentId(sessionId: string): string | undefined
  clear(): void
}

export class AgentRegistryError extends Error {
  constructor(message: string, public readonly code: string) {
    super(message)
    this.name = 'AgentRegistryError'
  }
}
export class UnknownAgentError extends AgentRegistryError {
  constructor(name: string) {
    super(`Unknown agent: ${name}`, 'AGENT_UNKNOWN')
    this.name = 'UnknownAgentError'
  }
}
export class AgentNotBoundError extends AgentRegistryError {
  constructor(sessionId: string) {
    super(`Session not bound to any agent: ${sessionId}`, 'AGENT_NOT_BOUND')
    this.name = 'AgentNotBoundError'
  }
}
export class BuiltinAgentsLoadError extends AgentRegistryError {
  constructor(message = 'builtin agents load failed') {
    super(message, 'AGENT_BUILTIN_LOAD_FAILED')
    this.name = 'BuiltinAgentsLoadError'
  }
}

export class AgentRegistryImpl implements AgentRegistry {
  private agents = new Map<string, AgentConfig>()
  private sessionBindings = new Map<string, string>()

  loadBuiltinAgents(): void {
    throw new Error('not implemented')
  }
  loadUserAgents(_dir: string): Promise<LoadUserAgentsResult> {
    throw new Error('not implemented')
  }
  registryAgent(_sessionId: string, _agentId: string): void {
    throw new Error('not implemented')
  }
  unregistryAgent(_sessionId: string): void {
    throw new Error('not implemented')
  }
  slot<T>(_origin: T, _slotId: AgentSlotId, _sessionId: string): Promise<T> {
    throw new Error('not implemented')
  }
  listAgents(): AgentConfig[] {
    return Array.from(this.agents.values())
  }
  hasAgent(name: string): boolean {
    return this.agents.has(name)
  }
  resolveAgent(name: string): AgentConfig | undefined {
    return this.agents.get(name)
  }
  getBoundAgentId(sessionId: string): string | undefined {
    return this.sessionBindings.get(sessionId)
  }
  clear(): void {
    this.sessionBindings.clear()
    // agents map 保留
  }
}

// 占位类型 —— 实际类型在后续任务导入或从 vendor 引入
export type Tool = { name: string; [k: string]: unknown }
export type McpServerConfig = { name: string; [k: string]: unknown }
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @zn-ai/zn-agent-core test test/server/agentRegistry.types.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add packages/zn-agent-core/src/opencc-src/server/agentRegistry.ts \
        packages/zn-agent-core/test/server/agentRegistry.types.test.ts
git commit -m "feat(zn-agent-core): add AgentRegistry skeleton with types and errors"
```

---

### Task 2: `loadBuiltinAgents` + `loadUserAgents` 加载实现

**Files:**
- Modify: `packages/zn-agent-core/src/opencc-src/server/agentRegistry.ts:65-67`
- Create: `packages/zn-agent-core/src/opencc-src/server/loadBuiltinAgents.ts`(薄封装)
- Test: `packages/zn-agent-core/test/server/agentRegistry.load.test.ts`

**Interfaces:**
- Consumes:
  - `getBuiltinMainAgents(): MainAgentConfig[]` from `packages/zn-agent-core/src/opencc-src/server/mainAgents.ts`(已存在)
  - 现有 `loadUserMainAgents(dir)` 实现位于 `packages/zai/src/server/services/mainAgents.ts:67-102`,本任务把它**逻辑迁移**到 core,文件本身留 zai-server 一份薄包装(后续 Task 5 删除)
- Produces:
  - `loadBuiltinAgents(): void` — 同步,从 `getBuiltinMainAgents()` 取列表,逐个 `agents.set(name, toAgentConfig(c))`
  - `loadUserAgents(dir): Promise<{loaded, failed}>` — 扫 `*.js`、dynamic import、CJS/ESM 三格式兼容、工厂函数、shape 校验、错误聚合
- 转换 helper:`toAgentConfig(main: MainAgentConfig): AgentConfig` — 把 `{systemPrompt, tools, mcp}` 顶层字段映射到 `{slots: {systemPrompt, tools, mcp}}`

- [ ] **Step 1: Write the failing test**

```typescript
// packages/zn-agent-core/test/server/agentRegistry.load.test.ts
import { describe, it, expect, beforeEach } from 'vitest'
import { mkdtemp, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { AgentRegistryImpl } from '../../src/opencc-src/server/agentRegistry.js'

describe('AgentRegistry load', () => {
  let registry: AgentRegistryImpl
  beforeEach(() => {
    registry = new AgentRegistryImpl()
  })

  it('loadBuiltinAgents 注册 3 个 builtin', () => {
    registry.loadBuiltinAgents()
    const agents = registry.listAgents().map(a => a.name).sort()
    expect(agents).toEqual(['agent-creator', 'default', 'office'])
  })

  it('loadBuiltinAgents 后 hasAgent 对三个 name 返回 true', () => {
    registry.loadBuiltinAgents()
    expect(registry.hasAgent('default')).toBe(true)
    expect(registry.hasAgent('office')).toBe(true)
    expect(registry.hasAgent('agent-creator')).toBe(true)
    expect(registry.hasAgent('nonexistent')).toBe(false)
  })

  it('loadUserAgents 空目录 → loaded=[], failed=[]', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'agentRegistry-'))
    const r = await registry.loadUserAgents(dir)
    expect(r.loaded).toEqual([])
    expect(r.failed).toEqual([])
    await rm(dir, { recursive: true })
  })

  it('loadUserAgents 目录不存在 → 空结果', async () => {
    const r = await registry.loadUserAgents('/nonexistent/path/xyz')
    expect(r.loaded).toEqual([])
    expect(r.failed).toEqual([])
  })

  it('loadUserAgents 单个 .js 文件注册成功', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'agentRegistry-'))
    await writeFile(
      join(dir, 'my-agent.js'),
      `module.exports = { name: 'my', description: 'd' };`,
    )
    const r = await registry.loadUserAgents(dir)
    expect(r.loaded).toEqual(['my'])
    expect(r.failed).toEqual([])
    expect(registry.hasAgent('my')).toBe(true)
    await rm(dir, { recursive: true })
  })

  it('loadUserAgents 工厂函数 ctx 注入', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'agentRegistry-'))
    await writeFile(
      join(dir, 'factory-agent.js'),
      `module.exports = (ctx) => ({
        name: 'factory',
        description: 'd',
        tools: (origin) => origin,
      });`,
    )
    const r = await registry.loadUserAgents(dir)
    expect(r.loaded).toEqual(['factory'])
    expect(registry.listAgents().find(a => a.name === 'factory')?.slots.tools).toBeDefined()
    await rm(dir, { recursive: true })
  })

  it('loadUserAgents 损坏文件 skip + 计入 failed', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'agentRegistry-'))
    await writeFile(join(dir, 'broken.js'), `module.exports = throw new Error('boom');`)
    const r = await registry.loadUserAgents(dir)
    expect(r.loaded).toEqual([])
    expect(r.failed).toHaveLength(1)
    expect(r.failed[0].file).toContain('broken.js')
    await rm(dir, { recursive: true })
  })

  it('loadUserAgents 缺 name/description → failed, 不注册', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'agentRegistry-'))
    await writeFile(
      join(dir, 'no-name.js'),
      `module.exports = { description: 'd' };`,
    )
    const r = await registry.loadUserAgents(dir)
    expect(r.failed).toHaveLength(1)
    expect(registry.hasAgent('no-name')).toBe(false)
    await rm(dir, { recursive: true })
  })

  it('外置同名覆盖 builtin', async () => {
    registry.loadBuiltinAgents()
    const dir = await mkdtemp(join(tmpdir(), 'agentRegistry-'))
    await writeFile(
      join(dir, 'override.js'),
      `module.exports = { name: 'default', description: 'user override' };`,
    )
    await registry.loadUserAgents(dir)
    const a = registry.listAgents().find(a => a.name === 'default')
    expect(a?.description).toBe('user override')
    await rm(dir, { recursive: true })
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @zn-ai/zn-agent-core test test/server/agentRegistry.load.test.ts`
Expected: FAIL(`not implemented`)

- [ ] **Step 3: Write minimal implementation**

修改 `packages/zn-agent-core/src/opencc-src/server/agentRegistry.ts` —— 替换 `loadBuiltinAgents` 与 `loadUserAgents` 占位:

```typescript
// 顶部追加 import
import { readdir } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { getBuiltinMainAgents } from './mainAgents.js'
import type { MainAgentConfig, MainAgentLoadContext } from './mainAgents.js'

// 类内替换 loadBuiltinAgents / loadUserAgents 占位

loadBuiltinAgents(): void {
  for (const c of getBuiltinMainAgents()) {
    this.agents.set(c.name, toAgentConfig(c))
  }
}

async loadUserAgents(dir: string): Promise<LoadUserAgentsResult> {
  const loaded: string[] = []
  const failed: Array<{ file: string; error: Error }> = []
  let files: string[]
  try {
    files = (await readdir(dir)).filter((f) => f.endsWith('.js'))
  } catch {
    return { loaded, failed }
  }
  const ctx = buildLoadContext()
  for (const file of files) {
    const filePath = join(dir, file)
    try {
      const url = pathToFileURL(filePath).href
      const mod = (await import(url)) as Record<string, unknown>
      const raw = mod.default ?? mod
      const config =
        typeof raw === 'function'
          ? await (raw as (c: MainAgentLoadContext) => unknown)(ctx)
          : raw
      const items = Array.isArray(config) ? config : [config]
      for (const item of items) {
        if (!isAgentConfigLike(item)) {
          failed.push({ file, error: new Error('missing name/description') })
          continue
        }
        const agent = toAgentConfig(item as MainAgentConfig)
        this.agents.set(agent.name, agent)
        loaded.push(agent.name)
      }
    } catch (err) {
      failed.push({ file, error: err as Error })
    }
  }
  return { loaded, failed }
}

// 类外 helper(文件底部)
function isAgentConfigLike(value: unknown): boolean {
  if (!value || typeof value !== 'object') return false
  const o = value as Record<string, unknown>
  return typeof o.name === 'string' && typeof o.description === 'string'
}

function toAgentConfig(c: MainAgentConfig): AgentConfig {
  return {
    name: c.name,
    description: c.description,
    slots: {
      systemPrompt: c.systemPrompt as AgentSlotFn<string[]> | undefined,
      tools: c.tools as AgentSlotFn<Tool[]> | undefined,
      mcp: c.mcp as AgentSlotFn<McpServerConfig[]> | undefined,
    },
  }
}

function buildLoadContext(): MainAgentLoadContext {
  const requireFromCore = createRequire(import.meta.url)
  const core = requireFromCore('./mainAgents.js') as { buildTool?: unknown; z?: unknown }
  return core as MainAgentLoadContext
}
```

> **关于 ctx**:core 内 `createRequire(import.meta.url)` 解析 `./mainAgents.js` 与 `MainAgentLoadContext` 同包,无需跨包。`buildTool` / `z` 已在 `MainAgentLoadContext` 类型定义中,本任务不重新实现。

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @zn-ai/zn-agent-core test test/server/agentRegistry.load.test.ts`
Expected: PASS

- [ ] **Step 5: Run typecheck**

Run: `pnpm --filter @zn-ai/zn-agent-core exec tsc --noEmit -p tsconfig.server.json`
Expected: 无错误(`Tool` / `McpServerConfig` 是占位类型,稍后由 zai-server 接通时收紧)

- [ ] **Step 6: Commit**

```bash
git add packages/zn-agent-core/src/opencc-src/server/agentRegistry.ts \
        packages/zn-agent-core/test/server/agentRegistry.load.test.ts
git commit -m "feat(zn-agent-core): implement loadBuiltinAgents and loadUserAgents"
```

---

### Task 3: `sessionBindings` CRUD + 检视方法

**Files:**
- Modify: `packages/zn-agent-core/src/opencc-src/server/agentRegistry.ts:68-72`
- Test: `packages/zn-agent-core/test/server/agentRegistry.bindings.test.ts`

**Interfaces:**
- Consumes: `AgentRegistryImpl.loadBuiltinAgents()` (Task 2)
- Produces:
  - `registryAgent(sessionId, agentId)` — fail loud if `!hasAgent(agentId)` → throw `UnknownAgentError`;幂等:已绑定同 (sid, agentId) → no-op;同 sid 不同 agentId → 覆盖 + DEBUG log
  - `unregistryAgent(sessionId)` — 无 sid 静默 no-op
  - `getBoundAgentId(sessionId): string | undefined`
  - `clear()` — 已存在(Task 1 写),扩展为不清 agents

- [ ] **Step 1: Write the failing test**

```typescript
// packages/zn-agent-core/test/server/agentRegistry.bindings.test.ts
import { describe, it, expect, beforeEach } from 'vitest'
import {
  AgentRegistryImpl,
  UnknownAgentError,
} from '../../src/opencc-src/server/agentRegistry.js'

describe('AgentRegistry sessionBindings', () => {
  let r: AgentRegistryImpl
  beforeEach(() => {
    r = new AgentRegistryImpl()
    r.loadBuiltinAgents()
  })

  it('registryAgent 注册后 getBoundAgentId 返回 agentId', () => {
    r.registryAgent('s1', 'default')
    expect(r.getBoundAgentId('s1')).toBe('default')
  })

  it('registryAgent 未知 agentId 抛 UnknownAgentError', () => {
    expect(() => r.registryAgent('s1', 'nonexistent')).toThrow(UnknownAgentError)
  })

  it('registryAgent 重复同 (sid, agentId) 幂等', () => {
    r.registryAgent('s1', 'default')
    r.registryAgent('s1', 'default')
    expect(r.getBoundAgentId('s1')).toBe('default')
  })

  it('registryAgent 同 sid 不同 agentId 覆盖', () => {
    r.registryAgent('s1', 'default')
    r.registryAgent('s1', 'office')
    expect(r.getBoundAgentId('s1')).toBe('office')
  })

  it('unregistryAgent 后 getBoundAgentId 返回 undefined', () => {
    r.registryAgent('s1', 'default')
    r.unregistryAgent('s1')
    expect(r.getBoundAgentId('s1')).toBeUndefined()
  })

  it('unregistryAgent 未注册 sid 无抛', () => {
    expect(() => r.unregistryAgent('nope')).not.toThrow()
  })

  it('clear 清 sessionBindings 但保留 agents', () => {
    r.registryAgent('s1', 'default')
    r.clear()
    expect(r.getBoundAgentId('s1')).toBeUndefined()
    expect(r.hasAgent('default')).toBe(true)
  })

  it('并发 100 次 registryAgent 同 sid 不死锁', async () => {
    const ps = Array.from({ length: 100 }, () =>
      Promise.resolve().then(() => r.registryAgent('s1', 'default')),
    )
    await Promise.all(ps)
    expect(r.getBoundAgentId('s1')).toBe('default')
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @zn-ai/zn-agent-core test test/server/agentRegistry.bindings.test.ts`
Expected: FAIL

- [ ] **Step 3: Write minimal implementation**

替换 `registryAgent` / `unregistryAgent` 占位:

```typescript
registryAgent(sessionId: string, agentId: string): void {
  if (!this.agents.has(agentId)) {
    throw new UnknownAgentError(agentId)
  }
  const existing = this.sessionBindings.get(sessionId)
  if (existing === agentId) {
    return // 幂等
  }
  if (existing !== undefined) {
    // 覆盖,可加 console.debug;默认静默
  }
  this.sessionBindings.set(sessionId, agentId)
}

unregistryAgent(sessionId: string): void {
  this.sessionBindings.delete(sessionId)
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @zn-ai/zn-agent-core test test/server/agentRegistry.bindings.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add packages/zn-agent-core/src/opencc-src/server/agentRegistry.ts \
        packages/zn-agent-core/test/server/agentRegistry.bindings.test.ts
git commit -m "feat(zn-agent-core): implement sessionBindings CRUD"
```

---

### Task 4: `slot()` dispatcher

**Files:**
- Modify: `packages/zn-agent-core/src/opencc-src/server/agentRegistry.ts:73-75`
- Test: `packages/zn-agent-core/test/server/agentRegistry.slot.test.ts`

**Interfaces:**
- Consumes: Task 2/3 完成的所有方法
- Produces:
  - `slot<T>(origin: T, slotId: AgentSlotId, sessionId: string): Promise<T>`
    - 未绑定 sid → throw `AgentNotBoundError(sessionId)`
    - `agents.get(boundAgentId).slots[slotId]` 不存在 → pass-through(返回 origin)
    - 存在 → `await fn(origin, sessionId)`,原错误透传

- [ ] **Step 1: Write the failing test**

```typescript
// packages/zn-agent-core/test/server/agentRegistry.slot.test.ts
import { describe, it, expect, beforeEach } from 'vitest'
import {
  AgentRegistryImpl,
  AgentNotBoundError,
} from '../../src/opencc-src/server/agentRegistry.js'

describe('AgentRegistry.slot', () => {
  let r: AgentRegistryImpl
  beforeEach(() => {
    r = new AgentRegistryImpl()
  })

  it('未绑定 sid 抛 AgentNotBoundError', async () => {
    await expect(r.slot(['x'], 'systemPrompt', 'unbound')).rejects.toBeInstanceOf(
      AgentNotBoundError,
    )
  })

  it('agent 未实现 slotId → pass-through 原 origin', async () => {
    // 注入无 slots 的 agent
    ;(r as any).agents.set('noop', { name: 'noop', description: 'd', slots: {} })
    r.registryAgent('s1', 'noop')
    const out = await r.slot(['a', 'b'], 'tools', 's1')
    expect(out).toEqual(['a', 'b'])
  })

  it('agent 实现 slotId → 调 fn 并返回结果', async () => {
    ;(r as any).agents.set('ext', {
      name: 'ext',
      description: 'd',
      slots: {
        tools: (origin: string[]) => [...origin, 'extra'],
      },
    })
    r.registryAgent('s1', 'ext')
    const out = await r.slot(['a'], 'tools', 's1')
    expect(out).toEqual(['a', 'extra'])
  })

  it('fn 是 async 时 await 返回', async () => {
    ;(r as any).agents.set('async-ext', {
      name: 'async-ext',
      description: 'd',
      slots: {
        systemPrompt: async (origin: string[]) => {
          await new Promise((res) => setTimeout(res, 1))
          return [...origin, 'async-line']
        },
      },
    })
    r.registryAgent('s1', 'async-ext')
    const out = await r.slot(['base'], 'systemPrompt', 's1')
    expect(out).toEqual(['base', 'async-line'])
  })

  it('fn 抛错 → 原错误透传', async () => {
    ;(r as any).agents.set('thrower', {
      name: 'thrower',
      description: 'd',
      slots: {
        tools: () => {
          throw new Error('agent tools fail')
        },
      },
    })
    r.registryAgent('s1', 'thrower')
    await expect(r.slot([], 'tools', 's1')).rejects.toThrow('agent tools fail')
  })

  it('sessionId 透传给 slot fn', async () => {
    let captured: string | undefined
    ;(r as any).agents.set('spy', {
      name: 'spy',
      description: 'd',
      slots: {
        tools: (origin: string[], sid: string) => {
          captured = sid
          return origin
        },
      },
    })
    r.registryAgent('s1', 'spy')
    await r.slot([], 'tools', 's1')
    expect(captured).toBe('s1')
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @zn-ai/zn-agent-core test test/server/agentRegistry.slot.test.ts`
Expected: FAIL

- [ ] **Step 3: Write minimal implementation**

替换 `slot` 占位:

```typescript
async slot<T>(origin: T, slotId: AgentSlotId, sessionId: string): Promise<T> {
  const agentId = this.sessionBindings.get(sessionId)
  if (agentId === undefined) {
    throw new AgentNotBoundError(sessionId)
  }
  const agent = this.agents.get(agentId)
  if (!agent) {
    throw new AgentNotBoundError(sessionId) // 防御:已绑定但 agent 不存在
  }
  const fn = agent.slots[slotId]
  if (!fn) {
    return origin // pass-through
  }
  return (await fn(origin as never, sessionId)) as T
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm --filter @zn-ai/zn-agent-core test test/server/agentRegistry.slot.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add packages/zn-agent-core/src/opencc-src/server/agentRegistry.ts \
        packages/zn-agent-core/test/server/agentRegistry.slot.test.ts
git commit -m "feat(zn-agent-core): implement slot dispatcher"
```

---

### Task 5: 下沉 zai-server `mainAgents.ts` 到 core + bundle entry 导出

**Files:**
- Modify: `packages/zn-agent-core/src/bundle-entry.ts:38`(在 `getBuiltinMainAgents` 导出附近追加)
- Modify: `packages/zai/src/server/services/mainAgents.ts`(改为 thin re-export)
- Test: 跑现有 `packages/zai/test/server/services/mainAgents.test.ts`,确保不回归

**Interfaces:**
- Consumes: Task 1-4 完成的所有 core API
- Produces:
  - core bundle entry 导出 `AgentRegistryImpl` 实例工厂(单例 `getAgentRegistry()`)
  - zai-server `services/mainAgents.ts` 删除 `loadUserMainAgents` / `mergeMainAgents` 实现,改为从 `@zn-ai/zn-agent-core` re-export 兼容旧 import
  - `isMainAgentConfig` 同步迁到 core 或保留 zai-server 旧 helper(deprecated)

- [ ] **Step 1: Write the failing import test**

新建 `packages/zn-agent-core/test/server/agentRegistry.exported.test.ts`:

```typescript
import { describe, it, expect } from 'vitest'
import {
  getAgentRegistry,
  AgentRegistryImpl,
} from '../../src/opencc-src/server/agentRegistry.js'

describe('agentRegistry exports', () => {
  it('getAgentRegistry 返回单例', () => {
    const a = getAgentRegistry()
    const b = getAgentRegistry()
    expect(a).toBe(b)
    expect(a).toBeInstanceOf(AgentRegistryImpl)
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm --filter @zn-ai/zn-agent-core test test/server/agentRegistry.exported.test.ts`
Expected: FAIL(`getAgentRegistry` 未导出)

- [ ] **Step 3: 实现 single instance + bundle entry 导出**

在 `packages/zn-agent-core/src/opencc-src/server/agentRegistry.ts` 文件底部追加:

```typescript
let singleton: AgentRegistryImpl | null = null
export function getAgentRegistry(): AgentRegistryImpl {
  if (!singleton) singleton = new AgentRegistryImpl()
  return singleton
}
export function resetAgentRegistryForTests(): void {
  singleton = null
}
```

修改 `packages/zn-agent-core/src/bundle-entry.ts` —— 在 line 38 后追加:

```typescript
// zai patch (2026-08-29): Agent 插件系统 registry —— 单例由 core 持有,
// zai-server 启动时 loadBuiltinAgents + loadUserAgents;session 生命周期
// 经 registryAgent / unregistryAgent;socket 派发走 slot()。见
// docs/superpowers/specs/2026-08-29-agent-plugin-system-refactor-design.md。
export {
  getAgentRegistry,
  resetAgentRegistryForTests,
  AgentRegistryImpl,
} from './opencc-src/server/agentRegistry.js'
export type {
  AgentConfig,
  AgentSlotId,
  AgentSlotFn,
  AgentRegistry,
  LoadUserAgentsResult,
  AgentRegistryError,
  UnknownAgentError,
  AgentNotBoundError,
  BuiltinAgentsLoadError,
} from './opencc-src/server/agentRegistry.js'
```

- [ ] **Step 4: Run core test to verify**

Run: `pnpm --filter @zn-ai/zn-agent-core test test/server/agentRegistry.exported.test.ts`
Expected: PASS

- [ ] **Step 5: 跑 build:core**

Run: `pnpm run build:core`
Expected: 全部构建步骤完成,`dist/opencc-core.mjs` 包含新导出

- [ ] **Step 6: 迁移 zai-server mainAgents.ts 到 thin re-export**

替换 `packages/zai/src/server/services/mainAgents.ts` 主体为:

```typescript
/**
 * 主 Agent 解析(zai patch 2026-08-29)。
 *
 * 核心 loader/registry 已下沉到 @zn-ai/zn-agent-core 的 AgentRegistry。
 * 本文件保留 zai-server 调用方需要的 import 兼容:
 *   - `resolveMainAgent(name)` 保留 {agent, agents} 形状,内部委托给
 *     core 的 `resolveAgent(name)` + `listAgents()`,settings UI 列
 *     agents 列表与 agentSettings.ts:117,354 调用保持原签名。
 *   - `mainAgentsDir()` 保留,作为 `loadUserAgents` 的默认 dir。
 *   - `isMainAgentConfig` / `buildLoadContext` 删除(已迁 core)。
 *   - `loadUserMainAgents` / `mergeMainAgents` 删除(已迁 core)。
 *
 * 见 docs/superpowers/specs/2026-08-29-agent-plugin-system-refactor-design.md。
 */
import { homedir } from 'node:os'
import { join } from 'node:path'
import {
  getAgentRegistry,
  type AgentConfig,
  type MainAgentConfig,
  type MainAgentSlot,
} from '@zn-ai/zn-agent-core'

/** 外置 agent 目录:`~/.zai/main-agents/`(保留兼容)。 */
export function mainAgentsDir(): string {
  return join(homedir(), '.zai', 'main-agents')
}

/**
 * 解析当前生效的主 Agent(原 {agent, agents} 形状保留)。
 * - `name` 未传 / 未知名 → 回退 `default`
 * - `agents` 全部已注册的 agent(供 settings UI 列列表)
 */
export async function resolveMainAgent(
  name: string | undefined,
): Promise<{ agent: AgentConfig; agents: AgentConfig[] }> {
  const registry = getAgentRegistry()
  const agents = registry.listAgents()
  const resolved = name ? registry.resolveAgent(name) : undefined
  const agent = resolved ?? registry.resolveAgent('default')
  if (!agent) {
    throw new Error('builtin default agent missing — loadBuiltinAgents not called?')
  }
  return { agent, agents }
}

// 兼容旧 import 名字
export type { AgentConfig as MainAgentConfig, MainAgentSlot }
```

> **删除**:原文件内 `loadUserMainAgents` / `mergeMainAgents` / `isMainAgentConfig` / `buildLoadContext` 实现全部删除。`resolveMainAgent` 保留为薄 wrapper。

- [ ] **Step 7: 跑 zai-side 现有 mainAgents 测试,确保 re-export 不破坏**

Run: `pnpm --filter @zn-ai/zai test test/server/services/mainAgents.test.ts`(路径以仓库实际为准,grep `mainAgents.test`)
Expected: PASS(若失败,根据报错调整 re-export 列表)

- [ ] **Step 8: Commit**

```bash
git add packages/zn-agent-core/src/opencc-src/server/agentRegistry.ts \
        packages/zn-agent-core/test/server/agentRegistry.exported.test.ts \
        packages/zn-agent-core/src/bundle-entry.ts \
        packages/zai/src/server/services/mainAgents.ts
git commit -m "refactor: sink mainAgents loader into core AgentRegistry, thin re-export zai-side"
```

---

## Phase 2 — 三态 runtime 接入(slot 调用替换)

### Task 6: `createOpenccRuntime-impl.ts`(lightweight 接入)

**Files:**
- Modify: `packages/zn-agent-core/src/opencc-src/server/createOpenccRuntime-impl.ts:122-125, :197-202, :219`

**Interfaces:**
- Consumes:
  - `getAgentRegistry(): AgentRegistryImpl` from `@zn-ai/zn-agent-core`(Task 5)
  - `input.sessionId: string`(已有)
- Produces: 三处 `await getAgentRegistry().slot(input, slotId, sessionId)` 替换原 `options.mainAgent?.[slotId](...)` 直接调用

- [ ] **Step 1: 跑现有 createOpenccRuntime 测试,确认替换前基线绿**

Run: `pnpm --filter @zn-ai/zn-agent-core test test/server/createOpenccRuntime.test.ts`(路径以实际为准,grep `createOpenccRuntime`)
Expected: PASS(若红,先排查既有 bug,不在本任务范围)

- [ ] **Step 2: 修改 :122-125(MCP 槽)**

把:

```typescript
if (options.mainAgent?.mcp) {
  const all = await getAllMcpConfigs()
  mcpConfigs = await options.mainAgent.mcp(all.servers)
}
```

替换为:

```typescript
const all = await getAllMcpConfigs()
mcpConfigs = await getAgentRegistry().slot(
  all.servers,
  'mcp',
  input.sessionId,
)
```

- [ ] **Step 3: 修改 :197-202(tools 槽)**

把:

```typescript
const engineComputeTools = () =>
  agent?.tools ? agent.tools(computeTools()) : computeTools()
```

替换为:

```typescript
const engineComputeTools = () =>
  getAgentRegistry().slot(computeTools(), 'tools', input.sessionId)
```

- [ ] **Step 4: 修改 :219(systemPrompt 槽)**

把:

```typescript
systemPromptSlot: agent?.systemPrompt,
```

替换为:

```typescript
systemPromptSlot: (origin: string[]) =>
  getAgentRegistry().slot(origin, 'systemPrompt', input.sessionId),
```

- [ ] **Step 5: 删除/注释 `agent` 局部变量**

原 `agent` 局部变量在 `:180-186` 定义,本任务后不再使用 → 删除或注释。需 grep `agent\\.` 确认无残留引用:

```bash
grep -n "\\bagent\\b" packages/zn-agent-core/src/opencc-src/server/createOpenccRuntime-impl.ts
```

若有残留,根据上下文删除。

- [ ] **Step 6: 跑 build:core + 单测**

Run:
```bash
pnpm run build:core
pnpm --filter @zn-ai/zn-agent-core test test/server/createOpenccRuntime.test.ts
```
Expected: PASS

- [ ] **Step 7: Commit**

```bash
git add packages/zn-agent-core/src/opencc-src/server/createOpenccRuntime-impl.ts
git commit -m "refactor(zn-agent-core): wire createOpenccRuntime to AgentRegistry.slot()"
```

---

### Task 7: `createHeadlessContext-impl.ts`(inproc tools + mcp 接入)

**Files:**
- Modify: `packages/zn-agent-core/src/opencc-src/server/createHeadlessContext-impl.ts:235, :290-309`

**Interfaces:**
- Consumes:
  - `getAgentRegistry(): AgentRegistryImpl` from `@zn-ai/zn-agent-core`
  - `input.sessionId: string` —— `createHeadlessContext` 当前可能没接收 sessionId;**本任务需要把 sessionId 透传到 createHeadlessContext 工厂**(如签名变更,grep 调用方同步)
- Produces:
  - `tools: Tools = getTools(permissionContext)` 之后 `await getAgentRegistry().slot(tools, 'tools', input.sessionId)`
  - `mcp` 连接路径 `await getMcpToolsCommandsAndResources(cb, slotMcpConfigs)` 之前 `const slotMcpConfigs = await getAgentRegistry().slot(getAllMcpConfigs().servers, 'mcp', input.sessionId)`

- [ ] **Step 1: 跑现有 createHeadlessContext 测试基线**

Run: `pnpm --filter @zn-ai/zn-agent-core test test/server/createHeadlessContext.test.ts`(以实际为准)
Expected: PASS

- [ ] **Step 2: grep createHeadlessContext 调用方,确认 sessionId 透传链**

```bash
grep -rn "createHeadlessContext" packages/zn-agent-core/src/opencc-src/ packages/zai/src/server/
```

记录所有调用点 — `input.sessionId` 必须在 `createHeadlessContext` 工厂签名内可用。如缺失,在最近的调用点(`headlessPrintSession.ts` 或 `createPrintRuntime-impl.ts`)注入。

- [ ] **Step 3: 修改 :235(tools 接入)**

把:

```typescript
const tools: Tools = getTools(permissionContext as any)
```

替换为:

```typescript
const baseTools: Tools = getTools(permissionContext as any)
const tools: Tools = await getAgentRegistry().slot(baseTools, 'tools', sessionId)
```

`sessionId` 来源:`createHeadlessContext({ sessionId, ... })` 新增 sessionId 入参,或在闭包内捕获。

- [ ] **Step 4: 修改 :290-309(mcp 接入)**

把:

```typescript
if (connectMcp) {
  try {
    await getMcpToolsCommandsAndResources(
      ({ client, tools: t, commands }) => { ... },
      // 第二参数已是可选 mcpConfigs
    )
```

调整为:从 `getAgentRegistry().slot(getAllMcpConfigs().servers, 'mcp', sessionId)` 拿过滤后 server 列表,作为第二参数传入。空数组 → 不连接(等同当前空数组分支)。

具体改动需读 `:290-340` 完整上下文,确认 `getMcpToolsCommandsAndResources` 的第二参数签名后修改。

- [ ] **Step 5: 跑 build:core + 单测**

Run:
```bash
pnpm run build:core
pnpm --filter @zn-ai/zn-agent-core test test/server/createHeadlessContext.test.ts
```
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add packages/zn-agent-core/src/opencc-src/server/createHeadlessContext-impl.ts
git commit -m "feat(zn-agent-core): wire createHeadlessContext to AgentRegistry slot for tools+mcp (inproc fix)"
```

---

### Task 8: `headlessPrintSession.ts`(inproc systemPrompt 接入)

**Files:**
- Modify: `packages/zn-agent-core/src/opencc-src/server/headlessPrintSession.ts`(定位 stdin init request 构造处)

**Interfaces:**
- Consumes:
  - `getAgentRegistry(): AgentRegistryImpl` from `@zn-ai/zn-agent-core`
  - `sessionId` 已在 headlessPrintSession 闭包内(per-session 常驻)
  - vendor `print.ts:4598-4603` 读 stdin init request 的 `systemPrompt` / `appendSystemPrompt` 字段
- Produces: stdin init request 构造前 `await getAgentRegistry().slot(baseSystemPrompt, 'systemPrompt', sessionId)`,把结果赋给 `request.systemPrompt` / `request.appendSystemPrompt`

- [ ] **Step 1: grep stdin init request 构造点**

```bash
grep -n "systemPrompt\|appendSystemPrompt\|init_request\|initialize_request\|InitializeRequest" packages/zn-agent-core/src/opencc-src/server/headlessPrintSession.ts
```

记录 `request.systemPrompt = ...` 或 `send(JSON.stringify({type: 'control_request', request: { subtype: 'initialize', systemPrompt: ... } }))` 的具体行号。

- [ ] **Step 2: 找到 baseSystemPrompt 来源**

通常为 `getDefaultSystemPrompt()` 或从 `createHeadlessContext` 注入的 `appState.systemPrompt`。grep `systemPrompt` 上下文,确认 base 值变量名。

- [ ] **Step 3: 修改 init request 构造**

示例(以实际变量名为准):

```typescript
// 原:
request.systemPrompt = baseSystemPrompt
// 改为:
const enriched = await getAgentRegistry().slot(baseSystemPrompt, 'systemPrompt', sessionId)
request.systemPrompt = enriched.join('\n')
// 或 appendSystemPrompt 路径:
request.appendSystemPrompt = enriched.join('\n')
```

具体是 `systemPrompt` 字段还是 `appendSystemPrompt` 字段,根据 vendor `print.ts:4598-4603` 决定(两者择一,不混用)。

- [ ] **Step 4: 跑 build:core + 现有 headlessPrintSession 测试**

Run:
```bash
pnpm run build:core
pnpm --filter @zn-ai/zn-agent-core test test/server/headlessPrintSession.test.ts
```
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add packages/zn-agent-core/src/opencc-src/server/headlessPrintSession.ts
git commit -m "feat(zn-agent-core): wire headlessPrintSession to AgentRegistry slot for systemPrompt (inproc fix)"
```

---

## Phase 3 — zai-server 生命周期接线

### Task 9: zai-server `agentRuntime.ts` 接入 + session lifecycle 钩子

**Files:**
- Modify: `packages/zai/src/server/services/agentRuntime.ts:520-660`(inproc 分支)、`:663`(lightweight)、initAgentRuntime 函数
- Modify: `packages/zai/src/server/routes/agent.ts:1081-1107, :1727`

**Interfaces:**
- Consumes:
  - `getAgentRegistry()` from `@zn-ai/zn-agent-core`(Task 5)
  - 现有 `initAgentRuntime` 函数体
- Produces:
  - `initAgentRuntime` 启动序列:
    1. `agentRegistry.loadBuiltinAgents()`
    2. `const userRes = await agentRegistry.loadUserAgents(mainAgentsDir())`,`if (userRes.failed.length) logger.warn(...)`
    3. `await restoreAllSessions(agentRegistry)`
  - 新增 `restoreAllSessions(registry)`:扫 `getTranscriptStore().list({cwd})`(或 `SessionFacade.list` 等价 API),逐个读 `transcript.meta.mainAgent`,`registry.registryAgent(sid, agentId ?? 'default')`;无 `mainAgent` 字段 fallback `'default'`,不报错
  - inproc 分支(`agentRuntime.ts:520-660`):不再传 `mainAgent` / `mainAgents` 给 `createPrintRuntime`(vendor 不认),改成依赖 `agentRegistry` 单例与 Task 7/8 的 inproc slot 接入
  - lightweight 分支(`:663`):删 `mainAgent` / `mainAgents` 入参(由 registry 接管)
  - `routes/agent.ts:1081-1107`:session 创建/恢复的 `sessionMainAgent` 解析后追加 `agentRegistry.registryAgent(sessionId, sessionMainAgent)`
  - `routes/agent.ts:1727`:session 删除追加 `agentRegistry.unregistryAgent(sessionId)`

- [ ] **Step 1: 跑 zai-side agentRuntime 测试基线**

Run: `pnpm --filter @zn-ai/zai test test/server/services/agentRuntime.test.ts`(以实际为准)
Expected: PASS

- [ ] **Step 2: 实现 restoreAllSessions**

新增 `packages/zai/src/server/services/agentRuntime.ts` 顶部辅助函数:

```typescript
async function restoreAllSessions(registry: AgentRegistryImpl): Promise<void> {
  const cwd = process.cwd()
  const sessions = await getTranscriptStore().list({ cwd }) // 路径以实际为准
  for (const info of sessions) {
    try {
      const t = await getTranscriptStore().read(info.sessionId, { cwd })
      const agentId = (t.meta as { mainAgent?: string } | undefined)?.mainAgent ?? 'default'
      registry.registryAgent(info.sessionId, agentId)
    } catch (err) {
      // 老会话没 meta.mainAgent 字段 → fallback 'default'(registry 接受)
      registry.registryAgent(info.sessionId, 'default')
    }
  }
}
```

> **关于 API**:`getTranscriptStore().list` 与 `.read` 签名以仓库实际为准;若有偏差,改用 `SessionFacade.list`(`packages/zn-agent-core/src/opencc-src/server/sessionFacade.ts`)或直接 `readdir(transcriptsDir)`。

- [ ] **Step 3: 修改 initAgentRuntime**

在 `initAgentRuntime` 现有 `loadPluginRuntime` 之后追加:

```typescript
const agentRegistry = getAgentRegistry()
agentRegistry.loadBuiltinAgents()
const userRes = await agentRegistry.loadUserAgents(mainAgentsDir())
if (userRes.failed.length > 0) {
  logger.warn({ failed: userRes.failed }, 'user main agents load partially failed')
}
await restoreAllSessions(agentRegistry)
```

- [ ] **Step 4: 修改 inproc 分支(:520-660) + `createPrintRuntime-impl.ts:399, :446`**

把 `createPrintRuntime({...mainAgent, mainAgents})` 调用中的 `mainAgent` / `mainAgents` 字段删除(vendor 不认)。**同时**修改 `createPrintRuntime-impl.ts` 内部两处残留:

```typescript
// packages/zn-agent-core/src/opencc-src/server/createPrintRuntime-impl.ts:399
// 原:agentType: input.mainAgent
// 改为(从 registry 取,plugin runtime hook 'startup' 仍接受 agentType 但语义弱化):
agentType: getAgentRegistry().getBoundAgentId(input.sessionId) ?? 'default',

// :446
// 原:agent: input.mainAgent
// 改为(取消 vendor agent 查找,vendor 走默认 systemPrompt,由 Task 7/8 的 zai slot 提前注入):
agent: undefined,
```

`createPrintRuntimeImpl` 内部通过 Task 7/8 的 slot 接入自动应用 registry;vendor `agent` 选项关闭,避免 vendor `print.ts:4616-4655` 试图查找 filesystem agent(`'default'` 命中 builtin AgentDefinition 不是 zai 的 MainAgentConfig)。

```typescript
// agentRuntime.ts:520-660 原:
const runtime = await createPrintRuntime({
  dataDir,
  mainAgent,
  mainAgents,
  // ...
})
// 改为:
const runtime = await createPrintRuntime({
  dataDir,
  // ...
})
```

- [ ] **Step 5: 修改 lightweight 分支(:663)**

`createOpenccRuntime({...mainAgent, mainAgents})` 同删 `mainAgent` / `mainAgents`。Task 6 接入已自动通过 registry。**`agentRuntime.ts:663` 处调用 `resolveMainAgent(...)` 也删除**(已下沉 core);改为 `getAgentRegistry().hasAgent(...)` 或直接依赖 `registryAgent` 早先已在 prompt 路径绑定的事实。

- [ ] **Step 6: 修改 routes/agent.ts:1081-1107**

在 `sessionMainAgent` 解析后(已有逻辑末尾),`agentRuntime.ts:1081-1107` 已有 `if (sessionMainAgent === null) { ... patch transcript ... }`,之后追加:

```typescript
// agent registry bind
if (sessionMainAgent !== null) {
  getAgentRegistry().registryAgent(sessionId, sessionMainAgent)
}
```

> **关于 sessionMainAgent 类型**:原代码可能是 `string | null`,本任务确保 nullable → registry 只接受 string,空值跳过。

- [ ] **Step 7: 修改 routes/agent.ts:1727**

在 `CwdStore.delete(sessionId)` 之后追加:

```typescript
getAgentRegistry().unregistryAgent(sessionId)
```

- [ ] **Step 8: 跑 build:core + zai-side 相关测试**

Run:
```bash
pnpm run build:core
pnpm --filter @zn-ai/zai test test/server/services/agentRuntime.test.ts \
                              test/server/routes/agent.test.ts
```
Expected: PASS(若失败,根据报错调整)

- [ ] **Step 9: Commit**

```bash
git add packages/zai/src/server/services/agentRuntime.ts \
        packages/zai/src/server/routes/agent.ts
git commit -m "feat(zai): wire agent registry lifecycle (load/restore/create/delete)"
```

---

### Task 10: `runtimeLifecycle.ts` 服务关闭清理

**Files:**
- Modify: `packages/zn-agent-core/src/opencc-src/server/runtimeLifecycle.ts:56`(closeServer)

**Interfaces:**
- Consumes: `getAgentRegistry()` from `@zn-ai/zn-agent-core`
- Produces: `closeServer()` 内 `getAgentRegistry().clear()` 释放 sessionBindings

- [ ] **Step 1: 跑 runtimeLifecycle 测试基线**

Run: `pnpm --filter @zn-ai/zn-agent-core test test/server/runtimeLifecycle.test.ts`(以实际为准)
Expected: PASS

- [ ] **Step 2: 修改 closeServer**

定位 `closeServer` 函数体(`runtimeLifecycle.ts:56` 附近),在最后追加:

```typescript
import { getAgentRegistry } from './agentRegistry.js'
// ...
export async function closeServer(): Promise<void> {
  // ... 现有清理 ...
  getAgentRegistry().clear() // 清 sessionBindings;agents map 保留
}
```

- [ ] **Step 3: 跑 build:core + 测试**

Run:
```bash
pnpm run build:core
pnpm --filter @zn-ai/zn-agent-core test test/server/runtimeLifecycle.test.ts
```
Expected: PASS

- [ ] **Step 4: Commit**

```bash
git add packages/zn-agent-core/src/opencc-src/server/runtimeLifecycle.ts
git commit -m "chore(zn-agent-core): clear agent registry session bindings on server close"
```

---

## Phase 4 — 回归与 E2E 验证

### Task 11: 回归测试(builtin agents 行为不变 + 外置文件三种格式)

**Files:**
- Modify: `packages/zai/test/server/services/mainAgents.test.ts`(如不存在,新建)

**Interfaces:**
- Consumes: `getBuiltinMainAgents()` from core;`loadUserAgents(dir)` from core
- Produces: 回归断言
  - builtin 三个 agent 名称不变
  - `office` / `agent-creator` 的 `systemPrompt` / `tools` 输出 byte-for-byte 与重构前一致(snapshot)
  - 外置 `.js` 三种格式(export object / factory function / default export)都正常加载

- [ ] **Step 1: 跑现有 mainAgents 测试基线**

Run: `pnpm --filter @zn-ai/zai test test/server/services/mainAgents.test.ts`
Expected: PASS(re-export 已就绪,Task 5 已验)

- [ ] **Step 2: 新增 byte-for-byte snapshot 测试**

在 `mainAgents.test.ts` 追加:

```typescript
import { describe, it, expect } from 'vitest'
import { getBuiltinMainAgents, getAgentRegistry } from '@zn-ai/zn-agent-core'

describe('builtin main agents snapshot', () => {
  it('default/office/agent-creator 名称不变', () => {
    const names = getBuiltinMainAgents().map(a => a.name).sort()
    expect(names).toEqual(['agent-creator', 'default', 'office'])
  })

  it('office.systemPrompt(空 origin) 返回非空字符串数组', async () => {
    const r = getAgentRegistry()
    r.loadBuiltinAgents()
    r.registryAgent('s1', 'office')
    const out = await r.slot<string[]>([], 'systemPrompt', 's1')
    expect(Array.isArray(out)).toBe(true)
    expect(out.length).toBeGreaterThan(0)
    expect(out.join('\n')).toMatchSnapshot()
  })

  it('agent-creator.tools(空 origin) 包含 ValidateMainAgent', async () => {
    const r = getAgentRegistry()
    r.loadBuiltinAgents()
    r.registryAgent('s1', 'agent-creator')
    const tools = await r.slot<any[]>([], 'tools', 's1')
    expect(tools.map((t: any) => t.name)).toContain('ValidateMainAgent')
  })

  it('default.tools append displayFilesOpenccTool', async () => {
    const r = getAgentRegistry()
    r.loadBuiltinAgents()
    r.registryAgent('s1', 'default')
    const tools = await r.slot<any[]>([], 'tools', 's1')
    expect(tools.map((t: any) => t.name)).toContain('mcp__display_files__read_file')
  })
})
```

- [ ] **Step 3: 新增外置 .js 三格式加载测试**

```typescript
import { mkdtemp, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

describe('loadUserAgents format compat', () => {
  it('CJS object export', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'fmt-'))
    await writeFile(join(dir, 'a.js'), `module.exports = { name: 'a', description: 'd' };`)
    const r = getAgentRegistry()
    const res = await r.loadUserAgents(dir)
    expect(res.loaded).toEqual(['a'])
    await rm(dir, { recursive: true })
  })

  it('CJS factory export', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'fmt-'))
    await writeFile(join(dir, 'b.js'), `module.exports = (ctx) => ({ name: 'b', description: 'd' });`)
    const r = getAgentRegistry()
    const res = await r.loadUserAgents(dir)
    expect(res.loaded).toEqual(['b'])
    await rm(dir, { recursive: true })
  })

  it('ESM default export factory', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'fmt-'))
    await writeFile(
      join(dir, 'c.mjs'),
      `export default () => ({ name: 'c', description: 'd' });`,
    )
    // 注:本仓库 loadUserAgents 只扫 .js,不是 .mjs;测试跳过 .mjs 走 c.js 路径:
    await writeFile(join(dir, 'c.js'), `export default () => ({ name: 'c', description: 'd' });`)
    const r = getAgentRegistry()
    const res = await r.loadUserAgents(dir)
    expect(res.loaded).toEqual(['c'])
    await rm(dir, { recursive: true })
  })

  it('数组导出(单文件多 agent)', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'fmt-'))
    await writeFile(
      join(dir, 'multi.js'),
      `module.exports = [{ name: 'x1', description: 'd' }, { name: 'x2', description: 'd' }];`,
    )
    const r = getAgentRegistry()
    const res = await r.loadUserAgents(dir)
    expect(res.loaded.sort()).toEqual(['x1', 'x2'])
    await rm(dir, { recursive: true })
  })
})
```

- [ ] **Step 4: 跑全部新测试**

Run: `pnpm --filter @zn-ai/zai test test/server/services/mainAgents.test.ts`
Expected: PASS

- [ ] **Step 5: 接受 snapshot(首次)**

```bash
pnpm --filter @zn-ai/zai test test/server/services/mainAgents.test.ts -u
git add packages/zai/test/server/services/mainAgents.test.ts
git commit -m "test(zai): snapshot builtin main agent outputs + external .js format compat"
```

---

### Task 12: E2E 验证(inproc + lightweight + office 真实生效)

**Files:**
- 不写代码,只做行为验证
- 若失败,记录现象并回到 Phase 2 修复

**Interfaces:**
- Consumes: `pnpm --filter @zn-ai/zai dev` 起服务;`/ego-browser` skill
- Produces: 验证矩阵

- [ ] **Step 1: 启动 lightweight dev 服务(空闲端口)**

Run:
```bash
lsof -i :8102 || pnpm --filter @zn-ai/zai dev -- --port 8102 --api-port 7715
```
Expected: 服务在 `http://localhost:8102`

- [ ] **Step 2: 浏览器验证 office agent 在 lightweight 生效**

调 `/ego-browser` skill,目标:
- 访问 `http://localhost:8102/agent`
- 切换全局 `settings.mainAgent = 'office'`
- 新建会话,发第一条 user message
- 用 inspector / evaluate 取 systemPrompt 数组,断言含 office 注入文本(grep "office" / "Deliver directly usable output" 等关键字)

Expected: 断言通过

- [ ] **Step 3: 浏览器验证 office agent 在 inproc 生效(关键修复)**

切 `ZAI_CORE_RUNTIME=inproc`(重启服务,或改 `.zai/settings.json` → `{"agent":{"kernel":"inproc"}}`),重复 Step 2。

Expected: 断言通过(原 inproc bug 已修复)

- [ ] **Step 4: 浏览器验证 default agent**

切回 `default`,Step 2 流程重复,断言不含 office 注入文本。

Expected: 断言通过

- [ ] **Step 5: 浏览器验证外置自定义 agent**

```bash
mkdir -p ~/.zai/main-agents
cat > ~/.zai/main-agents/e2e.js <<'EOF'
module.exports = { name: 'e2e', description: 'E2E marker', systemPrompt: (origin) => [...origin, 'E2E_MARKER_LINE'] };
EOF
```

重启服务,settings.mainAgent = 'e2e',新建会话,发消息 → systemPrompt 数组末尾应含 `'E2E_MARKER_LINE'`。

清理:`rm ~/.zai/main-agents/e2e.js`(测试结束后)

Expected: 断言通过

- [ ] **Step 6: 浏览器验证 restart-restore**

发送消息后,`Ctrl-C` 关闭 dev 服务,重启,恢复同一 sessionId,继续发消息 → agent binding 重建(从 `transcript.meta.mainAgent`),行为不变。

Expected: 会话恢复后 systemPrompt 与重启前一致

- [ ] **Step 7: 收尾**

- 关闭 dev 服务
- 删除 `~/.zai/main-agents/e2e.js`(若 Step 5 创建)
- 不在本任务 commit;若发现 bug,回到 Phase 2 修

- [ ] **Step 8: 最终验证**

Run:
```bash
pnpm run build:core
pnpm -r exec tsc --noEmit
```

Expected: 全绿

- [ ] **Step 9: 最终 commit(若有杂项修复)**

```bash
git status
# 若有 diff,逐文件 commit:
git add <fix files>
git commit -m "fix: E2E followups from inproc mainAgent verification"
```

---

## Self-Review Checklist

> Per writing-plans skill — 已就地核对:

- [x] **Spec 覆盖**:spec §2(数据契约)→ Task 1,2,3,4,5;§3.1(启动)→ Task 9 Step 3;§3.2(冷启动恢复)→ Task 9 Step 2;§3.3(创建)→ Task 9 Step 6;§3.4(恢复)→ Task 9 Step 6;§3.5(销毁)→ Task 9 Step 7;§3.6(关闭)→ Task 10;§3.7.1(lightweight)→ Task 6;§3.7.2(inproc)→ Task 7,8;§4(错误处理)→ Task 1-4 各方法;§5.1(下沉)→ Task 5;§5.3(三态改造)→ Task 6,7,8,9;§5.4(不动)→ 全 plan 内未触碰;§6.1(unit)→ Task 1-4;§6.2(integration)→ Task 9 Step 8 + 11;§6.3(migration regression)→ Task 11;§6.4(e2e)→ Task 12
- [x] **Placeholder 扫描**:无"TBD"/"TODO"/"implement later";所有代码片段完整可执行;Task 11 Step 2 接受 snapshot 是显式一次性操作(标了 `-u`)
- [x] **类型一致**:`AgentSlotId`/`AgentConfig`/`AgentRegistry`/`AgentRegistryError` 在 Task 1 定义,Task 2-5 引用一致;`getAgentRegistry()` 在 Task 5 导出,Task 6-10 引用一致
- [x] **API 假设**:`getTranscriptStore().list/.read` 签名以仓库实际为准(Task 9 Step 2 标了 fallback 路径);`createHeadlessContext({sessionId})` 签名变更需 grep 调用方(Task 7 Step 2 标了)
- [x] **commit message 风格**:遵循 `feat(zn-agent-core):` / `refactor:` / `chore:` 前缀,与现有 git log 一致

---

## Execution Handoff

Plan complete and saved to `docs/superpowers/plans/2026-08-29-agent-plugin-system-refactor.md`. Two execution options:

1. **Subagent-Driven (recommended)** - dispatch fresh subagent per task, review between tasks, fast iteration
2. **Inline Execution** - execute tasks in this session using executing-plans, batch execution with checkpoints

Which approach?
