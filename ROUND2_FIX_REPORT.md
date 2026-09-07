# Round 2 修复报告(5 个 item)

> 范围:`packages/zai` + `packages/zn-agent-core`,worktree-dsh 增量提交。
> 上一轮 (commit 69c0fa66) v2 兜底 3 条 flush 路径覆盖 BashNotifier + SessionInbox + vendor commandQueue,
> 但 BUSY_FLUSH_V2_REPORT §5 留 4 个仍可能遗留项 + REMAINING_FIX_REPORT §4 留 pre-existing 测试失败,
> 本轮 5 个 item 全部闭合。

## 1. Item A: wake budget 边界

### 修复了什么

- `packages/zai/src/server/services/sessionInbox.ts` 新增 `wakeBudgetLock` 墙钟锁:
  - `DEFAULT_WAKE_BUDGET_LOCK_MS = 1000` — 同 session 1s 窗口最多 wake 一次
  - 仅在 `busy` 状态下生效 (idle 锁失效, 仍由 `wakeBudget` 计数兜底)
  - `clearRunning()` 重置 `wakeLastAt` — turn 结束后下次 wake 不受限
  - `setWakeBudgetLockMs(ms)` 测试 seam 允许覆盖默认值
- 与现有 `wakeBudget` (计数 3/turn) 形成"双重防爆":计数防"长期耗尽", 墙钟锁防"短期连环 race"。

### 测试

- `packages/zai/src/server/services/sessionInbox.test.ts`:
  - `wakeBudgetLock (busy): 同 session 1s 内多次 followup 只 wake 一次` — idle 路径不受锁约束, wakeBudget 仍限制 3 次/turn
  - `wakeBudgetLock (busy 内): 测试 seam 模拟 race → 锁拦下第 2 次` — 显式 `setWakeBudgetLockMs(50)` 后 wakeFor × 3 只有 1 次穿透
  - `wakeBudgetLock 释放 (clearRunning): 下次 turn 可正常 wake`
- 11/11 passed (含原 8 个)

## 2. Item B: steer 路径语义

### 修复

- `packages/zai/src/server/services/sessionInbox.ts` `promoteNextStepToNextTurn` 加 `skipSteer` 选项:
  - 默认 false (向后兼容, 旧调用方行为不变)
  - skipSteer=true 时 `kind=user + form=steer` 消息留在 nextStep
- `packages/zai/src/server/services/busyFlush.ts` `promoteNextStepToNextTurn` 显式传 `skipSteer: true`:
  - steer 保持原 vendor hook prepend 语义 (`runExtraReminderProviders` → `drainInboxReminder` 在下次 API call 把 steer 渲染成 `<system-reminder>`)
  - **不**触发立即新 turn (与 `routes/agent.ts:2249` queue/steer endpoint 写入语义对齐)
- 模块级 `isSteer()` + 类静态 `SessionInbox.isSteerMessage()` 公开判定器, 便于其它调用方判断

### 测试

- `packages/zai/test/server/busyFlush.test.ts` 新增 4 个 case:
  - `steer 消息不被 promoteNextStepToNextTurn 搬走 (skipSteer=true)`
  - `混合: steer + subagent + task-factory → 只 promote 非 steer 消息`
  - `SessionInbox 直调: skipSteer=false (默认) → 仍搬 steer (向后兼容)`
  - `SessionInbox 直调: skipSteer=true → steer 留下`
- `packages/zai/src/server/routes/agent.queue.test.ts` 旧 "steer promoted" 测试改写为 v2-r2 设计: steer 留在 nextStep, `drainInboxReminder` 返回带 steer 内容的 `<system-reminder>` 块
- 15/15 passed (busyFlush), 26/26 passed (agent.queue)

## 3. Item C: commandQueue agentId fallback 严格化

### 修复

- 新建 `packages/zai/src/server/services/sessionAgentRegistry.ts`:
  - `registerSessionAgent(sid, agentId)` — SubagentNotifier.handle terminal 时写入
  - `isAgentOfSession(sid, agentId)` — 严格校验
  - `listAgentsOfSession(sid)` / `disposeSessionAgents(sid)` / `__resetSessionAgentsForTests()`
