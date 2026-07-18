# AGENTS.md - opencc-web

## 项目概述

**opencc-web** 是 zai 的本地开发与运行工具集,在 `packages/zai`(Express + SSE server + React/Zustand/AntD 前端)与 `packages/zai-agent-core`(Agent 运行时核心库)两个 workspace 中实现 Agent 对话、流式 UI、命令/Skill/插件等能力。zai 仅监听 localhost,不依赖外部鉴权。

## 目录说明

| 目录 | 说明 |
|------|------|
| `packages/zai/` | `src/server/` 路由 + service,`src/web/` UI + store,`src/shared/` zod schema |
| `packages/zai-agent-core/` | `runtime/`(`queryEngine` 主循环 + `query` shim + `streamAdapter` / `toolExecution` / `canUseTool` / `subagent` / `background/`)+ `tools/`(Bash/Read/Edit/Write/AskUserQuestion/TodoWrite/Task*/Agent/BackgroundAgent/...)+ `transcript/`(v2 落盘)+ `mcp/` + `plugins/`(OpenCC 插件)+ `skills/` |
| `docs/  examples/  scripts/` | 设计文档 / 示例 / 仓库脚本 |

## 核心入口

- **`packages/zai-agent-core/src/runtime/queryEngine.ts`** — 主循环 `export async function* queryEngine(options, config)`:`while (turn < maxTurns=50)` → 加载 skills → 连 MCP → assemble tools → resume transcript → build system prompt → 跑 hooks → `for-await modelCaller`(遇 `message_stop` 主动 break)→ 累积 text/thinking/tool_use → 落盘 v2 → `executeToolsStreaming` → 处理 `__pendingSkillInjection` → loop。`query.ts` 是 re-export shim,`contract.ts:DefaultAgentRuntime.run` 代理到 `query()`
- **`packages/zai/src/server/index.ts`** — `createApp({cwd, cwdName, token, port?})` 按顺序 `initAgentRuntime → initSubagentNotifierLifecycle → initBackgroundRuntime`;挂 14 个 router 到 `/api/*`;`express.json({limit:'20mb'})`(图片粘贴);`/api` 整段禁缓存

## 数据流

**主对话路径**:

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

**后台任务路径**(平行子系统,见下 § BackgroundRuntime):

```
web (useBackgroundTasks) ─POST /api/tasks→ DefaultBackgroundRuntime.dispatch
   → 调度器 for-await agentRuntime.run → TaskEvent(strip meta)
   → JsonTaskStore.appendEvent [先写盘] + emitter.emit [再通知]
   → GET /api/tasks/:id/events (SSE, ev.seq 作 id:)
```

`/agent/prompt` 不 abort(fire-and-forget),真正兜底是 **5 分钟 HARD_TIMEOUT**(`agent.ts:34`)。

## 关键文件

| 路径 | 职责 |
|------|------|
| `packages/zai/src/server/routes/agent.ts` | `/agent/prompt` (fire-and-forget + HARD_TIMEOUT) + sessions CRUD + abort |
| `packages/zai/src/server/routes/{answer,event,tasks,v2Tasks,agentSettings,slash}.ts` | AskRegistry 注入 / SSE 路由 / 后台任务 CRUD+SSE / V2 TaskList 兜底 / 模型设置 / slash 命令 |
| `packages/zai/src/server/services/eventBus.ts` | `ServerEventBus`(subscriber Set + 256 ring history)|
| `packages/zai/src/server/services/askRegistry.ts` | `register/answer/reject/abortAll`,等 AskUserQuestion 答复 |
| `packages/zai/src/server/services/agentRuntime.ts` | `DefaultAgentRuntime` 单例 + `resolveSkillsDirs`(`~/.agents/skills`)+ `resolveSandbox`(`executor:'child_process'` / `maxCpuMs:600_000`)+ 启动时 `initCommands` |
| `packages/zai/src/server/services/backgroundRuntime.ts` | `initBackgroundRuntime` 包 `DefaultBackgroundRuntime` 注入 `onTaskStateChange` → emit `job.*` + 串 `SubagentNotifier.handle(task)`;`initSubagentNotifierLifecycle` 必须先注册 |
| `packages/zai/src/server/services/subagentNotifier.ts` | 后台 task terminal 时 fire-and-forget 注入 `<task-notification>` 触发父 queryEngine 续传 |
| `packages/zai-agent-core/src/runtime/{queryEngine,streamAdapter,toolExecution,canUseTool}.ts` | 主循环 / `wrapWithZaiMeta` 加 meta / `executeToolsStreaming` 串行 tool_use:* / `defaultCanUseToolFactory`(Bash 走 sandbox,Agent 直接 allow)|
| `packages/zai-agent-core/src/runtime/background/{BackgroundRuntime,DefaultBackgroundRuntime,store/JsonTaskStore,types}.ts` | `dispatch/get/list/cancel/events/shutdown` interface + JsonTaskStore 持久化 + retry(529 连续上限 vs 5xx 总上限 maxRetries=10)|
| `packages/zai-agent-core/src/{agents/agentsMdLoader,skills/index,mcp/MCPClientPool,plugins/{index,HookRunner}}.ts` | `loadAgentsMd` 注入 system prompt 顶部 / `loadSkillsFromDirs` + PendingSkillInjection / MCP 池 + SIGTERM 钩子 / `DefaultPluginRuntime` + 8 个 hook event |
| `packages/zai-agent-core/src/tools/{BackgroundAgentResultTool,TaskOutputTool}/` | 阻塞读 / 非阻塞拉 task output |
| `packages/zai/src/shared/events.ts` | zod discriminatedUnion:`runtime.*` / `session.*` / `job.*` / `prompt.ask` / `system.*` 五通道 |
| `packages/zai/src/web/src/store/useAgentStore.ts` | Zustand store:`applyRuntimeEvent` / `applySessionEvent` / `applyPromptAsk` / `applyJobEvent` / `applySystemEvent` + `upsertToolCall` / `scheduleTaskListClearIfAllDone` 5s 自动清空 |
| `packages/zai/src/web/src/lib/{api,v2TaskApi}.ts` + `hooks/useBackgroundTasks.ts` | 通用 fetch(`api.ts` 默认不带 `X-Zai-Token`)+ v2 task 拉取 + job dock 按 sessionId 切分 |

