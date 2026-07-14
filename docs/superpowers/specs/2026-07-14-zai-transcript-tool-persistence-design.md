# zai transcript 工具调用 / 结果完整可重放 设计文档

- **状态**：待评审
- **日期**：2026-07-14
- **作者**：OpenCC brainstorming session
- **范围**：`packages/zai-agent-core`（transcript schema + 写入路径）、`packages/zai`（server routes + 前端 loadTranscript）

## 1. 背景与动机

zai 当前把 tool_use 折叠进 assistant 消息的 `raw.tool_uses: [{id, name, input}]` 字段，且完全不写 tool_result（`packages/zai-agent-core/src/runtime/queryEngine.ts:413` `appendAssistantMessage`）。后果：

- 历史会话刷新后 `useAgentStore.loadTranscript` 看不到工具卡片；
- 不能跨进程 resume：模型拿不到历史 tool_result，强制 reset 上下文；
- 丢失 `is_error` 与执行耗时。

OpenCC 上游每个事件独立落 `SerializedMessage`，user 消息携带 `tool_result` block，assistant 消息携带 `text`/`thinking`/`tool_use` block 的 `ContentBlock[]`（`packages/zai-agent-core/src/opencc-internals/types/logs.ts:250` + `types/message.ts:45`）。`opencc-internals/QueryEngine.ts:173` 在事件循环里逐条 append。

本次改造让 zai 与 OpenCC 对齐。

## 2. 决策摘要

| 决策 | 选择 |
|------|------|
| 核心目标 | 完整可重放 |
| Schema 演进 | 换 OpenCC 风格（`SerializedMessage` + `ContentBlock[]`），TranscriptFile.version 1 → 2 |
| Resume | 本次一并实现（queryEngine 启动时 store.read → 拼 Anthropic messages） |
| 数据迁移 | 不迁移；v1 read 失败时降级为空 messages，旧会话仅显示文本 |
| 工具结果压缩 | 复用 `opencc-internals/services/api/compressToolHistory.ts` 三级压缩 |
| 文件格式 | 保持 `.json` 单文件（不改 JSONL），便于 `list()` 性能 |
| 架构方案 | 方案 A：zai-agent-core 内复用 opencc-internals QueryEngine 写入路径 |

## 3. 架构总览

```
zai queryEngine (runtime/queryEngine.ts)
  store = new TranscriptStore(dataDir)
  if options.resumeFromTranscriptId:
    try: t = await store.read(id)            // v2
         initialMessages = serializeForAnthropic(t.messages)
    catch LegacyTranscriptError:             // v1 或损坏
         initialMessages = []                // 不报错，前端显示 "历史不可读"

  for each SDK event in submitMessage():
    case content_block_start{tool_use}:
      appendToolUse(parentUuid=turn.user.uuid)        // → store.append type=tool_use
    case content_block_stop{tool_use} 同 turn 末尾:
      appendAssistantMessage(message.content=[...blocks])   // 含 text/thinking/tool_use
    case tool 执行完成 (toolExecution.ts 返回 {output, isError}):
      output = compressToolHistory.compressToolResult(rawOutput, turnIdx)
      appendToolResult(parentUuid=对应 tool_use.uuid, is_error=isError)  // → store.append type=user
    case user prompt 入站:
      appendUserMessage (扩为 v2 schema)

zai useAgentStore.loadTranscript
  for each msg:
    if msg.type === 'tool_use'      → emit tool_use:start
    if msg.type === 'tool_result'   → upsert 上一条 tool_use 的 output / error
    if msg.type === 'assistant' && message.content: ContentBlock[]
                                     → 按顺序 emit thinking / text / tool_use:start
    fallback (LegacyTranscriptError): 走 v1 raw.tool_uses 旧逻辑
```

### 模块边界

| 文件 | 角色 |
|------|------|
| `packages/zai-agent-core/src/transcript/types.ts` | v2 schema 定义（ContentBlock / SerializedMessage 风格 TranscriptMessage） |
| `packages/zai-agent-core/src/transcript/serialization.ts` | v2 serialize / deserialize；`LegacyTranscriptError` 抛出 v1 |
| `packages/zai-agent-core/src/transcript/store.ts` | 不变；append/read 继续走 proper-lockfile |
| `packages/zai-agent-core/src/runtime/queryEngine.ts` | 新增 `appendToolUse` / `appendToolResult` / `serializeForAnthropic`；调用 `compressToolHistory` |
| `packages/zai-agent-core/src/opencc-internals/services/api/compressToolHistory.ts` | 复用，不改 |
| `packages/zai/src/web/src/store/useAgentStore.ts` | `loadTranscript` 增加 tool_use / tool_result / ContentBlock[] 三个分支；保留 v1 fallback |

