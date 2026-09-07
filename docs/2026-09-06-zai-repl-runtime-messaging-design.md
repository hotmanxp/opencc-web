# zai repl runtime 消息体系方案

## 一句话立场

zai 在 vendor 单进程单会话 CLI 的设计前提上扩展为多会话服务:存储层复用 vendor `commandQueue` 单例 + 自建 per-session lane 双层;生产层在实测 22 个 vendor `enqueuePendingNotification` 调用方处直接打补丁注入 `agentId=sessionId`,把 vendor 既有的"主线程 vs 子 agent"filter 重新用作 session 路由;消费层保留 vendor mid-turn drain / pre-API inbox reminder,新增 zai 自有的 session inbox bridge、in-process mailbox signal 和 fallback imperative loop。本方案是 `docs/2026-09-06-zai-session-isolation-plan.md` 的**实施视图**——把"三维度"翻译成可落地的 repl runtime 消息体系,与该 plan 互补(本方案聚焦消息体系本身,plan 聚焦三维度策略),不替代。

## 0. 范围与前置事实

- **当前 HEAD**:`251309ef docs: zai 对标 vendor 消息体系的 Session 隔离方案(三维度 plan)`
- **working tree**:有两个未追踪的备查稿(命名后缀暗示视角变体),本方案独立产出
- **包结构**:`packages/` 只含 `zai/` 与 `zn-agent-core/`,与文档一致
- **核心代码现实**:
  - `packages/zn-agent-core/src/opencc-src/utils/messageQueueManager.ts:52` 是 vendor `commandQueue` 模块级 singleton
  - `packages/zn-agent-core/src/opencc-src/query.ts:2660-2691` 是 mid-turn drain 真实实现
  - `packages/zn-agent-core/src/opencc-src/utils/daemon/preApiCallReminders.ts:37` 是 zai 注册 reminder provider 的 vendor 入口
  - `packages/zn-agent-core/src/opencc-src/types/textInputTypes.ts:301-372` 是 `QueuedCommand` 字段定义,`agentId` 字段(`L353-359`)注释明写"Subagents run in-process and share the module-level command queue"
  - `packages/zai/src/server/services/sessionInbox.ts:181-196` 是 per-session `SessionInbox` 工厂
  - `packages/zai/src/server/services/agentRuntime.ts:666-715` 是 `ZAI_RUNTIME_CORE=repl` 默认主路径(ReplRuntime 委托 createOpenccRuntime)
  - `packages/zn-agent-core/src/compat/repl/createReplSession.ts:155-227` 是 fallback 路径的 14 个 setup 模块入口
- **与现有 plan 的关系**:**互补**。`2026-09-06-zai-session-isolation-plan.md` 提供三维度策略与优先级;本方案把它落地为"存储 + 生产 + 消费"三层目录树 + 改造清单 + 实施 Phase。

## 1. repl runtime 消息体系全景

### 1.1 体系架构图

```text
                       ┌──────────────────────────────────────────────┐
                       │  生产端(22 个 vendor enqueuePendingNotification │
                       │  调用方,均经 zai layer wrapper)               │
                       │  - LocalShellTask.tsx 4 处 / LocalAgentTask 1 处 │
                       │  - RemoteAgentTask.tsx 4 处 / LocalWorkflow 1 处 │
                       │  - LocalMainSessionTask 1 处 / framework 1 处   │
                       │  - useScheduledTasks 1 / useCancelRequest 1    │
                       │  - hooks.ts 1 / ultraplan.tsx 7 / processSlash 1│
                       │  - ExitPlanModePermissionRequest 1             │
                       └─────────────┬────────────────────────────────┘
                                     │ zaiEnqueuePendingNotification({...cmd, agentId: sessionId})
                                     ▼
┌────────────────────────────────────────────────────────────────────────┐
│  存储层(三类)                                                         │
│  ┌────────────────────────┐  ┌──────────────────────────────────┐      │
│  │ 进程级 singleton       │  │ per-session lane store           │      │
│  │ messageQueueManager    │  │ SessionInbox(sid):               │      │
│  │ .commandQueue(L52)     │  │   nextTurn / nextStep / busy     │      │
│  │ - module-level array   │  │   wakeBudget Map<sid,n>          │      │
│  │ - agentId 字段做 session│  │ agentRuntime.ts:145-150 注入     │      │
│  │   路由(本方案核心)    │  │ globalThis.__zaiSessionInbox      │      │
│  └────────────────────────┘  └──────────────────────────────────┘      │
│                                                                        │
│  ┌────────────────────────────────────────────────────────────────┐    │
│  │ 文件存储                                                          │    │
│  │ - ~/.zai/teams/{team}/inboxes/{agent}.json(agentName 路由)     │    │
│  │ - ~/.zai/projects/<project>/queue_operations.json(replay)       │    │
│  │ - ~/.zai/scheduled_tasks.json(cron 持久)                       │    │
│  │ - ${cwd}/.zai/inbox/${to}.jsonl(跨 REPL session)                │    │
│  │ - vendor bg-daemon Unix socket IPC(bg agent 完成)             │    │
│  └────────────────────────────────────────────────────────────────┘    │
└────────────────────────────────────────────────────────────────────────┘
                                     │
                                     ▼
┌────────────────────────────────────────────────────────────────────────┐
│  消费层(5 + 1 消费者,全部 session-aware)                               │
│  ① mid-turn drain  query.ts:2660-2691      vendor 真循环内,主/子 filter│
│  ② pre-API reminder preApiCallReminders.ts:53 query.ts:701 每次 LLM 前 │
│  ③ in-process mailbox signal   compat/repl/setup/setupMailboxBridge.ts  │
│  ④ session inbox bridge (idle) routes/agent.ts:936 runNextInQueue     │
│  ⑤ cronScheduler   compat/repl/setup/setupCronScheduler.ts(63 行)     │
│  + fallback inbox poller   compat/repl/setup/setupInboxPoller.ts(62 行)│
└────────────────────────────────────────────────────────────────────────┘
                                     │
                                     ▼
                       ┌──────────────────────────────────────┐
                       │  LLM 感知(下一轮 API call)         │
                       │  - AttachmentMessage(queued_command)│
                       │  - <system-reminder>(bg 通知)      │
                       │  - 新一轮 UserMessage(inbox 唤醒)   │
                       └──────────────────────────────────────┘
```

