# AGENTS.md - opencc-web

## 项目概述

**opencc-web** 是 zai 的本地开发与运行工具集,在 `packages/zai`(本地 server + web 前端)与 `packages/zai-agent-core`(Agent 运行时核心库)两个 workspace 中实现 Agent 对话、流式 UI、命令 / Skill / 插件等能力。zai 仅监听 localhost,不依赖外部鉴权。

## 目录说明

| 目录 | 说明 |
|------|------|
| `packages/zai/` | zai server(Express + SSE)+ web 前端(React + Zustand + AntD)。`src/server/` 是路由与 service,`src/web/` 是 UI 与 store |
| `packages/zai-agent-core/` | Agent 运行时:`runtime/`(queryEngine, toolExecution, subagent, abort)+ `tools/`(Bash/Read/Edit/Write/Grep/Glob/AskUserQuestion/TodoWrite/Task*/Agent/...)+ `transcript/`(落盘 v2)+ `mcp/` + `plugins/`(OpenCC 插件加载)+ `skills/` |
| `docs/` | 设计 / 架构文档 |
| `examples/` | 示例配置 |
| `scripts/` | 仓库脚本 |

## 构建与测试

- 安装:`pnpm install`(workspace 是 `packages/*`)
- 测试:`pnpm test` = `vitest run`;前端测试在 `packages/zai/test/web/`,运行时测试在 `packages/zai-agent-core/test/`
- 运行 zai:在 `packages/zai` 下构建后启动,server 与 web 同进程;前端从 `/api/event` 收 SSE,路由全部挂在 `/api/*`

### zai server

`packages/zai/src/server/index.ts`:`createApp({cwd})` → Express,`initAgentRuntime(cwd)` 单例 `DefaultAgentRuntime`,`initSubagentNotifierLifecycle()` + `initBackgroundRuntime()` 串起 sub-agent 续写。

### zai-agent-core runtime

`packages/zai-agent-core/src/runtime/queryEngine.ts` 是核心:`run({prompt, cwd, transcriptId, parentSessionId, model, permissionMode, abortSignal})` → `AsyncIterable<RuntimeEvent>`,内含 maxTurns 默认 50 的循环、resume transcript、tool execution、hook 触发、skill injection。

## 提交规范

```
feat: 新功能 | fix: 修复 | docs: 文档 | refactor: 重构
chore: 工具链 | style: 格式 | test: 测试
```

## Agent 对话(深度要点)

### 数据流总览

```
web (Agent.tsx + useAgentStore)
   │  POST /api/agent/prompt
   ▼
server/routes/agent.ts (fire-and-forget)
   │  translateRuntimeEvents() 把 Anthropic-style runtime events 翻译成 ServerEvent
   │  eventBus.emit(ServerEvent)          ◄──── subagentNotifier.ts(同流程)
   ▼
GET /api/event (SSE, 15s 心跳, Last-Event-ID 续读)
   │
   ▼
web/lib/eventSource.ts → subscribeServerEvents() 派发到 applyRuntimeEvent / applySessionEvent / applyPromptAsk
```

`/agent/prompt` 是 fire-and-forget:立即 `res.json({sessionId})`,事件走 eventBus。`req.on('close')` 不 abort,只 `askRegistry.abortAll('client_disconnect')`,真正兜底是 **5min HARD_TIMEOUT**(`agent.ts:33`)。

### 关键文件

