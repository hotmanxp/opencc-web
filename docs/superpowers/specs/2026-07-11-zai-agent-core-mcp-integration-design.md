# zai-agent-core MCP 工具接入 设计文档

- **状态**：待评审
- **日期**：2026-07-11
- **作者**：OpenCC brainstorming session
- **范围**：`packages/zai-agent-core`（含与 `packages/zai` server 的契约变更）

## 1. 背景与动机

`zai-agent-core` 当前未真正接入 MCP 工具能力。从 OpenCC 上游同步过来的 MCP 代码位于 `src/opencc-internals/services/mcp/client.ts` 等位置，靠 `@ts-nocheck` 跳过类型检查。`@modelcontextprotocol/sdk` 不在 `package.json` 的 dependencies，`RuntimeConfig.mcpServers` 字段在 `src/runtime/types.ts` 定义但 `queryLoop.ts` 全文无引用，`MCPTool` 未注册到 `getZaiRuntimeTools()` 工具池。

本次接入打通从配置到工具调用、Skill 加载、错误事件的端到端链路。

## 2. 决策摘要

| 决策 | 选择 |
|------|------|
| Transport 范围 | stdio + SSE + StreamableHTTP 三种全要 |
| 生命周期责任 | zai-agent-core 自管（zai-server shutdown 时 disconnectAll） |
| MCP Skill 模式 | 复用（连接后扫描 `skill://` 资源，转 LoadedSkill） |
| 工具命名 | OpenCC 风格 `mcp__<server>__<tool>` |
| 配置源 | 仅 RuntimeConfig.mcpServers（zai-server 负责读 ~/.zai/settings.json + cwd/.mcp.json 后传入） |
| OAuth | 仅预置 token（env 注入 headers / 子进程 env） |
| 架构方案 | 方案 A：MCPClientPool 挂在 RuntimeConfig 顶层 |

## 3. 架构总览

```
zai-server
  DefaultAgentRuntime setup
    - 读 ~/.zai/settings.json + cwd/.mcp.json
    - new MCPClientPool({ logger })
    - RuntimeConfig.mcpClientPool = pool
    - RuntimeConfig.mcpServers = merged config
  ↓
zai-agent-core queryLoop
  while turn:
    pool.connectAll(config.mcpServers)          // 幂等，懒启动
    mcpArtifacts = pool.getArtifacts()
      → { tools: MCPTool[], skills: LoadedSkill[] }  // MCP server 暴露的工具 (mcp__<server>__<tool>)
    tools = resolveToolPool({
      base: getZaiRuntimeTools()              // 原生工具，含 ListMcpResourcesTool / ReadMcpResourceTool
        + mcpArtifacts.tools,                  // MCP server 暴露的工具
      skillsDirs,
      loadedSkills: skillArtifacts ∪ mcpArtifacts.skills
    })
    modelCall = modelCaller({ tools, messages })
    for tool_use block:
      toolExecution.execute(block)              // MCPTool adapter 走 mcpClient.callTool
  shutdown:
    pool.disconnectAll()                        // zai-server shutdown 触发
  ↓ SSE
前端
```

### 模块边界

| 文件 | 角色 |
|------|------|
| `src/mcp/MCPClientPool.ts` (新增) | 连接生命周期管理、artifacts 缓存 |
| `src/mcp/MCPToolAdapter.ts` (新增) | MCP `tool/list` 适配为 zai-agent-core `Tool<>` |
| `src/mcp/SkillResourceAdapter.ts` (新增) | MCP `resources/read` skill:// 适配为 LoadedSkill |
| `src/mcp/transport.ts` (新增) | createMcpTransport 工厂 + auth 注入 |
| `src/mcp/types.ts` (新增) | McpServerSpec / MCPClientPool interface |
| `src/runtime/queryLoop.ts` (修改) | connectAll / disconnectAll 调用，工具池装配 |
| `src/runtime/types.ts` (修改) | RuntimeConfig.mcpClientPool / mcpServers / mcpSkillLoading |
| `src/tools/index.ts` (修改) | ListMcpResourcesTool / ReadMcpResourceTool 动态注入 |
| `src/opencc-internals/services/mcp/client.ts` (修改) | 去掉 `@ts-nocheck`，正式接入依赖 |
| `package.json` (修改) | 加 `@modelcontextprotocol/sdk` 到 dependencies |

