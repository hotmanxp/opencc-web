# zai `/compact` v2 + Token 估算模块设计

| 字段 | 值 |
|---|---|
| Spec 编号 | 2026-07-26-zai-compact-command-v2 |
| 状态 | 设计中 → 待评审 |
| 范围 | 阶段 2(子项目 E 完整) + 独立 token 估算模块(用户新增) |
| 工作量 | 1-2 天(8-12 task) |
| 上游 spec | `docs/superpowers/specs/2026-07-19-zai-session-compaction-design.md` §7 |

## 1. 背景与目标

### 1.1 现状

zai 主对话路径已交付阶段 1 auto-compact 三道防线(`snip` / `forceReason` / `autocompact`),见 spec `2026-07-19-zai-session-compaction-design.md` §4 + `runtime/compact/` 9 个模块。但 `/compact` 命令(v0, `runtime/compactService.ts` 196 行)能力与 `compactConversation`(阶段 1)重叠且弱:

| 维度 | `compactConversation`(阶段 1) | `compactSession`(compactService.ts,旧) |
|---|---|---|
| streaming 摘要 | ✅(120s timeout) | ❌(60s timeout,无 streaming) |
| PTL 自愈 | ❌(单次,失败透传) | ❌ |
| Prompt cache sharing | ❌(cold path only) | ❌ |
| pre/post hooks | ❌(无接口) | ❌ |
| `serializeForCompact` 质量 | 简化版(只 dump text) | 完整版(thinking/tool_use/tool_result truncate 500B/image) |
| token 估算 | `autocompact.ts` 内私有函数,`content.length / 4` | 无 |

阶段 2 目标:把 `/compact` 升级到完整版,并把 token 估算抽为可复用模块。

### 1.2 目标(用户确认)

1. **/compact 走 OpenCC 同款 dual path**(Anthropic → cache sharing;非 Anthropic → cold path)。
2. **推进阶段 2**(spec §7 完整:streaming + PTL 自愈 + cache + hook + token 模块)。
3. **`compactService.ts` 删除**,`compactSession()` 入口迁入 `runtime/compact/index.ts`,字段 100% 兼容。
4. **token 估算抽到独立模块**,`autocompact.ts` 复用;启发式(中文 / 英文 / thinking / image / tool_use / tool_result 各自权重),不调 API。

## 2. 架构

### 2.1 模块布局

```
runtime/compact/
├── token-estimate.ts          ← 新增:estimateMessagesTokenCount
├── serialize-for-compact.ts   ← 新增:serializeForCompact(thinking/tool_use/tool_result/image)
├── ptl-retry.ts               ← 新增:truncateHeadForPTLRetry + getPromptTooLongTokenGap
├── prompt-cache-share.ts      ← 新增:isCompactionCacheSharingCompatible(providerKind)
├── hooks.ts                   ← 新增:executePreCompactHooks + executePostCompactHooks (no-op)
├── conversation.ts            ← 改造:注入以上 5 个;dual path;PTL 透传;token 估算注入 pre/post count
├── autocompact.ts             ← 改造:本地 tokenCountWithEstimation → import token-estimate
├── index.ts                   ← 改造:重新 export + 新增 compactSession() shim
└── ...其余 7 个文件(snip/force-reason/tracking/cleanup/context-window/log-event/types)不动
```

### 2.2 契约

| 模块 | 入口 | 出口 |
|---|---|---|
| `token-estimate.ts` | `estimateMessagesTokenCount(msgs): number` | 启发式 token 总数(中文 / 英文 / thinking / image / tool_use / tool_result) |
| `serialize-for-compact.ts` | `serializeForCompact(msgs): string` | Markdown 形式对话历史,喂给 LLM 摘要 |
| `ptl-retry.ts` | `truncateHeadForPTLRetry(msgs, ptlResponse): Message[] \| null` | PTL 重试削头结果,失败返回 null |
| `prompt-cache-share.ts` | `isCompactionCacheSharingCompatible(providerKind): boolean` | true 仅当 `providerKind === 'anthropic'` |
| `hooks.ts` | `executePreCompactHooks(input, signal)` / `executePostCompactHooks(input, signal)` | no-op + 接口预留(zai 暂无 user hook) |

### 2.3 边界与依赖

- `runtime/compact/` 不依赖 `opencc-internals/*`(独立实现)。
- `runtime/compact/` 不依赖 `react` / `antd`(纯 TS,服务端同构)。
- `token-estimate.ts` / `serialize-for-compact.ts` / `ptl-retry.ts` / `prompt-cache-share.ts` / `hooks.ts` 互不依赖,只通过 `types.ts` 共享类型契约。
- `conversation.ts` 是唯一依赖上述 5 个新模块的消费者。
- `autocompact.ts` 只依赖 `token-estimate.ts`。

