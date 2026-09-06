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
| **存储** | 进程级 singleton(`commandQueue`)+ 文件 + IPC | per-session lane(`SessionInbox`)+ 仍依赖 vendor `commandQueue` | 复用 vendor `agentId` 字段做 sessionId 路由,让 vendor `commandQueue` 自动 session 隔离 |
| **生产/消费** | 5 个消费者共享 `commandQueue`,无 session 概念 | 5 个消费者在 zai 侧不全部跑(REPL-only hooks 不适用) | **zai patch 替换 vendor 26 个 enqueue 调用方为 `zaiEnqueuePendingNotification`** + `toolUseContext.agentId = sessionId` 注入 |
| **TUI/headless** | TUI + React hooks + Ink | headless + imperative class(主路径委托 vendor,fallback 自己命令式) | 选 `ReplRuntime + createOpenccRuntime` 委托为主路径(已选),缺 22 项 vendor hooks 通过 zai patch 或 zai 镜像补 |

**关键事实**:
- vendor 是**单进程单 session CLI**(整个 `messageQueueManager` 设计前提);zai 是多 session 服务,vendor **不**提供 session 隔离
- zai 在 `packages/zn-agent-core/src/opencc-src/` 内的 vendor 代码**允许修改**(opencc-web 仓库标准做法,打 `zai patch` 注释)
- "尽量少改动" = **能 zai 层做的尽量 zai 层做**;**vendor 内核调用栈内必须改的,直接 zai patch**(不要为了"零改动"而镜像大量 vendor 逻辑)

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
| `engines` Map<sessionId, QueryEngine> | `createOpenccRuntime-impl.ts:577-625` | ✅ 已隔离 |
| `queryAbortControllers` Map | `createOpenccRuntime-impl.ts:561-565` | ✅ 已隔离 |
| `sharedOpenccRuntimeSingleton` | `agentRuntime.ts:696` | ⚠️ 单例(进程级),但 query 入口按 sessionId 分发 |
| vendor `commandQueue`(zai 进程依赖) | `messageQueueManager.ts:52` | **🔴 当前未隔离**,需 zai patch 让 agentId 注入 sessionId |
| vendor bg-daemon `clientId` | `daemon/mailbox.ts:99-105` | **🔴 当前未隔离**,需 zai patch |

### 1.4 维度 1 隔离方案:复用 vendor `agentId` 字段做 sessionId

#### 核心思想

**zai 把 sessionId 注入 `QueuedCommand.agentId` 字段**,让 vendor 已有的子 agent filter `cmd.agentId === currentAgentId` 自动变成 session 路由。

```typescript
// zai 层提供 zaiEnqueue 系列(替代 vendor 直接调用)
export function zaiEnqueuePendingNotification(cmd: QueuedCommand): void {
  const sessionId = cmd.agentId ?? getSessionId()  // ALS 取当前 sessionId
  if (!sessionId) throw new Error('zaiEnqueue: sessionId required')
  return _vendorEnqueuePendingNotification({ ...cmd, agentId: sessionId })
}
```

#### vendor 配合:zai patch `toolUseContext.agentId = sessionId`

zai 调用 vendor query 时,**在 toolUseContext 里设 `agentId: sessionId`**,这样 mid-turn drain 的 `currentAgentId === sessionId`,filter `cmd.agentId === currentAgentId` 自动 session 路由。

```typescript
// packages/zn-agent-core/src/compat/repl/createReplSession.ts:486-536 (zai patch)
// 在构造 toolUseContext 时追加
const toolUseContext = {
  options: { /* ... */ },
  agentId: sessionId,  // ← zai patch:让 vendor mid-turn drain 的 currentAgentId = sessionId
  abortController: ...,
  readFileState: ...,
  getAppState: () => { ... },
  // ...
}
```

#### 为什么这个方案可行

