# Spec — zai inproc 链路从 print.ts 实例化迁移到 vendor REPL 命令式抽壳

**日期**:2026-08-30
**状态**:draft (待评审)
**关联 spec**:
- `docs/superpowers/specs/2026-08-27-zai-headless-runtime-vs-vendor-repl-comparison.md`(§5.8 路径 C 长期方向 + §3 现状盘点)
- `docs/superpowers/specs/2026-08-24-zai-runtime-printts-sse-web-bridge.md`(B1 子进程方案,已被 inproc-print plan 取代)
**关联 plan**:
- `docs/superpowers/plans/2026-08-27-inprocess-print-multi-session-runtime.md`(createPrintRuntime P0-P3,本 spec 是它的"换底层"继任)
**替换目标**:直接替代 `createPrintRuntime`(`packages/zn-agent-core/src/opencc-src/server/createPrintRuntime-impl.ts`),不再双轨并存。

---

## 0. TL;DR

zai 当前 inproc 链路基于 vendor `cli/print.ts`(5881 行),通过 `printSessionRuntime.ts` ALS + `headlessPrintSession.ts` 包装做"实例化"——已积累 17+ 个 zai patch,集中在 4 个进程级 chokepoint(stdout / gracefulShutdown / cleanupRegistry / cronScheduler),最近 commit `8241142a EventDrivenPrint` 还在改 do-while → 事件驱动循环。

**本 spec 的方案**:zai fork 内抽 vendor `screens/REPL.tsx`(5366 行 React/Ink 组件)的 non-UI 部分,做成纯命令式入口 `createReplSession(opts)`,**复用 vendor 内部 hooks/utils 逻辑,仅剥除 Ink/React 渲染壳**。最终**直接替换** `createPrintRuntime`,使 inproc 链路拿到 vendor REPL.tsx 的全量能力(60+ hooks / session loop / cron / proactive / swarm / inbox / teammate),脱离 print.ts 实例化的补丁泥潭。

---

## 1. 动机:为什么 print.ts 实例化路径要换

### 1.1 根本矛盾

`cli/print.ts` 的设计前提是 **"一进程一 session,跑完退进程"**——这是 vendor SDK host 模式(`opencc -p --input-format stream-json`)的标准形态。zai inproc 链路把它"实例化"为多 session runtime 后,与该前提产生四个**结构性冲突**:

| # | 进程级假设 | 多 session 需求 | zai 当前 patch |
|---|---|---|---|
| 1 | 输出硬绑 `process.stdout` | 每 session 独立 NDJSON sink | `print.ts:548/632/854/929/5096` 等 5+ 处 `writeToStdout` 路由 |
| 2 | `gracefulShutdownSync` → `process.exit` | 不退进程,只 resolve 本实例 | `print.ts:1225` ALS 拦截 |
| 3 | cleanupRegistry / `receivedMessageUuids` Set 进程级单例 | per-session | `print.ts:407/438/4292` per-session bucket |
| 4 | `cronScheduler` per-call 局部 | 多实例共享同一份 `.zai/scheduled_tasks.json`,N timer 浪费 | `print.ts:2914` per-instance 关闭 + zai 端进程级单 scheduler |

每次 vendor 升级 `print.ts`,这 4 个 chokepoint 的补丁都得回放。最近 10+ 个 commit(`f1955c50` / `93ec30b9` / `1f985758` / `d12fe8f2` / `3c9180c5` / `003a6948` / `c97cd73b` / `7ba8f72b` / `8241142a` / `3e121fc9` / `7fdd4229` / `f7ae92a5` / `312eddc5` / `2a4dcd38` / `a7c1f11e` / `b4124293` / `a24774ed` / `4e385b7c` 等)**全部是 print runtime 相关修补**。

### 1.2 为什么 REPL.tsx 是更好基底

- REPL.tsx 才是 vendor 主力维护路径——**所有新能力都先加在 REPL.tsx,再 backport 到 print.ts**(包括 cron / proactive / inbox / teammate / swarm / sandbox / elicitation 等)
- REPL.tsx 的 hooks 体系(useScheduledTasks / useProactive / useSwarmInitialization / useInboxPoller / useMailboxBridge / useSessionBackgrounding 等)是 vendor 完整的能力集——print.ts 只是它的**命令式简化版**
- print.ts 当前的"实例化"本质上是在**反向补齐 REPL.tsx 的能力**——既然 REPL.tsx 已经是完整版本,直接抽它的 non-UI 部分更短路径

