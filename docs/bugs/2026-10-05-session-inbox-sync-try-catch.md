# SessionInbox 用同步 try/catch 包 async handler，catch 形同虚设

**日期：** 2026-10-05
**发现者：** `--by claude`
**状态：** 已确认，未修复
**严重度：** 严重（常规 agent 活动即可触发全进程崩溃）

## 摘要

`SessionInbox.wakeIfBudgeted` 用**同步** `try/catch` 调用一个 **返回 Promise 的 async
handler**。同步 catch 观察不到 promise rejection，而返回的 promise 被直接丢弃 ——
于是**这个 catch 捕获不到任何东西**。

被包的 handler 是 `runNextInQueue`，它自身 `try/finally` 但**没有 catch**。
这条路径在每次 subagent 完成、每次后台 bash 完成、每次 commandQueue 排空时都会走 ——
属于**常规 agent 活动**，不是只在出错时才触发。

失败后果与 `docs/bugs/2026-10-05-async-handler-rejection-kills-process.md` 相同：
unhandled rejection → 进程退出，所有会话丢失。

## 位置

| 文件 | 行 | 内容 |
|------|----|------|
| `packages/zai/src/server/services/sessionInbox.ts` | 281-285 | `try { this.wakeHandler(sessionId) } catch { console.warn(...) }` |
| 同上 | 102, 105 | `private wakeHandler: InboxWakeHandler` 及 setter |
| `packages/zai/src/server/routes/agent.ts` | 1121-1123 | `setSessionInboxWakeHandler(async (sid) => { await runNextInQueue(sid) })` |
| 同上 | 1018-1031 | `runNextInQueue`：`try { await runQueryLoop(cmd) } finally { ... }`，**无 catch** |
| 同上 | 1030 | `void runNextInQueue(sid)` —— 裸 fire-and-forget |
| 同上 | 2009 | 另一处 fire-and-forget 调用点 |
| `packages/zai/src/server/services/busyFlush.ts` | 66, 139 | 触发 `commandQueue` 排空 |

## 注释与代码互相矛盾

`routes/agent.ts:1115-1116` 的注释把意图写得很清楚：

> handler 抛错仅 console.warn, 不让后台回调把 server 弄崩(与 SubagentNotifier 同款防御)。

**同步 try/catch 正是这个意图想防的那个 bug 本身。** 作者知道后台回调不能弄崩
server，加了防御，但防御用错了语言原语 —— 拦不住 async rejection。

这比「压根没想到」更值得记：防御代码存在、有注释、有意图，只是无效。

## 复现链

1. 用户发起一轮对话，其中包含 subagent 调用（或后台 bash 命令）。
2. subagent 完成 → `SubagentNotifier` → `getSessionInbox(sid).followup()`。
3. session 处于 idle 且 `wakeBudget` 未超限 → `wakeIfBudgeted` 走到 :281。
4. `this.wakeHandler(sessionId)` 启动 async handler，返回 Promise，**被丢弃**。
5. handler 内 `await runNextInQueue(sid)` → `await runQueryLoop(cmd)` 抛错
   （LLM API 失败、provider 报错、token 超限、上下文溢出……）。
6. `finally` 清理状态后 rejection 继续向外传播。
7. 无人持有的 rejected promise → **unhandledRejection** → Node 22+ 抛为
   uncaught exception → **进程退出**。

现场会话 `sess-1791173729117-ntgf8hz6`（见 `4746e9b9` commit message）就有
活跃的后台 bash 任务，说明这条路径在日常使用中一直在跑。

## 修复

最小且最贴切的修法 —— **把 rejection 处理挪到 promise 上**：

```ts
this.wakeHandler(sessionId).catch((err) => {
  console.warn('[SessionInbox] wake handler rejected:', err)
})
```

同时把 `wakeHandler` 的类型从同步视角改为显式 promise 契约
（`InboxWakeHandler = (sid: string) => Promise<void>`），让 TypeScript 在
未来有人改成同步实现时也能发现语义变化。

两处 fire-and-forget 调用点（`agent.ts:1030`、`:2009`）的 `void` 也应补 `.catch()`，
或统一走一个 `safeFireAndForget()` helper。

## 附带建议

`runNextInQueue`（:1018-1031）的 `try/finally` 建议补 `catch`：
后台 agent turn 失败是**可预期的常态**（用户取消、网络抖动、provider 报错），
不应该冒泡到进程级。至少要保证 session 状态被正确落回 idle 并给用户一条可见的
错误提示 —— 当前这个失败在 UI 上是**完全静默**的（进程直接没了）。

## 关联问题

- 与 `docs/bugs/2026-10-05-async-handler-rejection-kills-process.md` 同根同源。
  那份文档给出的进程级 `unhandledRejection` 兜底能同时挡住本条；
  但本条仍应单独修 —— 兜底只是止损，wake handler 的 rejection 本身
  仍应被消费掉，否则每次都靠兜底接住会刷爆日志。
- `docs/bugs/2026-10-05-lan-mode-no-auth-rce.md` 记录的 `--lan` 无鉴权面
  也包含这条路径可被外部触发。