### 职责切分

- `MCPClientPool` 连接池 + 缓存，不感知 agent-core Tool 接口
- `MCPToolAdapter` 协议转换层，把 MCP 协议翻译成 zai-agent-core 的 Tool
- `SkillResourceAdapter` 同样做 MCP resources → LoadedSkill 翻译
- `queryLoop` 不直接调 MCP SDK，只通过 pool + adapter 两层间接使用

## 4. 数据契约

### 4.1 McpServerSpec

```ts
export type McpServerSpec = {
  name: string  // 全局唯一
  transport:
    | { kind: 'stdio'; command: string; args?: string[]; env?: Record<string, string> }
    | { kind: 'sse'; url: string; headers?: Record<string, string> }
    | { kind: 'http'; url: string; headers?: Record<string, string> }
  auth?: {
    bearerEnvVar?: string
    headerEnvVars?: Record<string, string>
  }
  reconnect?: { maxRetries?: number; backoffMs?: number }  // 默认 3 / 1000
  callTimeoutMs?: number  // 默认 30000
}
```

### 4.2 MCPClientPool 接口

```ts
export interface MCPClientPool {
  connectAll(servers: McpServerSpec[]): Promise<void>
  getArtifacts(): { tools: MCPTool[]; skills: LoadedSkill[] }
  listRawTools(): Record<string, McpSdkTool[]>
  health(): Record<string, { ok: boolean; error?: string; lastCheckAt: number }>
  disconnectAll(): Promise<void>
}
```

### 4.3 MCPToolAdapter 产出

```ts
export type MCPTool = Tool<ZodTypeAny, unknown> & {
  isMcp: true
  mcpInfo: { serverName: string; originalName: string }
  // Tool.name === `mcp__${serverName}__${originalName}`
  // description 含 [mcp:serverName] 前缀
}
```

### 4.4 LoadedSkill 扩展

```ts
export type LoadedSkill = {
  name: string
  description: string
  body: string
  source: 'disk' | 'mcp'  // 新增 'mcp' 枚举值
  mcpInfo?: { serverName: string; resourceUri: string }
}
```

### 4.5 RuntimeConfig 扩展

```ts
export type RuntimeConfig = {
  // ... 现有字段 ...
  mcpServers?: McpServerSpec[]
  mcpClientPool?: MCPClientPool
  mcpSkillLoading?: 'auto' | 'off'  // 默认 'auto'
}
```

## 5. 连接生命周期

### 5.1 状态机

- Idle → Connecting → Connected → Reconnecting → Connected
- Reconnecting 超 maxRetries → Failed（保留 tool 列表，call 立即 isError）
- 任意状态 → disconnectAll() → Disconnected

### 5.2 connectAll 行为

- 增量 diff：新增 server 连接、消失的 server 断开、存在的 server 跳过
- 并发连接，错误聚合，**永不抛错**
- 全部完成后 `refreshArtifacts()`

### 5.3 重连策略

- 触发：连接 error 事件 / health 探测连续失败 3 次
- 退避：`backoffMs * 2^retry`，封顶 `backoffMs * 8`
- 上限：默认 3 次，超限后 Failed
- 重连成功自动 refreshArtifacts

### 5.4 disconnectAll

- 关闭 stdio 子进程（SIGTERM → 2s → SIGKILL）
- 关闭 SSE/HTTP 连接（abort fetch + clearTimeout）
- 幂等

### 5.5 与 queryLoop 协作

- queryLoop 不在 finally 里 disconnectAll（pool 跨 query 复用）
- queryLoop abort（用户中断 query）也**不**调 disconnectAll，仅终止当前 in-flight tool call
- disconnectAll **仅**由 zai-server shutdown 触发，避免连接频繁断建

## 6. Transport 适配

### 6.1 工厂

```ts
function createMcpTransport(spec: McpServerSpec, signal: AbortSignal): Transport
```

discriminated union 按 `spec.transport.kind` 分发到 stdio / SSE / StreamableHTTP 三种 SDK transport。

### 6.2 三种 transport 差异