### 1.3 治本路径(§5.8 路径 C)的现实选择

理想是 vendor 自抽 `HeadlessSessionEngine`(无 React/Ink 的 REPL 引擎),但 vendor 当前没有这个抽象。**zai 在自己 fork 里先抽**——既拿到治本收益,又为未来 vendor 抽象提供参考实现。

---

## 2. 抽壳边界

### 2.1 REPL.tsx 双层划分

| 层 | 内容 | 抽壳处理 |
|---|---|---|
| **渲染壳**(剥除) | `<App>`、`<REPL>`、`Box/Text`、Screens、Notifications context、`useInput/useStdin/useTerminalSize/useTerminalTitle/useTerminalFocus/useTabStatus` | 全部去除;`useInput` 用 server-side `opts.input` AsyncIterable 替代(无 TTY stdin) |
| **逻辑层**(复用) | onSubmit/onQuery/onQueryImpl 状态机、useCommandQueue、useScheduledTasks、useProactive、useSwarmInitialization、useSessionBackgrounding、useInboxPoller、useMailboxBridge、Zustand AppState、Notifs、CronScheduler、Mailbox、InProcessTeammate、vendor `query()` 入口 | 复用 vendor 内部实现;React `useXxx` 拆为 `setupXxx(opts) → { teardown, subscribe }` 命令式适配,**一份逻辑、两套调用** |

### 2.2 hook 复杂度四档

| 档 | 描述 | 抽壳形态 | 例子 |
|---|---|---|---|
| **L0 纯逻辑** | module-level queue / class,无 React 依赖 | `setupXxx()` 返回 `{ teardown, fn }`,直接复用 | `useCommandQueue`、`useArrowKeyHistory`(server 跳过)、`useAssistantHistory` |
| **L1 副作用 hook** | useEffect + 内部命令式逻辑(setInterval / event listener) | `setupXxx(opts) → { teardown, subscribe }`,同一份逻辑,React 与命令式各包一层 | `useScheduledTasks`(cronScheduler)、`useProactive`、`useInboxPoller`、`useMailboxBridge`、`useSessionBackgrounding`、`useSwarmInitialization`、`useSkillsChange`、`useTasksV2WithCollapseEffect` |
| **L2 状态机 hook** | useState/useReducer + 副作用 | **拆出 state machine class**,原 hook 改为薄 React 包装;命令式直接用 class | `useCommandKeybindings`、`useDiffData`、`useTextInput`(server 跳过) |
| **L3 渲染 hook** | 深度绑 Ink/React | **完全去除**,改 server-side 适配 | `useInput`(→ `opts.input` AsyncIterable)、`useStdin`、`useTerminalSize`、`useTerminalTitle`、`useTabStatus`、`useNotifications` |

### 2.3 screens/* UI 组件策略

`PermissionRequest.tsx` / `ElicitationDialog.tsx` / `ResumeCompactPrompt.tsx` 等 `screens/*` 下的 UI 组件**深度绑 React 渲染**,本 spec **不抽**。它们原本只对终端交互有意义;改走 zai web UI 出口(`askRegistry` / `permissionRegistry` 已有,本次扩 `elicitationRegistry`)。

---

## 3. `createReplSession` 接口

