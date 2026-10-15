# 接线：手动 `/compact` 切换到 vendor `compactConversation`

> 生成时间: 2026-10-08
> 仓库: `/Users/liangxuechao572/code/zn-ai-zbuddy`
> 状态: **规划中，待用户评审**（尚未写任何实现代码）
> 前序交接: `.agent_working_dir/handoff/fix-snip-and-autocompact-threshold-2026-10-08.md` 事项 #12（评估时结论「不建议切回 vendor」）

---

## 0. TL;DR

前序交接文档 #12 判定「手动压缩切回 vendor `compactConversation`」有**三个硬障碍**，建议不做。本次复核代码后：**三个障碍里有两个已经不成立**，第三个的成本也被高估了。

| 阶段 | 内容 | 风险 | 工作量 |
|------|------|------|--------|
| **P0** | 摘 `runPostCompactCleanup` + `suppressCompactWarning` 到手动路径 | 低 | 几行 |
| **P1** | 从主入口导出 vendor 压缩原语 + 抽出共用的 `ToolUseContext` 构造 | 中 | 1 天 |
| **P1.5** | **手动压缩落盘格式追平 vendor**（`preservedSegment` 锚点） | 中 | 0.5 天 |
| **P2** | `/compact` 改调 vendor 摘要生成，格式用 P1.5 的新形状 | 中高 | 1-2 天 |
| **P3（可选）** | 统一自动/手动**落盘机制** | 高 | 需先解决 UI 刷新 |

**核心设计判断：换「摘要怎么生成」+ 对齐「盘上格式」，暂不换「谁执行写盘」。** 磁盘实证（§1.2）显示 zai 的 JSONL 是 vendor 环与 zai 侧共同写入的，自动压缩已经走 vendor 落盘；手动压缩却用 `store.replace()` 整文件覆盖，**反而破坏了 vendor 的增量链**——它写的 boundary 没有 `compactMetadata.preservedSegment`，导致 vendor 读取时的保留段分支永远走不到（§2.3）。

因此推荐**先追格式、后议机制**：P1.5 让手动压缩也写 vendor 风格 boundary，代价小、测试不破；P3 再评估是否让写盘也交给 vendor 环，前提是先解决 §6.1 的 UI 刷新问题。

---

## 1. 现状

### 1.1 两套实现并存

| 路径 | 入口 | 摘要生成 | 落盘 |
|------|------|---------|------|
| **自动**（已接线） | `compat/repl/createReplSession.ts:66` → `query()` → `query.ts:976 deps.autocompact` → `autoCompact.ts` → `compactConversation` | vendor | ✅ **vendor 环写盘**（`query.ts:1051` `buildPostCompactMessages` → yield → 落盘） |
| **手动**（本次目标） | `/api/command` → `getCommandRegistry()` → `commands/builtin/compact.ts:125` | zai 手写（342 行） | ⚠️ `store.replace()` **整文件覆盖** |

> **规划期修正（2026-10-08）**：本节初稿写「自动路径 vendor 不落盘」，**该结论错误**，源于误信 `legacyTranscriptStore` 的过期注释。见 §1.2 磁盘实证。

`autoCompact.ts` 里 `compactConversation` 是被 `deps` 间接调用的，所以 `grep autoCompactIfNeeded` 搜不到调用点 —— 排查时容易误判为「自动路径没接 vendor」。

### 1.2 落盘拓扑（磁盘实证，2026-10-08）

对真实 transcript `sess-1791442115572-vtxow5uw.jsonl`（214 行）做类型统计：

```
assistant                131   ← 含 71 个 tool_use
user                      75
file-history-snapshot      5
session-meta / custom-title / last-prompt   3
```

**JSONL 由两方共同写入**：

```
vendor 环  ──写──►  JSONL   user / assistant / tool_use / tool_result
                         （自动压缩的 postCompactMessages 也走这条，约占 96%）
zai 侧     ──写──►  JSONL   session-meta / custom-title / last-prompt
                         + 可见 slash 指令行（appendMessageEntry 通道）
                         + /compact 与 /clear 的整文件覆盖（replace）
zai 侧     ──读──►  JSONL   read / list —— 唯一读回通道
```

**`legacyTranscriptStore` 的准确定性**（它的文件名有严重误导性）：

| 事实 | 证据 |
|---|---|
| **不是** stub | `read/writeEntries/patch/replace/create/list` 全部真实实现，30+ 处活跃调用 |
| **不是** 死代码 | 名字里的 "legacy" 指 compat 层出身，非"已弃用" |
| `append()` 单独 no-op | 消息行归 vendor 环写，该方法注释是**唯一准确**的一条 |
| `sessionFacade` **未接入** | zai 侧零调用，仅注释提及；`compact()` 只读不压缩 |

> 本节四个结论已写回代码注释：`src/index.ts`、`agentRuntime.ts`、`sessionFacade-impl.ts`、`sessionFacade.ts`。

### 1.3 zai 手写版的已知短板

