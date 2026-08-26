# zai Session Inbox 机制设计(DSH 对齐版)

**日期：** 2026-08-17
**状态：** 待实施(rev 3 — 补充 zn-agent-core 改造、session 模型对照、并发守卫与边界)
**来源：** DSH(deepseek-harness)后台任务/后台 Agent 结果回传机制的移植调研

## 背景

zai 当前把「后台子 Agent / 后台任务完成后的结果回传主对话」做成**单一 fire-and-forget**：

- `SubagentNotifier.handle()`(`server/services/subagentNotifier.ts:80`)在任务进入 terminal 且带 `parentSessionId` 时,**直接调 `runtime.query()`** 往父 session 注入一条 `<task-notification>` 并启动新一轮 turn(`inject()` L110-170)。
- 为避免通知 query 与主线并行,加了 **running 守卫**(L96-101):主线活跃时把通知暂存进 `pendingNotifications` Map,主线 `runQueryLoop` 的 finally(`routes/agent.ts:1353`)里由 `flushPendingSubagentNotifications()` 补发。

DSH(deepseek-harness)的对应机制是 **per-Session inbox 队列 + 三种投递语义**(`core/agent-loop/src/agent.ts:113-132`,`core/agent/src/inbox.ts`)：

| DSH 方法 | 队列 lane | 唤醒 | 语义 |
|---|---|---|---|
| `followup()` | `next-turn` | 是 | 起新 turn |
| `steer()` | `next-step` | 是 | 本 turn 下一步边界注入(可批处理) |
| `inject()` | `next-step` | 否 | 静默入队,等下个边界消费 |

DSH 侧还有 `tool-jobs` 的 `onJobDone` 监听器(`packages/jobs/tool-jobs/src/index.ts:279-300`),用 **wakeBudget(默认 3)** 防止后台反复 settle 时连环唤醒主 Agent。

### zai 现状的差距

| 差距 | 影响 |
|---|---|
| 只有一种投递语义(fire-and-forget 新 turn) | 后台通知**只能**打断主对话;没有「静默入队,等主对话自然收尾」的降级 |
| `pendingNotifications` 只是**终态通知**的暂存,不是通用 inbox | 子 Agent **运行中途**无法 report(只有完成/失败/取消三态);父无法 control(发消息/中断/列举) |
| 没有 wakeBudget | 多个后台任务陆续完成会连环唤醒 |
| 主对话消息由 `routes/agent.ts` 的 `sessionQueues` 串行驱动,通知注入是另一条独立路径(runtime.query 直呼) | 两条路径并存,缺少统一入口;running 守卫逻辑分散在 SubagentNotifier / BashNotifier 两处 |

### 为什么必须同时改 zn-agent-core

子 Agent 的**运行环境在 core**：`AgentTool`(`zn-agent-core/src/opencc-src/tools/AgentTool/runAgent.ts`)用 `createSubagentContext` 构建子上下文(L764)、`query()` 跑循环(L826)。「子 Agent mid-run 主动上报」与「父对子的 control」这两条 DSH 核心通道,**都必须注册在 core 端工具上下文**里。core → server 的通信沿用现有 **globalThis bridge** 范式(`agentTaskBridge.ts`:`__zaiEventBus` / `__zaiBackgroundRuntime` / `__zaiCurrentSessionId`,zai 端注入点 `agentRuntime.ts:75`)。本次新增 bridge 通道投递到 zai 端 inbox。

## 会话模型对照(决定 inbox 放哪一层)

| 维度 | DSH | opencc-web(zai) |
|---|---|---|
| 主会话 | 多 session,每个 Session 独立事件日志 | 多 session,per `sessionId` transcript / 队列 / SSE |
| 子 agent 会话 | **独立 Session**：`child.session.header.parentSession` 指向父(`subagent/continuation.ts:617`) | **复用父 sessionId**：`DefaultBackgroundRuntime.runOne` 用 `query({sessionId: parentSessionId ?? bg-…})`,transcript 走 subdir 侧记(`setAgentTranscriptSubdir`) |
| inbox 归属 | per-Session,durable(从 `agent/inbox/spliced` 事件投影) | 需新建,按 sessionId 组织;zai 无 session 事件日志机制 → **进程内内存队列** |
| 结果回传 | 子 → 父 session 的 inbox(followup/inject) | 同一 sessionId 下注入新 prompt(现) / 入 inbox(本次) |

