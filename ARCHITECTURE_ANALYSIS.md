# opencc-web 架构调研报告

> 调研日期: 2026-08-21
> 调研方式: `codegraph_explore` + 文件树探查(项目自带 `.codegraph/`,索引已就绪)
> 调研范围: `/Users/liangxuechao572/code/opencc-web`(pnpm workspace,2 个 package)

---

## 1. 技术栈确认

**运行时 & 语言**:`engines.node>=20`、TypeScript ^5.6.0。**默认 runtime 是 Node-direct**(`tsx --loader bun-protocol.mjs`),Bun 仅作为可选快速路径(`dev:bun`)。`bun-protocol` loader 拦截 `bun:bundle` / `bun:feature`,否则会触发 `ERR_UNSUPPORTED_ESM_URL_SCHEME`。

**pnpm 工作区**:`packages/*`,`pnpm-workspace.yaml` 允许 `sharp` 原生构建。

### `packages/zai` (v0.4.2)

| 类别 | 包 | 版本 | 角色 |
|------|----|------|------|
| deps | `@anthropic-ai/sdk` | ^0.52.0 | Claude API 客户端 |
| deps | `express` | ^4.21.2 | HTTP server |
| deps | `@zn-ai/zn-agent-core` | `workspace:*` | Agent runtime 核心 |
| deps | `@codemirror/*` (17 个子包) | ^6 | 代码块语法高亮 |
| deps | `react-markdown` + `remark-gfm` | ^10.1 / ^4.0 | 流式 Markdown 渲染 |
| deps | `zod` + `zod-to-json-schema` | ^3.23 / ^3.25 | request/response schema |
| deps | `commander` | ^12.1 | CLI 参数解析 |
| deps | `proper-lockfile` | ^4.1 | 进程内文件锁 |
| deps | `sharp` / `qrcode` / `adm-zip` / `open` | — | 图片/二维码/zip/浏览器唤起 |
| devDeps | `react` / `react-dom` | ^18.3.1 | UI 框架 |
| devDeps | `react-router-dom` | ^6.28.0 | 路由(注意 devDeps,但运行时通过 Vite import) |
| devDeps | `zustand` | ^4.5.5 | 状态管理 |
| devDeps | `antd` | ^5.22.0 | UI 组件库 |
| devDeps | `@ant-design/icons` | ^6.3.2 | icon |
| devDeps | `vite` + `@vitejs/plugin-react` | ^8.1.5 / ^5.2 | 前端构建(无 webpack) |
| devDeps | `tailwindcss` + `autoprefixer` + `postcss` | ^3.4 / ^10 / ^8 | 工具 CSS |
| devDeps | `vitest` + `happy-dom` + `@testing-library/react` + `supertest` | ^4.1 / ^20 / ^15 / ^7 | 测试栈 |
| devDeps | `tsx` | ^4.19 | TS 直跑 |

### `packages/zn-agent-core` (v0.4.2)

**核心依赖**(节选):`@anthropic-ai/sdk ^0.94`、`@modelcontextprotocol/sdk ^1.29`、`@anthropic-ai/mcpb ^2.1.2`、`@anthropic-ai/sandbox-runtime ^0.0.67`、`@opentelemetry/{api,core,resources,sdk-logs,sdk-metrics,sdk-trace-base}`、`@orama/orama ^3.1` + `@orama/plugin-data-persistence` (本地语义搜索 / 持久化)、`preact ^10`、`react-compiler-runtime ^1.0`、`react-reconciler ^0.33`、`ws`、`axios`、`execa`、`chokidar`、`eventsource-parser`、`@alcalzone/ansi-tokenize`、`js-yaml`、`zod ^3.25`、`lru-cache`、`semver`、`shell-quote`、`tree-kill`、`undici`、`xss`。

devDeps 关键项:`esbuild 0.28.1`(esbuild bundle `opencc-core.mjs`)、`@types/bun ^1.1.13`(仅为 loader 类型)、`react ^19.2.8`(测试用)、`typescript 5.6.3`、`vitest ^2.1`。

**关键观察**:
- React 18 + React 19 同时出现(zai 用 18.3,core 用 19.2 作为测试 runtime)— 这是 Preact reconciler + React Compiler runtime 的特殊组合。
- Webpack 不存在;Vite 是前端唯一构建工具。
- 无 Redux / MobX;只有 Zustand。
- 没有 GraphQL / tRPC;**REST + SSE 自组织**。

---

## 2. 顶层目录结构

