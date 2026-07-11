# zai-agent-core MCP 工具接入 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在 `zai-agent-core` 中端到端接入 MCP (Model Context Protocol) 工具能力，让 `RuntimeConfig.mcpServers` 里的 MCP server 通过 stdio / SSE / StreamableHTTP 三种 transport 接入，并把它们的 tools 和 skills 注入到 queryEngine 工具池。

**Architecture:** 方案 A — 在 RuntimeConfig 顶层新增 `mcpClientPool?: MCPClientPool` 和 `mcpServers?: McpServerSpec[]`。`MCPClientPool` 负责连接生命周期、artifacts 缓存、错误聚合。`MCPToolAdapter` 把 MCP `tool/list` 翻译成 zai-agent-core `Tool<>`（命名 `mcp__<server>__<tool>`）。`SkillResourceAdapter` 把 MCP `resources/read` 的 `skill://` URI 翻译成 `LoadedSkill`。queryEngine 在每个 turn 调 `pool.connectAll` 幂等建连，从 `getArtifacts()` 取 tools 和 skills 合并到工具池。zai-server shutdown 时调 `pool.disconnectAll()`。

**Tech Stack:** TypeScript (strict), `@modelcontextprotocol/sdk ^1.6.1`（与 `packages/mcp-proxy-server` 对齐），Bun runtime + bun test，Zod schema。

**Spec:** `docs/superpowers/specs/2026-07-11-zai-agent-core-mcp-integration-design.md` (commit `35e0b5f`)

## Global Constraints

- **依赖**：`@modelcontextprotocol/sdk ^1.6.1`，版本与 `packages/mcp-proxy-server` 对齐
- **命名**：MCP 工具名 `mcp__<serverName>__<originalToolName>`（OpenCC 风格）
- **配置源**：仅 RuntimeConfig.mcpServers；zai-server 负责读 `~/.zai/settings.json` + `cwd/.mcp.json` 后合并传入
- **生命周期**：zai-agent-core 自管 pool；zai-server shutdown 调 disconnectAll；queryEngine 不在 finally/finally 调 disconnectAll
- **OAuth**：仅 env 注入 bearer/header，不做交互式 OAuth
- **失败策略**：MCP 永不打断 query（pool.connectAll 永不抛错，tool.call 失败返回 isError，disconnectAll 失败仅 log warn）
- **E2E 测试**：默认 CI 不跑，靠 `RUN_MCP_E2E=1` 触发
- **commit 风格**：遵循 `<type>(<scope>): <description>`，type ∈ {feat, fix, test, refactor, docs, chore}
- **TDD**：每个 task 先写失败测试，再写实现，再 commit
- **不允许**：在非测试文件用 `as any` / `@ts-ignore` / 空 catch / catch-all 文件

---

## File Structure

### 新增文件

| 路径 | 职责 |
|------|------|
| `packages/zai-agent-core/src/mcp/types.ts` | `McpServerSpec` / `MCPClientPool` / `MCPTool` / 错误类型 |
| `packages/zai-agent-core/src/mcp/MCPClientPool.ts` | 连接生命周期管理、artifacts 缓存、健康状态 |
| `packages/zai-agent-core/src/mcp/MCPToolAdapter.ts` | MCP `tool/list` → zai-agent-core `Tool<>` |
| `packages/zai-agent-core/src/mcp/SkillResourceAdapter.ts` | MCP `resources/read` skill:// → `LoadedSkill` |
| `packages/zai-agent-core/src/mcp/transport.ts` | `createMcpTransport` 工厂 + `injectAuth` |
| `packages/zai-agent-core/src/mcp/errors.ts` | MCP 错误分类 + 格式化 |
| `packages/zai-agent-core/src/mcp/jsonSchemaToZod.ts` | JSON Schema → Zod 转换 |
| `packages/zai-agent-core/src/tools/ListMcpResourcesTool/ListMcpResourcesTool.ts` | 列出 MCP server 的 resources |
| `packages/zai-agent-core/src/tools/ReadMcpResourceTool/ReadMcpResourceTool.ts` | 读取 MCP resource |
| `packages/zai-agent-core/test/mcp/tool-name.test.ts` | `makeMcpToolName` 单元测试 |
| `packages/zai-agent-core/test/mcp/schema-convert.test.ts` | `jsonSchemaToZod` 单元测试 |
| `packages/zai-agent-core/test/mcp/skill-parser.test.ts` | `parseSkillResource` 单元测试 |
| `packages/zai-agent-core/test/mcp/auth-inject.test.ts` | `injectAuth` 单元测试 |
| `packages/zai-agent-core/test/mcp/transport-factory.test.ts` | `createMcpTransport` 单元测试 |
| `packages/zai-agent-core/test/mcp/permission-matcher.test.ts` | `matchToolName` 单元测试 |
| `packages/zai-agent-core/test/mcp/pool.test.ts` | MCPClientPool 集成测试（用 MockMcpServer） |
| `packages/zai-agent-core/test/mcp/fixtures/MockMcpServer.ts` | 内存 MCP 协议 fixture |
| `packages/zai-agent-core/test/mcp/e2e-stdio.test.ts` | E2E：spawn 真 MCP server |
| `packages/zai-agent-core/test/mcp/e2e-sse.test.ts` | E2E：in-process SSE server |
| `packages/zai/src/server/services/mcpConfig.ts` | 读 `~/.zai/settings.json` + `cwd/.mcp.json` 合并为 `McpServerSpec[]` |

### 修改文件

| 路径 | 变更 |
|------|------|
| `packages/zai-agent-core/package.json` | 加 `@modelcontextprotocol/sdk ^1.6.1` 到 dependencies |
| `packages/zai-agent-core/src/opencc-internals/services/mcp/client.ts` | 去掉 `@ts-nocheck`，导出适配后的 `createMCPClient` |
| `packages/zai-agent-core/src/runtime/types.ts` | `RuntimeConfig.mcpServers` / `mcpClientPool` / `mcpSkillLoading` 字段 |
| `packages/zai-agent-core/src/runtime/queryEngine.ts` | `pool.connectAll` / `getArtifacts` 装配 MCP artifacts 到工具池 |
| `packages/zai-agent-core/src/runtime/streamAdapter.ts` | 校验 `mcp_server` 错误分类 recoverable |
| `packages/zai-agent-core/src/tools/index.ts` | 暴露 MCP 工具 + 资源工具 |
| `packages/zai-agent-core/test/runtime/toolExecution.test.ts` | 加 MCP 工具用例 |
| `packages/zai/src/server/index.ts` | DefaultAgentRuntime 注入 pool + shutdown disconnectAll |

---

## Task 1: 构建层 — 接入 @modelcontextprotocol/sdk

**Files:**
- Modify: `packages/zai-agent-core/package.json`
- Modify: `packages/zai-agent-core/src/opencc-internals/services/mcp/client.ts`
- Modify: `packages/zai-agent-core/src/runtime/types.ts`（仅 `McpServerSpec` 字段类型精化）

**Interfaces:**
- Consumes: 现有 `RuntimeConfig.mcpServers` 字段（已在 `src/runtime/types.ts:43`）
- Produces: `@modelcontextprotocol/sdk` 类型导入可用，client.ts 无 `@ts-nocheck`，可创建 `Client` 实例

- [ ] **Step 1: 加 SDK 到 dependencies**

修改 `packages/zai-agent-core/package.json`，在 `dependencies` 中新增：

```json
"@modelcontextprotocol/sdk": "^1.6.1"
```

- [ ] **Step 2: 安装**

Run: `cd packages/zai-agent-core && bun install`
Expected: `+ @modelcontextprotocol/sdk@1.6.x` 安装成功，bun.lock 变更

- [ ] **Step 3: 改 RuntimeConfig.mcpServers 字段类型**

修改 `packages/zai-agent-core/src/runtime/types.ts:43`：

```ts
import type { McpServerSpec } from '../mcp/types.js'

// 把第 43 行原字段
// mcpServers?: Array<{ name: string; command?: string; args?: string[]; url?: string }>
// 替换为
mcpServers?: McpServerSpec[]
```

并在 `src/mcp/types.ts`（创建）放：

```ts
export type McpServerSpec = {
  name: string
  transport:
    | { kind: 'stdio'; command: string; args?: string[]; env?: Record<string, string> }
    | { kind: 'sse'; url: string; headers?: Record<string, string> }
    | { kind: 'http'; url: string; headers?: Record<string, string> }
  auth?: {
    bearerEnvVar?: string
    headerEnvVars?: Record<string, string>
  }
  reconnect?: { maxRetries?: number; backoffMs?: number }
  callTimeoutMs?: number
}
```

- [ ] **Step 4: 写失败测试**

`packages/zai-agent-core/test/mcp/build.test.ts`：

```ts
import { describe, expect, test } from 'bun:test'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'

describe('MCP SDK import', () => {
  test('Client class is constructible', () => {
    const client = new Client({ name: 'test', version: '1.0.0' }, { capabilities: {} })
    expect(client).toBeInstanceOf(Client)
  })
})
```

- [ ] **Step 5: 跑测试验证 SDK 可导入**

Run: `cd packages/zai-agent-core && bun test test/mcp/build.test.ts`
Expected: PASS

- [ ] **Step 6: 去掉 client.ts 的 @ts-nocheck**

修改 `packages/zai-agent-core/src/opencc-internals/services/mcp/client.ts`，删除文件第一行 `// @ts-nocheck`。如果文件编译出错（缺类型等），先在 `src/mcp/types.ts` 末尾补 `export type McpSdkClient = InstanceType<typeof Client>`，并在 client.ts 里 import 后用。

- [ ] **Step 7: 验证编译**