**结论**：两边都是多会话 server(非单 session);真正的差异是**「子 agent 是否有独立会话」**。本次 inbox 按**主 sessionId** 组织即可对齐 DSH 语义(DSH 的 Session ≈ zai 的主 sessionId);「子 agent 独立会话」是后续增强(见「后续工作」),不入本次范围。

## 目标

1. 引入 **per-session Inbox 队列**,提供 `followup` / `steer` / `inject` 三种投递语义(对齐 DSH `agent-loop`)。
2. 主对话调度入口(`runNextInQueue`)统一消费 **inbox next-turn lane** 与 **HTTP prompt 队列**;后台通知不再直呼 `runtime.query()`。
3. 引入 **wakeBudget(默认 3)** 防后台连环唤醒;用户人工输入 / turn 自然结束重置预算。
4. **core 端新增** `subagent-report` 工具(子 agent mid-run 主动上报,对齐 DSH `tool-subagent-report`)与 `subagent-control` 工具(`send_message` / `interrupt_agent` / `list_agents`,对齐 DSH `tool-subagent-control`)。
5. 删除 `pendingNotifications` / `flushPendingSubagentNotifications()`;`SubagentNotifier` 改为 inbox 投递。

## 非目标

- 不引入 cordis / plugin 框架;沿用 zai module-level 单例 + globalThis bridge 既有风格。
- 不重建 SSE 传输层;`eventBus.emit()` → `/api/event` SSE 全链路原样复用。
- 不做 inbox 磁盘持久化(进程内内存队列;DSH 的 durable inbox 依赖 session 事件日志,zai 没有,留作后续)。
- **不**改造 `BashNotifier`(同构;收敛留作后续)。
- **不**为子 agent 引入独立会话/独立 inbox(复用主 sessionId 模型;若后续要完全对齐 DSH 的「子 agent 独立 Session」,需另立 session 存储与树形 header 关联,范围外)。
- opencc-src 的 `AgentTool / runAgent.ts` 允许以 zai patch 方式修改(仓库 AGENTS.md 明确「opencc-src 允许修改,改后需 build:core」),但**不改动** vendor 的 queryEngine / modelCaller 核心循环。

## 核心决策

| 决策点 | 选择 |
|---|---|
| 分工 | **core 产生/终止消息,server 负责队列与投递**(对齐 DSH capability seam) |
| inbox 形态 | zai server 端 module-level 单例 `SessionInbox`,`Map<sessionId, lane[]>` |
| 投递语义 | `followup`(next-turn+wake)、`steer`(next-step+wake)、`inject`(next-step+no-wake) |
| 唤醒途径 | idle 时唤醒回调驱动 `runNextInQueue(sessionId)`;busy 时消息留在队列等边界 |
| next-step 语义(降级) | vendor `query()` 单 prompt 原子调用 → `inject/steer` 消息在 turn 结束时合并为**一条** next-turn prompt 消费(批处理,对齐 DSH `steer` 合并意图) |
| wakeBudget | per-session,默认 3;超限降级 `inject`;用户人工 prompt / turn 结束重置 |
| 消费优先级 | **HTTP 用户 prompt 优先 > inbox next-turn** |
| running 守卫 | inbox 自身承担缓冲;删 `pendingNotifications` + `flushPendingSubagentNotifications()` |
| core→server 通道 | 新增 `__zaiSessionInbox` globalThis bridge(沿用 `__zaiEventBus` 范式,zai server 注入);report/settle 消息从 core 投递到 zai 端 `SessionInbox` |
| 子 agent control | `send_message` = core 端 `DefaultBackgroundRuntime` 暴露 per-task 消息队列(子 agent 下一轮 query 消费);`interrupt_agent` = 复用 `bg.cancel(taskId)`;`list_agents` = 复用 `bg.list({parentSessionId})` |
| 通知渲染 | 沿用 `renderTaskNotificationMessage()`(`subagentNotifier.ts:177`);report 消息由新工具渲染(与 `<task-notification>` 同风格) |