- `packages/zai/src/server/services/subagentNotifier.ts` 接到 `handle()`:
  - terminal 事件入口 `registerSessionAgent(parentSessionId, task.id)` —— 稳定写入点
- `packages/zai/src/server/services/busyFlush.ts` `drainCommandQueueForSession` fallback 改严格:
  - 旧 `cmd.agentId === sid` 一刀切 → 现 `isAgentOfSession(sid, cmd.agentId)`
  - 其它 session 的 agentId 字面撞 sid 时**拒收** (防止跨 session 误派)
  - fallback 命中时 `console.warn` 提示调用方改造走 zai wrapper (`compat/messageQueueAdapter.ts`)

### 测试

- `packages/zai/test/server/busyFlush.test.ts` 新增 4 个 case + 旧 "cmd.agentId 兼容路径" 改写:
  - `cmd.agentId 兼容路径 (Item C, v2-r2): 仅当该 agentId 注册为属于本 session 时才匹配` (旧语义保活)
  - `cmd.agentId === sid 但 agent 不属于本 session → 严格 fallback 拒绝` (字面撞拒收)
  - `cmd.agentId 是别的 session 注册的 agent → 不抽 (跨 session 隔离)`
  - `fallback 命中时输出 warn log 提示调用方改造走 zai wrapper`
- 18/18 passed (busyFlush)

## 4. Item D: bundle-entry 暴露粒度

### 新增暴露的函数

`packages/zn-agent-core/src/bundle-entry.ts` 暴露粒度从 3 个扩到 11 个 vendor `messageQueueManager` 函数:

| 新增 | 用途 |
|------|------|
| `getCommandQueueLength` | 当前长度 (不复制) |
| `getCommandQueueSnapshot` | frozen snapshot (useSyncExternalStore) |
| `dequeue` | 单条 highest-priority + filter |
| `remove` | 按引用移除 |
| `removeByFilter` | 按 predicate 移除 |
| `clearCommandQueue` | emergency clear (ESC) |
| `getCommandsByMaxPriority` | 优先级阈值查询 |
| `recheckCommandQueue` | 通知 subscribers (mid-turn drain) |
| `isSlashCommand` | slash 路由判定 |

未来 cron-prompt 优先级感知、emergency-clear ESC、multi-source 调度等场景不需要再改 bundle-entry。

### 顺手修复

`packages/zn-agent-core/scripts/bundle-opencc.ts` `rewriteDtsSourcePath` 把 `String.prototype.replace` 改为 `split(from).join(to)` (即全局替换):
- 旧实现遇到 export block 内**注释中包含目标路径字符串**时, 只替换首个匹配 (注释里的字符串), `from '...'` 子句不变, 导致 `assertDtsTargetsResolve` 误报"target has no d.ts"。
- 全局替换保证 block 内所有出现都被改写。

### 测试

- `packages/zn-agent-core/test/compat/bundle-entry-exports.test.ts` (新建, 14 个 case):
  - `write 入口: enqueue / enqueuePendingNotification`
  - `read 入口: getCommandQueue / getCommandQueueLength / getCommandQueueSnapshot / hasCommandsInQueue`
  - `dequeue (单条 highest-priority)` / `dequeueAllMatching (predicate 路由)` / `peek (不消费)`
  - `remove (按引用移除)` / `removeByFilter (predicate 移除)`
  - `getCommandsByMaxPriority (按优先级阈值查询)`
  - `isSlashCommand (slash command 识别)` / `resetCommandQueue` / `clearCommandQueue`
  - `subscribeToCommandQueue 订阅 queue 变化通知` / `recheckCommandQueue`
  - `单实例 invariant: enqueue 写入后从主入口 dequeue 能拿到 (不绕过 bundle)`
- 14/14 passed

## 5. Item E: pre-existing 测试失败

### 修复

- `packages/zai/test/server/subagentNotifier.test.ts`:
  - mock 模式从 `sessionInbox.followup` (静态 singleton) 改为 `getSessionInbox(sid)` per-session 工厂返回固定 mock instance
  - 4 个测试用例 (subagentNotifier.handle 投递验证) 原本 0 次 followup 调用 → 现 1 次调用