### 1.2 三个层次职责

| 层次 | 职责 | 实现位置 | session 隔离策略 |
|---|---|---|---|
| 存储层 | 消息落地、跨 turn 持久、跨进程可见 | vendor `commandQueue` + zai `SessionInbox` Map + 文件 | `agentId` 字段做路由 |
| 生产层 | 21 个调用方统一注入 `sessionId` | `zaiEnqueuePendingNotification` wrapper + vendor patch | ALS `getSessionId()` + `cmd.agentId ??` |
| 消费层 | 5 个消费者按自身时机读 | vendor query loop + zai 自有 scheduler/bridge | filter by `agentId === currentAgentId` |

## 2. 存储层设计

### 2.1 per-session lane store

**核心**:`SessionInbox`(`packages/zai/src/server/services/sessionInbox.ts:45-154`),每个 session 一个实例,存于模块级 `Map<sessionId, SessionInbox>`(`sessionInbox.ts:160` 的 `sessionInboxes`)。

| 数据结构 | 行号 | 语义 |
|---|---|---|
| `lanes: Map<sid, {nextTurn, nextStep}>` | 46 | nextTurn = 唤醒 prompt;nextStep = mid-turn reminder |
| `busy: Set<sid>` | 47 | 占用标记(`runNextInQueue` 入口 set/clear) |
| `wakeBudget: Map<sid, number>` | 48 | 防后台连环唤醒,默认 3 |
| `wakeHandler: (sid) => void` | 49 | 由 `setSessionInboxWakeHandler` 注册为 `runNextInQueue` |

**生命周期**:
- 创建:`getSessionInbox(sid)` lazy(`sessionInbox.ts:181-196`),首次访问自动绑 wake handler
- 清理:`disposeSessionInbox(sid)`(`sessionInbox.ts:203-205`),`gc()` 在 lanes 双双清空时自动从 Map 移除(`sessionInbox.ts:148-153`)
- 关联:`agentRuntime.ts:145-150` 注入 `globalThis.__zaiSessionInbox.{followup,inject}`,让 vendor / zn-agent-core 端(不同 module 实例)能反向调到 zai lane

**跨 session 边界**:每个 sid 独立 `Map` 条目,`gc` 自动清空;`wakeHandler` 内部捕获 `fn`(闭包),wake 调用仅触发对应 sid 的 `runNextInQueue(sid)`,不会跨 sid 唤起。

### 2.2 进程级 shared store

**进程级 vendor `commandQueue`**(`messageQueueManager.ts:52`):

| 必须进程级 | 原因 | session 化方式 |
|---|---|---|
| `commandQueue` 数组 | 模块级 singleton,所有 vendor 调用方共享 | **`agentId` 字段做 session 路由** |
| `snapshot`(`L54`) | React useSyncExternalStore 订阅对象 | filter by `agentId` 间接路由 |
| `queueChanged` signal(`L55`) | vendor 全局 signal,emit 同步遍历 listener | 不变,后置 filter |
| `engines: Map<sid, QueryEngine>`(`createOpenccRuntime-impl.ts:577-625`) | 已 per-session | 已隔离 |
| `queryAbortControllers: Map<sid, AbortController>`(`L561-565`) | 已 per-session | 已隔离 |
| `runtimeCore: Map<sid, RuntimeGuardState>`(`agentRuntime.ts:347-381`) | 已 per-session | 已隔离 |
| `sharedOpenccRuntimeSingleton`(`agentRuntime.ts:696`) | ⚠️ 单例,query 入口按 sid 分发 | query 入口分发 OK |