对照 vendor `commands/compact/compact.ts` 的参考实现，zai 版缺：

| 能力 | vendor | zai 手写版 |
|------|--------|------------|
| PreCompact / PostCompact hooks | ✅ | ❌ 无接口 |
| PTL（prompt-too-long）自愈重试 | ✅ `truncateHeadForPTLRetry` + 3 次 | ❌ 单次，超时即报错 |
| microcompact 前置 | ✅ | ❌ |
| `runPostCompactCleanup` 缓存清理 | ✅ | ❌ **缓存状态可能残留** |
| `suppressCompactWarning` | ✅ | ❌ |
| 保留策略 | 边界计算 + `preservedSegment` 锚点 | 硬编码「最后 2 条 user/assistant」 |
| 摘要 prompt | vendor 英文 prompt | zai 自定义中文 prompt（≤800 字） |
| tool_result 截断 | vendor 侧策略 | 硬编码 500 字节 |
| **落盘方式** | 增量 append，保留段原 `parentUuid` 落盘 | **整文件覆盖**，破坏 vendor 增量链 |

### 1.4 死代码

`src/compat/runtime/compactService.ts`（216 行）是 v0 遗留 shim，注释自述「legacy callers (none in production)」，其 `compactSession` 需要显式 `modelCaller` 注入 —— 而 `da5956c3` 已移除 zai 自建 `modelCaller`，故恒报「未配置」。**本次接线完成后应一并删除**（`grep` 确认零生产调用方后）。

**注意区分**：`sessionFacade-impl.ts` 也是死代码（未接入），但它与 `compactService.ts` 性质不同 —— 前者是「未来可能启用」的新 API，后者是「已被重写取代」的旧实现。清理时不要一锅端。

---

## 2. 障碍复核（对比交接文档 #12）

### 2.1 障碍一「主入口未导出」—— **仍成立，但成本远低于预估**

核实：`src/bundle-entry.ts` 里 compact 相关只有一段注释，**无任何 compact 符号导出**。`compactConversation` 及其依赖（`compact.ts` 1848 行 + 一串 transitive）确实不在主入口。

**但这不是死路**：`bundle-entry.ts` 的模式就是聚合 re-export，加导出是机械工作。真正的问题是导什么、导多少 —— 见 §4.1 的取舍。

### 2.2 障碍二「`ToolUseContext` 无法构造」—— **已不成立**

交接文档说「内部用 31 处 context 成员，其中 `setStreamMode` / `setSDKStatus` / `setResponseLength` 是终端 Ink UI 状态控制，zai 是 Web 无 TTY 只能 stub」。

复核结论：**stub 就够了，而且这个 stub 已经在生产跑了。**

`compat/repl/createReplSession.ts:486-544` 就在每次 REPL turn 里构造一个真 `toolUseContext` 并喂给 vendor `query()`，其中：

```ts
setResponseLength: () => {},     // 正是交接文档点名"无法构造"的三个之一
setInProgressToolUseIDs: () => {},
updateFileHistoryState: () => {},
updateAttributionState: () => {},
getAppState: () => ({ ...host, toolPermissionContext: { mode: 'default', ... } }),
```

且注释（515-523 行）记录了踩坑史：早期不补 `toolPermissionContext` 防御默认值时，第一个纯文本 prompt 就崩在 `Cannot read properties of undefined (reading 'mode')`。这说明这条路已经被踩通并固化了。

对照 §2.2 附表，vendor `compact.ts` 实际用到的 context 成员是收敛的：

| 成员 | 用量 | zai 侧现状 |
|------|------|-----------|
| `context.options` | 30 | ✅ 已有 |
| `context.onCompactProgress` | 14 | ⚠️ 可选调用 `?.`，不提供即 no-op |
| `context.agentId` | 10 | ✅ 已有（`undefined` 即可） |
| `context.abortController` | 8 | ✅ 已有 |
| `context.setResponseLength` | 6 | ✅ no-op stub |
| `context.setStreamMode` | 5 | ⚠️ 需确认是否 optional |
| `context.setSDKStatus` | 5 | ✅ 已有（部分 `?.`） |
| `context.getAppState` | 5 | ✅ 已有带防御默认值 |
| `context.readFileState` | 4 | ✅ 已有 |
| `context.queryTracking` | 2 | ⚠️ 可选 |
| `context.loadedNestedMemoryPaths` | 2 | ⚠️ 需确认 |
| `context.addNotification` | 1 | ⚠️ 可选 |

**结论**：不需要新造 context，**复用 `createReplSession` 的构造逻辑**即可（P1 的核心动作是把它抽成可复用函数，而不是各写一份）。

### 2.3 障碍三「落盘语义不兼容」—— **仍成立，但成本比原估低（规划期修正）**