## 4. Schema 设计

### ContentBlock（对齐 OpenCC `message.ts:45`）

```ts
type ContentBlock =
  | { type: 'text'; text: string }
  | { type: 'thinking'; thinking: string }
  | { type: 'tool_use'; id: string; name: string; input: unknown }
  | { type: 'tool_result'; tool_use_id: string; content: unknown; is_error: boolean }
```

### TranscriptMessage（对齐 OpenCC `logs.ts:250`）

```ts
type TranscriptMessage = {
  uuid: string
  parentUuid: string | null
  type: 'user' | 'assistant' | 'tool_use' | 'tool_result' | 'system' | 'attachment'
  timestamp: number
  // message 形态对齐 OpenCC SerializedMessage
  message: { content: string | ContentBlock[]; role?: 'user' | 'assistant' }
  // OpenCC 元字段
  cwd: string
  userType: string           // 'zai'
  sessionId: string
  version: string            // '2'
  gitBranch?: string
  slug?: string
  isSidechain: boolean
  // zai 已有
  runtime?: { turnIndex: number; costUsd?: number }
}
```

`TranscriptFile.version` 升 `2`。`TranscriptMeta` 加 `version: number`，`list()` 过滤时 v1 文件仍展示但前端知道不可重放工具。

### 写入函数

```ts
async function appendToolUse(
  store: TranscriptStore,
  sessionId: string,
  block: { id: string; name: string; input: unknown },
  turnIndex: number,
  parentUuid: string,
): Promise<void>                        // type='tool_use', message.content=[block]

async function appendToolResult(
  store: TranscriptStore,
  sessionId: string,
  block: { tool_use_id: string; content: unknown; is_error: boolean },
  turnIndex: number,
  parentUuid: string,
): Promise<void>                        // type='user', message.content=[tool_result block]

async function appendAssistantMessage(
  store: TranscriptStore,
  sessionId: string,
  blocks: ContentBlock[],               // text + thinking + tool_use
  turnIndex: number,
  parentUuid: string,
): Promise<void>                        // type='assistant'
```

### serializeForAnthropic

把 v2 TranscriptMessage[] 转 Anthropic SDK `{role, content: ContentBlock[]}`：

- `msg.type='user' && message.content` 含 tool_result → 同一 user role 多 block
- `msg.type='assistant' && message.content` 是数组 → role=assistant，content=blocks
- `msg.type='user' && message.content` 是 string → role=user，content=[{type:'text', text}]
- 顺序按 uuid 链还原（同 turn 内按 uuid 时序）

## 5. Resume 实现细节

### queryEngine 启动（`runtime/queryEngine.ts`）

```ts
let initialMessages: Array<{ role: 'user' | 'assistant'; content: unknown }> = []
if (options.resumeFromTranscriptId) {
  try {
    const t = await store.read(options.resumeFromTranscriptId)
    initialMessages = serializeForAnthropic(t.messages)
  } catch (err) {
    if (err instanceof LegacyTranscriptError) {
      // v1 文件 — UI 显示文本，模型从空开始
    } else {
      throw err                              // 损坏的 v2 文件 → 让上层报错
    }
  }
}
```

### 父子链维护（`wrapWithZaiMeta` 流式循环）

- turn 开始：取 `turn.userUuid = randomUUID()`，appendUserMessage 后 `parentUuid = options.resumeFromTranscriptId ? 上 turn 最后 uuid : null`
- content_block_start{tool_use}：该 turn 内 uuid 顺序 +1
- tool_result：parentUuid = 对应 tool_use 的 uuid
- assistant 文本/thinking 块结束：appendAssistantMessage，content 数组含本 turn 所有 blocks，parentUuid = turn.userUuid

## 6. UI 回放（useAgentStore.loadTranscript）

