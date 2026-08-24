# DSH Subagent / 后台任务 调用链全面对齐 vendor 设计

日期:2026-08-24
状态:设计定稿(待实施)

## 1. 背景与目标

### 1.1 问题陈述

当前 opencc-web DSH 轨下,subagent / 后台任务调用链路与 vendor (`deepseek-harness/packages/subagent/*`、`@deepseek-ai/dsh-jobs`) 语义存在系统性偏差,导致消息/事件/状态/UI 与 vendor 期望行为不一致:

1. **事件模型不匹配**:vendor 用 `subagent/start` + `subagent/end` 两个独立事件;zai 收到的是单一 `subagent.changed` 带 action 字段(`start`/`finish`),信息密度低且丢字段。
2. **Capability 字段全丢**:`outputSchema` / `toolFilter` / `persona` / `maxDepth` 在 `SeamSubagentDispatchInput` 已定义但 zai 调用时被忽略,只透传 `model`/`provider`。
3. **Stage 7 completionDelivery 半完成**:`wakeup`/`quiet` 完成策略代码已写(`taskStore.ts:355`),但 `kernel/factories/dsh.ts:524-624` 调用时**未传递**参数,始终默认 wakeup。
4. **Fork provider 已加载未启用**:`@deepseek-ai/dsh-subagent-fork-in-process` 已在 runtime 加载,代码支持 `providerName: 'fork'`,但 zai-side 从未传 fork,能力空悬。
5. **Continuable 子代理未实现**:`startContinuable` 在 `taskStore.ts:63` 是 mock,无任何调用路径,持久多轮会话能力未启用。
6. **状态机未透传**:vendor `running`/`waiting`/`settled` 三态(`continuation.ts ActivationState`)zai 不感知,UI 不知道子代理何时"安静但有未释放子代"。
7. **SubagentResult.output 未消费**:vendor 返回 `ContentBlock[]`,zai 只读 `toolCalls` 字段。
8. **vendorSeam 接口未真接**:`SubagentControlSeam` / `JobsControlSeam` 接口存在但 zai-side 绕过,直接调 `taskStore` 函数。globalThis 桥(`__zaiDshSubagentControl` / `__zaiDshSubagentDetail`)仍在使用。
9. **移动端 /m subagent 显示缺失**:`MobileAgent.tsx` 不渲染 subagent 列表。
10. **OpenCC 轨 SubagentsTab 空态误导**:OpenCC 模式下 SubagentsTab 永远空,无明确提示。

### 1.2 目标

把 DSH 轨 subagent / 后台任务调用链路**一次性全面对齐**到 vendor 语义,具体包括:

- 事件 schema 透传 vendor 原生事件名,新事件为主、保留旧事件作为 deprecation shim
- Capability 字段全接(`outputSchema`/`toolFilter`/`persona`/`maxDepth`/`provider`/`completionDelivery`/`runInBackground`)
- completionDelivery 真接线(wakeup + quiet)
- Fork provider 真启用
- Continuable 子代理启用(持久多轮)
- 状态机透传(`running`/`waiting`/`settled`)
- SubagentResult.output `ContentBlock[]` 渲染
- vendorSeam 真接线,移除 globalThis 桥
- 移动端 /m subagent 列表补齐
- OpenCC 轨明确标识 "DSH 模式专享"
- 废弃 `createAgentTool` / `registerAgentTool` / `notifyParentSession` 三个 no-op/deprecated 入口

## 2. 范围与约束

### 2.1 在范围

- DSH 轨下所有 subagent 调用路径(`opencc-web/packages/dsh-bridge/` + `packages/zai/src/server/` + `packages/zai/src/web/`)
- DSH 轨下后台任务路径(`@deepseek-ai/dsh-jobs` 接入)
- DSH 轨下 SSE 事件 schema(`packages/zai/src/shared/events.ts`)
- DSH 轨下 UI 组件(`SubagentsTab` / `SubagentsDrawer` / `SubagentDetailDrawer` / `SubagentDetailBody` / `MobileAgent.tsx` / `MobileQuickDrawer`)
- DSH 轨下 subagent 配置入口(Agent 页面 / settings.json)

### 2.2 不在范围

