# SSE 断点续传的两处断裂：重启后流式永久静默 + Last-Event-ID 永不命中

**日期：** 2026-10-05
**发现者：** `--by claude`
**状态：** 已确认，未修复
**严重度：** 高（用户可见的功能性失效，无报错）

## 摘要

SSE 事件流有两套独立的「防重复 / 防丢失」机制，**两套同时是坏的**，且互相掩盖：

1. **客户端 seq guard 跨重启不清零** —— 服务端重启后 seq 从 0 重新计数，
   客户端拿旧的高水位比对，**新事件全被静默丢弃**。模型在干活，界面一个字不出。
2. **`Last-Event-ID` 续读键写错** —— SSE 的 `id:` 行写的是 `seq`，而服务端查找时
   比对的是 `eventId`，两者永远不相等，**每次重连都退化成全量重放**。

第 1 条让用户以为「重连修好了」，实际是把事件全部吃掉；第 2 条让重连必然重放全量，
而没有 seq guard 的 reducer（`state.*` / `prompt.*`）会**真的重复执行**。

## 问题 1：seq guard 跨重启不清零

### 位置

| 文件 | 行 | 内容 |
|------|----|------|
| `packages/zai/src/server/services/eventBus.ts` | 171 | `private seqCounter = 0` —— **进程级**计数器 |
| `packages/zai/src/web/src/store/useAgentStore.ts` | 340, 711 | `lastSeqBySession` 状态定义与初始值 |
| `packages/zai/src/web/src/store/useAgentStore.ts` | 801-804, 998-1001 | 两处 guard：`if (guardSeq <= prev) return s` |

`eventBus.ts:169-170` 的注释已明确写死前提：**「进程重启后从 0 重新计数」**。
客户端的 `lastSeqBySession` 却是 tab 生命周期的，**永不清零**。

### 复现链

1. 用户在会话 S 里正常对话，服务端 `seqCounter` 涨到比如 4000，
   前端 `lastSeqBySession['sess-xxx'] = 4000`。
2. 设置抽屉点「重启服务」，或自动更新触发重启。**这条路径不 reload 页面** ——
   `window.location.reload()` 只在手动点「连接错误」恢复链接
   （`AgentInputBox.tsx:1527`）和 supertask supervisor 按钮里调用。
3. `useAgentStore` 是模块单例（`useAgentStore.ts:618`），跟 tab 一起活着。
4. EventSource 自动重连，新进程从 `seq = 1` 开始发。
5. 每个 `runtime.delta` / `runtime.thinking` / `runtime.tool_call` 的 seq 都 `<= 4000`
   → `return s` → **静默丢弃**。

用户侧表现：发 prompt → spinner 转 → 模型正常执行 → **界面永远空白**。
无报错、无 toast。只能手动 F5，或等新事件数超过旧水位。

### 漏掉重置的位置

`setCurrentSession`（`useAgentStore.ts:1125`）重置了 `messages` / `textSegmentRev` /
`segmentedToolUseIds` / `sendSeq` / `lastRuntimeTurnIndex`，**唯独漏了 `lastSeqBySession`**。
`clearMessages`（:1064-1081）同样漏。任何错误恢复路径也没重置。

### 修复

最小改动 —— 在 `setCurrentSession` 和 `clearMessages` 的重置对象里各加一行
`lastSeqBySession: {}`。

但**只加这一行不够**：`setCurrentSession` 不一定覆盖「不切会话只重启服务」的场景
（正是上面的复现链）。更稳的做法是让 seq 水位绑定**进程世代**而非 tab：

- 服务端在 `/api/system` 或 SSE 首帧里带一个 `bootId`（进程启动时生成一次 UUID）；
- 客户端发现 `bootId` 变化时清空 `lastSeqBySession`。

这样不依赖「用户有没有恰好切过会话」。

## 问题 2：Last-Event-ID 永不命中

### 位置

| 文件 | 行 | 内容 |
|------|----|------|
| `packages/zai/src/server/services/sse.ts` | 50 | `const id = event.seq ?? (event as {eventId?}).eventId` |
| `packages/zai/src/server/services/eventBus.ts` | 260-264 | `arr.findIndex((e) => e.eventId === lastEventId)` |

`emit` **总是**填 `seq`（`eventBus.ts:192`：`seq: event.seq ?? ++this.seqCounter`），
所以 `?? ` 的右半边永远走不到 —— 写出去的 `id:` 行恒为数字字符串（如 `"482"`）。
而 `_sliceAfter` 拿它去比对 `e.eventId`（形如 `"evt_m4k2p_1x"`）。

**`"482"` 永远不等于 `"evt_m4k2p_1x"`** → `idx < 0` → `return [...arr]`（全量）。

`eventBus.ts:257-259` 的注释把它描述成边缘情况（「续读如果断点丢失」），
实际上**每次重连都命中这一条**。

### 复合放大

`getHistoryAfterForSid`（:248-253）只在 `lastEventId === undefined` 时套用
`STREAMING_REPLAY_EXCLUDE` 过滤器。重连时 `lastEventId` 恒有值 → **过滤器永不生效** →
重放完整 256 条窗口。

`runtime.*` 的重复被问题 1 的 seq guard 挡住了（副作用：问题 1 更隐蔽了），
但 `state.*` / `prompt.*` 的 reducer **没有 seq guard** —— 这些会真的重复执行。

### 修复

`id:` 行与查找键必须用同一个字段。两个选择：

- 改 `sse.ts:50` 为 `const id = (event as {eventId?}).eventId ?? event.seq`，
  并确认 `eventId` 全局唯一（注意：`eventId` 若按 sid 生成，不同 sid 可能撞车，
  此时需要 `${sid}:${eventId}` 复合键）。
- 或改 `eventBus._sliceAfter` 改用 `e.seq` 比对 —— 但 `ServerEvent` 类型上
  `seq` 是可选的，历史数组里可能缺，需要 fallback。

另外 `_sliceAfter` 的全量 fallback 建议加一个上限 + 告警日志，
静默退化成全量重放本身就是需要可见的异常。

## 关联问题：session 切换窗口内 reducer 缺 sid 守卫

`applyRuntimeEvent`（`useAgentStore.ts:1622-1623`）有守卫：

```ts
const currentSid = get().sessionId
if (currentSid && sid !== currentSid) return
```

但同族的 `applyPromptAsk`（:1971）、`applyPromptApprove`（:1994）、
`applyPromptPermission`（:2091）、`applyQueueChanged`（:1041）**都没有**。
`useEventStream.ts:44-46` 的注释承认了这些 reducer 不做 sid 过滤，
但那道防线**只对 `runtime.*` 生效**。

`pendingAsk` 会 gate 发送按钮（`AgentInputBox.tsx:1746`）。切会话的几十毫秒真空期里
（`useAgentStore.ts:1613-1619` 注释描述的窗口），A 会话的 `prompt.ask` 会覆盖
B 会话的状态 —— **用户在 B 会话看到 A 的提问卡片，且输入框被硬锁**。
问题 2 的全量重放会加剧这一点（`prompt.ask` 无 seq guard，重连必重放）。

建议把这几个 reducer 统一加上与 `applyRuntimeEvent` 相同的 `currentSid` 比较。
