# opencc-web 架构研究报告

> 仅基于代码静态阅读 + AST(codegraph)+ 仓库 AGENTS.md 元信息
> 调研日期:本次会话;读模式,未修改任何项目文件
> 工作目录:`/Users/ethan/code/opencc-web`

---

## 1. 总体架构概览

opencc-web 是一个 monorepo,包含两个 workspace,目标是把 OpenCC Agent 运行时移植到一个本地 Web 形态:**zai 是一个单进程、只听 localhost、零外部鉴权**的桌面化工具平台,提供 CLI 启动器(`zai dev` / `zai start`)+ Vite HMR 的开发态 + Express+SSE 服务 + React/Zustand/AntD 前端;**zai-agent-core 是从 OpenCC 抽取的运行时核心库**,负责对话循环、工具执行、Skills/MCP/Plugins 加载、transcript 持久化、后台任务调度、上下文压缩、多 provider 模型调用桥接等。两个 workspace 之间通过 `workspace:*` 协议依赖(`packages/zai/package.json` 显式依赖 `@zn-ai/zai-agent-core`),依赖方向单向:zai → agent-core,无回环。

整个系统由三大事件通道支撑——**主对话 SSE**(POST /agent/prompt fire-and-forget + GET /event 长连接)、**后台任务 SSE**(POST /tasks 派发 + GET /tasks/:id/events 续读)、**state.\* 推送**(cwd.changed / bash_task.changed / v2_task.changed / agent_task.changed,合并到一个 eventBus 走同一 SSE 链路)——前端 Zustand 通过统一的 `useEventStream` 钩子订阅,reducers 按事件 type 切到 useAgentStore 的多 session 命名空间(4 张并行 map:todosBySession / v2TasksBySession / bashTasksBySession / agentTasksBySession)。模型侧通过 `modelCaller` 抽象让 Anthropic SDK 与手写 OpenAI-compatible HTTP 客户端(`openaiClient.ts` ~648 行)在 `provider:'openai'` 下无缝替换,后者实现了 schema 归一化、SSE→Anthropic event 翻译、`reasoning_content → thinking` 桥接、`paic.com.cn` 自动加 plugin 头等针对性适配。

---

## 2. Workspace 概览

### 2.1 `packages/zai/`(@zn-ai/zai v0.0.8)