| 路径 | 职责 |
|------|------|
| `packages/zai/src/server/routes/agent.ts` | `/agent/prompt` + sessions CRUD + abort + skills + 命令 |
| `packages/zai/src/server/routes/answer.ts` | `/agent/answer` / `/agent/answer/reject` 注入 AskRegistry |
| `packages/zai/src/server/routes/event.ts` | `/api/event` SSE 路由 + 心跳 + 历史补发 |
| `packages/zai/src/server/services/eventBus.ts` | `ServerEventBus`(subscriber Set + 256 ring history)|
| `packages/zai/src/server/services/askRegistry.ts` | `AskRegistry.register/answer/reject/abortAll`,等 AskUserQuestion 答复 |
| `packages/zai/src/server/services/agentRuntime.ts` | `DefaultAgentRuntime` 单例 + skillsDirs 解析 + sandbox 默认 |
| `packages/zai/src/server/services/subagentNotifier.ts` | BackgroundRuntime 完成时 fire-and-forget 注入 `<task-notification>` 触发父 session 续写 |
| `packages/zai-agent-core/src/runtime/queryEngine.ts` | 主循环:modelCaller → 累积 assistantText/thinkingText/toolUseBlocks → 持久化 → 调 executeToolsStreaming |
| `packages/zai-agent-core/src/runtime/streamAdapter.ts` | `wrapWithZaiMeta` 给每个上游事件加 eventId/sessionId/ts/turnIndex |
| `packages/zai-agent-core/src/runtime/toolExecution.ts` | 串行 yield `tool_use:start|ask_pending|done|error|invalid|denied` + 落 v2 tool_use/tool_result |
| `packages/zai-agent-core/src/runtime/canUseTool.ts` | `defaultCanUseToolFactory`:Bash 走 sandbox allow/denylist,Agent 直接 allow |
| `packages/zai/src/shared/events.ts` | zod discriminatedUnion 定义 `ServerEvent`(runtime/session/job/prompt/system 五通道)|
| `packages/zai/src/web/src/store/useAgentStore.ts` | Zustand store,核心 reducer:`applyRuntimeEvent` / `applySessionEvent` / `applyPromptAsk` |
| `packages/zai/src/web/src/store/useEventStream.ts` | 把 ServerEvent 派发到对应 store |
| `packages/zai/src/web/src/pages/Agent.tsx` | 主页面 + `MessageBubble` + `ToolCallBlock` + `ThinkingBlock` |
| `packages/zai/src/web/src/components/AgentInputBox.tsx` | 输入框 + 状态行(spinner + 任务摘要)+ slash autocomplete + 图片粘贴/拖拽 |
| `packages/zai/src/web/src/components/QuestionCard.tsx` | AskUserQuestion 渲染(Radio / Checkbox + Notes + Review)|
| `packages/zai/src/web/src/components/toolRenderers/` | 各工具自定义 renderer;`Edit/Write` 走 `DiffBlock` 整接管 |
| `packages/zai/src/web/src/components/TodoZone.tsx` | TodoWrite 唯一可视化通道(不写 messages)|

### SSE 事件通道(shared/events.ts)

- **runtime.\***: started / delta(文本)/ thinking(独立通道,key 隔离) / tool_call(必带 toolUseId, server 从 upstream block.id 取) / tool_result(必带 toolUseId + toolName + input)/ done / aborted / error(可带 toolUseId 指代具体工具)
- **session.\***: created / deleted / renamed
- **job.\***: started / progress / done / failed(可带 `sessionId` 让前端按 session 过滤)
- **prompt.ask**: sessionId + toolUseId + questions[{question, header, options[label,description]}]
- **system.\***: server.connected / server.error / toast / branch.changed

### RuntimeEvent 翻译表(agent.ts:81-302)

| runtime 上游 | → ServerEvent |
|---|---|
| `message_start` | `runtime.started` |
| `content_block_start` (tool_use) | 缓存 pending toolUseId/Name/input |
| `content_block_delta` text_delta | `runtime.delta` |
| `content_block_delta` thinking_delta | `runtime.thinking` |
| `content_block_delta` input_json_delta | 累积到 toolInputBuffer |
| `content_block_stop` (有 pending tool_use) | `runtime.tool_call` |
| `tool_use:start` / `tool_use:done` | `runtime.tool_call` / `runtime.tool_result` |
| `tool_use:ask_pending` | `prompt.ask` |
| `tool_use:error` / `:invalid` / `:denied` | `runtime.error`(带 toolUseId)|
| `message_stop` | `runtime.done` |
| for-await 兜底(未见到 message_stop)| `runtime.done`(`agent.ts:299-301`)|

### 前端 store 关键设计

- **Stream block key** = `${sendSeq}:${turnIndex}:${textSegmentRev}:${blockIndex}:kind`
  - `sendSeq` 每发一轮消息 +1 → 跨轮次不冲撞
  - `textSegmentRev` 在 `tool_use:start` 与(非 streaming 状态的)`runtime.started` 时 +1 → 工具边界 / 续写 turn 把文字段切到独立 bubble
  - `segmentedToolUseIds` 记录已 bump 的 toolUseId,防重复
- **TodoWrite 守卫**:`upsertToolCall` 收到 `name === 'TodoWrite'` 立刻吞掉不写 messages,在 `tool_use:done` 阶段解析 `input.todos` 写入 `todosBySession[sid]`;损坏静默忽略
- **任务自动清空**:`scheduleTaskListClearIfAllDone`,todos + v2 tasks 全部 completed(含 v2 的 `deleted`)后 5s 自动从 store 移除
- **V2 TaskList**:与 TodoWrite 独立的 `v2TasksBySession`,由 `TaskCreate/TaskUpdate` 工具触发,server 持久化到 `~/.zai/tasks/<sid>.json`,前端通过 `/api/agent/sessions/:id/v2-tasks` 拉全量
- **runtime.error 路由**:带 toolUseId → `upsertToolCall` 写成 `tool_use:error` 让 `ToolCallBlock` 切到错误态;不带 → push 一条 `runtime.error` 进 messages 让 `MessageBubble` 红色 Card 渲染
- **流式 markdown 拆分**:`splitMarkdownOnIncomplete` 切完整段 vs tail(避免半截 fenced code block 跳变),流式期跳过 `react-markdown` 整段重渲