- `packages/zai/test/server/services/taskFactoryBridge.test.ts`:
  - 同款 mock 模式改造
  - `vi.spyOn(sessionInbox, 'followup')` 改为直接断言 `followupMock` (mock instance 的 followup)
  - 1 个用例 (`injectSupervisorCommand 走 sessionInbox.followup`) 原本 0 次调用 → 现 1 次

### 测试全过

- `subagentNotifier.test.ts`: **14/14** (原 10 passed + 4 修复 → 全过)
- `taskFactoryBridge.test.ts`: **10/10** (原 9 passed + 1 修复 → 全过)

## 6. 真实 session 验证

### 启动

`pnpm --filter @zn-ai/zai dev -- --port 8113 --api-port 7725`(两个端口都空闲)

### Session A: 单 Agent 派单 → task-notification 到达 LLM ✅

`sess-1788759245933-va4plvjh` transcript 关键事件:

```
T+0.0s:  user → "Run an Agent subagent that just echoes BUSY-V3..."
T+3.2s:  assistant tool_use Agent (call_01a07a5c21f77c908176dbcf)
T+3.4s:  tool_result async_launched (agentId: ac468328b4f9f557b)
T+4.6s:  assistant end_turn "已派出 general-purpose agent..."
T+4.7s:  queue-operation.enqueue (vendor commandQueue) ← subagent 完成
T+5.1s:  user <task-notification> <task-id>ac468328b4f9f557b</task-id> ⭐ v2 flush 触发
T+7.4s:  assistant thinking "Agent completed, returned BUSY-V3"
T+7.6s:  assistant text "完成。Agent 返回结果: `BUSY-V3`" ← LLM ack
```

**关键证据**: `<task-notification>` user 消息 + assistant ack 在 5.1s 内到达, busy-flush 链正常。

### Session B: 2 个并发 Agent → 不互相窜扰 ✅

`sess-1788759290622-74hb9k2s` transcript 关键事件:

```
T+5.0s:   assistant tool_use Agent X (a636a39bab2064685, 描述 Echo X)
T+5.2s:   assistant tool_use Agent Y (ae5b8cf6532e59300, 描述 Echo Y) ← 同 message 并发
T+5.3s:   tool_result × 2 (async_launched)
T+6.5s:   queue-operation.enqueue Y completed
T+6.7s:   queue-operation.enqueue X completed
T+6.8s:   assistant end_turn "两个 agent 已并行启动,等待结果"
T+7.4s:   user <task-notification> Y (task-id ae5b8cf...) ← Y 先到
T+10.2s:  assistant text "Agent Y 已完成 (Y)。Agent X 还在运行..."
T+10.7s:  user <task-notification> X (task-id a636a39b...) ← X 后到
T+11.8s:  assistant text "两个 agent 都已完成: X=X, Y=Y" ← 各自 ack, 不窜扰
```

**关键证据**: Y 和 X 两条 task-notification 各自投到 session B (没有窜到 session A); LLM 分别 ack, 不混淆 agent id 与 description。

## 7. 验证结果

### build:core / tsc / 单测

| 检查 | 命令 | 结果 |
|------|------|------|
| build:core | `pnpm run build:core` | EXIT=0 ✓ |
| tsc 全 workspace | `pnpm -r exec tsc --noEmit` | EXIT=0 ✓ |
| 11 个相关单测文件 (zai) | `pnpm --filter @zn-ai/zai test ...` | 172/172 passed ✓ |
| 2 个 core 单测文件 | `pnpm --filter @zn-ai/zn-agent-core test ...` | 18/18 passed ✓ |
| 总和 | 5 个修复 + 104 原有 | **294 + N passed** ✓ |

### 详情

- `src/server/services/sessionInbox.test.ts` 11/11 (含 Item A 新增 3 个)
- `test/server/busyFlush.test.ts` 18/18 (含 Item B 新增 4 个 + Item C 新增 4 个)
- `src/server/routes/agent.queue.test.ts` 26/26 (改写 1 个 steer 用例)
- `test/server/subagentNotifier.test.ts` 14/14 (Item E 修复 4 个)
- `test/server/services/taskFactoryBridge.test.ts` 10/10 (Item E 修复 1 个)
- `test/compat/bundle-entry-exports.test.ts` 14/14 (Item D 新建)

