# zai 全量对标 vendor 消息体系:Session 隔离方案(按三维度)

> **本文档定位**:zai 服务端要全量对标 vendor 消息体系(`docs/2026-09-06-vendor-message-system.md`)时,按 **3 个维度**回答:
> 1. **存储隔离** — 消息存在哪里?谁能看到?
> 2. **生产/消费隔离** — 谁写谁读?如何按 session 路由?
> 3. **TUI / headless 循环机制对标** — vendor 是 TUI + 事件驱动,zai 是 headless + 信号驱动,如何对齐?
>
> **核心原则**:**尽量少改动 vendor 代码**。zai 在 vendor 接口之上做 session 隔离层;**必要时通过 `zai patch (YYYY-MM-DD)` 注释直接修改 vendor**(opencc-web 仓库的标准做法,见 `packages/zn-agent-core/AGENTS.md` — "opencc-src/ 是 opencc 上游拷贝,但**允许修改**——类型修复、zai 补丁")。
>
> **权衡原则**:
> - 优先在不侵入 vendor 的前提下解决(zai 层包装 / zai 镜像)
> - vendor 内核调用栈内 zai 拦不住且需要 session 注入的,通过 `zai patch` 直接改 vendor
> - 不为了"零改动"而牺牲设计清晰度(不必要的 zai 镜像 = 双份维护)
>
> **调研输入**:
> - vendor 消息体系深度解析:`docs/2026-09-06-vendor-message-system.md`(1168 行)
> - vendor 完整 REPL 对比 spec:`docs/superpowers/specs/2026-08-27-zai-headless-runtime-vs-vendor-repl-comparison.md`(1148 行)
> - zai 现状:`sessionInbox.ts` / `subagentNotifier.ts` / `inboxReminder.ts` / `bashNotifier.ts` / `agentRuntime.ts` / `compat/repl/` / `createOpenccRuntime-impl.ts`

---

## 0. 关键洞察(三个维度的核心结论)

| 维度 | vendor 原生 | zai 现状 | zai 必须做什么 |
|---|---|---|---|
| **存储** | 进程级 singleton(`commandQueue`)+ 文件 + IPC | per-session lane(`SessionInbox`)+ 仍依赖 vendor `commandQueue` | **在 `QueuedCommand` 加独立 `sessionId?` 字段**(vendor patch ≤3 处),让 vendor `commandQueue` 通过 `sessionId` 字段自动 session 隔离;**不复用 `agentId`**(实测 30+ 处 vendor 副作用) |
| **生产/消费** | 5 个消费者共享 `commandQueue`,无 session 概念 | 5 个消费者在 zai 侧不全部跑(REPL-only hooks 不适用) | zai 层 `zaiEnqueuePendingNotification` wrapper **入参注入** `sessionId`(实测 22 个调用方,不是 26);vendor **0 文件改动**;不复用 vendor ALS `getSessionId()`(async callback 不可达) |
| **TUI/headless** | TUI + React hooks + Ink | headless + imperative class(主路径委托 vendor,fallback 自己命令式) | 选 `ReplRuntime + createOpenccRuntime` 委托为主路径(已选),缺 22 项 vendor hooks 通过 zai **镜像**补(**不再 patch vendor**) |

**关键事实**:
- vendor 是**单进程单 session CLI**(整个 `messageQueueManager` 设计前提);zai 是多 session 服务,vendor **不**提供 session 隔离
- vendor 已有 `getSessionId()` ALS(`hooks.ts:3609/3704/3763/4083`),zai 可直接复用(不需自建 ALS)
- vendor 已有 `concurrentSessions.ts` 第一类 API(`concurrentSessions.ts:50-78`),zai 可作为 session 注册/查询的统一入口
- `toolUseContext.agentId` 实测在 vendor 内部 **30+ 处**被引用(BashTool/PowerShellTool/attachments/PermissionContext/SDK 输出),灌 sessionId 会产生 30+ 处隐性回归;**必须用独立 `sessionId` 字段**
- zai 在 `packages/zn-agent-core/src/opencc-src/` 内的 vendor 代码**允许修改**,但**优先 zai 层 wrapper**;vendor patch 只在不得不改 ≤3 处(`QueuedCommand` 类型 + mid-turn drain filter + enqueue 签名)
- "尽量少改动" = **能 zai 层做的尽量 zai 层做**;vendor 内核调用栈内**只改 ≤3 处**(类型 + filter + 签名),不镜像 vendor 逻辑

---

## 1. 维度 1:消息的存储隔离

### 1.1 5 个存储位置全景

```
                    ┌──────────────────────────────────────┐
                    │  进程级 vendor 存储                  │
                    │  - commandQueue(模块级 singleton)    │  ← 主要生产点
                    │  - bg-daemon Unix socket(clientId)  │  ← 进程级 clientId
                    │  - ~/.zai/scheduled_tasks.json      │  ← 进程级共享
                    │  - Mailbox 内存实例(signal 订阅)    │  ← 进程级
                    └─────────────┬────────────────────────┘
                                  │
                                  │ zai patch 让 vendor 入队时携带 sessionId
                                  │ (复用 agentId 字段做 session 路由)
                                  ▼
┌──────────────────────────────────────────────────────────────┐
│  zai per-session 存储                                          │
│  - SessionInbox(sessionId → {nextTurn, nextStep})            │  ← 已实现 ✅
│  - engines Map<sessionId, QueryEngine>(createOpenccRunt)     │  ← 已实现 ✅
│  - queryAbortControllers Map<sessionId, AbortController>     │  ← 已实现 ✅
│  - runtimeCore Map<sessionId, QueryGuardState>(fallback)      │  ← 已实现 ✅
└──────────────────────────────────────────────────────────────┘

                    ┌──────────────────────────────────────┐
                    │  per-agent 文件存储                  │
                    │  - ~/.zai/teams/{team}/inboxes/       │
                    │    {agentName}.json                  │  ← agentName 路由
                    │  - zai patch:                        │
                    │    ${cwd}/.zai/inbox/${to}.jsonl     │  ← to 路由
                    └──────────────────────────────────────┘
```

### 1.2 vendor 各存储位置的隔离现状 + zai 干预方式