## SSE 事件通道(`shared/events.ts`)

- **runtime.\***:started / delta(text) / thinking(独立通道) / tool_call / tool_result(必带 toolUseId+toolName+input) / done / aborted / error(可带 toolUseId)
- **session.\***:created / deleted / renamed
- **job.\***:started(progress / done / failed,可带 `sessionId` 让前端按 session 过滤;`kind:'agent_task'` 带 `taskId`)
- **prompt.ask**:`sessionId + toolUseId + questions[{question, header, options}]`
- **system.\***:server.connected / server.error / toast / branch.changed

## RuntimeEvent 翻译表(`routes/agent.ts` 内 `translateRuntimeEvents`)

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
| `tool_use:error` / `:invalid` / `:denied` | `runtime.error`(带 toolUseId)|
| `message_stop` | `runtime.done`(`queryEngine` 主动 yield,不再 wrapWithZaiMeta)|

## 前端 store 关键设计

- **Stream block key** = `${sendSeq}:${turnIndex}:${textSegmentRev}:${blockIndex}:kind`
  - `sendSeq` 每次发消息 +1 → 跨轮次不冲撞(`wrapWithZaiMeta` 计数器每调用归零 → 必须前端再 namespace)
  - `textSegmentRev` 在 `tool_use:start` 时 +1,把文字段切到独立 bubble;`segmentedToolUseIds` 防重复 bump
- **TodoWrite 守卫**:`upsertToolCall` 收到 `name==='TodoWrite'` 立刻吞掉不写 messages,在 `:done` 阶段解析 `input.todos` 写 `todosBySession[sid]`;损坏静默忽略
- **V2 TaskList**:`v2TasksBySession` 与 TodoWrite 独立,server 持久化到 `~/.zai/tasks/<sid>.json`,前端通过 `/api/agent/sessions/:id/v2-tasks` 拉全量兜底
- **runtime.error 路由**:带 toolUseId → `upsertToolCall` 写成 `tool_use:error`;不带 → push 一条进 messages 红色 Card
- **任务自动清空**:`scheduleTaskListClearIfAllDone`,todos + v2 tasks 全部终态(completed / deleted)后 5s 自动从 store 移除

## AskUserQuestion 端到端流

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

## BackgroundRuntime / 后台任务子系统

`BackgroundRuntime` 是和 `AgentRuntime` 平级的另一套持久化任务系统。`POST /api/tasks` → `dispatch` 入队 + 调度器在并发槽内 `for-await agentRuntime.run({parentSessionId, disallowedTools:['Agent']})` → 拿 `RuntimeEvent` 转 `TaskEvent`(strip meta)→ `JsonTaskStore.appendEvent` 写盘先于 emit → SSE 路由把 `ev.seq` 作 `id:` line 走 `Last-Event-ID` 续读。任务结束发 `task.ended` 哨兵。

**关键设计**:
- **写盘先于 emit**:服务端崩溃 / 客户端断网 → 重连用 `Last-Event-ID` 补齐。`tasks.ts:88-103` 把 `ev.seq` 显式作为 SSE `id:` line(之前 `...spread eventId` 让 `Number("evt-tool-1")=NaN`,前端 parseFrame 丢 frame)
- **retry**:`runOne` 区分 529 连续上限(`max529Retries`)vs 5xx 总上限(`maxRetries=10` = 11 次总尝试);`getRetryDelay(consecutive529 || attempt)` 退避
- **防递归**:派 sub-agent 时强制 `disallowedTools:['Agent']`,后台 sub-agent 不能继续派 sub-agent
- **parentSessionId 透传**:`dispatch metadata.parentSessionId` → `task.parentSessionId` → `agentRuntime.run({parentSessionId})`。缺这一步时,AgentTool 兜底成 `'sess-unknown'` → 孙子 task 继承占位符 → subagentNotifier 静默丢通知
- **sub-agent 续传**:`SubagentNotifier.handle(task)` 把 `<task-notification>` user 消息注入父 session 触发 queryEngine 重启一轮(走 Notifier 而不是直接 emit,因为父 session 不在跑时也要能排队)
- **session 切分**:`job.*` 事件 `sessionId` 来自 `task.parentSessionId`,前端 `useBackgroundTasks` 按 `useAgentStore.sessionId` 过滤 → 切到其它 session 后旧 job 不再显示
- **对应工具**:`BackgroundAgentResultTool`(阻塞轮询 terminal)/ `TaskOutputTool`(非阻塞拉 output) — AgentTool 派发 `run_in_background:true` 时由 LLM 在描述里看到