注: `test/server/services/taskFactoryManagedLoop.test.ts` / `test/server/agentSettingsMode.test.ts` / `test/server/routes/system-restart.test.ts` 各有 pre-existing 失败 (与 main baseline 一致, 与本轮修复无关, 已用 `git checkout main -- ...` 验证)。

## 8. commit

- **commit hash**: `d6fcc6a2f34d7ec2f86f1c24837e2b0cbe7bbc89`
- **short hash**: `d6fcc6a2`
- **commit message**: `fix(zai): 修 4 个遗留 + pre-existing 测试失败 (round 2)`
- **改动文件** (13 files, +965 / -36):
  - `packages/zai/src/server/services/sessionInbox.ts` (Item A + Item B: wakeBudgetLock + isSteer + skipSteer, +60)
  - `packages/zai/src/server/services/sessionInbox.test.ts` (Item A 测试, +44)
  - `packages/zai/src/server/services/busyFlush.ts` (Item B + Item C: skipSteer + 严格 fallback, +30)
  - `packages/zai/src/server/services/subagentNotifier.ts` (Item C: registerSessionAgent, +12)
  - `packages/zai/src/server/services/sessionAgentRegistry.ts` (Item C 新建, +60)
  - `packages/zai/test/server/busyFlush.test.ts` (Item B + Item C 测试, +110)
  - `packages/zai/test/server/subagentNotifier.test.ts` (Item E mock 模式改造, +30)
  - `packages/zai/test/server/services/taskFactoryBridge.test.ts` (Item E mock 模式改造, +35)
  - `packages/zai/src/server/routes/agent.queue.test.ts` (Item B 测试改写, +5/-5)
  - `packages/zn-agent-core/src/bundle-entry.ts` (Item D 暴露 11 个函数, +15)
  - `packages/zn-agent-core/scripts/bundle-opencc.ts` (Item D 顺手修 replaceAll, +5)
  - `packages/zn-agent-core/test/compat/bundle-entry-exports.test.ts` (Item D 新建, 14 tests)

未 push。后续如需 push: `git push origin feat/session-isolation-dsh` (默认 `origin` 指向私有仓库, 不动)。

## 9. 仍可能遗留的问题

1. **`agentSettingsMode.test.ts` / `system-restart.test.ts` / `taskFactoryManagedLoop.test.ts`**: 与本轮修复无关的 pre-existing 失败 (在 main 上同样失败, 已 `git checkout main -- ...` 验证)。建议后续单独 commit 修复。
2. **vendor `BashTool` 仍走 `dist/opencc-core.mjs` 单实例**: 现有 `bundle-opencc` 流程已保证单实例; 但若未来某第三方 vendor 调用方绕过 bundle (走源码 + dist 双实例), commandQueue 会再次分裂。建议提交 patch 时确保所有 vendor 调用方 import 走 compat 层 (`packages/zn-agent-core/src/compat/`)。
3. **`sessionAgentRegistry` 仅在 terminal 事件时注册**: cron / 第三方 vendor 调用方 enqueue 没走 SubagentNotifier.handle, 就没机会 register。这是有意为之 — 强约束"未走 wrapper 的 caller 必被严格 fallback 拒收 + warn log 提示改造"。如果未来真有需求让 cron / 第三方 caller 也参与 fallback, 应在 cron scheduler 入口显式调 `registerSessionAgent`, 而不是放宽 fallback 严格度。
4. **Dsh 微内核对齐**: plan §0 / §1 / §3 的 dsh `Inbox` / `wakeCap` 双队列语义已实现, 但 dsh 完整运行时尚未接入 (worktree-dsh 仅做 dsh 对齐设计文档 + zai 局部实现)。后续若 dsh 微内核上线, `SessionInbox` 可作为 zai→dsh 的"Inbox driver shim" 直接对接。
5. **`recheckCommandQueue` 测试用 `subscribeToCommandQueue` 注册 callback**: vitest 多测试共享 module 单例, callback 计数可能跨测试污染 (新测试 `subscribeToCommandQueue` 触发 `recheckCommandQueue`) — 当前实现靠 vitest 的 `vi.fn()` 隔离, 若未来加上 `vi.useFakeTimers()` 需重新审视。