| 存储位置 | 文件:行号 | 设计假设 | zai 多 session 风险 | zai 干预方式 |
|---|---|---|---|---|
| `commandQueue`(模块级 singleton) | `messageQueueManager.ts:52` | 单进程 = 单 session | **🔴 极高** | **zai patch**:zaiEnqueuePendingNotification 自动注入 `agentId=sessionId`,让 vendor 子 agent filter 自动按 session 路由 |
| `getSessionId()`(ALS) | `bootstrap/state.js` | bootstrap state 隔离 | **🟢 不影响 queue** | 已存在,无需改 |
| bg-daemon `clientId`(进程级 UUID) | `daemon/mailbox.ts:99-105` | 进程级 | **🟡 部分** | **zai patch**:clientId 改成 `clientId + sessionId` 或 per-session clientId(改 `daemon/mailbox.ts:99-105`) |
| bg-daemon `lastInboxAckThrough` | `daemon/inboxSection.ts:39-84` | 进程级游标 | **🟡 部分** | **zai patch**:per-session ackThrough,或 zai 自己用 `__zaiSessionInbox` 接管 bg agent 完成路由,绕开 vendor bg-daemon |
| TeammateMailbox `~/.zai/teams/.../inboxes/{agentName}.json` | `hooks/useInboxPoller.ts` | agentName 路由 | **🟡 部分** | zai 层加 `agentName → sessionId` 映射(zai 服务端配置);不需要改 vendor |
| Mailbox 内存实例 + signal | `hooks/useMailboxBridge.ts` | 进程级 | **🟡 部分** | **zai patch**:`useMailboxBridge.ts` 增加 sessionId 参数;fallback `setupMailboxBridge.ts` 改 in-memory signal 实现(zai 不必依赖文件) |
| cronScheduler lock + chokidar | `utils/cronScheduler.ts:62-128` | 进程级 | **🟢 不需隔离** | 不改 |
| `~/.zai/scheduled_tasks.json` | `utils/cronScheduler.ts` | 进程级 | **🟢 不需隔离** | 不改;cron fire 路由由 cron 配置的 `targetSessionId` 决定 |
| `getSessionCronTasks()` 内存表 | `bootstrap/state.ts` | session-only cron | **🟢 不需隔离** | 不改 |

### 1.3 zai 各存储位置的隔离现状

| 存储位置 | 文件:行号 | 隔离状态 |
|---|---|---|
| `SessionInbox` per-session lanes | `sessionInbox.ts:35-36` + `lanesFor(sessionId)` | ✅ 已隔离 |
| `__zaiSessionInbox` globalThis | `agentRuntime.ts:145-150` | ✅ 暴露 `{followup, inject}`(bridge core→server) |
| `engines` Map<sessionId, QueryEngine> | `createOpenccRuntime-impl.ts:312` | ✅ 已隔离(原 plan 写 577-625 错,偏差 260+ 行) |
| `queryAbortControllers` Map | `createOpenccRuntime-impl.ts:316` | ✅ 已隔离(原 plan 写 561-565 错,偏差 245+ 行) |
| `sharedOpenccRuntimeSingleton` | `agentRuntime.ts:696` | ⚠️ 单例(进程级),但 query 入口按 sessionId 分发 |
| vendor `commandQueue`(zai 进程依赖) | `messageQueueManager.ts:52` | **🔴 当前未隔离**,需 zai patch 让 agentId 注入 sessionId |
| vendor bg-daemon `clientId` | `daemon/mailbox.ts:99-105` | **🔴 当前未隔离**,需 zai patch |

### 1.4 维度 1 隔离方案:**独立 `sessionId?` 字段**(不复用 vendor `agentId`)

#### 核心思想

**zai 把 sessionId 注入独立的 `QueuedCommand.sessionId?` 字段**(vendor patch ≤3 处:类型定义 + mid-turn drain filter + enqueue 签名),**不复用 `agentId`**(实测 `toolUseContext.agentId` 在 vendor 内部 30+ 处被引用,灌 sessionId 会污染 vendor 子 agent 文件系统 + 误判主线程)。

```typescript
// zai 层提供 zaiEnqueue 系列(替代 vendor 直接调用)
export function zaiEnqueuePendingNotification(cmd: QueuedCommand): void {
  const sessionId = cmd.sessionId ?? cmd.agentId ?? __zaiGetCurrentSessionId()  // 入参优先
  if (!sessionId) throw new Error('zaiEnqueuePendingNotification: sessionId required')
  return _vendorEnqueuePendingNotification({ ...cmd, sessionId })  // 注入独立字段
}
```

`__zaiGetCurrentSessionId()` 优先取 zai 入口层注入的 `globalThis.__zaiBridgeCtx.sessionId`(zai 在调 vendor query 前已 set),其次从 vendor `getSessionId()` ALS fallback。**不依赖单一 ALS**(实测 vendor 22 个 enqueue 调用方多数不在 vendor query 调用栈内,ALS 在 async callback 不可达)。

#### vendor 配合:zai patch `textInputTypes.ts:359` + `query.ts:2672-2673` + `messageQueueManager.ts` 签名

**vendor patch ≤3 处**(不替换 22 个调用方文件):

1. **`textInputTypes.ts:359`**:`QueuedCommand` 加可选 `sessionId?: SessionId` 字段(类似 `agentId`)
2. **`query.ts:2672-2673`**:mid-turn drain filter 优先 `sessionId ?? agentId`(兼容 vendor 子 agent)
3. **`messageQueueManager.ts:52` 的 `enqueuePendingNotification` 签名**:接受 `sessionId` 入参,可缺省(向后兼容)

zai 调用 vendor query 时,**在 `createReplSession.ts:486-543` 构造 `toolUseContext` 时加 `sessionId: sessionId` 字段**(独立字段,不污染 `agentId`):

```typescript
// packages/zn-agent-core/src/compat/repl/createReplSession.ts:486-543 (zai patch)
// 在构造 toolUseContext 时追加
const toolUseContext = {
  options: { /* ... */ },
  agentId: subAgentId ?? undefined,  // vendor 子 agent 用,不被 zai 污染
  sessionId: sessionId,  // ← zai patch:独立 sessionId 字段
  abortController: ...,
  readFileState: ...,
  getAppState: () => { ... },
  // ...
}
```

#### 为什么这个方案可行

1. **vendor patch 面从 27+ 处降到 ≤3 处**(类型 + filter + 签名),维护成本可接受
2. **零 vendor 文件被 22 个调用方替换污染**;zai 层的 `zaiEnqueuePendingNotification` wrapper 在调用方处 import 替换即可
3. **vendor mid-turn drain filter `cmd.sessionId === currentAgentId ?? cmd.agentId` 兼容 vendor 子 agent 场景**
4. **`toolUseContext.agentId` 保留 vendor 原生语义**(BashTool `preventCwdChanges` / `attachments` plan 路径 / `PermissionContext` / SDK 输出等 30+ 处不受影响)

#### 备选方案对比(都拒绝)

| 方案 | 拒绝理由 |
|---|---|
| 自己实现 zaiSessionQueue 完全绕开 vendor `commandQueue` | vendor mid-turn drain 仍读 vendor queue;绕不开 |
| **复用** vendor `agentId` 字段做 sessionId(原方案) | 实测 vendor 内部 30+ 处引用 `toolUseContext.agentId`,灌 sessionId 会污染 vendor 子 agent 文件系统 + 误判主线程 |
| 修改 vendor 加 `sessionId` 字段并替换 22 个调用方为 zai wrapper | vendor patch 面 = 1 处类型 + 22 处调用方 + 1 处 filter,过大;**只改 1 处类型即可,调用方通过 wrapper 替换** |

