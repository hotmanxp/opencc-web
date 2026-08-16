# DEVELOPMENT_REFERENCE.md

> opencc-web 详细架构与实现细节。**不在每轮 prompt 中注入**——开发者或 agent 按需查阅。规则级要求以仓库根 `AGENTS.md` 为准。

## 1. 总体架构

两个 workspace:`packages/zai`(Express + SSE + React/Zustand/AntD 前端)与 `packages/zn-agent-core`(Agent 运行时 + opencc vendor 拷贝)。zai 通过 `compat/runtime/openccAdapter` 调 vendor 主循环,前端通过 SSE 通道接收 RuntimeEvent。

更细的研究(19 个 router 表、6 个服务单例、3 条数据流、风险清单)见 `docs/superpowers/specs/2026-07-25-opencc-web-architecture-overview.md`。

## 2. 核心入口

- `packages/zn-agent-core/src/compat/runtime/contract.ts` — `DefaultAgentRuntime` 兼容垫片,`run(opts)` 委托 `openccAdapter.runOpenccQuery()`。其他 compat shim(`cwdStore` / `commands` / `transcript` / `background/DefaultBackgroundRuntime` / `mcp/MCPClientPool` / `plugins/HookRunner` / `runtime/skills-*` / `runtime/compactService`)均按 zai 端原 API 形态提供。
- `packages/zn-agent-core/src/compat/runtime/openccAdapter.ts` — surface bridge(BUNDLE_URL → vendor bundle + `tool.prompt({agents})` 动态渲染 + attachment 翻译),经 `bun-protocol.mjs` loader 在 Node 下运行。`dev`(tsx)为默认入口,`dev:bun` 为可选 Bun 快速运行;`start:node` 为发布态 Node 入口。
- `packages/zn-agent-core/src/opencc-src/` — opencc 0.20.0 源码副本,UI 已剔除,`query.ts` 主循环入口 + `queryLoop.ts` / `services/tools/` / `services/api/` / `services/mcp/` 等。un-stripped 全量(commit `80a769b1`),`import 'bun:bundle'` 与 `Bun.sleep` 直接吃 Bun runtime;runtime path 走 compat bridge,只有 unit test 直接 import vendor 才撞 Bun-only 约束。
- `packages/zn-agent-core/scripts/bundle-opencc.ts` — 把 `src/bundle-entry.ts` 打成单一 `dist/opencc-core.mjs`(esbuild bundle,运行时主入口),并机械生成 `dist/bundle-entry.d.ts`(主入口 types,从 `bundle-entry.ts` 的 export 语句原样提取,与 bundle 同步);额外用 `bundle: false` 单文件编 `src/opencc-src/{types,services/api,services/compressToolHistory,utils/model,server}/{permissions,sessionApiCounter,compressToolHistory,genericModelCapabilities,index,createOpenccRuntime,createHeadlessContext,sessionFacade}.ts` → 对应 `dist/` 产物(供主入口 d.ts 引用,不在 exports 暴露)。
- `packages/zai/src/server/index.ts` — `createApp({cwd, cwdName, token, port?})` 顺序 `initAgentRuntime → initSubagentNotifierLifecycle → initBackgroundRuntime`,挂 14 个 router 到 `/api/*`;`express.json({limit:'20mb'})`(图片粘贴);`/api` 整段禁缓存。

## 3. 数据流

### 3.1 主对话路径

```
web (Agent.tsx + useAgentStore)
   │  POST /api/agent/prompt          ← fire-and-forget, 立即 res.json({sessionId})
   ▼
server/routes/agent.ts
   │  translateRuntimeEvents()         ← Anthropic-style RuntimeEvent → ServerEvent
   │  eventBus.emit(ServerEvent)       ← subagentNotifier.ts 同流程注入
   ▼
GET /api/event (SSE, 15s 心跳, Last-Event-ID 续读)
   ▼
web/lib/eventSource.ts → applyRuntimeEvent / applySessionEvent / applyPromptAsk
```

`/agent/prompt` 不 abort(fire-and-forget),真正兜底是 **2 小时 HARD_TIMEOUT**(`agent.ts:34`)。

### 3.2 后台任务路径

```
web (useBackgroundTasks) ─POST /api/tasks→ DefaultBackgroundRuntime.dispatch
   → 调度器 for-await agentRuntime.run → TaskEvent(strip meta)
   → JsonTaskStore.appendEvent [先写盘] + emitter.emit [再通知]
   → GET /api/tasks/:id/events (SSE, ev.seq 作 id:)
```

### 3.3 AskUserQuestion 端到端流

```
tool_use(AskUserQuestion) → toolExecution yield tool_use:ask_pending
  → translateRuntimeEvents → prompt.ask SSE
  → useAgentStore.applyPromptAsk → pendingAsk
  → QuestionCard 渲染
用户点 Submit → POST /api/agent/answer
  → AskRegistry.answer(toolUseId) resolve register Promise
  → AskUserQuestionTool.call 拿到 answers → 返回
  → toolExecution yield tool_use:done
前端:pendingAsk = null + upsertToolCall 收敛
```