```
opencc-web/
├── AGENTS.md                  # 项目元信息(强制开发规则)
├── package.json               # 顶层 workspace,只做编排
├── pnpm-workspace.yaml        # packages/*
├── pnpm-lock.yaml + bun.lock  # 双锁共存
├── docs/                      # 设计 spec + 实施 plan + DEVELOPMENT_REFERENCE
├── examples/                  # mcp-smoke 等
├── scripts/                   # release.mjs / generate-rpc-client.ts 等
├── .codegraph/                # 已建索引的符号图
├── .zai/                      # per-cwd 项目配置
├── .superpowers/              # brief / review / sdd 三段式记忆
└── packages/
    ├── zai/                   # 应用主体(backend + frontend + cli)
    │   ├── bin/zai.js         # 可执行入口
    │   ├── src/cli/           # dev / start / supervisor / managedChild
    │   ├── src/server/        # Express 后端
    │   ├── src/web/           # React/Zustand/AntD 前端
    │   ├── src/shared/        # server↔web 共享(zod schemas / events / types)
    │   ├── public/            # 静态资源
    │   ├── test/              # server / web / cli / integration
    │   └── vite.config.ts     # 前端构建配置
    └── zn-agent-core/         # Agent 运行时核心库
        ├── src/bundle-entry.ts          # 主入口聚合
        ├── src/index.ts                 # 单点 re-export
        ├── src/runtime/                 # 抛错 stub + inlined 兼容实现
        ├── src/compat/                  # zai 专用兼容垫片(transcript/permissions/mcp/...)
        ├── src/opencc-src/              # opencc 0.20.0 上游拷贝(Bun-native,**允许本地 patch**)
        ├── src/stateChangeBus.ts        # 核心 → zai 的 SSE 桥
        ├── scripts/                     # bundle-opencc.ts / verify-server-types-self-contained.mjs
        ├── vendor/ripgrep/              # 三平台 rg 二进制(macOS/Linux/Windows)
        └── test/                        # unit / integration / contract
```

**职责切片**(中英对照):

| 目录 | 职责 |
|------|------|
| `packages/zai/src/cli/` | Commander 命令入口,`dev` / `start` / `supervisor` / `managedChild` / `restartLog` / `backoff` / `ports`;受管 supervisor/managed child 模式实现 |
| `packages/zai/src/server/` | **Express 后端**。`routes/` 30+ 文件、`services/` 50+ 文件(`agentRuntime` / `subagentNotifier` / `instanceSupervisor` / `restartCoordinator` / `weixinBot/...` 等);`middleware/` 仅 2 个(`noCache` + `redirectMobileUA`) |
| `packages/zai/src/web/` | **React 前端**。`pages/` 路由级页面、`components/` 60+ 组件(含 conversation/transcript/toolRenderers/splitPane 子目录)、`store/` Zustand store 群、`hooks/`、`lib/eventSource.js`(EventSource 封装) |
| `packages/zai/src/shared/` | **跨端共享 schema**:`events.ts`(ServerEvent 联合类型)、`builtinProviders`、`settings`、`rpc`、`profileProjection`、zod schemas |
| `packages/zn-agent-core/src/opencc-src/` | opencc 0.20.0 上游拷贝,大量 `react`/`ink`/`hookChains`/`MCP`/`LSP`/`hookEvents` 子模块。**vendor 允许本地补丁**(改完需 `build:core`) |
| `packages/zn-agent-core/src/compat/` | zai 适配层:`runtime/`(模型调用契约)、`transcript/`(`append*MessageV2`)、`permissions/`、`background/`(后台任务运行时)、`mcp/`、`tools/`、`memory/`、`subagents/`、`subprocess/` |
| `packages/zn-agent-core/src/runtime/` | 入口聚合(`query` / `QueryEngine` 是抛错 stub,`registerProcessOutputErrorHandlers` 是 inlined EPIPE 实现);`openccStubs.ts` 明确不直接导入 `opencc-src/query` |
| `packages/zn-agent-core/vendor/` | vendored ripgrep 三平台二进制;作为 `bin` 入口分发 |
| `docs/superpowers/{specs,plans}/` | YYYY-MM-DD 命名的设计规范与实施计划 |

---

## 3. 后端架构

### 3.1 Express 入口与启动

`packages/zai/src/cli/index.ts` 是 CLI 顶层;`dev.ts` / `start.ts` 通过 `ports.ts:resolveServerPort()` 解析端口(显式 `--port` 占用则 `EADDRINUSE` 退出,不静默换端口,见 AGENTS.md 强约束),然后 spawn 一个 supervised child process。

