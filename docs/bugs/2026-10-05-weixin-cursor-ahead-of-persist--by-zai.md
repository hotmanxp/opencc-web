# 微信入站游标早于 pending 落盘推进，重启丢消息

**日期：** 2026-10-05
**状态：** 已确认，未修复
**严重度：** 中（重启窗口内丢消息）
**发现：** zai

## 摘要

入站消息的处理顺序是：`pending.save(msg)` → `followup(...)` → ……
而 iLink 的**拉取游标在更早的阶段就已经推进了**。

`disconnect()` 时用 `flushAll(() => { /* drop */ })` 丢弃所有 debounce 缓冲，
回调体是空的 —— 这意味着 flush 时**既不落盘也不投递**，消息直接消失。

两条路径叠加：进程重启/crash 落在「游标已推进」与「消息已落盘」之间的窗口内，
该消息**永久丢失**，且服务端不会再重投（游标已经过去了）。

## 位置

| 文件 | 行 | 内容 |
|------|----|------|
| `packages/zai/src/server/services/weixinBot/WeixinAdapter.ts` | 294 | `this.debounce.flushAll(() => { /* drop */ })` —— 空回调，**丢弃即消失** |
| `packages/zai/src/server/services/weixinBot/weixinInboundBridge.ts` | 386 | `await this.deps.pending.save(pending)` |
| `packages/zai/src/server/services/weixinBot/weixinInboundBridge.ts` | 388-393 | `followup` → `markProcessed` → `remove` |

`weixinInboundBridge` 的落盘顺序本身是对的（先 `save` 再 `followup`），
问题在于**它只在消息真正进入 bridge 时才执行**；而 debounce 缓冲里的消息
还没走到这一步，就已经被 `flushAll(drop)` 扔了。

## 失败场景

1. 用户连发 3 条消息，iLink 一次推来；adapter 走 debounce（3s 窗口）合并。
2. 前 2 条已 flush 进 bridge 并 `pending.save`；第 3 条还在缓冲区。
3. 此时进程重启 / crash / 用户点「重启服务」。
4. `disconnect()` → `flushAll(() => {})` → 第 3 条**被丢弃**。
5. 游标已推进 → 服务端不会重投 → **该消息永久丢失**。

## 实证

代码层确认（`sed` 读 `WeixinAdapter.ts:288-300`）：

```
WeixinAdapter.ts:294   this.debounce.flushAll(() => { /* drop */ })
```

回调体是**空函数** —— 明确标注 `drop`，既不 `pending.save` 也不 `followup`。

`weixinInboundBridge.ts:386-393` 确认 `pending.save` 在 `followup` 之前，
顺序正确，但只对已进入 bridge 的消息生效。

## 修复

1. **flush 回调里补落盘**：`flushAll` 的回调不应是 `drop`，而应把消息送进
   bridge 的持久化路径（至少 `pending.save`），让 `~/.zai/weixin/inbox-pending/`
   的崩溃重放机制能接管。
2. **或**：让 `disconnect()` 在 flush 前**不推进游标** —— 游标推进与消息落盘
   应该在同一个事务边界内。
3. 根本约束（值得写进设计文档）：**游标推进必须晚于消息持久化**。
   现在的实现里游标由 adapter 的 poll 循环推进，持久化由 bridge 异步做，
   两者之间没有顺序保证。

## 关联

- [微信内容指纹去重吞消息](2026-10-05-weixin-content-fingerprint-dedup--by-zai.md) ——
  同一子系统的另一条静默丢消息路径。
- `inbox-pending/` 机制（`AGENTS.md` 记载为「崩溃重放」）已存在，
  本条是它的一个未覆盖缺口。