| 文件 / 目录 | 一句话职责 |
|---|---|
| `src/cli/index.ts` | Commander 入口:zai / zai dev / zai start 子命令分发,运行时读 package.json 拿真实版本号 |
| `src/cli/dev.ts` / `src/cli/start.ts` | dev 模式(Vite HMR + Express 双端口)、start 模式(静态 SPA + API) |
| `src/server/index.ts` | **createApp(opts) 工厂**:装载 6 个核心服务单例 + 19 个 router(`server/index.ts:41-138`) |
| `src/server/types.ts` | AppOptions 接口(cwd/cwdName/token/port?) |
| `src/server/routes/*.ts` | 19 个 router(详见 §3.2) |
| `src/server/services/*.ts` | 6 大核心服务单例(详见 §3.3)+ 资源/CLI 检测/权限/spawner/spawn 帮助类 |
| `src/server/middleware/noCache.ts` | 禁 /api/* 浏览器缓存(`server/index.ts:89`) |
| `src/shared/events.ts` | zod discriminatedUnion:`runtime.*` / `session.*` / `job.*` / `prompt.ask` / `system.*` / `state.*` 五通道 |
| `src/shared/types.ts` | SseEvent / SseEventType / ConfigTool / ProviderProfile / KNOWN_REGISTRIES 等共享类型 |
| `src/web/src/main.tsx` / `router.tsx` | React 入口 + 路由(Agent / Config / Directory / Login / Resources / Tools / Dashboard) |
| `src/web/src/store/useAgentStore.ts` | 主 store:`applyRuntimeEvent` / `applySessionEvent` / `applyPromptAsk` / `applyJobEvent` / `applySystemEvent` + `upsertToolCall` + 5s 自动清理 |
| `src/web/src/store/useAppStore.ts` | 全局 UI state:`sidebarCollapsed` / `settingsDrawerOpen` / `settingsTheme` / `outputStyle` / `maxVisibleMessages` / `instanceContext` |
| `src/web/src/store/useEventStream.ts` | SSE 客户端(`fetch + ReadableStream` 解析,自定义 header 支持 Last-Event-ID)→ eventBus reducer 分派 |
| `src/web/src/lib/eventSource.ts` | 共享 SSE frame 解析工具(浏览器 EventSource 之外,用于 task SSE 等需要自定义 header 的场景) |
| `src/web/src/lib/{api,v2TaskApi,taskApi,bashReplApi}.ts` | REST 客户端封装 |
| `src/web/src/hooks/use*.ts` | useBackgroundTasks / useBashBackgroundTasks / useSessionCwd / useConversationInfo / useAutoScrollToBottom / useScrollFollow 等 |
| `src/web/src/pages/Agent.tsx` | 主对话页面:stream block 渲染、输入框、任务 dock、QuestionCard、ApproveDrawer |
| `src/web/src/components/*.tsx` | AgentInputBox / SettingsDrawer / QuestionCard / TaskDrawer / TodoZone / TaskDock / SessionCwdBridge / LogPanel / ConfigStatusBar 等 |

### 2.2 `packages/zai-agent-core/`(@zn-ai/zai-agent-core v0.1.0)

| 文件 / 目录 | 一句话职责 |
|---|---|
| `src/runtime/queryLoop.ts` | **核心主循环**`queryLoop(options, config)`:turn 循环 + skills/MCP/plugins 装配 + transcript resume + tool 串行执行 + 退出语义控制 |
| `src/runtime/queryEngine.ts` | 主循环的下一代实现(turn=0..maxTurns-1 显式 for 循环,父子 user 消息合并,resume 时 store.read 容错) |
| `src/runtime/query.ts` | re-export shim(把 queryLoop 包成 query) |
| `src/runtime/contract.ts` | DefaultAgentRuntime 包装:run/abort/listSessions/readSession/patchSession/removeSession |
| `src/runtime/streamAdapter.ts` | wrapWithZaiMeta + toRuntimeErrorEvent + toAbortedEvent + Anthropic→RuntimeEvent 翻译 |
| `src/runtime/toolExecution.ts` | executeToolsStreaming:串行 yield 每个 tool_use:start/done/denied/error 事件,挂 PreToolUse/PostToolUse 钩子 |
| `src/runtime/canUseTool.ts` | defaultCanUseToolFactory:Bash 走 sandbox,Agent 直接 allow |
| `src/runtime/cwdStore.ts` | per-session cwd Map(`CwdStore.get/set/getOrInit/has/delete/clear`),仅内存,进程重启即归零 |
| `src/runtime/stateChangeBus.ts` | agent-core 内部状态变更总线(`cwd.changed` / `bash_task.changed` / `v2_task.changed` / `agent_task.changed`) |
| `src/runtime/openaiShim.ts` | 对外暴露 openaiClient 的 duck-type Anthropic SDK |
| `src/runtime/events.ts` | RuntimeEvent 联合类型定义 |
| `src/runtime/types.ts` | QueryOptions / RuntimeConfig / SandboxConfig / ModelCaller |
| `src/runtime/index.ts` | runtime 子模块 barrel |
| `src/runtime/skills/{loader,frontmatter,promptBuilder,substitute,types,index}.ts` | Skills 加载、frontmatter 解析、prompt 拼接、变量替换、unconditional vs conditional 分类 |
| `src/runtime/background/{BackgroundRuntime,DefaultBackgroundRuntime,index,registry,retryPolicy,types}.ts` | 后台任务派发 + 调度 + retry 策略(`max529Retries=3` / `maxRetries=10` / `maxDelayMs=32s`) |
| `src/runtime/background/store/{JsonTaskStore,TaskStore,atomicWrite}.ts` | JSON 持久化 + atomicWrite + TaskStore 接口 |
| `src/runtime/streaming/{streamingToolExecutor,types,index}.ts` | streamingToolExecution 并行池(spec §2.5,阶段 2 wire-in) |
| `src/runtime/compact/{index,autocompact,force-reason,snip,conversation,cleanup,context-window,tracking,types,log-event}.ts` | 阶段 1 自动压缩:9 个小文件,每文件 ≤ 200 行 |
| `src/runtime/compactService.ts` | /compact 旧 contract shim(向后兼容) |
| `src/runtime/errors/{classification,index,loopGuard,maxOutputTokens,reactiveCompact}.ts` | 错误分类 + loop guard + max output tokens 自愈 + reactive compact 钩子 |
| `src/runtime/nudge/{analyze,hooks,inject,index}.ts` | 续推(continuation nudge)机制 |
| `src/runtime/attachment/{get,index,prefetchMemory}.ts` | wirein-prefetch + memory 预取 |
| `src/runtime/summary/{index,stepCounter,summaryStore,toolUseSummary}.ts` | 摘要 + 步数计数 + toolUse summary |
| `src/runtime/subagent.ts` | buildSubagentContext |
| `src/runtime/abort.ts` | abortSession(信号级中断) |
| `src/runtime/permissionMode.ts` | 权限模式状态机 |
| `src/transcript/{store,persistence,repair,serialization,paths,types}.ts` | TranscriptStore + v2 schema(`CompactMetadata` / `compact_boundary`) + repair(修复 2013 配对) + 原子写 |
| `src/mcp/{MCPClientPool,MCPToolAdapter,SkillResourceAdapter,mcpInstructions,transport,permission-matcher,jsonSchemaToZod,tool-name,errors,types}.ts` | MCP 客户端池 + tool 适配 + skill:// 资源 + schema→zod |
| `src/plugins/{index,HookRunner,defaultHookExecutor,registry,manifest,paths,errors,types}.ts` + `components/{hooks,mcp,commands,agents}.ts` + `sources/*` | OpenCC plugin runtime + 8 个 hook event(SessionStart/UserPromptSubmit/PreToolUse/PostToolUse/Stop/...) |
| `src/agents/{agentsMdLoader,memoryLoader,memoryWatcher}.ts` | AGENTS.md 自动注入 system prompt 顶部 + 1s mtime watcher + clearMemoryCache |
| `src/tools/{Tool,index,legacyAdapter,readState}.ts` + 18 个 tool 子目录 | Tool 接口 + getZaiRuntimeTools + legacyAdapter + readState(Bash/Read/Edit/Write/Glob/Grep/TodoWrite/Agent/Skill/TaskCreate/TaskUpdate/TaskGet/TaskList/TaskOutput/TaskStop/BackgroundAgent/BackgroundAgentResult/AskUserQuestion/ListMcpResources/ReadMcpResource/RequestApprove) |
| `src/commands/{index,registry,promptRender,types}.ts` | 自定义命令注册 |
| `src/opencc-internals/` | **OpenCC 兼容垫片**:bridge / bootstrap / constants / hooks / migrations / services(api/analytics/compact/mcp)/ skills / state / tools / types / utils(settings/permissions/bash/model)/ entrypoints。`AgentTool.ts` 等核心类直接复用 OpenCC 实现,通过 zai 适配层把 query 函数替换为 queryLoop |
| `src/index.ts` | 主入口 barrel |
| `scripts/strip-list.ts` | opencc-src 静态拷贝的裁剪清单(上游同步脚本已移除) |

---

## 3. 后端架构

### 3.1 `createApp` 启动流程(`server/index.ts:41-138`)

```
createApp({cwd, cwdName, token, port?})
│
├─ app.locals.instanceContext = { cwd, cwdName }      ← 注入只读 cwd 给路由
│
├─ initAgentRuntime(opts.cwd)                        ← DefaultAgentRuntime 单例
├─ initSubagentNotifierLifecycle()                   ← 必须在 initBackgroundRuntime 之前!
├─ initBackgroundRuntime()                           ← DefaultBackgroundRuntime + onTaskStateChange 钩子
├─ initStateBridge()                                 ← agent-core StateChangeBus → eventBus
├─ initZaiSettingsCache().catch(...)                 ← fire-and-forget;同步读返回 {}
├─ ensureManifestDir().catch(...)                    ← fire-and-forget
│
├─ express.json({ limit: '20mb' })                   ← 图片粘贴:10 × 1.8MB base64 留余量
├─ app.set('etag', false) + noCacheForApi            ← /api/* 304 全禁
│
├─ app.use('/api', <19 个 router>, answerRouter w/ AskRegistry middleware, approveRouter)
│
└─ startBranchChecker(opts.cwd)                      ← 每 10s 检测 git 分支变化
```

**严格顺序依赖**(注释中明文标注):
1. `initSubagentNotifierLifecycle` 必须在 `initBackgroundRuntime` 之前 — 否则 `onTaskStateChange` 第一次触发拿不到句柄
2. `initStateBridge` 必须在 `initBackgroundRuntime` 之后 — agent-core 才发 `agent_task.changed`,先订阅才不会丢第一批
3. `answerRouter` middleware 注入 `_askRegistry` / `_approveRegistry` 到 `req`,然后 `/api/agent/answer` + `/api/agent/answer/reject` 才能工作(注释明确写过写成 `/api/agent` 前缀会导致 `/api/agent/agent/answer` 的踩坑)
4. `slashRouter` 必须挂 `/api` 而非 `/api/agent` — 否则前端 fetch('/api/slash') 拿到 SPA fallback HTML

### 3.2 19 个 Router(按挂载顺序)

| Router | 关键职责 | 备注 |
|---|---|---|
| `event` | SSE 主通道 + state.* 推送 + Last-Event-ID 续读 | 15s 心跳;subscribeTopics / subscribeScoped |
| `health` | GET /health 返回 `{ ok, version }` | 读 package.json 拿版本 |
| `system` | 系统信息 + CLI 检测 + 分支检查 | startBranchChecker 在此 |
| `cli` | CLI 安装/卸载 + 注册表切换 | npm install/全局命令 |
| `dirs` | 工作目录扫描 | nova / opencode / opencc / globalSkills 计数 |
| `git` | git 命令代理(分支/状态/log) | git.test.ts |
| `fs` | 文件操作(read/write/mkdir/...) | fs.test.ts |
| `login` | POST/GET `/login/:type` SSE 流 | pa / pa-long / op 三种类型 |
| `config` | GET/PUT `/config/:tool` + provider profile | nova / opencode / opencc 三种 |
| `resources` | 资源缓存(skills/commands/extensions/agents) | ZAI_NO_CACHE=1 走原始 npx |
| `quickstart` | 一键安装缺失 CLI + 切换 npm registry | 内网 paic 优先 |
| `exec` | 白名单命令 spawn + SSE | npm/npx/node/git/echo/cat/ls/pwd/which/command |
| `agent` | **POST /agent/prompt fire-and-forget + HARD_TIMEOUT 2h** + sessions CRUD + abort + transcript 修复入口 | 转译 RuntimeEvent → ServerEvent |
| `agentSettings` | 模型设置读写 | agentSettingsMode.test.ts |
| `tasks` | **POST /tasks 派发 + GET /tasks/:id/events SSE 续读** | seq 显式作为 SSE id:line |
| `bashTasks` | 后台 bash task CRUD | TaskOutput / kill |
| `bashRepl` | bash REPL session 路由 | bashRepl.test.ts |
| `v2Tasks` | GET /agent/sessions/:sid/v2-tasks 全量兜底 | 持久化 `~/.zai/tasks/<sid>.json` |
| `sessionState` | session 状态聚合 | bashTasksBySession / agentTasksBySession / cwdBySession / todosBySession / v2TasksBySession |
| `transcript` | POST /api/transcript/repair 手动修复 transcript 漏写 | repairAndPersistTranscript |
| `slash` | GET /api/slash 命令列表 | 单独 /api 前缀 |
| `answer` | POST /agent/answer + /agent/answer/reject | 共享 `_askRegistry` middleware |
| `approve` | POST /agent/approve + /agent/approve/reject | 共享 `_approveRegistry` middleware |

### 3.3 六大核心服务单例

| 服务 | 职责 | 关键设计 |
|---|---|---|
| **eventBus** (`eventBus.ts`) | ServerEventBus:256 ring history + per-sid 切片 + topic 白名单 + sid-scoped 订阅 | 显式 `isGlobalEvent` 枚举(server.connected/toast/branch.changed/session.*/job.*),防止 sid=null 的全局任务被静默丢;`subscribeTopics` 支持 `'state'` 简写匹配 4 个 state.* type |
| **askRegistry** (`askRegistry.ts`) | AskRegistry:register/answer/reject/abortAll 等 AskUserQuestion 答复 | test seam 通过 `getAskRegistry` 返回单例 |
| **agentRuntime** (`agentRuntime.ts`) | DefaultAgentRuntime 单例 + resolveSkillsDirs + resolveSandbox + 启动时 initCommands | `executor:'child_process'` / `maxCpuMs:600_000` |
| **backgroundRuntime** (`backgroundRuntime.ts`) | DefaultBackgroundRuntime + JsonTaskStore + 调度器 + onTaskStateChange → emit job.* + 串 SubagentNotifier.handle | retry 策略:`max529Retries=3` + `maxRetries=10`(`maxRetries=10 = 11 次总尝试`)+ `maxDelayMs=32s` |
| **subagentNotifier** (`subagentNotifier.ts`) | 后台 task terminal 时 fire-and-forget 注入 `<task-notification>` 触发父 queryLoop 续传 | 用 `runtime.run({transcriptId: parentSessionId, prompt: <task-notification>, isMetaPrompt:true})`,走 translateRuntimeEvents 把事件 emit 到 eventBus |
| **openaiClient** (`openaiClient.ts`) | 手写 OpenAI-compatible HTTP 客户端 | ~648 行;`messages.create()` 返回 `AsyncGenerator<OpenAIStreamEvent>`;tool schema 归一化(`required[] ⊆ properties`,strict mode 加 `additionalProperties:false`);OpenAI SSE → Anthropic events;`reasoning_content → thinking` 桥接;`finish_reason=length` 截断 JSON 自愈;`paic.com.cn` 自动加 plugin 头 |