核实无误：
- `compact.ts:755` 与 `compact.ts:1111` 两处 `void sessionTranscriptModule?.writeSessionTranscriptSegment(messages)` **都在 `if (false)` 里** → vendor `compactConversation` 返回 `CompactionResult` 后**自己不写文件**。
- vendor 靠 `processSlashCommand.tsx` 的返回值由上层 `query()` 接管（把 `summaryMessages` 塞回消息流并由 vendor 环落盘）。zai 走 `/api/command` → `getCommandRegistry()`，**不经过该路径**。

**规划期修正**：本节初稿断言「自动压缩 vendor 不落盘」，据此推断追随成本极高。磁盘实证（§1.2）推翻了这个前提 —— **自动压缩的 `postCompactMessages` 确实落盘，经 vendor 环写入**。这意味着 vendor 的落盘机制在 zai 里**是可运行的生产代码**，而非死代码。

真正的不兼容点收敛为一个，且比原先具体：

> **zai 的 `replace()` 是整文件覆盖，vendor 是增量 append + `preservedSegment` 锚点。**
>
> 证据在 `sessionStoragePortable.ts:588-600`：
> ```ts
> if (hit?.hasPreservedSegment) {
>   s.hasPreservedSegment = true      // 保留段：不截断，整段读
> } else if (hit) {
>   s.out.len = 0                     // 无保留段：boundary 之前全部丢弃
>   s.boundaryStartOffset = s.bufFileOff
> }
> ```
> vendor 靠 boundary 行里的 `compactMetadata.preservedSegment` 字段区分两种语义。而 zai 现在写的 boundary（`builtin/compact.ts:277-295`）**根本没有 `compactMetadata` 字段** —— 它用整文件覆盖绕过了这个分支，于是 `preservedSegment` 分支在 zai 里**永远走不到**。

补充调研发现（交接文档未提）：

> **`SessionFacade` 已有 `compact(sessionId)` 方法，但它只读取不压缩。**
> `sessionFacade-impl.ts` 的实现是 `readTranscriptForLoad()` 拿 `boundaryStartOffset` / `hasPreservedSegment`，纯粹读文件。**命名极具误导性**，接线时极易误以为「facade 已经会压缩了」。已在该文件与 `sessionFacade.ts` 加了警示注释。

### 2.4 「能否追随 vendor 落盘」—— 分层结论

「落盘语义」实际是两件事，拆开后可行性天差地别：

| 层 | vendor 怎么做 | 追随可行性 |
|---|---|---|
| **盘上格式** | `compact_boundary` 行 + `messagesToKeep` 保留原 `parentUuid` + `preservedSegment` 锚点 | ✅ **可行且成本低** —— zai 已在用同一套 JSONL |
| **谁执行写盘** | `query()` 消费 yield 后由 vendor 会话层 append | ❌ 不能直接复用 —— zai 不走那条路 |

**建议：先「格式追随」，后评估「机制追随」。**

手动压缩的落盘从 `store.replace()` 整文件覆盖，改为写 vendor 风格的 boundary（带 `compactMetadata.preservedSegment`，`messagesToKeep` 保留原 `parentUuid`）。收益：

- 盘上格式与 vendor 对齐 → 未来若切真 vendor 机制，格式已就位
- `preservedSegment` 分支真正被用上（现在 zai 写的 boundary 走的是「永远截断」语义）
- 不碰 `replace()` 的整文件覆盖语义 → 既有测试不破

「机制追随」（让手动压缩也走 `query()` 内部路径）留到 P3，**前提是先解决 §6.1 的 UI 刷新问题**，否则改完用户看不到效果。

### 2.5 复核小结

| 障碍 | 交接文档判断 | 复核结论 | 依据 |
|------|------------|---------|------|
| 主入口未导出 | 硬障碍 | **仍成立，成本可控** | `bundle-entry.ts` 无 compact 导出 |
| `ToolUseContext` 无法构造 | 硬障碍 | ❌ **已不成立** | `createReplSession.ts:486` 已有生产可用实例 |
| 落盘语义不兼容 | 硬障碍 | ✅ **仍成立，但成本被高估** | 机制差异真实（§2.3），但 vendor 落盘在 zai 里是生产可运行的（§1.2） |

---

## 3. 方案选型

### 3.1 候选 A：全量切回 vendor（含落盘机制）

让手动压缩也走 vendor `query()` 内部路径，由 vendor 会话层统一写盘。

- ⚠️ **暂缓，不否决**。规划期初稿直接否决，理由是「`summaryMessages` 跨形状翻译风险高」——该理由仍成立。但磁盘实证（§1.2）显示 vendor 落盘机制在 zai 里是**生产可运行的**，不是死代码，所以否决依据不足。
- 移入 P3，**前提是先解决 §6.1 的 UI 刷新问题**：改完若 UI 不刷新，用户无法感知，等于没做。

### 3.2 候选 B：换摘要生成 + 格式追平 vendor（**推荐**）

