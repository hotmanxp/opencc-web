# SSE 连接泄漏：客户端在启动阶段断开 → 订阅者与心跳定时器永久泄漏

**日期：** 2026-10-05
**发现者：** `--by claude`
**状态：** 已确认，未修复
**严重度：** 中（无界增长，长期运行后累积；不崩溃）

## 摘要

`GET /api/event` 在**注册 `req.on('close')` 之前**就注册了 eventBus 订阅者，
两者之间隔着一次 `await bg.list()` 磁盘读。

若客户端在这个窗口内断开（刷新页面、切路由），`req` 的 `close` 事件**已经
触发过**且当时无监听器 —— `close` 是一次性的，事后再挂监听器永不触发。
心跳的 `res.write` 对已销毁的响应是**静默 no-op 不抛错**，所以 catch 也不会兜底。

结果：`await closed` 永不 resolve → `finally` 永不执行 → **订阅者与 15 秒定时器
永久泄漏**。每次这样的刷新都永久增加一个「活着但已死」的 eventBus 订阅者，
它会收到此后所有事件。

## 位置

| 文件 | 行 | 内容 |
|------|----|------|
| `packages/zai/src/server/routes/event.ts` | 67-72 | `unsubscribe = eventBus.subscribe*(...)` —— **先注册** |
| 同上 | 123 | `for (const task of await bg.list())` —— **await 空窗** |
| 同上 | 150-154 | 心跳 `setInterval`，catch 里 `markClosed()` |
| 同上 | 155 | `req.on('close', markClosed)` —— **后注册** |
| 同上 | 157 | `await closed` |
| 同上 | 160-169 | `finally`：`clearInterval` + `unsubscribe?.()` + `res.end()` |

`safeGetBackgroundRuntime()` 在启动完成后恒非 null，所以这个 await 在生产里
**总会发生**（读 `~/.zai/tasks/` 磁盘）。

## 失效链条

1. `:67` 订阅者注册进 eventBus。
2. `:123` 开始 `await bg.list()` —— 事件循环在此让出。
3. 客户端此刻断开 → `req` 发出 `'close'` → **无监听器**。
4. `:155` 挂上 `req.on('close', markClosed)` —— `'close'` 是一次性的，
   **永远不会为这次断开再触发**。
5. `:157` `await closed` 挂起。
6. 心跳 `:150` 的 `res.write(': heartbeat\n\n')` 对已销毁的响应
   **返回 false 而不抛错** —— `catch` 不触发，`markClosed()` 不被调用。
7. `await closed` 永挂 → `finally` 永不跑 → 订阅者与 interval 永久泄漏。

### 关于「close 是一次性的」

这条是整个 bug 的关键。已实测验证：req 的 `close` 事件只发一次，
断开后再 `req.on('close', ...)` 不会触发（探针输出
`close handler fired after client already disconnected? false`）。

### 心跳为什么救不回来

`services/sse.ts:9-12` 的注释担心 `EPIPE` 会让 `res.write` 抛错。
**实测不成立**：在已销毁的 socket 上写，Node 25 静默 no-op，不抛。
所以 `:150` 的 `catch { markClosed() }` 这道保险**在真实断开场景下不会执行**。

讽刺的是：这与
`docs/bugs/2026-10-05-repl-registry-child-process-leak.md:76-81` 排除
`bashRepl.ts:81` 裸 `res.write` 崩溃嫌疑时用的是**同一个实测结论** ——
结论正确，但在**这里**它变成了问题的一部分：既然写入不抛错，
心跳就没有任何机制能感知到连接已死。

## 修复

核心是**让 `req.on('close')` 的注册早于任何 await**，或者不依赖 close 事件来感知断开。

1. **最小改动**：把 `:155` 的 `req.on('close', markClosed)` 上移到订阅者注册
   （`:72`）之后、`await bg.list()`（`:123`）之前。这样断开事件一定被捕获。

2. **更稳**：用 `res.on('close', ...)` 替代 / 补充 `req.on('close', ...)` ——
   `res` 的生命周期在客户端断开时同样触发 close，且 Express 已确保它被销毁。
   建议两个都挂，任一触发即 `markClosed()`。

3. **兜底**：给心跳加一个**连续写失败计数**。连续 N 次
   `res.write()` 返回 `false`（背压）或 `res.writableEnded` / `res.destroyed`
   为 true 时主动 `markClosed()`。这比依赖抛错更贴合 Node 的实际行为。

4. **结构性修复**：`unsubscribe` 的注册与 `await` 不应交错。
   把 `:123` 的 `bg.list()` 提到订阅注册**之前**（预取数据），
   或改用 `:72` 之后立刻 `req.on('close')` 的顺序（本条第 1 点）。

## 验证建议

修完后应能观测到泄漏消失：反复刷新 `/agent` 页面 N 次后，
`eventBus` 的订阅者计数应回到基线而非线性增长。当前没有暴露该计数的
API，建议在 debug 模式下加一个（如 `GET /api/system` 回
`eventSubscribers`），否则这类泄漏无法回归验证。

---

## 附带的同类泄漏：session 删除不清 registry

**位置**：`packages/zai/src/server/services/sessionAgentRegistry.ts:25`（`sessionAgents` Map）、
`:68`（`disposeSessionAgents`，**全仓无调用方**）

`sessionAgents` 在每次 subagent 终态事件时被填充
（`subagentNotifier.ts:79` → `registerSessionAgent`）。
`disposeSessionAgents` 定义在 `:68`，注释写明意图：

> Should be called when a session is disposed / killed to avoid memory bloat

但全仓 grep 确认**除自身定义与 `__resetSessionAgentsForTests` 外无调用**。

`DELETE /api/agent/sessions/:id`（`routes/agent.ts:2166-2199`）仔细地清理了
`CwdStore.delete`、`unregistryAgent`、terminal 释放，**唯独漏了这一项**。
每个被删除的会话泄漏一个 `Set<agentId>` 直到进程结束。

`disposeSessionInbox`（在 `agent.ts:53` 被 import）有同样问题 ——
仅从测试 seam 调用，被删除会话的队列 followup 消息永不丢弃。

**修复**：在 `DELETE /api/agent/sessions/:id` 的清理序列里补上
`disposeSessionAgents(id)` 与 `disposeSessionInbox(id)`。

这类漏项的通用防线是：`closeServer()` / session dispose 这类**回收清单**
应当有对应的完整性测试（枚举所有注册表，断言 dispose 后为空），
否则每加一个新注册表就会漏一次。