## 架构设计

### 架构总览

```
┌─ zn-agent-core(子 agent 运行环境)──────────────────────────────────────┐
│  AgentTool / runAgent.ts                                                │
│    createSubagentContext(L764) + allTools 合并(L714-737)               │
│      └─ 注册 subagent-report 工具(子 agent mid-run 上报)                │
│  DefaultBackgroundRuntime(compat/background)                            │
│    dispatch / attach / appendTaskEvent / finalizeTask                   │
│    └─ 新增 sendMessageToTask(taskId, prompt) ← subagent-control 工具     │
│  agentTaskBridge  ──── 既有 globalThis bridge 范式                      │
│    __zaiEventBus / __zaiBackgroundRuntime / __zaiCurrentSessionId       │
│    + 新增 __zaiSessionInbox(followup / inject / steer 投递)             │
└───────────────┬────────────────────────────────────────────────────────┘
                │ report / settle 消息
┌───────────────▼────────────────────────────────────────────────────────┐
│  zai server(主对话调度)                                                  │
│                                                                         │
│  services/sessionInbox.ts  ★新建                                        │
│    SessionInbox(nextTurnQ / nextStepQ / wakeBudget / busy)              │
│      followup / steer / inject / consumeNextTurn / consumeNextStep      │
│      setBusy / clearRunning / resetWakeBudget / setWakeHandler          │
│         ▲                                      │ wake( idle 时)         │
│  SubagentNotifier.handle ──followup(parent)────┘                        │
│  (同 receive __zaiSessionInbox 投递)                                     │
│                                                                         │
│  routes/agent.ts                                                        │
│    runNextInQueue: HTTP queue 优先 > inbox next-turn                    │
│    finally: consumeNextStep → 合并为下一条 prompt                        │
│    runQueryLoop → translateRuntimeEvents → eventBus.emit → SSE           │
└──────────────────────────────────────────────────────────────────────────┘
```

### SessionInbox 接口(`zai/src/server/services/sessionInbox.ts`)

```ts
/** 投递语义:对齐 DSH agent-loop 的 followup / inject(steer = wakeup + next-step)。 */
export type InboxDelivery = 'wakeup' | 'quiet'

export interface InboxMessage {
  id: string
  source: { kind: string; form: string; senderSessionId?: string; agentType?: string; [k: string]: unknown }
  content: string            // 渲染后的完整 user prompt
  createdAt: number
}

interface InboxWakeHandler { (sessionId: string): void }

export class SessionInbox {
  setWakeHandler(handler: InboxWakeHandler): void
  followup(sessionId: string, msg: InboxMessage): void   // next-turn + wake(预算内)
  steer(sessionId: string, msg: InboxMessage): void      // next-step + wake(预算内)
  inject(sessionId: string, msg: InboxMessage): void     // next-step + no-wake
  consumeNextTurn(sessionId: string): InboxMessage | null
  consumeNextStep(sessionId: string): InboxMessage[]
  peekNextTurnCount(sessionId: string): number
  isBusy(sessionId: string): boolean
  setBusy(sessionId: string): void
  clearRunning(sessionId: string): void                   // 清 busy + 重置预算
  resetWakeBudget(sessionId: string): void                // 用户人工 prompt 时调用
}
export const sessionInbox = new SessionInbox()
```

投递语义代码与 rev 1 一致:`followup`(busy / 超预算降级 next-step)、`steer`(next-step + wake)、`inject`(next-step 无唤醒),见 plan Task 4。