**为什么必须进程级**:vendor 单进程假设的产物。**绕不开的代价** = 必须 zai patch 让 vendor 入队时携带 sid。**绕得开的代价** = vendor mid-turn drain 仍读 vendor queue,自己完全镜像等于双份维护(`plan §6.2` 评估过,否决)。

### 2.3 文件存储

| 文件 | 路由策略 | 写入位置 | session 隔离要求 |
|---|---|---|---|
| `~/.zai/teams/{team}/inboxes/{agentName}.json` | agentName(无 sid 概念) | vendor `SendMessageTool.writeToMailbox` | zai 层维护 agentName→sessionId 映射 |
| `~/.zai/projects/<project>/queue_operations.json` | 全局(replay) | vendor `recordQueueOperation`(`sessionStorage.ts:2113`) | 字段含 sessionId,replay 时按 sid 重建 |
| `~/.zai/scheduled_tasks.json` | 全局 cron 持久 | vendor `cronScheduler` + `addCronTask` | cron task 带 `targetSessionId` 决定 fire 路由 |
| `${cwd}/.zai/inbox/${to}.jsonl` | `to`(jsonl) | zai patch `setupMailboxBridge.ts:33` | 已对齐 |
| vendor bg-daemon Unix socket IPC | clientId(`daemon/mailbox.ts:99-105`) | vendor 内部 | clientId 需 zai patch 加 sid 维度 |

**跨 session 串扰风险点**:teammate mailbox 是 agentName 路由,与 zai sessionId 不对应——zai 必须维护映射表(已记为 plan 1.4)。

## 3. 生产层设计

### 3.1 真实调用方清单(实测 main HEAD 251309ef)

`enqueuePendingNotification` 调用方实测 grep:`packages/zn-agent-core/src/opencc-src/` 全树 21 处(`grep -rEn "^\s*enqueuePendingNotification\("` 命中 19 行 + 1 个箭头函数内嵌 + 1 个 Promise then):

| # | 文件:行号 | 上下文分类 | 是否走 vendor query |
|---|---|---|---|
| 1 | `tasks/LocalShellTask/LocalShellTask.tsx:112` | 异步回调(stall watchdog) | 是(`runInBackground` 路径) |
| 2 | `tasks/LocalShellTask/LocalShellTask.tsx:192` | 异步回调(bash 后台完成) | 是 |
| 3 | `tasks/LocalMainSessionTask.ts:263` | 异步回调(主 session 后台任务) | 是 |
| 4 | `tasks/LocalAgentTask/LocalAgentTask.tsx:260` | 异步回调(子 agent 完成) | 是 |
| 5 | `tasks/RemoteAgentTask/RemoteAgentTask.tsx:203` | 异步回调(远程任务完成) | 是 |
| 6 | `tasks/RemoteAgentTask/RemoteAgentTask.tsx:259` | 异步回调(ultraplan 失败) | 是 |
| 7 | `tasks/RemoteAgentTask/RemoteAgentTask.tsx:362` | 异步回调(远程 review 完成) | 是 |
| 8 | `tasks/RemoteAgentTask/RemoteAgentTask.tsx:380` | 异步回调(远程 review 失败) | 是 |
| 9 | `tasks/LocalWorkflowTask/LocalWorkflowTask.ts:502` | 异步回调(workflow 完成/失败) | 是 |
| 10 | `utils/task/framework.ts:289` | 异步回调(framework 任务) | 是 |
| 11 | `hooks/useCancelRequest.ts:233` | React hook(zai 主路径不挂) | fallback 镜像 |
| 12 | `hooks/useScheduledTasks.ts:74` | React hook(cron tick,zai 主路径不挂) | fallback `setupCronScheduler.ts:33` |
| 13 | `utils/hooks.ts:412` | hook 失败回调 | 是 |
| 14-20 | `commands/ultraplan.tsx:119,153,216,220,324,348,390` | ultraplan 各阶段(7 处) | 是 |
| 21 | `utils/processUserInput/processSlashCommand.tsx:134` | slash 结果回填(箭头函数内嵌) | 是 |
| +1 | `components/permissions/ExitPlanModePermissionRequest/ExitPlanModePermissionRequest.tsx:340` | Promise then 内嵌 | 是 |

合计 **22 个真实调用点**(与 plan §2.1 列的 26 个有差异——plan 把 vendor 文档里的几个注释行/间接调用算进了 26,实测真调用点 = 22)。**间接调用方 = 0**(`enqueuePendingNotification` 仅由 vendor 函数直接调)。

