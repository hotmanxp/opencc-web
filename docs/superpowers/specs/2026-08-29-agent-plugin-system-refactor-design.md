# Agent 插件系统重构设计

日期:2026-08-29
状态:设计定稿(待实施)

## 1. 背景与目标

zai 当前的主 Agent 插槽机制(`docs/superpowers/specs/2026-08-20-zai-main-agent-slots-design.md`)已在 `createOpenccRuntime`(lightweight 轨道)接入,但存在三个问题:

1. **inproc 轨道无主 Agent 插槽**:`createPrintRuntime-impl.ts` 完全不读 `options.mainAgent`/`options.mainAgents`,`agentRuntime.ts:520-660` 不调 `resolveMainAgent`,session 内 systemPrompt / tools / mcp 全部走 vendor `print.ts:4616-4655` 默认值,自定义 agent 在 inproc 下静默失效。
2. **agent 解析/加载分散在 zai-server**:`loadUserMainAgents` / `resolveMainAgent` / `mergeMainAgents` 在 `packages/zai/src/server/services/mainAgents.ts`,`getBuiltinMainAgents` 在 core;plugin runtime(`DefaultPluginRuntime`)又是另一套独立机制。核心注册逻辑没下沉 core,违反 "插件核心模块在 core 实现" 的工程约定。
3. **sessionId ↔ agentId 绑定没有显式 API**:目前 session 与 mainAgent 的绑定隐式在 `transcript.meta.mainAgent` 落盘后透传,无显式 `registryAgent` 钩子,排查/测试/扩 hook 都缺入口。

**目标**:在 core 内新增 `AgentRegistry`,作为 session ↔ agent 配置的唯一桥梁,提供:

- 显式的 `registryAgent(sessionId, agentId)` / `unregistryAgent(sessionId)` API
- 统一的 `slot<T>(origin: T, slotId: AgentSlotId, sessionId: string): Promise<T>` 派发
- 内置 + 外置 agent 加载下沉到 core
- 三态 runtime(repl / lightweight / inproc)统一通过 `slot()` 接入

**Scope 边界**:本期只覆盖 resource slots(`systemPrompt` / `tools` / `mcp`)。hook slots(`sessionStart` / `userPromptSubmit` / `preToolUse` / `postToolUse`)与 `DefaultPluginRuntime` **不在本期范围**,维持原状;`AgentSlotId` 联合类型与 `AgentConfig.slots` 字段结构上为 hook 留位,后续按需扩展。

## 2. 核心数据契约

### 2.1 AgentSlotId 静态联合

```typescript
// packages/zn-agent-core/src/opencc-src/server/agentRegistry.ts

export type AgentSlotId =
  | 'systemPrompt'   // (origin: string[])           → string[]
  | 'tools'          // (origin: Tool[])             → Tool[]
  | 'mcp'            // (origin: McpServerConfig[])  → McpServerConfig[]
  // 后续按需追加 hook slots(本期不实现)
  // | 'sessionStart' | 'userPromptSubmit' | 'preToolUse' | 'postToolUse'
```

编译期锁定。`slot()` dispatcher 通过泛型 + 内部 `Map<AgentSlotId, SlotFn<T>>` 保证 `T` 对齐。

### 2.2 AgentConfig

```typescript
export type AgentSlotFn<T> = (origin: T, sessionId: string) => T | Promise<T>

export interface AgentConfig {
  name: string                              // 唯一 id
  description: string
  slots: {
    systemPrompt?: AgentSlotFn<string[]>
    tools?:        AgentSlotFn<Tool[]>
    mcp?:          AgentSlotFn<McpServerConfig[]>
    // 后续 hook 字段(本期不实现)
    // sessionStart?:     AgentSlotFn<SessionStartCtx>
    // userPromptSubmit?: AgentSlotFn<UserPromptCtx>
    // preToolUse?:       AgentSlotFn<PreToolUseCtx>
    // postToolUse?:      AgentSlotFn<PostToolUseCtx>
  }
}
```

**向后兼容**:现有 `MainAgentConfig { systemPrompt?, tools?, mcp? }` 字段在 core 重导出时自动转换为 `AgentConfig { slots: { systemPrompt, tools, mcp } }`。builtin agents(`default` / `office` / `agent-creator`)不用动实现。

### 2.3 AgentRegistry API

```typescript
export interface AgentRegistry {
  /** 启动时调用一次 */
  loadBuiltinAgents(): void
  loadUserAgents(dir: string): Promise<{ loaded: string[]; failed: Array<{ file: string; error: Error }> }>

  /** 每会话创建/恢复时调用 */
  registryAgent(sessionId: string, agentId: string): void
  unregistryAgent(sessionId: string): void

  /** 三态 runtime 调用 slot */
  slot<T>(origin: T, slotId: AgentSlotId, sessionId: string): Promise<T>

  /** 检视(测试 + UI) */
  listAgents(): AgentConfig[]
  hasAgent(name: string): boolean
  getBoundAgentId(sessionId: string): string | undefined

  /** 服务关闭 */
  clear(): void
}
```