### core 端新增:subagent-report 工具

**位置**:`zn-agent-core/src/compat/tools/opencc/subagentReport.ts`(compat 层新增,由 zai 的 `openccToolDefaults` 挂进 AgentTool 子上下文 or 直接在 `runAgent.ts` 的 allTools 合并点注册——实现时选更稳的注册点,以 `openccToolDefaults.ts` 现有工具清单结构为准)。

```ts
// 语义对齐 DSH tool-subagent-report(continuation.ts deliverReport L630-653)
defineTool({
  name: 'subagent_report',
  description: '子 agent 主动向父 agent 上报进度或移交结果。',
  parameters: {
    output: { type: 'string', required: true, description: '上报内容(文本)。' },
    delivery: { type: 'string', enum: ['wakeup', 'quiet'], default: 'wakeup' },
  },
  execute({ output, delivery }, context) {
    const parentSessionId = /* 从子上下文取 parentSessionId(复用 __zaiCurrentSessionId fallback 链) */
    deliverViaInboxBridge(parentSessionId, output, delivery)  // → __zaiSessionInbox.followup/inject
    return { delivered: true }
  },
})
```

执行时通过新 bridge `__zaiSessionInbox`(zai server 注入,zai 端绑定到 `sessionInbox.followup/inject`)投递;无 bridge(纯 core 单测)时静默 no-op(对齐 agentTaskBridge 的 `tryGetBg` 回退风格)。

### core 端新增:subagent-control 工具

**位置**:`zn-agent-core/src/compat/tools/opencc/subagentControl.ts`,注册到**主对话**工具上下文(父 agent 视角)。

| 子工具 | 语义 | 实现 |
|---|---|---|
| `send_message` | 向后台子 agent 发消息,作为其**下一轮**输入 | `DefaultBackgroundRuntime.sendMessageToTask(taskId, prompt)`(新增);子 agent 下一轮 `runOne`(或 attach 路径下一轮)消费。对齐 DSH `tool-subagent-control.send_message`(进子 agent 的 FIFO,不等待) |
| `interrupt_agent` | 中止子 agent 当前轮 | 复用 `bg.cancel(taskId)`;幂等(已终态 no-op) |
| `list_agents` | 列举后台子 agent | 复用 `bg.list({ parentSessionId })` |

### core 端扩展:DefaultBackgroundRuntime.sendMessageToTask

`zn-agent-core/src/compat/background/DefaultBackgroundRuntime.ts` 新增 per-task pending prompt 队列(`MessageId[]`);子 agent 下一轮 query 开始时合成到 prompt 前缀。持久化落 store(可选:先内存,后续随 inbox 持久化一并做)。

### runNextInQueue 改造(`routes/agent.ts:781`)

同 rev 1:消费顺序 **HTTP 用户 prompt > inbox next-turn**;finally `clearRunning` + `consumeNextStep` 合并为下一条 prompt;用户人工入队时 `resetWakeBudget`。删除 `flushPendingSubagentNotifications` 调用(`routes/agent.ts:1353`)与 import(L36)。详细代码在 plan Task 6。

### SubagentNotifier 改造(`server/services/subagentNotifier.ts`)

`handle()` 改为构造 `InboxMessage` → `sessionInbox.followup(parentSessionId, msg)`;删除 `pendingNotifications` / `inject()` / `flushPendingSubagentNotifications` / `__resetSubagentNotifierPendingForTests`。SSE 推送由主对话 `runQueryLoop` 走既有 `translateRuntimeEvents` → `eventBus.emit()` 链路自动完成(与 rev 1 一致,plan Task 5)。

## 数据流(完整链路)