### 3.2 sessionId 注入策略

**不**用 ALS fallback 自动取(说"自动"会让 vendor 调用方误以为 sid 一定有,实际 vendor CLI 单进程单 session 设计里 sid 是隐式的);改用**调用方显式入参 + wrapper 自动补**:

```typescript
// packages/zai/src/server/services/messageQueueAdapter.ts(新)
import { enqueuePendingNotification as _v,
         getSessionId,
         type QueuedCommand } from '@zn-ai/zn-agent-core'

export function zaiEnqueuePendingNotification(cmd: QueuedCommand): void {
  const sid = cmd.agentId ?? getSessionId()
  if (!sid) throw new Error('zaiEnqueue: agentId or sessionId required')
  return _v({ ...cmd, agentId: sid })
}
```

- `cmd.agentId` 显式传 = 子 agent 通知(子 agent 完成 → agentId = 子 agent 名 → 走 vendor 子 agent filter)
- `cmd.agentId` 未传 + ALS 有 sid = 主 session 通知(走 vendor 主线程 filter)
- 两者皆空 = 抛错,不让无主通知污染 vendor queue

**globalThis 兜底**:vendor `messageQueueManager.ts:28` 的 `logOperation` 调 `getSessionId()`(ALS),zai 在 vendor query 调用栈内已设过 `runWithSessionId`(`createReplSession.ts:392`),vendor 入栈期间 ALS 有效。

### 3.3 vendor call site 改造清单

| 改造类型 | 文件 | 方式 | 优先级 |
|---|---|---|---|
| **vendor patch 替换 22 个调用方** | 全部 14 个 vendor 文件 | import + 调用替换 | P0 |
| **zai 层 wrapper** | `packages/zai/src/server/services/messageQueueAdapter.ts`(新) | zai 层包装 | P0 |
| **zai patch `toolUseContext.agentId = sid`** | `compat/repl/createReplSession.ts:486-536` 工具上下文构造 | **zai patch vendor** | P0 |
| **保留 vendor 原状** | `messageQueueManager.ts:147` 的 `enqueuePendingNotification` 函数本身(只替换调用方) | 不动 | — |

## 4. 消费层设计

### 4.1 mid-turn drain(turn 内并发通知)

**vendor 真实代码**(`query.ts:2660-2691`):

```text
sleepRan = toolUseBlocks.some(b => b.name === SLEEP_TOOL_NAME)
isMainThread = querySource in {'repl_main_thread', 'server-repl', 'sdk'}
currentAgentId = toolUseContext.agentId
queuedCommandsSnapshot = getCommandsByMaxPriority(sleepRan ? 'later' : 'next')
  .filter(cmd => {
    if (isSlashCommand(cmd)) return false
    if (isMainThread) return cmd.agentId === undefined
    return cmd.mode === 'task-notification' && cmd.agentId === currentAgentId
  })
```

**zai patch 后主/子 filter 处理**:

| zai 场景 | `querySource` | `toolUseContext.agentId` | 期望取到的 cmd |
|---|---|---|---|
| 主 session prompt | `'server-repl'`(`createOpenccRuntime-impl.ts:638-642` 注入) | sid(主 session id) | `cmd.agentId === sid`(子 agent 路径生效) |
| 子 agent query | 子 agent SDK call | 子 agent name | `cmd.agentId === 子 agent name` |
| vendor CLI 单进程模式 | `'repl_main_thread'` | `undefined` | `cmd.agentId === undefined`(原行为) |

**关键发现**:zai patch 后 `isMainThread=true` 路径不再命中——因为 zai 的 cmd 全部有 `agentId`(wrapper 强制),`cmd.agentId === undefined` 分支**永远 false**;所有 cmd 走子 agent filter `cmd.agentId === currentAgentId`。这正是 zai 想要的:**没有"主线程"概念,所有通知按 sessionId 路由**。

**sessionId 路由机制**:`cmd.agentId = sid`(wrapper 注入) + `toolUseContext.agentId = sid`(zai patch) → filter 命中。

### 4.2 inbox poller(turn 间通知)

**vendor 现状**:`useInboxPoller.ts:107` `INBOX_POLL_INTERVAL_MS = 1000`,`useInterval` 1000ms tick 读 `~/.zai/teams/{team}/inboxes/{agentName}.json`。

**zai 主路径**:不跑 React hook(委托 vendor query)。fallback 走 `compat/repl/setup/setupInboxPoller.ts`(62 行,已镜像)。

**session-aware 改造点**(plan §2.2 消费者 4):
- 维持 1000ms tick(实测 vendor 常量)
- 改"基于 agentName"为"agentName → sessionId 映射"(`zai 层` 加 `Map<agentName, sessionId>`,由 zai 配置/启动时注册)
- 8 类 message types 解析由 zai 层 `inboxMessageHandler.ts`(新)实现,不需改 vendor
- busy→idle 切换时(`useInboxPoller.ts:876-950` 镜像)在 fallback `setupInboxPoller.ts` 实现 sessionId 路由