| 维度 | stdio | SSE | StreamableHTTP |
|------|-------|-----|----------------|
| 终止 | SIGTERM → 2s → SIGKILL | res.body.cancel + abort fetch | 同 SSE |
| 超时 | spawn 10s / call 30s | 握手 10s / call 30s | 同 SSE |
| 心跳 | 无 | 客户端 60s 无消息主动重连 | 同 SSE |
| token 注入 | 子进程 env | HTTP header | 同 SSE |
| 重连 | spawn 失败触发 | fetch 失败 / `event: error` | POST 失败 / SSE chunk 错误 |

### 6.3 StreamableHTTP vs SSE 区分

靠 URL 路径区分：以 `/sse` 结尾用 `SSEClientTransport`，否则 `StreamableHTTPClientTransport`。连接后协议相同。

### 6.4 auth 注入

仅从 `process.env` 读：
- `bearerEnvVar`：拼成 `Authorization: Bearer <value>`
- `headerEnvVars`：注入到 HTTP headers 或 stdio 子进程 env

### 6.5 调用超时

- 默认 30s（`AbortSignal.timeout(30_000)`）
- spec 可覆盖 `callTimeoutMs`
- 超时返回 `{ output: 'MCP tool call timed out after Xms', isError: true }`

## 7. 工具池与权限

### 7.1 工具名生成

```ts
function makeMcpToolName(serverName: string, toolName: string): string {
  return `mcp__${serverName}__${toolName}`
}
```

### 7.2 Tool 接口形态

- `name`：`mcp__<server>__<tool>`
- `description`：`[mcp:<server>] <original description>`
- `inputSchema`：MCP JSON Schema → Zod（失败降级 `z.record(z.unknown())`）
- `isReadOnly` / `isDestructive` / `isConcurrencySafe`：默认 `false`（保守）
- `isMcp` / `mcpInfo`：固定

### 7.3 canUseTool 权限映射

支持两种规则格式：

```ts
{
  allow: [
    'mcp__github__create_issue',                       // 精确
    { pattern: 'mcp__github__*', action: 'allow' },    // 通配
    { pattern: 'mcp__*__read_*', action: 'allow' }
  ],
  deny: [{ pattern: 'mcp__github__delete_*' }]
}
```

匹配函数 `matchToolName`：字符串规则全等匹配，pattern 规则转正则（`*` → `.*`）。

### 7.4 Prompt 中工具列表

```markdown
## Native
- Bash: Execute shell commands
...

## MCP Servers
### github (mcp)
- mcp__github__create_issue: Create a new issue
```

## 8. Skill 加载

### 8.1 触发

`connectAll` 完成后，当 `RuntimeConfig.mcpSkillLoading !== 'off'` 时，对每个成功连接的 server 调 `loadMcpSkills(client, serverName)`。`'off'` 时跳过（默认 `'auto'`）。

### 8.2 协议

MCP `resources/read` 返回 `BlobResourceContents`：

```json
{
  "uri": "skill://code-review",
  "mimeType": "text/markdown",
  "blob": "base64编码内容"
}
```

复用现有 frontmatter 解析器（js-yaml，`5f02b45`）。

### 8.3 冲突策略

- 后注册赢：zai-agent-core 已有 skillsDirs 优先，MCP 来的覆盖
- MCP server 之间冲突：后连接的覆盖

### 8.4 SkillTool 集成

- `LoadedSkill.source` 新增 `'mcp'`
- SkillTool prompt 对 `source: 'mcp'` 标注 `(mcp:<server>)`

### 8.5 资源工具（zai-agent-core 原生 tool，运行时依赖 pool）

- `ListMcpResourcesTool`：`{ serverName?: string }`
- `ReadMcpResourceTool`：`{ serverName, uri }`
- 作为 zai-agent-core 原生 tool 放在 `getZaiRuntimeTools()` 的 base pool（与 MCPTool adapter 产出的 `mcp__<server>__<tool>` 工具不同）
- 运行时仅当 `config.mcpClientPool` 注入时调用 pool 暴露数据；未注入时返回 `isError: 'mcpClientPool not configured'`
- 命名风格保持 `ListMcpResourcesTool` / `ReadMcpResourceTool`（不带 `mcp__` 前缀），避免与外部 MCP 工具混淆

## 9. 错误处理

### 9.1 三层错误

| 层级 | 错误源 | agent-core 反应 |
|------|--------|-----------------|
| 连接层 | spawn 失败 / SSE 握手失败 / HTTP 5xx | pool 重试 3 次 → Failed 状态，tool 列表保留 |
| 协议层 | JSON-RPC 错误 / method not found | tool.call 返回 isError |
| 业务层 | MCP tool 返回 `isError: true` | tool.call 返回 isError |

