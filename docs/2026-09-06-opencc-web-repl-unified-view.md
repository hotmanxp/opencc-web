# opencc-web REPL:vendor 原生 REPL vs zai 实现的 REPL — GAP 对比

> **本文档定位**:zai 服务端"实现 REPL 行为"的方式 vs vendor 原生 REPL(`opencc-src/screens/REPL.tsx`,5366 行,Ink/React TUI)的真实差异。已删除之前文档中的 DSH / dsh-bridge / 跨厂商比较内容 — dsh-bridge 已废弃,本次只关注 zai ↔ vendor 原生 REPL 的 GAP。
>
> **调研方法**:三路独立 Explore agent 并行,主对话综合交叉验证。每条结论标注来源子任务 ID,可追溯到子报告对应章节。
>
> **调研时间**:2026-09-06,基于 `opencc-web` 当前 HEAD(opencc-web phase 4 收口 + 2026-08-30 ReplRuntime P2 完成后状态)。

---

## 0. 三套运行时架构与本文档口径

zai 主进程有 **4 套 runtime**,由 `ZAI_RUNTIME_CORE` 切换(`packages/zai/src/server/services/agentRuntime.ts:91-100`):

| `ZAI_RUNTIME_CORE` | 工厂 | 关键文件 | 适用 |
|---|---|---|---|
| **`repl`(默认)** | `createOpenccRuntime` + `ReplRuntime` 包装 | `agentRuntime.repl.ts` + `createOpenccRuntime-impl.ts` | 主对话 runtime |
| `default` | 纯 `createOpenccRuntime`(无 ReplRuntime 包装) | `createOpenccRuntime-impl.ts` | legacy / 兼容性回退 |
| `inproc` | `createPrintRuntime`(每 sessionId 一个 vendor `print.ts` 实例) | vendor `print.ts` | CLI / 嵌入式场景 |
| `spawn` | `SessionHostRuntimeAdapter` + spawn `opencc -p` 子进程 | `sessionHost/SessionRegistry.js` | escape hatch(拿 vendor 真 REPL) |

> **本文档"zai 实现的 REPL"特指 `ZAI_RUNTIME_CORE=repl` 的默认路径**,即 `ReplRuntime + createOpenccRuntime`。这是 zai 生产环境的真实形态。

---

## 1. 一句话核心结论

zai 主对话走 `ReplRuntime.query()`,**主路径委托给 vendor `createOpenccRuntime` 实例的 `.query()`**(vendor 真实的 `query()` async generator + `translateSdkToRuntime` 翻译 SDK 消息)。`compat/repl/createReplSession`(14 个 setup + 3 个 stateMachine + sessionRestore)只在 `openccRuntime` 未注入的 **fallback / 单元测试路径**触发。

也就是说:**zai 的"实现 REPL"主要是写了一个薄包装层(ReplRuntime),把 vendor 真实 query 内核委托出去,并自实现了一些 vendor REPL.tsx 不覆盖的命令(slash)和服务端必要的能力(plugins stub、ask/permission bridge)。**

---

## 2. 真实 GAP 对比(6 维度)

### 维度 1:进程模型(架构层)

| | vendor 原生 REPL | zai REPL |
|---|---|---|
| **形态** | TUI 进程(Ink + React),单用户 | Server 进程(Express + SSE),多用户 |
| **入口** | `opencc-src/screens/REPL.tsx:615` `REPL({...})` React 组件 | `agentRuntime.repl.ts:106` `ReplRuntime.query()` async generator |
| **输入** | 键盘 stdin(Ink `useInput`) | HTTP POST `/api/agent/prompt` |
| **输出** | 终端 stdout(Ink 16ms throttle) | SSE `/api/event` + `eventBus.emit(ServerEvent)` |
| **状态管理** | Zustand `useAppState` + module-singleton `messageQueueManager` | 模块级 `Map<sessionId, ReplSession>`(`agentRuntime.repl.ts:87`) + per-session `createReplSession` 实例 |
| **多 session** | 单 session(CLI) | N session(每个 sessionId 一个 `createReplSession`) |

**根因**:zai 没法跑 TUI,只能把 vendor query 内核当成一个 SDK 调用,用 SSE 转播给浏览器。**这不是 GAP,是有意为之**。

> 来源:Agent `aadf187288cf7f353` §B + Agent `aa3212314dc259944` §B

---

### 维度 2:主循环与状态机