### 4.3 mailbox bridge(进程级内存信号)

**vendor 现状**:`useMailboxBridge.ts:12-23` 订阅 `Mailbox` 类的 signal(`utils/mailbox.ts`),`useSyncExternalStore` 订阅 `mailbox.revision`;busy 时不 poll,idle 时 `mailbox.poll()` 取一条 → `onSubmitMessage`。

**zai 改造**:
- **zai patch** `useMailboxBridge.ts:12-23`:增 `sessionId` 参数,mailbox 内容物带 sid 标签(主路径不跑但留 vendor patch 注释)
- **fallback** `compat/repl/setup/setupMailboxBridge.ts`(47 行)改 in-memory signal,`appendFileSync` 写 `${cwd}/.zai/inbox/${to}.jsonl`
- 跨 session 文件写入由 zai 层独立完成,内存信号仅本 session 消费

### 4.4 cron scheduler

**vendor 现状**:`utils/cronScheduler.ts:62-128` `CronSchedulerOptions`,`createCronScheduler({onFire, isLoading, ...})`;`CHECK_INTERVAL_MS = 1000`(`L40`)1 秒 tick。

**zai 现状**:主路径不跑(zai 服务端不挂 vendor React hook);fallback `compat/repl/setup/setupCronScheduler.ts`(63 行)已镜像,带 `enqueueForLead`(`L33` 入 `commandQueue`)。

**session-scoped cron**:
- `~/.zai/scheduled_tasks.json` 全局持久(vendor 行为,不变)
- session-only cron(`/loop`)走 `getSessionCronTasks()` 内存表,已 session 隔离(`bootstrap/state.ts`)
- fire 路由:`cron task` 带 `targetSessionId` 字段(`plan §1.2` L81),fallback `setupCronScheduler` 入 `commandQueue` 时打 `agentId = targetSessionId`
- turn 期间不发:`isLoading() && !assistantMode → return`(`cronScheduler.ts:230`)

### 4.5 pre-API inbox reminder

**vendor hook + zai layer 双层**:
- vendor hook(`preApiCallReminders.ts:37`):`registerExtraReminderProvider(fn)`,zai `agentRuntime.ts:164` 注册 `(sid) => drainInboxReminder(sid)`
- zai `inboxReminder.ts:41-44` `drainInboxReminder(sessionId)`:
  1. `getSessionInbox(sid).consumeNextStep(sid)` 拿 per-session nextStep lane
  2. `renderInboxReminder(messages)`(`L54-67`)→ `<system-reminder>` 块
  3. 返回 `null` 时短路(不破坏 prompt cache)
- vendor 调用点(`query.ts:701` `runExtraReminderProviders(getSessionId())`):每次 LLM API call 前
- 已 session 隔离(ALS `getSessionId()` 取当前 sid),无需改 vendor

## 5. repl runtime 循环机制

### 5.1 主路径(委托 vendor query)— `ZAI_RUNTIME_CORE=repl` 默认

**8 方法契约**(`createOpenccRuntime`):

```typescript
const sharedRuntime = await createOpenccRuntimeFactory({
  dataDir, runtimeId: 'zai-server', defaultCwd: cwd,
  defaultModel: process.env.ANTHROPIC_DEFAULT_SONNET_MODEL ?? process.env.ANTHROPIC_SMALL_FAST_MODEL,
  connectMcp: false, interactive: !(isSdk ?? false),
})  // agentRuntime.ts:673-689
runtime = new ReplRuntime(sharedRuntime)  // L705
```

8 方法 = `query / abort / getSession / listSessions / readTranscript / patchSession / removeSession / shutdown`(spec §3)。

**自动继承 vendor 内置机制**:
- vendor mid-turn drain(`query.ts:2660`)自动 session-aware(因为 zai patch 让 `toolUseContext.agentId = sid` + wrapper 强制 `cmd.agentId = sid`)
- vendor pre-API reminder(`query.ts:701`)自动 per-session(ALS `getSessionId()`)
- vendor `cronScheduler` / `useInboxPoller` / `useMailboxBridge` / 30+ React hook**不挂**(主路径不跑 React)
- vendor `commandQueue` 路由自动(`agentId` 字段注入 sid)

### 5.2 fallback 路径(自建 imperative)— `ZAI_RUNTIME_CORE=repl` 的 createReplSession stub

**14 个 setup 模块**(`packages/zn-agent-core/src/compat/repl/setup/`):

