# 微信入站按文本内容指纹去重，吞掉合法的重复消息

**日期：** 2026-10-05
**状态：** 已确认，未修复
**严重度：** 中高（用户消息静默丢失，无任何提示）
**发现：** zai

## 摘要

入站有**两层**去重。第一层按 `message_id` 去重（正确 —— 那是消息身份）；
第二层按 `md5(文本内容)` 去重，TTL 5 分钟，**且命中后续期**。

第二层把「内容相同」当成了「同一条消息」。但重发同一句话是完全合法的用户
行为 —— iLink 会为它分配**不同的 `message_id`**，所以第一层放行，第二层
把它吃掉。

更糟的是续期：用户每 4 分钟重发一次「继续」，这个 key 永远不会过期，
**该用户从此再也发不出这句话**。

## 位置

| 文件 | 行 | 内容 |
|------|----|------|
| `packages/zai/src/server/services/weixinBot/WeixinAdapter.ts` | 485-487 | `contentKey = \`content:${senderId}:${md5(text)}\`` → `isDuplicate` → `return` |
| `packages/zai/src/server/services/weixinBot/WeixinAdapter.ts` | 429-430 | 第一层：`message_id` 去重（这一层是对的） |
| `packages/zai/src/server/services/weixinBot/stores/MessageDeduplicator.ts` | 34-43 | `isDuplicate` 命中时 `set(key, now + ttlMs)` **续期** |
| `packages/zai/src/server/services/weixinBot/constants.ts` | 40 | `MESSAGE_DEDUP_TTL_SECONDS = 300` |

## 实证

写了一条测试（验证后已删除），用 mock long-poll 投两条**真实独立**的消息：

| message_id | 文本 |
|---|---|
| `msg-AAA` | `继续` |
| `msg-BBB` | `继续` |

结果：

```
AssertionError: expected 1 to be 2
[PROOF] emitted 1 message(s) for 2 distinct messages
```

第二条被静默丢弃，emitter 只收到 1 条。

该路径**零测试覆盖** —— 现有测试只有
`packages/zai/test/server/weixinBot/WeixinAdapter.inbound.test.ts:130`
的 `message_id` 去重用例。

## 影响

- 微信用户发「继续」「好的」「ok」「收到」这类短回复，**大概率被吞**，
  agent 不响应，界面无任何提示 —— 表现为「机器人偶尔装死」。
- 高频短消息用户（最活跃的那批）会被续期机制**永久锁死**。
- 静默丢数据：不报错、不告警、无日志，用户和排查者都无从发现。

## 修复

内容指纹去重只能防「iLink 重复投递**同一条**消息」，而那正是 `message_id`
层该干的活。二选一：

1. **删掉内容指纹层**（推荐）—— `message_id` 已足够，且是 iLink 的权威身份。
   改动最小，且直接消除误杀。
2. 若要保留兜底，把 key 改成 `content:${messageId}:${md5(text)}`，让内容指纹
   **依附于消息身份**而非独立去重。同时把纯媒体消息（`text` 为空）也纳入 ——
   现在 `if (text)` 守卫让媒体消息完全绕过去重（见
   [入站媒体无上限无回收](2026-10-05-weixin-media-unbounded--by-zai.md)）。

若选方案 1，注意 `MessageDeduplicator` 类本身仍被 `message_id` 层使用，
不要连带删除。

## 关联

- [入站媒体无上限无回收](2026-10-05-weixin-media-unbounded--by-zai.md) ——
  同一个 `if (text)` 守卫的另一面。
- [游标早于 pending.save 推进](2026-10-05-weixin-cursor-ahead-of-persist--by-zai.md) ——
  同一子系统的另一条消息丢失路径。