### 3.4 压缩 SSE 通知路径

```
queryLoop 每轮 turn 进入
  → snipCompactIfNeeded (削 ≥95% 阈值的早期 user 消息)
  → resolveForceReason (memory-pressure > message-count > token 阈值)
  → autoCompactIfNeeded (per spec,带 circuit breaker)
  → store.replace() 落盘 + yield 内部 compaction.completed
  → routes/agent.ts 翻译为 SSE runtime.compacted
  → useAgentStore.applyCompactionEvent → 5s 自动消失的 toast
```

### 3.5 SSE 事件序列化与投影状态推送（dsh 借鉴）

设计稿: `docs/superpowers/specs/2026-08-15-dsh-event-seq-projection-design.md`；实施计划 `docs/superpowers/plans/2026-08-15-dsh-event-seq-projection.md`。三个核心机制:

**1. `ServerEvent.seq` 单调递增**
- `shared/events.ts` Base 加 `seq: z.number()`（必填）。`ServerEventBus.emit` 分配: `seq: event.seq ?? ++seqCounter`，全局单调、**单进程内**语义——跨重启由 `eventId` + history replay 兜底，**不得把 seq 当持久化 ID**。
- SSE `id:` 行自动携带 seq（`sse.ts` `writeSse` 的 `event.seq ?? event.eventId`），`Last-Event-ID` 续读不受影响（eventBus history 仍按 `eventId` 比对）。
- 前端 `useAgentStore.lastSeqBySession[sid]` 记录每 session 已应用的最大 seq（只升不降）;`upsertStreamBlock` / `upsertToolCall` 入口做 seq 守卫: `seq <= prev` 的重放/乱序/同 seq 重复投递直接丢弃,严格递增才合并。手工 key 拼接（`sendSeq/textSegmentRev`）仍负责 React 渲染分组,防御代码渐进式清理。

**2. 连接状态机**
- `eventSource.ts` 导出 `StreamState = 'connecting' | 'connected' | 'reconnecting' | 'error'`,`subscribeServerEvents(sid, onEvent, onState?)` 第三参由旧 `onError` 改为 `onState`。`onopen` → connected(重置计数);`onerror` → `attempt++`,`attempt <= 3` 报 reconnecting,否则 error(第 4 次失败)。
- `useEventStream` 把 onState 写入 `useAppStore.streamState / streamAttempt`;`server.connected` 事件到达仍置 connected + 触发 `hydrateSessionState`(冷启动快照补全)。
- `useEventStream.dispatch` 重构为批量 `applyBatch(batch)`(导出): 按 seq 全局排序 → 逐事件路由 → reducer。`enqueue` 用 `queueMicrotask` 把同 tick 的 N 个 SSE 事件合并成一次 flush(P4: 避免逐事件 setState)。
- 新增 `stream/error` 帧(闭合 `RpcErrorCode` union): 路由到 `setStreamState('error')` + toast(`applySystemEvent` 的 stream/error 分支)。

**3. `session/projection` 投影帧**
- host 算完的派生值快照按 `{sessionId, key, value, seq}` 整体推送,前端 `useAgentStore.projectionsBySession` 做 higher-seq-wins 合并(低 seq 丢弃),重连后 host 重算整体重发。
- 订阅面: `useProjection(sessionId, key, selector?, equal?)` hook(`store/useProjection.ts`)。
- 试点 key: `title`(`session.renamed` emit 时同步投影,`routes/agent.ts`)+ `context.tokens`(`runtime.done` emit 时同步投影)。消费:`useConversationInfo` 的"当前上下文大小"行 + `MobileHeader` 标题(投影优先,fallback 到 sessions 列表)。
- **新增事件必须同步**: `shared/events.ts` union + `eventSource.ts` `NAMED_EVENT_TYPES` + `eventBus.ts` `isGlobalEvent`(stream/error 是全局帧;session/projection 走 per-sid history)。漏一处即前端静默丢事件。

## 4. 关键文件