### 9.2 新增 RuntimeEvent

```ts
| { type: 'mcp_server:status'; serverName: string; status: 'connected' | 'reconnecting' | 'failed' | 'disconnected'; error?: string }
| { type: 'mcp_server:tools_updated'; serverName: string; toolNames: string[] }
```

通过现有 SSE 通道透传。

### 9.3 tool_use:error 消息格式

```json
{
  "type": "tool_use",
  "phase": "error",
  "toolName": "mcp__github__create_issue",
  "isMcp": true,
  "mcpInfo": { "serverName": "github", "originalName": "create_issue" },
  "error": {
    "category": "mcp_server",
    "message": "Tool call failed: connection reset",
    "retryable": true,
    "serverName": "github",
    "originalError": "ECONNRESET"
  }
}
```

### 9.4 优雅降级

MCP 永远不应该让 query 整体失败：
- 任何 server 连接失败：query 继续
- tool.call 失败：返回 isError，agent 决定下一步
- 重试超限：tool 保留，call 立即 isError
- disconnectAll 失败：log warn，不抛

### 9.5 AbortSignal 集成

- queryLoop AbortSignal 传入 connectAll / tool.call
- queryLoop abort（用户中断 query）时：正在建立的连接 abort，正在执行的 tool call 终止；pool **保持连接**，仅当前 query 中断
- pool.disconnectAll 由 zai-server shutdown 信号（SIGTERM / SIGINT）触发，独立于 queryLoop abort

## 10. 测试策略

### 10.1 测试金字塔

- 单元测试：核心路径 100%、边界 80%
- 集成测试：嵌入式 MockMcpServer，pool 状态机全覆盖
- E2E：每种 transport 1 happy + 1 reconnect，默认 CI 不跑，靠 `RUN_MCP_E2E=1` 触发

### 10.2 单元测试

```
test/mcp/
├── tool-name.test.ts
├── schema-convert.test.ts
├── skill-parser.test.ts
├── auth-inject.test.ts
├── transport-factory.test.ts
└── permission-matcher.test.ts
```

### 10.3 集成测试

`test/mcp/fixtures/MockMcpServer.ts` 内存事件总线 + MCP 协议接口。可模拟正常 / 失败 / 断连 / 慢响应。

```
test/mcp/pool.test.ts
├── connectAll 正常 + 取 artifacts
├── 一个 server 失败不影响其它
├── 重复调用幂等
├── 增量连接 / 断开
├── 断开后自动重连，artifacts 刷新
├── 超 maxRetries 进入 Failed
├── disconnectAll 关闭所有 transport
├── disconnectAll 幂等
└── getArtifacts 返回稳定的 tool 列表
```

### 10.4 E2E 测试

- `test/mcp/e2e-stdio.test.ts`：spawn `npx @modelcontextprotocol/server-everything`
- `test/mcp/e2e-sse.test.ts`：in-process HTTP server 实现 MCP SSE

### 10.5 回归保护

- `toolExecution.test.ts` 加 2 用例：MCP 工具正常 / MCP 工具失败
- queryLoop test 加 1 用例：connectAll 永不抛错
- 前端 smoke：`mcp_server:status` 事件能渲染

## 11. 实施分解（阶段，非计划）

| 阶段 | 范围 | 依赖 |
|------|------|------|
| P1 构建层 | 加 `@modelcontextprotocol/sdk` 到 deps，去掉 client.ts 的 `@ts-nocheck`，确保编译通过 | — |
| P2 原语 | MCPClientPool + createMcpTransport + 三种 transport 工厂 + auth 注入 | P1 |
| P3 适配层 | MCPToolAdapter + SkillResourceAdapter + Schema 转换 | P2 |
| P4 工具池 | queryLoop 装配 MCP artifacts，ListMcpResourcesTool / ReadMcpResourceTool 注入 | P3 |
| P5 错误层 | mcp_server:status / tools_updated 事件，streamAdapter mcp_server 分类校准 | P4 |
| P6 测试 | 单元 + 集成 + E2E 全部就绪 | P5 |
| P7 zai-server | DefaultAgentRuntime 注入 pool，shutdown 调 disconnectAll，读 ~/.zai/settings.json + cwd/.mcp.json | P6 |
| P8 前端 | mcp_server:status 状态条，可选 | P7 |

