# 停止按钮误杀另一个标签页的 turn

**日期：** 2026-10-05
**状态：** 已确认，未修复
**严重度：** 中高（误杀无关会话，丢失后台任务）
**发现：** zai

## 摘要

`POST /api/agent/abort` 先用 `X-Session-Id` header 正确 abort 了目标 session，
紧接着又调 `abortAgentSession(reason)` —— 后者内部使用的是**进程级全局
`currentSessionId`**，而不是刚解析出来的 `sid`。

`currentSessionId` 是单值，被每个 runtime 事件覆写。多标签页场景下，用户在
A 点停止，实际会连带 abort **B 的 query 和 B 的全部后台任务**。

## 位置

| 文件 | 行 | 内容 |
|------|----|------|
| `packages/zai/src/server/routes/agent.ts` | 2292-2300 | 先按 header 取 `sid`，再 `await abortAgentSession("user_abort")` |
| `packages/zai/src/server/services/agentRuntime.ts` | 920-950 | `abortAgentSession` 内部用模块级 `currentSessionId` |

```ts
const headerSid = (req.headers["x-session-id"] as string | undefined) ?? undefined
const sid = headerSid ?? getCurrentSessionId()
const aborted = sid ? abortSessionController(sid, "user_abort") : false
await abortAgentSession("user_abort")   // ← 用全局 currentSessionId，不是 sid
```

`abortAgentSession` 内部（`agentRuntime.ts:925-950`）依次做：
`abortAll()` × 3 → `abortSessionController(currentSessionId)` →
`cancelBackgroundTasksByParentSession(currentSessionId)` → `r.abort(currentSessionId)`。

## 与注释的冲突

`agent.ts:2295-2299` 的注释称：

> 重复调用不会引入副作用.

该论断**仅在 `sid === currentSessionId` 时成立**。多标签页下不成立 ——
这正是 bug 的来源。

## 失败场景

1. 标签页 A、B 分别打开会话 A、B，都在跑。
2. B 刚发过 runtime 事件 → `currentSessionId = B`。
3. 用户切到 A，点停止。
4. `abortSessionController(A)` 正确执行。
5. 但 `abortAgentSession` 又 abort 了 **B 的 query**，并
   `cancelBackgroundTasksByParentSession(B)` —— **B 的全部后台任务被杀掉**，
   后台任务本应继续跑的（注释自己说：「turn 已结束但后台任务还在跑」的场景
   就是靠这个函数兜底的）。

## 实证

源码逐行确认（`sed` 读 `agent.ts:2288-2302` 与 `agentRuntime.ts:915-955`）：
`abortAgentSession` 签名**不接收 sessionId 参数**，内部直接读模块级
`currentSessionId`。前端确实会带 `X-Session-Id`
（`useAgentStore.ts:1453`），但 server 端第二段调用绕过了它。

## 修复

1. 给 `abortAgentSession` 加显式 `sessionId` 参数：
   `abortAgentSession(sessionId: string, reason?: string)`，
   内部所有 `currentSessionId` 换成入参。
2. `/agent/abort` 传 `sid`（已有 header 兜底逻辑，够用）。
3. 三个 registry 的 `abortAll` 同步按 sessionId 过滤 —— 与
   [prompt close 全局清空审批](2026-10-05-prompt-close-aborts-all-approvals--by-zai.md)
   是同一处修复。
4. `commands/builtin/clear.ts:20` 也调 `abortAgentSession('user_clear')`，
   需同步适配签名。

## 关联

- [prompt close 全局清空审批](2026-10-05-prompt-close-aborts-all-approvals--by-zai.md)
  —— 同一根因家族，建议两条一起改。