```
【终态 通知】(现有,改为 inbox 投递)
子 agent 终态 → DefaultBackgroundRuntime.notifyChange
  → SubagentNotifier.handle(task) → sessionInbox.followup(parentSessionId, msg)
  → 父 idle + 预算内 → wakeHandler → runNextInQueue → consumeNextTurn → runQueryLoop
  → runtime.query(prompt=<task-notification>) → translateRuntimeEvents → eventBus → SSE → 前端

【mid-run report】(新增,core 端)
子 agent 运行中调 subagent_report(output, delivery)
  → core bridge __zaiSessionInbox → zai sessionInbox.followup/inject(parentSessionId, msg)
  → 同上消费 → 主对话收到报告并继续

【父 → 子 control】(新增,core 端)
主对话调 subagent_control(send_message)
  → bg.sendMessageToTask(taskId, prompt) → 子 agent 下一轮消费
```

## 并发守卫与边界(防"并行 turn 事件风暴")

**设计目标**：同一 session 在同一时间**只允许一个主对话 turn 运行**。并行 turn 会导致两个 query 并发写同一转录、工具重复执行、请求叠加触发 429 风暴(HRMSV3-ZN-WEBSITE#668 同类问题)。本方案的所有投递入口统一收敛到 `runNextInQueue` 单消费者通道,由一组守卫共同保证。

守卫链：

```
任意投递入口(followup / steer / inject / HTTP /api/agent/prompt enqueue)
      ▼
runNextInQueue(sid)
  ├─ if (sessionRunning.has(sid)) return      ← ① 单消费者守卫
  ├─ sessionRunning.add(sid) + setBusy(sid)   ← 同步段(add 与首个 await 之间无间隙)
  ├─ await runQueryLoop(cmd)                  ← 第一个 await 在 add 之后
  └─ finally: delete(sid) + clearRunning(sid)
              + consumeNextStep → enqueueInboxPrompt → void runNextInQueue(sid)
```

| 守卫 | 位置 | 作用 |
|---|---|---|
| `sessionRunning.has / add / delete`(Set) | `routes/agent.ts` `runNextInQueue` 入口与 finally | **单消费者**;并发触发(多个 followup 同时到、wake 与 HTTP enqueue 竞争)只有一个 turn 通过 |
| 同步段原子性 | `add` 与首个 `await` 之间无异步间隙 | JS 单线程下,同一 tick 的第二次调用 `has(sid)` 已为 true → return(对齐现有 `agent.ts:1441-1443` 注释「入队与启动判定在同一同步块内完成」) |
| `isBusy / setBusy / clearRunning` | `runNextInQueue` 包住整个 turn;finally 清理 | busy 期间 followup/steer 降级入 next-step 队列,不直呼 runtime;turn 结束后下一条串行消费 |
| `wakeBudget`(默认 3) | `SessionInbox.wakeIfBudgeted` | 防「完成 → 新 turn → 再派发 → 再完成」循环唤醒风暴;用户人工输入 / turn 自然结束经 `resetWakeBudget` / `clearRunning` 恢复 |
| 通知注入统一走 inbox | `SubagentNotifier` / `subagent_report` → `sessionInbox` → `runNextInQueue` | **取消** `SubagentNotifier.inject()` 直呼 `runtime.query()` 的旁路路径,通知与主线共用同一守卫 |

**已知边界(现状既有,非本次引入)**:

- **子 agent 后台 query 与父共享 sessionId**:`DefaultBackgroundRuntime.runOne` 的 `queryInput.sessionId = rec.task.parentSessionId ?? \`bg-…\``,`maxConcurrent=10` 时同一 sessionId 上可能并行多个 background query,它们**不经过** `runNextInQueue` 守卫。即「主对话 turn 守卫」与「后台 query 并发面」是两回事 —— 完整的根除方案是给子 agent 独立 sessionId(见「后续工作」),本次明确声明该边界。
- **BashNotifier 仍直呼 query 注入父 session**:靠自身 `hasActiveQuery` 守卫,不在 inbox 守卫内;列入「后续工作」收敛。

## 错误处理

| 场景 | 行为 |
|---|---|
| inbox 消费时 session 已销毁 / cwd 失效 | `runQueryLoop` 现有错误路径兜底;inbox 消息丢弃该条,不重入 |
| wakeHandler 抛异常 | `SessionInbox` 内 try/catch + console.warn,不让后台回调弄崩 server |
| 同 session 重复 followup | 各自入队,逐个串行消费(单消费者 `sessionRunning`);wakeBudget 超限后静默入队等用户输入 |
| 用户人工 prompt 与 inbox 消息同时到来 | HTTP 优先;inbox next-turn 保持,下一轮消费 |
| 无 bridge(纯 core 单测 / vendor CLI 直接跑) | `subagent_report` / `subagent-control` 走 no-op / 模块 registry 回退(对齐 agentTaskBridge `tryGetBg`) |
| `send_message` 目标 task 不存在或已终态 | return `{ ok: false, reason }` 而非抛错(对齐 DSH control 幂等语义) |

## 测试计划

| 测试文件 | 覆盖 |
|---|---|
| `zai/src/server/services/sessionInbox.test.ts`(新增) | followup/steer/inject 语义;busy 降级;wakeBudget 预算;消费合并;跨 session 隔离 |
| `zai/src/server/services/subagentNotifier.test.ts`(改) | handle() 走 inbox;删 flush 后通知仍到达(via inbox) |
| `zai/src/server/routes/agent.queue.test.ts`(改/增) | runNextInQueue 双队列消费顺序;inbox 消息 → SSE runtime.* 流;**并发触发(两次 followup / wake 与 HTTP 竞争)只起单 turn,runtime.started 至多一次** |
| `core/test/unit/compat/subagentReport.test.ts`(新增) | report 工具 schema;delivery 路由(wakeup→followup,quiet→inject);无 bridge no-op |
| `core/test/unit/compat/subagentControl.test.ts`(新增) | send_message 入队;interrupt 幂等;list 过滤 |
| `core/test/unit/compat/background/sendMessageToTask.test.ts`(新增) | 消息排队;子 agent 下一轮消费;终态后 no-op |

## 后续工作(本次不实施)

- **子 agent 独立会话**(对齐 DSH 的多 session 树):独立 sessionId + `parentSession` header 关联 + 独立 inbox。需要重建 session 存储与 UI 关联,范围大,单独立项。
- **inbox durable 持久化**:依赖 session 事件日志机制(zai 现无),先建事件日志再投影 inbox。
- **BashNotifier 收敛**:同构重构,走 inbox。

## 自审 checklist

- [x] 三种投递语义对齐 DSH `agent-loop`(followup/steer/inject)
- [x] wakeBudget 防连环唤醒,默认 3,用户输入重置
- [x] core 端 report / control 工具(DSH `tool-subagent-report` / `tool-subagent-control` 对齐)
- [x] core→server 走既有 globalThis bridge 范式(新增 `__zaiSessionInbox`)
- [x] 删除 `pendingNotifications` / `flushPendingSubagentNotifications`(inbox 承担缓冲)
- [x] 主对话消费入口唯一化(`runNextInQueue` 收敛 HTTP + inbox 两路)
- [x] 不改变 `renderTaskNotificationMessage` 输出格式(LLM 可见文本稳定)
- [x] **并发守卫**:同一 session 主对话 turn 单消费者(`sessionRunning` 入口 has + 同步段原子性 + busy 降级 + wakeBudget);通知注入统一走 inbox,取消直呼 `runtime.query()` 旁路
- [x] **守卫边界声明**:子 agent 后台 query 与父共享 sessionId(`maxConcurrent=10` 可并行),不经过 runNextInQueue —— 现状既有,根除方案(独立子会话)列入「后续工作」
- [x] 明确会话模型:多 session(per sessionId);子 agent 暂不引入独立会话
- [x] 错误边界:后台回调异常不崩 server;无 bridge 环境 no-op 回退

## 范围外

- 多进程/多实例 inbox 同步(单进程单 server 模型)。
- 子 agent 独立会话与独立 inbox(见「后续工作」)。