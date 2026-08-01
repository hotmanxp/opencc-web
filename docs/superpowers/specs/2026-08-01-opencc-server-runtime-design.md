# OpenCC Server Headless Runtime 设计

## 目标

在 `packages/zn-agent-core/src/opencc-src/server/` 提供与 UI、TTY、Ink 无关的 OpenCC server runtime。zai server 直接调用该 runtime，不再在 `compat/runtime` 中手工构造最小 `QueryParams`、伪造 AppState/permission 或自行维护 transcript 历史格式。

目标调用链：

```text
zai HTTP route
  → background task scheduler
  → opencc server runtime.query()
  → vendor QueryEngine
  → vendor tool execution/hooks/compaction/abort
  → server event adapter
  → task event persistence/SSE
```

## 范围与不变边界

### 纳入 server runtime

- Config 初始化与 headless 配置策略；
- AppState 初始化；
- vendor 默认 tool registry；
- permission context 与 server permission provider；
- hooks/plugins；
- MCP client/provider；
- sandbox；
- QueryEngine；
- vendor session/transcript lifecycle；
- session abort、读取、列表、修改和删除；
- vendor event stream。

### 保留在 zai server

- HTTP API 路由；
- queued/running/completed/cancelled 任务调度与并发限制；
- SSE 连接、heartbeat、Last-Event-ID 重放；
- UI permission request 的 HTTP/SSE 展示与回答；
- server task metadata 和 task-level event persistence。

Background task 不是 Agent runtime，不迁移到 `opencc-src/server`。

## 核心 API

```ts
export type OpenccRuntimeOptions = {
  cwd: string
  dataDir?: string
  modelCaller: ModelCaller
  permission?: ServerPermissionProvider
  mcp?: ServerMcpProvider
  sandbox?: SandboxConfig
  plugins?: OpenccPluginOptions
  hooks?: HookRuntime
}

export type OpenccQueryInput = {
  sessionId?: string
  prompt: string | UserMessage | UserMessage[]
  model?: string
  cwd?: string
  signal?: AbortSignal
  maxTurns?: number
  parentSessionId?: string
}

export type OpenccRuntime = {
  query(input: OpenccQueryInput): AsyncIterable<OpenccServerEvent>
  abort(sessionId: string, reason?: string): Promise<void>
  getSession(sessionId: string): Promise<Session | undefined>
  listSessions(options?: ListSessionsOptions): Promise<Session[]>
  readTranscript(sessionId: string): Promise<Transcript>
  patchSession(sessionId: string, patch: SessionPatch): Promise<void>
  removeSession(sessionId: string): Promise<void>
  shutdown(): Promise<void>
}

export function createOpenccRuntime(
  options: OpenccRuntimeOptions,
): Promise<OpenccRuntime>
```

`modelCaller` 只负责模型 API 请求。工具调用、tool result、hooks、compaction、abort 和事件产生全部由 vendor QueryEngine/toolExecution 完成。

## 初始化设计

`createOpenccRuntime()` 按以下顺序初始化：

1. 安装 server-safe global/config prerequisites；
2. 创建 vendor Config 上下文，启用 config 读取并设置 cwd/client type；
3. 创建独立 AppStateStore，禁止依赖 Ink/UI 组件；
4. 创建 vendor 默认 tools，并注入 MCP tools；
5. 创建 server permission context/provider；
6. 创建 plugin/hook runtime，server 模式下只跳过明确依赖 TTY 的 UI hook，不跳过 vendor tool lifecycle；
7. 创建 MCP provider/client lifecycle；
8. 创建 sandbox provider；
9. 创建 vendor session/transcript store；
10. 创建 QueryEngine，并将以上对象作为正式依赖注入；
11. 注册一次 shutdown handler，释放 MCP、hooks、sandbox 和 session resources。

禁止在 `buildOpenccQueryParams.ts` 中继续创建 `noopAppState`、`syntheticToolUseContext` 或硬编码 bypass permission 作为主要运行路径。