### 1.5 维度 1 实施清单

| # | 任务 | 文件 | 方式 | 优先级 |
|---|---|---|---|---|
| 1.1 | 实现 `zaiEnqueue` / `zaiEnqueuePendingNotification` wrapper(**入参注入 sessionId**) | `packages/zai/src/server/services/messageQueueAdapter.ts`(新) | zai 层 | P0 |
| 1.2 | zai patch 加 `QueuedCommand.sessionId?` 字段 | `packages/zn-agent-core/src/opencc-src/types/textInputTypes.ts:359` | **zai patch vendor** | P0 |
| 1.3 | zai patch mid-turn drain filter 优先 `sessionId ?? agentId` | `packages/zn-agent-core/src/opencc-src/query.ts:2672-2673` | **zai patch vendor** | P0 |
| 1.4 | zai patch `enqueuePendingNotification` 签名接受 `sessionId` | `packages/zn-agent-core/src/opencc-src/utils/messageQueueManager.ts:52` | **zai patch vendor** | P0 |
| 1.5 | bg-daemon 路由:per-session clientId | `packages/zn-agent-core/src/opencc-src/utils/daemon/mailbox.ts:99-105` | **zai patch vendor** | P1 |
| 1.6 | agentName→sessionId 映射(teammate mailbox) | zai 层 | zai 层 | P1 |
| 1.7 | useMailboxBridge 增加 sessionId 参数 | `packages/zn-agent-core/src/opencc-src/hooks/useMailboxBridge.ts:12-23` | **zai patch vendor** | P2 |
| 1.8 | fallback `setupMailboxBridge` 改 in-memory signal | `packages/zn-agent-core/src/compat/repl/setup/setupMailboxBridge.ts` | zai patch | P2 |

---

## 2. 维度 2:消息生产/消费的 session 隔离

### 2.1 生产端 — 实测 22 个 vendor 调用方通过 zai wrapper 入参注入

#### 关键事实(实测修正)

vendor `enqueuePendingNotification(` **实测 22 个调用点**(原 plan 写 26 个,差 4),分散在 14 个 vendor 文件。差异来源:
- `LocalShellTask` 实测 **4 处**(`112, 192, 413, 416`),原 plan 列 5 处(含 `:528` 是 `enqueueShellNotification` wrapper 间接调用,不算直接)
- `RemoteAgentTask` 实测 4 处,数量一致
- 其他文件无差异

**vendor 调用方都不在 vendor query 调用栈内**(React hook setInterval / 异步任务回调 / 权限请求回调),**vendor ALS `getSessionId()` 不可用**。改为 **zai 层 wrapper + 调用方 import 替换** 注入 sessionId(vendor 文件**不修改**)。

```typescript
// 旧(vendor 原始)
enqueuePendingNotification({ value, mode: 'task-notification', priority: 'later' })

// 新(zai 层 wrapper import 替换 — vendor 文件不改)
import { zaiEnqueuePendingNotification } from '@zn-ai/zai/server/services/messageQueueAdapter'
zaiEnqueuePendingNotification({ value, mode: 'task-notification', priority: 'later', sessionId: __zaiGetCurrentSessionId() })
```

**为什么这样是合理的**:
1. opencc-web 仓库 vendor 代码本就允许修改,但**优先 zai 层 wrapper**(vendor patch 只在 ≤3 处)
2. 不需要在 zai 镜像实现 vendor enqueue 的全部场景(避免双份维护)
3. `zaiEnqueuePendingNotification` 是 zai 层提供的 wrapper,**vendor 不需要知道它的存在**

#### 22 个调用方实测清单(实测数量)

| # | 调用方 | 文件:行号 | zai 处理方式 |
|---|---|---|---|
| 1-4 | `LocalShellTask`(bash 后台) | `LocalShellTask.tsx:112, 192, 413, 416` | import 替换 + 调用替换 |
| 5 | `LocalAgentTask`(子 agent) | `LocalAgentTask.tsx:260` | import 替换 + 调用替换 |
| 6-9 | `RemoteAgentTask`(远程 agent) | `RemoteAgentTask.tsx:203, 259, 362, 380` | import 替换 + 调用替换 |
| 10 | `LocalWorkflowTask` | `LocalWorkflowTask.ts:502` | import 替换 + 调用替换 |
| 11 | `LocalMainSessionTask` | `LocalMainSessionTask.ts:263` | import 替换 + 调用替换 |
| 12 | `framework.ts`(framework) | `framework.ts:289` | import 替换 + 调用替换 |
| 13 | `useScheduledTasks`(cron tick) | `useScheduledTasks.ts:74` | import 替换 + 调用替换 |
| 14 | `useCancelRequest`(Ctrl+C) | `useCancelRequest.ts:233` | import 替换 + 调用替换 |
| 15 | `hooks.ts`(hook 失败) | `hooks.ts:412` | import 替换 + 调用替换 |
| 16-22 | `ultraplan.tsx`(各阶段,7 处) | `ultraplan.tsx:119, 153, 216, 220, 324, 348, 390` | import 替换 + 调用替换 |
| (额外) | `processSlashCommand`(结果回填) | `processSlashCommand.tsx:134` | import 替换 + 调用替换 |

**总计实测 22 处**(原 plan 写 26,差 4:`LocalShellTask` 实际 4 处非 5 处;`ExitPlanModePermissionRequest.tsx:340` grep 未找到直接 enqueuePendingNotification 调用,可能是间接调用或 import)。

#### `zaiEnqueuePendingNotification` 完整实现

```typescript
// packages/zai/src/server/services/messageQueueAdapter.ts

import { enqueuePendingNotification as _vendorEnqueuePendingNotification,
         enqueue as _vendorEnqueue,
         type QueuedCommand } from '@zn-ai/zn-agent-core'

export function zaiEnqueue(cmd: QueuedCommand): void {
  const sessionId = cmd.sessionId ?? cmd.agentId ?? __zaiGetCurrentSessionId()
  if (!sessionId) throw new Error('zaiEnqueue: sessionId required')
  return _vendorEnqueue({ ...cmd, sessionId })  // 注入独立 sessionId 字段
}

export function zaiEnqueuePendingNotification(cmd: QueuedCommand): void {
  const sessionId = cmd.sessionId ?? cmd.agentId ?? __zaiGetCurrentSessionId()
  if (!sessionId) throw new Error('zaiEnqueuePendingNotification: sessionId required')
  return _vendorEnqueuePendingNotification({ ...cmd, sessionId })  // 注入独立 sessionId 字段
}

// zai 入口层(agentRuntime.ts:696-715 调 vendor query 前)注入
declare global {
  var __zaiBridgeCtx: { sessionId: string; /* ... */ } | undefined
}
function __zaiGetCurrentSessionId(): string | undefined {
  return globalThis.__zaiBridgeCtx?.sessionId
}
```

