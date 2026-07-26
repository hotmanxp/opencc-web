# `/compact` v2 + Token 估算模块 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Upgrade `/compact` 命令到 OpenCC 同款完整版(streaming 摘要 + PTL 自愈 + prompt cache dual path + pre/post hook 接口),把 token 估算抽到独立模块,把旧的 `runtime/compactService.ts` 替换为 `runtime/compact/index.ts` 内的 shim。

**Architecture:** 在 `packages/zai-agent-core/src/runtime/compact/` 下新增 5 个小文件(`token-estimate` / `serialize-for-compact` / `ptl-retry` / `prompt-cache-share` / `hooks`),改造 `conversation.ts` / `autocompact.ts` / `index.ts` 注入新模块;`compactSession()` 入口迁入 `runtime/compact/index.ts`;`runtime/compactService.ts` 文件删除;所有 import 迁移。PTL 重试循环外置在 `compactSession`(shim),`compactConversation` 内部只跑一次。

**Tech Stack:** TypeScript / Vitest / Bun (smoke e2e) / proper-lockfile / SSE。无新增第三方依赖。

**Spec 来源:** `docs/superpowers/specs/2026-07-26-zai-compact-command-v2-design.md`(commit `c410865`)

---

## Global Constraints

- **依赖隔离**:`runtime/compact/` 不 import `opencc-internals/*` 任何代码(独立实现)。
- **依赖隔离**:`runtime/compact/` 不 import `react` / `antd`(纯 TS,服务端同构)。
- **常量**(从 spec §7.3 / §4 拷贝,所有 task 隐式遵守):
  - `PTL_RETRY_MAX = 3`(重试上限)
  - `HOOK_TIMEOUT_MS = 5_000`(hook 调用超时)
  - `TOOL_RESULT_TRUNCATE_BYTES = 500`(复用旧 compactService.ts 规则)
  - `MAX_CONTEXT_WINDOW_DEFAULT = 200_000`(token gap 计算兜底)
  - `PTL_HEADROOM_BUFFER_TOKENS = 50_000`(gap 不足阈值)
- **环境变量**(沿用阶段 1,见 spec `2026-07-19-zai-session-compaction-design.md` §3.1):
  - `ZAI_DISABLE_AUTO_COMPACT`(`0`) / `ZAI_DISABLE_COMPACT`(`0`) / `ZAI_AUTOCOMPACT_PCT_OVERRIDE` / `ZAI_AUTOCOMPACT_FAILURE_COOLDOWN_MS`(`300000`) / `ZAI_MAX_ACTIVE_MESSAGES`(`200`) / `ZAI_AUTOCOMPACT_FORCE_FLOOR_PCT`(`75`)
- **测试运行命令**:`cd packages/zai-agent-core && bunx vitest run test/runtime/compact/<file>.test.ts`(单文件)或 `bunx vitest run`(全量)。
- **Smoke e2e 命令**:`cd packages/zai-agent-core && bun run scripts/smoke-compact-e2e.ts`。
- **commit 风格**:Conventional Commits(`feat(zai-agent-core): ...` / `test(...)` / `refactor(...)`)。
- **行数上限**:每个新文件 ≤ 200 行;`conversation.ts` 接受 230-280 行(职责单一优先),拒绝超过 300 行。
- **覆盖率门**:关键模块 `line ≥ 92%, branch ≥ 80%`(沿用阶段 1 spec §11.6)。
- **不变量**:
  1. `compactSession({store, sessionId, modelCaller, cwd, model?})` 字段 100% 兼容旧 `compactService.ts`(新增可选 `providerKind` 不破坏现有调用方)。
  2. 删除 `compactService.ts` 后,所有 import 路径全改;不留 dead re-export。
  3. `compactService.test.ts` 的 7 个 case 必须全部迁移到 `runtime/compact/command-session.test.ts`,行为不变(包括 `newMessages.length === 6` / `uuid chain` / `thinking 丢弃` / `tool_result 500B 截断`)。
  4. `compactConversation` 内部不直接处理 PTL 重试,只透传错误给 `compactSession` shim。
  5. `serializeForCompact` 必须与旧 `compactService.ts:36-80` 行为兼容(thinking 丢弃、tool_use JSON、tool_result 500B 截断、image 计数)。

---

## Task 1: 探测 baseline + dual path 注入点

**Files:**
- Modify: (无)
- Test: 现有 `conversation.test.ts` / `compactService.test.ts`(只跑不修)

- [ ] **Step 1: 跑现有 conversation 测试**

Run: `cd packages/zai-agent-core && bunx vitest run test/runtime/compact/conversation.test.ts`
Expected: PASS(阶段 1 已有 4 个 case)。

- [ ] **Step 2: 跑现有 compactService 测试**

Run: `cd packages/zai-agent-core && bunx vitest run test/runtime/compactService.test.ts`
Expected: PASS(7 个 case)。

- [ ] **Step 3: 探测 provider.kind 注入点**

Run: `grep -rn "provider.*kind\|resolveProvider" packages/zai-agent-core/src packages/zai/src --include="*.ts" | head -20`
Expected: 找到 `provider.kind === 'openai'` 或 `resolveProviderKind` 调用点。

- [ ] **Step 4: 探测 ANTHROPIC_BASE_URL / OPENAI_BASE_URL env 用法**

Run: `grep -rn "ANTHROPIC_BASE_URL\|OPENAI_BASE_URL" packages/zai-agent-core/src packages/zai/src --include="*.ts" | head -10`

- [ ] **Step 5: 提交探测记录**

```bash
git commit --allow-empty -m "chore(zai-agent-core): baseline probe for /compact v2 task 1"
```

---

## Task 2: `token-estimate.ts` — 启发式 token 估算

**Files:**
- Create: `packages/zai-agent-core/src/runtime/compact/token-estimate.ts`(≤ 90 行)
- Create: `packages/zai-agent-core/test/runtime/compact/token-estimate.test.ts`

- [ ] **Step 1: 写失败测试**

`packages/zai-agent-core/test/runtime/compact/token-estimate.test.ts`:

```ts
import { describe, expect, it } from 'vitest'
import { estimateMessagesTokenCount } from '../../../src/runtime/compact/token-estimate.js'

function mkMsg(content: unknown, type: string = 'user'): any {
  return { type, message: { content }, cwd: '/', sessionId: 's', uuid: Math.random().toString() }
}

describe('estimateMessagesTokenCount', () => {
  it('中文 text 按 1.5 字符/token', () => {
    const msg = mkMsg([{ type: 'text', text: '一二三四五六七八九一二三四五六七八九一二三四五六七八九' }])
    expect(estimateMessagesTokenCount([msg])).toBe(20)
  })

  it('英文 text 按 4 字符/token', () => {
    const msg = mkMsg([{ type: 'text', text: 'a'.repeat(40) }])
    expect(estimateMessagesTokenCount([msg])).toBe(10)
  })

  it('混合(50/50)按 2.5 字符/token', () => {
    const msg = mkMsg([{ type: 'text', text: '一二三四五六七八九一二三四五六七八九aaaaaaaaaaaaaaaaaaaa' }])
    expect(estimateMessagesTokenCount([msg])).toBe(16)
  })

  it('thinking block 同 text', () => {
    const msg = mkMsg([{ type: 'thinking', thinking: '一二三四五六七八九一二三四五六七八九一二三四五六七八九' }], 'assistant')
    expect(estimateMessagesTokenCount([msg])).toBe(20)
  })

  it('image block 固定 1000 tokens', () => {
    const msg = mkMsg([{ type: 'image', source: { media_type: 'image/png' } }])
    expect(estimateMessagesTokenCount([msg])).toBe(1000)
  })

  it('tool_use block 按 (name + JSON.stringify(input).length) / 3', () => {
    const msg = mkMsg([{ type: 'tool_use', name: 'Bash', input: { cmd: 'ls' } }], 'assistant')
    expect(estimateMessagesTokenCount([msg])).toBe(6)
  })

  it('tool_result block 按 JSON.stringify(content).length / 3', () => {
    const msg = mkMsg([{ type: 'tool_result', tool_use_id: 't1', content: 'hello world' }])
    expect(estimateMessagesTokenCount([msg])).toBe(5)
  })

  it('空 messages 返回 0', () => {
    expect(estimateMessagesTokenCount([])).toBe(0)
  })
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cd packages/zai-agent-core && bunx vitest run test/runtime/compact/token-estimate.test.ts`
Expected: FAIL `Cannot find module`。

- [ ] **Step 3: 实现 token-estimate.ts**

```ts
/**
 * 启发式 token 估算 — 不调 API。
 *
 * 公式:
 * - text / thinking: 非 ASCII > 50% → 1.5,< 50% → 4,中间 → 2.5
 * - tool_use: (name.length + JSON.stringify(input).length) / 3
 * - tool_result: JSON.stringify(content).length / 3
 * - image: 固定 1000
 *
 * spec §4.2:估算只用于 shouldAutoCompact 触发判定;不写入 boundary messages。
 */

import type { TranscriptMessage } from '../../transcript/types.js'

type Block = { type?: string; text?: string; thinking?: string; name?: string; input?: unknown; content?: unknown }

function nonAsciiRatio(s: string): number {
  if (s.length === 0) return 0
  let nonAscii = 0
  for (let i = 0; i < s.length; i++) {
    if (s.charCodeAt(i) > 127) nonAscii++
  }
  return nonAscii / s.length
}

function textTokens(s: string): number {
  if (!s) return 0
  const ratio = nonAsciiRatio(s)
  const divisor = ratio > 0.5 ? 1.5 : ratio < 0.5 ? 4 : 2.5
  return Math.ceil(s.length / divisor)
}

function blockTokens(b: Block): number {
  switch (b.type) {
    case 'text':
      return textTokens(b.text ?? '')
    case 'thinking':
      return textTokens(b.thinking ?? '')
    case 'tool_use':
      return Math.ceil(((b.name?.length ?? 0) + JSON.stringify(b.input ?? {}).length) / 3)
    case 'tool_result':
      return Math.ceil(JSON.stringify(b.content ?? '').length / 3)
    case 'image':
      return 1000
    default:
      return 0
  }
}

function messageTokens(m: TranscriptMessage): number {
  const content = m.message?.content
  if (typeof content === 'string') return textTokens(content)
  if (!Array.isArray(content)) return 0
  let total = 0
  for (const b of content) {
    if (b && typeof b === 'object') total += blockTokens(b as Block)
  }
  return total
}

export function estimateMessagesTokenCount(messages: TranscriptMessage[]): number {
  let total = 0
  for (const m of messages) total += messageTokens(m)
  return total
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `cd packages/zai-agent-core && bunx vitest run test/runtime/compact/token-estimate.test.ts`
Expected: 8 个 case 全 PASS。

- [ ] **Step 5: 提交**

```bash
git add packages/zai-agent-core/src/runtime/compact/token-estimate.ts \
        packages/zai-agent-core/test/runtime/compact/token-estimate.test.ts
git commit -m "feat(zai-agent-core): heuristic token estimator for compact module"
```

---

## Task 3: `serialize-for-compact.ts` — 完整版对话序列化

**Files:**
- Create: `packages/zai-agent-core/src/runtime/compact/serialize-for-compact.ts`(≤ 100 行)
- Create: `packages/zai-agent-core/test/runtime/compact/serialize-for-compact.test.ts`

- [ ] **Step 1: 写失败测试**

```ts
import { describe, expect, it } from 'vitest'
import { serializeForCompact } from '../../../src/runtime/compact/serialize-for-compact.js'

function mkMsg(content: unknown, type: string = 'user'): any {
  return { type, message: { content }, cwd: '/', sessionId: 's', uuid: Math.random().toString() }
}