```
/compact → compactViaVendor(messages, ctx, cacheSafeParams, customInstructions)
         → CompactionResult { summaryMessages, boundaryMarker, messagesToKeep, ... }
         → zai 侧提取 summary 文本
         → 写 vendor 风格 boundary（带 compactMetadata.preservedSegment）
         → store.replace([boundary, summary, ...keptRecent])   ← 写入机制不变，格式变
```

- ✅ vendor 拿到 hooks / PTL 自愈 / microcompact / 缓存清理 / vendor 保留策略
- ✅ 盘上格式与 vendor 对齐，`preservedSegment` 分支真正生效（§2.3）
- ✅ 写入机制零变更，`replace()` 语义（`legacyTranscriptStore.ts:523-533`）保持，既有测试不破
- ✅ 可回滚：保留现实现作为 feature flag 后备
- ⚠️ 需处理「vendor 保留策略 vs zai 硬编码 2 条」的取舍（§4.3）

### 3.3 候选 C：只换摘要生成，落盘格式不动

初稿方案。写盘仍是 zai 自造的 boundary（无 `compactMetadata`）。

- ⚠️ 可行但**次优**。改动最小，然而 zai 写的 boundary 永远走 vendor 的「截断」分支，`preservedSegment` 机制形同虚设；未来若切 vendor 机制还得再改一次格式。
- **降级为 B 的子集**：若 P1.5（格式追平）实测有风险，可先只做 C 保底。

### 3.4 候选 D：维持现状

- ❌ 不符合用户诉求。

**选定候选 B。**

---

## 4. 设计

### 4.1 主入口导出（zn-agent-core 侧）

在 `src/bundle-entry.ts` 增加导出。**关键取舍：导出 `compactConversation` 本体，还是导出一个已接好线的 wrapper？**

**建议：导出 wrapper，不导出本体。**

理由：`compactConversation` 有 6 个位置参数，其中 `cacheSafeParams` 需要 `getSystemPrompt` / `getUserContext` / `getSystemContext` 三个异步依赖（参考 `commands/compact/compact.ts:263-300` 的 `getCacheSharingParams`）。裸导出等于把「怎么拼 cacheSafeParams」这个易错细节推给 zai 调用方。

新增 `src/compat/compact/compactBridge.ts`：

```ts
export type CompactViaVendorOptions = {
  messages: Message[]           // zai transcript 读出的原始消息
  toolUseContext: ToolUseContext
  querySource?: QuerySource
  customInstructions?: string
  microcompact?: boolean        // 默认 true，对齐 vendor 参考实现
}

/** 返回 vendor CompactionResult 的摘要视图；失败时抛原始错误由 zai 侧翻译。 */
export type CompactViaVendorResult = {
  summary: string
  preCompactTokenCount: number
  postCompactTokenCount: number
  compactionUsage?: {...}
  userDisplayMessage?: string
}

export async function compactViaVendor(opts): Promise<CompactViaVendorResult>
```

内部照搬 `commands/compact/compact.ts` 的调用序列（`microcompactMessages` → `getCacheSharingParams` → `compactConversation`），并**在 `compactConversation` 返回后立即跑 `runPostCompactCleanup()` + `suppressCompactWarning()`** —— 这两条正是 vendor 参考实现在命令层做的事，vendor `compactConversation` 自己不做。

> ⚠️ 需核对：`commands/compact/compact.ts` 里 `setLastSummarizedMessageId(undefined)` 也需要一并摘出来（legacy 压缩替换全部消息后旧 UUID 失效）。这个符号在 `services/SessionMemory/sessionMemoryUtils.js`，也要确认导出面。

### 4.2 zai 侧 ToolUseContext 复用（P1）

**不要在 `compact.ts` 里重写一份 context。** 从 `createReplSession.ts:486-544` 抽出 `buildReplToolUseContext(opts)` 放到 `compat/repl/`，两处共用。

理由：那份 context 的防御默认值（`toolPermissionContext` 哨兵等）是踩坑换来的，复制一份就多一份漂移风险。

需要的额外成员：
- `onCompactProgress` —— 把 vendor 的 `hooks_start` / `compact_start` / `compact_end` 透传到 zai 的 eventBus，让 Web UI 能显示压缩进度。**这是本次接线的用户可见收益之一**，但可延后到 P2.5。
- `setStreamMode` / `setSDKStatus` / `setResponseLength` —— 全部 no-op stub。

### 4.3 落盘：保留策略的取舍（**需用户决策**）

vendor 的 `compactConversation` 内部会算一个「保留最近 N 条」并把结果放进 `summaryMessages`，且这些消息**保留原 `parentUuid` 落盘**（`annotateBoundaryWithPreservedSegment` 的注释明说「Preserved messages keep their original parentUuids on disk (dedup-skipped)」），再由 boundary 的 `preservedSegment` 锚点告诉 loader 怎么重新链接。

而 zai 现在的落盘是**自己**决定保留段的（`compact.ts:251-264`，硬编码最后 2 条 user/assistant），且因为走整文件覆盖，保留段的 `parentUuid` 被 `replace()` 连同旧消息一起丢掉了。