| 路径 | 职责 |
|------|------|
| `packages/zai/src/server/routes/agent.ts` | `/agent/prompt` (fire-and-forget + HARD_TIMEOUT) + sessions CRUD + abort |
| `packages/zai/src/server/routes/{answer,event,tasks,v2Tasks,agentSettings,slash}.ts` | AskRegistry 注入 / SSE / 后台任务 CRUD+SSE / V2 TaskList / 模型设置 / slash |
| `packages/zai/src/server/routes/{bashRepl,replHistory}.ts` | `/api/bash/repl/:sid/{exec,events,abort}` + `/api/bash/history/top10?q=&n=` |
| `packages/zai/src/server/services/eventBus.ts` | `ServerEventBus`(subscriber Set + 256 ring history) |
| `packages/zai/src/server/services/askRegistry.ts` | `register/answer/reject/abortAll`,等 AskUserQuestion 答复 |
| `packages/zai/src/server/services/agentRuntime.ts` | `DefaultAgentRuntime` 单例 + `resolveSkillsDirs`(`~/.agents/skills`)+ `resolveSandbox`(`executor:'child_process'` / `maxCpuMs:600_000`)+ 启动时 `initCommands` |
| `packages/zai/src/server/services/backgroundRuntime.ts` | `initBackgroundRuntime` 包 `DefaultBackgroundRuntime` 注入 `onTaskStateChange` → emit `job.*` + 串 `SubagentNotifier.handle(task)`;`initSubagentNotifierLifecycle` 必须先注册 |
| `packages/zai/src/server/services/subagentNotifier.ts` | 后台 task terminal 时 fire-and-forget 注入 `<task-notification>` 触发父 queryLoop 续传 |
| `packages/zai/src/server/services/openaiClient.ts` | 手写 OpenAI-compatible HTTP 客户端(~648 行),`messages.create()` 返回 `AsyncGenerator<OpenAIStreamEvent>`,duck-type 为 Anthropic SDK 让 `modelCaller` 在 `provider:'openai'` 时无缝替换:Anthropic messages → OpenAI messages(支持 string / base64 image / tool_use / tool_result,orphan tool_result 自动丢)+ tool schema 归一化(`required[] ⊆ properties`,strict mode 加 `additionalProperties:false`)+ OpenAI SSE → Anthropic events(`message_start`/`content_block_*`/`message_delta`/`message_stop`/`error`,含 `reasoning_content → thinking` 桥接 + `finish_reason=length` 截断 JSON 自愈 + `paic.com.cn` 自动加 `client-code/plugin-version: Gemini` 头)。**NOT supported**:远程 URL 图片、`tool_choice` 非 auto/required/none、prompt cache、`thinking` 参数、code interpreter。`modelCaller.ts:159-175` 懒加载 dynamic import(vitest `vi.mock` 可拦截) |
| `packages/zai/src/server/services/repl/{ReplSession,ReplRegistry,ReplHistoryService}.ts` | Bash REPL 单 session 状态机 / 单例 registry / 全局 JSONL 命令历史(append 串行 + 5min TTL cache + 10MB rotate + blocklist) |
| `packages/zai/src/server/services/mcpConfig.ts` | 尊重 Claude Code 过滤字段(`enabledMcpjsonServers` / `disabledMcpjsonServers` / `disabledMcpServers`) |
| `packages/zn-agent-core/src/compat/runtime/contract.ts` | `DefaultAgentRuntime` 兼容垫片,`run(opts)` 委托 `openccAdapter.runOpenccQuery()`(Node/tsx 兼容) |
| `packages/zn-agent-core/src/compat/runtime/{skills-index,skills-loader,skills-promptBuilder,skills-frontmatter,skills-substitute}.ts` | `loadSkillsFromDirs` + `buildSkillsSystemPrompt` + PendingSkillInjection / 解析 YAML frontmatter / `$ARGUMENTS`/`$N`/`$NAME` 替换 |
| `packages/zn-agent-core/src/compat/runtime/compactService.ts` | `compactSession()` 接 modelCaller + transcript 边界 + summary message 写入 |
| `packages/zn-agent-core/src/compat/background/{BackgroundRuntime,DefaultBackgroundRuntime,store/JsonTaskStore,retryPolicy,types}.ts` | `dispatch/get/list/cancel/events/shutdown` interface + 调度器(并发上限 4)+ JsonTaskStore 持久化 + retry(529 连续上限 vs 5xx 总上限 maxRetries=10) |
| `packages/zn-agent-core/src/compat/memory/{loader,watcher}.ts` | `loadMemoryForPrompt` 注入 system prompt 顶部(AGENTS.md 链 + .claude/rules + AGENTS.local.md + @include)/ `startMemoryWatcher` 1s mtime 监听 + `clearMemoryCache` |
| `packages/zn-agent-core/src/compat/mcp/MCPClientPool.ts` + `MCPToolAdapter.ts` | MCP 池 + zai 工具协议适配 |
| `packages/zn-agent-core/src/compat/plugins/{HookRunner,DefaultHookExecutor,registry,manifest,paths,errors}.ts` | OpenCC 插件钩子 + `DefaultPluginRuntime` + 8 个 hook event |
| `packages/zn-agent-core/src/opencc-src/tools/{BackgroundAgentResultTool,TaskOutputTool}/` | 阻塞读 / 非阻塞拉 task output(opencc 原版,Bun-native) |
| `packages/zai/src/shared/events.ts` | zod discriminatedUnion:`runtime.*` / `session.*` / `job.*` / `prompt.ask` / `system.*` 五通道 |
| `packages/zai/src/shared/repl.ts` | `TopCommandEntry` / `TopCommandsResponse`(全局 topN 历史接口契约) |
| `packages/zai/src/web/src/lib/{bashReplApi,replHistoryApi}.ts` | exec/abort/SSE client fetch + topN 历史 fetch 包装 |
| `packages/zai/src/web/src/hooks/useBashRepl.ts` | SSE 连接管理 + `topCommands` state + `refreshTopCommands()`(exec 后自动刷新) |
| `packages/zai/src/web/src/components/splitPane/BashTab.tsx` | Bash REPL Tab + AntD `AutoComplete` 下拉 top10 建议(本地 prefix 过滤) |
| `packages/zai/src/web/src/store/useAgentStore.ts` | Zustand store:`applyRuntimeEvent` / `applySessionEvent` / `applyPromptAsk` / `applyJobEvent` / `applySystemEvent` + `upsertToolCall` / `scheduleTaskListClearIfAllDone` 5s 自动清空 |
| `packages/zai/src/web/src/store/useAppStore.ts` | 全局 UI state:`sidebarCollapsed` / `settingsDrawerOpen` / `settingsTheme` / `outputStyle` / `maxVisibleMessages`(默认 20,超过时折叠早期消息 + 顶部浮按钮还原) |
| `packages/zai/src/web/src/lib/{api,v2TaskApi}.ts` + `hooks/useBackgroundTasks.ts` | 通用 fetch(`api.ts` 默认不带 `X-Zai-Token`)+ v2 task 拉取 + job dock 按 sessionId 切分 |

