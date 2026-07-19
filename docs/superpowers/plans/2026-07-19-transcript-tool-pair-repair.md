# Transcript Tool Pair Repair Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在 zai resume 前按 `parentUuid` DAG 修复错序的 `tool_use/tool_result`，验证协议后原子写回 transcript，避免 HTTP 400/2013。

**Architecture:** 新增纯函数 `repairTranscriptToolPairs` 将当前 active leaf 的因果链线性化为 canonical v2 records；新增 `TranscriptStore.mutateMessages` 在同一文件锁内读取、修复和写回。`queryLoop` resume 使用 `repairAndPersistTranscript` 返回的修复消息，再继续现有 `foldTopLevelToolUses` 和 `serializeForAnthropic`。

**Tech Stack:** TypeScript 5.6、Bun/pnpm、Vitest 4、`proper-lockfile`、现有 `TranscriptStore` v2 schema。

## Global Constraints

- 只修改 transcript repair、resume 集成和相关测试；不触碰已有 SSE 状态推送未提交修改。
- 保留 canonical v2 transcript 结构，继续兼容 UI 和现有 `foldTopLevelToolUses`。
- 修复必须幂等；修复后的协议校验失败时不得覆盖原 transcript。
- 未完成 `tool_use` 使用 `is_error: true` 的恢复 `tool_result` 闭合。
- 本次不实现同一 session 的完整运行时互斥锁。
- 不修改 Anthropic API client 或 provider 错误处理。
- 不创建新的第三方依赖。
- 除非用户明确要求，不创建 git commit；实现完成后保留工作区状态给用户检查。

---

### Task 1: 实现纯内存 DAG 修复函数

**Files:**
- Create: `packages/zai-agent-core/src/transcript/repair.ts`
- Create: `packages/zai-agent-core/test/transcript/repair.test.ts`
- Reference: `packages/zai-agent-core/src/transcript/types.ts:133-210`
- Reference: `packages/zai-agent-core/src/opencc-internals/utils/foldTopLevelToolUses.ts:106-191`

**Interfaces:**
- Produces `TranscriptRepairReport`, `TranscriptRepairResult` 和 `repairTranscriptToolPairs(messages)`，供 Task 2/3 使用。
- `repairTranscriptToolPairs` 不访问文件系统，不改变输入数组或输入 message 对象。

- [ ] **Step 1: 写失败测试，覆盖延迟结果和普通 prompt 插入。**

```ts
import { describe, expect, it } from 'vitest'
import type { TranscriptMessage } from '../../src/transcript/types.js'
import { repairTranscriptToolPairs } from '../../src/transcript/repair.js'

const record = (
  uuid: string,
  type: TranscriptMessage['type'],
  content: unknown,
  parentUuid: string | null = null,
): TranscriptMessage => ({
  uuid,
  parentUuid,
  timestamp: Number(uuid.replace(/\\D/g, '') || 1),
  cwd: '/x',
  userType: 'zai',
  sessionId: 's',
  version: '2',
  isSidechain: false,
  raw: null,
  type,
  message: { role: type === 'assistant' || type === 'tool_use' ? 'assistant' : 'user', content },
})

it('moves a delayed tool_result directly after its tool_use turn', () => {
  const assistant = record('a1', 'assistant', [{ type: 'text', text: 'run it' }])
  const tool = record('t1', 'tool_use', [{ type: 'tool_use', id: 'call-1', name: 'Bash', input: {} }], 'a1')
  const nextPrompt = record('u2', 'user', 'continue', 't1')
  const delayedResult = record('r1', 'user', [{ type: 'tool_result', tool_use_id: 'call-1', content: 'done', is_error: false }], 't1')

  const result = repairTranscriptToolPairs([assistant, tool, nextPrompt, delayedResult])
  const messages = result.messages

  expect(messages.map(message => message.type)).toEqual(['assistant', 'tool_use', 'user', 'user'])
  expect(messages[2].message?.content).toEqual([
    { type: 'tool_result', tool_use_id: 'call-1', content: 'done', is_error: false },
  ])
  expect(messages[3].message?.content).toBe('continue')
  expect(result.report.repairedToolUseIds).toEqual(['call-1'])
})

it('synthesizes an error result for an unresolved tool_use', () => {
  const assistant = record('a1', 'assistant', [])
  const tool = record('t1', 'tool_use', [{ type: 'tool_use', id: 'call-1', name: 'Bash', input: {} }], 'a1')

  const result = repairTranscriptToolPairs([assistant, tool])
  const recovery = result.messages.at(-1)?.message?.content

  expect(recovery).toEqual([
    expect.objectContaining({ type: 'tool_result', tool_use_id: 'call-1', is_error: true }),
  ])
  expect(result.report.synthesizedToolUseIds).toEqual(['call-1'])
})
```