三种选择：

| 选项 | 说明 | 评价 |
|------|------|------|
| **B1 保持 zai 现状** | vendor 只出摘要文本，保留段仍由 zai 算 | 风险最低，但保留策略与 vendor 不一致（zai 的「2 条」可能过少，丢掉刚发生的工具往返） |
| **B2 用 vendor 的边界** | 从 `summaryMessages` 反推保留段 | 语义正确，但需要理解 `buildPostCompactMessages` 内部构造，跨形状翻译风险 |
| **B3 折中（推荐）** | vendor 边界只用作参考，实际保留段仍由 zai 算，但保留条数从 2 提到更合理的值，并按 P1.5 补上 `preservedSegment` 锚点 | 折中，保留 zai 对 transcript 形状的掌控，同时让 vendor 的保留段机制真正生效 |

**D1 决策已有答案**：既然 vendor 已提供 `messagesToKeep` + `preservedSegment` 的完整范式，**没有理由继续用硬编码的「2 条」**。P1.5 应把保留段计算提出来做成可配置常量（默认从 2 提到能覆盖最近一次完整工具往返的量级），并让 `parentUuid` 链保持连续。

**仍需用户确认一件事**：zai 的「2 条」当初是刻意选的（`compact.ts:252` 注释：「压缩后对话上下文不丢末尾的最新约束/决策」）还是随手写的默认值。**此项不阻塞 P0/P1。**

**倾向 B3**，但需要先确认一件事：zai 的「2 条」当初是刻意选的（`compact.ts:252` 注释：「压缩后对话上下文不丢末尾的最新约束/决策」）还是随手写的默认值。**这一项列为待确认，不阻塞 P0/P1。**

### 4.4 摘要语言

zai 现在强制**中文摘要**（`COMPACT_SUMMARY_SYSTEM_PROMPT`，≤800 字），vendor 用英文 prompt + 无字数上限。

**需用户决策**：切回 vendor 后摘要语言会变英文。这对中文用户是体验回退。选项：
- 用 vendor 的 `customInstructions` 参数传中文约束（vendor `compactConversation` 第 5 个参数就是为此设计的，支持 `mergeHookInstructions`）——**推荐**，零成本保留中文。
- 接受英文摘要。

> 交接文档 #6 提到 `compactConversation(messages, context, cacheSafeParams, suppressFollowUpQuestions, customInstructions, isAutoCompact, recompactionInfo)`，第 5 位 `customInstructions` 正是这个用途。

### 4.5 错误语义翻译

vendor 抛的错误是英文常量（`ERROR_MESSAGE_NOT_ENOUGH_MESSAGES` / `ERROR_MESSAGE_INCOMPLETE_RESPONSE` / `ERROR_MESSAGE_USER_ABORT`），zai 现在返回中文。需要在 zai 侧做一层映射，保持 Web UI 文案不变。

### 4.6 架构图

```
Web UI  /compact
    │
    ▼
POST /api/command ──► commands/builtin/compact.ts
    │
    ├─ store.read(sessionId)  ──────────────────────► 现有逻辑保留
    │                                                    （< 2 条校验）
    ▼
  compactViaVendor()                    ◄── 新增，zn-agent-core compat 层
    │
    ├─ buildReplToolUseContext()                     复用 createReplSession 的
    │                                                 既有构造（不重写，见 §4.2）
    ├─ microcompactMessages(messages, ctx)          vendor
    ├─ getCacheSharingParams(ctx, messages)         vendor（getSystemPrompt 等）
    ├─ compactConversation(...)                     vendor ★ 本次接入
    ├─ runPostCompactCleanup(querySource)           vendor（P0 摘出）
    └─ suppressCompactWarning()                     vendor（P0 摘出）
    │
    ▼
  CompactionResult ──► 提取 summary 文本 + messagesToKeep + token 统计
    │
    ▼
  构造 vendor 风格 boundary                            ◄── P1.5 新增
  （带 compactMetadata.preservedSegment 锚点，
    保留段沿用原 parentUuid）
    │
    ▼
  store.replace([boundary, summary, ...keptRecent])  ◄── 写入机制不变
    │
    ▼
  { kind: 'compacted', removedMessages, summary }  ──► UI（契约不变）
```

---

## 5. 任务拆解

### P0 — 缓存清理补齐（低风险，独立可交付）

- [ ] P0-1 从 `bundle-entry.ts` 导出 `runPostCompactCleanup` / `suppressCompactWarning`
- [ ] P0-2 在 `builtin/compact.ts` 现有实现末尾调用两者
- [ ] P0-3 跑 `builtin.compact.disk.test.ts` 等相关测试

> 收益：即使 P1/P2 全部推迟，手动压缩的缓存残留问题也解决了。**这是本次最低成本、最高确定性的收益。**

### P1 — 接线基础设施（中风险）