```typescript
type ReplSessionOptions = {
  /** zai sessionId,绑定 vendor `getSessionId()` ALS。 */
  sessionId: string
  /** Project cwd,vendor derive transcript path 用。 */
  cwd: string
  /** 主 Agent 名(builtin slot 派发)。 */
  mainAgent?: string
  /** 默认模型;per-turn 覆盖通过 `setModel`。 */
  model?: string
  /** 初始 permission mode。 */
  permissionMode?: PermissionMode

  /** server-side 注入(替代 Ink 的 stdin/stdout)。 */
  input: AsyncIterable<UserMessage | InterruptRequest | EnqueueRequest>
  hooks: {
    /** 推一个事件到 zai SSE;替代 Ink 渲染。 */
    onEvent: (ev: ReplEvent) => void
    /** 可选:hook trace(PreToolUse / PostToolUse / UserPromptSubmit 等)。 */
    onHook?: (hook: HookTrace) => void
  }

  /** 与 zai 现有桥接。 */
  canUseTool?: CanUseToolFn
  getAppState?: () => AppState
  setAppState?: SetAppStateFn
  mcpClients?: McpClient[]
  /** vendor 上下文(与 print.ts 共享同一套)。 */
  bootstrap?: BootstrapState
}

type ReplSession = {
  /** 推一条 user prompt;session busy 时 enqueue 等 turn 结束。 */
  submit(content: ContentBlock[]): Promise<void>
  /** steering:'now' 抢占打断当前 turn,'next'/'later' 排队。 */
  enqueue(
    content: ContentBlock[],
    priority: 'now' | 'next' | 'later'
  ): Promise<void>
  /** 中断当前 turn(vendor control_request{interrupt} 语义)。 */
  interrupt(reason?: string): Promise<void>
  /** 优雅结束(SessionEnd hooks fire)。 */
  endSession(reason?: string): Promise<void>
  /** 订阅 lifecycle 事件。 */
  on(
    event: 'turnStart' | 'turnEnd' | 'sessionStart' | 'sessionEnd' | 'abort',
    cb: (payload?: unknown) => void
  ): Unsubscribe
  /** 强制 dispose(idle TTL / maxSessions LRU / server shutdown)。 */
  dispose(): Promise<void>
  /** 当前状态(只读投影)。 */
  getState(): SessionStateSnapshot
}
```

---

## 4. 抽壳实现策略

### 4.1 hook 命令式适配原则

**不重写内部逻辑**——在 `packages/zn-agent-core/src/compat/repl/` 下新建 hook 命令式适配层,每个 vendor hook 拆为:

```typescript
// vendor 原 hook(保留,React 使用方不变):
export function useXxx(opts: XxxOpts): void { ... }

// 命令式适配(同模块导出,server-side 使用):
export function setupXxx(opts: XxxOpts): { teardown(): void; subscribe(cb): Unsubscribe } {
  // 与 useXxx 共享 module-level 状态(messageQueueManager / cronScheduler / inboxPoller / mailbox)
  // 仅替换 useEffect 生命周期为显式 setup/teardown
  ...
}
```

`createReplSession` 内部用 `setupXxx` 形式调用;原 `useXxx` 保留不变(给原 REPL.tsx 用)。

### 4.2 状态机层

REPL.tsx 的 `onSubmit / onQuery / onQueryImpl` 状态机用 React `useState / useRef / useCallback` 编排。命令式版本改为 **closure class**,保留所有 `useRef` 等价物为字段、`useState` 等价物为私有 setter,对外 method 集合与原 React callback 一致。

### 4.3 TTY 假设替换

| REPL.tsx TTY 调用 | 命令式替换 |
|---|---|
| `useInput((input, key) => ...)` | `opts.input` AsyncIterable,类型 `UserMessage \| InterruptRequest \| EnqueueRequest`;`createReplSession` 内 `for await (const msg of opts.input) handle(msg)` |
| `useTerminalSize()` | 不需要(server 渲染不依赖) |
| `useTerminalTitle()` | 不需要 |
| `useTabStatus()` | 不需要;`onEvent({type:'turnStart'})` → zai SSE 推前端(替代 terminal tab) |
| `useNotifications()` | `notifs` module-level store 复用,`opts.hooks.onHook({type:'notification', payload})` 推到 zai SSE |

### 4.4 输出路径

不再调 Ink `<Text>`;`opts.hooks.onEvent(ev)` 直接推 zai 事件总线(translateSdkToRuntime 复用,createPrintRuntime-impl:43 已有)。

### 4.5 vendor `query()` 调用方式

保留 vendor `for await (const event of query({messages, systemPrompt, userContext, systemContext, canUseTool, toolUseContext, querySource}))` 的 for-await 形态——本 spec 不重写 vendor `query()` 入口,只去掉 React 外壳。`querySource` 新增 `'server-repl'` 取值(非 `'repl'` 也非 `'sdk'`)。

---

## 5. 阶段交付