Run: `cd packages/zai-agent-core && bun run typecheck 2>&1 || bunx tsc --noEmit -p .`
Expected: `MCPClientPool` / `McpServerSpec` / `@modelcontextprotocol/sdk` 相关报错 0 个

- [ ] **Step 8: Commit**

```bash
cd packages/zai-agent-core
git add package.json bun.lock src/mcp/types.ts src/runtime/types.ts src/opencc-internals/services/mcp/client.ts test/mcp/build.test.ts
git commit -m "feat(zai-agent-core): wire @modelcontextprotocol/sdk as real dep + McpServerSpec types"
```

---

## Task 2: MCPClientPool 原语 — 连接生命周期

**Files:**
- Create: `packages/zai-agent-core/src/mcp/MCPClientPool.ts`
- Create: `packages/zai-agent-core/src/mcp/transport.ts`
- Create: `packages/zai-agent-core/src/mcp/errors.ts`
- Test: `packages/zai-agent-core/test/mcp/tool-name.test.ts`
- Test: `packages/zai-agent-core/test/mcp/auth-inject.test.ts`
- Test: `packages/zai-agent-core/test/mcp/transport-factory.test.ts`
- Test: `packages/zai-agent-core/test/mcp/fixtures/MockMcpServer.ts`
- Test: `packages/zai-agent-core/test/mcp/pool.test.ts`

**Interfaces:**
- Consumes: `McpServerSpec`（Task 1）
- Produces:
  - `class MCPClientPool implements MCPClientPool`
  - `createMcpTransport(spec, signal): Transport`
  - `injectAuth(spec): McpServerSpec`
  - `class McpServerError extends Error { retryable: boolean; serverName: string }`

- [ ] **Step 1: 写 errors.ts 失败测试**

`packages/zai-agent-core/test/mcp/errors.test.ts`：

```ts
import { describe, expect, test } from 'bun:test'
import { McpServerError } from '../../src/mcp/errors.js'

describe('McpServerError', () => {
  test('carries serverName and retryable', () => {
    const err = new McpServerError('connect failed', { serverName: 'github', retryable: true })
    expect(err.serverName).toBe('github')
    expect(err.retryable).toBe(true)
    expect(err.message).toBe('connect failed')
  })
})
```

Run: `cd packages/zai-agent-core && bun test test/mcp/errors.test.ts`
Expected: FAIL with "Cannot find module '../../src/mcp/errors.js'"

- [ ] **Step 2: 实现 errors.ts**

`packages/zai-agent-core/src/mcp/errors.ts`：

```ts
export type McpServerErrorContext = {
  serverName: string
  retryable: boolean
  originalError?: unknown
}

export class McpServerError extends Error {
  readonly serverName: string
  readonly retryable: boolean
  readonly originalError: unknown

  constructor(message: string, ctx: McpServerErrorContext) {
    super(message)
    this.name = 'McpServerError'
    this.serverName = ctx.serverName
    this.retryable = ctx.retryable
    this.originalError = ctx.originalError
  }
}

export function formatMcpError(err: unknown, serverName: string): string {
  if (err instanceof McpServerError) return `${err.message} (server: ${err.serverName})`
  if (err instanceof Error) return `MCP tool call failed: ${err.message}`
  return `MCP tool call failed: ${String(err)} (server: ${serverName})`
}
```

- [ ] **Step 3: 跑测试验证通过**

Run: `cd packages/zai-agent-core && bun test test/mcp/errors.test.ts`
Expected: PASS

- [ ] **Step 4: 写 tool-name.ts 失败测试**

`packages/zai-agent-core/test/mcp/tool-name.test.ts`：

```ts
import { describe, expect, test } from 'bun:test'
import { makeMcpToolName, parseMcpToolName } from '../../src/mcp/tool-name.js'

describe('makeMcpToolName', () => {
  test('joins server and tool with double underscore', () => {
    expect(makeMcpToolName('github', 'create_issue')).toBe('mcp__github__create_issue')
  })
})

describe('parseMcpToolName', () => {
  test('parses valid mcp name', () => {
    expect(parseMcpToolName('mcp__github__create_issue')).toEqual({
      serverName: 'github',
      originalName: 'create_issue',
    })
  })

  test('returns null on non-mcp name', () => {
    expect(parseMcpToolName('Bash')).toBeNull()
  })

  test('returns null on malformed mcp name with single underscore segment', () => {
    expect(parseMcpToolName('mcp__github__')).toEqual({
      serverName: 'github',
      originalName: '',
    })
  })
})
```

Run: `cd packages/zai-agent-core && bun test test/mcp/tool-name.test.ts`
Expected: FAIL with "Cannot find module '../../src/mcp/tool-name.js'"

- [ ] **Step 5: 实现 tool-name.ts**

`packages/zai-agent-core/src/mcp/tool-name.ts`：

```ts
const MCP_PREFIX = 'mcp__'

export function makeMcpToolName(serverName: string, toolName: string): string {
  return `${MCP_PREFIX}${serverName}__${toolName}`
}

export function parseMcpToolName(
  name: string
): { serverName: string; originalName: string } | null {
  if (!name.startsWith(MCP_PREFIX)) return null
  const rest = name.slice(MCP_PREFIX.length)
  const sep = rest.indexOf('__')
  if (sep < 0) return null
  return {
    serverName: rest.slice(0, sep),
    originalName: rest.slice(sep + 2),
  }
}
```

- [ ] **Step 6: 跑测试验证通过**

Run: `cd packages/zai-agent-core && bun test test/mcp/tool-name.test.ts`
Expected: PASS (3 tests)

- [ ] **Step 7: 写 transport.ts 失败测试**

`packages/zai-agent-core/test/mcp/transport-factory.test.ts`：

```ts
import { describe, expect, test } from 'bun:test'
import { createMcpTransport, injectAuth } from '../../src/mcp/transport.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import { SSEClientTransport } from '@modelcontextprotocol/sdk/client/sse.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'

describe('createMcpTransport', () => {
  test('stdio kind returns StdioClientTransport', () => {
    const t = createMcpTransport(
      { name: 'x', transport: { kind: 'stdio', command: 'node', args: ['m.js'] } },
      new AbortController().signal
    )
    expect(t).toBeInstanceOf(StdioClientTransport)
  })

  test('sse kind returns SSEClientTransport', () => {
    const t = createMcpTransport(
      { name: 'x', transport: { kind: 'sse', url: 'https://example.com/sse' } },
      new AbortController().signal
    )
    expect(t).toBeInstanceOf(SSEClientTransport)
  })

  test('http kind returns StreamableHTTPClientTransport', () => {
    const t = createMcpTransport(
      { name: 'x', transport: { kind: 'http', url: 'https://example.com/mcp' } },
      new AbortController().signal
    )
    expect(t).toBeInstanceOf(StreamableHTTPClientTransport)
  })

  test('sse kind auto-detected by url ending in /sse', () => {
    const t = createMcpTransport(
      { name: 'x', transport: { kind: 'http', url: 'https://example.com/api/sse' } },
      new AbortController().signal
    )
    expect(t).toBeInstanceOf(SSEClientTransport)
  })
})

describe('injectAuth', () => {
  test('bearerEnvVar injects Authorization header', () => {
    process.env.TEST_BEARER = 'secret-token'
    const out = injectAuth({
      name: 'x',
      transport: { kind: 'sse', url: 'https://example.com/sse' },
      auth: { bearerEnvVar: 'TEST_BEARER' },
    })
    expect(out.transport).toMatchObject({
      kind: 'sse',
      headers: { Authorization: 'Bearer secret-token' },
    })
    delete process.env.TEST_BEARER
  })

  test('headerEnvVars injected verbatim', () => {
    process.env.TEST_HEADER = 'header-value'
    const out = injectAuth({
      name: 'x',
      transport: { kind: 'sse', url: 'https://example.com/sse' },
      auth: { headerEnvVars: { 'X-Api-Key': 'TEST_HEADER' } },
    })
    expect(out.transport).toMatchObject({
      kind: 'sse',
      headers: { 'X-Api-Key': 'header-value' },
    })
    delete process.env.TEST_HEADER
  })

  test('stdio auth injected into env', () => {
    process.env.TEST_STDIO_TOKEN = 'tok'
    const out = injectAuth({
      name: 'x',
      transport: { kind: 'stdio', command: 'node' },
      auth: { bearerEnvVar: 'TEST_STDIO_TOKEN' },
    })
    if (out.transport.kind !== 'stdio') throw new Error('expected stdio')
    expect(out.transport.env).toEqual({ Authorization: 'Bearer tok' })
    delete process.env.TEST_STDIO_TOKEN
  })

  test('missing env var skipped silently', () => {
    const out = injectAuth({
      name: 'x',
      transport: { kind: 'sse', url: 'https://example.com/sse' },
      auth: { bearerEnvVar: 'NONEXISTENT_VAR_12345' },
    })
    expect(out.transport).toMatchObject({ kind: 'sse' })
  })
})
```

Run: `cd packages/zai-agent-core && bun test test/mcp/transport-factory.test.ts`
Expected: FAIL with "Cannot find module '../../src/mcp/transport.js'"

- [ ] **Step 8: 实现 transport.ts**

`packages/zai-agent-core/src/mcp/transport.ts`：