`packages/zai/src/server/index.ts` 是 Express 实例的创建入口;中间件链非常简单 — 只有 `middleware/noCache.ts` + `middleware/redirectMobileUA.ts`(后者把移动端 UA 重定向到 `/m` 路由)。**没有 cors / helmet / compression**,因为只监听 localhost。

### 3.2 路由组织

30+ 路由文件按**功能名平铺**在 `routes/`,而不是按 domain 分子目录(没有 `routes/api/`、`routes/agent/`、`routes/system/`)。完整列表(节选):
- 会话与转写: `agent`, `agentSettings`, `transcript`, `sessionState`, `answer`, `approve`, `permission`, `replHistory`, `slash`, `command`, `commands`, `tasks`, `v2Tasks`, `bashRepl`, `bashTasks`
- 资源: `plugins`, `resources`, `cli`, `fs`, `fsPicker`, `git`, `config`, `dirs`, `instances`, `v2Tasks`
- 系统: `system`, `event`, `stream`, `health`, `login`, `quickstart`, `weixin`
- 工具: `exec`, `translate-runtime-events-parallel`

每个文件导出 `router: IRouter`,`server/index.ts` 统一 `app.use(router)`。

### 3.3 SSE 端点

**两套不同的 SSE schema 并存**:

1. **旧 shell-stream schema** (`packages/zai/src/shared/types.ts:SseEvent`):
```ts
type SseEventType = 'start' | 'stdout' | 'stderr' | 'exit' | 'error'
interface SseEvent { type: SseEventType; command?: string; line?: string; code?: number; signal?: string; message?: string }
```
对应 `routes/stream.ts:createSseStream(res)`,header 设定 `text/event-stream` + `no-cache` + `keep-alive`,写入 `data: ${JSON.stringify(event)}\n\n`。被 `routes/login.ts` / `routes/quickstart.ts` 用来转发 `spawn` 出的子进程 stdout/stderr。**注意:这套实现没有 heartbeat,也没有 Last-Event-ID** — 长连接断开的感知只能依赖 TCP keepalive,这是已知痛点。

2. **新 agent-event schema** (`packages/zai/src/shared/events.ts:ServerEvent`):
类型多得多 — `runtime.{started,delta,thinking,tool_call,tool_result,done,aborted,error,compacted}`,`session.{created,deleted,renamed}`,`job.{started,progress,done,failed}`,`prompt.{ask,approve,permission}`,`queue.changed`,`session/projection`,`stream/error`,`server.error`,`toast`,`system.{restarting,restart.canceled}`,`branch.changed`,`cwd.changed`,`bash_task.changed`,`v2_task.changed`,`agent_task.changed`,`instance.changed`,`app.update.{checking,installing,complete,failed}`,`server.connected`。
每条事件都带 `seq` 序号,服务端全局单调,客户端**按 seq 排序 + 守卫去重**。

### 3.4 中间件链

| 中间件 | 文件 | 作用 |
|--------|------|------|
| `noCache` | `middleware/noCache.ts` | SSE/HTML 禁用缓存 |
| `redirectMobileUA` | `middleware/redirectMobileUA.ts` | 移动 UA → `/m` 路径 |
| `auth` | **缺失** | 仅 localhost,无 token 鉴权 |
| `cors` | **缺失** | localhost 同源策略足够 |
| `error` | 各 route 内 try/catch + 4xx/5xx | 无全局 errorHandler |

### 3.5 与 Agent runtime 的集成方式

**不是子进程**,是**进程内 ESM 导入 + globalThis 桥接**。

- `packages/zai/src/server/services/agentRuntime.ts:initAgentRuntime()` 动态 import `@zn-ai/zn-agent-core`(注释:避免无关测试路径加载 vendor headless bootstrap(~5s transform))。
- 通过 `globalThis.__zaiEventBus = eventBus` 把 SSE 总线暴露给 core。
- 通过 `globalThis.__zaiSessionInbox = {followup, inject}` 让 core 把子 agent 完成通知注入 zai 的 scheduler。
- 通过 `globalThis.__zaiBridgeCtx = {askRegistry, permissionRegistry, onYield}` 静态注入,core 的 `AskUserQuestion` wrapper 在 call-time 读取,`onYield` 把 `tool_use:ask_pending` 翻译成前端消费的 `prompt.ask` ServerEvent。

**原因**:opencc 的 `query()` 是 `for-await` 流,当工具 await 用户回答时,流本身被阻塞,无法在同一条流上 emit "等待用户"的中间事件,必须借道。

---

## 4. 前端架构

### 4.1 入口与构建