另外两个支撑服务:
- `stateBridge.ts`:`initStateBridge` 把 agent-core `StateChangeBus` → eventBus(`cwd.changed` / `bash_task.changed` / `v2_task.changed` / `agent_task.changed`)
- `zaiSettingsCache.ts`:boot 启动时按 tier 解析 `~/.zai/settings.json`(zai → claude → builtin defaults),首次启动时自动 seed,fire-and-forget

### 3.4 中间件链

| 顺序 | 中间件 | 行为 |
|---|---|---|
| 1 | `express.json({ limit: '20mb' })` | 显式抬到 20mb,默认 100kb 在粘贴/拖拽图片立刻 PayloadTooLargeError |
| 2 | `app.set('etag', false)` | 禁 ETag |
| 3 | `noCacheForApi`(挂 `/api`) | `Cache-Control: no-store, no-cache, must-revalidate` + `Pragma: no-cache` + `Expires: 0`;SSE 路由自带 Cache-Control,中间件不覆盖 |
| 4 | 各 router(mount) | 19 个 router 按顺序处理 `/api/*` |

**tokenGuard 状态**:已删除(注释 `server/index.ts:37-40` 明示)。zai 只听 localhost,token 每次重启变 → 401 → 用户手动粘贴,无安全收益却添摩擦。

---

## 4. Agent 运行时核心

### 4.1 `queryLoop` 主循环控制流