- OpenCC 轨 `DefaultBackgroundRuntime` 代码保持现状(`packages/zai/src/server/services/backgroundRuntime.ts:123-161`)
- OpenCC 轨 `/api/subagent-tasks/*` 端点继续返回 503 `dsh_subagent_unavailable`
- vendor 源码本身不修改(只读消费)
- `opencc` 上游合并策略(与本 spec 无关)
- 非 subagent 的普通 bash 后台任务(`TaskDock` 显示的 bash 类任务保持现有 dsh-bridge Stage 6 行为)

### 2.3 关键约束

- **Node-direct runtime**:`zai dev` 走 tsx + bun-protocol loader,改 vendorSeam 注入路径不能破坏 `tsx` 启动链路
- **core 改动先 build:core**:`packages/zn-agent-core/` 改完必跑 `pnpm run build:core` 才能在 zai dev 生效(本次 dsh-bridge 不涉及 zn-agent-core,跳过)
- **真实浏览器验收**:完成前必须 `/ego-browser` 验证 DSH 模式全功能 + 移动端 `/m`
- **CodeGraph 优先**:实施期优先用 `codegraph_explore` 定位文件,不 grep+read 轮询
- **测试粒度**:仅跑直接受影响的测试文件,不全量跑(zai 2192 + zn-agent-core 382 + dsh-bridge 135 测试基线)
- **小步可逆**:`subagent.changed` 旧事件保留一阶段 deprecation 期,UI 完全迁到新事件后通过 feature flag 关闭

## 3. 架构总图

```
zai UI (React)
   │  useSubagentTasks / useEventStream 订阅 vendor 原生事件名
   │  (subagent.start / subagent.end / subagent.descriptor / subagent.state / subagent.message / subagent.error)
   ▼
zai SSE /api/events (zod schema: shared/events.ts)
   │
   ▼
zai server (routes/services)
   │  kernel.getSeam('subagent').spawn(...) 调 vendorSeam
   │  (不再直调 dsh-bridge taskStore)
   ▼
@zn-ai/dsh-bridge vendorSeam layer (新:src/vendorSeam/)
   │  SubagentControlSeam / JobsControlSeam
   │  ├─ 委托 taskStore 函数(spawnDshSubagent / interruptDshSubagent / sendMessageToDshSubagent / ...)
   │  ├─ 订阅 vendor 原生事件并翻译为 zai SSE 事件
   │  ├─ 状态聚合(running/waiting/settled)
   │  └─ deprecation shim:同步发旧 subagent.changed 事件(可关闭)
   ▼
deepseek-harness vendor (@deepseek-ai/dsh-subagent/* + dsh-jobs + dsh-session-persistence)
   │
   ▼
子 Agent 运行 + 输出 ContentBlock[] + 状态机 + 描述符事件
```

**关键变化**:
1. zai-side 调用入口从 `import { spawnDshSubagent } from '@zn-ai/dsh-bridge'` 改为 `kernel.getSeam('subagent').spawn(...)`
2. dsh-bridge 暴露新 `vendorSeam` 子模块,负责事件翻译
3. zai 共享事件 schema 新增 6 个事件,旧 `subagent.changed` 标记 deprecated
4. UI 直接消费 vendor 原生事件名,不再做 action 字段解码

## 4. 事件 Schema 对齐

### 4.1 新事件清单

| 新事件(主) | 旧事件(deprecation shim) | Payload 关键字段 | 来源 |
|------|------|------|------|
| `subagent.start` | `subagent.changed` action='start' | `runId, provider, id, local, parentSessionId, sessionId` | vendor `subagent/start` |
| `subagent.end` | `subagent.changed` action='finish' | `runId, provider, id, local, stopReason, lastAssistantMessage?: ContentBlock[], output?: ContentBlock[], structured?` | vendor `subagent/end` |
| `subagent.descriptor` | — | `version: 2, mode: 'one-shot'\|'continuable', provider, label?, persona?, toolFilter?, agentProvider?, agentModel?` | vendor `subagent/descriptor` |
| `subagent.state` | — | `runId, state: 'running'\|'waiting'\|'settled'` | vendor `continuation.ts ActivationState` |
| `subagent.message` | — | `runId, blocks: ContentBlock[]`(增量) | vendor 子 agent publish |
| `subagent.error` | `subagent.changed` action='error' | `runId, message, code?` | taskStore catch |
| `job.started` (DSH 轨) | 同 | `jobId, runId?, kind: 'subagent'\|'shell', sessionId` | vendor `dsh-jobs` |
| `job.outcome` (DSH 轨) | — | `jobId, status: 'completed'\|'killed'\|'failed', detail?, output?` | vendor `JobOutcome` |