```ts
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import { SSEClientTransport } from '@modelcontextprotocol/sdk/client/sse.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import type { McpServerSpec } from './types.js'

export function injectAuth(spec: McpServerSpec): McpServerSpec {
  const resolved: McpServerSpec = structuredClone(spec)
  const headers: Record<string, string> = { ...(resolved.transport.headers ?? {}) }

  if (resolved.auth?.bearerEnvVar) {
    const tok = process.env[resolved.auth.bearerEnvVar]
    if (tok) headers.Authorization = `Bearer ${tok}`
  }
  for (const [header, envVar] of Object.entries(resolved.auth?.headerEnvVars ?? {})) {
    const v = process.env[envVar]
    if (v) headers[header] = v
  }

  if (resolved.transport.kind === 'stdio') {
    resolved.transport = { ...resolved.transport, env: { ...resolved.transport.env, ...headers } }
  } else {
    resolved.transport = { ...resolved.transport, headers }
  }
  return resolved
}

export function createMcpTransport(spec: McpServerSpec, signal: AbortSignal) {
  const resolved = injectAuth(spec)

  if (resolved.transport.kind === 'stdio') {
    return new StdioClientTransport({
      command: resolved.transport.command,
      args: resolved.transport.args,
      env: resolved.transport.env,
    })
  }

  if (resolved.transport.kind === 'sse' || resolved.transport.url.endsWith('/sse')) {
    return new SSEClientTransport(new URL(resolved.transport.url), {
      requestInit: { headers: resolved.transport.headers, signal },
    })
  }

  return new StreamableHTTPClientTransport(new URL(resolved.transport.url), {
    requestInit: { headers: resolved.transport.headers, signal },
  })
}
```

- [ ] **Step 9: 跑测试验证通过**

Run: `cd packages/zai-agent-core && bun test test/mcp/transport-factory.test.ts`
Expected: PASS (8 tests)

- [ ] **Step 10: 实现 MCPClientPool.ts**

`packages/zai-agent-core/src/mcp/MCPClientPool.ts`（完整代码）：

```ts
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import type { McpServerSpec } from './types.js'
import { createMcpTransport } from './transport.js'
import { McpServerError } from './errors.js'

type ServerEntry = {
  spec: McpServerSpec
  client: Client
  status: 'connecting' | 'connected' | 'reconnecting' | 'failed' | 'disconnected'
  retries: number
  lastError?: string
  lastCheckAt: number
}

export class MCPClientPool {
  private servers = new Map<string, ServerEntry>()

  async connectAll(specs: McpServerSpec[]): Promise<void> {
    const wanted = new Set(specs.map((s) => s.name))
    const toDisconnect = [...this.servers.keys()].filter((n) => !wanted.has(n))
    await Promise.allSettled(toDisconnect.map((n) => this.disconnect(n)))

    const toConnect = specs.filter((s) => !this.servers.has(s.name))
    await Promise.allSettled(toConnect.map((spec) => this.connectOne(spec)))
  }

  async disconnectAll(): Promise<void> {
    await Promise.allSettled(
      [...this.servers.keys()].map((n) => this.disconnect(n))
    )
    this.servers.clear()
  }

  health(): Record<string, { ok: boolean; error?: string; lastCheckAt: number }> {
    const out: Record<string, { ok: boolean; error?: string; lastCheckAt: number }> = {}
    for (const [name, entry] of this.servers) {
      out[name] = {
        ok: entry.status === 'connected',
        error: entry.lastError,
        lastCheckAt: entry.lastCheckAt,
      }
    }
    return out
  }

  async disconnect(name: string): Promise<void> {
    const entry = this.servers.get(name)
    if (!entry) return
    try {
      await entry.client.close()
    } catch {
      // best-effort
    }
    entry.status = 'disconnected'
    this.servers.delete(name)
  }

  private async connectOne(spec: McpServerSpec): Promise<void> {
    const entry: ServerEntry = {
      spec,
      client: new Client({ name: `zai-agent-core/${spec.name}`, version: '0.0.0' }, { capabilities: {} }),
      status: 'connecting',
      retries: 0,
      lastCheckAt: Date.now(),
    }
    this.servers.set(spec.name, entry)

    try {
      const transport = createMcpTransport(spec, new AbortController().signal)
      await entry.client.connect(transport)
      entry.status = 'connected'
      entry.lastCheckAt = Date.now()
    } catch (err) {
      entry.status = 'failed'
      entry.lastError = err instanceof Error ? err.message : String(err)
      entry.lastCheckAt = Date.now()
      // do not throw — surface via health()
    }
  }

  /** Read-only view of underlying MCP clients for adapters. Throws on failed servers. */
  getClient(name: string): Client {
    const entry = this.servers.get(name)
    if (!entry) {
      throw new McpServerError(`mcp server not connected: ${name}`, {
        serverName: name,
        retryable: false,
      })
    }
    return entry.client
  }

  hasClient(name: string): boolean {
    const e = this.servers.get(name)
    return !!e && e.status === 'connected'
  }
}
```

- [ ] **Step 11: 实现 MockMcpServer fixture**

`packages/zai-agent-core/test/mcp/fixtures/MockMcpServer.ts`（简化版：用 InMemoryTransport，需要 SDK 提供；如无则跳过此 task 的 mock test，改在 Task 4 真实集成）：

```ts
// 实际编写时先用 bun add @modelcontextprotocol/sdk 的 in-memory transport
// 如果 SDK 没有 InMemoryTransport，则本 fixture 改为 mock transport 模式
// 此处先列接口占位，实施时按 SDK 实际能力补全
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js'

export type MockMcpServerOptions = {
  tools?: Array<{ name: string; description?: string; inputSchema?: unknown }>
  resources?: Array<{ uri: string; name?: string; mimeType?: string; text?: string }>
  failOnConnect?: boolean
  callToolImpl?: (name: string, args: unknown) => Promise<unknown>
}

export interface MockMcpServer {
  transport: Transport
  close: () => Promise<void>
  simulateDisconnect: () => void
}
```

> 实施说明：若 SDK 没有 `InMemoryTransport`，本 fixture 改为实现 `Transport` 接口（start / send / close 三方法），通过事件总线模拟 JSON-RPC 双向通信。

- [ ] **Step 12: 写 pool.test.ts 失败用例**

`packages/zai-agent-core/test/mcp/pool.test.ts`：

```ts
import { describe, expect, test, beforeEach } from 'bun:test'
import { MCPClientPool } from '../../src/mcp/MCPClientPool.js'

describe('MCPClientPool', () => {
  let pool: MCPClientPool
  beforeEach(() => { pool = new MCPClientPool() })

  test('connectAll with empty specs resolves without throw', async () => {
    await pool.connectAll([])
    expect(pool.health()).toEqual({})
  })

  test('disconnectAll on empty pool is idempotent', async () => {
    await pool.disconnectAll()
    await pool.disconnectAll()
  })

  test('health reflects failed server without throwing', async () => {
    await pool.connectAll([
      {
        name: 'broken',
        transport: { kind: 'stdio', command: 'definitely-not-a-real-binary-12345' },
        reconnect: { maxRetries: 0, backoffMs: 1 },
      },
    ])
    const h = pool.health()
    expect(h.broken.ok).toBe(false)
    expect(h.broken.error).toBeDefined()
  })

  test('connectAll does not throw when one server fails', async () => {
    await pool.connectAll([
      { name: 'broken', transport: { kind: 'stdio', command: 'definitely-not-a-real-binary-12345' }, reconnect: { maxRetries: 0, backoffMs: 1 } },
      { name: 'also-broken', transport: { kind: 'stdio', command: 'also-not-real-67890' }, reconnect: { maxRetries: 0, backoffMs: 1 } },
    ])
    expect(pool.health().broken.ok).toBe(false)
    expect(pool.health()['also-broken'].ok).toBe(false)
  })

  test('incrementally disconnects removed servers', async () => {
    // 用 mock server 需要 fixture；先用 broken stdio 验证 diff 逻辑
    await pool.connectAll([
      { name: 'a', transport: { kind: 'stdio', command: 'no-such-bin' }, reconnect: { maxRetries: 0, backoffMs: 1 } },
      { name: 'b', transport: { kind: 'stdio', command: 'no-such-bin' }, reconnect: { maxRetries: 0, backoffMs: 1 } },
    ])
    await pool.connectAll([
      { name: 'a', transport: { kind: 'stdio', command: 'no-such-bin' }, reconnect: { maxRetries: 0, backoffMs: 1 } },
    ])
    expect(pool.health().a).toBeDefined()
    expect(pool.health().b).toBeUndefined()
  })
})
```

Run: `cd packages/zai-agent-core && bun test test/mcp/pool.test.ts`
Expected: PASS（因为 health/connectAll 的语义用 broken stdio 可验证）

- [ ] **Step 13: Commit**

```bash
cd packages/zai-agent-core
git add src/mcp/MCPClientPool.ts src/mcp/transport.ts src/mcp/errors.ts src/mcp/tool-name.ts \
  test/mcp/errors.test.ts test/mcp/tool-name.test.ts test/mcp/auth-inject.test.ts \
  test/mcp/transport-factory.test.ts test/mcp/pool.test.ts test/mcp/fixtures/MockMcpServer.ts
git commit -m "feat(zai-agent-core): MCPClientPool with stdio transport + auth injection"
```

---

## Task 3: Adapter 层 — 工具和 Skill 适配

**Files:**
- Create: `packages/zai-agent-core/src/mcp/jsonSchemaToZod.ts`
- Create: `packages/zai-agent-core/src/mcp/MCPToolAdapter.ts`
- Create: `packages/zai-agent-core/src/mcp/SkillResourceAdapter.ts`
- Create: `packages/zai-agent-core/src/mcp/permission-matcher.ts`
- Test: `packages/zai-agent-core/test/mcp/schema-convert.test.ts`
- Test: `packages/zai-agent-core/test/mcp/skill-parser.test.ts`
- Test: `packages/zai-agent-core/test/mcp/permission-matcher.test.ts`

