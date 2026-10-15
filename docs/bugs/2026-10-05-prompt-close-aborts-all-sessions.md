# `/agent/prompt` 正常响应即 abort 全进程所有 pending 提问

**日期：** 2026-10-05
**发现者：** `--by opencc`
**状态：** 已确认，未修复
**严重度：** 严重（跨会话正确性破坏，静默，且在常见交互路径上）

## 摘要

`POST /api/agent/prompt` 的 `req.on("close")` 处理器在**每一次正常成功响应后**都会触发
（不只是客户端断开时），并调用三个 registry 的 `abortAll()`。这三个 registry 都是
**模块级单例**，`abortAll` **不按 sessionId 过滤** —— 于是任何一次 prompt 提交都会
reject 掉**整个 zai 进程**中所有会话的 pending 提问 / 审批 / 权限确认。

## 位置

`packages/zai/src/server/routes/agent.ts:1967-1987`

```ts
req.on("close", () => {
  // ★ 不要 abort: fire-and-forget 设计下, /agent/prompt 立即写完响应,
  // HTTP/1.1 默认会 close res, client 关 body 是正常 lifecycle.
  // ...但 askRegistry 仍要 abort — client 关掉页面时正在 ask 的 tool 必须释放.
  getAskRegistry().abortAll("client_disconnect");        // :1980
  getApproveRegistry().abortAll("client_disconnect");    // :1983
  getPermissionRegistry().abortAll("client_disconnect"); // :1986
})
```

注释自相矛盾：先说「不要 abort」（针对 query loop），随后仍然 abort 三个 registry
（理由是「client 关掉页面时」）。**这个前提是错的** —— 见下方实证。

## 根因

`res.json()`（`agent.ts:2012`）是 fire-and-forget，handler 立即返回，Node 在
**正常完成**时同样在 `IncomingMessage` 上触发 `close`，而非只在客户端中断时触发。

三个 registry 是模块级单例（`services/agentRuntime.ts:84-86`）：

```ts
const askRegistry = new AskRegistry()
const approveRegistry = new ApproveRegistry()
const permissionRegistry = new PermissionRegistry()
```

`abortAll` 遍历全部 pending，无 sessionId 过滤
（`askRegistry.ts:74-79`、`approveRegistry.ts:103-108`、`permissionRegistry.ts:94-99`，
三者实现完全一致）：

```ts
abortAll(reason = 'session_aborted'): void {
  for (const p of this.pending.values()) {
    this.pending.delete(p.toolUseId)
    p.reject(new Error(reason))
  }
}
```

注意三个 registry 的 `Pending` 类型**都已经存了 `sessionId`**
（`askRegistry.ts:45`、`approveRegistry.ts:20`、`permissionRegistry.ts:20`），
`approveRegistry.ts:111` 甚至已经有一个 `listBySession(sessionId)` 过滤辅助方法 ——
**修复所需的字段与查询手段全部现成**，只是 `abortAll` 从不使用它们。

## 实证

Node **v25.6.0**（本机版本），mimic `agent.ts` 的 fire-and-forget 响应模式：

```
[client got complete 200 response]
=> req "close" FIRED 1ms after a NORMAL 200 response
```

正常、完整、客户端成功收到响应后 1ms，`close` 就触发了。

## 失效路径

**同会话（最常见）**：agent 在会话 A 调 `AskUserQuestion` 阻塞等待用户作答。
用户此时输入一条追问（排在正在跑的 turn 之后）→ 这次 POST 返回 200 → `req` close →
`abortAll` 触发 → **待回答的问题被 reject**。agent 收到 `Error: client_disconnect`
而不是用户的答案，整轮对话被打断。

**跨会话**：会话 B 的任意一次 prompt 提交，会 kill 掉会话 A 正在等待的
权限确认 / 审批 / 提问。多标签页或子 agent 并行时必然互相干扰。

**审批/权限同样受害**：`ApproveRegistry` 与 `PermissionRegistry` 共用同一模式，
`/api/agent/approve` 与 permission 确认在用户点「允许」之前就可能已被 reject。

## 修复

`abortAll` 需要按会话收敛，而不是进程级清空：

1. 给三个 registry 的 `abortAll` 增加可选 `sessionId` 参数，有值时只 reject
   该会话的 pending。三个 `Pending` 都已存 `sessionId`，`approveRegistry` 已有
   `listBySession` 可参照 —— 改动很小。
2. 调用点传入当前请求的 `sessionId`。
3. 更稳妥的方案：改用 `req.on("aborted")`（仅客户端中断时触发）区分
   「真断开」与「正常完成」，前者才 abort。

**注意**：即使加了 sessionId 过滤，同会话内「追问 abort 掉本会话 pending 提问」
的问题依然存在 —— 那是同一个设计缺陷的另一半。方案 3 才能真正修掉。

## 关联

`disposeSessionAgents`（`services/sessionAgentRegistry.ts:68`）全仓**零调用方** ——
`DELETE /agent/sessions/:id`（`agent.ts:2166-2199`）清理了 `CwdStore`、agent registry
和 PTY 终端，但没清 `sessionAgents`，也没调已 import 的 `disposeSessionInbox`。
该函数自己的 docstring 写着「Should be called when a session is disposed / killed
to avoid memory bloat」。每跑过 subagent 的会话都会泄漏一个 `Map` + `Set`。
