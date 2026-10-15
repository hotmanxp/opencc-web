# 微信记忆轮转读了一个没人写入的路径布局 —— 整个特性静默空转

**日期：** 2026-10-05
**发现者：** `--by claude`
**状态：** 已确认，未修复
**严重度：** 高（整条跨会话记忆链路无任何效果，无报错）

## 摘要

`readTranscriptExcerpt` 拼出的 transcript 路径与真正的写入方
`legacyTranscriptStore` **在三个维度上都不一致**（多一层目录 / 扩展名不同 /
序列化格式不同）。结果是它**永远读不到任何东西**，
`recordRotationSummary` 在第一道检查就早退，
**微信跨会话记忆的总结从未被写入过一次**。

整个特性看起来在工作（有目录、有调用、有 API），实际是 no-op。

## 位置

| 文件 | 行 | 内容 |
|------|----|------|
| `packages/zai/src/server/services/weixinBot/weixinMemory.ts` | 108-112 | 读取路径拼接（错） |
| 同上 | 269 | `if (messages.length === 0) return ''` —— 早退点 |
| 同上 | 126-128 | `JSON.parse` 失败被吞 |
| `packages/zn-agent-core/src/compat/runtime/legacyTranscriptStore.ts` | 90-94 | 真实写入路径 |
| `packages/zai/src/server/services/weixinBot/weixinInboundBridge.ts` | 341 | `recordRotationSummary` 调用点 |

## 三重不匹配

**读**（`weixinMemory.ts:109-111`）：

```ts
const base = join(dataDir, 'transcripts')
const candidates = cwd
  ? [join(base, 'projects', sanitizePath(cwd), `${sessionId}.json`),
     join(base, `${sessionId}.json`)]
  : [join(base, `${sessionId}.json`)]
```

**写**（`legacyTranscriptStore.ts:88-94`）：

```ts
private dirFor(cwd) { return join(this.dataDir, 'projects', sanitizePath(cwd)) }
private filePathFor(sessionId, cwd) { return join(this.dirFor(cwd), `${sessionId}${JSONL_EXT}`) }
```

| 维度 | 读 | 写 |
|------|----|----|
| 根目录 | `dataDir/transcripts/` | `dataDir/` —— **多了 `transcripts/` 一层** |
| 文件名 | `${sessionId}.json` | `${sessionId}.jsonl` —— **扩展名不同** |
| 格式 | `JSON.parse(readFileSync(...))` | JSONL（每行一条）—— **即使路径对了也会抛** |

第三个问题即使前两个修好仍在：`readTranscriptExcerpt:114` 的
`JSON.parse(readFileSync(path, 'utf-8'))` 读到的是 JSONL，
会在第一行就抛 —— 而该异常被 `:126-128` 的 catch 吞掉，**继续试下一个 candidate**，
最终返回空数组，同样静默。

## 磁盘实证

```
$ find ~/.zai/transcripts -type f -newermt "2026-09-01" | head
(空 —— 该目录自 2026-08-01 起再无新文件)

$ find ~/.zai/projects -name "*.jsonl" | head -3
~/.zai/projects/-private-tmp-year-report/sess-34d8d285-....jsonl
~/.zai/projects/-private-tmp-zai-rg-verify/sess-1786264506770-....jsonl
~/.zai/projects/-private-tmp-zai-rg-verify/sess-1786264506765-....jsonl
(这些才是活跃写入的)

$ find ~/.zai/weixin/memory -path "*rotations*" -type f | wc -l
0
```

**`~/.zai/transcripts/` 存在但是陈旧的**（可能是早期版本写的），
真实数据在 `~/.zai/projects/*/*.jsonl`。
而 `memory/<hash>/rotations/` 目录里 **0 个文件** —— 总结从未落盘。

## 复现链

1. 微信会话达到 TTL 阈值，或用户发 `/new`。
2. `weixinInboundBridge.ts:341` 调 `recordRotationSummary({ dataDir, oldSessionId, cwd, ... })`。
3. → `readTranscriptExcerpt(dataDir, oldSessionId, cwd)`。
4. 两个 candidate 路径都不存在 → `continue` 跳过 → 返回 `[]`。
5. → `weixinMemory.ts:269` `if (messages.length === 0) return ''`。
6. 早退，**不写任何文件**。
7. 之后 `loadMemorySnapshot` 读 `lastRotationSummary` 恒为 `''`。

**跨会话记忆交接全程静默失效。** 没有异常、没有日志、没有 metric ——
唯一可观测的症状就是那个恒为 0 的 `rotations/` 目录。

## 修复

1. **让读取方复用写入方的路径构造函数**，而不是自己拼字符串。
   `legacyTranscriptStore` 的 `filePathFor` 是私有的，建议抽成导出的纯函数
   （如 `transcriptPathFor(dataDir, cwd, sessionId)`），两侧共用。
   这类「两处各拼一遍路径」的不匹配，靠改字面量只能撑到下次重构再次漂移。

2. **改用 JSONL 解析**。若必须读文件，应按行 split 后逐行 `JSON.parse`，
   并容忍尾部半行（写入方的写入是 append，可能有未刷完的尾行）。

3. **加可观测性**。`messages.length === 0` 这个早退点目前完全静默 ——
   至少 `console.debug` 打出尝试过的 candidate 路径和 `existsSync` 结果。
   这次的 bug 之所以能存活这么久，正是因为「什么都不写」和「正常运行但没数据」
   在日志上长得一模一样。

4. **加回归测试**。用真实的 `legacyTranscriptStore` 写一条 transcript，
   再调 `readTranscriptExcerpt` 断言能读回 —— 当前的测试若只测解析函数本身
   （喂内存数据），就绕过了路径拼接这半边。

## 附带发现

`~/.zai/weixin/locks/` 目录累积了 **1742 个** `.lock` 文件，最早的来自
2026-08-19。属于同一类治理缺口（清理策略缺失导致的无界增长），
但与本 bug 无关，单独记录。
