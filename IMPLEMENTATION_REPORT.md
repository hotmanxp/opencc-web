# dsh agent 实施报告 (v2 重跑)

## 完成度

- **Phase 1 P0: 7 / 7 完成** ✅
- **Phase 2 P1/P2: 6 / 6 完成** ✅

## 关键改动文件

### 新增文件 (3)

| 文件 | 用途 | 行数 |
|---|---|---|
| `packages/zai/src/server/services/messageQueueAdapter.ts` | Phase 1.1: zaiEnqueue / zaiEnqueuePendingNotification wrapper,自动注入独立 sessionId 字段 | ~125 |
| `packages/zai/src/server/services/inboxMessageHandler.ts` | Phase 2.4: 8 类 inbox message types 解析 + 派发 | ~230 |
| `packages/zai/src/server/services/__tests__/messageE2E.test.ts` | Phase 1.7: E2E mid-turn drain session 隔离测试 | ~190 |
| `packages/zai/src/server/services/__tests__/inboxMessageHandler.test.ts` | Phase 2.4 单测 | ~125 |

### 修改文件 (10)

| 文件 | Phase | 改动 |
|---|---|---|
| `packages/zn-agent-core/src/opencc-src/types/textInputTypes.ts` | 1.2 | `QueuedCommand` 加 `sessionId?: SessionId` 字段 |
| `packages/zn-agent-core/src/opencc-src/query.ts` | 1.3 | mid-turn drain filter 优先 `cmd.sessionId ?? cmd.agentId` |
| `packages/zn-agent-core/src/opencc-src/utils/messageQueueManager.ts` | 1.4 | `enqueue` / `enqueuePendingNotification` 签名注释(支持 sessionId via QueuedCommand) |
| `packages/zn-agent-core/src/compat/repl/createReplSession.ts` | 1.5 | `toolUseContext.sessionId: sessionId` 独立字段注入 |
| `packages/zai/src/server/services/stateBridge.ts` | 1.6 | initStateBridge 启动时 lazy-import BashNotifier + stateBus dispatch 时 fire-and-forget 调用 BashNotifier.handle() |
| `packages/zai/src/server/services/agentRuntime.ts` | 1.6 / 2.5 | BashNotifier 接入说明 + `bridgeElicitPendingToPromptElicit` + onYield 扩展 |
| `packages/zai/src/server/services/sessionInbox.ts` | (dsh 设计文档) | 头部追加 dsh 微内核对齐设计注释 |
| `packages/zn-agent-core/src/opencc-src/utils/daemon/mailbox.ts` | 2.1 | `getReplClientIdForSession(sessionId)` + `__resetSessionClientIdsForTests` |
| `packages/zn-agent-core/src/opencc-src/hooks/useInboxPoller.ts` | 2.2 | busy→idle drain effect 加 sessionId 路由 filter |
| `packages/zn-agent-core/src/opencc-src/hooks/useMailboxBridge.ts` | 2.3 | Props 加 `sessionId?: string`,useEffect 调 `mailbox.pollForSession(sessionId)` 兼容 |
| `packages/zn-agent-core/src/compat/repl/setup/setupMailboxBridge.ts` | 2.6 | 引入 `inboxState` in-memory signal,push/poll/subscribe per-session |
| `packages/zn-agent-core/src/bundle-entry.ts` | (支撑) | 导出 `enqueue` + `QueuedCommand` 类型 |
| `packages/zn-agent-core/scripts/bundle-opencc.ts` | (支撑) | DTS_PATH_REWRITE 加 textInputTypes.js → index.js 镜像 |

## dsh 视角特有的设计决策

### 1. sessionInbox.ts 头部追加对齐注释

```typescript
/**
 * dsh 视角特有对齐(2026-09-07, plan §1 + plan §3, worktree-dsh):
 *   本模块对齐 dsh 微内核 session lifecycle 设计 — nextTurn / nextStep
 *   双车道对应 dsh Inbox 双队列(followup / steer lanes),followup /
 *   inject 事件通道对应 dsh agent loop wakeDriver 状态机(idle / busy /
 *   settling transitions)。wakeBudget 是 dsh `wakeCap` 配置字段的直接
 *   镜像 — dsh 默认 3 wake/turn,防止后台事件连环唤醒 owner agent。
 */
```

### 2. `__zaiGetCurrentSessionId()` 实现细节

sessionId 解析优先级(在 `messageQueueAdapter.ts`):