- [ ] **Step 2: 运行测试确认当前实现失败。**

Run: `pnpm --filter @zn-ai/zai-agent-core exec vitest run test/transcript/repair.test.ts`

Expected: FAIL，因为 `src/transcript/repair.ts` 和 `repairTranscriptToolPairs` 尚不存在。

- [ ] **Step 3: 写最小 DAG 线性化实现。**

在 `repair.ts` 中定义：

```ts
export type TranscriptRepairReport = {
  repaired: boolean
  repairedToolUseIds: string[]
  synthesizedToolUseIds: string[]
  droppedMessageUuids: string[]
}

export type TranscriptRepairResult = {
  messages: TranscriptMessage[]
  report: TranscriptRepairReport
}

export function repairTranscriptToolPairs(
  messages: TranscriptMessage[],
): TranscriptRepairResult
```

实现顺序固定为：

1. 建立 `byUuid`、`childrenByParent`、`toolUsesById` 和 `resultsByToolUseId`。
2. 用原数组中 timestamp 最大的非纯 `tool_result` record 作为 active leaf；若不存在则使用 timestamp 最大 record；相同 timestamp 使用原数组后出现者。
3. 沿 `parentUuid` 回溯到 root，使用 `seen` 防止循环；只保留该链上的普通记录。
4. 对链上的 assistant，收集其全部 `type === 'tool_use'` 子记录；把它们按原数组顺序放在 parent assistant 后面，并把所有匹配结果紧接着组成一条 user record。
5. 对没有结果的 tool_use 生成新的 v2 user record，`parentUuid` 指向 tool_use record 的 UUID，block 使用 `is_error: true` 和固定恢复文案 `Transcript repair: tool execution did not complete.`。
6. 跳过原始 tool_use/tool_result record 的物理位置，防止重复；丢弃非 active chain 的分支并写入 `droppedMessageUuids`。
7. 对结果执行协议校验：每条 tool_result 必须紧跟包含对应 tool_use ID 的 assistant；失败时返回原数组副本和 `repaired: false`。
8. 通过稳定的 message/block 比较判断是否真的发生变化；已 canonical 的 transcript 第二次调用必须返回 `repaired: false`。

不要在这个函数里调用 `TranscriptStore`、读取环境变量或写日志。

- [ ] **Step 4: 运行纯函数测试。**

Run: `pnpm --filter @zn-ai/zai-agent-core exec vitest run test/transcript/repair.test.ts`

Expected: PASS，所有 repair fixture 通过。

- [ ] **Step 5: 扩展纯函数边界测试并运行。**

在同一测试文件增加以下完整断言：