**关键**:
- 通过 ALS `getSessionId()` 从 vendor query 调用栈内取当前 sessionId
- 通过 `agentId ?? sessionId` 兼容原本带 `agentId` 的命令(子 agent)
- **不**修改 vendor `enqueuePendingNotification` 签名,只替换调用方

### 2.2 消费端 — 5 个消费者的 session 路由

#### 消费者 1:mid-turn drain(`query.ts:2671`)

```typescript
// vendor mid-turn drain (query.ts:2660-2691) — 不改
const isMainThread =
  querySource.startsWith('repl_main_thread') ||
  querySource === 'server-repl' ||
  querySource === 'sdk'
const currentAgentId = toolUseContext.agentId  // ← zai patch: = sessionId

if (isMainThread) return cmd.agentId === undefined         // zai 不走这条
return cmd.mode === 'task-notification' && cmd.agentId === currentAgentId
```

**zai 路由机制(2026-09-07 修正)**:
- zai patch 让 `toolUseContext.sessionId = sessionId`(`createReplSession.ts:486-543`)**独立字段,不复用 agentId**
- `cmd.sessionId = sessionId`(由 `zaiEnqueuePendingNotification` 自动注入)
- filter `cmd.sessionId === currentAgentId`(zai patch `query.ts:2672-2673` 优先 `sessionId ?? agentId`)= `sessionId === sessionId` ✓

**isMainThread 路径**:zai `querySource: 'server-repl'` 会让 isMainThread=true,但 zai 的所有 cmd 都有 agentId,**不会**进入 `cmd.agentId === undefined` 分支,**全部走子 agent 路径**。

**这正是 zai 想要的** — 没有"主线程"概念,所有 cmd 都按 agentId(= sessionId)路由。

#### 消费者 2:useQueueProcessor(React hook)

**关键事实**:
- **React hook**,zai 服务端不跑 React 组件
- **zai 主路径不跑这个消费者**(委托 vendor query 时 React hook 不触发)
- **zai fallback 路径**用 `compat/repl/setup/setupCommandQueue.ts` 镜像

**session 隔离影响**:
- 主路径:useQueueProcessor **不生效**,被 vendor query 内部 mid-turn drain 替代
- fallback 路径:zai `compat/repl/createReplSession.ts` 每个 session 独立实例(`replRuntime.sessions: Map<sessionId, ReplSession>`),**天然隔离**

**需要的改动**:
- `useQueueProcessor` 本身**不需要改**(React hook 不跑)
- zai fallback 路径已经在 `compat/repl/setup/setupCommandQueue.ts` 镜像,只调 `cmdQueue.enqueue`,不调 enqueuePendingNotification → 不需要 patch

#### 消费者 3:pre-API inbox reminder(`query.ts:708-712`)

```typescript
const bgReminder = await buildInboxSystemReminder()              // vendor bg-daemon
const extraReminder = await runExtraReminderProviders(getSessionId())  // zai 注入
```

**session 隔离现状**:
- `runExtraReminderProviders(getSessionId())` **已经 session 隔离** — `getSessionId()` 从 ALS 取当前 sessionId
- zai 的 `drainInboxReminder(sid)` 从 `SessionInbox.nextStep` 读,per-session lane
- **✅ 已对齐**,不需改

#### 消费者 4:useInboxPoller(React hook,1000ms 轮询)

**关键事实**:
- **React hook**,zai 服务端不跑
- 读 `~/.zai/teams/{team}/inboxes/{agentName}.json` — **基于 agentName 路由**

**session 隔离影响**:
- 主路径:zai 不跑这个 hook(zai 不需要 React)
- fallback 路径:`compat/repl/setup/setupInboxPoller.ts`(2000ms 轮询)镜像

**需要的改动**:
- zai 服务端**不跑 React hook**,改为在 fallback `setupInboxPoller.ts` 实现 session-aware 版本
- **zai patch** `useInboxPoller.ts` 的 React hook 内部 `useEffect (line 876-950)` 处理逻辑,busy → idle 切换时按 sessionId 路由
- 8 类 message types 解析:**zai 层在 inboxMessageHandler 中实现**(不需改 vendor)

#### 消费者 5:useMailboxBridge(React hook,signal 订阅)

**关键事实**:
- **React hook**,zai 服务端不跑
- **进程级内存 mailbox**,无 session 隔离

**需要的改动**:
- **zai patch** `useMailboxBridge.ts`:增加 `sessionId` 参数,mailbox 内容物带 sessionId 标签
- fallback `setupMailboxBridge.ts` 改 in-memory signal 替代 `appendFileSync`

### 2.3 维度 2 实施清单

| # | 任务 | 文件 | 方式 | 优先级 |
|---|---|---|---|---|
| 2.1 | zai 层 wrapper + 22 个 vendor 调用方 import 替换(`enqueuePendingNotification` → `zaiEnqueuePendingNotification`) | 14 个 vendor 文件(import 替换) | zai 层 | P0 |
| 2.2 | 修复 BashNotifier dead code,接入 BashBackgroundTracker | `bashNotifier.ts` + `agentRuntime.ts` | zai 层 | P0 |
| 2.3 | `useInboxPoller` 增加 sessionId 路由(busy→idle 切换) | `useInboxPoller.ts:876-950` | **zai patch vendor** | P1 |
| 2.4 | `useMailboxBridge` 增加 sessionId 参数 | `useMailboxBridge.ts:12-23` | **zai patch vendor** | P2 |
| 2.5 | zai mailbox signal 订阅机制 | `setupMailboxBridge.ts` | zai patch | P2 |
| 2.6 | 8 类 inbox message types 解析 | zai 层 `inboxMessageHandler.ts`(新) | zai 层 | P1 |
| 2.7 | `__zaiBridgeCtx.onYield` 扩展处理 permission_request / elicit | `agentRuntime.ts:178` | zai 层 | P1 |

---

## 3. 维度 3:TUI / headless 循环机制对标

### 3.1 vendor 的"循环"真相(不是 while 循环)

**常见误解**:vendor REPL 有"主循环"。**实际上没有**。

vendor 整个"循环"机制是**事件驱动 + React render** 的混合:

```text
REPL.tsx 组件 mount
  ↓ React render
  ↓ useState / useEffect / useMemo 初始化
  ↓ 30+ hooks 注册(useQueueProcessor / useScheduledTasks / useInboxPoller / ...)
  ↓
  ↓ (等待用户输入)
  ↓
onSubmit(input) ← 用户按 Enter
  ↓ queryGuard.tryStart()
  ↓ onQuery → onQueryImpl
  ↓ for await (const event of query({...}))  ← 唯一真正的循环,但只在 query 期间存在
  ↓ (await 完,turn 结束)
  ↓
  ↓ finally: queryGuard.end(gen)
  ↓ mrOnTurnComplete → zai 镜像成 runNextInQueue
  ↓
  ↓ (等待下一条 prompt,React re-render)
  ↓
  ↓
持续 useInterval / setInterval 监听:
  - cronScheduler: 1s tick
  - useInboxPoller: 1000ms tick
  - useProactive: 30s tick (GrowthBook gated)
```