## 5. SSE 事件通道(`shared/events.ts`)

- **runtime.\***:started / delta(text) / thinking(独立通道) / tool_call / tool_result(必带 toolUseId+toolName+input) / done / aborted / error(可带 toolUseId)
- **session.\***:created / deleted / renamed
- **job.\***:started / progress / done / failed(`sessionId` 字段让前端按 session 过滤;`kind:'agent_task'` 带 `taskId`)
- **prompt.ask**:`sessionId + toolUseId + questions[{question, header, options}]`
- **system.\***:server.connected / server.error / toast / branch.changed
- **state.\***:cwd.changed / bash_task.changed / v2_task.changed / agent_task.changed
- **command.\***:`command.run` + `command.done` 配对(`/api/agent/command` 路由发,`commandId` 配对,debugging / 慢命令分析埋点,见 §13)

## 6. RuntimeEvent 翻译表(`routes/agent.ts` 内 `translateRuntimeEvents`)

> 行号会随 import 偏移,以 `translateRuntimeEvents` 符号为准。

| runtime 上游 | → ServerEvent |
|---|---|
| `message_start` | `runtime.started` |
| `content_block_start`(tool_use)| 缓存 pending toolUseId/Name/input |
| `content_block_delta` text_delta / thinking_delta | `runtime.delta` / `runtime.thinking` |
| `content_block_delta` input_json_delta | 累积到 toolInputBuffer |
| `content_block_stop`(有 pending tool_use)| `runtime.tool_call` |
| `tool_use:start` / `:done` | `runtime.tool_call` / `runtime.tool_result` |
| `tool_use:ask_pending` | `prompt.ask` |
| `tool_use:error` / `:invalid` / `:denied` | `runtime.error`(带 toolUseId) |
| `message_stop` | `runtime.done`(`queryLoop` 主动 yield,不再 wrapWithZaiMeta) |

## 7. 前端 store 关键设计

- **Stream block key** = `${sendSeq}:${turnIndex}:${textSegmentRev}:${blockIndex}:kind`
  - `sendSeq` 每次发消息 +1 → 跨轮次不冲撞(`wrapWithZaiMeta` 计数器每调用归零 → 必须前端再 namespace)
  - `textSegmentRev` 在 `tool_use:start` 时 +1,把文字段切到独立 bubble;`segmentedToolUseIds` 防重复 bump
- **TodoWrite 守卫**:`upsertToolCall` 收到 `name==='TodoWrite'` 立刻吞掉不写 messages,在 `:done` 阶段解析 `input.todos` 写 `todosBySession[sid]`;损坏静默忽略
- **V2 TaskList**:`v2TasksBySession` 与 TodoWrite 独立,server 持久化到 `~/.zai/tasks/<sid>.json`,前端通过 `/api/agent/sessions/:id/v2-tasks` 拉全量兜底
- **runtime.error 路由**:带 toolUseId → `upsertToolCall` 写成 `tool_use:error`;不带 → push 一条进 messages 红色 Card
- **任务自动清空**:`scheduleTaskListClearIfAllDone`,todos + v2 tasks 全部终态(completed / deleted)后 5s 自动从 store 移除
- **StateEvent map**:`cwdBySession` / `bashTasksBySession` / `agentTasksBySession` / `v2TasksBySession`(已有)与 `todosBySession` 平行,4 个 map + 4 个 reducer 维护

## 8. BackgroundRuntime / 后台任务子系统