### 4.2 文件变更

- `packages/zai/src/shared/events.ts`:新增 6 个 zod schema,旧 `subagent.changed` schema 加 `@deprecated` JSDoc 注释
- `packages/dsh-bridge/src/vendorSeam/eventTranslation.ts`(新):vendor 原生事件 → zai SSE 事件翻译
- `packages/dsh-bridge/src/vendorSeam/subagent.ts`:已有 `DshSubagentControlAdapter` 扩展,订阅 `subagent/start`、`subagent/end`、`subagent/descriptor`、`subagent/state` 多事件
- `packages/dsh-bridge/src/vendorSeam/jobs.ts`:已有 `DshJobsControlAdapter` 扩展,翻译 `JobOutcome` → `job.outcome` 事件

### 4.3 过渡策略

- `subagent.changed` 同步发,eventBus emit 前 console.warn(`'[deprecation] subagent.changed will be removed after 2026-09-30; migrate to subagent.start/subagent.end'`)
- 新 UI 代码只订阅 `subagent.start` / `subagent.end`,`useAgentStore.applySubagentChanged` reducer 标记 deprecated
- 截止 2026-09-30 后通过 feature flag `agent.subagent.eventV2.enabled = false` 关闭 deprecation shim

## 5. Capability 字段全接

### 5.1 zai 配置入口

`packages/zai/src/web/src/pages/Agent.tsx`(或新 `pages/SubagentSettings.tsx`):

| 字段 | UI 控件 | 存储位置 | 默认 |
|------|---------|---------|------|
| `outputSchema` | 子代理创建弹窗 → "结构化输出" → JSON Schema 编辑器(CodeMirror) | session-level metadata | 不传 |
| `toolFilter` | "允许的工具" → 多选(Read / Write / Bash / Glob / Grep / WebFetch / MCP / ...) | session-level metadata | 不传(全开) |
| `persona` | "Persona prompt" → textarea | session-level metadata | 不传 |
| `maxDepth` | "嵌套层数" → number input | settings.json `agent.subagent.maxDepth` | vendor 默认(2) |
| `provider` | "是否携带父上下文" toggle(`spawn` vs `fork`) | session-level metadata | `spawn` |
| `completionDelivery` | "子代理完成策略" radio(`wakeup` vs `quiet`) | settings.json `agent.subagent.completionDelivery` | `wakeup` |
| `runInBackground` | "后台运行" toggle | session-level metadata | `false` |

### 5.2 字段透传路径

`packages/zai/src/server/services/kernel/factories/dsh.ts:524-624` 调用 `registerZaiTools` 时,**所有 7 个字段**透传给 `vendorSeam`:

```ts
// 新增透传参数
registerZaiTools(ctx, {
  spawnSubagent: (input: SpawnSubagentInput) =>
    kernel.getSeam('subagent').spawn({
      ...input,
      outputSchema: input.outputSchema,
      toolFilter: input.toolFilter,
      persona: input.persona,
      maxDepth: input.maxDepth,
      provider: input.provider,            // 'spawn' | 'fork'
      completionDelivery: settings.agent.subagent.completionDelivery,
      runInBackground: input.runInBackground,
    }),
})
```

### 5.3 文件变更

- `packages/dsh-bridge/src/vendorSeam/types.ts:113`:扩展 `SeamSubagentDispatchInput` 必填字段校验
- `packages/dsh-bridge/src/subagent/taskStore.ts:319` `spawnDshSubagent`:增加 capability 字段参数,内部透传到 vendor `SubagentStartRequest`

## 6. CompletionDelivery 真接线

### 6.1 行为定义

- **`wakeup`**(默认):子代理结束时,vendor `reportFrom` 触发,父 session 注入一条 `[subagent X 完成] {output preview}` 消息到 transcript。父 LLM 下一轮能感知子代理已完成 + 拿到 output 摘要(≤500 字符)。
- **`quiet`**:子代理结束时,只更新 subagent 状态(`subagent.end` 事件),父 session 静默。父 LLM 下一轮不会自动感知,需用户主动打开 SubagentsTab 查看。

### 6.2 配置入口

`settings.json` 新增字段:

```json
{
  "agent": {
    "subagent": {
      "completionDelivery": "wakeup"
    }
  }
}
```