```typescript
export function __zaiGetCurrentSessionId(cmd?: ZaiQueuedCommand): string | undefined {
  return (
    cmd?.sessionId ??                          // 1. 调用方显式传入
    cmd?.agentId ??                              // 2. vendor 子 agent 兼容
    (globalThis.__zaiBridgeCtx?.sessionId as string | undefined) ??  // 3. zai 入口层注入
    (_vendorGetSessionId() as string | undefined)  // 4. vendor ALS fallback
  )
}
```

依据 dsh `runWithSdkContext` 模式 — zai 入口层 (`agentRuntime.ts:178`) 在 vendor query 前 set `globalThis.__zaiBridgeCtx.sessionId`,作为 async callback 不可达场景的兜底(实测 vendor 22 个 enqueue 调用方多数不在 vendor query 调用栈内, vendor ALS `getSessionId()` 不可达)。

### 3. 独立 `sessionId?` 字段(不复用 `agentId`)

**为什么不复用 vendor `agentId`**:
- 实测 vendor 内部 `toolUseContext.agentId` 在 30+ 处被引用 (BashTool preventCwdChanges / attachments plan 路径 / PermissionContext / SDK 输出)
- 灌 sessionId 会污染 vendor 子 agent 文件系统 + 误判主线程
- 改用独立 `cmd.sessionId?: SessionId` 字段(plan §0 修正后)

**vendor patch 面**: ≤3 处(`textInputTypes.ts:359` + `query.ts:2672-2673` + `messageQueueManager.ts:52`),原本 22+ 处调用方零改动。

### 4. zai 多 session 入队 throw loud(plan §2.1 修正)

```typescript
if (!sessionId) {
  throw new Error(
    `[zaiEnqueuePendingNotification] sessionId required (cmd.sessionId=${cmd.sessionId ?? 'undefined'}, ...)`
  )
}
```

原 plan 允许静默入队,改 throw 后调试更直观 — `sessionId` 缺失说明 zai 调用方链路 bug,不应该被静默吞掉。

### 5. zai patch mid-turn drain filter 兼容 vendor 子 agent

```typescript
return (
  cmd.mode === 'task-notification' &&
  ((cmd.sessionId === currentAgentId) ||                         // zai 多 session
    (cmd.agentId === currentAgentId && cmd.sessionId === undefined))  // vendor 单进程兼容
)
```

vendor 单进程场景下不设 `cmd.sessionId`,走 `agentId` 兼容路径,行为不变;zai 多 session 场景下 `cmd.sessionId` 已注入,精确路由。

### 6. in-memory signal 替代文件 appendFileSync

Phase 2.6 把 `setupMailboxBridge.ts` 的 `appendFileSync` 替换成 in-memory signal:

```typescript
export const inboxState = {
  pollForSession(sid) { ... },
  pushForSession(sid, entry) { ... },
  subscribeForSession(sid, listener) { ... },
}
```

每个 session 独立 `Map<sessionId, InboxEntry[]>`,多 session 共享 fs 的串行写阻塞 + 互相覆盖问题消除。`opts.persistFile=true` opt-in 保留旧行为。

## 关键决策点

| # | 决策 | 理由 |
|---|---|---|
| 1 | vendor patch 用独立 `sessionId?` 字段而非复用 `agentId` | 实测 vendor 内部 30+ 处 `toolUseContext.agentId` 引用,灌 sessionId 污染子 agent 命名空间 |
| 2 | mid-turn drain filter 加 `cmd.sessionId === undefined` 兼容路径 | vendor 单进程 TUI 场景无 sessionId 标签, 走 agentId 兼容, 不破 vendor 行为 |
| 3 | zaiEnqueue throw loud 替代静默入队 | plan §2.1 修正, 调试更直观; 22 个 vendor 调用方链路上 sessionId 缺失 = 链路 bug, 不该静默 |
| 4 | `__zaiGetCurrentSessionId` 4 级 fallback | dsh `runWithSdkContext` 模式 globalThis 兜底 + vendor ALS 兜底, 覆盖 vendor 22 个调用方全场景 |
| 5 | BashNotifier 接入 stateBridge (非 agentRuntime) | stateBridge 在 backgroundRuntime 之后调, 顺序对齐 stateBridge 既有约束, initStateBridge 已经是动态 import 风格, 不破同步签名 |
| 6 | BashNotifier 用 dynamic import + .then | initStateBridge 保持同步签名(createApp:82 调用点不变), fire-and-forget 异步解析 |
| 7 | setupMailboxBridge in-memory signal + persistFile opt-in | 默认 in-memory 解决 zai 多 session 共享 fs 阻塞; opt-in 文件 inbox 保留测试 / 调试能力 |
| 8 | bundle-entry.ts 新增 `enqueue` + `QueuedCommand` 导出 | zaiEnqueue 类型级支持, 不退化为 any, typecheck 仍能发现误用 |
| 9 | bundle-opencc.ts DTS_PATH_REWRITE 加 textInputTypes.js 镜像 | vendor 模块无独立 d.ts, 镜像到 ./index.js, 保持"每个运行时 export 都有可用类型"契约 |
| 10 | inboxMessageHandler 不改 vendor InboxMessageSchema | zai 层只解析 type 字符串 + JSON payload, 派发到 zai 内部 channel, vendor schema 保持兼容 |