| 阶段 | 内容 | 验收 | 估算 |
|---|---|---|---|
| **P0 骨架** | `compat/repl/createReplSession.ts` + `setupXxx(opts)` 适配层(L0 全 + L1 cron/proactive)+ vendor `query()` 命令式调用(不绕 REPL.tsx React 树) | 一个 session 跑通 submit → for await events → turnEnd;两 sessionId 并发隔离;不退化 cron tick | ~1500-2000 行 |
| **P1 主体能力** | L1 全套(`useInboxPoller`/`useMailboxBridge`/`useSwarmInitialization`/`useSessionBackgrounding`/`useSkillsChange` 等)+ 状态机类(`onSubmit→onQuery→onQueryImpl` 拆命令式)+ resume 完整状态恢复(file history / worktree / cost / plan / attribution) | L1 全套 setupXxx teardown 通过单测;两实例跑通 /loop + proactive tick;teammate 创建可被观察到 | ~3000-4000 行 |
| **P2 收口** | L2 状态机 hook 拆分;`screens/*` UI 组件去除,web UI 出口(`askRegistry`/`permissionRegistry` 扩 `elicitationRegistry`);30+ notification hooks 接入(`runtime.notification` 事件) | `createPrintRuntime` 删除,所有路径走 `createReplSession`;`ZAI_CORE_RUNTIME` 从 `inproc` 翻成 `repl`(或直接干掉该开关);print.ts 17+ zai patch 撤回 | ~1500-2500 行 |

### 5.1 替换时机

- **P0 完成**:`ZAI_CORE_RUNTIME` 增加 `repl` 实验分支,`createPrintRuntime` 保留作 fallback
- **P1 完成**:`repl` 默认;`createPrintRuntime` 留作 fallback(失败时降级)
- **P2 完成**:`createPrintRuntime` 删除,print.ts 17+ zai patch 全部撤回(改回 vendor 原版,仅留 `// zai patch` 注释指引)

### 5.2 P0 验收补强

从 inproc-print plan §9.5 抽取:

- 双实例空闲 30min,`process.cpuUsage()` delta ≈ 0
- `process.getActiveHandlesInfo?.()` 检查无意外活跃 handle
- L0/L1 所有 `setupXxx` teardown 后无残留 timer / listener

---

## 6. 数据流(一个 turn 的完整路径)

```
[前端 SSE 收到 user prompt]
  ↓ POST /api/agent/prompt {sessionId, prompt, ...}
routes/agent.ts → runtime.submit(input)
  ↓
createReplSession(opts).submit(content)
  ├─→ setupCommandQueue(opts).enqueue(content, priority)  // L0
  │    └─→ messageQueueManager(module-level,已 vendor 化)
  ├─→ setupCommandKeybindings(opts)  // L2(命令解析)
  ├─→ setupQueryGuard(opts)  // state machine class,generation token 防 stale
  └─→ onTurnStart → for await (const event of query({
        messages, systemPrompt, userContext, systemContext,
        canUseTool: opts.canUseTool ?? ctx.permission,
        toolUseContext, querySource: 'server-repl',
       }))
       ├─→ vendor QueryEngine → defaultQuery → streamingToolExecutor
       ├─→ toolExecution 内部 PreToolUse/PostToolUse hooks(已生效)
       └─→ emit event → opts.hooks.onEvent(ev)  // → zai SSE
                ├─ text_delta → runtime.delta
                ├─ thinking_delta → runtime.thinking
                ├─ content_block_start{tool_use} → runtime.tool_call
                ├─ tool_result → runtime.tool_result
                ├─ control_request → opts.canUseTool 路由
                └─ result → runtime.done
  ↓
for-await 结束 → queryGuard.end(thisGen)
  ├─→ onTurnComplete(messagesRef, abortSignal.aborted)
  │    ├─→ executeSessionEndHooks('turnEnd')  // 复用 vendor
  │    └─→ opts.hooks.onEvent({type:'turnEnd'})  // → zai SSE
  └─→ setupCommandQueue(opts).drain()  // 排下一条入队 prompt
```

### 6.1 对照 createPrintRuntime 的改进