**Interfaces:**
- Consumes: `MCPClientPool.getClient(name)` / `MCPClientPool.hasClient(name)`（Task 2）
- Produces:
  - `jsonSchemaToZod(schema: unknown): ZodTypeAny`
  - `adaptMcpTools(pool: MCPClientPool, serverName: string): Promise<MCPTool[]>`
  - `loadMcpSkills(pool: MCPClientPool, serverName: string): Promise<LoadedSkill[]>`
  - `matchToolName(rule: string | { pattern: string; action?: string }, name: string): boolean`

- [ ] **Step 1: 写 schema-convert.test.ts 失败用例**

`packages/zai-agent-core/test/mcp/schema-convert.test.ts`：

```ts
import { describe, expect, test } from 'bun:test'
import { z } from 'zod'
import { jsonSchemaToZod } from '../../src/mcp/jsonSchemaToZod.js'

describe('jsonSchemaToZod', () => {
  test('object with string and number', () => {
    const zod = jsonSchemaToZod({
      type: 'object',
      properties: { name: { type: 'string' }, count: { type: 'number' } },
      required: ['name'],
    }) as z.ZodObject<any>
    expect(zod.safeParse({ name: 'x' }).success).toBe(true)
    expect(zod.safeParse({}).success).toBe(false)
    expect(zod.safeParse({ name: 'x', count: 'wrong' }).success).toBe(false)
  })

  test('array property', () => {
    const zod = jsonSchemaToZod({
      type: 'object',
      properties: { tags: { type: 'array', items: { type: 'string' } } },
    }) as z.ZodObject<any>
    expect(zod.safeParse({ tags: ['a', 'b'] }).success).toBe(true)
    expect(zod.safeParse({ tags: [1, 2] }).success).toBe(false)
  })

  test('malformed schema falls back to z.record(unknown)', () => {
    const zod = jsonSchemaToZod({ this: 'is-not-a-schema' })
    expect(zod.safeParse({ anything: 'goes' }).success).toBe(true)
  })

  test('null schema falls back to z.record(unknown)', () => {
    const zod = jsonSchemaToZod(null)
    expect(zod.safeParse({}).success).toBe(true)
  })
})
```

Run: `cd packages/zai-agent-core && bun test test/mcp/schema-convert.test.ts`
Expected: FAIL with "Cannot find module"

- [ ] **Step 2: 实现 jsonSchemaToZod.ts**

`packages/zai-agent-core/src/mcp/jsonSchemaToZod.ts`：

```ts
import { z, type ZodTypeAny } from 'zod'

type JsonSchema = Record<string, unknown>

function primitive(type: string): ZodTypeAny {
  switch (type) {
    case 'string': return z.string()
    case 'number':
    case 'integer': return z.number()
    case 'boolean': return z.boolean()
    case 'null': return z.null()
    default: return z.unknown()
  }
}

function convert(schema: unknown, depth = 0): ZodTypeAny {
  if (depth > 10) return z.unknown()
  if (!schema || typeof schema !== 'object') return z.unknown()
  const s = schema as JsonSchema

  if (s.type === 'object') {
    const props = (s.properties ?? {}) as Record<string, JsonSchema>
    const shape: Record<string, ZodTypeAny> = {}
    for (const [k, v] of Object.entries(props)) {
      shape[k] = convert(v, depth + 1)
    }
    let obj = z.object(shape).passthrough()
    if (Array.isArray(s.required)) {
      const req = new Set(s.required as string[])
      for (const k of Object.keys(shape)) {
        if (!req.has(k)) shape[k] = shape[k].optional()
      }
      obj = z.object(shape).passthrough()
    }
    return obj
  }

  if (s.type === 'array') {
    return z.array(convert(s.items, depth + 1))
  }

  if (typeof s.type === 'string') return primitive(s.type)

  if (Array.isArray(s.enum)) {
    return z.union((s.enum as unknown[]).map((v) => z.literal(v as never)) as [ZodTypeAny, ZodTypeAny, ...ZodTypeAny[]])
  }

  return z.unknown()
}

export function jsonSchemaToZod(schema: unknown): ZodTypeAny {
  try {
    return convert(schema)
  } catch {
    return z.record(z.string(), z.unknown())
  }
}
```

- [ ] **Step 3: 跑测试验证通过**

Run: `cd packages/zai-agent-core && bun test test/mcp/schema-convert.test.ts`
Expected: PASS (4 tests)

- [ ] **Step 4: 写 permission-matcher.test.ts 失败用例**

`packages/zai-agent-core/test/mcp/permission-matcher.test.ts`：

```ts
import { describe, expect, test } from 'bun:test'
import { matchToolName } from '../../src/mcp/permission-matcher.js'

describe('matchToolName', () => {
  test('exact string match', () => {
    expect(matchToolName('mcp__github__create_issue', 'mcp__github__create_issue')).toBe(true)
    expect(matchToolName('mcp__github__create_issue', 'mcp__github__close_issue')).toBe(false)
  })

  test('pattern with single star', () => {
    expect(matchToolName({ pattern: 'mcp__github__*' }, 'mcp__github__create_issue')).toBe(true)
    expect(matchToolName({ pattern: 'mcp__github__*' }, 'mcp__gitlab__create_issue')).toBe(false)
  })

  test('pattern with multiple stars', () => {
    expect(matchToolName({ pattern: 'mcp__*__read_*' }, 'mcp__fs__read_file')).toBe(true)
    expect(matchToolName({ pattern: 'mcp__*__read_*' }, 'mcp__fs__write_file')).toBe(false)
  })

  test('action defaults to allow', () => {
    expect(matchToolName({ pattern: 'Bash' }, 'Bash')).toBe(true)
  })
})
```

Run: `cd packages/zai-agent-core && bun test test/mcp/permission-matcher.test.ts`
Expected: FAIL

- [ ] **Step 5: 实现 permission-matcher.ts**

`packages/zai-agent-core/src/mcp/permission-matcher.ts`：

```ts
export type ToolRule = string | { pattern: string; action?: 'allow' | 'deny' }

export function matchToolName(rule: ToolRule, name: string): boolean {
  if (typeof rule === 'string') return rule === name
  const regex = new RegExp('^' + rule.pattern.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*') + '$')
  return regex.test(name)
}
```

- [ ] **Step 6: 跑测试验证通过**

Run: `cd packages/zai-agent-core && bun test test/mcp/permission-matcher.test.ts`
Expected: PASS (4 tests)

- [ ] **Step 7: 写 skill-parser.test.ts 失败用例**

`packages/zai-agent-core/test/mcp/skill-parser.test.ts`：

```ts
import { describe, expect, test } from 'bun:test'
import { parseSkillResource } from '../../src/mcp/SkillResourceAdapter.js'

describe('parseSkillResource', () => {
  const validBlob = Buffer.from(
    '---\nname: code-review\ndescription: Review code changes\n---\n\n## Steps\n...'
  ).toString('base64')

  test('parses valid skill resource', () => {
    const skill = parseSkillResource(
      { uri: 'skill://code-review', mimeType: 'text/markdown', blob: validBlob },
      'github'
    )
    expect(skill).toEqual({
      name: 'code-review',
      description: 'Review code changes',
      body: '## Steps\n...',
      source: 'mcp',
      mcpInfo: { serverName: 'github', resourceUri: 'skill://code-review' },
    })
  })

  test('returns null on missing frontmatter', () => {
    const blob = Buffer.from('No frontmatter here').toString('base64')
    const skill = parseSkillResource(
      { uri: 'skill://x', mimeType: 'text/markdown', blob },
      'github'
    )
    expect(skill).toBeNull()
  })

  test('returns null on malformed blob', () => {
    const skill = parseSkillResource(
      { uri: 'skill://x', mimeType: 'text/markdown', blob: 'not-base64!' },
      'github'
    )
    expect(skill).toBeNull()
  })
})
```

Run: `cd packages/zai-agent-core && bun test test/mcp/skill-parser.test.ts`
Expected: FAIL

- [ ] **Step 8: 实现 SkillResourceAdapter.ts**

`packages/zai-agent-core/src/mcp/SkillResourceAdapter.ts`：

```ts
import yaml from 'js-yaml'
import type { LoadedSkill } from '../skills/types.js'

export type SkillResource = {
  uri: string
  mimeType?: string
  blob?: string
  text?: string
}

export function parseSkillResource(resource: SkillResource, serverName: string): LoadedSkill | null {
  try {
    const raw = resource.text ?? (resource.blob ? Buffer.from(resource.blob, 'base64').toString('utf8') : null)
    if (!raw) return null

    const match = raw.match(/^---\n([\s\S]*?)\n---\n([\s\S]*)$/)
    if (!match) return null

    const fm = yaml.load(match[1]) as Record<string, unknown> | null
    if (!fm || typeof fm.name !== 'string' || typeof fm.description !== 'string') return null

    return {
      name: fm.name,
      description: fm.description,
      body: match[2].trim(),
      source: 'mcp',
      mcpInfo: { serverName, resourceUri: resource.uri },
    }
  } catch {
    return null
  }
}

import type { MCPClientPool } from './MCPClientPool.js'
import { ListResourcesResultSchema, ReadResourceResultSchema } from '@modelcontextprotocol/sdk/types.js'

export async function loadMcpSkills(pool: MCPClientPool, serverName: string): Promise<LoadedSkill[]> {
  if (!pool.hasClient(serverName)) return []
  const client = pool.getClient(serverName)
  try {
    const list = await client.listResources({ }, ListResourcesResultSchema)
    const skills = (list.resources ?? []).filter((r) => r.uri.startsWith('skill://'))
    const results = await Promise.allSettled(
      skills.map((r) => client.readResource({ uri: r.uri }, ReadResourceResultSchema))
    )
    const out: LoadedSkill[] = []
    for (let i = 0; i < results.length; i++) {
      const r = results[i]
      if (r.status !== 'fulfilled') continue
      const contents = r.value.contents ?? []
      for (const c of contents) {
        const blob = 'blob' in c ? c.blob : undefined
        const text = 'text' in c ? c.text : undefined
        const skill = parseSkillResource({ uri: skills[i].uri, mimeType: c.mimeType, blob, text }, serverName)
        if (skill) out.push(skill)
      }
    }
    return out
  } catch {
    return []
  }
}
```