## 关键 race condition

- `message_stop` race:minimax proxy 走完 `message_stop` 后 keep-alive 不关 socket → queryEngine 必须主动 break,否则 `appendAssistantMessage` 永远走不到 — `queryEngine.ts:243-251`(`sawMessageStop` 标志)
- v2 transcript resume:`store.read` 必须把 `type:'tool_use'` 顶层消息的 content 合并到上一条 assistant,否则下一轮 `tool_result` block 找不到对应 `tool_use_id` 报 Anthropic 2013 — `queryEngine.ts:140-185`
- BackgroundRuntime 重启:`store.load(id)` 拿不到 in-memory `TaskRecord` → `events()` 退化成"只回放历史"模式(`events/<id>.log`),客户端用 Last-Event-ID 续读

## 已知薄弱点

- `/agent/prompt` HARD_TIMEOUT 5min 没有自动化测试(常量 `agent.ts:34`)
- `BackgroundRuntime` retry 策略(529 vs 5xx)缺单元测试;`SubagentNotifier` 父 session 续传链路缺测试(关键路径任何一环断就静默丢通知)
- `translateRuntimeEvents` 没有针对错位/损坏 input 的回归测试
- v2 transcript resume `tool_use` 顶层消息合并(`queryEngine.ts:140-185`)缺回归测试,易在改 schema 时回归 2013
- abort / SSE 重连 / 模式切换乐观更新 revert / `AgentInputBox` 图片粘贴 + Esc 中断 路径无单元测试

## 启动所需环境

- `cwd`:从 `createApp({cwd, cwdName, token, port?})` 注入 `app.locals.instanceContext`;`tokenGuard` 已移除
- `dataDir`:默认 `~/.zai`(`ZAI_DATA_DIR` 覆盖);存 transcript + commands + v2 tasks + background tasks + plugin 缓存
- API key:`~/.zai/settings.json → env.ANTHROPIC_API_KEY`;`ANTHROPIC_BASE_URL` 同理
- 默认 model:`ANTHROPIC_DEFAULT_SONNET_MODEL ?? ANTHROPIC_SMALL_FAST_MODEL`,回退 `MiniMax-M3`
- Skills:默认 `[~/.agents/skills]`(与 Nova CLI / OpenCode / OpenCC 共享);`ZAI_SKILLS_DIRS=''` 显式禁用
- Sandbox:默认开(`executor:'child_process'`,`maxCpuMs:600_000`,`networkEgress:'allow'`);`ZAI_SANDBOX=off` 关闭;`ZAI_SANDBOX_ENV_ALLOWLIST=foo,bar` 控制 env 白名单
- MCP:从 `cwd/.mcp.json` 加载 → `MCPClientPool`;`mcpSkillLoading='off'` 关闭 `skill://`;zai 注册 SIGTERM/SIGINT 钩子
- 插件:`resolveOpenccConfigDir()` → `~/.claude` 加载 OpenCC plugin(skills / agents / hooks)
- AGENTS.md 自动注入:每个 turn 调 `loadAgentsMd(options.cwd)` 拼到 system prompt 顶部;`enableAgentsMd:false` 关闭
- 前端鉴权:**默认不带** `X-Zai-Token` —— `lib/api.ts:1-35` 不读 localStorage,只有 `v2TaskApi / slash` 等少数手写 fetch 显式加;server 也不强制校验

<!-- CODEGRAPH_START -->
## CodeGraph

配置了 CodeGraph MCP 服务器(CLI v1.4.1),提供基于 AST 解析的代码知识图谱查询。**仅暴露 1 个工具** `codegraph_explore`,把 search / callers / callees / impact / node / files / status 的能力收拢到一个调用里。

- **优先用 MCP `codegraph_explore`** —— 单调用覆盖绝大多数代码理解场景,无需 grep + read 轮询
- **信任 AST 结果** —— 来自完整 AST 解析,无需 grep 二次验证
- **索引滞后** —— 结果横幅列出待索引文件,对此用 Read 核实;其余内容以 codegraph 为准
- **未初始化** —— `.codegraph/` 不存在时运行 `codegraph init -i`

> ⚠️ `codegraph_context` / `codegraph_trace` 在当前 v1.4.1 中**均不可用**,请勿引用。
<!-- CODEGRAPH_END -->