```
queryEngine / queryLoop (AsyncGenerator<RuntimeEvent>)
│
├─ sessionId = options.transcriptId ?? options.resumeFromTranscriptId ?? `sess-${randomUUID()}`
├─ store = new TranscriptStore(config.dataDir)
├─ abortController = new AbortController()
├─ options.abortSignal?.addEventListener('abort', () => abortController.abort(...), { once: true })
├─ isSubagent = Boolean(parentSessionId) || Boolean(subagentType)   ← ★ 双保险
│
├─ PluginRuntime.load({cwd, signal}) → pluginSnapshot(hooks/mcpServers/skills/agents)
├─ HookRunner = new HookRunner(pluginSnapshot.hooks, hookExecutor)
├─ mcpServers = [...config.mcpServers, ...pluginSnapshot.mcpServers]
│
├─ 0.1 loadSkillsFromDirs(skillsDirs) + pluginSnapshot.skills → skills[]
├─ 0.2 mcpClientPool.connectAll() + loadMcpSkills() + snapshotMcpClients()  ← instructions 走 system prompt TEXT
│     [Dynamic import] getZaiRuntimeTools()
├─ 0.3 resolveToolPool(...) + adaptMcpTools(...) → tools[]
│
├─ if (!transcriptId && !resumeFromTranscriptId) store.create(...)    ← ★ 关键:别只看 resumeFromTranscriptId
├─ systemPrompt = buildSystemPrompt(...)                              ← 装 AGENTS.md + skills + MCP instructions
├─ hookRunner.run('SessionStart')
├─ hookRunner.run('UserPromptSubmit')
│
├─ messages: [{role, content}] = []
├─ lastUuid: string | null = null
├─ if (resumeId) t = store.read(resumeId, pathOpts); 把顶层 type:'tool_use' 合并到上一条 assistant   ← ★ Anthropic 2013 防御
├─ messages.push 新 user prompt
├─ mergeTrailingUserMessage(messages)                                ← 新 user 后补一道合并
│
├─ while (turn < maxTurns) {
│     snipCompactIfNeeded(messages)              ← 防线 1:削 ≥95% 阈值的早期 user
│     resolveForceReason(...) → tracking.forceReason   ← 防线 2:memory-pressure > message-count > token
│     autoCompactIfNeeded(...)                   ← 防线 3:streaming modelCaller → boundary + summary message
│     ↓
│     modelStream = config.modelCaller({model, systemPrompt, messages, tools, signal})
│     for await (const ev of modelStream) {
│       // 累积 assistantText / thinkingText / toolUseBlocks
│       // message_stop → sawMessageStop = true → break
│     }
│     if (sawMessageStop) {
│       // ★ 主动 break,否则 minimax proxy keep-alive 不关 socket → appendAssistantMessage 永远走不到
│       yield { type: 'runtime.done', ... }
│       return
│     }
│     ↓
│     toolCtx = makeToolContext(...)
│     for await (const ev of executeToolsStreaming(...)) yield ev   ← tool_use:start/done/error/denied/ask_pending
│     ↓
│     // __pendingSkillInjection 处理:把 skill 内容作为 user message 注入,绕过 SkillTool 渲染
│     // 避免 "skill 文字被显示成用户消息" 的 bug
│   }
└─ finally { dispose(); ... }
```

### 4.2 三层职责边界

| 模块 | 职责 | 不做 |
|---|---|---|
| `streamAdapter.ts` | **Anthropic SDK event → RuntimeEvent 翻译**;`wrapWithZaiMeta` 加 eventId/sessionId/ts/turnIndex;`toRuntimeErrorEvent` / `toAbortedEvent` | 不管工具执行 |
| `toolExecution.ts` | `executeToolsStreaming`:串行 yield 每个 tool_use:start/done/error/denied/ask_pending 事件;挂 PreToolUse/PostToolUse 钩子;v2 tool_use + tool_result 落盘(parentUuid 链条) | 不调 model,不管 prompt |
| `canUseTool.ts` | `defaultCanUseToolFactory(sandbox)`:Bash 走 sandbox(`executor:'child_process'` / `maxCpuMs:600_000`),Agent 直接 allow | 不持久化,不做 UI 反馈 |

### 4.3 `modelCaller` 多 provider 桥接

`modelCaller.ts:159-175` 通过 **dynamic import** 懒加载:

```ts
if (config.provider === 'openai') {
  // 加载 openaiClient.ts
  // messages.create() 返回 AsyncGenerator<OpenAIStreamEvent>
  // duck-type 为 Anthropic SDK 形态
} else {
  // 默认 Anthropic SDK
}
```

| 能力 | Anthropic SDK | openaiClient (zai 自实现) |
|---|---|---|
| messages.create → AsyncGenerator | SDK 原生 | 手写 HTTP fetch + SSE 解析 |
| tool schema 归一化 | SDK 内置 | `required[] ⊆ properties`,strict mode 加 `additionalProperties:false` |
| OpenAI SSE → Anthropic events | n/a | `message_start`/`content_block_*`/`message_delta`/`message_stop`/`error` |
| `reasoning_content` 桥接 | n/a | → `thinking` block |
| `finish_reason=length` 截断 JSON 自愈 | n/a | 当 tool_use 没闭合时尝试拼接残余 JSON |
| `paic.com.cn` 自动加 header | n/a | `client-code/plugin-version: Gemini` |
| 远程 URL 图片 | 支持 | **不支持** |
| `tool_choice` 非 auto/required/none | 支持 | **不支持** |
| prompt cache | 支持 | **不支持** |
| `thinking` 参数 | 支持 | **不支持** |
| code interpreter | 支持 | **不支持** |

### 4.4 RuntimeEvent 翻译表(`routes/agent.ts` 内 `translateRuntimeEvents`)

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
| `message_stop` | `runtime.done`(`queryLoop` 主动 yield,不再 wrapWithZaiMeta)|

---

## 5. 前端架构

### 5.1 Zustand 分层

| Store | 关键 state | 关键 reducer |
|---|---|---|
| **useAgentStore** (主业务) | `sessionId` / `messagesBySession` / `todosBySession` / `v2TasksBySession` / `bashTasksBySession` / `agentTasksBySession` / `cwdBySession` / `pendingAsk` / `pendingApprove` / `status` / `_taskClearTimers` | `applyRuntimeEvent` / `applySessionEvent` / `applyPromptAsk` / `applyJobEvent` / `applySystemEvent` / `applyCompactionEvent` / `upsertToolCall` / `scheduleTaskListClearIfAllDone`(5s) |
| **useAppStore** (全局 UI) | `sidebarCollapsed` / `settingsDrawerOpen` / `settingsTheme` / `outputStyle` / `maxVisibleMessages`(默认 20,超过时 Agent.tsx 折叠早期消息 + 顶部浮按钮还原) / `instanceContext.cwdName` | 全局 UI setter |
| **useEventStream** | SSE 连接 + frame 解析 + reducer dispatch | `connect()` 启动 EventSource(fetch + ReadableStream) |

**Stream block key** = `${sendSeq}:${turnIndex}:${textSegmentRev}:${blockIndex}:kind`
- `sendSeq` 每次发消息 +1 → 跨轮次不冲撞(`wrapWithZaiMeta` 计数器每调用归零 → 必须前端再 namespace)
- `textSegmentRev` 在 `tool_use:start` 时 +1,把文字段切到独立 bubble;`segmentedToolUseIds` 防重复 bump

**TodoWrite 守卫**:`upsertToolCall` 收到 `name==='TodoWrite'` 立刻吞掉不写 messages,在 `:done` 阶段解析 `input.todos` 写 `todosBySession[sid]`;损坏静默忽略