### 2.4 内部存储

```typescript
class AgentRegistryImpl implements AgentRegistry {
  private agents = new Map<string /*agentId*/, AgentConfig>()
  private sessionBindings = new Map<string /*sessionId*/, string /*agentId*/>()
  private userAgentDir: string | null = null
  // ...
}
```

**不变量**:
- `sessionBindings` 单进程 in-memory(进程重启 = 全部丢失,启动时通过 `restoreAllSessions` 从 `transcript.meta.mainAgent` 重建)
- `agents` 加载后基本不变;`loadUserAgents` 失败保留 builtin + 抛错(不静默回落)
- `slot()` 对未注册 sessionId 抛 `AgentNotBoundError`;对未实现 slotId 的 agent 直接 pass-through(不抛)

## 3. 生命周期

### 3.1 服务启动(zai-server `initAgentRuntime` 内,once)

```typescript
const registry = agentRegistry
registry.loadBuiltinAgents()                                       // 同步
const result = await registry.loadUserAgents(
  path.join(os.homedir(), '.zai', 'main-agents')
)
if (result.failed.length > 0) {
  logger.warn({ failed: result.failed }, 'user main agents load partially failed')
}
await restoreAllSessions(registry, store)                          // 见 §3.2
```

### 3.2 冷启动 — 恢复已有会话

新增 `restoreAllSessions(registry)`:zai-server 启动后,扫描 `~/.zai/data/transcripts/<cwdHash>/` 下所有 `.jsonl`(用 `SessionFacade.list({cwd})` 或 zai-server `getTranscriptStore()` 等价枚举 API;具体 API 在 plan 阶段确认),逐个读 `transcript.meta.mainAgent`,调 `registryAgent(sid, agentId ?? 'default')`。在 `initAgentRuntime` 内 `loadUserAgents` 之后、`setReady` 之前调用。

> **依赖**:transcript meta 必须含 `mainAgent` 字段——已有会话(2026-08-20 spec 上线前)若无该字段,fallback `'default'`(不报错)。冷启动扫全表,启动时长与 transcript 数量线性,大用户量需后续优化(本期接受)。

### 3.3 会话创建(zai-server `routes/agent.ts:1081-1107` 已有逻辑附近)

```typescript
if (sessionMainAgent === null) {
  sessionMainAgent = getCachedZaiSettingsSync().mainAgent ?? 'default'
  void getTranscriptStore().patch(sessionId, { mainAgent: sessionMainAgent }, { cwd })
}
agentRegistry.registryAgent(sessionId, sessionMainAgent)   // fail loud if unknown
```

### 3.4 会话恢复(每 query 入口)

```typescript
const metaMainAgent = (transcript.meta as { mainAgent?: string }).mainAgent
if (typeof metaMainAgent === 'string') sessionMainAgent = metaMainAgent
if (sessionMainAgent !== null) {
  agentRegistry.registryAgent(sessionId, sessionMainAgent)   // 幂等
}
```

幂等保证:已绑定同 (sid, agentId) 则跳过;换 agentId 则覆盖(语义上 per-session 冻结,但支持热切覆盖)。

### 3.5 会话销毁(`routes/agent.ts:1727`)

```typescript
CwdStore.delete(sessionId)
agentRegistry.unregistryAgent(sessionId)   // 与 §3.3 对称
```

### 3.6 服务关闭(`runtimeLifecycle.ts:closeServer`)

```typescript
agentRegistry.clear()   // 清 sessionBindings;agents map 保留(进程生命周期内复用)
```

### 3.7 三态 runtime 调用 slot(本期核心收益)

#### 3.7.1 `createOpenccRuntime-impl.ts`(已有,改写)

替换现有 `options.mainAgent?.{systemPrompt,tools,mcp}` 三处直接调用:

```typescript
// :122-125 MCP 槽
mcpConfigs = await agentRegistry.slot(getAllMcpConfigs().servers, 'mcp', input.sessionId)

// :197-202 tools 槽
const engineComputeTools = () =>
  agentRegistry.slot(computeTools(), 'tools', input.sessionId)

// :219 systemPrompt 槽(通过 QueryEngine 的 systemPromptSlot 字段,统一 wrapper)
systemPromptSlot: (origin: string[]) =>
  agentRegistry.slot(origin, 'systemPrompt', input.sessionId)
```