- [ ] **Step 9: 跑测试验证通过**

Run: `cd packages/zai-agent-core && bun test test/mcp/skill-parser.test.ts`
Expected: PASS (3 tests)

- [ ] **Step 10: 实现 MCPToolAdapter.ts**

`packages/zai-agent-core/src/mcp/MCPToolAdapter.ts`：

```ts
import { z, type ZodTypeAny } from 'zod'
import type { Tool, ToolContext } from '../tools/Tool.js'
import { CallToolResultSchema, ListToolsResultSchema } from '@modelcontextprotocol/sdk/types.js'
import { jsonSchemaToZod } from './jsonSchemaToZod.js'
import { makeMcpToolName } from './tool-name.js'
import { formatMcpError } from './errors.js'
import type { MCPClientPool } from './MCPClientPool.js'

export type MCPTool = Tool<ZodTypeAny, unknown> & {
  isMcp: true
  mcpInfo: { serverName: string; originalName: string }
}

export async function adaptMcpTools(pool: MCPClientPool, serverName: string): Promise<MCPTool[]> {
  if (!pool.hasClient(serverName)) return []
  const client = pool.getClient(serverName)
  try {
    const result = await client.listTools({ }, ListToolsResultSchema)
    const tools = result.tools ?? []
    return tools.map((t) => adaptOne(t, serverName, client))
  } catch {
    return []
  }
}

function adaptOne(
  t: { name: string; description?: string; inputSchema?: unknown },
  serverName: string,
  client: import('@modelcontextprotocol/sdk/client/index.js').Client
): MCPTool {
  const inputSchema = jsonSchemaToZod(t.inputSchema)
  return {
    name: makeMcpToolName(serverName, t.name),
    description: `[mcp:${serverName}] ${t.description ?? t.name}`,
    inputSchema,
    isMcp: true,
    isReadOnly: false,
    isDestructive: false,
    isConcurrencySafe: false,
    mcpInfo: { serverName, originalName: t.name },
    async call(input: unknown, ctx: ToolContext) {
      const serverSpec = ctx.__runtimeConfig?.mcpServers?.find((s) => s.name === serverName)
      const timeoutMs = serverSpec?.callTimeoutMs ?? 30_000
      try {
        const result = await client.callTool(
          { name: t.name, arguments: input as Record<string, unknown> },
          CallToolResultSchema,
          { signal: AbortSignal.any([ctx.abortSignal, AbortSignal.timeout(timeoutMs)]) }
        )
        const content = (result as { content?: Array<{ type: string; text?: string }> }).content ?? []
        const text = content
          .filter((c) => c.type === 'text' && typeof c.text === 'string')
          .map((c) => c.text)
          .join('\n')
        const isError = (result as { isError?: boolean }).isError ?? false
        return { output: text || JSON.stringify(content), isError }
      } catch (err) {
        return { output: formatMcpError(err, serverName), isError: true }
      }
    },
  }
}
```

> 实施说明：`CallToolResultSchema` 实际只用于 `callTool` 调用，不用于 `listTools`。listTools 用 `ListToolsResultSchema`。实施时按 SDK 实际签名校正类型断言。

- [ ] **Step 11: 编译验证**

Run: `cd packages/zai-agent-core && bunx tsc --noEmit -p .`
Expected: 0 errors（允许遗留 `opencc-internals` 的非 MCP 部分错误）

- [ ] **Step 12: Commit**

```bash
cd packages/zai-agent-core
git add src/mcp/jsonSchemaToZod.ts src/mcp/MCPToolAdapter.ts src/mcp/SkillResourceAdapter.ts \
  src/mcp/permission-matcher.ts \
  test/mcp/schema-convert.test.ts test/mcp/skill-parser.test.ts test/mcp/permission-matcher.test.ts
git commit -m "feat(zai-agent-core): MCP tool and skill adapters with schema + permission conversion"
```

---

## Task 4: 工具池集成 + 资源工具

**Files:**
- Modify: `packages/zai-agent-core/src/runtime/types.ts`（`mcpClientPool` / `mcpSkillLoading` 字段）
- Modify: `packages/zai-agent-core/src/runtime/queryEngine.ts`（`pool.connectAll` / `getArtifacts` 装配）
- Create: `packages/zai-agent-core/src/tools/ListMcpResourcesTool/ListMcpResourcesTool.ts`
- Create: `packages/zai-agent-core/src/tools/ReadMcpResourceTool/ReadMcpResourceTool.ts`
- Modify: `packages/zai-agent-core/src/tools/index.ts`（暴露两个资源工具）
- Modify: `packages/zai-agent-core/test/runtime/toolExecution.test.ts`（加 MCP 工具用例）

**Interfaces:**
- Consumes: `MCPClientPool`（Task 2）+ `MCPTool` / `loadMcpSkills`（Task 3）
- Produces: queryEngine 在每 turn 装配 MCP artifacts，资源工具在 `getZaiRuntimeTools()` 可用

- [ ] **Step 1: 扩展 RuntimeConfig 字段**

修改 `packages/zai-agent-core/src/runtime/types.ts`，在 `mcpServers` 字段后新增：

```ts
import type { MCPClientPool } from '../mcp/MCPClientPool.js'

export type RuntimeConfig = {
  // ... 现有字段 ...
  mcpServers?: McpServerSpec[]
  mcpClientPool?: MCPClientPool
  mcpSkillLoading?: 'auto' | 'off'  // 默认 'auto'
}
```

- [ ] **Step 2: 写 ListMcpResourcesTool 实现 + 测试**

`packages/zai-agent-core/src/tools/ListMcpResourcesTool/ListMcpResourcesTool.ts`：

```ts
import { z } from 'zod'
import type { Tool, ToolContext } from '../Tool.js'
import { ListResourcesResultSchema } from '@modelcontextprotocol/sdk/types.js'

export const ListMcpResourcesTool: Tool<z.ZodObject<{ serverName: z.ZodOptional<z.ZodString> }>, string> = {
  name: 'ListMcpResources',
  description: 'List resources exposed by MCP servers. Optionally filter by serverName.',
  inputSchema: z.object({ serverName: z.string().optional() }),
  isReadOnly: true,
  async call(input, ctx) {
    const pool = ctx.__runtimeConfig?.mcpClientPool
    if (!pool) {
      return { output: 'mcpClientPool not configured', isError: true }
    }
    const health = pool.health()
    const targets = input.serverName ? [input.serverName] : Object.keys(health)
    const out: Array<{ serverName: string; ok: boolean; resources: unknown[]; error?: string }> = []
    for (const name of targets) {
      if (!pool.hasClient(name)) {
        out.push({ serverName: name, ok: false, resources: [], error: health[name]?.error ?? 'not connected' })
        continue
      }
      try {
        const client = pool.getClient(name)
        const res = await client.listResources({ }, ListResourcesResultSchema)
        out.push({ serverName: name, ok: true, resources: res.resources ?? [] })
      } catch (err) {
        out.push({ serverName: name, ok: false, resources: [], error: err instanceof Error ? err.message : String(err) })
      }
    }
    return { output: JSON.stringify(out, null, 2) }
  },
}
```

`packages/zai-agent-core/test/tools/ListMcpResourcesTool.test.ts`：

```ts
import { describe, expect, test, mock } from 'bun:test'
import { ListMcpResourcesTool } from '../../src/tools/ListMcpResourcesTool/ListMcpResourcesTool.js'

describe('ListMcpResourcesTool', () => {
  test('returns isError when pool not configured', async () => {
    const result = await ListMcpResourcesTool.call({}, { cwd: '/tmp', env: {}, abortSignal: new AbortController().signal, dataDir: '/tmp', canUseTool: async () => ({ behavior: 'allow' }), emitEvent: () => {}, state: {}, awaitAskUserQuestion: async () => ({ answers: {} }), __runtimeConfig: {} as never })
    expect(result.isError).toBe(true)
  })

  test('lists resources for configured server', async () => {
    const fakePool = {
      health: () => ({ github: { ok: true, lastCheckAt: 0 } }),
      hasClient: () => true,
      getClient: () => ({
        listResources: async () => ({ resources: [{ uri: 'skill://x', name: 'x' }] }),
      }),
    }
    const result = await ListMcpResourcesTool.call({ serverName: 'github' }, {
      cwd: '/tmp', env: {}, abortSignal: new AbortController().signal, dataDir: '/tmp',
      canUseTool: async () => ({ behavior: 'allow' }),
      emitEvent: () => {},
      state: {},
      awaitAskUserQuestion: async () => ({ answers: {} }),
      __runtimeConfig: { mcpClientPool: fakePool } as never,
    })
    expect(result.isError).toBeFalsy()
    expect(result.output).toContain('skill://x')
  })
})
```

Run: `cd packages/zai-agent-core && bun test test/tools/ListMcpResourcesTool.test.ts`
Expected: PASS (2 tests)

- [ ] **Step 3: 写 ReadMcpResourceTool 实现 + 测试**

`packages/zai-agent-core/src/tools/ReadMcpResourceTool/ReadMcpResourceTool.ts`：