| 模块 | 行数 | 职责 |
|---|---|---|
| `setupCommandQueue.ts` | 142 | 本地命令队列(cmdQueue) |
| `setupCronScheduler.ts` | 63 | cron 1s tick + 镜像 vendor |
| `setupProactive.ts` | 84 | proactive tick(主路径不挂,fallback 用) |
| `setupQueryGuard.ts` | 76 | 状态机(`idle|busy|running`) |
| `setupInboxPoller.ts` | 62 | 1000ms 轮询(镜像 vendor,fallback 用) |
| `setupMailboxBridge.ts` | 47 | 内存 mailbox signal |
| `setupSwarmInitialization.ts` | 37 | team 初始化 |
| `setupSessionBackgrounding.ts` | 36 | background session |
| `setupSkillsChange.ts` | 106 | skill hot-reload |
| `setupApiKeyVerification.ts` | 24 | API key 检查 |
| `setupCostSummary.ts` | 27 | cost 汇总 |
| `setupTasksV2Collapse.ts` | 32 | tasks UI 折叠 |
| `setupNotifications.ts`(sub) | — | notification bus |
| `setupCommandKeybindings.ts` | 59 | keybindings |

合计 ~813 行 + notifications 子目录。**LIFO teardown**(`createReplSession.ts:343-357`),dispose 按相反顺序 unwinding。

**session 隔离边界**:
- 每个 session 一个 `ReplSession` 实例(`replRuntime.sessions: Map<sid, ReplSession>`)— 天然隔离
- `cmdQueue` / `cronHandle` / `proactiveHandle` / `inboxHandle` / `mailboxHandle` 等都是 session-scope closure
- per-session `QueryGuardState`(`setupQueryGuard.ts:62-76`)

### 5.3 三层切换条件

| 路径 | 触发条件 | 完整度 | 用途 |
|---|---|---|---|
| **主路径**(`repl`) | `ZAI_RUNTIME_CORE=repl` 且 `initAgentRuntime` 成功 | 8/30 | 默认,委托 vendor query |
| **fallback**(`repl` stub) | `openccRuntime` 未注入(单元测试场景) | 14 setup + 3 stateMachine ≈ 40-50% | 测试 / 紧急回退 |
| **fallback**(`inproc`) | `ZAI_RUNTIME_CORE=inproc`(`createPrintRuntime`) | 28/30 | 备选双轨,需 zai HTTP/SSE ↔ SDK stream-json + control_request 协议对齐 |
| **fallback**(`spawn`) | `ZAI_RUNTIME_CORE=spawn`(`SessionHostRuntimeAdapter`) | 30/30(委托 vendor CLI) | 备选双轨,IPC 复杂度高 |

## 6. session 隔离边界

### 6.1 严格 per-session 资源

| 资源 | 文件:行号 | 隔离机制 |
|---|---|---|
| `SessionInbox` | `sessionInbox.ts:160` 的 `sessionInboxes: Map<sid, ...>` | Map 工厂 |
| `QueryEngine` | `createOpenccRuntime-impl.ts:577-625` `engines: Map<sid, ...>` | Map |
| `AbortController` | `createOpenccRuntime-impl.ts:561-565` `queryAbortControllers: Map<sid, ...>` | Map |
| `QueryGuardState` | `compat/repl/setup/setupQueryGuard.ts:62-76`(fallback) | per-session closure |
| `eventBus` listener | `eventBus.ts` per-session? | zai 需 patch |

### 6.2 进程级 shared 但 session-aware 资源

| 资源 | 路由机制 | 文件:行号 |
|---|---|---|
| vendor `commandQueue` | `agentId` 字段 = sid(本方案核心) | `messageQueueManager.ts:52` |
| vendor `signal` | 后置 filter(emit 不变) | `messageQueueManager.ts:55` |
| vendor `bg-daemon` | clientId + sid(zai patch 改 `daemon/mailbox.ts:99-105`) | — |
| vendor `cronScheduler` lock | 文件级(`cronTasksLock.ts`)+ per-task `inFlight` | `cronScheduler.ts:230-394` |
| `~/.zai/teams/.../inboxes/{agent}.json` | agentName → sid 映射(zai 层) | — |
| Mailbox 内存实例 | zai patch 加 sid 标签 + fallback 改 in-memory signal | `useMailboxBridge.ts:12-23` |

### 6.3 进程级且无法 session 化的资源

| 资源 | 接受共享的设计 | 影响 |
|---|---|---|
| vendor bundle module singleton(`opencc-core.mjs`) | 全进程 1 份,依赖 esbuild 隔离 | 单元测试需注意 module state 共享 |
| `sharedOpenccRuntimeSingleton`(`agentRuntime.ts:696`) | query 入口按 sid 分发,引擎实例本身 per-session | runtime 单例 ≠ engine 单例 |
| `enableOpenccConfigs()` 后的 `process.env` | 启动时一次 `Object.assign` | 启动后 `reapplyRuntimeCoreFlag` 恢复 |

