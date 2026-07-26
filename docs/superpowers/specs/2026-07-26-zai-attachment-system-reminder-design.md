# Mid-turn Attachment → System-Reminder Rewrite

| 字段 | 值 |
|---|---|
| Spec 编号 | 2026-07-26-zai-attachment-system-reminder |
| 父 spec | [D. Mid-turn Attachment + Memory Prefetch](./2026-07-19-zai-loop-resilience-d-attachment-design.md) |
| 状态 | 设计评审中 → 待批准 |
| 目标交付 | 4 类 mid-turn attachment 改走 `<system-reminder>` 注入 systemPrompt,不再污染 messages |
| 工作量 | 1 天 |
| 修订内容 | D spec §2.1 Attachment 接口 payload → content(spec v1.1) |

## 0. 范围

| 在范围 | 不在范围 |
|---|---|
| 4 类 attachment(`background-bash` / `background-agent` / `skill-prefetch` / `memory-prefetch`)改走 `<system-reminder>` 纯文本 | 改 `BackgroundRuntime` / `BashTracker`(冻结) |
| `Attachment.payload: AnthropicMessage` → `content: string` | prompt cache `cache_control` 边界 marker 重新设计(留 follow-up) |
| `queryLoop:248-254` 把 attachment 拼到 `systemPrompt` 数组尾巴 | `mergeTrailingUserMessage` 逻辑调整(已不再需要) |
| `collectSkills` 不再用 `<skill-prefetch>` 标签,改用人类语言描述 | front-end UI 调整(attachment 不入 UI,transcript loader 不变) |
| 4 个 builder 输出形态重写 | `prefetchMemory.ts` 行为变更 |
| 单测 + 集成测补充 | transcript v2 schema 调整 |

## 1. 背景与目标

zai 当前 4 类 mid-turn attachment(`background-bash` / `background-agent` / `skill-prefetch` / `memory-prefetch`)走 `queryLoop:248-254` 注入 `messages` 数组:

```ts
const attachments = await getAttachmentMessages({ sessionId, signal, pluginSnapshot })
for (const att of attachments) messages.push(att.payload as any)
```

每个 attachment 的 `payload` 都是 `role: 'assistant'` 的 `AnthropicMessage`(见 `get.ts:264,273,280`)。

**问题**:Anthropic 协议要求 messages 严格 `user/assistant` 交替。当 session 是 **fresh**(无 transcript resume)且 `pluginSnapshot.skills` 非空时:

```
messages[0] = { role: 'assistant', content: '<skill-prefetch ...>' }   ← attachment
messages[1] = { role: 'user', content: <用户新 prompt> }               ← 用户输入
```

`modelCaller` 把这形状喂给 Anthropic 即刻被 400 / 2013 拒掉 → queryLoop 卡死在 `for-await modelStream` 之前的 `serializeForAnthropic` 阶段 → `message_stop` 永远不来 → 前端 SSE `runtime.done` 永远不推送 → **对话流中断**(用户观察到的现象)。

**目标**:
1. 4 类 attachment 全部改走 `<system-reminder>` 纯文本,**不再进 `messages` 数组**
2. `queryLoop` 入口把 reminder 拼到 `systemPrompt` 数组尾巴(对齐 OpenCC `normalizeMessagesForAPI` 把 `skill_listing` 转 `createUserMessage({ isMeta:true })` + `<system-reminder>` 包装的设计,但路径不同:zai 不入 messages,直接拼 systemPrompt)
3. 公开 API `Attachment.payload: AnthropicMessage` → `content: string`(对齐 spec D §7 "attachment 转 AnthropicMessage 的具体格式 — 自由")
4. 不破坏现有 `BackgroundRuntime` / `BashTracker` 只读契约(spec D §0 冻结)

## 2. 公共契约(修订 spec D §2.1 → v1.1)

### 2.1 旧契约(spec D v1.0)