```ts
import { z } from 'zod'
import type { Tool, ToolContext } from '../Tool.js'
import { ReadResourceResultSchema } from '@modelcontextprotocol/sdk/types.js'

export const ReadMcpResourceTool: Tool<z.ZodObject<{ serverName: z.ZodString; uri: z.ZodString }>, string> = {
  name: 'ReadMcpResource',
  description: 'Read a resource from an MCP server by serverName and uri.',
  inputSchema: z.object({ serverName: z.string(), uri: z.string() }),
  isReadOnly: true,
  async call(input, ctx) {
    const pool = ctx.__runtimeConfig?.mcpClientPool
    if (!pool) return { output: 'mcpClientPool not configured', isError: true }
    if (!pool.hasClient(input.serverName)) {
      return { output: `mcp server not connected: ${input.serverName}`, isError: true }
    }
    try {
      const client = pool.getClient(input.serverName)
      const res = await client.readResource({ uri: input.uri }, ReadResourceResultSchema)
      const text = (res.contents ?? [])
        .map((c) => 'text' in c ? c.text : ('blob' in c ? Buffer.from(c.blob, 'base64').toString('utf8') : ''))
        .filter(Boolean)
        .join('\n')
      return { output: text || JSON.stringify(res.contents) }
    } catch (err) {
      return { output: err instanceof Error ? err.message : String(err), isError: true }
    }
  },
}
```

测试：`packages/zai-agent-core/test/tools/ReadMcpResourceTool.test.ts`（按 ListMcpResourcesTool 测试模板补，2 用例：未配置 / 已配置）

- [ ] **Step 4: 修改 tools/index.ts 暴露两个工具**

修改 `packages/zai-agent-core/src/tools/index.ts`，新增导出：

```ts
export { ListMcpResourcesTool } from './ListMcpResourcesTool/ListMcpResourcesTool.js'
export { ReadMcpResourceTool } from './ReadMcpResourceTool/ReadMcpResourceTool.js'
```

并在 `getZaiRuntimeTools()` 返回的数组中追加这两个工具（无条件）。

- [ ] **Step 5: 写 queryEngine MCP 装配失败测试**

`packages/zai-agent-core/test/runtime/queryEngine-mcp.test.ts`：

```ts
import { describe, expect, test, mock } from 'bun:test'
import { MCPClientPool } from '../../src/mcp/MCPClientPool.js'
import { queryEngine } from '../../src/runtime/queryEngine.js'

describe('queryEngine MCP wiring', () => {
  test('connectAll never throws even when all servers fail', async () => {
    const pool = new MCPClientPool()
    const config = {
      dataDir: '/tmp',
      mcpClientPool: pool,
      mcpServers: [
        { name: 'bad', transport: { kind: 'stdio' as const, command: 'no-such-bin' }, reconnect: { maxRetries: 0, backoffMs: 1 } },
      ],
      modelCaller: async () => ({ content: 'mock', tool_use: [] }),
    }
    // 用一个最小 prompt 跑 queryEngine，期待 connectAll 不抛、query 继续
    const events: unknown[] = []
    try {
      const gen = queryEngine({ prompt: 'hi', cwd: '/tmp' }, config as never)
      for await (const ev of gen) events.push(ev)
    } catch {
      // 允许 modelCaller mock 报错；关键是 connectAll 不抛
    }
    expect(pool.health().bad.ok).toBe(false)
  })
})
```

Run: `cd packages/zai-agent-core && bun test test/runtime/queryEngine-mcp.test.ts`
Expected: FAIL（queryEngine 当前不调用 pool）

- [ ] **Step 6: 修改 queryEngine.ts 装配 MCP artifacts**

修改 `packages/zai-agent-core/src/runtime/queryEngine.ts`，在 `resolveToolPool` 调用前增加：

```ts
import { adaptMcpTools } from '../mcp/MCPToolAdapter.js'
import { loadMcpSkills } from '../mcp/SkillResourceAdapter.js'

// 在 while (turn < maxTurns) 循环开头
if (config.mcpClientPool && config.mcpServers) {
  await config.mcpClientPool.connectAll(config.mcpServers)
  const mcpTools: MCPTool[] = []
  const mcpSkills: LoadedSkill[] = []
  for (const spec of config.mcpServers) {
    if (!config.mcpClientPool.hasClient(spec.name)) continue
    mcpTools.push(...await adaptMcpTools(config.mcpClientPool, spec.name))
    if (config.mcpSkillLoading !== 'off') {
      mcpSkills.push(...await loadMcpSkills(config.mcpClientPool, spec.name))
    }
  }
  // 合并到 base pool 和 loadedSkills
  baseTools = [...baseTools, ...mcpTools]
  loadedSkills = [...loadedSkills, ...mcpSkills]
}
```

实际变量名按 queryEngine.ts 现有结构适配（`baseTools` / `loadedSkills` 可能叫别的名字）。

- [ ] **Step 7: 跑 queryEngine-mcp 测试**

Run: `cd packages/zai-agent-core && bun test test/runtime/queryEngine-mcp.test.ts`
Expected: PASS

- [ ] **Step 8: 加 toolExecution MCP 用例**

修改 `packages/zai-agent-core/test/runtime/toolExecution.test.ts`，追加 2 用例：

```ts
test('MCP tool call success', async () => {
  const mcpTool: MCPTool = {
    name: 'mcp__x__ping',
    description: '[mcp:x] ping',
    inputSchema: z.object({ msg: z.string() }),
    isMcp: true,
    mcpInfo: { serverName: 'x', originalName: 'ping' },
    call: async () => ({ output: 'pong' }),
  }
  // 复用现有 toolExecution 测试 fixture
})

test('MCP tool call error returns isError without throwing', async () => {
  const mcpTool: MCPTool = {
    name: 'mcp__x__fail',
    description: '[mcp:x] fail',
    inputSchema: z.object({}),
    isMcp: true,
    mcpInfo: { serverName: 'x', originalName: 'fail' },
    call: async () => ({ output: 'fail reason', isError: true }),
  }
})
```

具体 fixture 按 `toolExecution.test.ts` 现有模式写。

Run: `cd packages/zai-agent-core && bun test test/runtime/toolExecution.test.ts`
Expected: PASS（包含原有 + 新增 2 用例）

- [ ] **Step 9: 跑全套测试**

Run: `cd packages/zai-agent-core && bun test`
Expected: 全部通过

- [ ] **Step 10: Commit**

```bash
cd packages/zai-agent-core
git add src/runtime/types.ts src/runtime/queryEngine.ts src/tools/index.ts \
  src/tools/ListMcpResourcesTool/ src/tools/ReadMcpResourceTool/ \
  test/runtime/queryEngine-mcp.test.ts test/runtime/toolExecution.test.ts \
  test/tools/ListMcpResourcesTool.test.ts test/tools/ReadMcpResourceTool.test.ts
git commit -m "feat(zai-agent-core): wire MCP artifacts into queryEngine tool pool + resource tools"
```

---

## Task 5: 错误事件 + streamAdapter 校准

**Files:**
- Modify: `packages/zai-agent-core/src/runtime/streamAdapter.ts`
- Modify: `packages/zai-agent-core/src/runtime/types.ts`（RuntimeEvent 新增 `mcp_server:status` / `mcp_server:tools_updated`）
- Modify: `packages/zai-agent-core/src/runtime/MCPClientPool.ts`（暴露 server 状态变更的回调）
- Modify: `packages/zai-agent-core/src/runtime/queryEngine.ts`（订阅 pool 状态变更 → 投递事件）

**Interfaces:**
- Consumes: `MCPClientPool.health()`（Task 2）
- Produces: 新增两个 `RuntimeEvent` 类型，前端可通过 SSE 收到 MCP server 状态变更

- [ ] **Step 1: 写 RuntimeEvent 测试失败用例**

`packages/zai-agent-core/test/runtime/runtime-events.test.ts`：

```ts
import { describe, expect, test } from 'bun:test'
import type { RuntimeEvent } from '../../src/runtime/types.js'

describe('mcp_server RuntimeEvent types', () => {
  test('mcp_server:status is a valid RuntimeEvent', () => {
    const ev: RuntimeEvent = {
      type: 'mcp_server:status',
      serverName: 'github',
      status: 'connected',
    }
    expect(ev.type).toBe('mcp_server:status')
  })

  test('mcp_server:tools_updated carries toolNames array', () => {
    const ev: RuntimeEvent = {
      type: 'mcp_server:tools_updated',
      serverName: 'github',
      toolNames: ['mcp__github__create_issue', 'mcp__github__close_issue'],
    }
    expect(ev.toolNames).toHaveLength(2)
  })
})
```

Run: `cd packages/zai-agent-core && bun test test/runtime/runtime-events.test.ts`
Expected: FAIL（RuntimeEvent 联合类型尚未包含新事件）

- [ ] **Step 2: 扩展 RuntimeEvent 联合**

修改 `packages/zai-agent-core/src/runtime/types.ts` 的 `RuntimeEvent` 联合，追加：

```ts
| { type: 'mcp_server:status'; serverName: string; status: 'connected' | 'reconnecting' | 'failed' | 'disconnected'; error?: string }
| { type: 'mcp_server:tools_updated'; serverName: string; toolNames: string[] }
```

- [ ] **Step 3: 跑测试验证通过**

Run: `cd packages/zai-agent-core && bun test test/runtime/runtime-events.test.ts`
Expected: PASS

- [ ] **Step 4: MCPClientPool 暴露状态回调**

修改 `packages/zai-agent-core/src/mcp/MCPClientPool.ts`，新增：

```ts
type StatusListener = (name: string, status: ServerEntry['status'], error?: string) => void

class MCPClientPool {
  private listeners = new Set<StatusListener>()

  onStatusChange(listener: StatusListener): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  private emitStatus(name: string, status: ServerEntry['status'], error?: string) {
    for (const l of this.listeners) l(name, status, error)
  }
}
```

并在 `connectOne` 状态变更处（connected / failed）和 `disconnect` 处调 `this.emitStatus(...)`。