- [ ] P1-1 从 `createReplSession.ts` 抽出 `buildReplToolUseContext()`，两处共用（不改行为）
- [ ] P1-2 新建 `compat/compact/compactBridge.ts`，含 `compactViaVendor()`
- [ ] P1-3 `bundle-entry.ts` 导出 bridge
- [ ] P1-4 单元测试：叶子模块可测性优先（参照 `autoCompactThreshold` 的做法，必要时再抽策略层）
- [ ] P1-5 `pnpm run build:core` + grep bundle 验证符号存活（`if (false)` DCE 风险，AGENTS.md 强制）

### P1.5 — 落盘格式追平 vendor（✅ 已完成）

**先于 P2 落地**：让手动压缩写出的 boundary 与 vendor 同形，P2 再复用。

- [x] P1.5-1 boundary 改用 vendor 形状 `type:'system' + subtype:'compact_boundary'`
- [x] P1.5-2 boundary 补 `compactMetadata.preservedSegment` 锚点（`headUuid` / `anchorUuid` / `tailUuid`）
- [x] P1.5-3 保留段沿用原 `parentUuid`，链保持连续
- [x] P1.5-4 验证 `readTranscriptForLoad` 正确识别新形状（`hasPreservedSegment === true`）
- [x] P1.5-5 更新 `builtin.compact.disk.test.ts` + `builtin.compact.test.ts` 断言
- [x] P1.5-6 回归 `/clear` 路径与前端 transcript 派生（11 文件 69 测试全绿）
- [ ] P1.5-7 保留段条数可配置（**推迟**：属 D5 决策，需实测定值；当前维持「2 条」）

> **独立价值**：即使 P2 全部推迟，格式追平也修正了「zai 写的 boundary 让 vendor 保留段分支永远失效」这个既有问题。

**实施记录（2026-10-08）**

| 项 | 内容 |
|---|---|
| 根因 | vendor `parseBoundaryLine` 要求 `type==='system' && subtype==='compact_boundary'`；zai 原写 `type:'compact_boundary'`，vendor 直接判为非边界 |
| 前端影响 | **无**。`loadTranscriptMessages`（`useAgentStore.ts:489`）只处理 user/assistant/tool_use，boundary 两种形状都不进 store；压缩分界靠「文件里物理只留这几条」实现，不靠前端识别 type |
| 类型定义 | `compat/transcript/types.ts` 加 `subtype?` / `compactMetadata?`；union 保留 `'compact_boundary'` 以**读回 P1.5 之前的历史会话** |
| zod schema | `TranscriptMessageSchema` 同步放行两字段。**注意**：该 schema 全仓无调用方（死代码），改动无害但无实际作用 |
| 实证 | 驱动 vendor 自己的 `readTranscriptForLoad`：新形状 `hasPreservedSegment=true` / `boundaryStartOffset=0`（不截断）；旧形状 `false`（走截断）。已固化为 `packages/zn-agent-core/test/opencc-src/utils/compactBoundaryShape.test.ts` |
| 保留段 | 维持「最后 2 条 user/assistant」，沿用原 `parentUuid`；`anchorUuid` 指向 summary（vendor relink 的挂载点） |

### P2 — 切换实现（✅ 已完成）

- [x] P2-1 `builtin/compact.ts` 改调 `compactViaVendor()`，旧实现保留在 `ZAI_COMPACT_VENDOR=0` 后备
- [x] P2-2 错误语义映射表（vendor 常量 → 中文物案，`VENDOR_ERROR_ZH`）
- [x] P2-3 中文摘要约束经 `customInstructions` 传入（§4.4）
- [x] P2-4 保留策略维持「最后 2 条 user/assistant」（D5 推迟，见 P1.5-7）
- [x] P2-5 ~~`onCompactProgress` → eventBus~~ **不做**：bridge 内部消费，不外泄
- [x] P2-6 既有测试分层：两个旧文件锁自建路径（`ZAI_COMPACT_VENDOR=0`），新增 `builtin.compact.vendor.test.ts` 锁默认路径

### P3 — 收尾（部分完成）

- [x] P3-1 删除 `compat/runtime/compactService.ts` 死代码（净删 202 行）
  - ⚠️ **未**连带删 `sessionFacade-impl.ts` —— 它是「未接入的新 API」，与 `compactService.ts`（已被取代的旧实现）性质不同
- [ ] P3-2 统一自动/手动**落盘机制** —— 未做，前置是 §6.1 的 UI 刷新问题

---

## 5.1 真机验证结果（2026-10-08）

环境：独立实例 `--port 8104 --api-port 7719`（**用户原有 8102/7715 实例全程未受影响**，验证后已清理）。

### 验证通过项