**关键洞察**:
- REPL **没有显式 while(true) 主循环**,所有"周期性"行为外包给 setInterval
- 唯一的循环在 `for await query(...)` 内(turn 期间,一次性 await 完)
- 跨 turn 串行靠 `mrOnTurnComplete` hook(zai 镜像成 `runNextInQueue`)

### 3.2 三个 headless 实现对比

| 维度 | `createOpenccRuntime`(981 行) | `print.ts`(5771 行) | `createReplSession`(compat/repl,788 行) |
|---|---|---|---|
| **位置** | `opencc-src/server/createOpenccRuntime-impl.ts` | `opencc-src/cli/print.ts` | `packages/zn-agent-core/src/compat/repl/createReplSession.ts` |
| **形态** | 8 方法契约(headless runtime factory) | 完整命令式 CLI(`-p --input-format stream-json`) | imperative class + 14 个 setup 模块 |
| **React 依赖** | ✅ 完全不依赖 | ✅ 完全不依赖 | ✅ 完全不依赖 |
| **30+ 通知 hook** | ❌ 不挂 | ✅ 镜像(命令式重写) | ❌ 不挂(setupNotifications 是空 bus) |
| **useQueueProcessor** | ❌ 不挂 | ✅ 镜像(`processQueueIfReady` in run loop) | ❌ 不挂(setupCommandQueue 镜像) |
| **useInboxPoller** | ❌ 不挂 | ✅ 镜像 | ❌ 不挂(setupInboxPoller 简化版) |
| **useMailboxBridge** | ❌ 不挂 | ✅ 镜像 | ❌ 不挂(setupMailboxBridge 文件 append) |
| **useScheduledTasks** | ❌ 不挂 | ✅ 镜像(注释: "Mirrors REPL's useScheduledTasks hook") | ❌ 不挂(setupCronScheduler 简化) |
| **useProactive** | ❌ 不挂 | ✅ 镜像 | ❌ 不挂(setupProactive 简化) |
| **useSessionBackgrounding** | ❌ 不挂 | ✅ 镜像 | ❌ 不挂(setupSessionBackgrounding) |
| **useSwarmInitialization** | ❌ 不挂 | ✅ 镜像 | ❌ 不挂(setupSwarmInitialization stub) |
| **SessionStart/SessionEnd hooks** | ❌ 不挂 | ✅ 调 | ❌ 不挂 |
| **Resume 完整恢复** | ⚠️ 只灌 messages | ✅ 完整(worktree / cost / plan / attribution) | ⚠️ 部分(缺 contextCollapse/todos/activeGoal) |
| **完整度** | 8/30 (~27%) | 28/30 (~93%) | 14 setup 模块 + 3 stateMachine 镜像部分(约 40-50%) |

### 3.3 zai 当前选择(`ZAI_RUNTIME_CORE=repl` 默认)

```typescript
// agentRuntime.ts:666-715 — 默认 'repl' 初始化路径
const sharedRuntime = await createOpenccRuntimeFactory({...})
const replRuntime = new ReplRuntime(sharedRuntime)
runtime = replRuntime
```

**实际行为**:
1. zai 创建 shared `createOpenccRuntime`(8 方法契约)
2. 包装成 `ReplRuntime`(适配 OpenccRuntimeV2 形态)
3. `runtime.query(input)` 调用时:
   - 主路径:`for await (const ev of this.openccRuntime.query(input))`(**委托 vendor createOpenccRuntime**)
   - fallback 路径:仅 `openccRuntime` 未注入时(单元测试),走 `createReplSession` stub

**评估**:
- ✅ 利用 vendor `createOpenccRuntime` 的 8 方法契约
- ✅ 自动继承 vendor 真实 `query()` async generator → mid-turn drain / commandQueue / useQueueProcessor 等 vendor 内置机制**全部生效**
- ❌ 但 `createOpenccRuntime` 不挂 vendor 30+ React hooks
- ⚠️ 没有自己的"循环"(靠 vendor query async generator 自然驱动)

### 3.4 三个 headless 选项的抉择

| 选项 | 做法 | 完整性 | 代价 |
|---|---|---|---|
| **当前**:`repl`(默认) | `createOpenccRuntime` + `ReplRuntime` 委托 vendor | 8/30 | 缺 22 项 vendor hooks(可在 vendor 加 zai patch,或 zai 镜像补) |
| **A:换 `print.ts` 双轨** | `ZAI_OPENCC_CLI=1` spawn `opencc -p` 子进程 | 28/30 | 需 zai HTTP/SSE ↔ SDK stream-json + control_request 协议对齐 |
| **B:扩展 createOpenccRuntime 契约** | 8 → 15-20 方法,暴露 hooks/swarm/background/proactive | 取决于扩展 | zai patch vendor 创建 `OpenccRuntimeV2`(增方法) |
| **C:维持现状 + zai 镜像补缺** | zai 自己实现缺失的 hooks/通知 | 取决于 zai 实现深度 | 双份维护 |

**zai 当前选择**:**C(部分)+ 评估中是否切到 A**。

### 3.5 vendor 的"循环" vs zai headless 的"循环"

| 维度 | vendor TUI (REPL.tsx) | zai headless (ReplRuntime + createOpenccRuntime) |
|---|---|---|
| **主驱动** | React render + 用户输入事件 | HTTP POST `/api/agent/prompt` 事件 |
| **单 turn 驱动** | `for await (const event of query({...}))` in `onQuery` | `for await (const ev of this.openccRuntime.query(input))` in `ReplRuntime.query` |
| **跨 turn 串行** | `mrOnTurnComplete` hook(zai 镜像成 `runNextInQueue`) | zai routes/agent.ts:801 `runNextInQueue(sessionId)` finally |
| **持久监听(setInterval)** | REPL.tsx 30+ React hooks(setInterval / useInterval) | zai 几乎不用 — 主路径不跑 React |
| **Abort** | `onCancel` + `abortController.abort('user-cancel')` | `ReplRuntime.abort(sessionId)` → `session.interrupt()` |
| **持久事件源** | useInboxPoller / useScheduledTasks / useMailboxBridge | zai 自己实现:`backgroundRuntime.ts` onTaskStateChange、`sessionInbox.ts` lanes |

### 3.6 维度 3 实施清单