- **去掉 NDJSON line pump**:不再 `rec.lines.push/next` + `JSON.parse`,event 已经是 structured object
- **去掉 `break on 'result'` 修补**(commit `f1955c50` / `003a6948` / `1f985758`):vendor SDK message → ReplEvent 无"stale result"问题(自然终止靠 `query()` done)
- **去掉 per-session AbortController Map**(createPrintRuntime-impl:583):queryGuard generation token 替代,自动防 stale finally
- **去掉 `wrapTaskAwareSetState` 全局指针回退**(`__zaiCurrentSessionId`):ALS 已有,无需 fallback

---

## 7. 错误处理

| 失败场景 | 处理 |
|---|---|
| Hook 抛错 | vendor `executeSessionEndHooks` 已有 timeout + 错误日志;`setupXxx` 返回的 teardown 顺序按 LIFO,单个失败不阻塞其他 |
| Session 崩溃 | `query()` reject → `onSessionEnd('crash')` → SessionEnd hooks fire → `opts.hooks.onEvent({type:'sessionCrash', error})` → zai SSE 推 runtime.error |
| Hook timeout | `getSessionEndHookTimeoutMs()` 复用,AbortSignal 中止未完成的 hook |
| Dispose 中途失败 | `dispose()` 幂等;`for (const teardown of teardowns.reverse()) await teardown().catch(log)` |
| 并发 dispose | `dispose()` 内部 `if (disposed) return`,多个调用方安全 |
| 致命错误 OOM | vendor `queryGuard` 监控内存压力;超阈值 → 触发 SessionEnd + server restart |
| Loop/cron/proactive 触发 hook 失败 | vendor 原机制已有 fallback(丢弃/记日志),复用 |
| Vendor 升级导致 API 不兼容 | `setupXxx` 适配层是隔离点,vendor 改动仅影响对应 adapter;`createReplSession` 主流程不变 |

---

## 8. 测试策略

| 层 | 工具 | 覆盖 |
|---|---|---|
| **单元** | Vitest | `createReplSession` 每个 `setupXxx(opts)` 的 teardown 顺序;hook 异常不影响其他 hook;ALS sessionId 路由正确;queryGuard generation token 防 stale |
| **并发隔离** | Vitest(双实例测试) | 两 sessionId 并发 submit / enqueue / interrupt 互不串;permissionMode 不同各走各的;cron /loop 各 fire 各的 |
| **能力对齐** | Vitest(参数化测试) | REPL.tsx 60+ hooks 全清单 → 逐一映射到命令式 setup;每个 hook 都有 `setup` + `teardown` 单测 |
| **集成** | Vitest + 真实 vendor | `createReplSession` 跑一个 turn(单 prompt → for await events → turnEnd);mock model;resume 文件 hydration;cron fire 全链路 |
| **真机** | ego-browser skill(强制项) | 双 tab 双会话并发对话、各自 AskUserQuestion 弹窗不串、/loop cron 实际触发、proactive tick 实际触发、teammate/swarm 创建可观察 |

### 8.1 回归对照

每次阶段完成前,与 `createPrintRuntime` 当前实现跑同一组真机场景:

- 单 prompt 多 turn(用户连发 3 条,看 SSE 顺序)
- 中途 steering('now' 抢占打断当前 turn,跑新 prompt)
- 中途 interrupt(用户按 ESC,turn 终止,vendor 自动续跑中断 turn)
- cron fire(SessionStart hook 配 SessionStart 输出 initialUserMessage)
- proactive tick / /loop 触发
- 双 session 并发,各自 permissionMode 不同
- session 异常结束 / dispose / server shutdown

---

## 9. 关键文件清单