- 入口 `packages/zai/src/web/src/main.tsx`(推断;`App.tsx` 是根组件)— `App.tsx` 包 `<ConfigProvider locale={zhCN}>` + `<BrowserRouter>` + `<AppRouter>`。
- 构建工具:**仅 Vite**(`vite.config.ts`,无 webpack)。`@vitejs/plugin-react` + `react-dom` 18。`build:web` 输出到 `dist/web/`。
- 生产构建:`vite build --outDir dist/web`,随后被 Express static serve。

### 4.2 Zustand Store 划分

| Store | 行数 | 订阅者 | 职责 |
|-------|------|--------|------|
| `useAppStore` (`store/useAppStore.ts:210`) | 大 | 42 个 caller | **系统/UI 全局状态**:sidebar、theme、workMode、outputStyle、split screen、autoUpdate、appUpdate、streamState、connected |
| `useAgentStore` (`store/useAgentStore.ts:532`) | 大 | **88 个 caller**(最大) | **会话核心**:sessionId、transcript、prompt queue、in-flight count、cwd、bash tasks、v2 tasks、agent tasks、projection、hydration |
| `useInstanceStore` | — | — | 实例管理(instance manager / managed child) |
| `useProjection` | — | — | session projection(state 镜像) |
| `useEventStream` | — | 2 (App.tsx) | SSE 订阅 + 批量 dispatcher |

### 4.3 AntD 使用

- 版本 `^5.22.0`,`ConfigProvider` 包裹整树,主题 token 区分 `DARK_TOKENS` / `LIGHT_TOKENS`(`colorPrimary: '#f97316'` Tailwind orange-500),dark/light 由 `theme.{darkAlgorithm, defaultAlgorithm}` 切换,主题感知写进 `<html data-theme>`。
- 布局: `<Layout>` 桌面端用 `AntLayout` + `Sider`(可折叠,自渲触发条);`<MobileLayout>` 移动端挂 visualViewport,顶部 hamburger + 底部输入。

### 4.4 路由结构

`packages/zai/src/web/src/router.tsx`(`AppRouter`),`react-router-dom ^6.28.0` + `lazy()` + `Suspense` + `Spin fallback`:

```
桌面端 <Layout />:
  / → /agent (replace)
  /login                 → <Login>
  /manage                → <Manage>(Tabs: tools/resources/config/dirs 合并)
  /tools                 → /manage?tab=tools (replace)
  /resources             → /manage?tab=resources
  /config                → /manage?tab=config
  /dirs                  → /manage?tab=dirs
  /agent                 → <Agent>
  /dashboard             → <Dashboard>
  /instances             → <InstanceRouteGuard> → <Instances>(受管子实例被 redirect 到 /agent)
  * (404)                → /agent
移动端 <MobileLayout />:
  /m                     → <MobileAgent>
```

注意 `MOBILE_BREAKPOINT=768` 在 `useIsMobile.ts`;`/m` 路由**不依赖视口宽度**,是独立路径。

### 4.5 SSE 连接方式

- **原生 `EventSource`**,封装在 `lib/eventSource.js:subscribeServerEvents(sessionId, onEvent, onState)`。
- `sessionId` 走 URL query(`?sid=xxx`),因为 EventSource 不支持自定义 header(HTML 规范);server 也兼容 `X-Session-Id` header(供其他 fetch 调用)。
- **EventSource 自带自动重连**,重连时浏览器重发同一 URL,server 端 `stateBridge.ts` 按 sid filter 后自动续传。
- 接收后不直接 dispatch — 走 `enqueue()` + `queueMicrotask` 的 **microtask 批量**合并,`applyBatch(batch)` 排序后统一分发,避免一帧 N 个事件触发 N 次 reducer 链。
- 状态机:`useAppStore.setStreamState('connected' | 'connecting' | 'error', attempt)` + `setConnected(true)`。

---

## 5. Agent 运行时核心

### 5.1 调度模型

**没有显式 session 队列抽象**;每个 session 一个 controller。

- `packages/zai/src/server/services/agentRuntime.ts:sessionControllers`(`Map<sessionId, Controller>`)— **per-session controller**,由 `routes/agent.ts` 等路由按需取/创建。
- 并发由 `routes/agent.ts` 内 per-session 串行(`hasActiveQuery` 检查)保证,跨 session 之间相互独立。
- 后台任务(`packages/zn-agent-core/src/compat/background/DefaultBackgroundRuntime.ts`)用 `Scheduler` 类(`maxConcurrent` + `maxTotal` 上限,FIFO 队列,`Promise.resolve().then()` 包装 fn 保证 sync throw 路由到 reject path)。
- 重启 drain(`restartCoordinator.ts`):`requestRestart(reason, deps)` 跑 `drainUntilExit` 10000ms 超时,期间 `inFlightCount()` 轮询 100ms 间隔,超时则 `abortAll()`。