## 7. 关键 vendor 调用方改造清单

### 7.1 实测清单(`enqueuePendingNotification` 22 处)

| 文件 | 行号 | 调用类型 | 改造方式 |
|---|---|---|---|
| `tasks/LocalShellTask/LocalShellTask.tsx` | 112, 192 | 异步回调(stall / bash 完成) | import + 调 zai wrapper |
| `tasks/LocalMainSessionTask.ts` | 263 | 异步回调 | 同上 |
| `tasks/LocalAgentTask/LocalAgentTask.tsx` | 260 | 异步回调(子 agent 完成) | 同上 |
| `tasks/RemoteAgentTask/RemoteAgentTask.tsx` | 203, 259, 362, 380 | 异步回调(4 处) | 同上 |
| `tasks/LocalWorkflowTask/LocalWorkflowTask.ts` | 502 | 异步回调 | 同上 |
| `utils/task/framework.ts` | 289 | 异步回调 | 同上 |
| `hooks/useCancelRequest.ts` | 233 | React hook | 同上(zai 主路径不跑但留 vendor patch) |
| `hooks/useScheduledTasks.ts` | 74 | React hook | 同上 |
| `utils/hooks.ts` | 412 | 异步回调 | 同上 |
| `commands/ultraplan.tsx` | 119, 153, 216, 220, 324, 348, 390 | 异步回调(7 处) | 同上 |
| `utils/processUserInput/processSlashCommand.tsx` | 134 | 箭头函数内嵌 | 同上 |
| `components/permissions/ExitPlanModePermissionRequest/ExitPlanModePermissionRequest.tsx` | 340 | Promise then 内嵌 | 同上 |

### 7.2 vendor patch 注释规范

```typescript
// zai patch (YYYY-MM-DD, plan Px): reason why this file is patched.
// - 替换 vendor enqueuePendingNotification 为 zaiEnqueuePendingNotification
// - 自动注入 agentId = sessionId,让 vendor mid-turn drain filter
//   (query.ts:2672-2673 cmd.agentId === currentAgentId) 自动 session 路由
// - rebase manifest: scripts/rebase-manifest.ts 扫描所有 "zai patch" 注释生成
```

**rebase manifest**(`scripts/rebase-manifest.ts`,新):扫 `packages/zn-agent-core/src/opencc-src/**` 所有 `zai patch` 注释,输出 JSON 清单,rebase vendor upstream 时核对。

## 8. 实施 Phase(基于当前 main 真实状态)

### Phase 1(2 周)— P0 关键路径

| 任务 | 文件 | DoD | 风险 | 回滚 |
|---|---|---|---|---|
| 1.1 `zaiEnqueue` / `zaiEnqueuePendingNotification` wrapper | `packages/zai/src/server/services/messageQueueAdapter.ts`(新,50 行) | 单测 + 多 session 不窜扰 | 无 | 删 wrapper 恢复原 import |
| 1.2 `toolUseContext.agentId = sid` zai patch | `packages/zn-agent-core/src/compat/repl/createReplSession.ts:486-536` | mid-turn drain filter 命中 sid | vendor 主线程测试在 zai 不跑 | 注释掉该行 |
| 1.3 vendor patch 替换 22 个 `enqueuePendingNotification` 调用方 | 14 个 vendor 文件 | rebase manifest 完整 | upstream 同步时冲突 | patch 注释 + rebase manifest |
| 1.4 e2e 多 session 测试 | `__tests__/messageE2E.test.ts`(新) | 2 session 并发无窜扰 | 无 | 测试独立 |

### Phase 2(1.5 周)— P0 通知修复 + P1 inbox

| 任务 | 文件 | DoD | 风险 | 回滚 |
|---|---|---|---|---|
| 2.1 BashNotifier 死代码修复 + 接入 BashBackgroundTracker | `bashNotifier.ts` + `agentRuntime.ts:438` | 后台 bash 完成 LLM 必感知 | turn 风暴(throttle + isMeta 抑制) | 关闭 `__setBashNotifier(null)` |
| 2.2 bg-daemon per-session clientId zai patch | `opencc-src/utils/daemon/mailbox.ts:99-105` | bg agent 完成路由到正确 sid | daemon IPC 复杂度 | 关闭 zai patch 注释 |
| 2.3 `useInboxPoller` sessionId 路由 | `opencc-src/hooks/useInboxPoller.ts:876-950` zai patch + `setupInboxPoller.ts` fallback | busy→idle 切换按 sid 路由 | vendor 注释行号漂移 | 关闭 patch |
| 2.4 8 类 inbox message types 解析 | `inboxMessageHandler.ts`(新) | `permission_request` / `shutdown_request` 等 8 类齐全 | 类型遗漏 | 后续 Phase 补 |

### Phase 3(2 周)— P2 循环对标