**V2 TaskList**:`v2TasksBySession` 与 TodoWrite 独立,server 持久化到 `~/.zai/tasks/<sid>.json`,前端通过 `/api/agent/sessions/:id/v2-tasks` 拉全量兜底

**runtime.error 路由**:带 toolUseId → `upsertToolCall` 写成 `tool_use:error`;不带 → push 一条进 messages 红色 Card

**任务自动清空**:`scheduleTaskListClearIfAllDone`,todos + v2 tasks 全部终态(completed / deleted)后 5s 自动从 store 移除

**StateEvent map**:`cwdBySession` / `bashTasksBySession` / `agentTasksBySession` / `v2TasksBySession`(已有)与 `todosBySession` 平行,4 个 map + 4 个 reducer 维护

### 5.2 SSE 事件管线

```
Browser                          zai server                        agent-core
  │                                  │                                 │
  │  GET /api/event (EventSource)    │                                 │
  │ ─────────────────────────────►   │  ServerEventBus.subscribe       │
  │                                  │  ┌──────────────────────────┐   │
  │                                  │  │ emit(event)               │   │
  │                                  │  │  ├─ history[256]          │   │
  │                                  │  │  ├─ historyBySid[sid][256]│   │
  │                                  │  │  └─ for sub of subs: sub()│   │
  │                                  │  └──────────────────────────┘   │
  │                                  │                                 │
  │                                  │  route/agent.ts                 │
  │                                  │  translateRuntimeEvents        │
  │                                  │    (RuntimeEvent → ServerEvent) │
  │                                  │  eventBus.emit(ServerEvent)     │
  │  ◄─────────────────────────────  │                                 │
  │  ServerEvent SSE 推送             │                                 │
  │  ├─ id: line (Last-Event-ID 续读) │                                 │
  │  ├─ event: line (type)            │                                 │
  │  └─ data: JSON                    │                                 │
  │                                  │                                 │
  │  useEventStream.applyEvent       │                                 │
  │    ├─ runtime.* → applyRuntimeEvent → upsertToolCall / pushMessage  │
  │    ├─ session.* → applySessionEvent                               │
  │    ├─ job.* → applyJobEvent → useBackgroundTasks (filter by sid)  │
  │    ├─ prompt.ask → applyPromptAsk → pendingAsk → QuestionCard      │
  │    └─ system.* / state.* → applySystemEvent / applyStateEvent     │
```

**Last-Event-ID 续读**:浏览器 EventSource **不能**自定义 request header → `eventSource.ts` / `taskApi.ts` 用 `fetch + ReadableStream` 自己解析 SSE 帧,`parseFrame` 把数值 id 保留为 number(之前 `Number("evt-tool-1")=NaN` 丢 frame 的修复见 `tasks.ts:88-103` 注释)

### 5.3 关键组件

| 组件 | 职责 |
|---|---|
| `Agent.tsx` | 主对话页面:消息流渲染、stream block 拼接、输入框、QuestionCard / ApproveDrawer 容器、模型状态栏 |
| `AgentInputBox.tsx` | 输入框:文本 + 图片粘贴(20mb 限制)+ Esc 中断 + slash 命令触发 |
| `SessionList.tsx` / `Sidebar` | session 列表 + 新建/删除/重命名 |
| `SettingsDrawer.tsx` | 主题 / outputStyle / maxVisibleMessages / 模型设置 |
| `QuestionCard.tsx` | AskUserQuestion 渲染:questions[].options 按钮 + Other 文本框;`OTHER_OPTION_VALUE` sentinel |
| `ApproveDrawer.tsx` | RequestApprove 权限审批 |
| `TaskDrawer.tsx` / `TaskDock.tsx` | 后台任务详情 / dock 列表(按 sessionId 过滤) |
| `TodoZone.tsx` / `TodoDropdown.tsx` | TodoWrite 状态展示(已完成 5s 自动清空) |
| `SessionCwdBridge.tsx` | SSE cwd.changed → `useAppStore.instanceContext.cwdName` |
| `LogPanel.tsx` | install / login / exec / quickstart 通用日志面板 |
| `ConfigStatusBar.tsx` | 底部状态栏:实例 cwd / model / 分支 |
| `BottomStatusBar.tsx` | 任务统计 / 上下文使用率 / 模式 |
| `Layout.tsx` | 整体布局:sidebar + 主区 + drawer |
| `markdown/`, `transcript/`, `toolRenderers/`, `splitPane/` | 子组件目录:markdown 渲染、transcript 回放、tool 输出渲染、分屏 |

---

## 6. 关键子系统

### 6.1 BackgroundRuntime(后台任务)

```
AgentTool.run_in_background: true
  → BackgroundRuntime.dispatch({prompt, cwd?, agent?, model?, metadata: {parentSessionId}})
  → 调度器 for-await agentRuntime.run({parentSessionId, disallowedTools:['Agent']})
  → 拿 RuntimeEvent → TaskEvent(strip meta)
  → JsonTaskStore.appendEvent [先写盘] + emitter.emit [再通知]
  → GET /api/tasks/:id/events (SSE, ev.seq 作 id:line, Last-Event-ID 续读)
  → 任务结束:发 task.ended 哨兵
```

**关键设计**:
- **写盘先于 emit**:服务端崩溃 / 客户端断网 → 重连用 `Last-Event-ID` 补齐
- **retry**:`runOne` 区分 529 连续上限(`max529Retries=3`)vs 5xx 总上限(`maxRetries=10` = 11 次总尝试);`getRetryDelay(consecutive529 || attempt)` 指数退避 + 抖动(0.25 jitter)
- **防递归**:派 sub-agent 时强制 `disallowedTools:['Agent']`
- **parentSessionId 透传**:`dispatch metadata.parentSessionId` → `task.parentSessionId` → `agentRuntime.run({parentSessionId})`。缺这一步时 AgentTool 兜底成 `'sess-unknown'` → 孙子 task 继承占位符 → subagentNotifier 静默丢通知
- **sub-agent 续传**:`SubagentNotifier.handle(task)` 把 `<task-notification>` user 消息注入父 session 触发 queryLoop 重启一轮(走 Notifier 而不是直接 emit,因为父 session 不在跑时也要能排队)
- **session 切分**:`job.*` 事件 `sessionId` 来自 `task.parentSessionId`,前端 `useBackgroundTasks` 按 `useAgentStore.sessionId` 过滤

**对应工具**:
- `BackgroundAgentResultTool`:阻塞轮询 terminal
- `TaskOutputTool`:非阻塞拉 output
- AgentTool 派发 `run_in_background:true` 时由 LLM 在描述里看到

### 6.2 压缩系统(`runtime/compact/` 模块)

3 道防线:

```
queryLoop 每轮 turn 进入
  ↓
snipCompactIfNeeded (削 ≥95% 阈值的早期 user 消息)         ← 防线 1
  ↓
resolveForceReason (memory-pressure > message-count > token 阈值)   ← 防线 2
  ↓ forceReason 写入 tracking.forceReason
autoCompactIfNeeded (per spec)                            ← 防线 3
  ├─ shouldAutoCompact → querySource 递归守卫 / ZAI_DISABLE_* env / token 阈值 / forceReason
  ├─ resolveAutoCompactCircuitBreakerState → closed / half-open / skip(open + cooldown)
  ├─ compactConversation → streaming modelCaller → boundary + summary message
  ├─ store.replace() 落盘(沿用 proper-lockfile)
  └─ logEvent → ~/.zai/logs/compact.jsonl(JSONL,无锁)
  ↓
yield 内部 compaction.completed 事件
  ↓
routes/agent.ts translateRuntimeEvents 翻译为 SSE runtime.compacted
  ↓
useAgentStore.applyCompactionEvent → 5s 自动消失的 toast
```

**Env 矩阵**(在 `runtime/compact/index.ts` 顶部消费):

| Env | 默认 | 说明 |
|---|---|---|
| `ZAI_DISABLE_AUTO_COMPACT` | `0` | 设为 1 禁自动压缩,manual /compact 仍可用 |
| `ZAI_DISABLE_COMPACT` | `0` | 设为 1 禁所有压缩 |
| `ZAI_AUTOCOMPACT_PCT_OVERRIDE` | unset | 0-100,覆盖 token 阈值百分比 |
| `ZAI_AUTOCOMPACT_FAILURE_COOLDOWN_MS` | 300000 (5min) | ≥ 10000,失败后冷却时长 |
| `ZAI_MAX_ACTIVE_MESSAGES` | 200 | message-count forceReason 触发上限 |
| `ZAI_AUTOCOMPACT_FORCE_FLOOR_PCT` | 75 | 大上下文安全百分比(floor) |

**Circuit breaker 状态机**:
- `closed`:正常工作
- `half-open`:失败累积到临界后,允许 1 次试探;成功 → closed,失败 → open
- `open`:冷却期内 `skip`;`MAX_CONSECUTIVE_AUTOCOMPACT_FAILURES` 触发

**阶段 1 限制**:`manual /compact` 在大对话下仍可能 `kind: 'error'`(阶段 1 不做 PTL 自愈);`autocompact` / `conversation` branch coverage < 85%,阶段 2 补

### 6.3 Skills / MCP / Plugins 加载链

```
queryLoop 进入
│
├─ PluginRuntime.load({cwd, signal}) → pluginSnapshot
│   ├─ hooks: PluginHook[]              ← 8 个 hook event
│   ├─ mcpServers: McpServerSpec[]
│   ├─ skills: LoadedSkill[]            ← plugin 自带 skills
│   └─ agents: AgentDefinition[]        ← plugin 自带 sub-agent 类型
│
├─ HookRunner = new HookRunner(pluginSnapshot.hooks, hookExecutor)
│   └─ combinedAbortSignal:钩子超时 + 主 abort
│
├─ mcpServers = [...config.mcpServers, ...pluginSnapshot.mcpServers]
│
├─ loadSkillsFromDirs(skillsDirs) + pluginSnapshot.skills
│   ├─ walkDir 每个目录 → skill.md 解析 frontmatter
│   ├─ unconditional: LoadedSkill[]    ← 没 paths: → 立刻暴露
│   └─ conditional: ConditionalSkill[] ← 有 paths: → 等 activateConditionalSkillsForPaths
│
├─ mcpClientPool.connectAll(mcpServers)
│   ├─ connectAll 内部吞掉 per-server 错误
│   ├─ hasClient(name) 失败则跳过该 server
│   └─ loadMcpSkills(pool, name) → 把 skill:// 资源合并进 skills[]
│
├─ snapshotMcpClients() → config.mcpClients         ← instructions 走 system prompt TEXT 通道
│
├─ [Dynamic import] getZaiRuntimeTools()
├─ resolveToolPool(...) → tools[]
│
├─ adaptMcpTools(pool, name) → MCP tools[]          ← 不参与 skill 机制,独立追加
│
├─ buildSystemPrompt(...)                             ← 装 AGENTS.md + skills + MCP instructions + plugin agents
│
├─ hookRunner.run('SessionStart')                     ← 第一个 hook
└─ hookRunner.run('UserPromptSubmit', {prompt, cwd, sessionId})
```

**AGENTS.md 自动注入**:每个 turn 调 `loadAgentsMd(options.cwd)` 拼到 system prompt 顶部;`enableAgentsMd:false` 关闭;1s mtime watcher 监听文件变更 → `clearMemoryCache` 失效缓存

**MCP 过滤**:尊重 Claude Code 的过滤字段 —— `enabledMcpjsonServers` / `disabledMcpjsonServers`(per-`.mcp.json` allowlist/blocklist,只在 project scope 生效)+ `disabledMcpServers`(user-scope 全局黑名单,post-merge 过滤;user 黑名单压过 project allowlist)

**Hook 事件**(8 个,源自 OpenCC):SessionStart / SessionEnd / UserPromptSubmit / PreToolUse / PostToolUse / Stop / SubagentStop / PreCompact

### 6.4 Cwd 跟踪机制(`feat/cwd-tracking`)

```
BashTool 每条 sh -c 命令
  ↓
末尾追加 `pwd -P >| /tmp/zai-bash-<taskId>-cwd` trailer
  ↓
子进程退出后 readFileSync 读出
  ↓
与上次 CwdStore.get(sid) 比较
  ↓ 不同
CwdStore.set(sid, newCwd)        ← 仅内存,进程崩溃即归零
  ↓
stateBridge 监听 → emit cwd.changed
  ↓
GET /api/event SSE → 前端 useSessionCwd(sid)
  ↓
SessionCwdBridge 写 useAppStore.instanceContext.cwdName
  ↓
ConfigStatusBar 展示
```

**已知薄弱点**:
- CwdStore 仅内存:server 进程重启后所有 session cwd 归零(transcript 重跑可恢复,符合预期)
- 前端 cwd 轮询失败时静默保留旧值:用户看到陈旧 cwd 但无错误提示
- `pwd -P` 在某些 shell 上不支持 `>|` noclobber(罕见,POSIX 必支持)
- 不做目录权限限制:`resetCwdIfOutsideProject` 仍是 stub 返回 false
- 不做 sub-agent cwd 隔离:`preventCwdChanges = !isMainThread` 未实现

---

## 7. 关键数据流

### 7.1 主对话路径