### 5.2 工具调用机制

- `opencc-src/Tool.ts` 定义 `Tool<Input, Output, Prompt>` 接口:`prompt({getToolPermissionContext, tools, agents, allowedAgentTypes?})` 返回给 LLM 看的描述,`call(input, ctx)` 执行,`userFacingName(input)`。
- 注册:在 `opencc-src/query.ts`(推断)/`compat/runtime/contract.ts` 拼装 `Tools` 数组。`resolveAgentTools(settings)`(`opencc-src/tools/AgentTool/agentToolUtils.ts:126`)负责按 settings/permission rule 过滤工具子集。
- 分发:`checkPermissionsAndCallTool()`(`opencc-src/utils/permissions.ts`)→ 权限校验 → `tool.call(input, ctx)` → 流式 yield → `tool_use:*` event。
- MCP 适配:`adaptMcpTools(manager)`(`compat/runtime/mcpAdapter.ts`)把 MCP tool 转 `Tool`;`getMcpClientConfig(serverName, config)` 用 sha256(serverName + config) 16-hex 做密钥隔离。

### 5.3 事件流生命周期

完整链路(以一次 prompt 为例):

```
[User] POST /api/agent/prompt (Express)
   └─ routes/agent.ts: 拿/建 session controller
       └─ agentRuntime.run(queryOpts, sid)
           ├─ globalThis.__zaiSessionInbox.followup(sid, msg)  // 入队
           ├─ core.query(opts) // for-await stream
           │   ├─ runtime.started   → eventBus.emit
           │   ├─ runtime.delta     → eventBus.emit (×N)
           │   ├─ runtime.thinking  → eventBus.emit
           │   ├─ runtime.tool_call → eventBus.emit
           │   ├─ AskUserQuestion await ─┐
           │   │                         │ (流被阻塞)
           │   │                         │ __zaiBridgeCtx.onYield
           │   │                         │ → eventBus.emit prompt.ask
           │   │                         ↓
           │   │                    [SSE] → 前端 EventSource onmessage
           │   │                         → useEventStream.enqueue
           │   │                         → microtask flush → applyBatch
           │   │                         → useAgentStore.applyPromptAsk
           │   │                         ↓
           │   │                    [User] /api/agent/answer {toolUseId, answers}
           │   │                         ↓
           │   └─ AskRegistry.answer(toolUseId, answers) // 解 await
           │   ├─ runtime.tool_result → eventBus.emit
           │   ├─ runtime.delta       → eventBus.emit (×N)
           │   └─ runtime.done        → eventBus.emit
           ↓
       eventBus.each subscriber
           └─ stateBridge.ts → res.write(`data: ${JSON.stringify(ev)}\n\n`)
```

事件 seq 全局单调,前端 `applyBatch` 按 seq 排序,`T5 seq 守卫` 兜底丢弃重放。

### 5.4 可观测性 / 断点恢复

- 日志:`packages/zn-agent-core` 集成 OpenTelemetry(`@opentelemetry/sdk-{logs,metrics,trace-base}` + `semantic-conventions`),但代码中只在 `hookChains.ts:logOTelEvent` 见到实际调用,**OTel exporter 默认未配**。
- 断点恢复:transcript + `appendUserMessageV2` / `appendAssistantMessageV2` / `appendToolUse` / `appendToolResult`(`compat/transcript/persistence.ts`)— zai patch:opencc `query()` 本身不写 transcript,需 zai server 消费 stream 时手动持久化。
- 实例心跳:`services/instanceHeartbeat.ts`(推断)用于 managed child 进程探活。
- 重启 drain:`restartCoordinator.ts` 保证 in-flight prompt 在重启前 10s 内优雅退出或 abort。
- 没有看到**结构化 trace export**(Jaeger/Tempo)的代码,OpenTelemetry 仅在 hookChains 中用过一次。

---

## 6. 关键文件 Top 10