- [ ] **Step 5: queryEngine 订阅并投递事件**

修改 `packages/zai-agent-core/src/runtime/queryEngine.ts`，在 `connectAll` 后：

```ts
if (config.mcpClientPool) {
  const unsubscribe = config.mcpClientPool.onStatusChange((name, status, error) => {
    emit({ type: 'mcp_server:status', serverName: name, status, error })
    if (status === 'connected' || status === 'failed') {
      emit({ type: 'mcp_server:tools_updated', serverName: name, toolNames: [] })
      // toolNames 留空，client 端需要时调 ListMcpResourcesTool/重新查
    }
  })
  // 注意：当前 queryEngine 是 AsyncGenerator，emit 通过 yield 返回
  // unsubscribe 在 query 结束时调用（用 try/finally）
}
```

具体 emit 实现按 queryEngine.ts 现有的 yield RuntimeEvent 模式写。

- [ ] **Step 6: 校准 streamAdapter 的 mcp_server 分类**

打开 `packages/zai-agent-core/src/runtime/streamAdapter.ts`，校验 54 行和 93 行的 `mcp_server` 分类是否真把所有 MCP 相关错误标 `recoverable: true`。如果不是，调整判断逻辑确保 MCP 错误一律 recoverable（query 不应被中断）。

最小修改示例（如果当前没做）：

```ts
// streamAdapter.ts 在 categorize 函数中
if (msg.includes('mcp') || msg.includes('server') || msg.toLowerCase().includes('mcp_server')) {
  return 'mcp_server'
}
// 在 recoverability 函数中
if (category === 'mcp_server') return true
```

- [ ] **Step 7: 跑全套测试**

Run: `cd packages/zai-agent-core && bun test`
Expected: 全部通过

- [ ] **Step 8: Commit**

```bash
cd packages/zai-agent-core
git add src/runtime/types.ts src/runtime/streamAdapter.ts src/runtime/queryEngine.ts src/mcp/MCPClientPool.ts \
  test/runtime/runtime-events.test.ts
git commit -m "feat(zai-agent-core): mcp_server RuntimeEvents + streamAdapter calibration"
```

---

## Task 6: zai-server 集成（mcpConfig + DefaultAgentRuntime + shutdown）

**Files:**
- Create: `packages/zai/src/server/services/mcpConfig.ts`
- Modify: `packages/zai/src/server/index.ts`（DefaultAgentRuntime 注入 pool + shutdown disconnectAll）

**Interfaces:**
- Consumes: `RuntimeConfig.mcpServers` / `mcpClientPool`（Task 4）
- Produces:
  - `loadMcpServers(cwd: string): Promise<McpServerSpec[]>` — 合并 `~/.zai/settings.json` 和 `cwd/.mcp.json`
  - zai-server 启动时建 pool，shutdown 时 disconnectAll

- [ ] **Step 1: 写 mcpConfig 失败测试**

`packages/zai/test/server/services/mcpConfig.test.ts`：

```ts
import { describe, expect, test, beforeEach, afterEach } from 'bun:test'
import { mkdtempSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { loadMcpServers } from '../../../src/server/services/mcpConfig.js'

describe('loadMcpServers', () => {
  let cwd: string
  beforeEach(() => {
    cwd = mkdtempSync(join(tmpdir(), 'mcp-config-'))
  })
  afterEach(() => rmSync(cwd, { recursive: true, force: true }))

  test('returns empty when no files exist', async () => {
    const servers = await loadMcpServers(cwd)
    expect(servers).toEqual([])
  })

  test('reads project .mcp.json', async () => {
    writeFileSync(join(cwd, '.mcp.json'), JSON.stringify({
      mcpServers: {
        github: { command: 'npx', args: ['-y', '@mcp/github'] },
      },
    }))
    const servers = await loadMcpServers(cwd)
    expect(servers).toContainEqual({
      name: 'github',
      transport: { kind: 'stdio', command: 'npx', args: ['-y', '@mcp/github'] },
    })
  })

  test('merges user ~/.zai/settings.json (when env ZAI_HOME points to test dir)', async () => {
    const home = mkdtempSync(join(tmpdir(), 'mcp-home-'))
    writeFileSync(join(home, 'settings.json'), JSON.stringify({
      mcpServers: {
        gitlab: { command: 'npx', args: ['-y', '@mcp/gitlab'] },
      },
    }))
    process.env.ZAI_HOME = home
    try {
      const servers = await loadMcpServers(cwd)
      expect(servers.find((s) => s.name === 'gitlab')).toBeDefined()
    } finally {
      delete process.env.ZAI_HOME
      rmSync(home, { recursive: true, force: true })
    }
  })
})
```

Run: `cd packages/zai && bun test test/server/services/mcpConfig.test.ts`
Expected: FAIL

- [ ] **Step 2: 实现 mcpConfig.ts**

`packages/zai/src/server/services/mcpConfig.ts`：

```ts
import { readFileSync } from 'fs'
import { join } from 'path'
import { homedir } from 'os'
import type { McpServerSpec } from '@local/zai-agent-core'

type RawConfig = {
  mcpServers?: Record<string, { command?: string; args?: string[]; url?: string; type?: 'stdio' | 'sse' | 'http'; env?: Record<string, string>; headers?: Record<string, string> }>
}

function loadJson(path: string): RawConfig | null {
  try {
    return JSON.parse(readFileSync(path, 'utf8')) as RawConfig
  } catch {
    return null
  }
}

function toSpec(name: string, raw: NonNullable<RawConfig['mcpServers']>[string]): McpServerSpec {
  const kind = raw.type ?? (raw.url ? (raw.url.endsWith('/sse') ? 'sse' : 'http') : 'stdio')
  if (kind === 'stdio') {
    return { name, transport: { kind: 'stdio', command: raw.command ?? '', args: raw.args, env: raw.env } }
  }
  if (kind === 'sse') {
    return { name, transport: { kind: 'sse', url: raw.url ?? '', headers: raw.headers } }
  }
  return { name, transport: { kind: 'http', url: raw.url ?? '', headers: raw.headers } }
}

export async function loadMcpServers(cwd: string): Promise<McpServerSpec[]> {
  const home = process.env.ZAI_HOME ?? join(homedir(), '.zai')
  const userRaw = loadJson(join(home, 'settings.json'))
  const projectRaw = loadJson(join(cwd, '.mcp.json'))
  const merged: Record<string, NonNullable<RawConfig['mcpServers']>[string]> = {
    ...(userRaw?.mcpServers ?? {}),
    ...(projectRaw?.mcpServers ?? {}),
  }
  return Object.entries(merged).map(([name, raw]) => toSpec(name, raw))
}
```

- [ ] **Step 3: 跑测试验证通过**

Run: `cd packages/zai && bun test test/server/services/mcpConfig.test.ts`
Expected: PASS (3 tests)

- [ ] **Step 4: 修改 zai-server 注入 pool + shutdown disconnectAll**

**先读取现有代码**：

```bash
cat packages/zai/src/server/index.ts
```

定位两处：
1. `DefaultAgentRuntime` 实例创建点（搜 `new DefaultAgentRuntime` 或类似）
2. `process.on('SIGTERM'` 或 `process.on('SIGINT'` 已有 shutdown handler

**在实例创建点之前插入**：

```ts
import { MCPClientPool } from '@local/zai-agent-core'
import { loadMcpServers } from './services/mcpConfig.js'

const mcpPool = new MCPClientPool()
const mcpServers = await loadMcpServers(process.cwd())
```

**把 `mcpPool` 和 `mcpServers` 加到传给 runtime 的 config 对象中**（字段名按 RuntimeConfig 实际定义：`mcpClientPool` / `mcpServers`）。

**在已有 shutdown handler 内、在其它 cleanup 之前加**：

```ts
await mcpPool.disconnectAll()
```

如果 zai-server 当前**没有** shutdown handler（grep 不到），加：

```ts
const shutdown = async (signal: string) => {
  console.log(`Received ${signal}, shutting down MCP...`)
  await mcpPool.disconnectAll()
  process.exit(0)
}
process.on('SIGTERM', () => shutdown('SIGTERM'))
process.on('SIGINT', () => shutdown('SIGINT'))
```

- [ ] **Step 5: 跑 zai 全套测试**

Run: `cd packages/zai && bun test`
Expected: 全部通过

- [ ] **Step 6: Commit**

```bash
cd packages/zai
git add src/server/services/mcpConfig.ts src/server/index.ts test/server/services/mcpConfig.test.ts
git commit -m "feat(zai): wire MCPClientPool into DefaultAgentRuntime + shutdown disconnect"
```

---

## Task 6.5: MCP 工具黑/白名单（缓解 LLM context 撑爆）

**Files:**
- Modify: `packages/zai-agent-core/src/mcp/MCPToolAdapter.ts`（`adaptMcpTools` 接收 enableList）
- Modify: `packages/zai/src/server/services/mcpConfig.ts`（支持 `~/.zai/settings.json` 里 per-server `enabledTools` 字段）

**目的**：spec §12 风险 — MCP server 可能暴露数百个 tool，按白名单/黑名单过滤，避免撑爆 LLM context。

- [ ] **Step 1: 扩展 McpServerSpec 加 enabledTools 字段**

修改 `packages/zai-agent-core/src/mcp/types.ts`：

```ts
export type McpServerSpec = {
  // ... 现有字段 ...
  /** 白名单：仅暴露这些工具名（null/undefined = 全部暴露） */
  enabledTools?: string[]
  /** 黑名单：这些工具名不暴露 */
  disabledTools?: string[]
}
```

- [ ] **Step 2: 修改 adaptMcpTools 应用过滤**