启动期解析:kernel factory 读取 → 注入 `vendorSeam` 全局默认。每次 spawn 时也可在 session-level metadata 覆盖。

### 6.3 实现路径

`packages/dsh-bridge/src/vendorSeam/subagent.ts`(`DshSubagentControlAdapter.spawn`):

```ts
const subagentStartRequest = {
  ...input,
  completionDelivery: input.completionDelivery ?? this.defaultCompletionDelivery,
}
// 透传给 vendor SubagentRuntime.start()
// vendor 端 dsh-subagent 内部已实现 wakeup/quiet 两种策略的 reportFrom 行为
```

`packages/zai/src/server/services/kernel/factories/dsh.ts:524-624`:从 `settings.json` 读取 `agent.subagent.completionDelivery` 传给 `registerZaiTools`。

## 7. Fork / Continuable 启用

### 7.1 Fork Provider

- **触发**:zai UI 子代理创建弹窗新增 "Fork(携带父上下文)" toggle
- **后端**:`POST /api/subagent-tasks` 接 `provider: 'fork'` 参数 → `kernel.getSeam('subagent').spawn({ provider: 'fork', ... })` → 委托 `spawnDshSubagent(providerName='fork')` → vendor `ForkInProcessProvider`
- **vendor 入口**:`@deepseek-ai/dsh-subagent-fork-in-process` 已在 `createDshRuntime.ts:408` 动态加载,无需新增
- **UI**:SubagentsTab 每行显示 "Forked from {parentSessionId}" 标签(`subagent.descriptor.provider === 'fork'`)

### 7.2 Continuable 子代理

- **触发**:SubagentsTab 每行加 "Continue in subagent" 按钮(仅 `subagent.end` 之后显示)
- **后端**:新端点 `POST /api/subagent-tasks/:id/continuable`
  ```ts
  // zai/src/server/routes/subagentTasks.ts
  fastify.post('/api/subagent-tasks/:id/continuable', async (req) => {
    const { id } = req.params
    const { message } = req.body
    return kernel.getSeam('subagent').startContinuable(id, message)
  })
  ```
- **dsh-bridge**:`packages/dsh-bridge/src/subagent/taskStore.ts:63` 当前 `startContinuable` 是 mock,改为真实现:
  ```ts
  // 调用 vendor SubagentContinuationManager.startContinuable(spec)
  // spec: { parentSessionId, childId?, messageId?, prompt }
  // 返回 { childId, messageId }
  ```
- **UI**:进入 continuable 模式后,SubagentDetailDrawer 顶部显示"多轮对话"模式标识 + 消息输入框(已发消息历史)+ Send 按钮(调 `POST /api/subagent-tasks/:id/send-message`,已有 `subagentTasks.ts:227-267`)

### 7.3 文件变更

- `packages/dsh-bridge/src/subagent/taskStore.ts:63` 真实现 `startContinuable`
- `packages/dsh-bridge/src/vendorSeam/subagent.ts` `DshSubagentControlAdapter.startContinuable`
- `packages/zai/src/server/routes/subagentTasks.ts` 新增 `/:id/continuable` 端点
- `packages/zai/src/web/src/components/splitPane/SubagentsTab.tsx` 新增 "Fork" toggle + "Continue" 按钮
- `packages/zai/src/web/src/components/splitPane/SubagentDetailDrawer.tsx` continuable 模式渲染

## 8. 状态机透传

### 8.1 状态定义

vendor `continuation.ts ActivationState`:

| 状态 | 含义 | zai UI 渲染 |
|------|------|------------|
| `running` | Agent 有活跃 admission/turn 或有 accepted 消息 | spinner + "运行中" |
| `waiting` | Agent 安静但仍有未释放的子代 | 静态 + "等待子代理回复" + 提示用户可发消息 |
| `settled` | 安静且无子代 → 触发 handle dispose | 已结束显示(同 `subagent.end` 但持续可见) |

### 8.2 事件订阅

`packages/dsh-bridge/src/vendorSeam/subagent.ts` `DshSubagentControlAdapter`:

```ts
ctx.on('subagent/state', (info: { runId, state: ActivationState }) => {
  eventBus.emit('subagent.state', {
    runId: info.runId,
    state: info.state,
    sessionId: this.sessionId,
  })
})
```