## 3. 数据流

```
POST /api/command { name: 'compact', args, sessionId }
   │
   └─ routes/command.ts → cmd.call(args, context)  [现有,不动]
         │
         └─ compactCommand.call(args, context)  [zai/src/.../commands/builtin/compact.ts]
               ├─ sessionId = context.sessionId ?? getCurrentSessionId()
               ├─ existing = await store.read(sessionId, { cwd })
               ├─ if existing.messages.length < 2 → return { kind: 'error' }
               ├─ runtime = getRuntime()
               ├─ providerKind = resolveProviderKind()
               │
               ├─ compactSession({ store, sessionId, modelCaller, cwd, model, providerKind })
               │     │
               │     ├─ cacheSafeParams = isCompactionCacheSharingCompatible(providerKind)
               │     │     ? buildCacheSafeParams(toolUseContext, forkMessages)
               │     │     : COLD_PATH_PARAMS  // { suppressFollowUpQuestions: true }
               │     │
               │     ├─ executePreCompactHooks({ trigger: 'manual', customInstructions }, signal)
               │     │     └─ zai no-op → {}
               │     │
               │     ├─ let attempt = 0; let messages = originalMessages
               │     │ loop {
               │     │   try {
               │     │     result = await compactConversation(messages, ..., trigger: 'manual', providerKind)
               │     │     break
               │     │   } catch (err if isPTL(err) && attempt < 3) {
               │     │     messages = truncateHeadForPTLRetry(messages, err.assistantMessage)
               │     │     if (!messages) throw err
               │     │     attempt++
               │     │     continue
               │     │   }
               │     │ }
               │     │
               │     ├─ executePostCompactHooks({ trigger: 'manual', summary, messagesToKeep }, signal)
               │     │     └─ zai no-op → []
               │     │
               │     └─ return { kind: 'compacted', summary, newMessages: buildPostCompactMessages(result) }
               │
               ├─ store.replace(sessionId, newMessages)
               └─ return { kind: 'compacted', summary }
```

**关键点**:
- PTL 重试循环外置在 `compactSession`(shim),`compactConversation` 内部只跑一次 → 与上游 spec §7.3 一致。
- `providerKind` 由调用方一次性注入,避免 `compactConversation` 重复探测 provider。
- `executePreCompactHooks` 在 manual 触发时接收 `customInstructions`(从 `args` parse),auto 触发时为 `null`。
- `compactConversation` 的 `preCompactTokenCount` / `postCompactTokenCount` 改为:
  - `preCompactTokenCount = estimateMessagesTokenCount(originalMessages)`
  - `postCompactTokenCount = estimateMessagesTokenCount([boundaryMarker, summaryMessage])`
  不再使用阶段 1 的 `messages.length * 100` 占位。

## 4. 错误处理与边界

### 4.1 PTL 自愈错误传播

- 模型返回的 PTL 错误(`prompt_too_long` / 400)被 `modelCaller` 转译为 `Error & { code: 'prompt_too_long', assistantMessage?: AnthropicMessage }`(沿用阶段 1 错误流,见 `runtime/errors/`)。
- `truncateHeadForPTLRetry` 从 `ptlResponse.usage.output_tokens` 与 `contextWindow` 计算 token gap,按 "API-round group" 切:`{ user + assistant(tool_use) + user(tool_result) }` 视为一组,每次削掉最早的 1 组;gap 不足时返回 `null`。
- 3 次重试后仍 PTL → 抛 `ERROR_MESSAGE_PROMPT_TOO_LONG`,`compactSession` 捕获并返回 `{ kind: 'error', message: '对话历史过长,无法压缩(已尝试 3 次)' }`。

### 4.2 Token 估算启发式(`token-estimate.ts`)

| 内容块 | 估算公式 |
|---|---|
| `text` block | 中文按 `length / 1.5`,英文按 `length / 4`,按非 ASCII 字符比例动态切档(>50% 中文 → 1.5,>50% 英文 → 4,中间 → 2.5) |
| `thinking` block | 同 `text` |
| `tool_use` block | `(name.length + JSON.stringify(input).length) / 3` |
| `tool_result` block | `(JSON.stringify(content).length) / 3` |
| `image` block | 固定 1000 tokens(Anthropic 图片粗估) |
| `cache` / `unknown` 字段 | 不计 |