## Session 与 transcript

直接采用 vendor 的 session ID、目录和 transcript 格式。zai 不再使用独立的 `compat/transcript/TranscriptStore` 作为 Agent 历史来源，也不再执行：

- `loadTranscriptHistory()`；
- `serializeForAnthropic()` 作为跨格式历史转换；
- 手工 uuid/timestamp；
- tool result pairing 修复作为正常路径。

vendor session store 必须提供显式 session 参数，不读取单一 CLI 当前 session 全局状态，以支持 HTTP 并发。若现有模块依赖 CLI 全局状态，应在 server 模块中提供薄的显式上下文封装，而不是复制 transcript 格式。

Task ID 与 vendor session ID 分离：task scheduler 可为一次执行创建 task ID，但 Agent 对话身份始终由 vendor session ID 标识。task metadata 保存 sessionId、parentSessionId 和 agentType。

## 事件设计

server runtime 原样向上游产出 vendor 语义事件，至少包含：

- assistant text/thinking delta；
- tool use pending/started/completed/failed；
- permission request；
- compact started/completed；
- subagent/session events；
- query completed/failed/aborted。

zai 只实现一次 `OpenccServerEvent → RuntimeEvent` 映射。映射不得重新推断 toolUseId、pairing 或 turn index；这些字段从 vendor event 保留。AskUserQuestion 仅在 HTTP 边界转换成 `prompt.ask`，回答再通过 runtime 的 permission/provider API 回注。

## 错误与取消

- QueryEngine 的异常以 vendor query error event 结束事件流；
- `AbortSignal` 同时传入 QueryEngine、modelCaller、tool execution 和 sandbox；
- `runtime.abort()` 使用 vendor session abort 机制；
- zai task cancellation 只调用 runtime abort，不自行伪造 tool result；
- shutdown 等待 vendor query 结束，并释放 server-owned resources。

## zai 迁移

`packages/zai/src/server/services/agentRuntime.ts` 改为创建并持有 `OpenccRuntime`，不再组装 `openccConfig.transcriptStore` 或 `buildOpenccQueryParams` 所需的 synthetic 配置。

`DefaultAgentRuntime`/`runViaOpenccQuery`/`buildOpenccQueryParams` 应被删除，或暂时保留为仅供迁移期间使用的薄兼容入口；正常 server 路径不得再调用它们。

`subagentNotifier`、后台任务和 SSE 使用 vendor session ID 关联 parent/child session，但不复制 vendor transcript。

## 实施阶段

1. 梳理并测试 vendor Config、AppState、tools、permission、session 和 QueryEngine 的可复用入口；
2. 新增 `opencc-src/server` 类型、runtime factory、session facade 和 event facade；
3. 将 vendor QueryEngine 接入完整 server context，先建立 headless runtime 单元/集成测试；
4. 把 zai modelCaller、MCP、sandbox、plugin/hook、permission provider 接入新 runtime；
5. 替换 `DefaultAgentRuntime` 的 server 调用链；
6. 删除旧 bridge/transcript history/manual permission 路径；
7. 迁移 task/SSE/session 关联到 vendor session ID；
8. 补齐真实浏览器验收与 CLI 回归测试。

## 验收标准

- 连续多轮 session 使用 vendor transcript 自动恢复；
- tool_use/tool_result 一一对应且不需要 bridge pairing 修复；
- Bash、Read、Edit、MCP、Agent/subagent 工具走 vendor tool lifecycle；
- AskUserQuestion 可暂停并通过 HTTP 回答后继续；
- compact 后 query 能继续；
- abort 中断模型、工具和 sandbox；
- server 重启后能读取 vendor session/transcript；
- SSE 断线重连不会重复或丢失 vendor event；
- 不引入 Ink、TTY 或 UI 依赖到 server runtime；
- OpenCC CLI 现有行为和测试不回归；
- zai server 不再依赖 `buildOpenccQueryParams` 的 synthetic runtime。