```ts
export interface Attachment {
  source: 'background-bash' | 'background-agent' | 'skill-prefetch' | 'memory-prefetch';
  payload: AnthropicMessage;   // assistant message 形式
  consumedAt: number;
}
```

### 2.2 新契约(v1.1,本次修订)

```ts
/** v1.1: attachment 内容改为纯文本(已包好 <system-reminder> 包装),
 *  queryLoop 不再 push 到 messages 数组,改为拼到 systemPrompt 尾巴。 */
export interface Attachment {
  source: 'background-bash' | 'background-agent' | 'skill-prefetch' | 'memory-prefetch';
  content: string;            // <system-reminder>...</system-reminder> 包好的字符串
  consumedAt: number;         // 排序用
}
```

**接口形态对齐 OpenCC**:`normalizeMessagesForAPI`(`opencc-internals/utils/messages.ts:1719-1741`)处理 `attachment` 类型的输出本质是 `createUserMessage` + `wrapMessagesInSystemReminder`,最终生成 `<system-reminder>...</system-reminder>` 文本。zai 把这个流程前置:`Attachment.content` 直接是最终产物,`queryLoop` 入口 join 到 `systemPrompt` 数组尾巴。

### 2.3 queryLoop 入点契约(v1.1)

```ts
// runtime/queryLoop.ts turn 入点 (替换原 248-254)
const attachments = await getAttachmentMessages({ sessionId, signal, pluginSnapshot })
// 全部按 consumedAt asc 排序(已由 getAttachmentMessages 保证),join 到 systemPrompt 尾巴
const reminderText = attachments.map(a => a.content).join('\n')
if (reminderText.length > 0) systemPrompt.push(reminderText)
// messages 数组完全不再被 attachment 污染
```

`systemPrompt` 类型原为 `readonly string[]`(见 `queryLoop:326 [...systemPrompt]`),`push` 调用前需要 spread / mutation 形式:

```ts
systemPrompt = [...systemPrompt, reminderText]
```

或者改 modelCaller 输入形参签名为可变数组。本次计划取前一种,**不动 modelCaller 签名**。

### 2.4 错误契约(沿用 spec D §2.4)

- `getAttachmentMessages` 异常 → 返 `[]`(空数组),**不抛**
- `getAttachmentMessages` source 为空 → 返 `[]`
- abort 信号在 `getAttachmentMessages` 之前触发 → `[]`,`systemPrompt` 不被污染

### 2.5 配置键(沿用 spec D §2.3)

无新增 / 修改。

## 3. 4 个 builder 输出形态(v1.1)

### 3.1 `collectBash` → `background-bash`

```ts
function bashTaskToReminder(t: BashTaskLike): string {
  const header = `<bash-task taskId="${t.taskId ?? ''}" status="${t.status ?? ''}" exitCode="${t.exitCode ?? ''}">`
  const body = [
    `$ ${t.command ?? ''}`,
    t.stdout ? `[stdout]\n${t.stdout}` : '',
    t.stderr ? `[stderr]\n${t.stderr}` : '',
  ].filter(Boolean).join('\n')
  return `<system-reminder>\n${header}\n${body}\n</bash-task>\n</system-reminder>`
}
```

### 3.2 `collectBackgroundTasks` → `background-agent`

```ts
function backgroundTaskToReminder(t: BackgroundTaskLike): string {
  const header = `<background-agent taskId="${t.id ?? ''}" status="${t.status ?? ''}">`
  const body = t.resultText ?? t.error?.message ?? '(no result)'
  return `<system-reminder>\n${header}\n${body}\n</background-agent>\n</system-reminder>`
}
```

### 3.3 `collectSkills` → `skill-prefetch`(改人类语言)

**v1.0 输出**:`<skill-prefetch name="X" source="Y">description</skill-prefetch>`

**v1.1 输出**:
```ts
function skillToReminder(s: LoadedSkill): string {
  const desc = s.frontmatter?.description ?? s.description ?? ''
  const source = s.source ?? 'disk'
  return `<system-reminder>\nThe following skill is available: ${s.name} (source: ${source})\n${desc}\n</system-reminder>`
}
```