zai `useAgentStore.applySubagentState` reducer 更新 `subagentTasksBySession[id].state`。

### 8.3 UI 渲染

`packages/zai/src/web/src/components/splitPane/SubagentDetailBody.tsx`:增加状态分支渲染(spinner / static / ended)。

## 9. SubagentResult.output ContentBlock[] 渲染

### 9.1 vendor 输出结构

`SubagentResult.output: ContentBlock[]`,支持:
- `thinking` → thinking 块
- `text` → 文本块
- `tool_use` → 工具调用
- `tool_result` → 工具结果
- `image` → 图片块

### 9.2 存储

`packages/dsh-bridge/src/subagent/taskStore.ts`:扩展 `getDshSubagentToolCalls` 为 `getDshSubagentBlocks(runId)`,从 `~/.zai/tasks-dsh/<runId>/blocks.jsonl` 读 ContentBlock[]。

### 9.3 UI 渲染

`packages/zai/src/web/src/components/splitPane/SubagentDetailBody.tsx`(当前 429 行):

- 新增 `ContentBlockRenderer` 组件,按 `block.type` 分支:
  - `thinking` → 复用 zai `ThinkingBlock`(`packages/zai/src/web/src/components/ThinkingBlock.tsx`)
  - `text` → `<TextBlock>` (markdown 渲染)
  - `tool_use` / `tool_result` → 已支持,扩展 `tool_use.name` 显示
  - `image` → `<ImageBlock>`(data URL `<img>`,复用 zai 现有 image 渲染)
- 未知 type → 降级为 `<pre>{JSON.stringify(block, null, 2)}</pre>` + zod 校验失败的 warn 日志

### 9.4 zod 校验

新增 `packages/dsh-bridge/src/subagent/contentBlockSchema.ts`(新):

```ts
import { z } from 'zod'

export const ContentBlockSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('thinking'), thinking: z.string() }),
  z.object({ type: z.literal('text'), text: z.string() }),
  z.object({ type: z.literal('tool_use'), id: z.string(), name: z.string(), input: z.unknown() }),
  z.object({ type: z.literal('tool_result'), tool_use_id: z.string(), content: z.unknown(), is_error: z.boolean().optional() }),
  z.object({ type: z.literal('image'), source: z.object({ type: z.literal('base64'), media_type: z.string(), data: z.string() }) }),
])
```

UI 渲染前 zod parse,失败降级 + warn。

## 10. VendorSeam 真接线 / 移除 globalThis 桥

### 10.1 新增文件

- `packages/zai/src/server/services/kernel/seamBinding.ts`(新):kernel factory 启动时把 vendorSeam 注入 zai services
- `packages/zai/src/server/services/kernel/seamRegistry.ts`(新):集中管理 seam 实例,提供 `kernel.getSeam<T>(name)`

### 10.2 修改文件

- `packages/zai/src/server/services/kernel/factories/dsh.ts:710-790`:移除 `__zaiDshSubagentControl` / `__zaiDshSubagentDetail` globalThis 桥
- `packages/zai/src/server/services/kernel/factories/dsh.ts:570-596`:`onTaskStart/onTaskFinish` 改为订阅 vendor `ctx.on('subagent/start' | 'subagent/end' | 'subagent/state' | 'subagent/descriptor' | 'subagent/message')` 多事件
- `packages/zai/src/server/services/backgroundRuntime.ts:76-179`:`initBackgroundRuntime` 在 DSH 模式下改为注入 vendorSeam(而非 return null)
- zai 所有 subagent 调用点改为 `kernel.getSeam('subagent').xxx(...)`

### 10.3 移除 deprecated

- `packages/dsh-bridge/src/tools/subagent.ts:131` `createAgentTool` no-op:删除函数
- `packages/dsh-bridge/src/tools/subagent.ts:328` `registerAgentTool` no-op:删除函数
- `packages/dsh-bridge/src/subagent/taskStore.ts:533` `notifyParentSession` 已废弃 export:删除
- 所有 import 这三个函数的 zai-side 代码删除 import

### 10.4 注入路径示例

```ts
// packages/zai/src/server/services/kernel/factories/dsh.ts
const seamRegistry = new SeamRegistry()
seamRegistry.register('subagent', new DshSubagentControlAdapter(taskStore, eventBus))
seamRegistry.register('jobs', new DshJobsControlAdapter(jobsRegistry, eventBus))
return { ...kernel, getSeam: seamRegistry.get.bind(seamRegistry) }
```

