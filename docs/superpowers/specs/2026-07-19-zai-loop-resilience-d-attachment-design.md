# D. Mid-turn Attachment + Memory Prefetch

| 字段 | 值 |
|---|---|
| Spec 编号 | 2026-07-19-zai-loop-resilience-d |
| 父 spec | [umbrella](./2026-07-19-zai-loop-resilience-master-design.md) |
| 状态 | 设计中 → 待评审 |
| 目标交付 | Turn 入点合并 mid-turn 附件;trigger 后续 turn 的 memory prefetch |
| 工作量 | 2-3 天 |

## 0. 范围

| 在范围 | 不在范围 |
|---|---|
| `getAttachmentMessages(sessionId)` 合并后台命令输出 / agent prefetch 消息 | Skill discovery prefetch(留扩展) |
| `startRelevantMemoryPrefetch(sessionId, signal)` 返回 Disposable | Skill prefetch 接口统一(留给 Skill 集成时一起做) |
| 与 BackgroundRuntime 串联(读 task output) | 重写 BackgroundRuntime(冻结) |
| 与现有 plugin prefetch hooks 对接 | Command lifecycle notification (`consumedCommandUuids`) |

## 1. 背景与目标

zai 当前 turn 入口直接根据 `messages` 重建;**mid-turn 的后台任务输出 / sub-agent 续接 / Skill prefetch / memory prefetch** 等内容**不会自动注入下一轮**。

本 sub-spec 目标:

1. **`getAttachmentMessages(sessionId)`**:turn 入点拉取 mid-turn 期间排队的 attachment(本地 Bash 任务结束输出、Sub-agent 完成通知、Skill prefetch 资源),转 assistant message 形式注入 messages
2. **`startRelevantMemoryPrefetch(sessionId, signal)`**:turn 入点异步启动 memory 预取,返回 `Disposable`,turn 结束或信号 abort 时 dispose
3. **与 BackgroundRuntime / BashTracker 复用**:不重写,只读它们既有 API

## 2. 公共契约(冻结)

### 2.1 函数签名

```ts
// runtime/attachment/get.ts
export interface Attachment {
  source: 'background-bash' | 'background-agent' | 'skill-prefetch' | 'memory-prefetch';
  payload: AnthropicMessage;  // assistant message 形式
  consumedAt: number;
}

export interface GetAttachmentOptions {
  sessionId: string;
  fromTimestamp?: number;       // 上次拉取时间戳;不传则全部
  signal: AbortSignal;
}

export async function getAttachmentMessages(
  opts: GetAttachmentOptions
): Promise<Attachment[]>;

// runtime/attachment/prefetchMemory.ts
export interface MemoryPrefetchHandle {
  prefetched: Promise<string | null>;  // resolved with content or null on abort
  dispose(): void;                       // 取消并清理 timer / handler
}

export interface PrefetchMemoryOptions {
  sessionId: string;
  windowMs?: number;         // 默认 config.runtime.memoryPrefetchWindow = 1500
  enabled?: boolean;         // 默认 config.runtime.attachmentPrefetchEnabled
  signal: AbortSignal;
}

export function startRelevantMemoryPrefetch(
  opts: PrefetchMemoryOptions
): MemoryPrefetchHandle;
```

### 2.2 事件 / 字段 schema

无新事件。attachment 转 assistant message 注入 messages 走 `runtime.delta` 现有通道(沿用 upstream `getAttachmentMessages`)。

### 2.3 配置键(从 umbrella §3.3 引用)

| Key | 类型 | 默认 |
|---|---|---|
| `config.runtime.attachmentPrefetchEnabled` | boolean | true |
| `config.runtime.memoryPrefetchWindow` | number(ms) | 1500 |

### 2.4 错误契约

- `getAttachmentMessages` 异常 → 返 `[]`(空数组),**不抛**
- `getAttachmentMessages` source 为空 → 返 `[]`
- `startRelevantMemoryPrefetch` 内部异常 → 写到 `prefetched` Promise(不抛到外层)
- `dispose()` 立刻 resolve `prefetched` 为 `null`(若尚未完成)
- `signal` abort → 同 dispose