`BackgroundRuntime` 是和 `AgentRuntime` 平级的另一套持久化任务系统。`POST /api/tasks` → `dispatch` 入队 + 调度器在并发槽内 `for-await agentRuntime.run({parentSessionId, disallowedTools:['Agent']})` → 拿 `RuntimeEvent` 转 `TaskEvent`(strip meta)→ `JsonTaskStore.appendEvent` 写盘先于 emit → SSE 路由把 `ev.seq` 作 `id:` line 走 `Last-Event-ID` 续读。任务结束发 `task.ended` 哨兵。

**关键设计**:
- **写盘先于 emit**:服务端崩溃 / 客户端断网 → 重连用 `Last-Event-ID` 补齐。`tasks.ts:88-103` 把 `ev.seq` 显式作为 SSE `id:` line(之前 `...spread eventId` 让 `Number("evt-tool-1")=NaN`,前端 parseFrame 丢 frame)
- **retry**:`runOne` 区分 529 连续上限(`max529Retries`)vs 5xx 总上限(`maxRetries=10` = 11 次总尝试);`getRetryDelay(consecutive529 || attempt)` 退避
- **防递归**:派 sub-agent 时强制 `disallowedTools:['Agent']`,后台 sub-agent 不能继续派 sub-agent
- **parentSessionId 透传**:`dispatch metadata.parentSessionId` → `task.parentSessionId` → `agentRuntime.run({parentSessionId})`。缺这一步时,AgentTool 兜底成 `'sess-unknown'` → 孙子 task 继承占位符 → subagentNotifier 静默丢通知
- **sub-agent 续传**:`SubagentNotifier.handle(task)` 把 `<task-notification>` user 消息注入父 session 触发 queryLoop 重启一轮(走 Notifier 而不是直接 emit,因为父 session 不在跑时也要能排队)
- **session 切分**:`job.*` 事件 `sessionId` 来自 `task.parentSessionId`,前端 `useBackgroundTasks` 按 `useAgentStore.sessionId` 过滤 → 切到其它 session 后旧 job 不再显示
- **对应工具**:`BackgroundAgentResultTool`(阻塞轮询 terminal)/ `TaskOutputTool`(非阻塞拉 output) — AgentTool 派发 `run_in_background:true` 时由 LLM 在描述里看到

## 9. 关键 race condition

- `message_stop` race:minimax proxy 走完 `message_stop` 后 keep-alive 不关 socket → queryLoop 必须主动 break,否则 `appendAssistantMessage` 永远走不到 — `queryLoop.ts:243-251`(`sawMessageStop` 标志)
- v2 transcript resume:`store.read` 必须把 `type:'tool_use'` 顶层消息的 content 合并到上一条 assistant,否则下一轮 `tool_result` block 找不到对应 `tool_use_id` 报 Anthropic 2013 — `queryLoop.ts:140-185`
- BackgroundRuntime 重启:`store.load(id)` 拿不到 in-memory `TaskRecord` → `events()` 退化成"只回放历史"模式(`events/<id>.log`),客户端用 Last-Event-ID 续读

## 10. 会话压缩(阶段 1 已交付)

zai 主对话路径已支持自动压缩,3 道防线(`snip` → `forceReason` → `autocompact`) + circuit breaker 失败熔断。

- **运行时**:`packages/zn-agent-core/src/compat/runtime/compactService.ts`(单文件移植,`compactSession()` 接 modelCaller + transcript 边界 + summary message 写入)
- **集成测试**:`packages/zn-agent-core/test/`(从 opencc 拷贝的运行时测试,Bun-native,Node 下 `bun:bundle` import 抛错导致 27 个 pre-existing 失败,非迁移 bug)
- **Spec**:`docs/superpowers/specs/2026-07-19-zai-session-compaction-design.md`
- **Plan**:`docs/superpowers/plans/2026-07-19-zai-auto-compact-core.md`(19 tasks,阶段 1 已交付)

### Env 矩阵(`runtime/compact/index.ts` 顶部消费)

| Env | 默认 | 说明 |
|---|---|---|
| `ZAI_DISABLE_AUTO_COMPACT` | `0` | 设为 `1` 禁自动压缩,manual `/compact` 仍可用 |
| `ZAI_DISABLE_COMPACT` | `0` | 设为 `1` 禁所有压缩 |
| `ZAI_AUTOCOMPACT_PCT_OVERRIDE` | unset | 0-100,覆盖 token 阈值百分比 |
| `ZAI_AUTOCOMPACT_FAILURE_COOLDOWN_MS` | `300000`(5min) | ≥ 10000,失败后冷却时长 |
| `ZAI_MAX_ACTIVE_MESSAGES` | `200` | message-count forceReason 触发上限 |
| `ZAI_AUTOCOMPACT_FORCE_FLOOR_PCT` | `75` | 大上下文安全百分比(floor) |

### 已交付