## 11. 移动端 /m 补齐

### 11.1 MobileAgent

`packages/zai/src/web/src/pages/m/MobileAgent.tsx`:

- 增加 `useSubagentTasks().tasks` 消费(已存在 hook,直接复用)
- 新增 `<SubagentList />` 子组件(简化版 SubagentsTab,只显示 task 标题 + 状态 + 展开 detail)
- 折叠到 "Subagents" 折叠面板,默认收起

### 11.2 MobileQuickDrawer

`packages/zai/src/web/src/components/MobileQuickDrawer.tsx`:

- 增加 "Subagents" 入口(toggle 触发抽屉显示 `<SubagentList />`)
- 不动现有 toggle 顺序,在末尾追加

### 11.3 移动端 SubagentDetail

复用 `SubagentDetailBody.tsx`(已是通用组件),只在外层包一层 mobile-friendly wrapper(全屏 sheet 而非右侧 Drawer)。

## 12. 测试策略

### 12.1 dsh-bridge 补测

`packages/dsh-bridge/test/`:
- `subagent/taskStore.test.ts`:补 fork provider 路径、startContinuable、capability 字段透传、completionDelivery wakeup/quiet
- 新增 `vendorSeam/eventTranslation.test.ts`:vendor 原生事件 → zai SSE 事件翻译
- 新增 `vendorSeam/subagent.test.ts`:DshSubagentControlAdapter 多事件订阅、状态聚合
- 新增 `subagent/contentBlock.test.ts`:ContentBlock zod 解析

### 12.2 zai 补测

`packages/zai/test/`:
- `shared/events.test.ts`:6 个新事件 schema zod 解析
- `server/services/kernel/seamBinding.test.ts`:vendorSeam 注入路径
- `server/services/kernel/factories/dsh.test.ts`:vendorSeam 调用 + 多事件订阅
- `web/hooks/useSubagentTasks.test.ts`:多事件 store 更新
- `web/components/splitPane/SubagentsTab.test.tsx`:Fork toggle + Continue 按钮 + state 渲染
- `web/components/splitPane/SubagentDetailBody.test.tsx`:ContentBlock[] 渲染(thinking/text/tool_use/tool_result/image)
- `web/pages/m/MobileAgent.test.tsx`:subagent 列表渲染

### 12.3 移动端补测

- `web/components/MobileQuickDrawer.test.tsx`:Subagents 入口
- `web/components/splitPane/SubagentDetailBody.test.tsx`:mobile wrapper 验证

### 12.4 测试粒度

仅跑直接受影响的测试文件:

```bash
pnpm --filter @zn-ai/dsh-bridge test src/subagent src/vendorSeam
pnpm --filter @zn-ai/zai test src/shared/events src/server/services/kernel src/web/hooks/useSubagentTasks src/web/components/splitPane/SubagentsTab src/web/components/splitPane/SubagentDetailBody src/web/pages/m/MobileAgent
```

**禁止**:`pnpm -r test` 全量(zai 2192 + zn-agent-core 382 + dsh-bridge 135 = 2700+ 文件,冷启动太慢)。

## 13. OpenCC 轨保留与 deprecation 标记

### 13.1 代码不动

- `packages/zai/src/server/services/backgroundRuntime.ts:123-161` OpenCC 模式 `DefaultBackgroundRuntime` 逻辑保持现状
- `/api/subagent-tasks/*` 在 OpenCC 模式继续返回 503 `dsh_subagent_unavailable`(现状)

### 13.2 UI 标识

`packages/zai/src/web/src/components/splitPane/SubagentsTab.tsx`:空态时显示:

```tsx
{currentKernel !== 'dsh' && (
  <Empty
    description={
      <span>
        当前 kernel = <code>{currentKernel}</code> 不支持 subagent。
        请切换到 <strong>dsh</strong> 模式(<a href="/config">配置页</a>)。
      </span>
    }
  />
)}
```

`packages/zai/src/web/src/components/SubagentsDrawer.tsx`:同样提示。

`packages/zai/src/web/src/pages/m/MobileAgent.tsx`:同样提示。

### 13.3 settings 跳转

UI 提供 "切换到 dsh 模式" 链接,跳到 `/config`,引导用户切换。

## 14. 风险与回退