1. vendor 子 agent 设计本来就支持 multi-instance isolation(`cmd.agentId === currentAgentId`),zai 把 session 当"子 agent"看待即可
2. **改动最小**:zai 层加 wrapper + 在 `createReplSession.ts` 加一行 `agentId: sessionId`
3. vendor mid-turn drain 是 imperative 代码,**zai 主路径委托 vendor query 时也跑这条 drain**

#### 备选方案对比(都拒绝)

| 方案 | 拒绝理由 |
|---|---|
| 自己实现 zaiSessionQueue 完全绕开 vendor `commandQueue` | vendor mid-turn drain 仍读 vendor queue;绕不开 |
| 修改 vendor 加 `sessionId` 字段 | 改 `QueuedCommand` types = 改 vendor;虽然允许,但**不必要**(复用 `agentId` 已足够) |
| **不**让 zai 复用 vendor `agentId`,自己镜像 vendor enqueue 全部 26 个调用方 | 镜像代价大、双份维护;实际 zai patch 改 vendor 调用方为 `zaiEnqueuePendingNotification` 即可 |

### 1.5 维度 1 实施清单

| # | 任务 | 文件 | 方式 | 优先级 |
|---|---|---|---|---|
| 1.1 | 实现 `zaiEnqueue` / `zaiEnqueuePendingNotification` wrapper | `packages/zai/src/server/services/messageQueueAdapter.ts`(新) | zai 层 | P0 |
| 1.2 | zai patch `toolUseContext.agentId = sessionId` | `packages/zn-agent-core/src/compat/repl/createReplSession.ts:486-536` | **zai patch vendor** | P0 |
| 1.3 | bg-daemon 路由:per-session clientId | `packages/zn-agent-core/src/opencc-src/utils/daemon/mailbox.ts:99-105` | **zai patch vendor** | P1 |
| 1.4 | agentName→sessionId 映射(teammate mailbox) | zai 层 | zai 层 | P1 |
| 1.5 | useMailboxBridge 增加 sessionId 参数 | `packages/zn-agent-core/src/opencc-src/hooks/useMailboxBridge.ts:12-23` | **zai patch vendor** | P2 |
| 1.6 | fallback `setupMailboxBridge` 改 in-memory signal | `packages/zn-agent-core/src/compat/repl/setup/setupMailboxBridge.ts` | zai patch | P2 |

---

## 2. 维度 2:消息生产/消费的 session 隔离

### 2.1 生产端 — 26 个调用方 zai patch 替换为 zaiEnqueue

#### 关键事实

vendor 26 个 `enqueuePendingNotification` 调用方都在 vendor 内核(`opencc-src/`)。zai 在这个仓库有维护权,可以**直接 zai patch 改 vendor 调用方**,把:

```typescript
// 旧(vendor 原始)
enqueuePendingNotification({ value, mode: 'task-notification', priority: 'later' })
```

替换为:

```typescript
// 新(zai patch)
// zai patch (YYYY-MM-DD, plan Px): zaiEnqueuePendingNotification 自动注入 sessionId
zaiEnqueuePendingNotification({ value, mode: 'task-notification', priority: 'later' })
```

**为什么这样是合理的**:
1. opencc-web 仓库 vendor 代码本就允许修改(标准 zai patch 做法)
2. 不需要在 zai 镜像实现 vendor enqueue 的全部场景(避免双份维护)
3. `zaiEnqueuePendingNotification` 是 zai 层提供的 wrapper,**vendor 不需要知道它的存在**

#### 26 个调用方的 zai patch 策略

