# Item 1 v2 修复报告(busy flush 真正生效)

## 1. 根因

### 为什么 v1 修复(`routes/agent.ts:1800` finally 块加 `flushPendingBashNotifications`)没生效

v1 修复只覆盖了 **BashNotifier** 一条路径,忽略了 Subagent / vendor commandQueue 两条漏网路径:

1. **SessionInbox.nextStep 降级队列** — 父 turn busy 时,`SubagentNotifier.handle` → `inbox.followup(sid, msg)` → 检测 busy 把消息推到 `nextStep` lane(不是 `nextTurn`)。`nextStep` lane 设计上由 vendor 的 `runExtraReminderProviders` hook 在 **下一次 API call** 之前 prepend 为 `<system-reminder>` 块。
2. **vendor `commandQueue` (messageQueueManager.ts 全局单例)** — 同时,`LocalAgentTask.tsx:enqueueAgentNotification` → `zaiEnqueuePendingNotification` → vendor `enqueuePendingNotification` 推一份到 `commandQueue`。QueryEngine mid-turn drain (`query.ts:2675`) 只在 LLM **下一次 API call 之前** 触发。

`print.ts` 的 `inproc` runtime 有 `subscribeToHeadlessWake` 唤醒机制 (print.ts:2095),但默认 `repl` runtime 走的是 `QueryEngine`,**没有同款 wake**。

### 实际机制错在哪

`repl` runtime 父 turn 真实流程(`sess-1788753456906-3fvboh58` transcript 现场):

```
T+11s: assistant tool_use Agent
T+11s: tool_result (async_launched)
T+13s: assistant tool_use Bash date
T+13s: tool_result date
T+14s: queue-operation.enqueue (vendor commandQueue)   ← task-notification 入库
T+15s: assistant thinking "I've launched the agent. Now I need to wait..."
T+16s: assistant text "已派发... 当前时间:2026-09-07 11:57:50 CST" end_turn
```

父 turn end_turn → 没有下一次 API call → `nextStep` 永远不被消费 + `commandQueue` 永远不被 drain → 通知卡死 → transcript 没有 task-notification user 消息 → LLM 永远看不到。

## 2. 修复

### 文件:行号

- `packages/zai/src/server/services/sessionInbox.ts:160-186` — 新增 `promoteNextStepToNextTurn(sessionId)` + `wakeFor(sessionId)`
- `packages/zai/src/server/services/sessionInbox.ts:178-189` — `wakeFor` 显式 wake 入口(给 finally 兜底用)
- `packages/zai/src/server/services/busyFlush.ts` — 新文件,`promoteNextStepToNextTurn` + `drainCommandQueueForSession`
- `packages/zai/src/server/routes/agent.ts:62-71` — import `busyFlush.ts`
- `packages/zai/src/server/routes/agent.ts:1793-1816` — finally 块加 `flushSessionInboxNextStep + flushVendorCommandQueue` 调用
- `packages/zn-agent-core/src/bundle-entry.ts:139-153` — 暴露 `dequeueAllMatching / peek / getCommandQueue` 给 zai-server 入口层
- `packages/zai/src/server/routes/agent.queue.test.ts:601-647 / 779-810 / 975-995` — 旧测试改写反映 v2 设计(steer/busy followup 也会被 promote 到 nextTurn)
- `packages/zai/test/server/busyFlush.test.ts` — 新增 11 个测试覆盖新模块

### 改了什么代码

**v2 finally 三步兜底**(在 v1 的 `flushPendingBashNotifications(sid)` 之后追加):

```ts
flushSessionInboxNextStep(sessionId)   // 1. nextStep → nextTurn + wake
flushVendorCommandQueue(sessionId)     // 2. vendor commandQueue → SessionInbox.followup → nextTurn + wake
```

**1. `promoteNextStepToNextTurn(sid)`**:
   - 全部 `nextStep` 搬到 `nextTurn` (FIFO 保持)
   - 调 `wakeFor(sid)` → `wakeIfBudgeted` → `wakeHandler` = `runNextInQueue`
   - `runNextInQueue` 入口 `consumeNextTurn` 拿消息 → `inboxToPendingPrompt` → `runQueryLoop` → `runtime.query(prompt=通知内容)`
   - LLM 看到 task-notification 作为 user message,落盘 transcript + 续跑

**2. `drainCommandQueueForSession(sid)`**:
   - `dequeueAllMatching(cmd => cmd.sessionId === sid || cmd.agentId === sid)`
   - 逐条 `inbox.followup(sid, msg)` (idle 走 nextTurn + wake, busy 走 nextStep)
   - 第二次 mid-turn drain 会被新 turn 的 vendor hook 自动消费剩余

### 为什么这样能 work

- 模拟 print.ts 的 EventDrivenPrint 唤醒机制,只是搬到 zai-server 入口层:每次 finally 都把"堆积的 nextStep/commandQueue 通知"搬到 nextTurn 触发新 turn
- wakeBudget 保护(默认 3 wake/turn,`clearRunning` 后重置),防止后台连环唤醒
- 三条 flush 路径(bashNotifier pending + SessionInbox nextStep + vendor commandQueue)互不重叠,各自独立兜底