| 风险 | 缓解 |
|------|------|
| 一次性改回归面广 | 保留 `subagent.changed` deprecation shim 兜底;kernel 启动参数 `--kernel=opencc` 强制回退(不验证 subagent) |
| vendorSeam 注入时机错误 | kernel factory 启动期检测,缺失 seam 时 fail loud(throw `MissingVendorSeamError`)而非静默 |
| ContentBlock[] UI 渲染覆盖不全 | 用 vendor 自带 `ContentBlockSchema` zod 校验,未知 type 降级为 raw JSON + warn 日志 |
| 移动端改动影响 mobile quick drawer | 仅新增 "Subagents" 入口,不动现有 toggle 顺序 |
| dsh-bridge 测试基线破坏 | 全量 `pnpm --filter @zn-ai/dsh-bridge test` 必须先全绿(135 测试);本次预计补到 175+ 测试 |
| fork provider 启动 vendor 失败 | kernel 启动期 try-catch,失败时降级到 spawn(不静默,console.warn + log telemetry) |
| completionDelivery wakeup 触发父 session 注入失败 | try-catch + UI Toast 提示,不影响 subagent 主流程 |
| startContinuable vendor 调用失败 | 返回 503 + 错误消息,UI 显示 "该子代理暂不支持续聊" |

## 15. 验收清单

### 15.1 测试验收

```bash
# dsh-bridge 测试基线(必须先全绿)
pnpm --filter @zn-ai/dsh-bridge test
# 目标:135+ 测试全绿,新增 40+ 测试,合计 175+

# zai 测试(仅直接受影响文件)
pnpm --filter @zn-ai/zai test src/shared/events.test.ts
pnpm --filter @zn-ai/zai test src/server/services/kernel
pnpm --filter @zn-ai/zai test src/web/hooks/useSubagentTasks.test.ts
pnpm --filter @zn-ai/zai test src/web/components/splitPane/SubagentsTab.test.tsx
pnpm --filter @zn-ai/zai test src/web/components/splitPane/SubagentDetailBody.test.tsx
pnpm --filter @zn-ai/zai test src/web/pages/m/MobileAgent.test.tsx
```

### 15.2 ego-browser 验收(强制)

启 DSH 模式 zai:

```bash
pnpm --filter @zn-ai/zai dev -- --port 8102 --api-port 7715 --kernel=dsh
```

真实浏览器(`/ego-browser` skill)逐项验证:

1. **DSH 模式 subagent.start / subagent.end 事件能消费** — DevTools Network SSE 日志看到 `subagent.start` / `subagent.end` / `subagent.state` / `subagent.descriptor` / `subagent.message` 事件
2. **Fork subagent** — 创建 fork 子代理,SubagentsTab 显示 "Forked from ..." 标签
3. **Spawn subagent 默认** — 普通 spawn 子代理
4. **capability outputSchema** — 子代理创建时指定 JSON Schema,完成后 output 是结构化 JSON
5. **capability toolFilter** — 子代理只能使用指定工具
6. **capability persona** — 子代理按 persona 行事
7. **completionDelivery wakeup** — 子代理完成后,父 transcript 出现 `[subagent X 完成]` 消息
8. **completionDelivery quiet** — 子代理完成后,父 transcript 静默,SubagentsTab 显示已结束
9. **状态机切换** — long-running 子代理触发 waiting 状态,UI 显示 "等待子代理回复"
10. **Continuable 续聊** — 子代理结束后,点击 "Continue" 进入多轮对话
11. **Send message** — continuable 模式下发送消息,子代理回复
12. **Interrupt** — 运行中子代理点击 Interrupt,UI 显示已中断
13. **OpenCC 模式 SubagentsTab 空态** — 切回 `--kernel=opencc`,SubagentsTab 显示 "DSH 模式专享" 提示
14. **/m 移动端 subagent 列表** — 浏览器宽度 ≤ 768,访问 `/m/agent`,看到 Subagents 折叠面板 + 列表 + detail
15. **/m 移动端 SubagentDetail** — 点击展开,看到 full-screen sheet,ContentBlock 正确渲染

### 15.3 CodeGraph 验证

实施完成后跑:

```bash
codegraph_explore "SubagentControlSeam spawn subagent.start subagent.end subagent.state"
```