| | vendor 原生 REPL | zai REPL |
|---|---|---|
| **主循环** | `REPL.tsx:3109-3314` `onQuery` 的 `for await (event of query({...}))` | `agentRuntime.repl.ts:160` `for await (ev of this.openccRuntime.query(input))`(透传);fallback 路径 `createReplSession.runTurn`(createReplSession.ts:537) |
| **状态机** | `QueryGuard` 三态 `idle / dispatching / running`(`QueryGuard.ts:144`) | 主路径:无独立状态机(vendor QueryGuard 内置在 `createOpenccRuntime` 里);fallback 路径:`QueryGuardState`(setupQueryGuard.ts:22)薄封装 vendor `QueryGuard`,**保留三态语义** |
| **Generation token** | `QueryGuard.end()` line 256 `if (this._generation !== generation) return false` 防 stale finally | 主路径走 vendor,天然继承;fallback 路径透传 `QueryGuardState.end()`(setupQueryGuard.ts:42-44) |
| **AbortController** | `onCancel`(REPL.tsx:2315)`abortController?.abort('user-cancel')` | `ReplRuntime.abort()`(`agentRuntime.repl.ts:237`)→ `session.interrupt()` + enqueue `runtime.aborted` |
| **并发模型** | 单进程单用户,queryGuard.tryStart 防重复 | 多 session 独立 QueryGuard 实例,完全隔离 |

> 来源:Agent `a94d6f9db7ee53f3f` §B/C + Agent `aa3212314dc259944` §B/C

---

### 维度 3:提问链 onSubmit / onQuery / onQueryImpl

| | vendor 原生 REPL | zai REPL |
|---|---|---|
| **onSubmit** | REPL.tsx:3432-3910 `useCallback` 处理 prompt / slash / bash / image / IDE selection / ultracode trigger / stashed prompt | 由 web UI + HTTP 入口替代;fallback 路径:`OnSubmitStateMachine`(stateMachines.ts:23)只做 `/` 前缀解析 + enqueue |
| **onQuery** | REPL.tsx:3109-3260 包含 queryGuard.tryStart / finally / mrOnBeforeQuery / onQueryImpl 完整链 | 主路径:web 直接调 `runtime.query(input)`;fallback 路径:`runTurn()`(createReplSession.ts:359)用 `OnQueryStateMachine` 替代 |
| **onQueryImpl** | REPL.tsx:2915-3108 `Promise.all` 并发加载 systemPrompt / userContext / systemContext + `for await query()` 循环 | 主路径:vendor query 内部处理;fallback 路径:`OnQueryImplStateMachine.buildContext`(stateMachines.ts:91)替代 |
| **3 状态机替代映射** | — | OnSubmitStateMachine → `onSubmit` / OnQueryStateMachine → `onQuery` / OnQueryImplStateMachine → `onQueryImpl` |

> 来源:Agent `a94d6f9db7ee53f3f` §B、G + Agent `aadf187288cf7f353` §C3

---

### 维度 4:Slash 命令(明显 GAP)

| | vendor 原生 REPL | zai REPL |
|---|---|---|
| **数量** | **60+** commands(`opencc-src/commands.ts`) | **3 个**:`['loop', 'swarm', 'send']`(`setupCommandQueue.ts:70`) |
| **处理入口** | `commands.ts` 的 `Command` 接口 + `onSubmit` 路由 | `ReplRuntime.query()` 第 1 分支(`agentRuntime.repl.ts:111-143`)识别后 yield `runtime.notification` + `runtime.done` |
| **缺失命令** | — | `/help /compact /context /model /permission /resume /session /share /status /tasks /theme /clear /diff /ide /mcp /plan /login /logout /memory /skills /vim /workflows /add-dir /btw /prune /reload /review /commit /autofix-pr /init /mobile` 等 **57+ 个** |

**关键影响**:zai web 用户**没有** `/help /compact /permission /context` 等基础命令可用。需要这些能力的场景只能通过 web UI 操作或 builtin server routes。

**为什么只有 3 个**:`setupCommandQueue.ts` 仅定义这三个,扩展方式 = 在白名单加新名字 + 在 `ReplRuntime.query()` slash 分支加 `kind` 处理。**没有实现 vendor `Command` 接口的完整路由**(`processSlashCommand` / `executeBashCommand` 等 vendor 内部能力)。

> 来源:Agent `aa3212314dc259944` §E + Agent `a94d6f9db7ee53f3f` §A1

---

### 维度 5:30+ 通知 hook 覆盖度(明显 GAP)

