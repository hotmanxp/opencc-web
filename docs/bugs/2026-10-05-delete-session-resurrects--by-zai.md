# 删除会话不中断运行中的 turn，被删的会话会自己回来

**日期：** 2026-10-05
**状态：** 已确认，未修复
**严重度：** 中（会话复活 + 内容残缺 + 持续烧 token）
**发现：** zai

## 摘要

`DELETE /api/agent/sessions/:id` 删除了 transcript 文件、清理了 CwdStore、
注销了 agent、回收了 PTY 终端 —— 但**没有中断正在运行的 `runQueryLoop`**。

流式输出中点删除后：文件被 `rm`，但 for-await 循环还在跑 →
`finally` 里的 `flushSessionInboxNextStep` 触发 `wakeFor` → **启动新 turn** →
`appendEntry`（`mkdir` + `writeFile flag:'a'`）**重建被删的文件**。

用户看到「删掉的会话自己回来了」，而且内容是残缺的。

## 位置

| 文件 | 行 | 说明 |
|------|----|------|
| `packages/zai/src/server/routes/agent.ts` | 2166-2199 | DELETE 路由 —— 做了 5 项清理，**独缺 `abortSessionController(sid)`** |
| `packages/zai/src/server/routes/agent.ts` | 53 | `disposeSessionInbox` 被 import，**全文件仅此一处 —— 生产代码零调用** |
| `packages/zai/src/server/routes/agent.ts` | 1905 | `finally` 里 `flushSessionInboxNextStep(sessionId)` → `wakeFor` |
| `packages/zai/src/server/services/sessionAgentRegistry.ts` | 68 | `disposeSessionAgents` 同样从未被调用 |

清理清单现状：`store.remove` / `CwdStore.delete` / `unregistryAgent` /
`getTerminalService().disposeSession` / `eventBus.emit('session.deleted')`。

`grep -c disposeSessionInbox agent.ts` = **1**（只有 import 行）。
`agentRuntime.ts:502` 的调用在 `__resetAgentRuntimeForTests` 里，是测试 seam。

## 与项目既有纪律的对比

`AGENTS.md` 明确要求 PTY 进程必须在**三处**回收：关 tab、删会话、进程退出。
对照 `services/runtimeLifecycle.ts` 的 `closeServer()` 清单
（instanceSupervisor → backgroundRuntime → weixinBot → terminalService →
agentRegistry → skillWatcher → http → vite → branchChecker）——
agent runtime 自己不在清单里。

## 失败场景

1. 会话正在流式输出。
2. 用户点删除会话。
3. 文件被 `rm`，接口返回 `{ok: true}`。
4. `runQueryLoop` 继续跑，继续烧 API token。
5. turn 结束 → `finally` → `flushSessionInboxNextStep` → `wakeFor` →
   `runNextInQueue(sid)` **启动新 turn**。
6. 新 turn 调 `appendEntry` → `mkdir` + `writeFile flag:'a'` →
   **被删的 transcript 文件被重建**。
7. 用户刷新页面 → 会话又出现了，内容残缺。

## 修复

DELETE 路由按顺序补三步（顺序重要 —— 先 abort 让 turn 停下来，再清理）：

1. `abortSessionController(req.params.id, 'session_deleted')` —— 中断运行中的 turn
2. `disposeSessionInbox(req.params.id)` —— 清掉该 sid 的 inbox
   （顺带让 `:53` 那个死 import 名副其实）
3. `disposeSessionAgents(req.params.id)` —— 清 `sessionAgentRegistry` 绑定

注意 `disposeSessionInbox` 的注释（`sessionInbox.ts:358-361`）明确要求
「调用方负责先终止任何 in-flight turn」—— 当前 DELETE 路由正好违反了这个前置条件。

另需考虑：`runNextInQueue` 本身应有「session 已删除则不启动」的守卫，
作为第二道防线（`wakeFor` 可能在 abort 之后才被触发）。

## 关联

- [ReplRegistry 子进程泄漏](2026-10-05-repl-registry-child-process-leak.md) ——
  同一类问题：`closeServer()` 回收清单不完整。