```
web AgentInputBox.submit
  │  POST /api/agent/prompt
  ▼
routes/agent.ts → getRuntime().run({prompt, cwd, transcriptId?, model?, isMetaPrompt?})
  │  fire-and-forget → res.json({sessionId})
  ▼
DefaultAgentRuntime.run → queryLoop(opts, config)
  │  AsyncGenerator<RuntimeEvent>
  ▼
routes/agent.ts translateRuntimeEvents(stream, sessionId)
  │  Anthropic SDK event → ServerEvent (runtime.* / prompt.ask / state.*)
  │  ServerEventBus.emit()
  ▼
GET /api/event SSE 长连接(15s 心跳)
  │  subscribeScoped(sid, topics, sub)
  │  topicMatches: 'state' 简写匹配 cwd/bash/v2/agent_task 4 type
  ▼
web useEventStream.applyEvent
  │  ├─ runtime.delta → applyRuntimeEvent → upsertToolCall / pushMessage
  │  ├─ prompt.ask → applyPromptAsk → pendingAsk → QuestionCard
  │  └─ state.* → applyStateEvent → 4 个 mapBySession reducer
  ▼
React re-render
```

**HARD_TIMEOUT 2h**(`agent.ts:34`):AskUserQuestion 不应被这条 timeout 掐死;若要让 ask 单独计时,应在 `askRegistry.register` 里接独立 setTimeout,而不是复用这里的 abortController(已知薄弱点)。

### 7.2 后台任务路径

```
web useBackgroundTasks / AgentTool.run_in_background
  │  POST /api/tasks {prompt, cwd?, agent?, model?, metadata: {parentSessionId}}
  ▼
routes/tasks.ts → DefaultBackgroundRuntime.dispatch(parsed)
  │  调度器在并发槽内 for-await agentRuntime.run({parentSessionId, disallowedTools:['Agent']})
  │  RuntimeEvent → TaskEvent(strip meta)
  │  JsonTaskStore.appendEvent(ev) [先写盘]
  │  emitter.emit(ev) [再通知]
  ▼
GET /api/tasks/:id/events (SSE, ev.seq 作为 id:line)
  │  headers: Last-Event-ID: <lastSeq>
  │  客户端 subscribeTaskEvents(taskId, lastEventId) — fetch + ReadableStream 解析
  │  parseFrame 把数值 id 保留为 number(避免 NaN 丢 frame)
  ▼
任务结束:发 task.ended 哨兵(lastSeq+1 作为新 id)
  ▼
SubagentNotifier.handle(task)              ← 仅 terminal 状态 + parentSessionId
  │  inject:runtime.run({transcriptId: parentSessionId, prompt: <task-notification>, isMetaPrompt:true})
  │  translateRuntimeEvents → eventBus.emit(续写事件)
  ▼
web job.* → applyJobEvent → useBackgroundTasks 按 sid 过滤
```

### 7.3 AskUserQuestion 端到端流

```
tool_use(AskUserQuestion) → toolExecution yield tool_use:ask_pending
  ↓
translateRuntimeEvents → prompt.ask SSE {sessionId, toolUseId, questions[]}
  ↓
useAgentStore.applyPromptAsk → pendingAsk = {toolUseId, questions}
  ↓
QuestionCard 渲染(options 按钮 + Other 文本框)
  ↓
用户点 Submit → POST /api/agent/answer {toolUseId, answers}
  ↓
routes/answer.ts → AskRegistry.answer(toolUseId) resolve register Promise
  ↓
AskUserQuestionTool.call 拿到 answers → 返回 tool_result
  ↓
toolExecution yield tool_use:done
  ↓
前端:pendingAsk = null + upsertToolCall 收敛
```

### 7.4 压缩 SSE 通知路径

```
queryLoop turn 进入
  ↓
autoCompactIfNeeded 触发 compactConversation
  ↓
yield 内部 {type: 'compaction.completed', ...}
  ↓
translateRuntimeEvents → SSE runtime.compacted {preCompactTokens, postCompactTokens, savedTokens}
  ↓
useAgentStore.applyCompactionEvent → toast(5s 自动消失)
  ↓
store.replace() 落盘(atomic + lockfile)
  ↓
logEvent('auto_compact_succeeded' | 'auto_compact_failed') → ~/.zai/logs/compact.jsonl
```

---

## 8. 关键设计决策与权衡

### 8.1 zai 设计层面

| 决策 | 权衡 |
|---|---|
| **单进程、只听 localhost、零外部鉴权** | 简化部署(无 token dance,无 CSRF)+ 简单心智模型;但失去多用户/远程访问能力 |
| **tokenGuard 删除** | localhost + 端口扫描不会威胁安全;token 重启失效 → 401 → 用户手动粘贴 → 摩擦 |
| **/agent/prompt 不 abort(fire-and-forget)** | 真正兜底是 2h HARD_TIMEOUT;但 AskUserQuestion 等待被 timeout 误掐是已知薄弱点 |
| **写盘先于 emit(JsonTaskStore.appendEvent)** | 服务端崩溃可恢复;客户端断网可续读;代价是单 event 多一次 fsync(用 atomicWrite 折中) |
| **dynamic import lazy load openaiClient** | 避免 vitest vi.mock 阻断 + 启动时间优化(Anthropic-only 用户不付出代价);代价是首次 openai 调用要 resolve import |
| **StateEvent map 拆 4 个 bySession map** | 比单一嵌套对象 O(1) 增删;每个 reducer 独立维护,但要保证 task 自动清空跨 map 一致 |
| **useEventStream 用 fetch + ReadableStream 而非 EventSource** | 浏览器 EventSource 不支持自定义 header → 不能传 Last-Event-ID;自定义 parser 接管一切 |
| **isGlobalEvent 显式枚举** | 防止 sid=null 的全局任务被静默丢;by-design 防御,新增 type 默认 sid-scoped |
| **backgroundRuntime 与 agentRuntime 平级** | 两套独立 lifecycle + retry + 持久化;简单清晰,但 sub-agent 续传要靠 SubagentNotifier 串联两套 |
| **run_in_background + disallowedTools:['Agent']** | 防递归派发 sub-agent 时无限递归;AgentTool 自身控制 |

### 8.2 agent-core 设计层面

| 决策 | 权衡 |
|---|---|
| **QueryLoop + QueryEngine 并存** | queryEngine 是下一代实现(显式 turn、父子 user 合并),queryLoop 是当前主用;contract.ts 通过 DefaultAgentRuntime 包装 queryLoop,query.ts 是 shim。共存期间 spec 与实现可能 drift |
| **opencc-internals/ 目录保留 OpenCC 源码** | 通过 zai 适配层(queryLoop 替代 opencc query)复用大量 OpenCC 代码;代价是同步负担(同步脚本已移除,现为静态拷贝) |
| **tool schema strict mode(additionalProperties:false)** | 部分 provider 不容忍;zai 端在 openaiClient 里硬加;provider 切换可能 schema 不兼容 |
| **reasoning_content → thinking 桥接** | 让 OpenAI 兼容模型(reasoning 模型)的思考输出复用 Anthropic SDK 的 thinking channel;但语义不完全等价(Anthropic 是显式 budget 参数,OpenAI 是 reasoning_effort) |
| **tool_use 顶层消息合并到上一条 assistant(resume 路径)** | Anthropic 协议约束 tool_result 必须紧跟 tool_use;resume 时 store.read 必须做这个合并,否则 2013 错误 |
| **AGENTS.md 1s mtime watcher** | 实时感知本地变更,但频繁文件操作会触发大量 cache invalidation(已用 mtime 去抖) |
| **Skills 分 unconditional / conditional(基于 paths: frontmatter)** | 条件 skills 不污染 system prompt;Read/Edit/Write 工具触发 activateConditionalSkillsForPaths;用户体验提升 |
| **MCP server per-spec filter + user-scope blacklist** | 与 Claude Code 行为对齐;user 黑名单压过 project allowlist(企业 exclusive 不被影响) |