| # | 调用方 | 文件:行号 | zai patch 方式 |
|---|---|---|---|
| 1-5 | `LocalShellTask`(bash 后台) | `LocalShellTask.tsx:112, 192, 413, 416, 528` | import + 调用替换 |
| 6 | `LocalAgentTask`(子 agent) | `LocalAgentTask.tsx:260` | import + 调用替换 |
| 7-10 | `RemoteAgentTask`(远程 agent) | `RemoteAgentTask.tsx:203, 259, 362, 380` | import + 调用替换 |
| 11 | `LocalWorkflowTask` | `LocalWorkflowTask.ts:502` | import + 调用替换 |
| 12 | `LocalMainSessionTask` | `LocalMainSessionTask.ts:263` | import + 调用替换 |
| 13 | `framework.ts`(framework) | `framework.ts:289` | import + 调用替换 |
| 14 | `useScheduledTasks`(cron tick) | `useScheduledTasks.ts:74` | import + 调用替换 |
| 15 | `useCancelRequest`(Ctrl+C) | `useCancelRequest.ts:233` | import + 调用替换 |
| 16 | `hooks.ts`(hook 失败) | `hooks.ts:412` | import + 调用替换 |
| 17-23 | `ultraplan.tsx`(各阶段,7 处) | `ultraplan.tsx:119-390` | import + 调用替换 |
| 24 | `processSlashCommand`(结果回填) | `processSlashCommand.tsx:134` | import + 调用替换 |
| 25 | `ExitPlanModePermissionRequest` | `ExitPlanModePermissionRequest.tsx:340` | import + 调用替换 |

#### `zaiEnqueuePendingNotification` 完整实现