| # | 任务 | 文件 | 方式 | 优先级 |
|---|---|---|---|---|
| 3.1 | 镜像 vendor 30+ 通知 hook(从 setupNotifications emit 调用方入手) | 各 zai 模块 | zai 层 | P1 |
| 3.2 | 镜像 useQueueProcessor(zai fallback 已镜像,主路径不需要) | — | — | — |
| 3.3 | 镜像 useInboxPoller 8 类解析 | `inboxMessageHandler.ts`(新) | zai 层 | P1 |
| 3.4 | 镜像 useScheduledTasks / useProactive(zai fallback 已镜像,主路径可选) | — | P2 | — |
| 3.5 | 评估切到 `print.ts` 双轨(spec §5.8 路径 A)| 调研文档 | zai 层 | P2 |
| 3.6 | permission request 弹窗 SSE 推流(对应 vendor useTerminalNotification) | `__zaiBridgeCtx.onYield` | zai 层 | P1 |
| 3.7 | `OpenccRuntimeV2` 扩展(选项 B,新增 hooks/swarm/background/proactive 方法) | `createOpenccRuntime-impl.ts` + `serverTypes.ts` | **zai patch vendor** | P2 |

---

## 4. 综合实施步骤(按三维度)

> **重大修正(2026-09-07 调研后)**:Phase 4.3 print.ts ROI 评估**前置到 Phase 0**(架构决策点);Phase 1 实际需 1.5-2 周(原 1 周低估);每个 Phase 增加 **DoD(definition of done)** 列。

### Phase 0:架构决策前置(0.5 周)— 必做

| # | 任务 | 文件 | DoD(完成标准) |
|---|---|---|---|
| 0.1 | `print.ts` 双轨切换 ROI 评估 | `docs/superpowers/specs/2026-08-27-zai-headless-runtime-vs-vendor-repl-comparison.md` §5.8 | 决策文档 + 决策人签字(opencc / dsh / 双轨 三选一) |
| 0.2 | 27+ 处 `toolUseContext.agentId` vendor 副作用清单固化 | vendor grep 输出 | 文档列出所有 30+ 处副作用 + zai patch 缓解方案 |
| 0.3 | 22 个 vendor enqueue 调用方实测清单固化 | grep + 人工核对 | 文档列出 22 处精确文件:行号(原 plan 26 错) |

**Phase 0 不可跳过** — 否则 Phase 1 选错方向会浪费 2 周。

### Phase 1:基础设施(维度 1 + 维度 2 基础)— 1.5-2 周

| # | 任务 | 文件 | 方式 | 优先级 | DoD |
|---|---|---|---|---|---|
| 1.1 | 实现 `zaiEnqueue` / `zaiEnqueuePendingNotification` wrapper(**入参注入 sessionId**) | `packages/zai/src/server/services/messageQueueAdapter.ts`(新) | zai 层 | P0 | wrapper + 单元测试覆盖 22 个调用方签名 |
| 1.2 | zai patch 加 `QueuedCommand.sessionId?` 字段 | `packages/zn-agent-core/src/opencc-src/types/textInputTypes.ts:359` | **zai patch vendor** | P0 | 类型扩展通过 tsc 编译 |
| 1.3 | zai patch mid-turn drain filter 优先 `sessionId ?? agentId` | `packages/zn-agent-core/src/opencc-src/query.ts:2672-2673` | **zai patch vendor** | P0 | filter 逻辑兼容 vendor 子 agent |
| 1.4 | zai patch `enqueuePendingNotification` 签名接受 `sessionId` | `packages/zn-agent-core/src/opencc-src/utils/messageQueueManager.ts:52` | **zai patch vendor** | P0 | 签名向后兼容(`sessionId` 可缺省) |
| 1.5 | zai 调用 vendor query 时注入 `toolUseContext.sessionId` 字段 | `packages/zn-agent-core/src/compat/repl/createReplSession.ts:486-543` | zai 层 | P0 | `toolUseContext.sessionId` 字段存在 |
| 1.6 | 接入 BashNotifier(从未初始化 → runtime 初始化) | `bashNotifier.ts` + `agentRuntime.ts` | zai 层 | P0 | `initBashNotifier()` 在 runtime 启动时调用 |
| 1.7 | 写 e2e 测试验证 mid-turn drain session 路由(2 session 并发互不窜) | `__tests__/messageE2E.test.ts` | zai 层 | P0 | 2 session 并发跑 + assertion:sessionB 通知不进 sessionA |

### Phase 2:补缺(维度 1 + 维度 2 细节)— 1.5 周

| # | 任务 | 文件 | 方式 | 优先级 | DoD |
|---|---|---|---|---|---|
| 2.1 | zai patch bg-daemon per-session clientId | `packages/zn-agent-core/src/opencc-src/utils/daemon/mailbox.ts:99-105` | **zai patch vendor** | P1 | daemon 路由按 session 拆分 |
| 2.2 | `useInboxPoller` sessionId 路由(busy→idle 切换) | `useInboxPoller.ts:876-950` | **zai patch vendor** | P1 | busy→idle 切换时按 sessionId 路由 |
| 2.3 | `useMailboxBridge` sessionId 参数 | `useMailboxBridge.ts:12-23` | **zai patch vendor** | P2 | vendor TUI 调用方传 sessionId 不破编译 |
| 2.4 | 实现 8 类 inbox message types 解析 | `inboxMessageHandler.ts`(新) | zai 层 | P1 | 8 类消息类型全部解析(参考 `vendor-message-system.md` §11) |
| 2.5 | 扩展 `__zaiBridgeCtx.onYield` 处理 permission_request / elicit | `agentRuntime.ts:178` | zai 层 | P1 | permission_request 弹窗走 SSE |
| 2.6 | zai mailbox signal 订阅机制(fallback) | `compat/repl/setup/setupMailboxBridge.ts` | zai patch | P2 | in-memory signal 替代文件 appendFileSync |

### Phase 3:TUI/headless 循环对标(维度 3)— 2 周

| # | 任务 | 文件 | 方式 | 优先级 | DoD |
|---|---|---|---|---|---|
| 3.1 | 镜像 vendor 30+ 通知 hook(从 setupNotifications emit 调用方入手) | 各 zai 模块 | zai 层 | P1 | rate limit / plugin auto-update 通知 zai web 可感知 |
| 3.2 | 镜像 useInboxPoller 8 类解析 | `inboxMessageHandler.ts` | zai 层 | P1 | 8 类 inbox message 全解析 |
| 3.3 | 镜像 useScheduledTasks / useProactive(zai fallback 已镜像,主路径可选) | — | — | P2 | cron / proactive 在 fallback 路径完整 |
| 3.4 | permission request 弹窗 SSE 推流(对应 vendor useTerminalNotification) | `__zaiBridgeCtx.onYield` | zai 层 | P1 | permission_request SSE 不阻塞 turn |
| 3.5 | `OpenccRuntimeV2` 扩展(选项 B,新增 hooks/swarm/background/proactive 方法) | `createOpenccRuntime-impl.ts` + `serverTypes.ts` | **zai patch vendor** | P2 | 新增方法不破 vendor 单元测试 |