| # | 绝对路径 | 职责 |
|---|----------|------|
| 1 | `packages/zai/src/cli/index.ts` | CLI 顶层,Commander 注册 `dev`/`start`/`update`/`restart`/`migrate`/`--port` 解析 |
| 2 | `packages/zai/src/server/index.ts` | Express 实例创建 + 路由挂载 + dev/start 生命周期 |
| 3 | `packages/zai/src/server/services/agentRuntime.ts` | 运行时单例,sessionControllers、globalThis 桥接(`__zaiEventBus`/`__zaiSessionInbox`/`__zaiBridgeCtx`)、in-flight 计数 |
| 4 | `packages/zai/src/server/routes/stream.ts` | 旧 SSE 工具(`createSseStream`),被 login/quickstart 转发子进程 stdout |
| 5 | `packages/zai/src/shared/events.ts` | 新 SSE schema — `ServerEvent` 联合类型,前端/后端类型安全源 |
| 6 | `packages/zai/src/web/src/App.tsx` | React 根组件,ConfigProvider 主题 token + BrowserRouter + AppRouter |
| 7 | `packages/zai/src/web/src/store/useEventStream.ts` | EventSource 订阅 + microtask 批量 dispatcher(`applyBatch`),30+ 事件类型路由 |
| 8 | `packages/zai/src/web/src/store/useAgentStore.ts` | 会话 store(532 行,88 个订阅者)— transcript、queue、cwd、tasks、hydration |
| 9 | `packages/zn-agent-core/src/bundle-entry.ts` | 主入口聚合(vendor opencc + compat re-export),`bundle-opencc.ts` esbuild 输出 `dist/opencc-core.mjs` |
| 10 | `packages/zn-agent-core/src/runtime/index.ts` | runtime 子模块入口,`query`/`QueryEngine` 是抛错 stub,`registerProcessOutputErrorHandlers` 是 inlined EPIPE |

---

## 7. 架构图

```
                    ┌─────────────────────────────────────┐
                    │   Browser (React 18 + Vite SSR?)   │
                    │                                     │
                    │  App.tsx                            │
                    │   ├─ ConfigProvider (antd)          │
                    │   ├─ BrowserRouter                  │
                    │   ├─ AppRouter                      │
                    │   │   ├─ <Layout>  Sider + Outlet   │
                    │   │   │   └─ <Agent>/<Manage>/...   │
                    │   │   └─ <MobileLayout> /m route    │
                    │   └─ useEventStream()  ◄─────────────┼──────┐
                    │        ├─ EventSource("/api/events?sid=xxx")
                    │        ├─ enqueue → microtask batch │
                    │        └─ applyBatch (seq 排序)     │
                    │              ├─ useAppStore         │
                    │              ├─ useAgentStore       │
                    │              └─ useInstanceStore    │
                    └──────────────────┬──────────────────┘
                                       │  HTTP/JSON (REST)
                                       │  EventSource (SSE, sid filter)
                                       ▼
                    ┌─────────────────────────────────────┐
                    │  Express @ :port  (localhost only)  │
                    │                                     │
                    │  src/server/index.ts                │
                    │   ├─ middleware/noCache             │
                    │   ├─ middleware/redirectMobileUA    │
                    │   └─ routes/  (30+ flat)            │
                    │       ├─ agent / answer / approve   │
                    │       ├─ login / quickstart (SSE)   │
                    │       ├─ stream  (legacy SSE)       │
                    │       ├─ plugins / resources        │
                    │       ├─ instances / system         │
                    │       └─ weixin / tasks / v2Tasks   │
                    │                                     │
                    │  services/                          │
                    │   ├─ agentRuntime.ts                │
                    │   │   sessionControllers (Map)      │
                    │   │   globalThis.{__zaiEventBus,    │
                    │   │     __zaiSessionInbox,          │
                    │   │     __zaiBridgeCtx}             │
                    │   ├─ subagentNotifier           │
                    │   ├─ restartCoordinator             │
                    │   ├─ instanceSupervisor             │
                    │   └─ weixinBot/...                  │
                    └──────────────────┬──────────────────┘
                                       │  dynamic import ESM
                                       ▼
        ┌──────────────────────────────────────────────────────┐
        │  @zn-ai/zn-agent-core  (workspace package)           │
        │                                                       │
        │  bundle-entry.ts ── esbuild ──► dist/opencc-core.mjs │
        │       │                                              │
        │       ├── runtime/index.ts (stubs + inlined EPIPE)   │
        │       │      └─ stateChangeBus.ts (core→zai 桥)      │
        │       ├── compat/                                    │
        │       │    ├─ runtime/  ModelCaller + Tool contract │
        │       │    ├─ transcript/  append*MessageV2          │
        │       │    ├─ background/ DefaultBackgroundRuntime   │
        │       │    │            + Scheduler (maxConc+Total) │
        │       │    ├─ permissions / mcp / tools / subagents  │
        │       │    ├─ memory / plugins / subprocess          │
        │       │    └─ requestApproveTool / cwdStore          │
        │       └── opencc-src/   (vendor opencc 0.20.0,      │
        │                          Bun-native, patched)         │
        │            ├─ query.ts / QueryEngine.ts              │
        │            ├─ Tool.ts / tools/AgentTool/...          │
        │            ├─ hooks/  (HookEvent, hookChains)        │
        │            ├─ ink/   (TUI rendering for CLI mode)    │
        │            ├─ services/mcp/  (auth + client)         │
        │            └─ utils/daemon/mailbox (bg-agent 通知)   │
        └───────────────────────────┬──────────────────────────┘
                                    │
                                    ▼
                    ┌─────────────────────────────────────┐
                    │  External: Claude / OpenAI API,    │
                    │  ripgrep binary, MCP servers,      │
                    │  ~/.zai/* (per-user config)        │
                    └─────────────────────────────────────┘
```