| 动作 | 文件 |
|---|---|
| 新增 | `packages/zn-agent-core/src/compat/repl/createReplSession.ts`(主入口) |
| 新增 | `packages/zn-agent-core/src/compat/repl/setupXxx.ts`(每个 hook 一份,或合并) |
| 新增 | `packages/zn-agent-core/src/compat/repl/stateMachines.ts`(onSubmit/onQuery/onQueryImpl 命令式 class) |
| 新增 | `packages/zn-agent-core/src/compat/repl/types.ts`(`ReplSession` / `ReplSessionOptions` / `ReplEvent`) |
| 新增 | `packages/zn-agent-core/src/compat/repl/index.ts`(barrel re-export) |
| 修改 | `packages/zn-agent-core/src/opencc-src/hooks/*.ts`(每个 hook 增加 `setupXxx` 导出,与原 `useXxx` 共存) |
| 修改 | `packages/zn-agent-core/src/opencc-src/screens/REPL.tsx`(无功能性改动;可选:用 `setupXxx` 替换内部 `useXxx` 调用以验证等价性) |
| 修改 | `packages/zn-agent-core/src/opencc-src/query.ts`(`querySource` 新增 `'server-repl'` 字符串字面量类型) |
| 修改 | `packages/zai/src/server/services/agentRuntime.ts`(init 路径从 `createPrintRuntimeImpl` 改为 `createReplSession`) |
| 修改 | `packages/zai/src/server/services/agentRuntime/types.ts`(`OpenccRuntimeV2` 扩展为 `OpenccRuntimeV3`,承接 `createReplSession` 形态;或保持兼容,`submit` 转 `query`) |
| 修改 | `packages/zai/src/server/routes/agent.ts`(`sessionQueues` 改为 `createReplSession` 实例内部 enqueue,API 不变) |
| 修改 | `packages/zn-agent-core/src/opencc-src/server/index.ts`(barrel re-export `createReplSession`) |
| 修改 | `packages/zn-agent-core/src/bundle-entry.ts`(主入口 export `createReplSession`) |
| 删除(P2) | `packages/zn-agent-core/src/opencc-src/server/createPrintRuntime-impl.ts` |
| 删除(P2) | `packages/zn-agent-core/src/opencc-src/server/createPrintRuntime.ts`(types) |
| 删除(P2) | `packages/zn-agent-core/src/opencc-src/server/headlessPrintSession.ts` |
| 删除(P2) | `packages/zn-agent-core/src/opencc-src/utils/printSessionRuntime.ts` |
| 撤回(P2) | `packages/zn-agent-core/src/opencc-src/cli/print.ts` 17+ zai patch(改回 vendor 原版;`runHeadless` 不再被 zai 调用) |
| 复用 | `compat/runtime/sdkEventAdapter.ts`(translateSdkToRuntime);`runtime/sdkContext`(runWithSdkContext ALS);`utils/sessionStart.ts`、`utils/hooks.ts`;`utils/cronScheduler.ts`;`utils/permissions/permissionSetup.ts`;`mainAgents.ts`(resolveSessionMainAgent);`getAgentRegistry` |
| 退役不删(P2 之后视情况) | `packages/zai/src/server/services/sessionHost/*`(spawn 模式) |

---

## 10. 风险与缓解

| 风险 | 缓解 |
|---|---|
| REPL.tsx 的 hook 内部逻辑实际比想象更绑 React(如 useState 闭包依赖) | P0 阶段先**逐 hook 做 spike**;如果某个 hook 内部 React 依赖太深,L1 → L2,改抽 state machine class;L2 → L3,改重写 |
| Vendor 升级 REPL.tsx 时破坏 setupXxx 适配层 | setupXxx 是**隔离点**;vendor 改动只影响对应 adapter;`createReplSession` 主流程不变。每个 PR 加 adapter 适配回归单测 |
| 60+ hooks 全量命令式化工作量大,排期失控 | P0/P1/P2 阶段严格排序;P0 通过 = 骨架验证可行;P1 是大头,**做不完就停在 P1**(可生产使用,能力 80%);P2 是收口,可以后续迭代 |
| 命令式 state machine class 比 React 状态机更易引入 bug(useEffect 时序问题在 class 里不存在,但 useState 闭包依赖要重写) | 每个拆出的 state machine class 配**完整单测**,对照原 hook 行为一一验证;P0 阶段先选 1-2 个简单 hook 验证模式 |
| 双轨过渡期 `createReplSession` 与 `createPrintRuntime` 并存,行为不一致 | P0/P1 期间 zai 默认走 `createPrintRuntime`,`createReplSession` 是 opt-in 实验分支;P1 末期默认切换,P2 删除老路径 |
| `screens/*` UI 组件去除影响用户体验(plan mode ExitPlanMode 确认弹窗等) | `askRegistry` / `permissionRegistry` 已有;P2 加 `elicitationRegistry`;前端 UI 走 zai 现有 QuestionCard / PermissionDialog 链路 |
| 与 vendor 升级回放冲突(setupXxx 适配层需要同步) | 每个 PR 附 "vendor version: x.y.z" 注释;升级 vendor 时按 hook 清单逐个核验 |
| 30+ notification hooks(API migration / rate limit / plugin auto-update 等)全量命令式化收益不明显 | P2 阶段只实现**与 inproc 体验直接相关**的(AskUserQuestion、Permission、Elicitation);其余走 `runtime.notification` 事件,前端 reducer 选择性显示 |
| 性能:命令式 session loop 是否比 print.ts 实例化慢 | P0 验收加 `process.cpuUsage()` 与 `getActiveHandlesInfo` 断言;性能回归比对 |
| 内存:每 session 一个 setupXxx 套件,常驻 N 个 session 时内存占用 | `enforceMaxSessions` LRU 限制 N(默认 8);idle TTL 驱逐;P0/P1/P2 各阶段压测 |