| | vendor 原生 REPL | zai REPL |
|---|---|---|
| **数量** | **30+** `use*Notification*` React hooks(REPL.tsx:834-866),消费端 `useNotifications`(REPL.tsx:810-813) | **空 bus 框架**:`setupNotifications.ts`(compat/repl/notifications/)只提供 emit/subscribe,无任何 vendor hook 被镜像 |
| **缺失 hook** | — | `useRateLimitWarningNotification` / `useDeprecationWarningNotification` / `useChromeExtensionNotification` / `useLspInitializationNotification` / `useTeammateLifecycleNotification` / `useFastModeNotification` / `useAutoModeUnavailableNotification` / `usePluginAutoupdateNotification` / `usePluginInstallationStatus` / `useModelMigrationNotifications` / `useCanSwitchToExistingSubscription` / `useIDEStatusIndicator` / `useMcpConnectivityStatus` / `useSettingsErrors` / `useInstallMessages` / `useLspPluginRecommendation` / `useClaudeCodeHintRecommendation` / `useUpdateNotification` / `useStartupNotification` 等 |
| **替代物** | — | zai 自实现的 L2 adapters:`setupApiKeyVerification` / `setupCostSummary` / `setupTasksV2Collapse`(各自处理自己的状态变化),**不替代 vendor 通知 hook**,只是用类似 pattern 提供 zai 自家的几类通知 |

**关键影响**:zai web 用户**看不到** rate limit 警告、API 弃用提示、Chrome 扩展状态、LSP 初始化、plugin 自动更新、模型迁移提醒、MCP 连接问题等等 30+ 类 UI 通知。

> 来源:Agent `a94d6f9db7ee53f3f` §F + Agent `aa3212314dc259944` §F

---

### 维度 6:子 agent / background / swarm / mailbox

| vendor hook | zai setup | 功能对等性 |
|---|---|---|
| `useInboxPoller`(opencc-src/hooks/useInboxPoller.ts:126)— 轮询 inbox + 处理 teammate 消息 + permission 响应 | `setupInboxPoller.ts:20` | **简化版** — 2s 轮询 `.zai/inbox/${sessionId}.jsonl`,**不处理 permission 响应,不解析 teammate message types** |
| `useMailboxBridge`(opencc-src/hooks/useMailboxBridge.ts:12)— 跨 session 消息 | `setupMailboxBridge.ts:20` | **简化版** — 仅 `appendFileSync` 写 inbox 文件,**无订阅机制** |
| `useSwarmInitialization`(opencc-src/hooks/useSwarmInitialization.ts:30)— team context + teammate hooks | `setupSwarmInitialization.ts:18` | **stub** — 仅 `createTeammate()` 生成 ID + 存 module-level map,**无 team context 初始化** |
| `useSessionBackgrounding`(opencc-src/hooks/useSessionBackgrounding.ts:27)— background/foreground 状态 | `setupSessionBackgrounding.ts:15` | **基本对等** — `background()`/`foreground()` 回调 + `isBackground` 状态 |

**关键影响**:zai 端**只覆盖了子 agent 协议的写面(发消息)**,读面(处理 teammate 消息类型、permission 响应、team 初始化)**全部缺失或不完整**。意味着 zai 用户看到的子 agent 行为是残缺的。

> 来源:Agent `aa3212314dc259944` §I + Agent `aadf187288cf7f353` §C2

---

### 维度 7:Elicitation / Permission / Ask(中等 GAP)

| | vendor 原生 REPL | zai REPL |
|---|---|---|
| **ElicitationRegistry** | vendor MCP 接口,form/url 请求分发 | **stub** in `createReplSession.ts:239-271`(in-process 实现 `{ request, resolve, cancel, hasPending }`)+ zai web 通过 `opts.elicitationRegistry` 注入真 registry |
| **PermissionMode** | `opencc-src/utils/permissions/PermissionMode.ts` | zai 通过 `transitionPermissionMode` + `ctx.appState.setState` 在 `createOpenccRuntime-impl.ts:525-549` 镜像 |
| **Ask** | `tool_use:ask_pending` 触发 TUI 对话框 | `__zaiBridgeCtx.onYield`(agentRuntime.ts:178)→ `bridgeToolYieldToPrompt` → SSE `prompt.ask` event |
| **Permission 请求** | `tool_use:permission_pending` TUI 弹窗 | `__zaiBridgeCtx.permissionRegistry` → SSE `prompt.permission` event |

**关键桥接**:`__zaiBridgeCtx`(globalThis)在 `initAgentRuntime` 时一次性注入,`AskUserQuestionTool` 等 vendor 工具 call-time 读取,把 vendor TUI 协议翻译成 zai SSE 事件。

> 来源:Agent `aa3212314dc259944` §H

---

### 维度 8:Resume / Session 状态恢复(部分 GAP)

