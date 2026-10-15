# 微信入站媒体无上限无回收 + 账号锁文件无限累积

**日期：** 2026-10-05
**状态：** 已确认，未修复
**严重度：** 低中（磁盘无界增长）
**发现：** zai

## 摘要

两处同属「只创建不回收」：

1. **入站媒体**：`~/.zai/weixin/media/` 与 `<cwd>/.zai/weixin-media/`
   全仓**无任何删除逻辑**。且纯媒体消息（无 `text`）完全绕过去重，
   同一张图反复发不会被拦。
2. **账号锁文件**：`AccountLock.acquire` 为每个 token 在
   `~/.zai/weixin/locks/` 创建一个 base 文件，**从不删除**。
   本机实测已累积 **1740 个 0 字节文件**。

## 位置

| 文件 | 行 | 内容 |
|------|----|------|
| `packages/zai/src/server/services/weixinBot/WeixinAdapter.ts` | 484-487 | `if (text) { ...去重 }` —— 纯媒体消息跳过整个去重块 |
| `packages/zai/src/server/services/weixinBot/AccountLock.ts` | 31-33 | `if (!existsSync(lockPath)) writeFile(lockPath, '')` —— 建了不删 |
| `packages/zai/src/server/services/weixinBot/AccountLock.ts` | 54-62 | `release()` 只调 `releaseFn()`（proper-lockfile 回收 `.lock` **目录**），不删 base 文件 |

## 实证：锁文件累积

```
$ ls ~/.zai/weixin/locks/ | wc -l
1740
$ du -sh ~/.zai/weixin/locks/
0B
$ ls -lat ~/.zai/weixin/locks/ | head -3
-rw-------  1 ethan  staff  0 Oct  1 10:32 a55adde9...465.lock
-rw-------  1 ethan  staff  0 Oct  1 10:32 b894fb5e...508.lock
```

每个文件 0 字节（proper-lockfile 的 base 文件本身就是空的），
但 **1740 个目录项**已累积，且从 8 月持续到 10 月。

另有 `f7fc7cd9...138.lock.lock` 是 proper-lockfile 的**目录锁**（正在持有中），
与 base 文件是两回事 —— base 文件才是泄漏的那个。

## 实证：媒体无回收

`grep -rn "rm\|unlink\|rmdir" services/weixinBot/` 未发现针对
`media/` 目录的删除路径。媒体只被 `_collectMedia` 写入和读取，
**没有任何生命周期结束后的清理**。

## 影响

- 单条消息体积小，但无界累积。长期运行的实例（用户的机器上 zai 已跑数月）
  会持续增长。
- 锁文件本身 0 字节，磁盘占用可忽略（`du` 显示 0B），真正的成本是
  **目录项数量** —— 1740 个文件对任何文件系统的遍历都是可测量的开销，
  且每次 `AccountLock.acquire` 都要 `existsSync` + 可能 `writeFile`。
- 媒体无去重这一点比泄漏本身更值得注意：**同一张图可以无限重复入库**。

## 修复

1. **锁文件**：给 `~/.zai/weixin/locks/` 加一个启动时的清扫 —— 删除超过
   24h 且当前未被 proper-lockfile 持有的 `.lock` base 文件。
   注意不能盲删正在被持有的锁（base 文件被删不影响 `.lock` 目录锁的语义，
   但要确认 proper-lockfile 的 stale 判定不依赖 base 文件的存在）。
   更彻底的做法是改用带 pid 的临时名 + 退出时清理，参考
   `instanceStore.ts:115` 的 `${path}.${process.pid}.tmp` 模式。
2. **媒体**：给 `media/` 加保留策略 —— 消息 transcript 被删除或超过 N 天时，
   清理其关联媒体文件。需要建立「媒体文件 → messageId/sessionId」的索引。
3. **纯媒体去重**：把去重 key 从「仅 text」扩展到
   `messageId + mediaPaths`，让重复投递的图片能被识别（与
   [内容指纹去重](2026-10-05-weixin-content-fingerprint-dedup--by-zai.md)
   一并处理）。

## 关联

- [微信内容指纹去重吞消息](2026-10-05-weixin-content-fingerprint-dedup--by-zai.md) ——
  同一个 `if (text)` 守卫：它让媒体绕过去重（从而放大本条的泄漏），
  同时让重复文本被误杀。