#### 3.7.2 `createPrintRuntime-impl.ts`(本期新接,inproc 修复)

inproc 的 vendor `print.ts` 不识别 zai 的 `MainAgentConfig`,所以 zai 必须在调 vendor 之前把 slot 输出应用到 vendor 看得到的字段。三处接入:

1. **`createHeadlessContext` 的 `tools: Tools = getTools(permissionContext)`(`createHeadlessContext-impl.ts:235`)之后**,改写为:
   ```typescript
   const tools = await agentRegistry.slot(
     getTools(permissionContext),
     'tools',
     input.sessionId,
   )
   ```

2. **`createHeadlessContext` 的 `mcp` 连接路径(`createHeadlessContext-impl.ts:290-309` `connectMcp` 分支)** 改写为:先 `slot(getAllMcpConfigs().servers, 'mcp', sessionId)` 拿到过滤后的 server 列表,再传给 `getMcpToolsCommandsAndResources`。

3. **vendor `print.ts` 的 `options.systemPrompt` / `options.appendSystemPrompt`**(`print.ts:4598-4603` 从 stdin init request 读取):在 zai 的 stdin init request 构造处(由 `headlessPrintSession.ts` 驱动),改为:
   ```typescript
   const basePrompt = buildBaseSystemPrompt(...)
   const enriched = await agentRegistry.slot(basePrompt, 'systemPrompt', input.sessionId)
   initRequest.systemPrompt = enriched.join('\n')
   ```

`createPrintRuntime-impl.ts` 本身的 `createInstance(input)` 不需要新增独立函数——上述三处接入点在 `createHeadlessContext` 与 `headlessPrintSession.ts` 内完成;`createPrintRuntime` 只是把 `input.sessionId` 透传到这两处。

#### 3.7.3 `screens/REPL.tsx`

后续按需接入。本期可暂时延后(REPL 是开发态入口,优先级低);若 §4 验证发现 inproc 修复即满足本期范围,REPL 留待下一阶段。

## 4. 错误处理

| 场景 | 行为 | 抛出 / 返回 |
|------|------|------------|
| `registryAgent(sid, unknownAgentId)` | fail loud | `UnknownAgentError(name)` |
| `slot(input, slotId, unboundSid)` | fail loud | `AgentNotBoundError(sid)` |
| `slot(input, slotId, sid)` agent 未实现该 slot | pass-through | 返回 `input` 原样 |
| slot fn throw | bubble up | 原错误透传(runtime 决定 turn 错误处理) |
| slot fn 返回类型错 | 编译期守;运行期信任作者 | 不做 zod runtime check(避免 hot path 损耗) |
| `loadUserAgents(dir)` 目录不存在 | no-op(首次运行) | 静默 + DEBUG 日志 |
| `loadUserAgents(dir)` 单个 .js 损坏 | skip 该文件,继续 | ERROR 日志 + `failed: [{file, error}]` |
| `loadUserAgents(dir)` builtin 失败 | 启动 fail | `BuiltinAgentsLoadError` |
| 同名 builtin + user | user 覆盖 builtin | INFO 日志 |
| `registryAgent` 重复同 (sid, agentId) | 幂等 no-op | 无日志 |
| `registryAgent` 同 sid 不同 agentId | 覆盖 | DEBUG 日志 |
| `unregistryAgent(unknownSid)` | 幂等 no-op | 无日志 |
| 并发 `registryAgent` 同 sid | `Map.set` 原子,last-write-wins | 无锁 |

错误类型:

```typescript
export class AgentRegistryError extends Error { code: string }
export class UnknownAgentError       extends AgentRegistryError { code: 'AGENT_UNKNOWN' }
export class AgentNotBoundError      extends AgentRegistryError { code: 'AGENT_NOT_BOUND' }
export class BuiltinAgentsLoadError  extends AgentRegistryError { code: 'AGENT_BUILTIN_LOAD_FAILED' }
```

zai-server 路由层映射:400(unknown agent)/ 500(internal)/ 200(pass-through)。

## 5. 代码迁移

### 5.1 从 zai-server 下沉到 core

`packages/zai/src/server/services/mainAgents.ts`(目前含 `loadUserMainAgents` / `resolveMainAgent` / `mergeMainAgents` / `isMainAgentConfig`)→ 移到 `packages/zn-agent-core/src/opencc-src/server/agentRegistry.ts`,zai-server 改为 re-export 或保留薄包装。

### 5.2 builtin agents

`getBuiltinMainAgents()` 返回的 `MainAgentConfig` 实例 → 包成 `AgentConfig`(加 `slots` 字段)。`default` / `office` / `agent-creator` 实现不变。

### 5.3 三态 runtime 改造