| | vendor `restoreSessionStateFromLog` | zai `compat/repl/sessionRestore.ts` |
|---|---|---|
| **恢复内容** | messages / fileHistorySnapshots / attributionSnapshots / contextCollapseSnapshot / worktreeSession / todos / activeGoal / agentDefinition | messages / worktreeSession / fileHistory / costState / planSlug / attribution / agentDefinition(sessionRestore.ts:91-98) |
| **缺失** | — | **contextCollapse**(sessionRestore.ts:99 有 `// if (false)` 注释掉的分支) / **todos** / **activeGoal** |

> 来源:Agent `a94d6f9db7ee53f3f` §A + Agent `aa3212314dc259944` §G

---

## 3. zai 14 个 setup 模块速查

> ⚠️ 这些 setup 模块**只在 fallback 路径**(主路径走 vendor `createOpenccRuntime`)生效。
> 来源:Agent `aadf187288cf7f353` §C2

| setup 模块 | 职责 | 文件:行号 |
|---|---|---|
| `setupCommandQueue` | 封装 vendor `messageQueueManager`,导出 `parseSlashCommand` + `KNOWN_SLASH_COMMANDS` | `setupCommandQueue.ts:96-142` |
| `setupCronScheduler` | 封装 vendor `createCronScheduler`(1s tick) | `setupCronScheduler.ts:26-62` |
| `setupProactive` | GrowthBook PROACTIVE/KAIROS 门控;30s 轮询 | `setupProactive.ts:42-84` |
| `setupQueryGuard` | `QueryGuardState` 类,封装 vendor `QueryGuard` 为非 React imperative | `setupQueryGuard.ts:62-76` |
| `setupCommandKeybindings` | `/` 前缀命令解析状态机 | `setupCommandKeybindings.ts:48-59` |
| `setupInboxPoller` | 轮询 `.zai/inbox/${sessionId}.jsonl`;2s 间隔(**简化版**) | `setupInboxPoller.ts:20-62` |
| `setupMailboxBridge` | 跨会话消息写入 recipient inbox 文件(**简化版**) | `setupMailboxBridge.ts:20-47` |
| `setupSwarmInitialization` | teammate 创建/列表(**stub**) | `setupSwarmInitialization.ts:18-37` |
| `setupSessionBackgrounding` | 前后台状态跟踪;`background()`/`foreground()` 回调 | `setupSessionBackgrounding.ts:15-36` |
| `setupSkillsChange` | chokidar 监控 `.agents/skills/`;200ms 防抖 | `setupSkillsChange.ts:31-105` |
| `setupApiKeyVerification` | 检查 ANTHROPIC_API_KEY / OPENAI_API_KEY env | `setupApiKeyVerification.ts:9-24` |
| `setupCostSummary` | 成本汇总刷新(P2 minimal: 全 0) | `setupCostSummary.ts:9-27` |
| `setupTasksV2Collapse` | 任务列表折叠状态 toggle | `setupTasksV2Collapse.ts:12-32` |
| `setupNotifications` | 统一通知总线;emit/subscribe(空 bus 框架) | `setupNotifications.ts:16-43` |

---

## 4. 关键不变量

| 不变量 | 文件:行号 | 含义 |
|---|---|---|
| `ZAI_RUNTIME_CORE` 默认值 | `agentRuntime.ts:91` | `'repl'` |
| 主对话路径委托 | `agentRuntime.repl.ts:160` | `for await (const ev of this.openccRuntime.query(input))` |
| `querySource: 'server-repl'` | `createReplSession.ts:503, 544` | vendor 区分 in-process server vs `repl_main_thread`(终端)/ `sdk`(CLI 子进程) |
| `__zaiBridgeCtx` 注入 | `agentRuntime.ts:178` | `{ askRegistry, permissionRegistry, onYield }` 桥接 vendor TUI → zai SSE |
| 单 module 实例 | `bundle-entry.ts:1-16` | `dist/opencc-core.mjs` 单一 bundle,杜绝双 module 实例导致 `commandQueue` 不共享 |
| `QueryGuard` generation token | `QueryGuard.ts:256` | `end(generation)` 防 stale finally,主/备路径都继承 |
| `createOpenccRuntime` 8 方法契约 | `serverTypes.ts:274` | query / abort / getSession / listSessions / readTranscript / patchSession / removeSession / shutdown + plugins |
| mid-turn drain(vendor) | `query.ts:2671-2679` | `getCommandsByMaxPriority` 同步 drain;**zai 没有自己的实现**,InboxPoller 是 2s 轮询的替代机制 |

---

## 5. 速查表 — 真实 GAP 一览