- 主动压缩核心(`autoCompactIfNeeded`) + snip + forceReason 3 道防线
- Circuit breaker 状态机(`resolveAutoCompactCircuitBreakerState`,half-open 模式)
- Streaming 摘要生成(`compactConversation` 阶段 1 简化版)
- 本地 JSONL 日志(`~/.zai/logs/compact.jsonl`) + `logEvent` 模拟接口
- `runtime.compacted` SSE 事件 + 前端 toast 提示
- `compactService.ts` shim 化,保持 `/compact` 命令向后兼容
- Transcript schema:`CompactMetadata` + `compact_boundary` type
- `TranscriptStore.replaceWithBoundary`(链式压缩写盘,阶段 3 接 resume 路径)
- Coverage: 关键模块 line ≥ 92%,branch ≥ 80%(spec §11.6 目标)

### 阶段 2-4 待办(单独 plan)

- 阶段 2:`/compact` v2(PTL 自愈 + prompt cache 复用 + pre/post hook)
- 阶段 3:Transcript 回放支持 `compact_boundary`(链式压缩 + resume 跳过)
- 阶段 4:Reactive compact(API 413 / media_size / max_tokens 自愈) + API microcompact(`context_management.edits`)
- 阶段 1 限制:`manual /compact` 在大对话下仍可能 `kind: 'error'`(阶段 1 不做 PTL 自愈);`autocompact` / `conversation` branch coverage < 85%,阶段 2 补

## 11. 已知薄弱点

- `/agent/prompt` HARD_TIMEOUT 2h 没有自动化测试(常量 `agent.ts:34`)。AskUserQuestion 的等待不该被这条 timeout 掐死;若要让 ask 单独计时,应在 `askRegistry.register` 里接独立 setTimeout,而不是复用这里的 abortController。
- `BackgroundRuntime` retry 策略(529 vs 5xx)缺单元测试;`SubagentNotifier` 父 session 续传链路缺测试(关键路径任何一环断就静默丢通知)
- `translateRuntimeEvents` 没有针对错位/损坏 input 的回归测试
- MiniMax-M3 缺 `input_json_delta` 时,`buildOpenccQueryParams.ts` 不再做 fallback/路径推断;空 `tool_use.input` 直接 `throw InputValidationError`,由 `openccQueryBridge` catch 旁路 → 合成 `runtime.tool_result(isError:true)` + `runtime.error` + `runtime.done` 经 `__zaiEventBus` 发出,UI 可见错误而非静默跑错工具(commit `fb0437c7` 链)。已知边界:若上游 vendor 在 `message_stop` 之前不发 `content_block_stop` 给所有 block,仍可能丢 `runtime.tool_call`(已在 `message_stop` 兜底 throw,但 vendor 自身的 tool execution 仍可能跳过,见并行 tool_use 修复说明)。
- 工具调用结果有双层 watchdog:`ZAI_TOOL_RESULT_TIMEOUT_MS` 默认 60s,从 `content_block_start(tool_use)` 起等待匹配 `tool_result`;`ZAI_OPENCC_WATCHDOG_MS` 默认 300s,在 `message_stop` / `message_delta` 后兜底。超时会通过 `__zaiEventBus` 合成 `runtime.done + runtime.tool_result(isError)` 防止 UI 永久卡住;这是恢复机制,LLM 本轮不会收到合成的 tool_result。
- v2 transcript resume `tool_use` 顶层消息合并 + SubagentNotifier 注入后 user/tool_result 配对已有回归测试(`test/runtime/queryLoop-resume-2013.test.ts`、`test/runtime/subagentNotifier-2013.test.ts`),覆盖 tool_result+text 合并到同一条 user 的 Anthropic 协议约束
- abort / SSE 重连 / 模式切换乐观更新 revert / `AgentInputBox` 图片粘贴 + Esc 中断 路径无单元测试
- SSE state push 走 StateChangeBus 桥接层,见 docs/superpowers/specs/2026-07-19-sse-state-push-design.md
- BashTool `/tmp/zai-bash-*-cwd` (cwd trailer) 与 `/tmp/zai-bash-<taskId>.txt` (大输出持久化) 已修复: abort/timeout 路径主动清 cwd trailer，bashBackgroundTracker.evictFinished 同步 unlink 持久化文件。测试 seam `__cleanupTempFilesForTests()` 在 afterEach 兜底。log-event 加 `__setDataDirForTests` seam 防止单元测试污染真实 `~/.zai/`。详见 plan `2026-07-26-zai-bash-test-cleanup.md`.
- **关键监控项**:ZAI 实测 Bug / 修复验证流程须经 `ego-browser`(参见 `AGENTS.md` 强制开发规则)

### LLM 自切 cwd(`feat/cwd-tracking`)

zai 端实现的能力,把 opencc 上游 `bashProvider.ts` 的"shell trailer 跟踪 cwd" 移植过来:

- **持久化**:每个 session 维护自己的逻辑 cwd(`Map<sessionId, {cwd, updatedAt}>`),zai 多 session 共享一个 server 实例,所以**全局 cwd 存取要按 sessionId 作 key**
- **跟踪机制**:BashTool 在每条 `sh -c` 末尾追加 `\npwd -P >| /tmp/zai-bash-<taskId>-cwd` trailer;子进程退出后 `readFileSync` 读出,与上次比较,**不同就更新 `CwdStore`**
- **API 路径**:`GET /api/agent/sessions/:id/pwd` → `{ cwd } | 404`
- **前端轮询**:`useSessionCwd(sessionId)` SSE 推送 (cwd.changed) → `SessionCwdBridge` 把 cwd basename 写到 `useAppStore.instanceContext.cwdName` → `ConfigStatusBar` 展示
- **已知薄弱点**:
  - CwdStore 仅内存:server 进程重启后所有 session cwd 归零(transcript 重跑可恢复,符合预期)。
  - 前端 cwd 轮询失败时静默保留旧值:用户看到陈旧 cwd 但无错误提示。
  - `pwd -P` 在某些 shell 上不支持 `>|` noclobber(罕见,POSIX 必支持)
  - 不做目录权限限制:`resetCwdIfOutsideProject` 仍是 stub 返回 false(用户明确延后)
  - 不做 sub-agent cwd 隔离:`preventCwdChanges = !isMainThread` 未实现,sub-agent bash 也会污染 session cwd(主 agent 与 sub-agent 不隔离)

## 12. 启动所需环境

- `cwd`:从 `createApp({cwd, cwdName, token, port?})` 注入 `app.locals.instanceContext`;`tokenGuard` 已移除
- `dataDir`:默认 `~/.zai`(`ZAI_DATA_DIR` 覆盖);存 transcript + commands + v2 tasks + background tasks + plugin 缓存
- API key:`~/.zai/settings.json → env.ANTHROPIC_API_KEY`;`ANTHROPIC_BASE_URL` 同理
- 默认 model:`ANTHROPIC_DEFAULT_SONNET_MODEL ?? ANTHROPIC_SMALL_FAST_MODEL`,回退 `MiniMax-M3`
- Skills:默认 `[~/.agents/skills]`(与 Nova CLI / OpenCode / OpenCC 共享);`ZAI_SKILLS_DIRS=''` 显式禁用
- Sandbox:默认开(`executor:'child_process'`,`maxCpuMs:600_000`,`networkEgress:'allow'`);`ZAI_SANDBOX=off` 关闭;`ZAI_SANDBOX_ENV_ALLOWLIST=foo,bar` 控制 env 白名单
- MCP:从 `cwd/.mcp.json` 加载 → `MCPClientPool`;`mcpSkillLoading='off'` 关闭 `skill://`;zai 注册 SIGTERM/SIGINT 钩子;**尊重 Claude Code 的过滤字段** —— `enabledMcpjsonServers` / `disabledMcpjsonServers`(per-`.mcp.json` allowlist/blocklist,只在 project scope 生效)+ `disabledMcpServers`(user-scope 全局黑名单,post-merge 过滤;user 黑名单压过 project allowlist;enterprise exclusive 不被影响)。实现见 `packages/zai/src/server/services/mcpConfig.ts:88-108`,plan 在 `docs/superpowers/plans/2026-07-20-zai-mcp-disabled-servers.md`
- 插件:`resolveOpenccConfigDir()` → `~/.claude` 加载 OpenCC plugin(skills / agents / hooks)
- AGENTS.md 自动注入:每个 turn 调 `loadAgentsMd(options.cwd)` 拼到 system prompt 顶部;`enableAgentsMd:false` 关闭
- **bun: protocol loader**: zai dev 脚本走 `tsx --import ./bun-protocol.mjs` (从 `@zn-ai/zn-agent-core` 包内),把 opencc 86 处 `from 'bun:bundle'` 拦截到本地 `bun-shim.ts`。Node 22+ tsx 4.23+ 必需;漏掉这个 flag 会 `ERR_UNSUPPORTED_ESM_URL_SCHEME`。
- 前端鉴权:**默认不带** `X-Zai-Token` —— `lib/api.ts:1-35` 不读 localStorage,只有 `v2TaskApi / slash` 等少数手写 fetch 显式加;server 也不强制校验

## 13. 命令路由生命周期埋点 (`command.run` / `command.done`)

`/api/agent/command` 路由自 2026-08-16 起在入口 + 5 处出口 emit `command.run` / `command.done` 配对 SSE 事件,用于会话日志、调试、慢命令分析。设计借鉴 dsh `command/run` + `command/done` 模式。

**事件 schema**(`packages/zai/src/shared/events.ts` `CommandEvent`):

- `command.run`: `{ sessionId, commandId, name, args, argsTruncated?, trigger: 'user' | 'skill', ts }`
  - `commandId`: `crypto.randomUUID()`,单进程全局唯一,与 `command.done` 配对
  - `args`: > 1024 字节时截断,带 `argsTruncated: true`
  - `ts`: 触发瞬间, 手动填 `Date.now()`(非 eventBus 自动填充,这样 `run.ts` 与 `done.ts` 都能精确算 `durationMs`)