### 8.3 前端设计层面

| 决策 | 权衡 |
|---|---|
| **Stream block key = sendSeq:turnIndex:textSegmentRev:blockIndex:kind** | 跨轮次不冲撞 + tool_use 切独立 bubble + 防重复 bump;key 生成复杂但前端渲染稳定 |
| **TodoWrite 守卫(前端吞事件 + 后端 :done 时解析 input.todos)** | TodoWrite 不渲染成普通 tool 卡片;损坏静默忽略避免 UI 卡死 |
| **5s 自动清空 todosBySession + v2TasksBySession** | 任务完成后 UI 自动收尾;但如果用户在 5s 内想看,定时器必须 cancel(已实现) |
| **prompt.ask 用 sentinel OTHER_OPTION_VALUE** | 避免循环依赖 QuestionCard 与 store;QuestionCard 是常量真源,store 硬编码一份需同步 |
| **cwd → ConfigStatusBar 走 SessionCwdBridge → useAppStore** | 单一真源在 useAppStore.instanceContext;ConfigStatusBar 订阅简单;cwd 变更不影响 useAgentStore |
| **SSE 帧解析放在 lib/eventSource.ts + lib/taskApi.ts 两处** | 通用 EventSource 路径 vs 需要自定义 header 路径(任务续读)共享 parseFrame 逻辑;重复实现风险(已通过 parseFrame 共用缓解) |

---

## 9. 已知风险与薄弱点(摘自 AGENTS.md)

| 模块 | 风险 | 现状 |
|---|---|---|
| agent.ts:34 | HARD_TIMEOUT 2h 无自动化测试 | 常量硬编码;AskUserQuestion 等待被 timeout 误掐是已知问题,应在 askRegistry.register 接独立 setTimeout |
| BackgroundRuntime retry | retry 策略(529 vs 5xx)缺单元测试 | retryPolicy.ts 实现了完整分类(classifyRetryableError / getRetryDelay / retrySleep),但 DefaultBackgroundRuntime.runOne 的 catch block 集成测试覆盖不足 |
| SubagentNotifier | 父 session 续传链路缺测试 | 关键路径任何一环断就静默丢通知;已有部分回归测试(subagentNotifier-2013.test.ts),但 end-to-end 链路覆盖不全 |
| translateRuntimeEvents | 错位/损坏 input 缺回归测试 | 任何上游 schema 变更都会让翻译失败而未被发现;建议加 fuzzing 测试 |
| v2 transcript resume tool_use | 已有回归测试 | queryLoop-resume-2013.test.ts、subagentNotifier-2013.test.ts 覆盖 tool_result+text 合并到同一条 user 的 Anthropic 协议约束 |
| abort / SSE 重连 / 模式切换乐观更新 revert | 无单元测试 | 关键边界路径测试覆盖不足 |
| AgentInputBox 图片粘贴 + Esc 中断 | 无单元测试 | 关键 UX 路径无自动化验证 |
| CwdStore 仅内存 | server 进程重启后所有 session cwd 归零 | transcript 重跑可恢复,符合预期 |
| 前端 cwd 轮询失败时静默保留旧值 | 用户看到陈旧 cwd 但无错误提示 | UX 隐患 |
| pwd -P noclobber 不支持 | 某些 shell 罕见不支持 | POSIX 必支持,实际几乎不会触发 |
| 不做目录权限限制 | resetCwdIfOutsideProject 仍是 stub 返回 false | 用户明确延后 |
| 不做 sub-agent cwd 隔离 | preventCwdChanges = !isMainThread 未实现,sub-agent bash 也会污染 session cwd | 安全/语义隐患 |
| manual /compact 大对话下 kind: error | 阶段 1 不做 PTL 自愈 | 阶段 2 计划补 |
| autocompact / conversation branch coverage < 85% | 阶段 1 测试覆盖不够 | 阶段 2 计划补 |
| 压缩 spec §11.6 目标 line ≥ 92%, branch ≥ 80% | 阶段 1 部分模块达标但未全量 | 需补测 |

---

## 10. 总结

opencc-web 是一个**深度集成 OpenCC 兼容垫片 + 现代化 Web 壳**的工程产物:`zai-agent-core` 把 OpenCC 的核心 agent 运行时(对话循环 / Skills / MCP / Plugins / transcript)抽取成独立 npm 包,`zai` 在它之上叠加 Express+SSE+Zustand+AntD 的 Web 外壳,把原本 CLI 形态的 agent 体验带到了浏览器。三大事件通道(主对话 SSE / 后台任务 SSE / state.* 推送)+ 三大事件总线(eventBus / stateChangeBus / askRegistry)+ 三大持久化层(transcript JSONL / TaskStore JSON / compact.jsonl)+ 三大 provider 桥接(Anthropic SDK / OpenAI-compatible HTTP / 自定义 router)构成了系统的核心骨架。

**最有价值的工程亮点**:
- **SubagentNotifier.fire-and-forget 注入 <task-notification> 触发父 queryLoop 重启**:zai 没有 OpenCC 的 command queue + inbox drain,但靠这个简化方案闭环了 sub-agent 续传链路
- **写盘先于 emit + Last-Event-ID 续读**:服务端崩溃 / 客户端断网都能从断点恢复
- **message_stop race 处理**:`sawMessageStop` 标志主动 break,避免 minimax proxy keep-alive 不关 socket 导致 appendAssistantMessage 永远走不到
- **openaiClient 的 duck-type Anthropic SDK**:不修改 modelCaller 一行代码,只需切换 provider:openai 即可让 OpenAI 兼容模型(包括内网 paic 网关)无缝接入
- **3 道防线压缩 + circuit breaker + streaming 摘要**:context 失控有兜底;失败累积到临界触发冷却,避免雪崩

**最值得继续投入的方向**:
1. 补充 BackgroundRuntime / SubagentNotifier / translateRuntimeEvents 的回归测试(已知薄弱点)
2. 阶段 2-4 压缩增强(PTL 自愈 / prompt cache 复用 / transcript 回放支持 compact_boundary / API 413 reactive compact)
3. cwd 持久化 + sub-agent cwd 隔离 + AgentTool/RequestApprove 路径单测
4. 把 queryLoop + queryEngine 并存状态收敛(目前 spec 漂移风险)