### AskUserQuestion 端到端流

```
tool_use (AskUserQuestion) 
  → toolExecution yield tool_use:ask_pending
  → translateRuntimeEvents → prompt.ask SSE
  → useAgentStore.applyPromptAsk → pendingAsk
  → QuestionCard 渲染
用户点 Submit → POST /api/agent/answer
  → AskRegistry.answer(toolUseId) resolve register Promise
  → AskUserQuestionTool.call 拿到 answers → 返回
  → toolExecution yield tool_use:done
前端:pendingAsk = null + upsertToolCall 收敛
```

### 关键 race condition(注释里有详细说明)

- minimax proxy 走完 `message_stop` 后 keep-alive 不关 socket → queryEngine 必须主动 `break for-await modelStream`(`queryEngine.ts:243-251`)
- `req.on('close')` 不能 abort(fire-and-forget 设计),否则 LLM 回复写不进 transcript
- `tool_use:done` 不带 input → server 不兜底 `{}`,client 用 `typeof === 'object' && !Array.isArray` 严格判,避免 `{}` 当 truthy 覆盖 prev.input
- TodoWrite 的 start 被守卫吞掉 → done 路径必须从 prev 同 toolUseId 拿 name/input;server 的 `tool_use:done` 因此必带 toolName/input

### 已知薄弱点

- `/agent/prompt` 的 HARD_TIMEOUT 5min 没有自动化测试
- `AgentInputBox` 图片粘贴 + URL 释放 + Esc 中断 路径缺少测试
- abort / SSE 重连 / 模式切换乐观更新 revert 路径无单元测试
- `translateRuntimeEvents` 没有针对错位/损坏 input 的回归测试
- `Agent.tsx` 顶层只有一个 "不再渲染 BottomStatusBar" 的 smoke test

### 启动所需环境

- `cwd`:从 `createApp({cwd})` 注入到 `app.locals.instanceContext`,所有路由共用
- `dataDir`:默认 `~/.zai`(transcript + commands + v2 tasks + plugin 缓存)
- API key:`~/.zai/settings.json → env.ANTHROPIC_API_KEY` 或真环境变量;`ANTHROPIC_BASE_URL` 同理
- 默认 model:`ANTHROPIC_DEFAULT_SONNET_MODEL ?? ANTHROPIC_SMALL_FAST_MODEL`,否则回退 `MiniMax-M3`
- Skills:默认 `[~/.agents/skills]`;`ZAI_SKILLS_DIRS=''` 显式禁用
- Sandbox:`ZAI_SANDBOX=off` 关闭,默认必须开(BashTool 否则拒绝);`ZAI_SANDBOX_TIMEOUT_MS` 默认 600_000ms
- MCP:从 `cwd/.mcp.json` 加载,`mcpSkillLoading='off'` 关闭 skill:// 资源
- 插件:`resolveOpenccConfigDir()` → `~/.claude`,加载 OpenCC plugin(skills / agents / hooks)
- 前端鉴权:几乎所有 fetch 带 `X-Zai-Token: localStorage['zai-token']`,但 server 不强制校验

<!-- CODEGRAPH_START -->
## CodeGraph

配置了 CodeGraph MCP 服务器（CLI v1.4.1），提供基于 AST 解析的代码知识图谱查询。

### MCP 工具

v1.4.1 的 MCP server **仅暴露 1 个工具** `codegraph_explore`，把 search / callers / callees / impact / node / files / status 的能力收拢到一个调用里。

| 工具 | 说明 |
|------|------|
| `codegraph_explore` | 主入口。接受自然语言问题或符号名列表，返回相关符号源码（按文件分组）+ 调用路径 + blast radius 摘要。Read 等价 —— **不要把返回的源码再 Read 一遍**。 |

### 使用原则

- **优先用 MCP `codegraph_explore`** — 单调用覆盖绝大多数代码理解场景，无需 grep + read 轮询
- **信任 AST 结果** — 来自完整 AST 解析，无需 grep 二次验证
- **索引滞后** — 结果横幅列出待索引文件，对此用 Read 核实；其余内容以 codegraph 为准
- **未初始化** — `.codegraph/` 不存在时运行 `codegraph init -i`

> ⚠️ `codegraph_context` / `codegraph_trace` 在当前 v1.4.1 中**均不可用**，请勿引用。
<!-- CODEGRAPH_END -->