**对齐 OpenCC**:`opencc-internals/utils/messages.ts:2584-2594` skill_listing 输出:
```ts
content: `The following skills are available for use with the Skill tool:\n\n${attachment.content}`
```

zai 把多个 skill 拆成多条 reminder(`getAttachmentMessages` 返回数组),每条对应一个 `<system-reminder>`,由 queryLoop join。模型看到连续多个 `<system-reminder>` 块会自动理解,不需要额外 list 头。

### 3.4 `collectMemory` → `memory-prefetch`

```ts
function memoryToReminder(content: string): string {
  return `<system-reminder>\n${content}\n</system-reminder>`
}
```

### 3.5 多 attachment 拼接顺序

`getAttachmentMessages` 内部 `out.sort((a, b) => a.consumedAt - b.consumedAt)`(`get.ts:165`)已保证升序,queryLoop `attachments.map(a => a.content).join('\n')` 直接按数组顺序拼接即可。

## 4. 数据流

```
queryLoop turn 入口
   ↓
getAttachmentMessages({ sessionId, signal, pluginSnapshot })
   ├─ collectBash          → [Attachment(content: '<system-reminder><bash-task ...>')]
   ├─ collectBackgroundTasks → [Attachment(content: '<system-reminder><background-agent ...>')]
   ├─ collectSkills        → [Attachment(content: '<system-reminder>The following skill ...')]
   └─ collectMemory        → [Attachment(content: '<system-reminder>memory content')]
   ↓ consumedAt asc 排序 + DEFAULT_LIMIT=100 cap
   ↓
attachments[].content.map(...).join('\n') → reminderText
   ↓
systemPrompt = [...systemPrompt, reminderText]
   ↓
modelCaller({ systemPrompt, messages, ... })   ← messages 不变(只 + 1 user prompt)
   ↓
Anthropic API 接受(skills via <system-reminder> in systemPrompt,user prompt user turn)
```

对比 v1.0 路径:**彻底删掉** `messages.push(att.payload as any)` 这一行。

## 5. 测试策略

### 5.1 单测层(`packages/zai-agent-core/test/integration/agent/resilience/d-attachment-messages.test.ts` 补充)

- `collectBash` 输出断言:内容以 `<system-reminder>` 开头 + `</system-reminder>` 结尾,内层保留 `<bash-task>` 标签
- `collectBackgroundTasks` 同上风格,内层 `<background-agent>`
- `collectSkills`:**断言不再含 `<skill-prefetch` 字串**,改为 `The following skill is available: <name>` 开头
- `collectMemory`:`<system-reminder>\n${content}\n</system-reminder>`
- 多 attachment:`content` 数组按 `consumedAt asc` 排序
- `fromTimestamp` 过滤、异常吞掉 → `[]`、空 source → `[]`(沿用 v1.0 用例,只调整断言 target)

### 5.2 集成层(新文件 `packages/zai-agent-core/test/runtime/queryLoop-attachment-system-prompt.test.ts`)

- **Case 1**:fresh session + `pluginSnapshot.skills = [{name:'foo', description:'d'}]` → `messages.length === 1`(只 user prompt)、`systemPrompt` 数组末尾追加 reminder,内容含 `<system-reminder>` + `The following skill is available: foo`
- **Case 2**:resumed session(5 条 transcript) + skill-prefetch → `messages.length === 6`(原 5 条 + 新 user)、`systemPrompt` 末尾追加 reminder。**核心回归**:不再出现连续 assistant message 触发 2013
- **Case 3**:`abortController.abort()` 在 `getAttachmentMessages` 返回前触发 → `getAttachmentMessages` 返 `[]` → `systemPrompt` 不被污染
- **Case 4**:多源 attachment(bash + skill + memory)→ reminder 内容按 `consumedAt asc` 排序
- **Case 5**:无 pluginSnapshot(`plugins.enabled = false`)→ `systemPrompt` 不被追加,行为等同 v1.0 的 `attachments === []` 分支