| 文件 | 改动 |
|------|------|
| `packages/zn-agent-core/src/opencc-src/server/createOpenccRuntime-impl.ts` | :122-125 / :197-202 / :219 三处替换为 `agentRegistry.slot()` |
| `packages/zn-agent-core/src/opencc-src/server/createPrintRuntime-impl.ts` | 新增 §3.7.2 session-start 时调 `agentRegistry.slot()` |
| `packages/zai/src/server/routes/agent.ts` | :1081-1107 / :1727 / `agentRuntime.ts:520-660` 调用 `registryAgent` / `unregistryAgent` |
| `packages/zai/src/server/services/agentRuntime.ts` | `initAgentRuntime` 内 `loadBuiltinAgents` + `loadUserAgents` + `restoreAllSessions` |
| `packages/zn-agent-core/src/opencc-src/server/runtimeLifecycle.ts` | `closeServer` 内 `registry.clear()` |

### 5.4 不动的部分

- `DefaultPluginRuntime` / `processSessionStartHooks` / `processUserInput` / `toolExecution` — 本期不改
- vendor `print.ts:4616-4655` 的 filesystem AgentDefinition 解析 — 不动;inproc 通过 zai slot wrapper 在调用 vendor 之前改写 mcpConfigs / tools / systemPrompt,绕开 vendor 不认 zai 插槽的问题
- settings.mainAgent 全局设置 / transcript.meta.mainAgent per-session 持久化 — 不动

## 6. 测试

### 6.1 Unit(`packages/zn-agent-core/test/server/agentRegistry.test.ts`,新文件)

- `loadBuiltinAgents` → 3 builtin 可见
- `loadUserAgents(emptyDir)` → 静默 ok,agents 仅含 builtin
- `loadUserAgents(corruptJs)` → 不抛,`failed` 含该路径,agents 仅含 builtin
- `loadUserAgents(builtin-name-override)` → user 覆盖 builtin
- `registryAgent(sid, unknown)` → 抛 `UnknownAgentError`
- `registryAgent + slot(sid, 'tools')` → 调用 agent.tools(baseTools)
- `slot(sid, 'tools')` 当 agent.tools 未定义 → 返回 baseTools
- `slot(unboundSid, ...)` → 抛 `AgentNotBoundError`
- `registryAgent` 重复同 (sid, agentId) → 幂等
- `registryAgent` 同 sid 不同 agentId → 第二次覆盖
- `unregistryAgent(unknownSid)` → 无抛
- `clear()` 清空 sessionBindings,agents map 保留
- slot fn 抛错 → 原错误透传
- 并发 100 次 `registryAgent` 同 sid → 不死锁,最终状态一致

### 6.2 Integration(`packages/zai/test/server/agentRegistry.integration.test.ts`,新文件)

- POST `/api/agent/sessions` 后无 prompt → 无 binding(只在 prompt 路径触发)
- POST `/api/agent/prompt`(新 sid)→ binding 建立
- POST `/api/agent/prompt` 第二次(同 sid)→ binding 复用(sessionMainAgent 优先)
- DELETE `/api/agent/sessions/:id` → binding 解除
- mock transcript.meta.mainAgent = 'office' → 启动后 `restoreAllSessions` 重建 binding
- 三态 runtime 各自 slot 调用,验证结果与 builtin agent 直接调用一致

### 6.3 Migration(回归)

- `packages/zai/test/server/services/mainAgents.test.ts` 现有用例 → 改为 import core 的同名函数,行为不变
- `office` / `agent-creator` builtin:每个 slot 调用一次,断言 origin→output 与原逻辑一致(byte-for-byte snapshot)
- `~/.zai/main-agents/*.js` 三种格式(export object / export factory / default export)都正常加载

### 6.4 E2E(ego-browser,本期目标)

- desktop 启 dev 服务,访问 `/agent`,新建会话,选 `office` → 第一条 user message 后 assistant system prompt 含 office 注入(用调试 inspector 看 prompt)
- 同样选 `default` → 不含 office 注入
- 切换 `ZAI_RUNTIME_CORE=inproc`,重复上面 → 现在 inproc 也生效(原 bug 修复)
- 切换 `ZAI_RUNTIME_CORE=lightweight`(`spawn` / `default`),行为不变

### 6.5 不变量(单测断言)

1. `listAgents().length === 3` 当且仅当 `loadBuiltinAgents()` 已调且 `loadUserAgents` 失败/空
2. `sessionBindings.size === 已创建/恢复会话数 - 已删除会话数`(忽略重复绑定同 sid)
3. `slot()` 对每个已知 slotId 必然返回 `T`;spy 校验 fn 被调用 0 或 1 次
4. builtin agent 的 `systemPrompt` / `tools` / `mcp` 输出与重构前一致(byte-for-byte snapshot)