**接口**:
```ts
export function estimateMessagesTokenCount(messages: TranscriptMessage[]): number
```

自包含,零外部依赖。`autocompact.ts` 删本地 `tokenCountWithEstimation`,改 import。

**偏差容忍**:估算只用于 `shouldAutoCompact` 触发判定;不写入 boundary messages。偏差只影响触发时机,不影响压缩质量。

### 4.3 Hook 接口预埋

- `executePreCompactHooks` / `executePostCompactHooks` 当前实现 = `return {}/return []`。
- 接口用 `trigger: 'auto' | 'manual'` 区分,为阶段 2 后续接入 zai-plugin / zai-skill 留口。
- 调用包 5s `AbortSignal.timeout(5000)`,超时 / 抛错 → 跳过当前 hook,记 `compact.jsonl` 一行 `{hookName, status: 'timeout'|'error'}`,不阻塞压缩。

### 4.4 Dual path 边界(`prompt-cache-share.ts`)

```ts
export function isCompactionCacheSharingCompatible(providerKind: string): boolean {
  return providerKind === 'anthropic'
}
```

- `providerKind === 'anthropic'` → true,走 cache sharing(`CacheSafeParams` + `runForkedAgent` 风格参数)。
- 其他(`'openai'` / `'custom'` / `undefined`)→ false,走 cold path,**不发** `betas` / `context_management` / `prompt-caching-2024-07-31` 头(spec §7.4 明确要求)。
- `providerKind` 来源:zai 现有 `agentRuntime.resolveProviderKind()`(modelCaller.ts 旁的 `resolveProvider`,基于 `ANTHROPIC_BASE_URL` / `OPENAI_BASE_URL` env 探测)。

### 4.5 `compactService.ts` 删除兼容策略

- 删除 `packages/zai-agent-core/src/runtime/compactService.ts`。
- `runtime/compact/index.ts` 导出同名 `compactSession(opts)`,字段签名(`store` / `sessionId` / `modelCaller` / `cwd` / `model` / `providerKind`)与旧版 100% 兼容,加一个可选 `providerKind`。
- `runtime/index.ts` 的 re-export 路径不变。
- `zai/src/server/services/commands/builtin/compact.ts` 改一行 import:`from 'runtime/compact/index.js'`(经 `zai-agent-core` 的 barrel)。

## 5. 测试策略

### 5.1 单元测试

| 模块 | 测试文件 | 关键 case |
|---|---|---|
| `token-estimate.ts` | `token-estimate.test.ts` | 中文 / 英文 / 混合 / thinking / image / tool_use / tool_result 7 case |
| `serialize-for-compact.ts` | `serialize-for-compact.test.ts` | thinking 丢弃 / tool_use JSON 序列化 / tool_result 500B 截断 / image 计数 |
| `ptl-retry.ts` | `ptl-retry.test.ts` | 单组削头 / 多组削头 / gap 不足返回 null / 非 PTL 错误不削 |
| `prompt-cache-share.ts` | `prompt-cache-share.test.ts` | `'anthropic'` → true,`'openai'` / `'custom'` → false |
| `hooks.ts` | `hooks.test.ts` | no-op 默认返回值 / 5s 超时跳过 / 抛错跳过 |
| `conversation.ts` | `conversation.test.ts`(扩展) | dual path 跑通 / PTL 错误透传 / token 估算注入 pre/post count |

### 5.2 集成测试

新建 `packages/zai-agent-core/test/runtime/compact/compact-command-v2.test.ts`,对应 spec §11.7 测试矩阵 F7:

1. **PTL 自愈链**:mock `modelCaller` 第一次抛 PTL → 削头后第二次成功,verify `store.replace` 内容正确。
2. **Dual path 切换**:`providerKind='openai'` → `compactConversation` 调用不带 cache fields;`providerKind='anthropic'` → 带 cache fields。
3. **Hook 超时不阻塞**:mock hook 抛错 / 超时,压缩仍成功完成。
4. **Token 估算喂入**:`preCompactTokenCount` 等于 `estimateMessagesTokenCount(originalMessages)`,不再用 `messages.length * 100` 占位。

### 5.3 测试运行器现状

`conversation.test.ts` 阶段 1 用 vitest(`import { describe, test, expect } from 'vitest'`),plan 文档写 `bun test`。