### Phase 4:验证与文档(0.5 周)

| # | 任务 | 文件 | DoD |
|---|---|---|---|
| 4.1 | 端到端 trace 测试(8 个场景 × 多 session) | `messageE2E.test.ts` | 8 场景全部跑通(参考 `vendor-message-system.md` §11):bash 后台完成 / 子 agent 完成 / turn idle 时 bash 完成 / turn idle 时子 agent 完成 / teammate 发消息到 idle / teammate 发消息到 busy / cron 触发 / bg agent completion |
| 4.2 | vendor 单元测试回归 | vendor 自带 jest/vitest | zai patch 替换 vendor 调用方后 vendor 单元测试 100% 通过 |
| 4.3 | 更新 `docs/2026-09-06-opencc-web-repl-unified-view.md` 反映新镜像 | docs | 文档与代码一致 |

---

## 5. 关键不变量

### 5.1 存储维度

| 不变量 | 文件:行号 | 含义 |
|---|---|---|
| `commandQueue` 是模块级 singleton | `messageQueueManager.ts:52` | 同进程所有 session 共享,但靠 `agentId` 字段 session 路由 |
| `SessionInbox` per-session lanes | `sessionInbox.ts:35-36` | `Map<sessionId, {nextTurn, nextStep}>` |
| `engines` Map<sessionId, QueryEngine> | `createOpenccRuntime-impl.ts:312` | 每个 session 独立 vendor engine(原 plan 行号 577-625 错) |
| vendor bg-daemon `clientId` 进程级 | `daemon/mailbox.ts:99-105` | zai patch 后 per-session |
| TeammateMailbox 基于 agentName 路由 | `useInboxPoller.ts` | zai 层加 agentName → sessionId 映射 |

### 5.2 生产/消费维度

| 不变量 | 文件:行号 | 含义 |
|---|---|---|
| mid-turn drain 主线程 filter | `query.ts:2667-2669` | `cmd.agentId === undefined`(zai 不走) |
| mid-turn drain 子 agent filter | `query.ts:2672-2673` | `cmd.agentId === currentAgentId`(zai 复用为 sessionId) |
| sleepRan 降级到 `'later'` | `query.ts:2660, 2671` | Sleep 工具触发时拉所有优先级 |
| `runExtraReminderProviders(getSessionId())` | `query.ts:709` | 已 session 隔离(ALS) |
| useQueueProcessor 触发条件 | `useQueueProcessor.ts:48-60` | React hook,zai 主路径不跑 |
| useInboxPoller 1000ms tick | `useInboxPoller.ts:107` | React hook,zai 主路径不跑;fallback 用 setupInboxPoller 2000ms |
| `zaiEnqueue` 自动注入独立 `sessionId?` 字段(2026-09-07 修正) | zai 层包装 | wrapper 入参注入,vendor 0 文件改动 |
| `toolUseContext.sessionId = sessionId`(2026-09-07 修正,独立字段) | `createReplSession.ts:486-543` zai patch | zai 调用 vendor query 时设,**不复用 `agentId`** |

### 5.3 TUI/headless 维度

| 不变量 | 文件:行号 | 含义 |
|---|---|---|
| `ZAI_RUNTIME_CORE=repl`(默认) | `agentRuntime.ts:91` | ReplRuntime + createOpenccRuntime |
| vendor REPL.tsx 30+ React hooks | `screens/REPL.tsx:810-866` | zai 不跑 React |
| `ReplRuntime.query` 三分支 | `agentRuntime.repl.ts:106-235` | slash / 委托 openccRuntime / fallback createReplSession |
| vendor `for await (event of query({...}))` 是唯一真循环 | `REPL.tsx:3047-3057` | turn 内一次性 await,跨 turn 靠 mrOnTurnComplete |
| cronScheduler 1s tick | `cronScheduler.ts:40` | `CHECK_INTERVAL_MS = 1000` |
| `print.ts` 5771 行是 vendor 最完整 headless | `cli/print.ts` | spec §5.8 路径 A 推荐 |

---

## 6. 风险与权衡

### 6.1 风险

| 风险 | 后果 | 缓解 | 触发条件 |
|---|---|---|---|
| **并发竞态**:vendor `commandQueue` 模块级 singleton,多 session 并发 `enqueue` 无锁 | session A 的通知被 session B 的 drain 意外消费(注入失败时) | Phase 1.7 e2e 测试强制覆盖并发场景;`notifySubscribers()` 同步遍历 listener 容忍范围 | 2+ session 同时活跃 + 高频 bash 完成 |
| **回滚策略缺失**:vendor 任何 patch 出 bug 后无隔离回滚 | 全量 revert 阻塞其他 patch | 每处 zai patch 独立 commit,支持 `git revert &lt;commit&gt;` 单点回滚;Phase 4.2 vendor 单测回归门禁 | 任何 zai patch 引入 vendor 测试失败 |
| **blast radius 扩大**:zai patch 替换 vendor 调用方 → `dist/opencc-core.mjs` bundle 改动 | 所有引用 vendor 的 zai 调用方受影响 | Phase 1.7 e2e 全覆盖 + Phase 4.2 vendor 单测 100% 通过 | bundle 重建后 |
| **vendor 上游 rebase 冲突**:vendor `query.ts` / `messageQueueManager.ts` 大改时 zai patch 被打掉 | session 隔离失效 | patch 注释机器可解析(`scripts/vendor-patch-extract.ts` 生成 manifest);rebase 时 `git grep` 定位 | vendor 上游 PR 合并 |
| **sessionId 语义污染**:zai 灌 `agentId` 字段会污染 vendor 子 agent 命名空间 | vendor 子 agent 文件路径、plan、todo 命名错乱 | **本方案已规避**:**用独立 `sessionId?` 字段,不复用 `agentId`** | (已规避) |
| **`toolUseContext.agentId` vendor 副作用 30+ 处**:BashTool `preventCwdChanges`、attachments plan 路径、PermissionContext、SDK 输出 | vendor 子 agent 行为改变 | **本方案已规避**:`toolUseContext.sessionId` 独立字段,`agentId` 保留 vendor 原生 | (已规避) |
| BashNotifier dead code 接入后高频 bash 完成可能 turn 风暴 | 模型频繁被打断 | Phase 1.6 throttle + `isMeta: true` 抑制 | 同时跑 5+ 个 long-running bash |
| 8 类 inbox message types 漏解析 | zai web 用户感知不到某些类型 | Phase 2.4 一次性补齐 | inbox poller 拉到新类型时 |
| mid-turn drain 主线程 filter `cmd.agentId === undefined` 被灌 sessionId 后绕过 | **已规避**:本方案用独立 `sessionId?` 字段,vendor 主线程 filter 行为不变 | — | (已规避) |
| vendor 单元测试兼容:zai patch 后 vendor 自带单测是否过 | 阻塞 zai CI merge | Phase 4.2 vendor 单测 100% 通过门禁 | zai CI 跑 vendor 单测时 |