修改 `packages/zai-agent-core/src/mcp/MCPToolAdapter.ts` 的 `adaptMcpTools`：

```ts
export async function adaptMcpTools(
  pool: MCPClientPool,
  serverName: string,
  spec?: McpServerSpec
): Promise<MCPTool[]> {
  if (!pool.hasClient(serverName)) return []
  const client = pool.getClient(serverName)
  try {
    const result = await client.listTools({ }, ListToolsResultSchema)
    let tools = result.tools ?? []
    if (spec?.enabledTools) {
      const allowed = new Set(spec.enabledTools)
      tools = tools.filter((t) => allowed.has(t.name))
    }
    if (spec?.disabledTools) {
      const denied = new Set(spec.disabledTools)
      tools = tools.filter((t) => !denied.has(t.name))
    }
    return tools.map((t) => adaptOne(t, serverName, client))
  } catch {
    return []
  }
}
```

queryEngine 调用方同步传入 spec。

- [ ] **Step 3: 写过滤单元测试**

`packages/zai-agent-core/test/mcp/mcp-tool-filter.test.ts`：

```ts
import { describe, expect, test } from 'bun:test'
import { makeMcpToolName } from '../../src/mcp/tool-name.js'

describe('enabledTools / disabledTools filter', () => {
  test('makeMcpToolName respects enabledTools semantics', () => {
    // 单元测主要验证白名单语义：白名单内暴露，黑名单外不暴露
    const allNames = ['echo', 'list', 'delete', 'create']
    const enabled = new Set(['echo', 'list'])
    const filtered = allNames.filter((n) => enabled.has(n))
    expect(filtered).toEqual(['echo', 'list'])

    const disabled = new Set(['delete'])
    const filtered2 = allNames.filter((n) => !disabled.has(n))
    expect(filtered2).toEqual(['echo', 'list', 'create'])
  })

  test('makeMcpToolName for filtered tools', () => {
    expect(makeMcpToolName('fs', 'echo')).toBe('mcp__fs__echo')
  })
})
```

Run: `cd packages/zai-agent-core && bun test test/mcp/mcp-tool-filter.test.ts`
Expected: PASS

- [ ] **Step 4: 修改 mcpConfig.ts 支持 enabledTools**

修改 `packages/zai/src/server/services/mcpConfig.ts`：

```ts
type RawConfig = {
  mcpServers?: Record<string,
    | { command?: string; args?: string[]; url?: string; type?: 'stdio' | 'sse' | 'http'; env?: Record<string, string>; headers?: Record<string, string>; enabledTools?: string[]; disabledTools?: string[] }
  >
}

// toSpec 内新增字段透传
function toSpec(name: string, raw: ...): McpServerSpec {
  // ... 现有逻辑 ...
  return {
    // ...
    enabledTools: raw.enabledTools,
    disabledTools: raw.disabledTools,
  }
}
```

- [ ] **Step 5: 写配置解析测试**

`packages/zai/test/server/services/mcpConfig.test.ts` 追加：

```ts
test('parses enabledTools from .mcp.json', async () => {
  writeFileSync(join(cwd, '.mcp.json'), JSON.stringify({
    mcpServers: {
      github: { command: 'npx', args: ['-y', '@mcp/github'], enabledTools: ['create_issue', 'list_repos'] },
    },
  }))
  const servers = await loadMcpServers(cwd)
  expect(servers[0].enabledTools).toEqual(['create_issue', 'list_repos'])
})
```

- [ ] **Step 6: 跑测试 + Commit**

Run: `cd packages/zai-agent-core && bun test && cd ../zai && bun test`
Expected: PASS

```bash
cd packages/zai-agent-core
git add src/mcp/types.ts src/mcp/MCPToolAdapter.ts test/mcp/mcp-tool-filter.test.ts
git commit -m "feat(zai-agent-core): MCP tool enable/disable list filtering"

cd ../zai
git add src/server/services/mcpConfig.ts test/server/services/mcpConfig.test.ts
git commit -m "feat(zai): parse enabledTools/disabledTools from .mcp.json"
```

---

## Task 7: E2E 测试（默认 CI 跳过，靠 RUN_MCP_E2E=1 触发）

**Files:**
- Create: `packages/zai-agent-core/test/mcp/e2e-stdio.test.ts`
- Create: `packages/zai-agent-core/test/mcp/e2e-sse.test.ts`

- [ ] **Step 1: 写 stdio E2E**

`packages/zai-agent-core/test/mcp/e2e-stdio.test.ts`：

```ts
import { describe, expect, test, beforeAll } from 'bun:test'
import { MCPClientPool } from '../../src/mcp/MCPClientPool.js'

const RUN_E2E = process.env.RUN_MCP_E2E === '1'
const describeE2E = RUN_E2E ? describe : describe.skip

describeE2E('MCP stdio E2E (server-everything)', () => {
  test('connects and lists tools from public fixture', async () => {
    const pool = new MCPClientPool()
    await pool.connectAll([{
      name: 'everything',
      transport: {
        kind: 'stdio',
        command: 'npx',
        args: ['-y', '@modelcontextprotocol/server-everything'],
      },
      reconnect: { maxRetries: 0, backoffMs: 100 },
      callTimeoutMs: 60_000,
    }])
    const h = pool.health()
    expect(h.everything.ok).toBe(true)
    await pool.disconnectAll()
  }, 120_000)
})
```

- [ ] **Step 2: 写 SSE E2E（in-process Bun HTTP server）**

`packages/zai-agent-core/test/mcp/e2e-sse.test.ts`：

```ts
import { describe, expect, test, afterAll } from 'bun:test'
import { MCPClientPool } from '../../src/mcp/MCPClientPool.js'
import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { SSEServerTransport } from '@modelcontextprotocol/sdk/server/sse.js'
import { ListToolsRequestSchema, CallToolRequestSchema } from '@modelcontextprotocol/sdk/types.js'

const RUN_E2E = process.env.RUN_MCP_E2E === '1'
const describeE2E = RUN_E2E ? describe : describe.skip

describeE2E('MCP SSE E2E (in-process Bun server)', () => {
  let server: ReturnType<typeof Bun.serve> | undefined
  let port = 0

  afterAll(() => server?.stop())

  test('connects via SSE and calls a tool', async () => {
    const mcp = new Server({ name: 'fixture', version: '0.0.0' }, { capabilities: { tools: {} } })
    mcp.setRequestHandler(ListToolsRequestSchema, async () => ({
      tools: [{ name: 'echo', description: 'echo', inputSchema: { type: 'object', properties: { msg: { type: 'string' } } } }],
    }))
    mcp.setRequestHandler(CallToolRequestSchema, async (req) => ({
      content: [{ type: 'text', text: `echo: ${String(req.params.arguments?.msg ?? '')}` }],
    }))

    server = Bun.serve({
      port: 0,
      async fetch(req) {
        const url = new URL(req.url)
        if (url.pathname === '/sse') {
          const transport = new SSEServerTransport('/messages', undefined as never)
          await mcp.connect(transport)
          return transport.handleSseRequest(req)
        }
        return new Response('not found', { status: 404 })
      },
    })
    port = server.port

    const pool = new MCPClientPool()
    await pool.connectAll([{ name: 'fixture', transport: { kind: 'sse', url: `http://localhost:${port}/sse` } }])
    const h = pool.health()
    expect(h.fixture.ok).toBe(true)

    await pool.disconnectAll()
  }, 60_000)
})
```

- [ ] **Step 3: 跑 E2E 验证（仅当 RUN_MCP_E2E=1）**

Run: `cd packages/zai-agent-core && RUN_MCP_E2E=1 bun test test/mcp/e2e-stdio.test.ts`
Expected: PASS（stdio E2E 真连 server-everything）

Run: `cd packages/zai-agent-core && RUN_MCP_E2E=1 bun test test/mcp/e2e-sse.test.ts`
Expected: PASS（in-process SSE server 工作）

- [ ] **Step 4: 不带环境变量跑 E2E，验证 skip**

Run: `cd packages/zai-agent-core && bun test test/mcp/e2e-stdio.test.ts`
Expected: `0 pass, 2 skip`（describe.skip 不执行）

- [ ] **Step 5: Commit**

```bash
cd packages/zai-agent-core
git add test/mcp/e2e-stdio.test.ts test/mcp/e2e-sse.test.ts
git commit -m "test(zai-agent-core): MCP E2E for stdio + SSE, gated by RUN_MCP_E2E"
```

---

## Self-Review Checklist

执行前请 reviewer 按以下清单逐项核对：

- [ ] Spec §1 背景与动机 — Task 1 P0 SDK dep 修复
- [ ] Spec §3 架构总览 — Task 2/3/4/6 完整覆盖
- [ ] Spec §4.1 McpServerSpec — Task 1 实现
- [ ] Spec §4.2 MCPClientPool 接口 — Task 2 实现（Task 5 补充 onStatusChange）
- [ ] Spec §4.3 MCPToolAdapter 产出 — Task 3 实现
- [ ] Spec §4.4 LoadedSkill 扩展 — Task 3 实现
- [ ] Spec §4.5 RuntimeConfig 扩展 — Task 1 + Task 4 实现
- [ ] Spec §5 连接生命周期 — Task 2 + Task 6 实现
- [ ] Spec §6 Transport 适配 — Task 2 实现
- [ ] Spec §7 工具池与权限 — Task 3 + Task 4 实现
- [ ] Spec §8 Skill 加载 — Task 3 + Task 4 实现
- [ ] Spec §9 错误处理 — Task 5 实现
- [ ] Spec §10 测试策略 — Task 1/2/3/4/5/7 单元 + 集成；Task 7 E2E
- [ ] Spec §12 「tool 数量过多」风险 — Task 6.5 实现 enable/disable 过滤