**控制流标注**:
- 红色(数据):EventSource SSE 流 — 从 `eventBus` (zai side) 到 `EventSource` (web side),由 `globalThis.__zaiEventBus` 桥穿 package 边界。
- 蓝色(控制):HTTP REST — 浏览器 → Express 路由 → service → core dynamic import → 回到 service → 写回 res。
- 绿色(进程内桥):`globalThis.__zaiBridgeCtx` — **唯一**让 core 在 query stream 阻塞时仍能 emit SSE 的侧通道。

---

## 8. 架构点评

### 8.1 优点

1. **清晰的共享 schema 层**:`src/shared/events.ts` + `src/shared/types.ts` 作为前后端单一事实源,`zod` 校验 + `zod-to-json-schema` 派生,改动自动传播。
2. **microtask 批量 + seq 守卫**:前端 SSE 接收用 `queueMicrotask` 合并 + seq 单调排序,从根本上消除"一帧 N 事件触发 N 次 reducer"问题;server 端 `Last-Event-ID` 续读 + seq 去重,断线重连不重放。
3. **进程内桥接而非子进程**:zai + zn-agent-core 是两个 ESM workspace,通过 `globalThis` 注入避免 IPC 序列化开销,`query()` 流和 SSE eventBus 在同一进程内零拷贝。
4. **Bun/Node 双 runtime 兼容**:`bun-protocol.mjs` loader 拦截 `bun:*` 协议让 Node 直跑 Bun-native vendor,避免一刀切要求 Bun。
5. **macros stub 显式处理**:`installMacroStub()` 预填 `globalThis.MACRO` 避免 vendor 顶层引用 panic;`query`/`QueryEngine` 是抛错 stub,callers 拿到可操作的错误而非 `MODULE_NOT_FOUND`。
6. **类型安全门槛**:`scripts/verify-server-types-self-contained.mjs` 验证 `dist/*.d.ts` 是自包含的,防 `import { Foo } from '../../src/...'`,防止 dist 漏文件。
7. **强端口策略**:显式 `--port` 被占 → `EADDRINUSE` 退出(不静默换端口,杜绝请求风暴);未指定 → `ports.ts:resolveServerPort()` 自动扫描空闲。
8. **mobile-first 双路由**:`/agent` 和 `/m` 是两条独立路径,`MOBILE_BREAKPOINT=768` 仅影响响应式;`InstanceRouteGuard` 在路由层做权限拦截,实例子进程不可见 `/instances`。

### 8.2 痛点 / 可改进

1. **`globalThis.__*` 三桥**(`packages/zai/src/server/services/agentRuntime.ts:78, 88, 106`):`__zaiEventBus` / `__zaiSessionInbox` / `__zaiBridgeCtx` 是进程内隐式耦合。**具体文件**:`agentRuntime.ts` 顶层模块副作用,无法通过普通 DI 注入测试,`__resetAgentRuntimeForTests()`/`__resetSessionControllersForTests()` 必须显式清理。建议封装成 `BridgeContext` 对象走显式参数传递。

2. **路由平铺 + 30+ 文件**(`packages/zai/src/server/routes/`):`agent.ts`、`agentSettings.ts`、`answer.ts`、`approve.ts`、`permission.ts`、`tasks.ts`、`v2Tasks.ts`、`bashRepl.ts`、`bashTasks.ts` — 领域划分不清晰,新增路由时容易放错位置。建议按 `routes/agent/`、`routes/system/`、`routes/resources/`、`routes/tools/` 分子目录。

3. **两套 SSE schema 不一致**:`shared/types.ts:SseEvent`(5 类型,无 seq,无心跳)和 `shared/events.ts:ServerEvent`(30+ 类型,带 seq,带 sessionId)。**具体文件**:`packages/zai/src/shared/events.ts` vs `packages/zai/src/shared/types.ts:112`。SSE 没有 heartbeat 注释(`routes/stream.ts:createSseStream` 只有 `Connection: keep-alive`),长连接经代理时可能静默死亡。建议合并并加心跳注释。