| GAP 维度 | vendor 原生 REPL | zai REPL | 严重性 |
|---|---|---|---|
| 进程模型 | Ink/React TUI 单用户 | HTTP/SSE 多用户 | 有意为之,非缺陷 |
| 主循环 | `for await (query(...))` | 委托 vendor `createOpenccRuntime.query()` | ✅ 对齐 |
| 状态机 | QueryGuard 三态 + generation | 主路径继承;fallback `QueryGuardState` 薄封装 | ✅ 对齐 |
| Abort/Interrupt | onCancel + abortController | `ReplRuntime.abort()` → `session.interrupt()` + `runtime.aborted` | ✅ 对齐 |
| Slash 命令 | **60+** commands | **3** 个(loop/swarm/send) | 🔴 **明显 GAP** |
| 30+ 通知 hook | 全部 hook | **空 bus 框架** + 3 个 zai 自实现 L2 adapter | 🔴 **明显 GAP** |
| `useInboxPoller` | 完整轮询 + permission 响应 + teammate msg | 2s 轮询 + **不解析 message types** | 🟠 部分 GAP |
| `useMailboxBridge` | 跨 session 消息 + 订阅机制 | 仅 `appendFileSync` 写文件 | 🟠 部分 GAP |
| `useSwarmInitialization` | team context + teammate hooks | **stub** createTeammate + module-level map | 🔴 严重 GAP |
| `useSessionBackgrounding` | background/foreground | 基本对等 | ✅ 对齐 |
| `useSkillsChange` | chokidar hot-reload | 200ms 防抖 + chokidar | ✅ 对齐 |
| Elicitation / Permission / Ask | TUI 弹窗 | `__zaiBridgeCtx` + SSE event | ✅ 对齐 |
| Resume 状态 | 7 类(messages/fileHistory/attribution/contextCollapse/worktree/todos/agent) | 6 类(**缺 contextCollapse/todos/activeGoal**) | 🟠 部分 GAP |
| 14 setup 模块 | vendor hooks | fallback 路径 imperative 包装(主路径不生效) | ⚠️ 仅 fallback |
| vendor TUI 独有能力 | AnimatedTerminalTitle / OSC 21337 / Buddy / Voice / Keybindings 全部 | 全部 **缺失**(non-TTY) | 🔴 非 TUI 不可弥补 |

---

## 6. 修复路径(参考 spec §7)

文档 [`docs/superpowers/specs/2026-08-27-zai-headless-runtime-vs-vendor-repl-comparison.md`](./superpowers/specs/2026-08-27-zai-headless-runtime-vs-vendor-repl-comparison.md) 给出 4 条路径:

- **路径 A(短期推荐,改动小)**:把 vendor `print.ts`(5771 行)用 `ZAI_OPENCC_CLI=1` 双轨 spawn 进来,**直接拿 vendor 真 REPL 全循环**。代价是 stdio NDJSON + control_request IPC 复杂度。
- **路径 B(不推荐)**:把 `print.ts` 外壳代码镜像进 `createOpenccRuntime`。双份维护负担。
- **路径 C(治本)**:抽共享 `HeadlessSessionEngine`,把 `print.ts` 的 `run()` 循环重构为可 import 引擎。vendor 重构成本高。
- **路径 D(现状)**:zai 持续手工镜像 vendor REPL 行为。每次 vendor 改 REPL,识别需要镜像的点,在 impl.ts 里打 `zai patch` 注释同步。

> 详细对比见 spec §5.8 / §6 / §7。

---

## 7. 子报告索引

| Agent ID | 调研切面 | 关键结论 |
|---|---|---|
| `aadf187288cf7f353` | zai REPL 实现真实架构 | ReplRuntime 三分支 + 14 setup 模块 + stateMachines + 与 `createOpenccRuntime` 委托关系 |
| `a94d6f9db7ee53f3f` | vendor 原生 REPL.tsx(5366 行) | 50+ React hooks + onSubmit/onQuery/onQueryImpl + QueryGuard + 60+ slash + 30+ 通知 hook |
| `aa3212314dc259944` | 两者 GAP 对比 | 8 维度对比 + 关键不变量 + 修复路径 |

每条结论可追到对应 agent 的子报告(子报告输出文件在 task output 中)。

---

## 文档元信息

- 路径:`docs/2026-09-06-opencc-web-repl-unified-view.md`
- 编写日期:2026-09-06
- 调研方法:3 个独立 Explore agent 并行 + 主对话综合交叉验证
- 数据源:zai REPL 架构 / vendor REPL.tsx(5366 行)/ GAP 对比三份子报告
- 维护建议:vendor REPL.tsx 大改时,需重跑三个 agent 并更新 §2 真实 GAP 对比表
