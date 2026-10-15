# 每次发消息都全局清空所有会话的待决审批

**日期：** 2026-10-05
**状态：** 已确认，未修复
**严重度：** 高（跨会话误杀审批，工具调用错误失败）
**发现：** zai

> **与 `--by opencc` 的 `2026-10-05-prompt-close-aborts-all-sessions.md` 描述同一个
> bug**（同一处 `agent.ts:1967-1987`）。那份把严重度定为「严重」。
> 两份的差异：本篇带**可复现的 Express 实证**（keep-alive 下 `closeFired=true`
> 而 `socket.destroyed=false`），那份带更完整的 registry 单例链路描述。
> 合并时保留两者的实证即可，避免重复修复。

## 摘要

`POST /api/agent/prompt` 挂了一个 `req.on("close")` 处理器，用来在客户端断开时
释放待决审批。但 **Express 的 `req` 在每次正常 POST 完成后都会触发 `close`**
（body 读完即销毁 request 流），与客户端是否断开**无关**。

结果是：用户每发一条消息（包括队列里排队的消息），就会把**进程内所有会话**
正在等待的 AskUserQuestion / approve / permission 审批全部 `reject`。

三个 registry 是模块级单例，`abortAll()` 无 sessionId 过滤 —— 所以
**在标签页 B 发任何一条消息，会杀掉标签页 A 正在等的审批**。

## 位置

| 文件 | 行 | 内容 |
|------|----|------|
| `packages/zai/src/server/routes/agent.ts` | 1967-1987 | `req.on("close", ...)` 内调三个 `abortAll("client_disconnect")` |
| `packages/zai/src/server/services/agentRuntime.ts` | 83-85 | `askRegistry` / `approveRegistry` / `permissionRegistry` 模块级单例 |
| `packages/zai/src/server/services/approveRegistry.ts` | 102-108 | `abortAll()` 遍历全部 pending，**无 sessionId 过滤** |

代码注释（`:1974-1979`）自己已经承认了这个语义：

> ★ 不要 abort: fire-and-forget 设计下, /agent/prompt 立即写完响应,
> HTTP/1.1 默认会 close res, **client 关 body 是正常 lifecycle**.

注释识别出了「正常 lifecycle」，却只摘掉了 `abortController.abort()`，
把三个 `abortAll()` 留在了原地。

讽刺的是 `approveRegistry.ts:110` 已经有 `listBySession(sessionId)` ——
**过滤能力存在，只是 `abortAll` 没用它**。

## 实证

用项目自己的 express 写最小复现，keep-alive，客户端**全程没有断开**：

```
HTTP 200, connection kept alive by client
200ms after res.json: closeFired=true  socket.destroyed=false
=> CONFIRMED: req "close" fires on NORMAL completion
```

`socket.destroyed=false` 证明连接是活的，`close` 依然触发了。

## 失败场景

1. 会话 A 正在跑，Bash 工具触发 `permissionMode:'ask'`，弹窗等用户点确认。
2. 用户在同一页面**输入一条排队消息** —— 这正是队列功能的核心用法。
3. POST → `res.json()` → `close` 触发 → A 的待决审批被 `reject('client_disconnect')`。
4. 工具调用报错，LLM 拿到的是「客户端断开」而不是用户的真实决策。

跨会话更糟：两个标签页开着 A、B，B 刚发过任何一条消息 → A 正在等的审批被
连带杀掉。

## 修复

1. **最小改动**：三个 `abortAll()` 改为按 sessionId 过滤，只释放本请求
   所属 session 的 pending。注意 `sessionId` 在闭包里已可用（`:1972` 有引用）。
2. **更彻底**：`/agent/prompt` 是 fire-and-forget，客户端断开**已经无法感知**
   （响应立刻写完）。真正兜底是 `runQueryLoop` 内的 HARD_TIMEOUT
   （`:1978` 注释，2h）。可以直接删掉整个 `req.on("close")` 处理器 ——
   释放语义已由 HARD_TIMEOUT 承担。
3. 若保留处理器，应改用 `res.on('close')` + 判断 `res.writableEnded`，
   区分「正常写完」与「中途断开」。

## 关联

- 与 [停止按钮误杀另一标签页](2026-10-05-abort-uses-global-session-id--by-zai.md)
  同源：都源于 registry / runtime 是进程级单例而路由假设是 per-session。
- `AskRegistry` / `PermissionRegistry` 的 `abortAll` 有同样问题，需一并核对
  （本条已确认 `ApproveRegistry`；三个类的实现形状相同）。