**Task 1 探测**:`bun test packages/zai-agent-core/test/runtime/compact/conversation.test.ts` 跑一次,确认:
- bun 是否能跑 vitest API(常见两者 API 兼容)。
- 若失败,改用 `vitest run packages/zai-agent-core/test/runtime/compact/`(仓库其它测试如 `queryLoop-resume-2013.test.ts` 也用 vitest)。

### 5.4 行数与覆盖率门

- 每个新文件 ≤ 200 行(spec §2.2 建议);`conversation.ts` 接受 230-260 行(职责单一优先),拒绝超过 300 行。
- 关键模块 `line ≥ 92%, branch ≥ 80%`(沿用 spec §11.6 阶段 1 目标)。

### 5.5 风险登记

| 风险 | 概率 | 缓解 |
|---|---|---|
| `providerKind` 注入路径与现有 modelCaller duck-type 不齐 | 中 | Task 1 先 `grep resolveProvider / provider.kind` 全仓确认;若不齐则用 `process.env.ANTHROPIC_BASE_URL ? 'anthropic' : 'openai'` 兜底 |
| `compactService.ts` 删除后老 import 漏改 | 低 | Task 10 `grep -r "compactService" packages/` 全仓扫,plan Task 显式列 |
| bun 与 vitest 双跑导致 CI 失败 | 中 | Task 1 探测 + plan 标注测试运行命令 |
| PTL 错误形态与 Anthropic SDK / OpenAI shim 不一致 | 中 | 阶段 1 错误已是 Anthropic 协议;OpenAI shim 抛 `prompt_too_long` 转换在 `openaiClient.ts` 已落,复用即可 |
| token 估算启发式与真实 API 偏差 > 30% | 低 | 估算只用于 `shouldAutoCompact` 触发判定;不写入边界 messages |

## 6. 实施计划(12 task,顺序执行,每 task 一 commit)

| # | Task | 输出 | 依赖 |
|---|---|---|---|
| 1 | 探测 baseline + dual path 注入点 | bun / vitest 跑通 conversation.test.ts;`grep provider.kind` 确认 | - |
| 2 | `token-estimate.ts` | 启发式 token 估算 + `token-estimate.test.ts`(7 case) | 1 |
| 3 | `serialize-for-compact.ts` | thinking / tool_use / tool_result / image + test | 1 |
| 4 | `ptl-retry.ts` | `truncateHeadForPTLRetry` + `getPromptTooLongTokenGap` + test | 1 |
| 5 | `prompt-cache-share.ts` | `isCompactionCacheSharingCompatible(providerKind)` + test | 1 |
| 6 | `hooks.ts` | `executePreCompactHooks` / `executePostCompactHooks` no-op + test | 1 |
| 7 | 改造 `conversation.ts` | 注入 5 个新模块;dual path;PTL 透传;`isAutoCompact` 消费;token 估算注入 | 2-6 |
| 8 | 改造 `autocompact.ts` | 删本地 `tokenCountWithEstimation`,改 import;行为不变 | 2 |
| 9 | 改造 `compact/index.ts` | 重新 export + 新增 `compactSession(opts)` shim | 2-7 |
| 10 | 删除 `compactService.ts` + 改 import | `runtime/index.ts` / `commands/builtin/compact.ts` / 老 import 全改 | 9 |
| 11 | 集成测试 `compact-command-v2.test.ts` | PTL 自愈 / dual path / hook 超时 / token 估算 4 case | 7-10 |
| 12 | 覆盖率 + 全量回归 | 全量测试绿;`line ≥ 92%, branch ≥ 80%` | 11 |

**commit 风格**:Conventional Commits(`feat(zai-agent-core): ...` / `test(...)` / `refactor(...)`)。

## 7. 决策汇总

| 决策项 | 决定 |
|---|---|
| 范围 | 阶段 2 spec §7 完整 + token 估算模块 |
| 路径选择 | dual path(`providerKind === 'anthropic'` → cache sharing,其他 → cold) |
| `compactService.ts` 命运 | 删除,`compactSession()` 迁入 `runtime/compact/index.ts` |
| token 估算 | 启发式,抽到 `token-estimate.ts`,阶段 3/4 复用 |
| Hook 接口 | 当前 no-op + 5s timeout + 预埋 trigger 区分,阶段 2 后续接入 zai-plugin |
| PTL 重试次数 | 3 次,每次削 1 组 API-round |
| Tool result 截断 | 复用旧 `compactService.ts` 的 500B 规则 |
| 测试运行 | bun 优先,失败回退 vitest(Task 1 探测) |
| 行数上限 | 新文件 ≤ 200 行;`conversation.ts` 接受 230-260 行 |