```ts
it('groups parallel tool results into one user record and preserves child order', () => {
  const assistant = record('a1', 'assistant', [])
  const toolA = record(
    't1',
    'tool_use',
    [{ type: 'tool_use', id: 'call-a', name: 'Bash', input: {} }],
    'a1',
  )
  const toolB = record(
    't2',
    'tool_use',
    [{ type: 'tool_use', id: 'call-b', name: 'Read', input: {} }],
    'a1',
  )
  const resultB = record(
    'r2',
    'user',
    [{ type: 'tool_result', tool_use_id: 'call-b', content: 'b', is_error: false }],
    't2',
  )
  const resultA = record(
    'r1',
    'user',
    [{ type: 'tool_result', tool_use_id: 'call-a', content: 'a', is_error: false }],
    't1',
  )

  const result = repairTranscriptToolPairs([assistant, toolA, toolB, resultB, resultA])
  const toolResults = result.messages.filter(message => {
    const content = message.message?.content
    return Array.isArray(content) && content.some(block => block.type === 'tool_result')
  })

  expect(result.messages.map(message => message.type)).toEqual(['assistant', 'tool_use', 'tool_use', 'user'])
  expect(toolResults).toHaveLength(1)
  expect((toolResults[0].message?.content as Array<{ tool_use_id: string }>).map(block => block.tool_use_id))
    .toEqual(['call-a', 'call-b'])
})

it('repairs a result when the next prompt is a sibling of the tool_use', () => {
  const assistant = record('a1', 'assistant', [])
  const tool = record(
    't1',
    'tool_use',
    [{ type: 'tool_use', id: 'call-sibling', name: 'Bash', input: {} }],
    'a1',
  )
  const nextPrompt = record('u900', 'user', 'continue', 'a1')
  const delayedResult = record(
    'r800',
    'user',
    [{ type: 'tool_result', tool_use_id: 'call-sibling', content: 'done', is_error: false }],
    't1',
  )

  const result = repairTranscriptToolPairs([assistant, tool, nextPrompt, delayedResult])

  expect(result.messages.map(message => message.type)).toEqual(['assistant', 'tool_use', 'user', 'user'])
  expect((result.messages[2].message?.content as Array<{ tool_use_id?: string }>)[0]?.tool_use_id)
    .toBe('call-sibling')
  expect(result.messages[3].message?.content).toBe('continue')
})

it('drops a disconnected branch and reports its UUIDs', () => {
  const root = record('a1', 'assistant', [])
  const stale = record('a800', 'assistant', [{ type: 'text', text: 'stale' }], 'a1')
  const active = record('u900', 'user', 'active', 'a1')

  const result = repairTranscriptToolPairs([root, stale, active])

  expect(result.messages.map(message => message.uuid)).toEqual(['a1', 'u900'])
  expect(result.report.droppedMessageUuids).toEqual(['a800'])
})

it('does not mutate input and is idempotent', () => {
  const input = [
    record('a1', 'assistant', []),
    record('t1', 'tool_use', [{ type: 'tool_use', id: 'call-1', name: 'Bash', input: {} }], 'a1'),
  ]
  const snapshot = structuredClone(input)

  const first = repairTranscriptToolPairs(input)
  const second = repairTranscriptToolPairs(first.messages)

  expect(input).toEqual(snapshot)
  expect(first.report.repaired).toBe(true)
  expect(second.report.repaired).toBe(false)
  expect(second.messages).toEqual(first.messages)
})
```

Run: `pnpm --filter @zn-ai/zai-agent-core exec vitest run test/transcript/repair.test.ts`

Expected: PASS。

---

### Task 2: 增加文件锁内的持久化入口

**Files:**
- Modify: `packages/zai-agent-core/src/transcript/store.ts:33-67`
- Modify: `packages/zai-agent-core/src/transcript/repair.ts`
- Modify: `packages/zai-agent-core/test/transcript/store.test.ts`
- Create: `packages/zai-agent-core/test/transcript/repair-persistence.test.ts`

**Interfaces:**
- `TranscriptStore.mutateMessages<T>(transcriptId, mutate)` 在同一 `proper-lockfile` 锁内完成 read → mutate → optional write，并返回 `mutate` 的 `value`。
- `repairAndPersistTranscript(store, sessionId)` 调用 `mutateMessages`，返回 `TranscriptRepairResult`；只有 `report.repaired === true` 且校验通过时写回。

- [ ] **Step 1: 为原子 mutation 写失败测试。**

在 `repair-persistence.test.ts` 的临时 `TranscriptStore` setup 中写入明确的错序 fixture：