```ts
for (const msg of transcript.messages) {
  if (msg.type === 'tool_use') {
    messages.push({
      ...base, eventId: msg.uuid,
      type: 'tool_use:start',
      toolUseId: msg.message.content[0].id,
      name: msg.message.content[0].name,
      input: msg.message.content[0].input,
    })
  } else if (msg.type === 'tool_result') {
    const tr = msg.message.content[0]
    const idx = messages.findIndex(m => m.toolUseId === tr.tool_use_id)
    if (idx >= 0) {
      messages[idx] = {
        ...messages[idx],
        type: tr.is_error ? 'tool_use:error' : 'tool_use:done',
        output: tr.content,
        error: tr.is_error ? tr.content : undefined,
      }
    }
  } else if (msg.type === 'assistant' && Array.isArray(msg.message.content)) {
    // 按 block 顺序 emit thinking / text / tool_use:start
  } else {
    // v1 fallback 或 system / attachment 维持现有行为
  }
}
```

旧 v1 路径（`raw.tool_uses` 数组）保留在 else 分支。

## 7. 错误处理

| 场景 | 行为 |
|------|------|
| `appendToolUse` / `appendToolResult` 写盘失败 | `catch` 吞掉，不阻断对话；`ZAI_DEBUG=1` 时 console.error |
| `store.read` v1 文件 | 抛 `LegacyTranscriptError` → queryEngine initialMessages=[]，UI 显示 "历史工具不可读" |
| `store.read` v2 文件损坏 | JSON.parse 失败 → 抛 SyntaxError，queryEngine 上层捕获返回错误 |
| `compressToolHistory` 异常 | 单条 tool_result 退化为不压缩，原样写入 |

## 8. 测试策略

`packages/zai-agent-core/test/transcript/` 新增：

- `store-v2.test.ts`：写入 user/assistant/tool_use/tool_result 四种类型各一条，read 后字段一致；proper-lockfile 并发写入不丢消息
- `serialize-v2.test.ts`：ContentBlock[] ↔ Anthropic SDK 双向转换；v1 fixture 抛 LegacyTranscriptError
- `compress-tool-result.test.ts`：复用 compressToolHistory 已有测试覆盖；新加 zai wrapper 在 0/中/远 turn 行为
- `queryEngine-resume.test.ts`：mock TranscriptStore.read，验证 resume 把 tool_use + tool_result 拼进 Anthropic messages

`packages/zai/src/web/src/store/useAgentStore.test.ts`（如有）：
- v2 transcript fixture 还原 tool_use:start → tool_use:done 顺序；tool_error 标红

## 9. 不在范围

- v1 → v2 数据迁移
- skill_injection 之外的新特殊 message type
- transcript 从 .json → .jsonl
- microCompact / token-level 压缩（zai 暂不达 OpenCC 量级）
- Sidebar 列表过滤 v1 提示（只展示 messageCount 即可，详情里不再展开历史工具）

## 10. 风险与回滚

- **风险**：zai 的 `wrapWithZaiMeta` 在外层做了事件级包装，与 opencc-internals QueryEngine 内部的 messages 维护路径并存，parentUuid 链需要小心避免重复维护。
- **缓解**：append 调用全部集中在 zai runtime 层（zai 的 query.ts/queryEngine.ts），不动 opencc-internals 的 QueryEngine；新加 `serializeForAnthropic` 隔离 v2 ↔ Anthropic 转换。
- **回滚**：v1 store.append 路径不动（`appendUserMessage` / `appendAssistantMessage` 旧版保留作为 `appendLegacyAssistantMessage`），通过 env `ZAI_TRANSCRIPT_VERSION=1` 临时回退（不在首次实现里做，预留口子）。

## 11. Implementation status

Implemented via `docs/superpowers/plans/2026-07-14-zai-transcript-tool-persistence.md`.
Tasks 1–7 landed; v1 files degrade silently via LegacyTranscriptError; v2 resume round-trips.
Carry-forward items (out of scope for this plan):
- compressToolHistory passthrough (transitive deps missing in zai-agent-core fork) — Task 3 follow-up
- Layout.tsx + index.css sidebar UI tweak bundled accidentally, reverted in 262ef46
- Tool execution error path not yet integrated with the new persistence layer (Task 6 covers the happy path; error path is best-effort passthrough)