```typescript
// packages/zai/src/server/services/messageQueueAdapter.ts

import { enqueuePendingNotification as _vendorEnqueuePendingNotification,
         enqueue as _vendorEnqueue,
         getSessionId,
         type QueuedCommand } from '@zn-ai/zn-agent-core'

export function zaiEnqueue(cmd: QueuedCommand): void {
  const sessionId = cmd.agentId ?? getSessionId()
  if (!sessionId) throw new Error('zaiEnqueue: agentId or sessionId required')
  return _vendorEnqueue({ ...cmd, agentId: sessionId })
}

export function zaiEnqueuePendingNotification(cmd: QueuedCommand): void {
  const sessionId = cmd.agentId ?? getSessionId()
  if (!sessionId) throw new Error('zaiEnqueuePendingNotification: agentId or sessionId required')
  return _vendorEnqueuePendingNotification({ ...cmd, agentId: sessionId })
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

**zai 路由机制**:
- zai patch 让 `toolUseContext.agentId = sessionId`(`createReplSession.ts:486-536`)
- `cmd.agentId = sessionId`(由 `zaiEnqueuePendingNotification` 自动注入)
- filter `cmd.agentId === currentAgentId` = `sessionId === sessionId` ✓

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
| 2.1 | zai patch 替换 vendor 26 个 `enqueuePendingNotification` 调用方 | 26 个 vendor 文件 | **zai patch vendor** | P0 |
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

### Phase 1:基础设施(维度 1 + 维度 2 基础)— 1 周

| # | 任务 | 文件 | 方式 | 优先级 |
|---|---|---|---|---|
| 1.1 | 实现 `zaiEnqueue` / `zaiEnqueuePendingNotification` wrapper | `packages/zai/src/server/services/messageQueueAdapter.ts`(新) | zai 层 | P0 |
| 1.2 | zai patch `toolUseContext.agentId = sessionId` 注入 | `packages/zn-agent-core/src/compat/repl/createReplSession.ts:486-536` | **zai patch vendor** | P0 |
| 1.3 | zai patch 替换 vendor 26 个 `enqueuePendingNotification` 调用方 | 26 个 vendor 文件 | **zai patch vendor** | P0 |
| 1.4 | 写 e2e 测试验证 mid-turn drain session 路由(2 session 互不窜) | `__tests__/messageE2E.test.ts` | zai 层 | P0 |

### Phase 2:补缺(维度 1 + 维度 2 细节)— 1-2 周

| # | 任务 | 文件 | 方式 | 优先级 |
|---|---|---|---|---|
| 2.1 | 修复 BashNotifier dead code,接入 BashBackgroundTracker | `bashNotifier.ts` + `agentRuntime.ts` | zai 层 | P0 |
| 2.2 | zai patch bg-daemon per-session clientId | `daemon/mailbox.ts:99-105` | **zai patch vendor** | P1 |
| 2.3 | zai patch `useInboxPoller` sessionId 路由(busy→idle 切换) | `useInboxPoller.ts:876-950` | **zai patch vendor** | P1 |
| 2.4 | zai patch `useMailboxBridge` sessionId 参数 | `useMailboxBridge.ts:12-23` | **zai patch vendor** | P2 |
| 2.5 | 实现 8 类 inbox message types 解析 | `inboxMessageHandler.ts`(新) | zai 层 | P1 |
| 2.6 | 扩展 `__zaiBridgeCtx.onYield` 处理 permission_request / elicit | `agentRuntime.ts:178` | zai 层 | P1 |
| 2.7 | zai mailbox signal 订阅机制 | `setupMailboxBridge.ts` | zai patch | P2 |

### Phase 3:TUI/headless 循环对标(维度 3)— 2 周

| # | 任务 | 文件 | 方式 | 优先级 |
|---|---|---|---|---|
| 3.1 | 镜像 vendor 30+ 通知 hook(从 setupNotifications emit 调用方入手) | 各 zai 模块 | zai 层 | P1 |
| 3.2 | 镜像 useInboxPoller 8 类解析 | `inboxMessageHandler.ts` | zai 层 | P1 |
| 3.3 | 镜像 useScheduledTasks / useProactive(zai fallback 已镜像,主路径可选) | — | — | P2 |
| 3.4 | 评估切到 `print.ts` 双轨(spec §5.8 路径 A) | 调研文档 | zai 层 | P2 |
| 3.5 | permission request 弹窗 SSE 推流(对应 vendor useTerminalNotification) | `__zaiBridgeCtx.onYield` | zai 层 | P1 |
| 3.6 | `OpenccRuntimeV2` 扩展(选项 B,新增 hooks/swarm/background/proactive 方法) | `createOpenccRuntime-impl.ts` + `serverTypes.ts` | **zai patch vendor** | P2 |

### Phase 4:验证与文档(0.5 周)

| # | 任务 | 文件 | 优先级 |
|---|---|---|---|
| 4.1 | 端到端 trace 测试(8 个场景 × 多 session) | `messageE2E.test.ts` | P0 |
| 4.2 | 更新 `docs/2026-09-06-opencc-web-repl-unified-view.md` 反映新镜像 | docs | P1 |
| 4.3 | 评估 `print.ts` 双轨切换的 ROI | 调研文档 | P2 |

---

## 5. 关键不变量

### 5.1 存储维度

| 不变量 | 文件:行号 | 含义 |
|---|---|---|
| `commandQueue` 是模块级 singleton | `messageQueueManager.ts:52` | 同进程所有 session 共享,但靠 `agentId` 字段 session 路由 |
| `SessionInbox` per-session lanes | `sessionInbox.ts:35-36` | `Map<sessionId, {nextTurn, nextStep}>` |
| `engines` Map<sessionId, QueryEngine> | `createOpenccRuntime-impl.ts:577-625` | 每个 session 独立 vendor engine |
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
| `zaiEnqueue` 自动注入 agentId(本方案) | zai 层包装 | zai patch 替换 vendor 调用方 |
| `toolUseContext.agentId = sessionId`(本方案) | `createReplSession.ts` zai patch | zai 调用 vendor query 时设 |

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

| 风险 | 后果 | 缓解 |
|---|---|---|
| zai patch 替换 vendor 26 个 enqueue 调用方 → vendor 上游同步时冲突 | 上游合并时需要 rebase | 在 patch 注释里写明 zai patch 原因,便于 rebase |
| zai patch `toolUseContext.agentId = sessionId` 影响 vendor 测试 | vendor 主路径测试在 zai 不跑 | zai bundle 单独 esbuild 隔离;写测试覆盖 |
| `toolUseContext.agentId` 改动影响 vendor 主线程判断 | bundle 共享 module singleton 可能影响单元测试 | Phase 1.2 测试覆盖 |
| BashNotifier 启用后高频 bash 完成可能 turn 风暴 | throttle + isMeta 抑制 | Phase 2.1 + throttle |
| 8 类 inbox message types 漏解析 | zai web 用户感知不到某些类型 | Phase 2.5 一次性补齐 |

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
| **zai patch 替换 vendor 26 个 enqueue 调用方**(替代"zai 镜像 vendor enqueue") | vendor 内部逻辑无需镜像;标准 zai patch 做法 |
| **zai 复用 vendor `agentId` 字段做 sessionId 路由** | vendor 子 agent filter 是唯一不需新建机制的 session 路由 |
| **zai patch `toolUseContext.agentId = sessionId`** | 配合 agentId 注入,vendor mid-turn drain 自动 session 路由 |
| **zai 主路径选 `createOpenccRuntime` 而非 `print.ts`** | 复杂度低(spawn 子进程的 IPC 协议对齐成本高) |
| **BashNotifier 必须修复**(dead code 修复) | 这是 vendor 通知的唯一直接通道 |
| **fallback `setupMailboxBridge` 改 in-memory signal** | `appendFileSync` 不是真正的 mailbox,只是日志 |

---

## 7. zai 已有的 session 隔离能力(不需重建)

| 已有能力 | 文件:行号 | 状态 |
|---|---|---|
| `SessionInbox` 双车道 | `sessionInbox.ts:35-108` | ✅ 完整 |
| `__zaiSessionInbox` globalThis | `agentRuntime.ts:145-150` | ✅ 已注入 |
| `__zaiBridgeCtx` globalThis | `agentRuntime.ts:178` | ✅ 已注入(部分) |
| `registerExtraReminderProvider` | `agentRuntime.ts:164` | ✅ 已注册 |
| `drainInboxReminder` busy 路径 | `inboxReminder.ts` | ✅ 已实现 |
| `SubagentNotifier` bg agent 路由 | `subagentNotifier.ts:43-150` | ✅ 已实现 |
| per-session `QueryEngine` 实例 | `createOpenccRuntime-impl.ts:577-625` | ✅ 已有 |
| per-session AbortController | `createOpenccRuntime-impl.ts:561-565` | ✅ 已有 |
| per-session 状态机(QueryGuardState) | `compat/repl/setup/setupQueryGuard.ts:62-76` | ✅ 已有(fallback) |
| per-session eventBus | `eventBus.ts` | ✅ 已有 |

---

## 8. 文档元信息

- **路径**:`docs/2026-09-06-zai-session-isolation-plan.md`
- **编写日期**:2026-09-06
- **调研输入**:`docs/2026-09-06-vendor-message-system.md`(1168 行)+ `docs/superpowers/specs/2026-08-27-zai-headless-runtime-vs-vendor-repl-comparison.md`(1148 行)+ zai 现状代码
- **核心原则**:**尽量少改动 vendor 代码**(通过 zai patch 标注);zai 在 vendor 接口之上做 session 隔离层;必要时直接 zai patch vendor 调用方,不为了"零改动"而镜像大量 vendor 逻辑
- **三维度核心**:
  1. **存储隔离**:`agentId` 字段复用为 sessionId 路由 vendor `commandQueue` + `SessionInbox` 镜像 zai per-session lane
  2. **生产/消费隔离**:zai patch 替换 vendor 26 个 enqueue 调用方为 `zaiEnqueuePendingNotification` + `toolUseContext.agentId = sessionId` 注入
  3. **TUI/headless 对标**:`ReplRuntime + createOpenccRuntime`(主路径)+ `print.ts`(备选双轨)+ `createReplSession`(fallback),缺 22 项 vendor hooks 通过 zai patch 或 zai 镜像补
- **下一步**:Phase 1(P0:wrapper + agentId 注入 + zai patch 26 个调用方 + BashNotifier 修复),目标 **2-3 周内完成关键路径**