---

## 11. 验收口径(全量)

- **正确性**:REPL.tsx 的能力清单(60+ hooks / cron / proactive / swarm / inbox / teammate / sandbox / elicitation / file history rewind / cost state / worktree / agent restore / plan / attribution / read file state / coordinator mode warning)100% 在 `createReplSession` 中可观察
- **隔离**:N 个 sessionId 并发 submit / enqueue / interrupt 互不串;各自 permissionMode / model / agent / mcp 各走各的
- **稳定性**:双实例空闲 30min,CPU delta ≈ 0,无意外活跃 handle
- **可替换性**:`createPrintRuntime` 删除后,所有现有 zai 调用方(`routes/agent.ts` / `backgroundRuntime.ts` / `mainAgents.ts`)无需改动或仅微小调整
- **真机**:ego-browser skill 通过双 tab 双会话并发对话、AskUserQuestion 弹窗不串、/loop cron 实际触发、proactive tick 实际触发、teammate 创建可观察
- **vendor 同步**:17+ zai patch 撤回后,`cli/print.ts` 与 vendor 原版 byte-for-byte 一致(用 `git diff` 验证)
- **升级健壮性**:vendor REPL.tsx 升级 1 个 minor 版本,`createReplSession` 主体代码不变,只改对应 adapter;回归单测通过

---

## 12. 不在范围

- vendor 自抽 `HeadlessSessionEngine`(§5.8 路径 C 长期方向)—— 本 spec 是 zai fork 内的实现,vendor 抽象是后续工作
- 重写 vendor `query()` 入口或 `QueryEngine` —— 复用 vendor 实现
- 替换 `createOpenccRuntime`(headless 轻量轨道)—— 本 spec 不动,`createOpenccRuntime` 是 off 轨道默认,`createReplSession` 是 inproc 轨道
- zai 前端 UI 改造 —— 服务端迁移不影响 frontend eventBus spec
- `ZAI_OPENCC_CLI` 子进程轨道(spawn `opencc -p`)—— 退役不删,留作最后逃生口
- `compat/runtime/sdkEventAdapter.ts` 重写 —— 复用现有 translateSdkToRuntime

---

## 13. 后续工作

- [ ] **P0 完成后**:发布 `docs/superpowers/specs/2026-XX-XX-repl-extract-p0-completion.md`,记录 hook 适配 spike 结论
- [ ] **P1 完成后**:评估 vendor 抽象 `HeadlessSessionEngine` 可行性;如果可行,推 PR 给 vendor(基于 zai 实现)
- [ ] **P2 完成后**:`print.ts` zai patch 全部撤回 → 升级 vendor 0.20.x → 后续版本不再有补丁同步压力

---

## 14. 元数据

- **作者**:zai team
- **评审人**:zai team
- **依赖 spec**:`2026-08-27-zai-headless-runtime-vs-vendor-repl-comparison.md`、`2026-08-27-inprocess-print-multi-session-runtime.md`(plan)
- **影响**:`packages/zn-agent-core`(vendor 拷贝,允许修改)、`packages/zai`(调用方)
- **优先级**:高(补丁泥潭长期治理)
- **预计工作量**:P0 ~1500-2000 行 / P1 ~3000-4000 行 / P2 ~1500-2500 行,合计 ~6000-8500 行