```ts
await appendAssistantMessageV2(
  store,
  sessionId,
  [{ type: 'text', text: 'run it' }],
  0,
  null,
  { cwd: '/x', sessionId },
)
const toolUuid = (await appendToolUse(
  store,
  sessionId,
  { id: 'call-1', name: 'Bash', input: {} },
  0,
  null,
  '/x',
))!
await appendUserMessageV2(store, sessionId, 'next prompt', 1, toolUuid, { cwd: '/x', sessionId })
await appendToolResult(
  store,
  sessionId,
  { tool_use_id: 'call-1', content: 'done', is_error: false },
  0,
  toolUuid,
  '/x',
)

const first = await repairAndPersistTranscript(store, sessionId)
const second = await repairAndPersistTranscript(store, sessionId)

expect(first.report.repaired).toBe(true)
expect(second.report.repaired).toBe(false)
expect((await store.read(sessionId)).messages).toEqual(first.messages)
```

- [ ] **Step 2: 运行测试确认失败。**

Run: `pnpm --filter @zn-ai/zai-agent-core exec vitest run test/transcript/repair-persistence.test.ts test/transcript/store.test.ts`

Expected: FAIL，因为 `mutateMessages` 和 `repairAndPersistTranscript` 尚未实现。

- [ ] **Step 3: 在 `TranscriptStore` 增加 locked mutation。**

添加以下方法，复用现有 `append`/`replace` 的 lock、deserialize 和 write 模式：

```ts
async mutateMessages<T>(
  transcriptId: string,
  mutate: (messages: TranscriptMessage[]) => {
    messages: TranscriptMessage[]
    changed: boolean
    value: T
  },
): Promise<T> {
  const filePath = transcriptPath(this.dataDir, transcriptId)
  const release = await lock(filePath, { retries: 3 })
  try {
    const raw = await readFile(filePath, 'utf-8')
    const file = deserializeFile(raw)
    const result = mutate(file.messages)
    if (result.changed) {
      file.messages = result.messages
      file.meta.updatedAt = Date.now()
      await writeFile(filePath, serializeFile(file), 'utf-8')
    }
    return result.value
  } finally {
    await release()
  }
}
```

- [ ] **Step 4: 实现 `repairAndPersistTranscript`。**

```ts
export async function repairAndPersistTranscript(
  store: TranscriptStore,
  sessionId: string,
): Promise<TranscriptRepairResult> {
  return store.mutateMessages(sessionId, messages => {
    const result = repairTranscriptToolPairs(messages)
    return {
      messages: result.messages,
      changed: result.report.repaired,
      value: result,
    }
  })
}
```

- [ ] **Step 5: 运行持久化测试。**

Run: `pnpm --filter @zn-ai/zai-agent-core exec vitest run test/transcript/repair-persistence.test.ts test/transcript/store.test.ts`

Expected: PASS，首次调用修复并落盘，第二次调用不改写；原子 mutation 不破坏既有 store 测试。

---

### Task 3: 接入 queryLoop resume

**Files:**
- Modify: `packages/zai-agent-core/src/runtime/queryLoop.ts:145-190`
- Modify: `packages/zai-agent-core/test/runtime/queryLoop-resume-2013.test.ts`

**Interfaces:**
- `queryLoop` resume 读取 transcript 后先调用 `repairAndPersistTranscript`。
- 修复返回的 `messages` 作为后续 `foldTopLevelToolUses` 输入；现有 API serialization 行为保持不变。

- [ ] **Step 1: 添加 resume 回归测试。**

在 `queryLoop-resume-2013.test.ts` 增加真实 `queryLoop` 回归测试，使用现有 `collect`、临时 `TranscriptStore` 和 `ModelCaller` fixture：