| 项 | 结果 |
|---|---|
| `/compact` 端到端 | ✅ `{"type":"compacted","removedMessages":12,"summary":...}` |
| 落盘行数 | ✅ 12 行 → **4 行**（boundary + summary + 2 条保留段），约 1474 tokens |
| boundary 形状 | ✅ `type=system` + `subtype=compact_boundary` |
| `preservedSegment` 锚点 | ✅ `headUuid=m10` / `tailUuid=m11` / `anchorUuid=<summary uuid>` 三元正确 |
| Web UI 渲染 | ✅ 摘要完整渲染，结构化章节齐全 |
| **压缩后能继续对话** | ✅ 摘要真的读懂了前 3 轮（甚至指出「张伟工号 A-2077」是捏造的） |
| vendor 能力 | ✅ PTL 自愈、microcompact、hooks 全部可用 |

### 真机抓到 3 个单测测不出的 bug（已修）

单测全部 mock 掉 vendor 链，形状错误只有真机能暴露。`ToolUseContext` 里三个字段的 fallback 取值与 vendor 期望不符：

| 字段 | 错误取值 | 正确取值 | 报错 |
|---|---|---|---|
| `options.tools` | `{}` | `[]` | `e.map is not a function`（vendor `getSystemPrompt` 第一行 `new Set(tools.map(t => t.name))`） |
| `readFileState` | `{get,set,has,delete}` | `new Map()` | `e.entries is not a function`（`compactConversation` 汇总文件用 `Object.fromEntries(readFileState.entries())`） |
| `appState.tasks` | 缺失 | `{}` 哨兵 | `Cannot convert undefined or null to object`（`Sus()` 里 `Object.values(appState.tasks)`） |

第三项的根因值得记：原 `getAppState` 是 `if (host.toolPermissionContext) return host` —— **host 只要带了 `toolPermissionContext` 就整体早退**，其余字段一律不补。已改为逐字段 `?? 哨兵`。vendor 压缩链实际读四个键：`toolPermissionContext` / `tasks` / `todos` / `mcp`。

> **教训**：`buildReplToolUseContext` 标了 `@ts-nocheck`（vendor 形状由 vendor 定义，主 tsconfig 排除了 `opencc-src`），类型检查完全帮不上忙。这类「fallback 形状」必须有真机用例兜底，不能只靠单测。

### 已知遗留：摘要开头是英文

`getCompactUserSummaryMessage`（`opencc-src/services/compact/prompt.ts:352`）**硬编码**了英文模板前缀：

```ts
let baseSummary = `This session is being continued from a previous conversation that ran out of context. …`
```

这不是模型输出，`customInstructions` 改不动它 —— 我把指令强化成「包括开头接续说明句在内全用中文」后，`<analysis>` 草稿区和正文都已全中文，但**模板句本身仍是英文**。

同理 `formatCompactSummary` 会把 `<summary>` 标签替换成硬编码的 `Summary:` 小标题，以及 `Primary Request and Intent:` 等章节名也是 vendor 写死的英文。

**未处理**：这是 vendor 面向英文 CLI 的设计。要中文化需改 vendor prompt 模板（`prompt.ts`），收益是纯观感、成本是偏离上游。不做，如实记录。

---

## 6. 已知风险与未解问题

### 6.1 自动压缩后的 UI 刷新（**P3 的前置，未解**）

交接文档 Next Steps #9 记录：事件链已通（`query.ts:1058` yield → `sdkEventAdapter.ts:109` 放行 `compact_boundary` → SSE → `deriveTranscriptNodes.ts:97` 切段），但**前端 transcript 是从服务端文件还原的**（`useAgentStore.ts:1441-1444` `loadTranscriptMessages`），非 SSE 增量。

自动压缩走 vendor 内存态、manual 走 `store.replace()` 落盘，**两条路径的可见性行为不同**。P3 若要统一落盘，必须先确认 UI 在两种情况下都能刷新。建议用 `CLAUDE_AUTOCOMPACT_PCT_OVERRIDE=30` 强制触发一次，抓 SSE 验证。

### 6.2 `if (false)` DCE 风险

`compact.ts` 里 `if (false)` 有 3 处（222 / 755 / 1111）。本次**不改这些门控**（改了会引入 P0 已实证的 DCE 风险面），但新增导出后必须 `build:core` + grep bundle 实证符号存活。AGENTS.md 有强制规则。

### 6.3 中文摘要与 vendor prompt 的耦合

若采纳 §4.4 的 `customInstructions` 方案，中文约束走的是 vendor 自己的 prompt 拼接逻辑。需验证 `mergeHookInstructions` 不会把约束塞到不合适的位置。

### 6.4 待用户决策项

| # | 问题 | 影响 | 建议 |
|---|------|------|------|
| D1 | 保留策略用 B1 / B2 / B3？ | 压缩后丢多少上下文 | **B3**（§4.3 已给答案：vendor 已有 `messagesToKeep` 范式，没理由继续硬编码 2 条） |
| D2 | 摘要是否保持中文？ | 用户体验 | 保持中文（走 `customInstructions`，§4.4） |
| D3 | 是否要做 P0 之外的完整切换？ | 工作量 1-2 天 | 先 P0 + P1.5 观察，再决定 P1/P2 |
| D4 | 是否顺带删 `compactService.ts` 死代码？ | 减少混淆 | 建议删；**但别连带删 `sessionFacade-impl.ts`** |
| D5 | P1.5 的保留段默认条数取多少？ | 压缩后上下文连续性 | 需覆盖最近一次完整工具往返；P1.5-1 可先做实测再定 |