### 5.3 验收门

1. `pnpm --filter @zn-ai/zai-agent-core typecheck`
2. `pnpm --filter @zn-ai/zai-agent-core test test/integration/agent/resilience/d-attachment-messages.test.ts`(全绿,沿用 + 调整)
3. `pnpm --filter @zn-ai/zai-agent-core test test/runtime/queryLoop-attachment-system-prompt.test.ts`(全绿,新增)
4. `pnpm --filter @zn-ai/zai-agent-core test`(全量)— 回归覆盖 d-memory-prefetch / queryLoop-resume-2013 / subagentNotifier-2013 / auto-compact-turn-loop
5. 与现有 `BashTool` / `BackgroundAgentTool` 的 E2E 不退化(手工 smoke)

### 5.4 覆盖率目标

沿用 spec D §11.6 总体目标:`Attachment.content` 相关分支 line ≥ 92%,branch ≥ 80%。

## 6. 风险与边界场景

| 风险 | 缓解 |
|---|---|
| `Attachment.payload` 公开类型变了,下游调用方编译失败 | grep 全仓无其他 caller(spec D §0 明确 attachment 是 queryLoop 唯一消费方);若发现,补迁移注释 + 一次性适配 |
| `system-reminder` 在 `systemPrompt` 数组 vs Anthropic messages 内识别差异 | `system-reminder` 是 Anthropic SDK 原生 token,放在 systemPrompt 与 user message 都能被模型理解;不区分 |
| 大量 attachment 把 systemPrompt 撑爆 | 沿用 spec D §6.2 `DEFAULT_LIMIT=100`,`getAttachmentMessages` 已 cap |
| prompt cache 命中降级(systemPrompt 比 messages 靠后 / 边界 marker 缺失) | 由 modelCaller 内部决定,不在本次范围;若命中率真出问题,留 follow-up(独立 plan) |
| `systemPrompt` 是 `readonly string[]` 类型 | queryLoop 用 spread 重赋值:`systemPrompt = [...systemPrompt, reminderText]`(局部变量非 `readonly`,见 queryLoop:177) |
| `modelCaller` 输入签名为 `systemPrompt: readonly string[]`,不接受新长度数组 | 不影响 — `[...systemPrompt, reminderText]` 产生新数组,长度可变,类型仍是 `string[]`,赋给 readonly 形参 OK |
| `<bash-task>` / `<background-agent>` 内层标签 vs OpenCC 是否一致 | OpenCC 内层用的是 XML-like 结构;zai 保留自造内层标签(非 OpenCC 来源);保留是因为有 user-facing 调试价值,改动属于"兼容保留" |

## 7. 不锁定

- `Attachment.content` 具体文本格式(只要 `<system-reminder>` 包裹 + 内层必要信息)— 自由
- `prefetchMemory` 行为 — 不动(冻结)
- 4 类 source 名称 — 不动(向后兼容 `AttachmentContext`)
- front-end UI / transcript loader — 不动(attachment 不入 transcript v2 落盘)

## 8. 与 OpenCC 的差异(刻意保留)

zai 不复刻 OpenCC 把 attachment 转 `createUserMessage({ isMeta:true })` 推 messages 数组再 `mergeAdjacentUserMessages` 的路径,原因:

- zai 的 `messages` 数组已严格 user/assistant 交替(transcript resume 后是历史 user/assistant/tool_result 序列),OpenCC 的 `mergeAdjacentUserMessages` 处理"两条 user 合并"在 zai 路径上是 noise
- zai 的 `systemPrompt` 数组是 string[] 形态,直接拼接字符串更简单
- prompt-cache 边界 marker 由 modelCaller 在 systemPrompt 数组上自然拆分,比 messages 数组里拆更友好

最终效果与 OpenCC **等价**:模型都收到 `<system-reminder>...</system-reminder>` 包裹的注入内容,且不破坏 user/assistant 协议约束。