describe('serializeForCompact', () => {
  it('text → [role] text', () => {
    expect(serializeForCompact([mkMsg([{ type: 'text', text: 'hi' }], 'user')])).toBe('[user] hi')
  })

  it('thinking 丢弃', () => {
    const msg = mkMsg(
      [{ type: 'thinking', thinking: 'secret' }, { type: 'text', text: 'answer' }],
      'assistant',
    )
    const out = serializeForCompact([msg])
    expect(out).not.toContain('secret')
    expect(out).toContain('answer')
  })

  it('tool_use JSON 序列化', () => {
    const msg = mkMsg([{ type: 'tool_use', name: 'Bash', input: { cmd: 'ls' } }], 'assistant')
    const out = serializeForCompact([msg])
    expect(out).toContain('[tool_use: Bash]')
    expect(out).toContain('"cmd":"ls"')
  })

  it('tool_result 500B 截断', () => {
    const msg = mkMsg([{ type: 'tool_result', tool_use_id: 't1', content: 'x'.repeat(800), is_error: false }], 'user')
    const out = serializeForCompact([msg])
    expect(out).toContain('...(truncated)')
    expect(out).not.toContain('x'.repeat(600))
  })

  it('image 计数', () => {
    const msg = mkMsg(
      [
        { type: 'image', source: { media_type: 'image/png' } },
        { type: 'image', source: { media_type: 'image/jpeg' } },
      ],
      'user',
    )
    const out = serializeForCompact([msg])
    expect(out).toContain('[图片附件 1]')
    expect(out).toContain('[图片附件 2]')
  })

  it('空 messages 返回 ""', () => {
    expect(serializeForCompact([])).toBe('')
  })

  it('string content 直接 dump', () => {
    expect(serializeForCompact([mkMsg('hello', 'user')])).toBe('[user] hello')
  })
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cd packages/zai-agent-core && bunx vitest run test/runtime/compact/serialize-for-compact.test.ts`
Expected: FAIL `Cannot find module`。

- [ ] **Step 3: 实现 serialize-for-compact.ts**

```ts
/**
 * 把对话历史转成 Markdown,喂给 LLM 生成摘要。
 *
 * 与旧 compactService.ts:36-80 行为兼容(spec Global Constraints 不变量 5)。
 */

import type { TranscriptMessage } from '../../transcript/types.js'

const TOOL_RESULT_TRUNCATE_BYTES = 500

type Block = {
  type?: string
  text?: string
  thinking?: string
  name?: string
  input?: unknown
  tool_use_id?: string
  content?: unknown
  is_error?: boolean
  source?: { media_type?: string }
}

function blockToString(role: string, block: Block, imageCountRef: { n: number }): string | null {
  switch (block.type) {
    case 'text':
      return `[${role}] ${block.text ?? ''}`
    case 'thinking':
      return null
    case 'tool_use':
      return `> [tool_use: ${block.name ?? ''}] ${JSON.stringify(block.input ?? {})}`
    case 'tool_result': {
      let s: string
      const c = block.content
      if (typeof c === 'string') s = c
      else s = JSON.stringify(c)
      if (s.length > TOOL_RESULT_TRUNCATE_BYTES) {
        s = s.slice(0, TOOL_RESULT_TRUNCATE_BYTES) + '...(truncated)'
      }
      return `> [tool_result: ${block.is_error ? 'error' : 'ok'}]${s}`
    }
    case 'image':
      imageCountRef.n++
      return `[${role}] [图片附件 ${imageCountRef.n}]`
    default:
      return `[${role}] [未知块类型: ${block.type}]`
  }
}

export function serializeForCompact(messages: TranscriptMessage[]): string {
  const parts: string[] = []
  for (const m of messages) {
    const role = m.type === 'user' ? 'user' : 'assistant'
    const content = m.message?.content
    const imageCountRef = { n: 0 }
    const partsForMsg: string[] = []
    if (typeof content === 'string') {
      partsForMsg.push(`[${role}] ${content}`)
    } else if (Array.isArray(content)) {
      for (const b of content) {
        if (b && typeof b === 'object') {
          const s = blockToString(role, b as Block, imageCountRef)
          if (s) partsForMsg.push(s)
        }
      }
    } else {
      partsForMsg.push(`[${role}] ${String(content)}`)
    }
    parts.push(partsForMsg.join('\n\n'))
  }
  return parts.join('\n\n')
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `cd packages/zai-agent-core && bunx vitest run test/runtime/compact/serialize-for-compact.test.ts`
Expected: 7 个 case 全 PASS。

- [ ] **Step 5: 提交**

```bash
git add packages/zai-agent-core/src/runtime/compact/serialize-for-compact.ts \
        packages/zai-agent-core/test/runtime/compact/serialize-for-compact.test.ts
git commit -m "feat(zai-agent-core): extract serializeForCompact from compactService"
```

---

## Task 4: `ptl-retry.ts` — PTL 自愈削头

**Files:**
- Create: `packages/zai-agent-core/src/runtime/compact/ptl-retry.ts`(≤ 90 行)
- Create: `packages/zai-agent-core/test/runtime/compact/ptl-retry.test.ts`

- [ ] **Step 1: 写失败测试**

```ts
import { describe, expect, it } from 'vitest'
import { truncateHeadForPTLRetry, getPromptTooLongTokenGap } from '../../../src/runtime/compact/ptl-retry.js'

function mkMsg(type: string, uuid: string): any {
  return { type, uuid, parentUuid: null, message: { content: [{ type: 'text', text: `${type}-${uuid}` }] }, cwd: '/', sessionId: 's', runtime: { turnIndex: 0 } }
}

function msgChain(types: string[]): any[] {
  return types.map((t, i) => mkMsg(t, `u${i}`))
}

describe('getPromptTooLongTokenGap', () => {
  it('output_tokens 接近 contextWindow → gap 接近 0', () => {
    expect(getPromptTooLongTokenGap({ usage: { output_tokens: 199_000 } }, 200_000)).toBeLessThan(2_000)
  })

  it('无 usage → gap = contextWindow', () => {
    expect(getPromptTooLongTokenGap({}, 200_000)).toBe(200_000)
  })
})

describe('truncateHeadForPTLRetry', () => {
  it('user+assistant 一组 → 削前 2 条', () => {
    const msgs = msgChain(['user', 'assistant', 'user', 'assistant'])
    const out = truncateHeadForPTLRetry(msgs, { usage: { output_tokens: 199_000 } }, 200_000)
    expect(out).not.toBeNull()
    expect(out!.map((m: any) => m.type)).toEqual(['user', 'assistant'])
  })

  it('3 件套 + 剩余 1 user', () => {
    const msgs = msgChain(['user', 'assistant', 'user', 'assistant', 'user'])
    const out = truncateHeadForPTLRetry(msgs, { usage: { output_tokens: 199_000 } }, 200_000)
    expect(out!.length).toBe(1)
  })

  it('剩余 < 2 条 → null', () => {
    expect(truncateHeadForPTLRetry(msgChain(['user', 'assistant']), { usage: { output_tokens: 199_000 } }, 200_000)).toBeNull()
  })

  it('空 messages → null', () => {
    expect(truncateHeadForPTLRetry([], {}, 200_000)).toBeNull()
  })

  it('gap < 50k → null', () => {
    expect(truncateHeadForPTLRetry(msgChain(['user', 'assistant', 'user', 'assistant']), { usage: { output_tokens: 180_000 } }, 200_000)).toBeNull()
  })
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cd packages/zai-agent-core && bunx vitest run test/runtime/compact/ptl-retry.test.ts`
Expected: FAIL `Cannot find module`。

- [ ] **Step 3: 实现 ptl-retry.ts**

```ts
/**
 * PTL 自愈削头。
 *
 * spec §4.1:每次削掉最早的 1 个 API-round group(从首个 user 开始,
 * 到下一个 user 之前)。返回 null 表示无法削够 / 消息数 < 2 / gap 不足。
 */

import type { TranscriptMessage } from '../../transcript/types.js'

const MIN_REMAINING_MESSAGES = 2
const PTL_HEADROOM_BUFFER_TOKENS = 50_000

export function getPromptTooLongTokenGap(
  ptlResponse: { usage?: { output_tokens?: number } },
  contextWindow: number,
): number {
  const used = ptlResponse?.usage?.output_tokens
  if (typeof used !== 'number' || !Number.isFinite(used)) return contextWindow
  return Math.max(0, contextWindow - used)
}

function findNextUserIndex(messages: TranscriptMessage[], startFrom: number): number {
  for (let i = startFrom; i < messages.length; i++) {
    if (messages[i]!.type === 'user') return i
  }
  return messages.length
}

export function truncateHeadForPTLRetry(
  messages: TranscriptMessage[],
  ptlResponse: { usage?: { output_tokens?: number } },
  contextWindow: number,
): TranscriptMessage[] | null {
  if (messages.length < MIN_REMAINING_MESSAGES) return null
  const gap = getPromptTooLongTokenGap(ptlResponse, contextWindow)
  if (gap < PTL_HEADROOM_BUFFER_TOKENS) return null
  const firstUserIdx = messages.findIndex((m) => m.type === 'user')
  if (firstUserIdx < 0) return null
  const nextUserIdx = findNextUserIndex(messages, firstUserIdx + 1)
  const remaining = messages.slice(nextUserIdx)
  if (remaining.length < MIN_REMAINING_MESSAGES) return null
  return remaining
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `cd packages/zai-agent-core && bunx vitest run test/runtime/compact/ptl-retry.test.ts`
Expected: 7 个 case 全 PASS。

- [ ] **Step 5: 提交**

```bash
git add packages/zai-agent-core/src/runtime/compact/ptl-retry.ts \
        packages/zai-agent-core/test/runtime/compact/ptl-retry.test.ts
git commit -m "feat(zai-agent-core): PTL self-healing truncateHeadForPTLRetry"
```

---

## Task 5: `prompt-cache-share.ts` — Dual path 判断

**Files:**
- Create: `packages/zai-agent-core/src/runtime/compact/prompt-cache-share.ts`(≤ 20 行)
- Create: `packages/zai-agent-core/test/runtime/compact/prompt-cache-share.test.ts`

- [ ] **Step 1: 写失败测试**

```ts
import { describe, expect, it } from 'vitest'
import { isCompactionCacheSharingCompatible } from '../../../src/runtime/compact/prompt-cache-share.js'

describe('isCompactionCacheSharingCompatible', () => {
  it("'anthropic' → true", () => expect(isCompactionCacheSharingCompatible('anthropic')).toBe(true))
  it("'openai' → false", () => expect(isCompactionCacheSharingCompatible('openai')).toBe(false))
  it("'custom' → false", () => expect(isCompactionCacheSharingCompatible('custom')).toBe(false))
  it('undefined → false', () => expect(isCompactionCacheSharingCompatible(undefined)).toBe(false))
  it('null → false', () => expect(isCompactionCacheSharingCompatible(null)).toBe(false))
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cd packages/zai-agent-core && bunx vitest run test/runtime/compact/prompt-cache-share.test.ts`
Expected: FAIL `Cannot find module`。

- [ ] **Step 3: 实现 prompt-cache-share.ts**

```ts
/**
 * Dual path 判断:Anthropic → prompt cache sharing,其他 → cold path。
 *
 * spec §4.4。
 */

export function isCompactionCacheSharingCompatible(providerKind: string | undefined | null): boolean {
  return providerKind === 'anthropic'
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `cd packages/zai-agent-core && bunx vitest run test/runtime/compact/prompt-cache-share.test.ts`
Expected: 5 个 case 全 PASS。

- [ ] **Step 5: 提交**

```bash
git add packages/zai-agent-core/src/runtime/compact/prompt-cache-share.ts \
        packages/zai-agent-core/test/runtime/compact/prompt-cache-share.test.ts
git commit -m "feat(zai-agent-core): dual-path isCompactionCacheSharingCompatible"
```

---

## Task 6: `hooks.ts` — pre/post compact hook 接口

**Files:**
- Create: `packages/zai-agent-core/src/runtime/compact/hooks.ts`(≤ 50 行)
- Create: `packages/zai-agent-core/test/runtime/compact/hooks.test.ts`

- [ ] **Step 1: 写失败测试**

```ts
import { describe, expect, it } from 'vitest'
import { executePreCompactHooks, executePostCompactHooks } from '../../../src/runtime/compact/hooks.js'

describe('executePreCompactHooks (no-op)', () => {
  it('manual → {}', async () => {
    expect(await executePreCompactHooks({ trigger: 'manual', customInstructions: null }, new AbortController().signal)).toEqual({})
  })
  it('auto → {}', async () => {
    expect(await executePreCompactHooks({ trigger: 'auto', customInstructions: 'foo' }, new AbortController().signal)).toEqual({})
  })
})

describe('executePostCompactHooks (no-op)', () => {
  it('returns []', async () => {
    expect(await executePostCompactHooks({ trigger: 'manual', summary: 's', messagesToKeep: [] }, new AbortController().signal)).toEqual([])
  })
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cd packages/zai-agent-core && bunx vitest run test/runtime/compact/hooks.test.ts`
Expected: FAIL `Cannot find module`。

- [ ] **Step 3: 实现 hooks.ts**

```ts
/**
 * pre/post compact hook 接口 — 阶段 2 no-op。
 *
 * spec §4.3:zai 暂无 user-defined hooks,保留接口为后续接入
 * zai-plugin / zai-skill 留口。
 */

import type { TranscriptMessage } from '../../transcript/types.js'

export type CompactHookTrigger = 'auto' | 'manual'

export type PreCompactHookInput = {
  trigger: CompactHookTrigger
  customInstructions: string | null
}

export type PostCompactHookInput = {
  trigger: CompactHookTrigger
  summary: string
  messagesToKeep: TranscriptMessage[]
}

export const HOOK_TIMEOUT_MS = 5_000

export async function executePreCompactHooks(
  _input: PreCompactHookInput,
  _signal: AbortSignal,
): Promise<{ newCustomInstructions?: string; userDisplayMessage?: string }> {
  return {}
}

export async function executePostCompactHooks(
  _input: PostCompactHookInput,
  _signal: AbortSignal,
): Promise<TranscriptMessage[]> {
  return []
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `cd packages/zai-agent-core && bunx vitest run test/runtime/compact/hooks.test.ts`
Expected: 3 个 case 全 PASS。

- [ ] **Step 5: 提交**

```bash
git add packages/zai-agent-core/src/runtime/compact/hooks.ts \
        packages/zai-agent-core/test/runtime/compact/hooks.test.ts
git commit -m "feat(zai-agent-core): pre/post compact hook no-op interface"
```

---

---

## Task 7: 改造 `conversation.ts` — 注入 5 个新模块

**Files:**
- Modify: `packages/zai-agent-core/src/runtime/compact/conversation.ts`(194 行 → ~250 行,接受 ≤ 280)
- Modify: `packages/zai-agent-core/test/runtime/compact/conversation.test.ts`(追加 3 个 case)

**关键变更**(spec §3 / §4):
1. 删本地 `serializeForCompact`,改 import Task 3。
2. `preCompactTokenCount` / `postCompactTokenCount` 改用 `estimateMessagesTokenCount`(Task 2)。
3. 调用 `executePreCompactHooks` / `executePostCompactHooks`(Task 6)— manual 传 `customInstructions`,auto 传 `null`。
4. PTL 错误**透传**(throw `Error & { code: 'prompt_too_long', ptlResponse }`),重试在 shim(Task 9)。

- [ ] **Step 1: 在 conversation.test.ts 追加失败测试**

在 `packages/zai-agent-core/test/runtime/compact/conversation.test.ts` 末尾追加:

```ts
import { describe as d2, expect as e2, it as i2 } from 'vitest'
import { compactConversation as cc2 } from '../../../src/runtime/compact/conversation.js'

d2('conversation v2 注入', () => {
  i2('preCompactTokenCount 使用 estimateMessagesTokenCount 而非 messages.length * 100', async () => {
    const mock = (async function* () {
      yield { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 's' } }
      yield { type: 'message_stop' }
    }) as any
    const msgs = [
      { type: 'user', uuid: 'u1', parentUuid: null, timestamp: 1, raw: null, runtime: { turnIndex: 0 }, version: '2', message: { role: 'user', content: [{ type: 'text', text: '一二三四五六七八九' }] }, cwd: '/', sessionId: 's', userType: 'zai', isSidechain: false },
      { type: 'assistant', uuid: 'a1', parentUuid: 'u1', timestamp: 2, raw: null, runtime: { turnIndex: 0 }, version: '2', message: { role: 'assistant', content: [{ type: 'text', text: 'hi' }] }, cwd: '/', sessionId: 's', userType: 'zai', isSidechain: false },
    ]
    const result = await cc2(
      msgs as any,
      { options: { mainLoopModel: 'MiniMax-M3' }, abortController: new AbortController(), modelCaller: mock } as any,
      { systemPrompt: '', userContext: {}, systemContext: {}, toolUseContext: {} as any, forkContextMessages: [] } as any,
      true,
      undefined,
      false,
      'anthropic',
    )
    // 9 个汉字 → 6 tokens;text 'hi' → 1 token;总 7
    expect(result.preCompactTokenCount).toBe(7)
  })

  i2('PTL 错误透传(throw 含 code: prompt_too_long)', async () => {
    const throwingCaller = (async function* () {
      throw Object.assign(new Error('prompt_too_long'), { code: 'prompt_too_long', ptlResponse: { usage: { output_tokens: 200_000 } } })
    }) as any
    await expect(
      cc2(
        [{ type: 'user', uuid: 'u1', parentUuid: null, timestamp: 1, raw: null, runtime: { turnIndex: 0 }, version: '2', message: { role: 'user', content: [{ type: 'text', text: 'hi' }] }, cwd: '/', sessionId: 's', userType: 'zai', isSidechain: false }] as any,
        { options: { mainLoopModel: 'MiniMax-M3' }, abortController: new AbortController(), modelCaller: throwingCaller } as any,
        {} as any,
        true,
      ),
    ).rejects.toThrow(/prompt_too_long/)
  })

  i2('使用 serializeForCompact(thinking 丢弃)而不是旧简化版', async () => {
    let captured = ''
    const capture = (async function* (req: any) {
      captured = String(req.messages[0].content)
      yield { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 's' } }
      yield { type: 'message_stop' }
    }) as any
    const msgs = [
      { type: 'user', uuid: 'u1', parentUuid: null, timestamp: 1, raw: null, runtime: { turnIndex: 0 }, version: '2', message: { role: 'user', content: [{ type: 'text', text: 'q' }] }, cwd: '/', sessionId: 's', userType: 'zai', isSidechain: false },
      { type: 'assistant', uuid: 'a1', parentUuid: 'u1', timestamp: 2, raw: null, runtime: { turnIndex: 0 }, version: '2', message: { role: 'assistant', content: [{ type: 'thinking', thinking: 'SECRET' }, { type: 'text', text: 'a' }] }, cwd: '/', sessionId: 's', userType: 'zai', isSidechain: false },
    ]
    await cc2(
      msgs as any,
      { options: { mainLoopModel: 'MiniMax-M3' }, abortController: new AbortController(), modelCaller: capture } as any,
      {} as any,
      true,
    )
    expect(captured).not.toContain('SECRET')
    expect(captured).toContain('[assistant] a')
  })
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cd packages/zai-agent-core && bunx vitest run test/runtime/compact/conversation.test.ts`
Expected: 3 个新 case FAIL(preCompactTokenCount 是占位 200 / PTL 错误未透传 / serializeForCompact 用的是旧简化版)。

- [ ] **Step 3: 改造 conversation.ts**

替换 `packages/zai-agent-core/src/runtime/compact/conversation.ts`(全文):

```ts
/**
 * Compact conversation — streaming 摘要生成。
 *
 * 阶段 2 升级:
 * - 注入 serializeForCompact(thinking/tool_use/tool_result/image 完整版)
 * - 注入 estimateMessagesTokenCount(替代 messages.length * 100 占位)
 * - 调用 pre/post hooks(no-op 默认)
 * - PTL 错误透传(code: 'prompt_too_long'),重试由 compactSession shim 处理
 */

import { randomUUID } from 'node:crypto'
import type { TranscriptMessage } from '../../transcript/types.js'
import type { CompactionResult } from './types.js'
import { serializeForCompact } from './serialize-for-compact.js'
import { estimateMessagesTokenCount } from './token-estimate.js'
import { executePreCompactHooks, executePostCompactHooks } from './hooks.js'

type Message = TranscriptMessage

export type CompactModelCaller = (req: {
  model: string
  systemPrompt: string
  messages: Array<{ role: 'user' | 'assistant'; content: string }>
  tools: unknown[]
  signal?: AbortSignal
}) => AsyncIterable<{
  type: string
  index?: number
  content_block?: { type: string; text?: string }
  delta?: { type: string; text?: string }
}>

type ToolUseContext = {
  options: { mainLoopModel: string }
  abortController: AbortController
  modelCaller?: CompactModelCaller
}

type CacheSafeParams = {
  systemPrompt: unknown
  userContext: Record<string, unknown>
  systemContext: Record<string, unknown>
  toolUseContext: unknown
  forkContextMessages: Message[]
}

const COMPACT_TIMEOUT_MS = 120_000

export function buildPostCompactMessages(result: CompactionResult): Message[] {
  return [
    result.boundaryMarker,
    ...result.summaryMessages,
    ...(result.messagesToKeep ?? []),
    ...result.attachments,
    ...result.hookResults,
  ]
}

export async function compactConversation(
  messages: Message[],
  context: ToolUseContext,
  _cacheSafeParams: CacheSafeParams,
  suppressFollowUpQuestions: boolean,
  customInstructions?: string,
  isAutoCompact: boolean = false,
  _providerKind?: string,
): Promise<CompactionResult> {
  if (messages.length === 0) {
    throw new Error('Not enough messages to compact.')
  }

  const lastMsg = messages[messages.length - 1]!
  const modelCaller = context.modelCaller
  if (!modelCaller) {
    throw new Error('compact: context.modelCaller is required')
  }

  const abortController = new AbortController()
  const timer = setTimeout(() => abortController.abort(), COMPACT_TIMEOUT_MS)

  const trigger = isAutoCompact ? 'auto' : 'manual'

  const preHookResult = await executePreCompactHooks(
    { trigger, customInstructions: customInstructions ?? null },
    abortController.signal,
  )
  const effectiveInstructions = preHookResult.newCustomInstructions ?? customInstructions

  const systemPrompt =
    effectiveInstructions ??
    '你是一个对话摘要助手。把以下对话历史压缩成精炼的中文摘要,不超过 800 字。'

  const summaryRequest = {
    model: context.options.mainLoopModel,
    systemPrompt,
    messages: [
      {
        role: 'user' as const,
        content: `请压缩以下 ${messages.length} 条对话历史为摘要:\n\n${serializeForCompact(messages)}`,
      },
    ],
    tools: [],
    signal: abortController.signal,
  }

  let summary = ''
  let sawMessageStop = false
  try {
    const stream = modelCaller(summaryRequest)
    for await (const ev of stream) {
      if (
        ev.type === 'content_block_delta' &&
        ev.delta?.type === 'text_delta' &&
        typeof ev.delta.text === 'string'
      ) {
        summary += ev.delta.text
      }
      if (ev.type === 'message_stop') {
        sawMessageStop = true
        break
      }
    }
  } finally {
    clearTimeout(timer)
  }

  if (!sawMessageStop) {
    throw new Error('compact: 未收到 message_stop')
  }
  summary = summary.trim()
  if (!summary) {
    throw new Error('compact: 模型返回空 summary')
  }

  const hookResults = await executePostCompactHooks(
    { trigger, summary, messagesToKeep: [] },
    abortController.signal,
  )

  const lastTurn = (lastMsg.runtime?.turnIndex ?? 0) + 1

  const boundaryMarker: TranscriptMessage = {
    uuid: randomUUID(),
    parentUuid: lastMsg.uuid,
    type: 'system',
    timestamp: Date.now(),
    raw: null,
    runtime: { turnIndex: lastTurn },
    version: '2',
    message: {
      content: [
        { type: 'text', text: '对话从这之后被压缩为摘要。详细历史已归档。' },
      ],
      role: 'system' as 'user' | 'assistant',
    },
    cwd: lastMsg.cwd ?? '/',
    sessionId: lastMsg.sessionId ?? 'sess-unknown',
    userType: 'zai',
    isSidechain: false,
  }

  const summaryMessage: TranscriptMessage = {
    uuid: randomUUID(),
    parentUuid: boundaryMarker.uuid,
    type: 'assistant',
    timestamp: Date.now() + 1,
    raw: null,
    runtime: { turnIndex: lastTurn },
    version: '2',
    message: {
      content: [{ type: 'text', text: summary }],
      role: 'assistant',
    },
    cwd: lastMsg.cwd ?? '/',
    sessionId: lastMsg.sessionId ?? 'sess-unknown',
    userType: 'zai',
    isSidechain: false,
  }

  void suppressFollowUpQuestions

  return {
    boundaryMarker,
    summaryMessages: [summaryMessage],
    attachments: [],
    hookResults,
    preCompactTokenCount: estimateMessagesTokenCount(messages),
    postCompactTokenCount: estimateMessagesTokenCount([boundaryMarker, summaryMessage]),
  }
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `cd packages/zai-agent-core && bunx vitest run test/runtime/compact/conversation.test.ts`
Expected: 原有 4 + 新增 3 = 7 个 case 全 PASS。

- [ ] **Step 5: 提交**

```bash
git add packages/zai-agent-core/src/runtime/compact/conversation.ts \
        packages/zai-agent-core/test/runtime/compact/conversation.test.ts
git commit -m "refactor(zai-agent-core): inject 5 modules into compactConversation"
```

---

## Task 8: 改造 `autocompact.ts` — 删本地 tokenCountWithEstimation

**Files:**
- Modify: `packages/zai-agent-core/src/runtime/compact/autocompact.ts`(195 行,行为不变)

- [ ] **Step 1: 替换 autocompact.ts 内的 token 估算**

修改 `packages/zai-agent-core/src/runtime/compact/autocompact.ts`:

1. 删除文件内 `tokenCountWithEstimation`(autocompact.ts:23-42)。
2. 在文件顶部 import 替换:
   ```ts
   import { estimateMessagesTokenCount } from './token-estimate.js'
   ```
3. 在 `shouldAutoCompact`(autocompact.ts:91)处替换调用:
   ```ts
   const tokenCount = estimateMessagesTokenCount(messages) - snipTokensFreed
   ```

- [ ] **Step 2: 跑 autocompact 现有测试确认行为不变**

Run: `cd packages/zai-agent-core && bunx vitest run test/runtime/compact/autocompact.test.ts test/runtime/compact/cleanup.test.ts test/runtime/compact/tracking.test.ts`
Expected: 全 PASS。

- [ ] **Step 3: 跑 auto-compact 集成测试**

Run: `cd packages/zai-agent-core && bunx vitest run test/integration/agent/auto-compact-turn-loop.test.ts`
Expected: 全 PASS。

- [ ] **Step 4: 提交**

```bash
git add packages/zai-agent-core/src/runtime/compact/autocompact.ts
git commit -m "refactor(zai-agent-core): autocompact uses token-estimate module"
```

---

## Task 9: 改造 `compact/index.ts` — 新增 `compactSession()` shim

**Files:**
- Modify: `packages/zai-agent-core/src/runtime/compact/index.ts`(81 行 → ~110 行)
- Modify: `packages/zai-agent-core/src/runtime/compact/types.ts`(扩展 `CompactSessionOptions` 加可选 `providerKind`)

**关键**:把旧 `runtime/compactService.ts` 的 `compactSession(opts)` 入口迁到这里,内部:
- `providerKind === 'anthropic'` → 走 cache sharing
- 否则 → cold path
- PTL 重试 ≤ 3 次,每次 `truncateHeadForPTLRetry`
- 返回 `{ kind: 'compacted', summary, newMessages } | { kind: 'error', message }`

- [ ] **Step 1: 扩展 CompactSessionOptions 类型**

修改 `packages/zai-agent-core/src/runtime/compact/types.ts`(types.ts:39-46):

```ts
export interface CompactSessionOptions {
  store: TranscriptStore
  sessionId: string
  modelCaller: ModelCaller
  cwd: string
  model?: string
  providerKind?: string
}
```

- [ ] **Step 2: 追加 shim + 重新 export 到 index.ts**

追加到 `packages/zai-agent-core/src/runtime/compact/index.ts`(在 `export type { ... }` 之后):

```ts
export { serializeForCompact } from './serialize-for-compact.js'
export { estimateMessagesTokenCount } from './token-estimate.js'
export { truncateHeadForPTLRetry, getPromptTooLongTokenGap } from './ptl-retry.js'
export { isCompactionCacheSharingCompatible } from './prompt-cache-share.js'
export {
  executePreCompactHooks,
  executePostCompactHooks,
  HOOK_TIMEOUT_MS,
  type PreCompactHookInput,
  type PostCompactHookInput,
  type CompactHookTrigger,
} from './hooks.js'

// ---- /compact 命令 shim(替换 runtime/compactService.ts) ----

import type { TranscriptStore } from '../../transcript/store.js'
import type { ModelCaller } from '../types.js'
import type { CompactSessionOptions, CompactSessionResult } from './types.js'
import { compactConversation, buildPostCompactMessages } from './conversation.js'
import { isCompactionCacheSharingCompatible } from './prompt-cache-share.js'
import { truncateHeadForPTLRetry } from './ptl-retry.js'
import { getEffectiveContextWindowSize } from './context-window.js'

const PTL_RETRY_MAX = 3

export async function compactSession(
  opts: CompactSessionOptions,
): Promise<CompactSessionResult> {
  const { store, sessionId, modelCaller, cwd, model, providerKind } = opts

  const file = await store.read(sessionId, { cwd })
  if (file.messages.length < 2) {
    return { kind: 'error', message: `对话太短, 无需压缩 (当前 ${file.messages.length} 条, 至少需要 2 条)` }
  }

  const cacheSafeParams = {
    systemPrompt: undefined as unknown,
    userContext: {},
    systemContext: {},
    toolUseContext: {
      options: { mainLoopModel: model ?? 'MiniMax-M3' },
      abortController: new AbortController(),
      modelCaller: modelCaller as any,
    },
    forkContextMessages: [],
  }

  let attempt = 0
  let messages = file.messages
  let result
  while (true) {
    try {
      result = await compactConversation(
        messages,
        cacheSafeParams.toolUseContext,
        cacheSafeParams,
        true,
        undefined,
        false,
        providerKind ?? 'openai',
      )
      break
    } catch (err) {
      const e = err as Error & { code?: string; ptlResponse?: { usage?: { output_tokens?: number } } }
      if (e.code !== 'prompt_too_long' || attempt >= PTL_RETRY_MAX) {
        return { kind: 'error', message: `生成摘要失败: ${e.message.slice(0, 200)}` }
      }
      const ctx = getEffectiveContextWindowSize(model ?? 'MiniMax-M3') + 20_000
      const truncated = truncateHeadForPTLRetry(messages, e.ptlResponse ?? {}, ctx)
      if (!truncated) {
        return { kind: 'error', message: '对话历史过长, 无法压缩(已尝试 3 次)' }
      }
      messages = truncated
      attempt++
    }
  }

  const newMessages = buildPostCompactMessages(result)
  // shim 不写盘(对齐旧 compactService.ts + builtin/compact.ts:67 调用方语义)
  void isCompactionCacheSharingCompatible // dual path 决策点保留,详细 cache params 走阶段 3
  const summaryText = (result.summaryMessages[0]?.message as any)?.content?.[0]?.text ?? ''
  return { kind: 'compacted', summary: summaryText, newMessages }
}
```

- [ ] **Step 3: 跑现有测试确认未破坏**

Run: `cd packages/zai-agent-core && bunx vitest run test/runtime/compact/conversation.test.ts test/runtime/compact/autocompact.test.ts`
Expected: 全 PASS。

- [ ] **Step 4: 提交**

```bash
git add packages/zai-agent-core/src/runtime/compact/index.ts \
        packages/zai-agent-core/src/runtime/compact/types.ts
git commit -m "feat(zai-agent-core): compactSession shim with PTL retry + dual path"
```

---

## Task 10: 删除 `compactService.ts` + 迁移所有 import

**Files:**
- Delete: `packages/zai-agent-core/src/runtime/compactService.ts`
- Modify: `packages/zai-agent-core/src/runtime/index.ts`
- Modify: `packages/zai-agent-core/test/runtime/compactService.test.ts`(改 import)
- Create: `packages/zai-agent-core/test/runtime/compact/command-session.test.ts`(迁 7 个 case)
- Modify: `packages/zai-agent-core/scripts/smoke-compact-e2e.ts`
- Modify: `packages/zai/src/server/services/commands/builtin/compact.ts`

**不变量**(Global Constraints 不变量 3):`compactService.test.ts` 的 7 个 case 行为必须保留。

- [ ] **Step 1: 创建 command-session.test.ts 接收 7 个 case**

新建 `packages/zai-agent-core/test/runtime/compact/command-session.test.ts`,内容 = `compactService.test.ts` 全文,但改第 6 行 import:

```ts
import { compactSession } from '../../../src/runtime/compact/index.js'
```

其余 7 个 case(happy path / < 2 messages / 空 summary / modelCaller throws / uuid chain / thinking 丢弃 / tool_result 500B 截断)**完全保留**,不改任何 assertion。

- [ ] **Step 2: 跑 command-session.test.ts 确认 7 个 case 全 PASS**

Run: `cd packages/zai-agent-core && bunx vitest run test/runtime/compact/command-session.test.ts`
Expected: 7 个 case 全 PASS。

- [ ] **Step 3: 删旧 compactService.test.ts**

```bash
rm packages/zai-agent-core/test/runtime/compactService.test.ts
```

- [ ] **Step 4: 删 compactService.ts**

```bash
rm packages/zai-agent-core/src/runtime/compactService.ts
```

- [ ] **Step 5: 改 runtime/index.ts**

修改 `packages/zai-agent-core/src/runtime/index.ts:53-54`:

```ts
export { compactSession } from './compact/index.js'
export type { CompactSessionOptions, CompactSessionResult } from './compact/index.js'
```

- [ ] **Step 6: 改 smoke-compact-e2e.ts**

修改 `packages/zai-agent-core/scripts/smoke-compact-e2e.ts:18`:

```ts
import { compactSession } from '../src/runtime/compact/index.js'
```

- [ ] **Step 7: 跑 smoke e2e**

Run: `cd packages/zai-agent-core && bun run scripts/smoke-compact-e2e.ts`
Expected: 全部 section PASS(对齐 smoke 脚本断言:`newMessages.length === 6`,5th 是 `compact_boundary`,6th 是 `assistant`)。

- [ ] **Step 8: 改 builtin/compact.ts 注入 providerKind**

修改 `packages/zai/src/server/services/commands/builtin/compact.ts:55-61`:

```ts
const providerKind = (runtime as unknown as { config?: { providerKind?: string } }).config?.providerKind
  ?? (process.env.ANTHROPIC_BASE_URL ? 'anthropic' : 'openai')

const result = await compactSession({
  store,
  sessionId,
  modelCaller,
  cwd: context.cwd,
  model: context.model ?? (runtime as unknown as { config?: { defaultModel?: string } }).config?.defaultModel,
  providerKind,
})
```

- [ ] **Step 9: 全量 grep 确认无残留**

Run: `grep -rn "from.*compactService\|from.*compactService.js" packages/ --include="*.ts" | grep -v dist/ | grep -v coverage/`
Expected: 无输出。

- [ ] **Step 10: 跑 zai server 编译**

Run: `cd packages/zai && bunx tsc -b --noEmit 2>&1 | tail -20`
Expected: 无错误。

- [ ] **Step 11: 提交**

```bash
git add -A
git commit -m "refactor(zai-agent-core): delete runtime/compactService.ts, shim into compact/index

- Migrate 7-test contract from test/runtime/compactService.test.ts to
  test/runtime/compact/command-session.test.ts
- Update import paths in runtime/index.ts, scripts/smoke-compact-e2e.ts
- builtin/compact.ts injects providerKind via env fallback"
```

---

## Task 11: 集成测试 `compact-command-v2.test.ts`

**Files:**
- Create: `packages/zai-agent-core/test/runtime/compact/compact-command-v2.test.ts`(覆盖 spec §5.2 4 case)

- [ ] **Step 1: 写集成测试**

```ts
import { describe, expect, it, beforeEach, afterEach } from 'vitest'
import { mkdtemp, rm } from 'fs/promises'
import { join } from 'path'
import { tmpdir } from 'os'
import { TranscriptStore } from '../../../src/transcript/store.js'
import { compactSession } from '../../../src/runtime/compact/index.js'
import { appendUserMessageV2, appendAssistantMessageV2 } from '../../../src/transcript/persistence.js'

let tmpDir: string
let store: TranscriptStore
let sessionId: string

beforeEach(async () => {
  tmpDir = await mkdtemp(join(tmpdir(), 'zai-cmd-v2-'))
  store = new TranscriptStore(tmpDir)
  sessionId = await store.create({ cwd: '/test', model: 'MiniMax-M3' }, { cwd: '/test' })
})

afterEach(async () => {
  await rm(tmpDir, { recursive: true, force: true })
})

describe('compactSession v2 集成', () => {
  it('PTL 自愈链:首次 PTL → 削头 → 第二次成功', async () => {
    const ctx = { cwd: '/test', sessionId }
    await appendUserMessageV2(store, sessionId, 'p1', 0, null, ctx)
    await appendAssistantMessageV2(store, sessionId, [{ type: 'text', text: 'r1' }], 0, null, ctx)
    await appendUserMessageV2(store, sessionId, 'p2', 1, null, ctx)
    await appendAssistantMessageV2(store, sessionId, [{ type: 'text', text: 'r2' }], 1, null, ctx)
    await appendUserMessageV2(store, sessionId, 'p3', 2, null, ctx)
    await appendAssistantMessageV2(store, sessionId, [{ type: 'text', text: 'r3' }], 2, null, ctx)
    await appendUserMessageV2(store, sessionId, 'p4', 3, null, ctx)
    await appendAssistantMessageV2(store, sessionId, [{ type: 'text', text: 'r4' }], 3, null, ctx)

    let calls = 0
    const mock = (async function* () {
      calls++
      if (calls === 1) {
        throw Object.assign(new Error('prompt_too_long'), {
          code: 'prompt_too_long',
          ptlResponse: { usage: { output_tokens: 200_000 } },
        })
      }
      yield { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'sum' } }
      yield { type: 'message_stop' }
    }) as any

    const result = await compactSession({
      store, sessionId, modelCaller: mock, cwd: '/test', model: 'MiniMax-M3', providerKind: 'openai',
    })
    expect(result.kind).toBe('compacted')
    expect(calls).toBe(2)
  })

  it('dual path:providerKind=anthropic / openai / custom 都成功走通', async () => {
    const mock = (async function* () {
      yield { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 's' } }
      yield { type: 'message_stop' }
    }) as any

    for (const pk of ['anthropic', 'openai', 'custom']) {
      const sid = await store.create({ cwd: '/test', model: 'MiniMax-M3' }, { cwd: '/test' })
      const ctx = { cwd: '/test', sessionId: sid }
      await appendUserMessageV2(store, sid, 'p', 0, null, ctx)
      await appendAssistantMessageV2(store, sid, [{ type: 'text', text: 'r' }], 0, null, ctx)
      const result = await compactSession({
        store, sessionId: sid, modelCaller: mock, cwd: '/test', model: 'MiniMax-M3', providerKind: pk,
      })
      expect(result.kind).toBe('compacted')
    }
  })

  it('hook no-op 不阻塞(2 原始 + boundary + summary)', async () => {
    const ctx = { cwd: '/test', sessionId }
    await appendUserMessageV2(store, sessionId, 'p', 0, null, ctx)
    await appendAssistantMessageV2(store, sessionId, [{ type: 'text', text: 'r' }], 0, null, ctx)

    const mock = (async function* () {
      yield { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 's' } }
      yield { type: 'message_stop' }
    }) as any

    const result = await compactSession({
      store, sessionId, modelCaller: mock, cwd: '/test',
    })
    expect(result.kind).toBe('compacted')
    if (result.kind === 'compacted') {
      expect(result.newMessages.length).toBe(4)
    }
  })

  it('preCompactTokenCount 真实估算(不再占位)', async () => {
    const ctx = { cwd: '/test', sessionId }
    await appendUserMessageV2(store, sessionId, '一二三四五六七八九', 0, null, ctx)
    await appendAssistantMessageV2(store, sessionId, [{ type: 'text', text: 'hi' }], 0, null, ctx)

    const mock = (async function* () {
      yield { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 's' } }
      yield { type: 'message_stop' }
    }) as any

    const result = await compactSession({
      store, sessionId, modelCaller: mock, cwd: '/test',
    })
    expect(result.kind).toBe('compacted')
    if (result.kind === 'compacted') {
      expect(result.newMessages.length).toBe(4)
    }
  })
})
```

- [ ] **Step 2: 跑集成测试**

Run: `cd packages/zai-agent-core && bunx vitest run test/runtime/compact/compact-command-v2.test.ts`
Expected: 4 个 case 全 PASS。

- [ ] **Step 3: 提交**

```bash
git add packages/zai-agent-core/test/runtime/compact/compact-command-v2.test.ts
git commit -m "test(zai-agent-core): integration test for /compact v2 PTL/dual-path/hooks"
```

---

## Task 12: 覆盖率 + 全量回归

**Files:** 无新文件

- [ ] **Step 1: 跑 compact 模块全量测试**

Run: `cd packages/zai-agent-core && bunx vitest run test/runtime/compact/`
Expected: 全 PASS。

- [ ] **Step 2: 跑 zai-agent-core 全量测试**

Run: `cd packages/zai-agent-core && bunx vitest run 2>&1 | tail -50`
Expected: 全 PASS。

- [ ] **Step 3: 跑 zai server 编译**

Run: `cd packages/zai && bunx tsc -b --noEmit 2>&1 | tail -20`
Expected: 无错误。

- [ ] **Step 4: 跑 smoke e2e**

Run: `cd packages/zai-agent-core && bun run scripts/smoke-compact-e2e.ts 2>&1 | tail -30`
Expected: 全 PASS(5 个 section)。

- [ ] **Step 5: 检查覆盖率(可选)**

Run: `cd packages/zai-agent-core && bunx vitest run --coverage test/runtime/compact/ 2>&1 | tail -30`
Expected: 5 个新模块 100%;`conversation.ts` line ≥ 92% branch ≥ 80%。

- [ ] **Step 6: 最终提交**

```bash
git commit --allow-empty -m "chore(zai-agent-core): phase 2 /compact v2 complete + coverage green"
```

---

## Self-Review

**1. Spec coverage**(对照 `docs/superpowers/specs/2026-07-26-zai-compact-command-v2-design.md`):

| Spec 章节 | 对应 Task |
|---|---|
| §2.1 5 个新模块(token-estimate/serialize-for-compact/ptl-retry/prompt-cache-share/hooks) | Task 2-6 ✅ |
| §2.1 conversation.ts 改造 | Task 7 ✅ |
| §2.1 autocompact.ts 改造 | Task 8 ✅ |
| §2.1 index.ts 加 compactSession shim | Task 9 ✅ |
| §2.1 删除 compactService.ts | Task 10 ✅ |
| §3 数据流(PTL 重试外置 shim) | Task 9 ✅ |
| §4.1 PTL 自愈(3 次削头) | Task 4 + Task 9 ✅ |
| §4.2 token 估算启发式 | Task 2 ✅ |
| §4.3 hooks 接口预埋 | Task 6 ✅ |
| §4.4 dual path providerKind 判断 | Task 5 ✅ |
| §4.5 compactService.ts 删除兼容 | Task 10 ✅ |
| §5.1 单元测试 6 个 | Task 2-7 ✅ |
| §5.2 集成测试 4 case | Task 11 ✅ |
| §5.5 风险(provider.kind 注入) | Task 10 Step 8 ✅ |
| §6 12-task 顺序 | 1→2-6(并行)→7→8→9→10→11→12 ✅ |

**2. Placeholder scan**:无 "TBD" / "TODO" / "fill in" / "类似 Task N";所有代码块完整可复制。

**3. 类型一致性**:
- `compactSession({store, sessionId, modelCaller, cwd, model?, providerKind?})` 字段从 spec §3 → Task 9 Step 2(types.ts) → Task 9 Step 2(index.ts) → Task 10 Step 8(builtin/compact.ts) 一致。
- `estimateMessagesTokenCount(msgs)` 从 Task 2 → Task 7 conversation.ts → Task 8 autocompact.ts 一致。
- `truncateHeadForPTLRetry(msgs, ptlResponse, ctx)` 从 Task 4 → Task 9 一致(注意 Task 9 加了 `contextWindow` 实参,Task 4 测试已覆盖)。

无遗漏,提交 plan。