```ts
it('repairs a delayed tool_result before sending the resume payload', async () => {
  const store = new TranscriptStore(tmpDir)
  const sessionId = await store.create({ cwd: '/x', model: 'm' })
  const userUuid = await appendUserMessageV2(
    store, sessionId, 'run it', 0, null, { cwd: '/x', sessionId },
  )
  const assistantUuid = await appendAssistantMessageV2(
    store,
    sessionId,
    [{ type: 'text', text: 'running' }],
    0,
    userUuid,
    { cwd: '/x', sessionId },
  )
  const toolUuid = await appendToolUse(
    store,
    sessionId,
    { id: 'call-1', name: 'Bash', input: {} },
    0,
    assistantUuid!,
    '/x',
  )

  // 普通 prompt 是 tool_use 的 sibling，而不是它的 child。
  await appendUserMessageV2(
    store, sessionId, 'next prompt', 1, assistantUuid!, { cwd: '/x', sessionId },
  )
  await appendToolResult(
    store,
    sessionId,
    { tool_use_id: 'call-1', content: 'done', is_error: false },
    0,
    toolUuid!,
    '/x',
  )

  const seen: Array<{ role: 'user' | 'assistant'; content: unknown }> = []
  const captureCaller: ModelCaller = async function* (req) {
    seen.push(...req.messages)
    yield { type: 'message_start', message: { id: 'm1' } }
    yield { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'ok' } }
    yield { type: 'message_stop' }
  }

  await collect(queryLoop(
    { prompt: 'new', cwd: '/x', transcriptId: sessionId },
    { dataDir: tmpDir, modelCaller: captureCaller },
  ))

  const assistantIndex = seen.findIndex(message => {
    if (message.role !== 'assistant' || !Array.isArray(message.content)) return false
    return message.content.some(block => {
      if (typeof block !== 'object' || block === null) return false
      const value = block as { type?: string; id?: string }
      return value.type === 'tool_use' && value.id === 'call-1'
    })
  })
  expect(assistantIndex).toBeGreaterThanOrEqual(0)

  const resultMessage = seen[assistantIndex + 1]!
  expect(resultMessage.role).toBe('user')
  expect((resultMessage.content as Array<{ type?: string; tool_use_id?: string }>)
    .filter(block => block.type === 'tool_result')
    .map(block => block.tool_use_id))
    .toEqual(['call-1'])
})
```

- [ ] **Step 2: 运行回归测试确认未接入前失败。**

Run: `pnpm --filter @zn-ai/zai-agent-core exec vitest run test/runtime/queryLoop-resume-2013.test.ts`

Expected: FAIL，当前 queryLoop 仍直接使用物理顺序 transcript。

- [ ] **Step 3: 接入 queryLoop。**

在 `queryLoop.ts` 的 `if (t)` 分支中将现有逻辑调整为：

```ts
if (t) {
  const repaired = await repairAndPersistTranscript(store, resumeId)
  t = { ...t, messages: repaired.messages }
  if (process.env.ZAI_DEBUG === '1' && repaired.report.repaired) {
    console.error('[zai.queryLoop] repaired transcript tool pairs', {
      sessionId,
      ...repaired.report,
    })
  }

  const folded = foldTopLevelToolUses(t.messages as unknown as Parameters<typeof foldTopLevelToolUses>[0])
  messages.push(...serializeForAnthropic(folded as unknown as Parameters<typeof serializeForAnthropic>[0]))
  // 保留现有 lastUuid 初始化逻辑。
}
```

保留 `lastUuid` 从最新修复后 transcript record 初始化；不修改新 prompt 的 append 路径。这里的 `as unknown as Parameters<...>` 与现有 `queryLoop.ts:172-178` 的泛型边界转换保持一致；不得新增 `as any`。

- [ ] **Step 4: 运行 resume 测试和 transcript 全套测试。**

Run: `pnpm --filter @zn-ai/zai-agent-core exec vitest run test/transcript/ test/runtime/queryLoop-resume-2013.test.ts`

Expected: PASS，新增错序回归通过，现有 fold/serialization/resume 测试不回归。

---

### Task 4: 协议回归与全量验证

**Files:**
- Modify: `packages/zai-agent-core/test/transcript/serializeForAnthropic.test.ts`
- Modify: `packages/zai-agent-core/test/runtime/queryLoop-resume-2013.test.ts`

**Interfaces:**
- 测试验证修复后的 canonical messages 满足当前 Anthropic tool protocol，不新增生产 API。

- [ ] **Step 1: 增加统一协议断言。**