- `command.done`: `{ sessionId, commandId, name, result, durationMs, error?, ts }`
  - `result`: `'cleared' | 'compacted' | 'status' | 'message' | 'prompt' | 'error' | 'unknown'`(与 `routes/command.ts` 的 `res.json` type 严格对齐,新增 kind 必须同步这里)
  - `error`: 仅 `result='error'` 时填
  - `durationMs`: `done.ts - run.ts`

**5 处出口**(`routes/command.ts` ):

| 路径 | result | 触发位置 |
|------|--------|----------|
| skill fallthrough | `prompt` | `if (rendered !== null)` 分支 |
| unknown command | `unknown` | `if (!cmd)` 兜底 |
| local cmd cleared | `cleared` | `result.kind === 'cleared'` |
| local cmd compacted | `compacted` | `result.kind === 'compacted'` |
| local cmd status | `status` | `result.kind === 'status'` |
| local cmd message | `message` | `result.kind === 'message'` |
| local cmd error | `error` | `result.kind === 'error'` |
| PromptCommand success | `prompt` | `cmd.getPromptForCommand` 路径 |
| PromptCommand 抛错 | `error` | `cmd.getPromptForCommand` 内部 try/catch |
| outer catch | `error` | 路由最外层 try/catch(`initCommands` 抛错等) |

**全局事件**:`command.{run,done}` 已在 `eventBus.isGlobalEvent` 登记为 `true`,跨 sid 广播(所有 tab 都能看见,调试面板 / 活动指示器不依赖具体 sid)。

**前端路由**:`packages/zai/src/web/src/lib/eventSource.ts` `NAMED_EVENT_TYPES` 已同步加 `command.run` / `command.done`,`EventSource` 不会静默丢。当前前端**不主动** toast(留给后续 UI 优化),但 store 仍可读取用于调试面板。

**测试**:`test/server/routes/command.lifecycle.test.ts` — 14 个 case 覆盖 5 处出口 + 异常路径 + args 截断 + commandId 配对 + durationMs 边界。

## 14. 类型化 RPC Client Stub (`apiRpc`)

`packages/zai/src/shared/rpc.ts` 的 `RpcMethodMap` 是 **REST path + request/response** 的单一真相源,前后端共享类型。`scripts/generate-rpc-client.ts` AST 扫描它,生成 `packages/zai/src/web/src/lib/api.generated.ts`(generated stub,`as const` + `_Map[key]` 索引访问,无 drift 风险)。

**调用方式**(优先用):

```ts
import { apiRpc } from '@/lib/api.js'
const r = await apiRpc.agent.command.post({ name: 'clear', args: '', sessionId: 's1' })
if (r.type === 'cleared') { ... }   // discriminated union 自动收窄
```

**当前覆盖**(高频 5 个 route,渐进迁移第一步):

| Generated stub | Route |
|----------------|-------|
| `apiRpc.health.get()` | `GET /api/health` |
| `apiRpc.cli.get()` | `GET /api/cli` |
| `apiRpc.agent.command.post(body)` | `POST /api/agent/command` |
| `apiRpc.agent.prompt.post(body)` | `POST /api/agent/prompt` |
| `apiRpc.agent.sessions.get()` | `GET /api/agent/sessions` |
| `apiRpc.agent.sessions.post(body)` | `POST /api/agent/sessions` |

**加新 route**:
1. 在 `shared/rpc.ts` 的 `RpcMethodMap` 加一行 `${METHOD} /api/...`: `{ request: T, response: U }`
2. 跑 `pnpm run codegen:rpc` 重新生成 `api.generated.ts`
3. commit generated stub + RpcMethodMap 一起
4. 调用方用 `apiRpc.<path>.post(...)` 立即拿到类型

**兼容老 `api.get/post/put`**: `web/src/lib/api.ts` 仍导出 `api`(走 `apiBase.request` 同样的 fetch 实现),迁移期间共存;新代码优先 `apiRpc`。

**底层 fetch**:`web/src/lib/apiBase.ts` 抽 `request(method, path, body?)` — 路径含 `/api` 前缀的(generated stub)直接用,否则加前缀(老 `api.get/post/put`),自动跳过重复前缀。

**测试**:
- `test/web/lib/apiRpc.test.ts` — 12 个 case 验证 `apiBase.request` + `apiRpc` 各 method 调用 + 老 `api` 兼容
- `test/scripts/generate-rpc-client.test.ts` — 2 个 case 验证 codegen 产物与 committed 文件 byte-for-byte 一致(snapshot),防止 RpcMethodMap 改了但忘了跑 codegen

**限制**:
- 当前 codegen 不支持 path 含动态参数(`:id` 等)的 route — 含 `:id` 的 entry 会被 skip 并 warn。迁移这些 route 时单独处理(e.g. 加 helper `withPathId` 拼接 `\`/sessions/${id}\``)。
- 30 个 routes 渐进迁移的进度, 后续 plan 跟进 — 没有这条路线的统一 plan, 优先按"高频调用方"顺序迁(`agent.ts` → `cli.ts` → `plugin` → `git` → `fs`)。
