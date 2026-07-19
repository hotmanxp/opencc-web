# Transcript tool_use/tool_result 自动修复设计

## 背景

zai v2 transcript 用 `parentUuid` 保存消息 DAG，但 `TranscriptStore.append()` 按完成时间追加记录。后台工具延迟完成、同一 session 新 prompt 并发到达时，`tool_result` 可能出现在另一条 assistant 分支之后。

resume 当前按物理数组顺序执行 `foldTopLevelToolUses` 和 `serializeForAnthropic`，因此会把不紧跟对应 `tool_use` 的 `tool_result` 发给 Anthropic，触发 HTTP 400 / error 2013。

已确认的会话实例：`sess-455d298a-7a71-4f50-b028-e6d355c5fe70`。

## 目标

- resume 前自动识别并修复错序的 `tool_use` / `tool_result`。
- 修复结果写回原 transcript，后续 resume 不重复触发。
- 保留 canonical v2 transcript 结构，继续兼容 UI 和现有 `foldTopLevelToolUses`。
- 修复幂等；无法安全修复时不覆盖原文件。
- 不改变当前工作区中与 SSE 状态推送有关的未提交修改。

## 非目标

- 本次不实现同一 session 的完整运行时互斥锁。
- 不重构所有 transcript DAG 语义。
- 不修改 Anthropic API client 或 provider 的错误处理。

## 方案

新增 transcript repair 模块，提供纯内存修复逻辑和带文件锁的持久化入口：

```ts
type TranscriptRepairReport = {
  repaired: boolean
  repairedToolUseIds: string[]
  synthesizedToolUseIds: string[]
  droppedMessageUuids: string[]
}

function repairTranscriptToolPairs(
  messages: TranscriptMessage[],
): { messages: TranscriptMessage[]; report: TranscriptRepairReport }

async function repairAndPersistTranscript(
  store: TranscriptStore,
  sessionId: string,
): Promise<TranscriptRepairResult>
```

`TranscriptRepairResult` 同时返回修复后的 `messages` 和 `TranscriptRepairReport`；持久化入口在文件锁内重新读取 transcript、执行修复并写回，避免修复计算期间其它 append 导致 stale replace。持久化只更新现有 `meta.updatedAt`，不新增 repair-specific metadata。

## DAG 线性化算法

1. 建立 `uuid -> message`、`parentUuid -> children`、`tool_use id -> tool_use record` 和 `tool_use_id -> tool_result records` 索引。
2. 选择 active leaf：优先使用最新的非纯 `tool_result` 消息；没有时使用最新消息；timestamp 相同时取原数组中后出现的 record。通过 `parentUuid` 从 leaf 回溯到 root，得到当前有效因果链。
3. 丢弃不属于 active chain 的并发分支，记录其 UUID 到 `droppedMessageUuids`。
4. 对 active chain 中的每个 assistant：
   - 收集该 assistant 的全部 top-level `tool_use` 子记录，保留源顺序；
   - 收集这些 tool 的所有结果，不依赖结果在文件中的物理位置；
   - 输出 parent assistant、tool_use 子记录和紧邻的 tool_result user 记录。
5. 一个 assistant turn 的多个 tool 结果输出为同一条 user 消息，满足 Anthropic tool protocol。
6. 没有结果的 tool_use 生成新的 user `tool_result`：`is_error: true`，内容固定为 `Transcript repair: tool execution did not complete.`；其 `parentUuid` 指向对应 tool_use 记录，并记录到 `synthesizedToolUseIds`。
7. 普通 user、assistant、system 和 attachment 记录保留在 active chain 中；tool_use/tool_result 记录只在上述 canonical 位置输出，避免重复。
8. 运行协议校验：每个 `tool_result.tool_use_id` 必须出现在紧邻的前一个 assistant 内容中；角色顺序不能出现 tool_result 后再插入普通 user。校验失败则返回原消息，不落盘。

## 集成点

`runtime/queryLoop.ts` 在读取 resume transcript 后：

1. 调用 `repairAndPersistTranscript(store, resumeId)`。
2. 使用修复后的 transcript 重新读取或复用修复结果。
3. 继续执行现有 `foldTopLevelToolUses` 和 `serializeForAnthropic`。
4. 通过 `ZAI_DEBUG=1` 输出 repair report，正常模式不增加用户可见噪声。

## 测试

新增/扩展测试覆盖：

- 延迟 tool_result 在另一条分支之后：修复后紧跟对应 tool_use。
- 普通 user prompt 插入 tool_use 与 tool_result 之间：修复后 user prompt 位于已完成 tool turn 之后。
- 多个并行 tool_use、结果乱序：结果合并到一条 user 消息且 ID 全部匹配。
- 未完成 tool_use：生成 `is_error=true` 恢复结果。
- 不相关分支被丢弃并记录 UUID。
- 修复结果可重复执行且第二次不再写盘。
- 修复失败时原 transcript 不变。
- `queryLoop` resume 集成测试确认最终 API messages 不再出现 2013 形状。

验证命令：

```bash
cd packages/zai-agent-core
pnpm vitest run test/transcript/ test/runtime/
pnpm typecheck
```

实际执行时按仓库现有 package scripts 选择对应的 `pnpm` 命令，不触碰已有未提交文件。