### 6.2 取舍:为何不全部 zai 镜像而要 zai patch vendor?

| 选项 | 优点 | 缺点 | 当前评估 |
|---|---|---|---|
| **zai patch vendor(本方案)** | 改动最小;不镜像 vendor 逻辑;与上游同步友好 | zai patch 与 upstream 同步需 rebase | **首选** |
| zai 镜像 vendor 全部 enqueue 行为 | 不碰 vendor 代码 | 双份维护;任何 vendor 修改要镜像一份 | 不推荐 |
| 不改 vendor,改 `OpenccRuntime` 契约(zai 自己实现) | 不碰 vendor 内部 | zai 镜像 22 项 hooks 代价大 | 不推荐 |
| 不改 vendor,完全绕开 vendor `commandQueue` | 不碰 vendor | vendor mid-turn drain 仍读 vendor queue;绕不开 | 不可行 |

### 6.3 关键决策

| 决策 | 理由 |
|---|---|
| **zai 层 wrapper 替换 vendor 调用方**(实测 22 个,不是 26) | vendor patch 面从 27+ 处降到 ≤3 处(类型 + filter + 签名);维护成本可接受 |
| **独立 `QueuedCommand.sessionId?` 字段**(不复用 `agentId`) | 实测 `toolUseContext.agentId` 在 vendor 内部 30+ 处被引用,灌 sessionId 会污染 vendor 子 agent 文件系统 + 误判主线程 |
| **`toolUseContext.sessionId` 独立字段**(`createReplSession.ts:486-543` 注入) | 配合独立 sessionId 字段,vendor mid-turn drain filter 优先 `sessionId ?? agentId`,兼容 vendor 子 agent 场景 |
| **zai 主路径选 `createOpenccRuntime` 而非 `print.ts`** | 复杂度低(spawn 子进程的 IPC 协议对齐成本高);print.ts ROI 评估移到 Phase 0 |
| **BashNotifier 必须接入 runtime**(`initBashNotifier()` 从未调用) | 这是 vendor 通知进入 zai 的唯一直接通道;dead code 需先 runtime 初始化 |
| **fallback `setupMailboxBridge` 改 in-memory signal** | `appendFileSync` 不是真正的 mailbox,只是日志 |
| **Phase 0 决策前置**(print.ts ROI + 副作用清单 + 调用方清单固化) | 避免 Phase 1 选错方向浪费 2 周 |
| **每个 Phase 必须有 DoD 列** | 防止 1 周 P0 任务超时无人察觉 |

---

## 7. zai 已有的 session 隔离能力(不需重建)

| 已有能力 | 文件:行号(实测) | 状态 |
|---|---|---|
| `SessionInbox` 双车道 | `sessionInbox.ts:35-108` | ✅ 完整 |
| `__zaiSessionInbox` globalThis | `agentRuntime.ts:145-150` | ✅ 已注入 |
| `__zaiBridgeCtx` globalThis | `agentRuntime.ts:178` | ✅ 已注入(部分) |
| `registerExtraReminderProvider` | `agentRuntime.ts:164` | ✅ 已注册 |
| `drainInboxReminder` busy 路径 | `inboxReminder.ts` | ✅ 已实现 |
| `SubagentNotifier` bg agent 路由 | `subagentNotifier.ts:43-150` | ✅ 已实现 |
| per-session `QueryEngine` 实例 | `createOpenccRuntime-impl.ts:312` | ✅ 已有(原 plan 写 577-625 错,偏差 260+ 行) |
| per-session AbortController | `createOpenccRuntime-impl.ts:316` | ✅ 已有(原 plan 写 561-565 错,偏差 245+ 行) |
| per-session 状态机(QueryGuardState) | `compat/repl/setup/setupQueryGuard.ts:62-76` | ✅ 已有(fallback) |
| `eventBus` 进程级单例(`subscribeScoped` 按 sid 过滤) | `eventBus.ts` | ⚠️ **bus 本身进程级,非 per-session 实例**;原 plan 描述"per-session eventBus"错 |
| BashNotifier 通知注入 | `bashNotifier.ts` | ⚠️ **dead code,从未 `initBashNotifier()` 调用**,Phase 1.6 必须先接入 runtime |
| vendor `getSessionId()` ALS | `hooks.ts:3609/3704/3763/4083` | ✅ vendor 已有,zai 可直接复用 |
| vendor `concurrentSessions` | `concurrentSessions.ts:50-78` | ✅ vendor 第一类 API,可作为 zai session 注册/查询入口 |

---

## 8. 文档元信息

- **路径**:`docs/2026-09-06-zai-session-isolation-plan.md`
- **编写日期**:2026-09-06
- **最后修正**:2026-09-07(基于 8 份方案综合调研,核心机制从"复用 agentId"改为"独立 sessionId 字段")
- **调研输入**:`docs/2026-09-06-vendor-message-system.md`(1168 行)+ `docs/superpowers/specs/2026-08-27-zai-headless-runtime-vs-vendor-repl-comparison.md`(1148 行)+ zai 现状代码 + 8 份独立 agent 方案(A/B/C + 本地 Explore + CliAgent dsh v2/v3 + CliAgent opencc 精简版)
- **核心原则**(2026-09-07 修正后):**尽量少改动 vendor 代码**(≤3 处 patch,不是 27+ 处);zai 层 wrapper 替代 vendor 调用方替换;**不复用 vendor `agentId` 字段**,改用独立 `sessionId?` 字段(规避 30+ 处 vendor 副作用)
- **三维度核心**(2026-09-07 修正后):
  1. **存储隔离**:`sessionId?` 字段路由 vendor `commandQueue` + `SessionInbox` 镜像 zai per-session lane;vendor patch ≤3 处
  2. **生产/消费隔离**:zai 层 `zaiEnqueuePendingNotification` wrapper + 调用方 import 替换(实测 22 个,不是 26);`toolUseContext.sessionId` 独立字段
  3. **TUI/headless 对标**:`ReplRuntime + createOpenccRuntime`(主路径)+ `print.ts`(Phase 0 决策)+ `createReplSession`(fallback),缺 22 项 vendor hooks 通过 zai **镜像**补(**不再 patch vendor**)
- **下一步**:Phase 0 决策前置(print.ts ROI + 副作用清单固化 + 调用方实测清单),Phase 1(P0:wrapper + 独立 sessionId 字段 + 3 处 vendor patch + BashNotifier 接入 runtime),目标 **3-4 周内完成关键路径**(原 2-3 周低估)