4. **useAgentStore 单 store 88 caller**(`packages/zai/src/web/src/store/useAgentStore.ts:532`):会话状态、transcript、queue、cwd、tasks、hydration 全部塞在一个 store;selectors 写得越多,`Object.is` 失效风险越高。建议按子领域拆分 `useTranscriptStore` / `usePromptQueueStore` / `useTaskStore` / `useSessionMetaStore`,`useAgentStore` 仅留 meta + hydration 协调。

5. **vendor opencc-src 允许 patch 但缺少审计**:`packages/zn-agent-core/src/opencc-src/` 是 opencc 0.20.0 上游拷贝,AGENTS.md 明确允许本地改 — 但 `git log` 看不到 `// UPSTREAM-PATCH:` 标记,长期看容易与上游 drift。建议 patch 文件加 `// ZAI-PATCH:` 头注释并进 `git blame` 跟踪。

6. **OpenTelemetry 装了但未启用**:`@opentelemetry/sdk-{trace,logs,metrics}-base` 全在 `dependencies`,但实际只 `hookChains.ts:logOTelEvent` 用过一次,无 exporter 配置。**具体文件**:`packages/zn-agent-core/src/opencc-src/utils/hookChains.ts:20`。建议要么删依赖瘦包,要么启用 OTLP exporter 接入 trace。

7. **zn-assets 路径漂移**(`AGENTS.md` 提到 `paths.ts:7-17` 描述的 `~/.zai/zn-assets/` 是预期 layout,实际未部署,`agentRuntime.ts:285` 走 `~/.agents/skills`):文档与实现不一致。建议统一路径常量。

8. **没有真正的路由级 RBAC**:`/instances` 有 `InstanceRouteGuard`,但其它路由(`/agent`、`/api/*`)未受 session ownership 保护;`AskRegistry.peek` 加 sid 校验是后期补丁,应作为全局中间件。

### 8.3 命名 / 边界

- **清晰**:`packages/zai` vs `packages/zn-agent-core` 的边界 + `src/{server,web,shared,cli}` 的四象限划分 = 好;`compat/` vs `opencc-src/` 的 vendored-vs-patched 区分在 AGENTS.md 也写明。
- **混乱**:`SseEvent` vs `ServerEvent` 同名不同义,易混;`runtime/index.ts` 的 `query`/`QueryEngine` stub 命名 vs 真正的 `opencc-src/query.ts`,新人易踩;`useAppStore` / `useAgentStore` / `useInstanceStore` 命名粒度不一致(useAgentStore 最大,useInstanceStore 最小)。

---

## 9. 一句话总结

> **opencc-web** 是 zai 生态的本地 dev/runtime 工具集:把 vendored opencc 0.20.0 Agent runtime(`zn-agent-core`)+ 进程内 ESM 桥接(`globalThis.__*`)+ Express+SSE server(`zai/src/server`)+ React+Zustand+AntD Web UI(`zai/src/web`)拼装成一个**localhost-only 的 Agent 对话、流式 UI、命令/Skill/插件统一管理面板**,通过 EventSource + seq-守卫 microtask 批量实现"浏览器↔Agent"准实时双向同步,核心价值是**让用户能在不开远程服务的前提下,在浏览器里跑完整的 Claude/OpenCode/OpenCC Agent 会话并管理本地插件/技能/任务**。

---

## 附:文件总数与最大目录深度

- **文件总数**(排除 `node_modules/`、`.git/`、`dist/`、`.codegraph/`、`.claude/`、`.superpowers/`、`.zai/`、`.worktrees/`):**3,513 个文件**(实测 `find ... | wc -l`)
- **最大目录深度**:**14 层目录**(实测 `find ... -type d ... | awk ... | sort -rn | head -1`);最深文件路径段数 **15**(路径段,非目录层数)
- 后端文件:`packages/zai/src/server/routes/` 50 个 + `services/` 49 个(含 `repl/`、`commands/`、`weixinBot/` 子目录)
- 前端文件:`packages/zai/src/web/src/components/` 60+ 个(含 `conversation/`、`transcript/`、`toolRenderers/`、`splitPane/`、`markdown/`、`PluginModal/`)、`store/` 11 个、`hooks/` 11 个、`pages/` 14 个
- `packages/zn-agent-core/src/opencc-src/` 是最大子树,**贡献了过半文件数**;vendor 部分(`@orama`、OpenTelemetry、Lodash-es 等)是 `dependencies` 引入的传递依赖,在 `node_modules/` 内