| 任务 | 文件 | DoD | 风险 | 回滚 |
|---|---|---|---|---|
| 3.1 镜像 vendor 30+ 通知 hook | 各 zai 模块(spec §6 已列 14 个 setup 模块,补齐剩余) | `notification` ReplEvent 全 | 双份维护 | 关闭 fallback 路径 |
| 3.2 评估切到 inproc 双轨(`createPrintRuntime`) | 调研文档 | ROI 报告(spec §5.8 路径 A) | 协议对齐成本 | 维持 `repl` |
| 3.3 `useMailboxBridge` sessionId 参数 | `opencc-src/hooks/useMailboxBridge.ts:12-23` zai patch + `setupMailboxBridge.ts` fallback 改 in-memory signal | busy 时不 poll,idle 时按 sid | vendor 内部 hook 漂移 | 关闭 patch |
| 3.4 `OpenccRuntimeV2` 契约扩展(可选) | `createOpenccRuntime-impl.ts` + `serverTypes.ts` zai patch | 8 → 15 方法(加 hooks/swarm/background/proactive) | vendor 重构成本 | 不切,留 V1 8 方法 |

### Phase 4(0.5 周)— 验证与文档

| 任务 | 文件 | DoD | 风险 | 回滚 |
|---|---|---|---|---|
| 4.1 端到端 trace 测试(8 个场景 × 多 session) | `__tests__/messageE2E.test.ts` | bash/agent/cron/mailbox/inbox 等场景双 session 互不窜 | 无 | 测试独立 |
| 4.2 更新 `docs/2026-09-06-zai-session-isolation-plan.md` 反映 vendor patch 实施进度 | docs | phase 标记完成 | 无 | doc 独立 |

## 9. 风险与缓解

| 风险 | 后果 | 缓解 |
|---|---|---|
| vendor patch 替换 22 个调用方 → upstream 同步冲突 | rebase 成本 | `zai patch` 注释 + `scripts/rebase-manifest.ts` |
| `toolUseContext.agentId = sid` 影响 vendor 主线程判断 | bundle shared module 可能影响单元测试 | Phase 1.2 测试覆盖,Phase 4 e2e 验证 |
| BashNotifier 启用后高频 bash 完成 → turn 风暴 | LLM API 调用雪崩 | throttle(默认预算) + `isMeta: true` 抑制 UI |
| 8 类 inbox message types 漏解析 | zai web 用户感知不到某些类型 | Phase 2.4 一次性补齐 |
| vendor `commandQueue` 进程级共享,sid 注入失败兜底为 ALS | ALS 未设时丢消息 | `messageQueueAdapter` 抛错 + 测试强制覆盖 |
| 多 session 并发 enqueue,signal emit 顺序 | React useSyncExternalStore 仍可能丢更新 | vendor 已实现无锁但保证 snapshot 反映全部(`messageQueueManager.ts:57-60`) |
| bg-daemon clientId 跨 session 串扰 | bg agent 完成通知路由错 session | Phase 2.2 zai patch `daemon/mailbox.ts:99-105` |
| ReplRuntime vs fallback createReplSession 三层切换条件不清晰 | 单元测试用 fallback,生产用主路径 | agentRuntime.ts:702-705 注释明写 |

**blast radius**:zai 主路径 = vendor `createOpenccRuntime` + ReplRuntime 薄包装;zai fallback = 14 个 setup 模块 + 3 个 state machine。两条路径完全独立,任一路径失败可独立回滚(切 `ZAI_RUNTIME_CORE` env)。

## 10. 跨方案关系

- **与 `docs/2026-09-06-zai-session-isolation-plan.md` 的关系**:**互补**(实施视图)。
- **本方案替代哪些章节**:无。该 plan §1-§4 是策略层,本方案是落地层。两者同读。
- **本方案不覆盖哪些章节**:
  - plan §6.2 备选方案对比(全量 zai 镜像 / 不改 vendor 改契约 / 绕开 vendor queue)— 由 plan 主导
  - plan §6.3 关键决策(为什么复用 agentId 字段)— 由 plan 主导
  - plan §7 zai 已有的 session 隔离能力清单 — 本方案仅在 §6.1 引用
- **本方案新增章节**:
  - §3.1 实测 22 个调用方(plan 写 26,与实测有差异)— **订正 plan §2.1**
  - §4.2-§4.4 三消费者(inbox poller / mailbox bridge / cron)的 session-aware 改造点
  - §7 vendor patch 注释规范 + rebase manifest
  - §8 实施 Phase 拆 4 个阶段,DoD + 风险 + 回滚三列对齐
- **何时更新 plan**:Phase 1 完成后,把 §2.1 的 26 个调用方改成实测 22 个;Phase 4 完成后,把 §3.4 选项评估中"zai 镜像补缺"实际进展填入。