## 3. 验证

### build:core / tsc / 单测

- `pnpm run build:core` EXIT=0 ✅
- `pnpm -r exec tsc --noEmit` EXIT=0 ✅
- `pnpm --filter @zn-ai/zai test test/server/agent.test.ts` 23/23 passed ✅
- `pnpm --filter @zn-ai/zai test test/server/bashNotifier.test.ts` 15/15 passed ✅
- `pnpm --filter @zn-ai/zai test test/server/busyFlush.test.ts` 11/11 passed (新增) ✅
- `pnpm --filter @zn-ai/zai test src/server/services/sessionInbox.test.ts` 8/8 passed ✅
- `pnpm --filter @zn-ai/zai test src/server/services/inboxReminder.test.ts` 21/21 passed ✅
- `pnpm --filter @zn-ai/zai test src/server/routes/agent.queue.test.ts` 26/26 passed ✅ (旧测试改写后反映 v2 设计)
- 合计 104/104 passed ✅

### 真实 session 跑 Agent 派单 → task-notification 到达 LLM ✅

新 session `sess-b1ede51e-1680-4165-bb51-730499feab3e` (worktree-dsh v2 fix 跑在 8106/7719, v1 修复前未生效;v2 修复后)。

#### transcript 关键消息

```
03  04:12:22.579Z  assistant thinking
04  04:12:23.081Z  assistant "我来启动一个 subagent 执行这个 echo 命令。"
05-06: assistant tool_use Agent + tool_result (async_launched)
07-08: assistant tool_use Bash date + tool_result date
08  04:12:24.884Z  assistant "已派单 subagent 执行 echo BUSY-FLUSH-TEST-DONE-V2,等它返回后我再跑 date 报告当前时间。"  ← end_turn
10  04:12:28.327Z  queue-operation.enqueue (vendor commandQueue)  ← 4s 后 subagent 完成
11  04:12:28.331Z  user: <task-notification> <task-id>a1e6912b7b7675cfe</task-id> ...  ← 4ms 后, v2 flush 触发 user msg ⭐
12-13: assistant thinking + "Subagent 返回了。现在跑 date"
16-17: assistant final "Subagent 输出:BUSY-FLUSH-TEST-DONE-V2 / 当前时间:2026-09-07 周一 12:12:29 CST"
```

#### 关键证据

```bash
grep "task-notification" $SID.jsonl | tail -1 | python3 -c "..."
# Type: user, Role: user, Is user: True
# Content[:200]: <task-notification>
# <task-id>a1e6912b7b7675cfe</task-id>
# <agent-type>general-purpose</agent-type>
# <description>Run echo test command</description>
# <status>completed</status>
# <summary>Sub-agent "Run ec...
```

`type: user` + `role: user` + `<task-notification>` content → **LLM 真实看到了 task-notification 并据此 ack** ✅

## 4. commit

- commit hash: 待 commit 后回填
- commit message: `fix(zai): busy flush 真正生效 (v2,位置修正)`

## 5. 仍可能遗留的问题

1. **wake budget 边界 — 后台连环唤醒**:`clearRunning` 会重置 wakeBudget,设计意图是"用户 turn 结束后恢复"。如果用户在 turn 结束后立刻又发 prompt,接着的 followup 又能 wake。但后台 task 极速连续完成 (race) 会绕过 wakeBudget,可能多个 turn 并行——与 v1 同款风险,未恶化也未修复。
2. **steer path**:AgentTool prompt-rebuild signal (`<task-command>`) 也走 inbox,steer 会被 promote 到 nextTurn 触发新 turn。原本 vendor hook prepend 的设计在这里被绕开 —— steer 不再等待下次 user prompt,直接起新 turn。语义略变,但方向更主动 (LLM 更快响应)。
3. **vendor commandQueue 全局锁**:`messageQueueManager.ts` 是 process-level singleton,跨 session 共享。dequeueAllMatching 走 cmd.sessionId 精确路由,但若 vendor 内部某路径 enqueue 时未注入 sessionId (没有走 zai wrapper),cmd.agentId fallback 可能把别的 session 的命令误派到这里。已加 agentId fallback 兼容,但需保证 vendor 调用方都走 zai wrapper。
4. **`getCommandQueue` 暴露粒度**: bundle-entry 现在同时暴露 `dequeueAllMatching / peek / getCommandQueue` 三个函数,粒度比 vendor 默认小;不在 bundle-entry 列出的 vendor 函数 (`subscribeToCommandQueue` 已有) 仍走原 vendor 路径,下次类似修复可能还需要再加。

## 6. 设计意图(留给 reviewer)

v1 (commit 646335c4) 只覆盖 BashNotifier pending queue;v2 把覆盖扩到 SessionInbox.nextStep + vendor commandQueue。三条 flush 路径在 finally 顺序执行:

```
flushPendingBashNotifications(sid)   ← v1, BashNotifier 暂存
promoteNextStepToNextTurn(sid)       ← v2, SessionInbox 兜底
drainCommandQueueForSession(sid)     ← v2, vendor 兜底
```

各自独立,任一路径触发的通知都不会丢。