确认:
- zai-side 不再有 `import { spawnDshSubagent }` 直调
- 所有 subagent 调用走 `kernel.getSeam('subagent').xxx`
- vendorSeam 是 zai 与 dsh-bridge 之间唯一接口

### 15.4 Deprecated 清理验证

```bash
grep -r "createAgentTool\|registerAgentTool\|notifyParentSession\|__zaiDshSubagentControl\|__zaiDshSubagentDetail" packages/
```

输出应为空(或仅 `compat/` 兼容垫片内的 alias 提示)。

## 16. 实施 Checklist(供 writing-plans skill 拆 plan)

- [ ] §4 事件 schema 对齐 + deprecation shim
- [ ] §5 Capability 字段全接(zai 配置入口 + 透传路径)
- [ ] §6 CompletionDelivery 真接线(wakeup + quiet)
- [ ] §7.1 Fork provider 真启用
- [ ] §7.2 Continuable 子代理启用
- [ ] §8 状态机透传(running / waiting / settled)
- [ ] §9 SubagentResult.output ContentBlock[] 渲染
- [ ] §10 VendorSeam 真接线 + 移除 globalThis 桥 + 移除 deprecated
- [ ] §11 移动端 /m 补齐(MobileAgent + MobileQuickDrawer + mobile detail wrapper)
- [ ] §13 OpenCC 轨 UI deprecation 标识
- [ ] §12 测试(单元 + 集成)
- [ ] §15 ego-browser 真实浏览器验收

## 17. 相关文档

- `packages/dsh-bridge/IMPLEMENTATION_STATUS.md` — dsh-bridge 当前实施状态
- `packages/zai/src/shared/events.ts` — zai 共享事件 schema
- `packages/zai/src/server/routes/subagentTasks.ts` — REST 端点
- `packages/zai/src/server/services/kernel/factories/dsh.ts` — DSH kernel factory
- `packages/zai/src/server/services/stateBridge.ts` — stateChangeBus → eventBus 桥
- `packages/zai/src/web/src/hooks/useSubagentTasks.ts` — SSE hook
- `packages/zai/src/web/src/components/splitPane/SubagentsTab.tsx` — Subagent UI
- `packages/zai/src/web/src/components/splitPane/SubagentDetailBody.tsx` — 详情渲染
- `packages/dsh-bridge/src/subagent/taskStore.ts` — subagent 状态存储
- `packages/dsh-bridge/src/vendorSeam/subagent.ts` — SubagentControlSeam 实现
- `packages/dsh-bridge/src/vendorSeam/jobs.ts` — JobsControlSeam 实现
- `/Users/ethan/code/deepseek-harness/packages/subagent/subagent/src/continuation.ts` — vendor 状态机
- `/Users/ethan/code/deepseek-harness/packages/subagent/subagent/src/types.ts` — vendor 类型
- `/Users/ethan/code/deepseek-harness/packages/subagent/subagent/src/lifecycle.ts` — vendor 生命周期事件
- `/Users/ethan/code/deepseek-harness/packages/jobs/jobs/src/types.ts` — JobOutcome 类型

## 18. 决策日志

| 决策 | 取舍 | 理由 |
|------|------|------|
| OpenCC 轨保持现状 vs 两轨对齐 | **只对齐 DSH 轨** | 用户确认;OpenCC 轨后续会废弃;统一 UI 不是本批目标 |
| 渐进式 vs 一次性重构 | **一次性重构** | 用户确认;范围已圈定 |
| 事件双轨过渡 vs 一次性切换 | **双轨过渡** | 小步可逆;运行期不破坏现有 UI 消费 |
| vendorSeam 真接线 vs 维持 globalThis 桥 | **真接线** | 用户选了"架构清理";移除 globalThis 桥是清理目标 |
| Fork 默认 vs Spawn 默认 | **Spawn 默认,Fork 显式 toggle** | 减少意外;Fork 是新能力不隐藏 |
| Continuable UI 入口位置 | **SubagentsTab 每行 "Continue" 按钮** | 已结束才能续聊,逻辑清晰 |
| 状态机是否 UI 显式展示 | **是** | waiting 状态是子代理静默期,用户需要看到提示 |
| ContentBlock 未知 type 渲染 | **降级 raw JSON + warn** | 不阻断主流程;便于调试 |
| 移动端 Subagent 渲染深度 | **简化版列表 + 全屏 detail** | 移动端屏幕空间有限,不照搬桌面 SubagentsTab |