## 12. 风险与开放问题

| 风险 | 缓解 |
|------|------|
| `@modelcontextprotocol/sdk` 版本漂移 | 锁版本，与 `packages/mcp-proxy-server` 对齐到 ^1.6.1 |
| MCP server 暴露数百个 tool 撑爆 LLM context | pool 端按 server 维度 lazy expose，zai-server 配置允许黑/白名单 |
| stdio 子进程僵尸 | disconnectAll SIGTERM → 2s → SIGKILL；zai-server 进程退出兜底 |
| SSE / StreamableHTTP 长连接被反向代理截断 | 60s 主动重连 + 退避 |
| Skill 加载阻塞 connectAll | 改 `Promise.allSettled` 并发，加载失败不影响连接 |
| OAuth 后续需求 | 当前仅 env 注入，后续迭代在 RuntimeConfig 加 tokenStore + 授权回调 |

## 13. 文件清单

### 新增

- `packages/zai-agent-core/src/mcp/types.ts`
- `packages/zai-agent-core/src/mcp/MCPClientPool.ts`
- `packages/zai-agent-core/src/mcp/MCPToolAdapter.ts`
- `packages/zai-agent-core/src/mcp/SkillResourceAdapter.ts`
- `packages/zai-agent-core/src/mcp/transport.ts`
- `packages/zai-agent-core/src/mcp/errors.ts`
- `packages/zai-agent-core/src/tools/ListMcpResourcesTool/ListMcpResourcesTool.ts`
- `packages/zai-agent-core/src/tools/ReadMcpResourceTool/ReadMcpResourceTool.ts`
- `packages/zai-agent-core/test/mcp/tool-name.test.ts`
- `packages/zai-agent-core/test/mcp/schema-convert.test.ts`
- `packages/zai-agent-core/test/mcp/skill-parser.test.ts`
- `packages/zai-agent-core/test/mcp/auth-inject.test.ts`
- `packages/zai-agent-core/test/mcp/transport-factory.test.ts`
- `packages/zai-agent-core/test/mcp/permission-matcher.test.ts`
- `packages/zai-agent-core/test/mcp/pool.test.ts`
- `packages/zai-agent-core/test/mcp/fixtures/MockMcpServer.ts`
- `packages/zai-agent-core/test/mcp/e2e-stdio.test.ts`
- `packages/zai-agent-core/test/mcp/e2e-sse.test.ts`
- `packages/zai/src/server/services/mcpConfig.ts`（读 ~/.zai/settings.json + cwd/.mcp.json）

### 修改

- `packages/zai-agent-core/package.json`（加 `@modelcontextprotocol/sdk`）
- `packages/zai-agent-core/src/opencc-internals/services/mcp/client.ts`（去 `@ts-nocheck`）
- `packages/zai-agent-core/src/runtime/types.ts`
- `packages/zai-agent-core/src/runtime/queryLoop.ts`
- `packages/zai-agent-core/src/runtime/streamAdapter.ts`（mcp_server 分类校准）
- `packages/zai-agent-core/src/tools/index.ts`（动态注入资源工具）
- `packages/zai-agent-core/test/runtime/toolExecution.test.ts`（MCP 工具用例）
- `packages/zai/src/server/index.ts`（DefaultAgentRuntime 注入 pool + shutdown disconnectAll）

## 14. 附录：与 OpenCC 上游对齐说明

`src/opencc-internals/` 是从 OpenCC 同步过来的代码。本次接入不删除这些代码，而是把它们从 `@ts-nocheck` 的影子状态转为正式集成。

设计差异点（与上游 OpenCC）：

- OpenCC 用 zod-to-json-schema 序列化 tool schema；zai-agent-core 已经统一走 zod → json schema（`modelCaller.ts:41-44`），MCP 工具走同样路径
- OpenCC 的 mcp 路径耦合在 queryLoop 内部；zai-agent-core 走 MCPClientPool 抽象，更易测试
- OpenCC 用 mcp 字段 `mcp__<server>__<tool>` 但权限模型在外层；zai-agent-core 在 RuntimeConfig 层暴露 wildcard 权限规则