在 `serializeForAnthropic.test.ts` 顶部增加以下 imports，并在该文件中加入统一断言和回归 case：

```ts
import { foldTopLevelToolUses } from '../../src/opencc-internals/utils/foldTopLevelToolUses.js'
import { repairTranscriptToolPairs } from '../../src/transcript/repair.js'
```

```ts
type ToolBlock = { type?: string; id?: string; tool_use_id?: string }

const blocksOf = (content: unknown): ToolBlock[] => {
  if (!Array.isArray(content)) return []
  return content.filter((block): block is ToolBlock => (
    typeof block === 'object' && block !== null
  ))
}

function expectValidToolSequence(messages: Array<{ role: string; content: unknown }>): void {
  for (let i = 0; i < messages.length; i++) {
    const results = blocksOf(messages[i].content).filter(block => block.type === 'tool_result')
    if (results.length === 0) continue
    expect(messages[i - 1]?.role).toBe('assistant')
    const uses = new Set(
      blocksOf(messages[i - 1].content)
        .filter(block => block.type === 'tool_use')
        .map(block => block.id),
    )
    for (const result of results) expect(uses.has(result.tool_use_id)).toBe(true)
  }
}

it('accepts the repaired branch as a valid tool sequence', () => {
  const repaired = repairTranscriptToolPairs([
    {
      uuid: 'a1', parentUuid: null, timestamp: 1, cwd: '/x', userType: 'zai',
      sessionId: 's', version: '2', isSidechain: false, raw: null,
      type: 'assistant', message: { role: 'assistant', content: [] },
    },
    {
      uuid: 't1', parentUuid: 'a1', timestamp: 2, cwd: '/x', userType: 'zai',
      sessionId: 's', version: '2', isSidechain: false, raw: null,
      type: 'tool_use', message: {
        role: 'assistant',
        content: [{ type: 'tool_use', id: 'call-1', name: 'Bash', input: {} }],
      },
    },
    {
      uuid: 'u1', parentUuid: 't1', timestamp: 3, cwd: '/x', userType: 'zai',
      sessionId: 's', version: '2', isSidechain: false, raw: null,
      type: 'user', message: { role: 'user', content: 'next prompt' },
    },
    {
      uuid: 'r1', parentUuid: 't1', timestamp: 4, cwd: '/x', userType: 'zai',
      sessionId: 's', version: '2', isSidechain: false, raw: null,
      type: 'user', message: {
        role: 'user',
        content: [{ type: 'tool_result', tool_use_id: 'call-1', content: 'done', is_error: false }],
      },
    },
  ])
  const folded = foldTopLevelToolUses(
    repaired.messages as Parameters<typeof foldTopLevelToolUses>[0],
  )
  const api = serializeForAnthropic(
    folded as Parameters<typeof serializeForAnthropic>[0],
  )

  expectValidToolSequence(api)
})
```

用上面的 malformed branch fixture 调用修复后 serialization，再调用 `expectValidToolSequence`。

- [ ] **Step 2: 运行 transcript、runtime 和类型检查。**

Run: `pnpm --filter @zn-ai/zai-agent-core exec vitest run test/transcript/ test/runtime/`

Expected: PASS，所有 transcript/runtime tests 通过。

Run: `pnpm --filter @zn-ai/zai-agent-core typecheck`

Expected: PASS，TypeScript 无新增错误。

- [ ] **Step 3: 运行 package build。**

Run: `pnpm --filter @zn-ai/zai-agent-core build`

Expected: PASS，`tsc -b` 完成且不改动其它 workspace 文件。

- [ ] **Step 4: 检查工作区变更边界。**

Run: `git status --short`

Expected: 只出现 transcript repair 相关新增/修改，以及任务开始前已经存在的 SSE 未提交修改；不删除、不覆盖用户已有文件。

---

## Implementation Handoff

实现顺序：Task 1 → Task 2 → Task 3 → Task 4。每个任务先写失败测试，再实现最小代码，再运行该任务的测试。实现过程中不要提交 git commit，除非用户另行明确要求。