---

## 7. 验证计划

| 阶段 | 验证方式 |
|------|---------|
| P0 | 相关单测（`builtin.compact.disk.test.ts`）；手动长会话 `/compact` 后观察缓存行为 |
| P1 | `pnpm run build:core` + `node -e "import('./dist/opencc-core.mjs')"` 实测；新单测 |
| P2 | **必须真机验证**（AGENTS.md）：起独立端口 `pnpm --filter @zn-ai/zai dev -- --port 8102 --api-port 7715`（**勿动 920x 正式实例**），长会话跑 `/compact`，检查：transcript 文件真的变短、UI 消息数下降、摘要内容合理、无缓存残留症状 |
| P2 回归 | 压缩后继续对话，确认 agent 能基于摘要正常推进（这是压缩的真实目的） |
| P3 | 依赖 §6.1 先解决 |

**测试粒度**：只跑直接受影响的测试文件，不跑 `pnpm -r test`（约 4.5 分钟）。

---

## 8. 参考

| 主题 | 位置 |
|------|------|
| vendor 参考实现 | `packages/zn-agent-core/src/opencc-src/commands/compact/compact.ts`（300 行） |
| vendor 压缩核心 | `packages/zn-agent-core/src/opencc-src/services/compact/compact.ts:411` `compactConversation` |
| `preservedSegment` 读侧逻辑 | `packages/zn-agent-core/src/opencc-src/utils/sessionStoragePortable.ts:588-600` |
| 保留段锚点生成 | `packages/zn-agent-core/src/opencc-src/services/compact/compact.ts:359` `annotateBoundaryWithPreservedSegment` |
| 现有真 context 实例 | `packages/zn-agent-core/src/compat/repl/createReplSession.ts:486-544` |
| zai 现实现 | `packages/zai/src/server/services/commands/builtin/compact.ts`（342 行） |
| 落盘实现 | `packages/zn-agent-core/src/compat/runtime/legacyTranscriptStore.ts:523-533` `replace()` |
| 误导性 API（已加警示） | `packages/zn-agent-core/src/opencc-src/server/sessionFacade-impl.ts` `compact()` **只读不压缩** |
| 死代码待删 | `packages/zn-agent-core/src/compat/runtime/compactService.ts` |
| 历史 spec | `docs/superpowers/specs/2026-07-19-zai-session-compaction-design.md` §4/§7<br>`docs/superpowers/specs/2026-07-26-zai-compact-command-v2-design.md` |
| 前序交接 | `.agent_working_dir/handoff/fix-snip-and-autocompact-threshold-2026-10-08.md` #6 / #12 |

---

## 9. 规划期修订记录

### 2026-10-08：落盘拓扑实测纠偏

规划期初稿基于代码注释推断落盘行为，**结论有误**，已按磁盘实证修正。记录在此以免后人重蹈：

| 初稿结论 | 实测 | 错因 |
|---|---|---|
| 「自动压缩 vendor 不落盘」 | **落盘** —— 经 vendor 环写入 JSONL | 误信 `agentRuntime.ts` 的 "no-op facade" 注释 |
| 「`legacyTranscriptStore` 是 no-op stub」 | **全功能实现**，30+ 处活跃调用 | 同上，且 `src/index.ts` 也这么写 |
| 「`sessionFacade` 拥有 session/transcript」 | **零调用的死代码** | 同上 |
| 「落盘追随 vendor 成本极高」 | **成本被高估** —— vendor 落盘机制在 zai 里是生产可运行的 | 由上一条推导而来 |

**已同步修正的代码注释**（本次一并提交）：

| 文件 | 修正内容 |
|---|---|
| `packages/zn-agent-core/src/index.ts` | 补 JSONL 双写方拓扑图，删「no-op stub」误述 |
| `packages/zai/src/server/services/agentRuntime.ts` | 同上，并显式标注「早前版本声称 sessionFacade 拥有数据，是错的」 |
| `packages/zn-agent-core/src/opencc-src/server/sessionFacade-impl.ts` | 顶部加「⚠️ NOT WIRED INTO zai」；`compact()` 方法内加「只读不压缩」 |
| `packages/zn-agent-core/src/opencc-src/server/sessionFacade.ts` | `SessionCompactResult` 加只读语义说明 |
| `packages/zai/src/server/services/weixinBot/WeixinSessionMap.ts` | 修正路径笔误（`compat/transcript/` → `compat/runtime/`） |

> **教训**：本仓的注释里混有「计划意图」（Task 6 将删除 X）与「当前事实」的混淆，注释描述**已完结的计划**时容易被当成现状。涉及存储/生命周期的判断，应以磁盘实证或 codegraph 调用图为准，不要只读注释。