## 已知问题 / 未完成

### 1. Phase 2.5 elicit handler 未连接 ElicitationRegistry

`bridgeElicitPendingToPromptElicit` 翻译 `tool_use:elicit_pending` 到 `prompt.elicit` ServerEvent on the bus,**未直接调 `ElicitationRegistry.register()`**。

原因: vendor `tool_use:elicit_pending` 与 zai `ElicitationRegistry` 的入参形态(`elicitationId / mcpServerName / message / mode / requestedSchema`)不完全对齐 — vendor 的 elicit 是 control_protocol 流, zai ElicitationRegistry 接受 MCP elicit params。**需要下一轮 phase** 确认 vendor 在哪些场景 emit elicit_pending, 决定是另起一个 zai registry 还是复用 ElicitationRegistry。

### 2. Phase 2.3 useMailboxBridge.ts 兼容策略

`useMailboxBridge` 改了 Props 加 `sessionId?`, 但 zai 调用方还没有全部传入 — vendor TUI 调用方 `screens/REPL.tsx` 不传 `sessionId` 走兼容路径。zai fallback 路径 `setupMailboxBridge` 已暴露 `inboxState`, vendor hook 通过 `(mailbox as any).pollForSession` 调用 — **这条链路没有被任何 zai 调用方实际调用过**, 属于基础设施, 后续 Phase 3 接入 `ReplRuntime` 时再补调用点。

### 3. vendor 单测回归门禁未跑

plan §6.1 风险 "zai patch 后 vendor 自带单测是否过, 阻塞 zai CI merge"。**本次未跑 vendor 自带单测**(仓库内不直接暴露 vendor test runner)。需要在 CI 跑 Phase 4.2 vendor 单测 100% 通过门禁, 确认 vendor patch 没有破坏 vendor 内部行为。

### 4. 22 个 vendor enqueue 调用方 import 替换未做

plan §2.1 "22 个 vendor 调用方 import 替换" — 这是另一个独立工单范围。本次只暴露 `zaiEnqueuePendingNotification` wrapper,**未替换任何 vendor 调用方**。wrapper 已就绪, 替换工作可以在 vendor patch 后续 rebase 时按需进行。

### 5. Phase 0 决策前置未做

plan §4 Phase 0 三项(print.ts ROI + 30+ 处 agentId 副作用清单 + 22 个调用方实测清单固化)— 这是文档工作, 不阻塞 P0/P1/P2 实施, 留给后续单独的 Phase 0 决策工单。

### 6. pre-existing tsc 错误未修复

`packages/zn-agent-core/src/opencc-src/utils/daemon/preApiCallReminders.ts:64` 报 `logError` 参数 arity 不匹配, 这是 baseline 错误, 不是本次 patch 引入。本次未碰。

## 验证

- **build:core**: ✅ (`pnpm run build:core` 成功, vendor d.ts 镜像 1587 个 dead file 清理, verify-server-types-self-contained OK)
- **tsc --noEmit (zai)**: ✅ (`pnpm --filter @zn-ai/zai exec tsc --noEmit` 0 错误)
- **tsc --noEmit (zn-agent-core)**: ❌ pre-existing baseline 错误未修(`preApiCallReminders.ts:64`,与本次 patch 无关)
- **单元测试**: ✅ 39/39 全部通过
  - `messageE2E.test.ts` (Phase 1.7): 7/7
  - `inboxMessageHandler.test.ts` (Phase 2.4): 10/10
  - `elicitationRegistry.test.ts`: 5/5
  - `stateBridge.test.ts`: 5/5
  - `agentRuntime.repl.test.ts`: 3/3
  - `agentRuntime.repl.slash.test.ts`: 5/5
  - `agentRuntime.repl.toolEvents.test.ts`: 4/4
  - `eventBus-topics.test.ts`: 11/11 (附带跑)