### 2.5 接入点

| 位置 | 调用 |
|---|---|
| queryLoop.ts turn 入点(getExistingMessages 之后,for-await 之前) | `getAttachmentMessages({sessionId, signal})` → attachment 转 assistant message 注入 messages |
| 同一位置 | `startRelevantMemoryPrefetch({sessionId, signal})` 异步起;Disposable 状态由 loop 内 stepCounter 管 |

集成 PR 阶段在 queryLoop.ts 顶端加 < 15 行 wire-in。

## 3. 行为列表

1. `getAttachmentMessages` 调用后立即返回(无后台阻塞);timeout 默认 0(同步拉取)
2. 多个 source 的 attachment 按时间戳排序后返回
3. 同一 source 内的 attachment 不去重(由 caller 决定)
4. `fromTimestamp` 缺省 → 拉 session 启动后全部
5. `startRelevantMemoryPrefetch` 立刻返回 `MemoryPrefetchHandle`,不等待 IO
6. `MemoryPrefetchHandle.dispose()` 调用后 `prefetched` 立刻 resolve `null`
7. `prefetched` resolve 在 `[windowMs]` 之后或立即(若内存已就绪)
8. `signal` abort 后 dispose 行为等价于手动 `dispose()`
9. 兼容 BackgroundRuntime:`backgroundTaskStore.listBySession(sessionId, {status:'completed'})` 拉取输出
10. 兼容 BashTracker:`bashTracker.listBySession(sessionId)` 拉取本地 Bash 输出
11. 兼容 Skill prefetch:读 `pluginSnapshot.skills` 缓存(只读)

## 4. 测试点

```
packages/zai-agent-core/test/integration/agent/resilience/d-attachment-messages.test.ts
  ✓ returns empty array when no background tasks, agents, or skill prefetches exist
  ✓ returns background-bash attachment from BashTracker
  ✓ returns background-agent attachment from BackgroundRuntime task store
  ✓ sorts attachments by consumedAt ascending
  ✓ filters by fromTimestamp (excluding items before)
  ✓ on error returns empty array (does not throw)
  ✓ properly populates AnthropicMessage shape for assistant message form

packages/zai-agent-core/test/integration/agent/resilience/d-memory-prefetch.test.ts
  ✓ startRelevantMemoryPrefetch returns handle immediately without awaiting IO
  ✓ prefetched resolves with null after dispose()
  ✓ prefetched resolves with null on AbortSignal abort
  ✓ prefetched resolves with content within windowMs
  ✓ multiple prefetches in same session don't interfere
  ✓ dispose() twice is idempotent (safe to call repeatedly)
```

## 5. 验收门

1. `pnpm --filter @zn-ai/zai-agent-core typecheck`
2. `pnpm --filter @zn-ai/zai-agent-core test test/integration/agent/resilience/d-*`
3. `pnpm --filter @zn-ai/zai-agent-core test`(全量)— auto-compact-turn-loop.test.ts 仍绿
4. 与 BackgroundRuntime / BashTracker 现有 test 共存不退化

## 6. 风险与边界场景

1. **幂等性**:同一 source 拉两次若产生重复 attachment,Agent 决定是否用 source+id 去重(建议去重)
2. **数据量大**:BackgroundRuntime 大量完成事件时,getAttachmentMessages 单次拉取可能上 MB,建议 limit 上限 100(或留 TODO)
3. **memory prefetch 与 cache**:memory 预取结果不写 cache;下次 prefetch 重新拉(local 只读)
4. **AbortSignal 时序**:signal 可能在 prefetch 完成前 abort,要求 prefetched 立即 resolve null
5. **attachment 转 assistant message 的格式**:Agent 决定 assistant message 内部 content blocks(纯 text 还是带 source 标记)— OpenCC 风格保持纯 text

## 7. 不锁定

- 内部 source 拉取实现(直接读 store 还是经 eventBus)— 自由
- attachment 转 AnthropicMessage 的具体格式 — 自由
- 测试用真 store vs mock store — 自由
- 错误日志格式 — 自由
