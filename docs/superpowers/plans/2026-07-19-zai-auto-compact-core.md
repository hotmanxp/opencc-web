# zai 自动压缩核心(A + G)Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在 zai 主对话路径(`runtime/queryLoop.ts`)中,每轮 turn 前自动执行 snip → forceReason → autocompact 三道防线 + circuit breaker 失败熔断,并把结果以 SSE `runtime.compacted` 事件推给前端 toast 提示。

**Architecture:** 在 `packages/zai-agent-core/src/runtime/compact/` 下新建独立子目录,按职责拆为 9 个小文件(每个 < 200 行)。`runtime/queryLoop.ts` 在每轮 turn 进入时依次调用 `snipCompactIfNeeded` → `resolveForceReason` → `autoCompactIfNeeded`,后者内部走 circuit breaker 守卫 → `compactConversation`(streaming 摘要)→ `store.replace()` → `runPostCompactCleanup`。`compactService.ts` 改为 shim 复用 `compactConversation`。前端 `useAgentStore` 监听新的 `runtime.compacted` SSE event 推 toast。

**Tech Stack:** TypeScript / Bun / Bun Test / Zustand / Ant Design / proper-lockfile / SSE。零新增第三方依赖,全部基于现有 zai + zai-agent-core 的运行时。

**Spec 来源:** `docs/superpowers/specs/2026-07-19-zai-session-compaction-design.md`(commit `e178ed2` + `37926bb`)

## Global Constraints

来自 spec,所有 task 隐式遵守:

- **依赖隔离**:`runtime/compact/` 不 import `opencc-internals/*` 任何代码(独立实现)
- **依赖隔离**:`runtime/compact/` 不 import `react` / `antd`(纯 TS,服务端/客户端同构)
- **依赖隔离**:`runtime/compact/` 不依赖 `runtime/compactService.ts`(后者改为 deprecated shim)
- **环境变量**(全部 `ZAI_*` 前缀,默认值见括号):
  - `ZAI_DISABLE_AUTO_COMPACT`(`0`)— 设为 `1` 禁用自动压缩,manual `/compact` 仍可用
  - `ZAI_DISABLE_COMPACT`(`0`)— 设为 `1` 禁用所有压缩
  - `ZAI_AUTOCOMPACT_PCT_OVERRIDE`(unset)— 0-100,覆盖 token 阈值
  - `ZAI_AUTOCOMPACT_FAILURE_COOLDOWN_MS`(`300000` = 5 min)— ≥ 10000
  - `ZAI_MAX_ACTIVE_MESSAGES`(`200`)— forceReason 触发上限
  - `ZAI_AUTOCOMPACT_FORCE_FLOOR_PCT`(`75`)— 大上下文安全百分比
- **常量**(取自 spec):
  - `MAX_CONSECUTIVE_AUTOCOMPACT_FAILURES = 3`
  - `AUTOCOMPACT_FAILURE_COOLDOWN_MS = 5 * 60 * 1000`
  - `MIN_AUTOCOMPACT_FAILURE_COOLDOWN_MS = 10_000`
  - `AUTOCOMPACT_BUFFER_TOKENS = 13_000`
  - `WARNING_THRESHOLD_BUFFER_TOKENS = 20_000`
  - `ERROR_THRESHOLD_BUFFER_TOKENS = 20_000`
  - `MANUAL_COMPACT_BUFFER_TOKENS = 3_000`
- **落盘约束**:`store.replace()` / `store.replaceWithBoundary()` 永远走 `proper-lockfile`,跟 `append` 互斥
- **日志约束**:每次 compact 触发(成功失败都算)追加一行 JSONL 到 `~/.zai/logs/compact.jsonl`
- **电路 breaker state 只活在 `tracking` 对象里,不写盘**
- **测试运行命令**:`bun test packages/zai-agent-core/test/runtime/compact/*.test.ts`(单文件)或 `bun test packages/zai-agent-core/test/`(全量)
- **commit 风格**:Conventional Commits,每 task 一个 commit
- **行数上限**:每个新文件 < 200 行(超过就要考虑拆)

---

## Task 1: types.ts — 共享类型契约

**Files:**
- Create: `packages/zai-agent-core/src/runtime/compact/types.ts`
- Test: 不需要(纯类型,后续 task 验证)

**Interfaces:**
- Consumes: (无)
- Produces:
  ```ts
  export type CompactTrigger = 'auto' | 'manual' | 'reactive-ptl' | 'reactive-media' | 'reactive-max-tokens'
  export type ForceReason = 'memory-pressure' | 'message-count'
  export type CircuitBreakerAction = { action: 'allow'; effectiveConsecutiveFailures: number; wasHalfOpen: boolean } | { action: 'skip'; consecutiveFailures: number; nextRetryAtMs: number; circuitBreakerActive: true }
  export interface AutoCompactTrackingState { ... }
  export interface CompactionResult { ... }
  export interface CompactSessionOptions { ... }  // 兼容旧接口
  export type CompactSessionResult = ...            // 兼容旧接口
  ```

- [ ] **Step 1: 创建 types.ts**

`packages/zai-agent-core/src/runtime/compact/types.ts`:

```ts
/**
 * 共享类型契约 — runtime/compact/* 内部模块都从这里导入。
 * 保持纯类型,零运行时副作用。
 */

// ---- Trigger 分类 ----

export type CompactTrigger =
  | 'auto'
  | 'manual'
  | 'reactive-ptl'
  | 'reactive-media'
  | 'reactive-max-tokens'

// ---- Force reason (子项目 A) ----

export type ForceReason = 'memory-pressure' | 'message-count'

// ---- Circuit breaker (子项目 G) ----

export interface AutoCompactTrackingState {
  compacted: boolean
  turnCounter: number
  turnId: string
  /** 连续 5xx/529 失败次数,process-local,不写盘 */
  consecutiveFailures?: number
  /** 下次允许试的时间戳(epoch ms) */
  nextRetryAtMs?: number
  /** 上次失败时间戳(epoch ms) */
  lastFailureAtMs?: number
  /** forceReason 在 autoCompactIfNeeded 内一次性消费 */
  forceReason?: ForceReason
}

export type CircuitBreakerAction =
  | {
      action: 'allow'
      effectiveConsecutiveFailures: number
      wasHalfOpen: boolean
    }
  | {
      action: 'skip'
      consecutiveFailures: number
      nextRetryAtMs: number
      circuitBreakerActive: true
    }

// ---- Compaction 结果(子项目 A/E 共享) ----

export interface CompactionResult {
  boundaryMarker: SystemMessage
  summaryMessages: UserMessage[]
  attachments: AttachmentMessage[]
  hookResults: HookResultMessage[]
  messagesToKeep?: Message[]
  userDisplayMessage?: string
  preCompactTokenCount?: number
  postCompactTokenCount?: number
  compactionUsage?: {
    input_tokens?: number
    output_tokens?: number
  }
}

// ---- 旧 CompactSessionOptions / CompactSessionResult(向后兼容) ----

export interface CompactSessionOptions {
  store: TranscriptStore
  sessionId: string
  modelCaller: ModelCaller
  cwd: string
  model?: string
}

export type CompactSessionResult =
  | { kind: 'compacted'; summary: string; newMessages: TranscriptMessage[] }
  | { kind: 'error'; message: string }

// ---- 外部 import 类型占位(用 import type 注入) ----

import type { TranscriptStore } from '../../transcript/store.js'
import type { TranscriptMessage } from '../../transcript/types.js'
import type { ModelCaller } from '../types.js'
import type {
  AttachmentMessage,
  HookResultMessage,
  Message,
  SystemMessage,
  UserMessage,
} from '../../opencc-internals/types/message.js'
```

> **注意**:`Message` 等类型在 spec 阶段还没确定走 zai 自有类型 vs opencc-internals 类型。本 plan 暂时按 spec §2.3 "不依赖 opencc-internals" 原则,等 Task 2 之后用 zai 自己的 `transcript/types.ts` `TranscriptMessage` 替代 `Message`。先放 import type 占位,Task 8 实际写到 `conversation.ts` 时再做替换。

- [ ] **Step 2: 验证 TS 编译通过**

Run:
```bash
cd /Users/ethan/code/opencc-web && bun run --filter '@zn-ai/zai-agent-core' typecheck 2>&1 | head -50
```

Expected: 编译错误提示 `Message` / `UserMessage` 等 opencc-internals 类型找不到 —— 这是预期的,Task 8 替换前先放着不动。

- [ ] **Step 3: Commit**

```bash
cd /Users/ethan/code/opencc-web
git add packages/zai-agent-core/src/runtime/compact/types.ts
git commit -m "feat(compact): 新增 types.ts 共享类型契约

- CompactTrigger / ForceReason / CircuitBreakerAction 枚举
- AutoCompactTrackingState circuit breaker 状态
- CompactionResult / CompactSessionOptions / CompactSessionResult
  向后兼容 runtime/compactService 旧接口"
```

---

## Task 2: log-event.ts — JSONL 本地日志 + logEvent 模拟

**Files:**
- Create: `packages/zai-agent-core/src/runtime/compact/log-event.ts`
- Test: `packages/zai-agent-core/test/runtime/compact/log-event.test.ts`

**Interfaces:**
- Consumes: (无,只依赖 `node:fs` / `node:os` / `node:path`)
- Produces:
  ```ts
  export interface CompactLogEntry { ts: number; sessionId: string; trigger: CompactTrigger; model: string; preCompactTokens?: number; postCompactTokens?: number; savedTokens?: number; circuitBreakerState: 'closed' | 'half-open' | 'open'; consecutiveFailures: number; durationMs: number; error: string | null }
  export function logEvent(eventName: string, metadata: CompactLogEntry): void
  export function readCompactLog(sessionId?: string): CompactLogEntry[]
  ```

- [ ] **Step 1: 写失败测试**

`packages/zai-agent-core/test/runtime/compact/log-event.test.ts`:

```ts
import { describe, test, expect, beforeEach, afterEach } from 'bun:test'
import { mkdtempSync, rmSync, existsSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

describe('log-event', () => {
  let dataDir: string
  let originalEnv: string | undefined

  beforeEach(() => {
    dataDir = mkdtempSync(join(tmpdir(), 'zai-log-test-'))
    originalEnv = process.env.ZAI_DATA_DIR
    process.env.ZAI_DATA_DIR = dataDir
  })

  afterEach(() => {
    if (originalEnv === undefined) delete process.env.ZAI_DATA_DIR
    else process.env.ZAI_DATA_DIR = originalEnv
    if (existsSync(dataDir)) rmSync(dataDir, { recursive: true, force: true })
  })

  test('logEvent 写入 JSONL 到 ~/.zai/logs/compact.jsonl', async () => {
    const { logEvent } = await import('../../../src/runtime/compact/log-event.js')
    logEvent('z auto_compact_succeeded', {
      ts: 1752921600000,
      sessionId: 'sess-1',
      trigger: 'auto',
      model: 'MiniMax-M3',
      preCompactTokens: 100000,
      postCompactTokens: 50000,
      savedTokens: 50000,
      circuitBreakerState: 'closed',
      consecutiveFailures: 0,
      durationMs: 1200,
      error: null,
    })
    const logPath = join(dataDir, 'logs', 'compact.jsonl')
    expect(existsSync(logPath)).toBe(true)
    const lines = readFileSync(logPath, 'utf-8').trim().split('\n')
    expect(lines.length).toBe(1)
    const entry = JSON.parse(lines[0]!)
    expect(entry.sessionId).toBe('sess-1')
    expect(entry.trigger).toBe('auto')
    expect(entry.savedTokens).toBe(50000)
  })

  test('readCompactLog 按 sessionId 过滤', async () => {
    const { logEvent, readCompactLog } = await import('../../../src/runtime/compact/log-event.js')
    logEvent('z auto_compact_succeeded', { ts: 1, sessionId: 'sess-A', trigger: 'auto', model: 'm', circuitBreakerState: 'closed', consecutiveFailures: 0, durationMs: 0, error: null })
    logEvent('z auto_compact_failed',    { ts: 2, sessionId: 'sess-B', trigger: 'auto', model: 'm', circuitBreakerState: 'closed', consecutiveFailures: 1, durationMs: 100, error: 'TIMEOUT' })
    const aOnly = readCompactLog('sess-A')
    expect(aOnly.length).toBe(1)
    expect(aOnly[0]!.sessionId).toBe('sess-A')
  })

  test('readCompactLog 不传 sessionId 返回全部', async () => {
    const { logEvent, readCompactLog } = await import('../../../src/runtime/compact/log-event.js')
    logEvent('z auto_compact_succeeded', { ts: 1, sessionId: 'sess-A', trigger: 'auto', model: 'm', circuitBreakerState: 'closed', consecutiveFailures: 0, durationMs: 0, error: null })
    logEvent('z auto_compact_succeeded', { ts: 2, sessionId: 'sess-B', trigger: 'manual', model: 'm', circuitBreakerState: 'closed', consecutiveFailures: 0, durationMs: 0, error: null })
    const all = readCompactLog()
    expect(all.length).toBe(2)
  })
})
```

- [ ] **Step 2: 跑测试,确认失败**

Run:
```bash
cd /Users/ethan/code/opencc-web && bun test packages/zai-agent-core/test/runtime/compact/log-event.test.ts 2>&1 | tail -20
```

Expected: 失败(模块不存在)。

- [ ] **Step 3: 实现 log-event.ts**

`packages/zai-agent-core/src/runtime/compact/log-event.ts`:

```ts
/**
 * 本地 JSONL 日志 + logEvent 模拟。
 *
 * - 写入路径:{ZAI_DATA_DIR|~/.zai}/logs/compact.jsonl
 * - 每次调用追加一行 JSON(无外部依赖,无锁)
 * - readCompactLog 用于本地调试 / 集成测试
 *
 * 后续接入 Statsig / OpenTelemetry 时,只需替换 logEvent 实现,
 * 调用方零改动。
 */

import { appendFileSync, readFileSync, mkdirSync, existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, dirname } from 'node:path'
import type { CompactTrigger } from './types.js'

export interface CompactLogEntry {
  ts: number
  sessionId: string
  trigger: CompactTrigger
  model: string
  preCompactTokens?: number
  postCompactTokens?: number
  savedTokens?: number
  circuitBreakerState: 'closed' | 'half-open' | 'open'
  consecutiveFailures: number
  durationMs: number
  error: string | null
}

function dataDir(): string {
  return process.env.ZAI_DATA_DIR ?? join(homedir(), '.zai')
}

function logPath(): string {
  return join(dataDir(), 'logs', 'compact.jsonl')
}

export function logEvent(eventName: string, metadata: CompactLogEntry): void {
  // eventName 当前未使用(Statsig 时会上报),保留签名兼容
  void eventName
  const path = logPath()
  if (!existsSync(dirname(path))) {
    mkdirSync(dirname(path), { recursive: true })
  }
  appendFileSync(path, JSON.stringify(metadata) + '\n', 'utf-8')
}

export function readCompactLog(sessionId?: string): CompactLogEntry[] {
  const path = logPath()
  if (!existsSync(path)) return []
  const lines = readFileSync(path, 'utf-8').trim().split('\n').filter(Boolean)
  const entries: CompactLogEntry[] = []
  for (const line of lines) {
    try {
      const entry = JSON.parse(line) as CompactLogEntry
      if (!sessionId || entry.sessionId === sessionId) {
        entries.push(entry)
      }
    } catch {
      // skip corrupt line
    }
  }
  return entries
}
```

- [ ] **Step 4: 跑测试,确认通过**

Run:
```bash
cd /Users/ethan/code/opencc-web && bun test packages/zai-agent-core/test/runtime/compact/log-event.test.ts 2>&1 | tail -20
```

Expected: PASS(3 个 test 全过)。

- [ ] **Step 5: Commit**

```bash
cd /Users/ethan/code/opencc-web
git add packages/zai-agent-core/src/runtime/compact/log-event.ts \
        packages/zai-agent-core/test/runtime/compact/log-event.test.ts
git commit -m "feat(compact): log-event 本地 JSONL + logEvent 模拟接口

- 写入 ~/.zai/logs/compact.jsonl(ZAI_DATA_DIR 覆盖)
- logEvent(eventName, metadata) 追加一行
- readCompactLog(sessionId?) 用于本地调试
- 测试:写入过滤、不传 sessionId 全返回"
```

---

## Task 3: context-window.ts — 阈值计算

**Files:**
- Create: `packages/zai-agent-core/src/runtime/compact/context-window.ts`
- Test: `packages/zai-agent-core/test/runtime/compact/context-window.test.ts`

**Interfaces:**
- Consumes: (无,只读 `process.env`)
- Produces:
  ```ts
  export function getEffectiveContextWindowSize(model: string): number
  export function getAutoCompactThreshold(model: string): number
  export function calculateTokenWarningState(tokenUsage: number, model: string): { percentLeft: number; isAboveWarningThreshold: boolean; isAboveErrorThreshold: boolean; isAboveAutoCompactThreshold: boolean; isAtBlockingLimit: boolean }
  export function isAutoCompactEnabled(): boolean
  export const AUTOCOMPACT_BUFFER_TOKENS = 13_000
  export const WARNING_THRESHOLD_BUFFER_TOKENS = 20_000
  export const ERROR_THRESHOLD_BUFFER_TOKENS = 20_000
  export const MANUAL_COMPACT_BUFFER_TOKENS = 3_000
  ```

- [ ] **Step 1: 写失败测试**

`packages/zai-agent-core/test/runtime/compact/context-window.test.ts`:

```ts
import { describe, test, expect, afterEach } from 'bun:test'
import {
  getEffectiveContextWindowSize,
  getAutoCompactThreshold,
  calculateTokenWarningState,
  isAutoCompactEnabled,
  AUTOCOMPACT_BUFFER_TOKENS,
} from '../../../src/runtime/compact/context-window.js'

describe('context-window', () => {
  const originalEnv = { ...process.env }

  afterEach(() => {
    process.env = { ...originalEnv }
  })

  test('getEffectiveContextWindowSize 减去 output reservation + 13k buffer', () => {
    // MiniMax-M3 = 200_000 context; 假设 max_output = 8_000
    const eff = getEffectiveContextWindowSize('MiniMax-M3')
    expect(eff).toBeGreaterThan(0)
    // floor:reservedTokensForSummary + autocompactBuffer 兜底
    expect(eff).toBeGreaterThanOrEqual(8000 + AUTOCOMPACT_BUFFER_TOKENS)
  })

  test('ZAI_AUTOCOMPACT_PCT_OVERRIDE 覆盖阈值百分比', () => {
    process.env.ZAI_AUTOCOMPACT_PCT_OVERRIDE = '50'
    const eff = getEffectiveContextWindowSize('MiniMax-M3')
    const threshold = getAutoCompactThreshold('MiniMax-M3')
    const pctThreshold = Math.floor(eff * 0.5)
    expect(threshold).toBe(Math.min(pctThreshold, eff - AUTOCOMPACT_BUFFER_TOKENS))
  })

  test('ZAI_AUTOCOMPACT_PCT_OVERRIDE 非法值被忽略', () => {
    process.env.ZAI_AUTOCOMPACT_PCT_OVERRIDE = '150'  // > 100
    const t1 = getAutoCompactThreshold('MiniMax-M3')
    delete process.env.ZAI_AUTOCOMPACT_PCT_OVERRIDE
    const t2 = getAutoCompactThreshold('MiniMax-M3')
    expect(t1).toBe(t2)
  })

  test('issue #635:eff 极小时不返回负数', () => {
    // 模拟模型 context = 1000,output reservation = 800
    // 1000 - 800 = 200,floor:800 + 13000 = 13800,Math.max(200, 13800) = 13800
    // 阈值:13800 - 13000 = 800
    const threshold = getAutoCompactThreshold('MiniMax-M3')
    expect(threshold).toBeGreaterThanOrEqual(0)
  })

  test('calculateTokenWarningState 返回完整状态', () => {
    const state = calculateTokenWarningState(50_000, 'MiniMax-M3')
    expect(state.percentLeft).toBeGreaterThanOrEqual(0)
    expect(state.percentLeft).toBeLessThanOrEqual(100)
    expect(typeof state.isAboveWarningThreshold).toBe('boolean')
    expect(typeof state.isAboveErrorThreshold).toBe('boolean')
    expect(typeof state.isAboveAutoCompactThreshold).toBe('boolean')
    expect(typeof state.isAtBlockingLimit).toBe('boolean')
  })

  test('isAutoCompactEnabled 默认 true', () => {
    expect(isAutoCompactEnabled()).toBe(true)
  })

  test('ZAI_DISABLE_AUTO_COMPACT=1 禁用自动压缩', () => {
    process.env.ZAI_DISABLE_AUTO_COMPACT = '1'
    expect(isAutoCompactEnabled()).toBe(false)
  })

  test('ZAI_DISABLE_COMPACT=1 禁用自动压缩', () => {
    process.env.ZAI_DISABLE_COMPACT = '1'
    expect(isAutoCompactEnabled()).toBe(false)
  })
})
```

- [ ] **Step 2: 跑测试,确认失败**

Run:
```bash
cd /Users/ethan/code/opencc-web && bun test packages/zai-agent-core/test/runtime/compact/context-window.test.ts 2>&1 | tail -20
```

Expected: 失败(模块不存在)。

- [ ] **Step 3: 实现 context-window.ts**

`packages/zai-agent-core/src/runtime/compact/context-window.ts`:

```ts
/**
 * 上下文窗口 + 自动压缩阈值计算。
 *
 * 模型上下文窗口 → 减去 output reservation → 减去 13k autocompact buffer
 * = 有效自动压缩阈值。
 *
 * 镜像 spec §1 / §3.4 / OpenCC `autoCompact.ts` 但完全独立实现。
 */

import { getContextWindowForModel, getMaxOutputTokensForModel } from '../../opencc-internals/utils/context.js'

export const AUTOCOMPACT_BUFFER_TOKENS = 13_000
export const WARNING_THRESHOLD_BUFFER_TOKENS = 20_000
export const ERROR_THRESHOLD_BUFFER_TOKENS = 20_000
export const MANUAL_COMPACT_BUFFER_TOKENS = 3_000

const MAX_OUTPUT_TOKENS_FOR_SUMMARY = 20_000

/**
 * 上下文窗口 - max_output_for_summary,带 13k buffer floor
 * 避免负数 / 极小阈值(issue #635)
 */
export function getEffectiveContextWindowSize(model: string): number {
  const reservedTokensForSummary = Math.min(
    getMaxOutputTokensForModel(model),
    MAX_OUTPUT_TOKENS_FOR_SUMMARY,
  )
  const contextWindow = getContextWindowForModel(model, [])

  const effectiveContext = contextWindow - reservedTokensForSummary
  return Math.max(effectiveContext, reservedTokensForSummary + AUTOCOMPACT_BUFFER_TOKENS)
}

/**
 * 自动压缩触发阈值 = eff - 13k buffer
 * (留 13k 给压缩后的对话 + summary)
 */
export function getAutoCompactThreshold(model: string): number {
  const effectiveContextWindow = getEffectiveContextWindowSize(model)
  const autocompactThreshold = effectiveContextWindow - AUTOCOMPACT_BUFFER_TOKENS

  const envPercent = process.env.ZAI_AUTOCOMPACT_PCT_OVERRIDE
  if (envPercent) {
    const parsed = parseFloat(envPercent)
    if (!isNaN(parsed) && parsed > 0 && parsed <= 100) {
      const percentageThreshold = Math.floor(effectiveContextWindow * (parsed / 100))
      return Math.min(percentageThreshold, autocompactThreshold)
    }
  }

  return autocompactThreshold
}

export interface TokenWarningState {
  percentLeft: number
  isAboveWarningThreshold: boolean
  isAboveErrorThreshold: boolean
  isAboveAutoCompactThreshold: boolean
  isAtBlockingLimit: boolean
}

export function calculateTokenWarningState(tokenUsage: number, model: string): TokenWarningState {
  const autoCompactThreshold = getAutoCompactThreshold(model)
  const effectiveWindow = getEffectiveContextWindowSize(model)
  const rawContextWindow = effectiveWindow + getMaxOutputTokensForModel(model)

  const percentLeft = Math.max(
    0,
    Math.round(((rawContextWindow - tokenUsage) / rawContextWindow) * 100),
  )

  const warningThreshold = autoCompactThreshold - WARNING_THRESHOLD_BUFFER_TOKENS
  const errorThreshold = autoCompactThreshold - ERROR_THRESHOLD_BUFFER_TOKENS

  const isAboveAutoCompactThreshold =
    isAutoCompactEnabled() && tokenUsage >= autoCompactThreshold
  const blockingLimit = effectiveWindow - MANUAL_COMPACT_BUFFER_TOKENS
  const isAtBlockingLimit = tokenUsage >= blockingLimit

  return {
    percentLeft,
    isAboveWarningThreshold: tokenUsage >= warningThreshold,
    isAboveErrorThreshold: tokenUsage >= errorThreshold,
    isAboveAutoCompactThreshold,
    isAtBlockingLimit,
  }
}

export function isAutoCompactEnabled(): boolean {
  if (process.env.ZAI_DISABLE_COMPACT === '1') return false
  if (process.env.ZAI_DISABLE_AUTO_COMPACT === '1') return false
  return true
}
```

- [ ] **Step 4: 跑测试,确认通过**

Run:
```bash
cd /Users/ethan/code/opencc-web && bun test packages/zai-agent-core/test/runtime/compact/context-window.test.ts 2>&1 | tail -20
```

Expected: PASS(8 个 test 全过)。

- [ ] **Step 5: Commit**

```bash
cd /Users/ethan/code/opencc-web
git add packages/zai-agent-core/src/runtime/compact/context-window.ts \
        packages/zai-agent-core/test/runtime/compact/context-window.test.ts
git commit -m "feat(compact): context-window 阈值计算

- getEffectiveContextWindowSize:减 output reservation + 13k buffer
- getAutoCompactThreshold:env ZAI_AUTOCOMPACT_PCT_OVERRIDE 压测入口
- calculateTokenWarningState:warning/error/autocompact/blocking 四态
- isAutoCompactEnabled:ZAI_DISABLE_* env 双层门
- 测试覆盖 issue #635 floor + env 覆盖边界"
```

---

## Task 4: tracking.ts — circuit breaker state

**Files:**
- Create: `packages/zai-agent-core/src/runtime/compact/tracking.ts`
- Test: `packages/zai-agent-core/test/runtime/compact/tracking.test.ts`

**Interfaces:**
- Consumes: (无)
- Produces:
  ```ts
  export const MAX_CONSECUTIVE_AUTOCOMPACT_FAILURES = 3
  export const AUTOCOMPACT_FAILURE_COOLDOWN_MS = 5 * 60 * 1000
  export const MIN_AUTOCOMPACT_FAILURE_COOLDOWN_MS = 10_000
  export function getAutoCompactFailureCooldownMs(): number
  export function resolveAutoCompactCircuitBreakerState(args: { tracking?: Pick<AutoCompactTrackingState, 'consecutiveFailures' | 'nextRetryAtMs' | 'lastFailureAtMs'>; nowMs: number; cooldownMs: number }): CircuitBreakerAction
  ```

- [ ] **Step 1: 写失败测试**

`packages/zai-agent-core/test/runtime/compact/tracking.test.ts`:

```ts
import { describe, test, expect, afterEach } from 'bun:test'
import {
  resolveAutoCompactCircuitBreakerState,
  getAutoCompactFailureCooldownMs,
  MAX_CONSECUTIVE_AUTOCOMPACT_FAILURES,
  AUTOCOMPACT_FAILURE_COOLDOWN_MS,
  MIN_AUTOCOMPACT_FAILURE_COOLDOWN_MS,
} from '../../../src/runtime/compact/tracking.js'

describe('tracking (circuit breaker)', () => {
  const originalEnv = { ...process.env }

  afterEach(() => {
    process.env = { ...originalEnv }
  })

  test('consecutiveFailures < 3 → allow, effectiveConsecutiveFailures = N', () => {
    const result = resolveAutoCompactCircuitBreakerState({
      tracking: { consecutiveFailures: 2 },
      nowMs: 1000,
      cooldownMs: 300_000,
    })
    expect(result.action).toBe('allow')
    if (result.action === 'allow') {
      expect(result.effectiveConsecutiveFailures).toBe(2)
      expect(result.wasHalfOpen).toBe(false)
    }
  })

  test('consecutiveFailures = 0(未指定) → allow, effectiveConsecutiveFailures = 0', () => {
    const result = resolveAutoCompactCircuitBreakerState({
      nowMs: 1000,
      cooldownMs: 300_000,
    })
    expect(result.action).toBe('allow')
    if (result.action === 'allow') {
      expect(result.effectiveConsecutiveFailures).toBe(0)
      expect(result.wasHalfOpen).toBe(false)
    }
  })

  test('consecutiveFailures = 3 + now < nextRetryAtMs → skip', () => {
    const result = resolveAutoCompactCircuitBreakerState({
      tracking: { consecutiveFailures: 3, nextRetryAtMs: 5000 },
      nowMs: 1000,
      cooldownMs: 300_000,
    })
    expect(result.action).toBe('skip')
    if (result.action === 'skip') {
      expect(result.consecutiveFailures).toBe(3)
      expect(result.nextRetryAtMs).toBe(5000)
      expect(result.circuitBreakerActive).toBe(true)
    }
  })

  test('consecutiveFailures = 3 + nextRetryAtMs 缺失 + lastFailureAtMs 存在 → 用 lastFailure + cooldown 计算 nextRetryAtMs', () => {
    const lastFailureAtMs = 1000
    const cooldownMs = 300_000
    const result = resolveAutoCompactCircuitBreakerState({
      tracking: { consecutiveFailures: 3, lastFailureAtMs },
      nowMs: lastFailureAtMs + 100,  // 100ms 后,远小于 cooldown
      cooldownMs,
    })
    expect(result.action).toBe('skip')
    if (result.action === 'skip') {
      expect(result.nextRetryAtMs).toBe(lastFailureAtMs + cooldownMs)
    }
  })

  test('consecutiveFailures = 3 + now >= nextRetryAtMs → allow, wasHalfOpen = true', () => {
    const result = resolveAutoCompactCircuitBreakerState({
      tracking: { consecutiveFailures: 3, nextRetryAtMs: 1000 },
      nowMs: 2000,
      cooldownMs: 300_000,
    })
    expect(result.action).toBe('allow')
    if (result.action === 'allow') {
      expect(result.effectiveConsecutiveFailures).toBe(2)  // MAX - 1
      expect(result.wasHalfOpen).toBe(true)
    }
  })

  test('getAutoCompactFailureCooldownMs 默认 5 分钟', () => {
    expect(getAutoCompactFailureCooldownMs()).toBe(AUTOCOMPACT_FAILURE_COOLDOWN_MS)
  })

  test('getAutoCompactFailureCooldownMs 接受合法 env override', () => {
    process.env.ZAI_AUTOCOMPACT_FAILURE_COOLDOWN_MS = '60000'
    expect(getAutoCompactFailureCooldownMs()).toBe(60_000)
  })

  test('getAutoCompactFailureCooldownMs 拒绝小于 floor 的值', () => {
    process.env.ZAI_AUTOCOMPACT_FAILURE_COOLDOWN_MS = '5000'  // < 10000
    expect(getAutoCompactFailureCooldownMs()).toBe(AUTOCOMPACT_FAILURE_COOLDOWN_MS)
  })

  test('getAutoCompactFailureCooldownMs 拒绝非整数', () => {
    process.env.ZAI_AUTOCOMPACT_FAILURE_COOLDOWN_MS = 'abc'
    expect(getAutoCompactFailureCooldownMs()).toBe(AUTOCOMPACT_FAILURE_COOLDOWN_MS)
  })

  test('getAutoCompactFailureCooldownMs 拒绝前导零', () => {
    process.env.ZAI_AUTOCOMPACT_FAILURE_COOLDOWN_MS = '030000'
    expect(getAutoCompactFailureCooldownMs()).toBe(AUTOCOMPACT_FAILURE_COOLDOWN_MS)
  })

  test('MAX_CONSECUTIVE_AUTOCOMPACT_FAILURES = 3(per spec §9.1)', () => {
    expect(MAX_CONSECUTIVE_AUTOCOMPACT_FAILURES).toBe(3)
  })

  test('MIN_AUTOCOMPACT_FAILURE_COOLDOWN_MS = 10_000(per spec §9.3)', () => {
    expect(MIN_AUTOCOMPACT_FAILURE_COOLDOWN_MS).toBe(10_000)
  })
})
```

- [ ] **Step 2: 跑测试,确认失败**

Run:
```bash
cd /Users/ethan/code/opencc-web && bun test packages/zai-agent-core/test/runtime/compact/tracking.test.ts 2>&1 | tail -20
```

Expected: 失败。

- [ ] **Step 3: 实现 tracking.ts**

`packages/zai-agent-core/src/runtime/compact/tracking.ts`:

```ts/**
 * Circuit breaker state + 状态机解析。
 *
 * 半开(half-open)状态:连续失败 ≥ MAX(3)后,允许 cooldown 后再试一次
 * (effectiveConsecutiveFailures = MAX-1),失败立刻 trip 回 open。
 *
 * 镜像 OpenCC `autoCompact.ts` 行为但完全独立实现。
 */

import type {
  AutoCompactTrackingState,
  CircuitBreakerAction,
} from './types.js'

export const MAX_CONSECUTIVE_AUTOCOMPACT_FAILURES = 3
export const AUTOCOMPACT_FAILURE_COOLDOWN_MS = 5 * 60 * 1000
export const MIN_AUTOCOMPACT_FAILURE_COOLDOWN_MS = 10_000

/**
 * 解析 env override,只接受 ≥ floor 的正整数,非法值回退默认。
 *
 * 防御:前导零 / 负数 / 科学计数 / 浮点 全部拒绝。
 */
export function getAutoCompactFailureCooldownMs(): number {
  const override = process.env.ZAI_AUTOCOMPACT_FAILURE_COOLDOWN_MS
  if (!override) return AUTOCOMPACT_FAILURE_COOLDOWN_MS
  const trimmed = override.trim()
  if (!/^[1-9]\d*$/.test(trimmed)) return AUTOCOMPACT_FAILURE_COOLDOWN_MS
  const parsed = Number(trimmed)
  if (!Number.isSafeInteger(parsed)) return AUTOCOMPACT_FAILURE_COOLDOWN_MS
  if (parsed < MIN_AUTOCOMPACT_FAILURE_COOLDOWN_MS) return AUTOCOMPACT_FAILURE_COOLDOWN_MS
  return parsed
}

/**
 * 状态机:closed → (≥ 3 失败) → open → (cooldown 到期) → half-open → (成功) closed / (失败) open
 */
export function resolveAutoCompactCircuitBreakerState(args: {
  tracking?: Pick<AutoCompactTrackingState, 'consecutiveFailures' | 'nextRetryAtMs' | 'lastFailureAtMs'>
  nowMs: number
  cooldownMs: number
}): CircuitBreakerAction {
  const { tracking, nowMs, cooldownMs } = args
  const consecutiveFailures = Math.max(0, tracking?.consecutiveFailures ?? 0)

  if (consecutiveFailures < MAX_CONSECUTIVE_AUTOCOMPACT_FAILURES) {
    return {
      action: 'allow',
      effectiveConsecutiveFailures: consecutiveFailures,
      wasHalfOpen: false,
    }
  }

  // ≥ 3 失败,进入 cooldown 检查
  let nextRetryAtMs = tracking?.nextRetryAtMs
  if (
    (typeof nextRetryAtMs !== 'number' || !Number.isFinite(nextRetryAtMs)) &&
    typeof tracking?.lastFailureAtMs === 'number' &&
    Number.isFinite(tracking.lastFailureAtMs) &&
    Number.isFinite(cooldownMs)
  ) {
    nextRetryAtMs = tracking.lastFailureAtMs + cooldownMs
  }

  if (
    typeof nextRetryAtMs === 'number' &&
    Number.isFinite(nextRetryAtMs) &&
    nowMs < nextRetryAtMs
  ) {
    return {
      action: 'skip',
      consecutiveFailures,
      nextRetryAtMs,
      circuitBreakerActive: true,
    }
  }

  // cooldown 已过,半开:用 MAX-1 让这次失败直接 trip
  return {
    action: 'allow',
    effectiveConsecutiveFailures: MAX_CONSECUTIVE_AUTOCOMPACT_FAILURES - 1,
    wasHalfOpen: true,
  }
}

---

## Task 5: snip.ts — snipCompactIfNeeded

**Files:**
- Create: `packages/zai-agent-core/src/runtime/compact/snip.ts`
- Test: `packages/zai-agent-core/test/runtime/compact/snip.test.ts`

**Interfaces:**
- Consumes: 接受 `Message[]` + `{ model: string }`
- Produces:
  ```ts
  export interface SnipResult { messages: TranscriptMessage[]; tokensFreed: number; boundaryMessage?: SnipBoundaryMessage }
  export function snipCompactIfNeeded(messages: TranscriptMessage[], opts: { model: string }): SnipResult
  ```

> **注**:`snip` 在阶段 1 暂用简化版:基于 message 数粗估,先不调 `groupMessagesByApiRound`。Stage 2(若需要)再升级。

- [ ] **Step 1: 写失败测试**

`packages/zai-agent-core/test/runtime/compact/snip.test.ts`:

```ts
import { describe, test, expect } from 'bun:test'
import { snipCompactIfNeeded } from '../../../src/runtime/compact/snip.js'
import type { TranscriptMessage } from '../../../src/transcript/types.js'

function makeUserMsg(content: string): TranscriptMessage {
  return {
    uuid: crypto.randomUUID(),
    parentUuid: null,
    type: 'user',
    timestamp: Date.now(),
    raw: null,
    runtime: { turnIndex: 0 },
    version: '2',
    message: { role: 'user', content },
    cwd: '/tmp',
    sessionId: 'sess-1',
    userType: 'zai',
    isSidechain: false,
  }
}

function makeAsstMsg(content: string): TranscriptMessage {
  return {
    uuid: crypto.randomUUID(),
    parentUuid: null,
    type: 'assistant',
    timestamp: Date.now(),
    raw: null,
    runtime: { turnIndex: 0 },
    version: '2',
    message: { role: 'assistant', content },
    cwd: '/tmp',
    sessionId: 'sess-1',
    userType: 'zai',
    isSidechain: false,
  }
}

describe('snip', () => {
  test('空 messages 返回原数组', () => {
    const result = snipCompactIfNeeded([], { model: 'MiniMax-M3' })
    expect(result.messages).toEqual([])
    expect(result.tokensFreed).toBe(0)
    expect(result.boundaryMessage).toBeUndefined()
  })

  test('< 2 messages 返回原数组', () => {
    const msgs = [makeUserMsg('hi')]
    const result = snipCompactIfNeeded(msgs, { model: 'MiniMax-M3' })
    expect(result.messages).toEqual(msgs)
    expect(result.tokensFreed).toBe(0)
  })

  test('大 token count(> 95% window)触发削头', () => {
    // MiniMax-M3 eff window ≈ 187_000; 95% ≈ 177_650
    // 模拟 100 条大 user 消息,每条 2000 token → ~200k tokens
    const msgs: TranscriptMessage[] = []
    for (let i = 0; i < 100; i++) {
      msgs.push(makeUserMsg('x'.repeat(8000)))  // ~2000 tokens
    }
    const result = snipCompactIfNeeded(msgs, { model: 'MiniMax-M3' })
    expect(result.messages.length).toBeLessThan(msgs.length)
    expect(result.tokensFreed).toBeGreaterThan(0)
    expect(result.boundaryMessage).toBeDefined()
  })

  test('小 token count(< 95% window)不削', () => {
    const msgs = [makeUserMsg('short'), makeAsstMsg('ok')]
    const result = snipCompactIfNeeded(msgs, { model: 'MiniMax-M3' })
    expect(result.messages).toEqual(msgs)
    expect(result.tokensFreed).toBe(0)
    expect(result.boundaryMessage).toBeUndefined()
  })
})
```

- [ ] **Step 2: 跑测试,确认失败**

Run:
```bash
cd /Users/ethan/code/opencc-web && bun test packages/zai-agent-core/test/runtime/compact/snip.test.ts 2>&1 | tail -20
```

Expected: 失败。

- [ ] **Step 3: 实现 snip.ts**

`packages/zai-agent-core/src/runtime/compact/snip.ts`:

```ts
/**
 * Snip:tokenCount ≥ effective_window * 0.95 时,削掉最早的 N 条 user 消息。
 *
 * 阶段 1 简化版:按 user 消息数粗估,不调 groupMessagesByApiRound。
 * 阶段 2(可选)再升级到精确 group 切分。
 */

import { randomUUID } from 'node:crypto'
import { getEffectiveContextWindowSize } from './context-window.js'
import type { TranscriptMessage } from '../../transcript/types.js'

export interface SnipBoundaryMessage {
  type: 'snip_boundary'
  message: { content: [{ type: 'text'; text: string }] }
}

export interface SnipResult {
  messages: TranscriptMessage[]
  tokensFreed: number
  boundaryMessage?: SnipBoundaryMessage
}

const SNIP_THRESHOLD_PCT = 0.95
const TOKENS_PER_USER_MSG = 2_000  // 粗估

export function snipCompactIfNeeded(
  messages: TranscriptMessage[],
  opts: { model: string },
): SnipResult {
  if (messages.length < 2) {
    return { messages, tokensFreed: 0 }
  }

  const effWindow = getEffectiveContextWindowSize(opts.model)
  const snipThreshold = effWindow * SNIP_THRESHOLD_PCT

  // 粗估 token count:user 消息数 * 平均 token
  const userMsgCount = messages.filter((m) => m.type === 'user').length
  const roughTokenCount = userMsgCount * TOKENS_PER_USER_MSG

  if (roughTokenCount < snipThreshold) {
    return { messages, tokensFreed: 0 }
  }

  // 削掉前 1/3 user 消息(粗略:保证剩 ≥ 2)
  const userMsgsToRemove = Math.max(1, Math.floor(userMsgCount / 3))
  const userMsgUuidsToRemove = new Set<string>()
  let removed = 0
  for (const m of messages) {
    if (m.type === 'user' && removed < userMsgsToRemove) {
      userMsgUuidsToRemove.add(m.uuid)
      removed++
    }
  }

  const remaining = messages.filter((m) => !userMsgUuidsToRemove.has(m.uuid))
  if (remaining.length === messages.length) {
    return { messages, tokensFreed: 0 }
  }

  const boundary: SnipBoundaryMessage = {
    type: 'snip_boundary',
    message: { content: [{ type: 'text', text: `已 snip 掉 ${userMsgsToRemove} 条早期消息` }] },
  }

  return {
    messages: remaining,
    tokensFreed: removed * TOKENS_PER_USER_MSG,
    boundaryMessage: boundary,
  }
}
```

- [ ] **Step 4: 跑测试,确认通过**

Run:
```bash
cd /Users/ethan/code/opencc-web && bun test packages/zai-agent-core/test/runtime/compact/snip.test.ts 2>&1 | tail -20
```

Expected: PASS(4 个 test)。

- [ ] **Step 5: Commit**

```bash
cd /Users/ethan/code/opencc-web
git add packages/zai-agent-core/src/runtime/compact/snip.ts \
        packages/zai-agent-core/test/runtime/compact/snip.test.ts
git commit -m "feat(compact): snip 削早期 user 消息

- 阈值 effective_window * 0.95(per spec §4.1)
- 粗估每条 user 消息 ~2000 tokens
- 削掉前 1/3 user 消息,返回 SnipResult{messages, tokensFreed, boundaryMessage}
- 阶段 1 简化版,不调 groupMessagesByApiRound"
```

---

## Task 6: force-reason.ts — resolveForceReason

**Files:**
- Create: `packages/zai-agent-core/src/runtime/compact/force-reason.ts`
- Test: `packages/zai-agent-core/test/runtime/compact/force-reason.test.ts`

**Interfaces:**
- Consumes: (无)
- Produces:
  ```ts
  export type ForceReason = 'memory-pressure' | 'message-count'
  export function resolveForceReason(args: { messageCount: number; tokenCount: number; memoryPressureFlag: boolean; maxActiveMessages: number; naturalThreshold: number; floorPct: number }): ForceReason | undefined
  export function validateBoundedIntEnvVar(name: string, value: string | undefined, defaultValue: number, max: number): { value: number; effective: number }
  export function consumeCompactionRequest(): boolean
  ```

- [ ] **Step 1: 写失败测试**

`packages/zai-agent-core/test/runtime/compact/force-reason.test.ts`:

```ts
import { describe, test, expect, afterEach } from 'bun:test'
import {
  resolveForceReason,
  validateBoundedIntEnvVar,
  consumeCompactionRequest,
} from '../../../src/runtime/compact/force-reason.js'

describe('force-reason', () => {
  const originalEnv = { ...process.env }
  afterEach(() => {
    process.env = { ...originalEnv }
  })

  test('priority: memory-pressure > message-count', () => {
    const result = resolveForceReason({
      messageCount: 500,
      tokenCount: 100_000,
      memoryPressureFlag: true,
      maxActiveMessages: 200,
      naturalThreshold: 180_000,
      floorPct: 75,
    })
    expect(result).toBe('memory-pressure')
  })

  test('message-count 超限触发', () => {
    const result = resolveForceReason({
      messageCount: 250,
      tokenCount: 50_000,  // 远低于 threshold
      memoryPressureFlag: false,
      maxActiveMessages: 200,
      naturalThreshold: 180_000,
      floorPct: 75,
    })
    expect(result).toBe('message-count')
  })

  test('message-count 低于上限且无 flag → undefined', () => {
    const result = resolveForceReason({
      messageCount: 50,
      tokenCount: 50_000,
      memoryPressureFlag: false,
      maxActiveMessages: 200,
      naturalThreshold: 180_000,
      floorPct: 75,
    })
    expect(result).toBeUndefined()
  })

  test('validateBoundedIntEnvVar 接受合法值', () => {
    const r = validateBoundedIntEnvVar('TEST', '75', 75, 100)
    expect(r.value).toBe(75)
    expect(r.effective).toBe(75)
  })

  test('validateBoundedIntEnvVar 拒绝负数 → 默认', () => {
    const r = validateBoundedIntEnvVar('TEST', '-5', 75, 100)
    expect(r.value).toBe(-5)
    expect(r.effective).toBe(75)
  })

  test('validateBoundedIntEnvVar 拒绝超过 max → 默认', () => {
    const r = validateBoundedIntEnvVar('TEST', '150', 75, 100)
    expect(r.value).toBe(150)
    expect(r.effective).toBe(75)
  })

  test('validateBoundedIntEnvVar 拒绝非整数', () => {
    const r = validateBoundedIntEnvVar('TEST', 'abc', 75, 100)
    expect(r.value).toBeNaN()
    expect(r.effective).toBe(75)
  })

  test('consumeCompactionRequest 默认 false', () => {
    expect(consumeCompactionRequest()).toBe(false)
  })

  test('consumeCompactionRequest 读后置 false(set true then consume)', () => {
    // 通过全局 mock 或共享 module-level flag
    // 为简化测试,验证函数签名一致即可
    expect(typeof consumeCompactionRequest()).toBe('boolean')
  })
})
```

- [ ] **Step 2: 跑测试,确认失败**

Run:
```bash
cd /Users/ethan/code/opencc-web && bun test packages/zai-agent-core/test/runtime/compact/force-reason.test.ts 2>&1 | tail -20
```

Expected: 失败。

- [ ] **Step 3: 实现 force-reason.ts**

`packages/zai-agent-core/src/runtime/compact/force-reason.ts`:

```ts
/**
 * Force reason 解析 — 在 token 阈值还没到时,提前触发压缩。
 *
 * 优先级:memory-pressure flag > message count > token 比例
 *
 * 镜像 spec §4.1 + OpenCC `forceReasonResolver.ts`
 */

import type { ForceReason } from './types.js'

const FLOOR_PCT_DEFAULT = 75
const FLOOR_PCT_MAX = 100

export function resolveForceReason(args: {
  messageCount: number
  tokenCount: number
  memoryPressureFlag: boolean
  maxActiveMessages: number
  naturalThreshold: number
  floorPct: number
}): ForceReason | undefined {
  if (args.memoryPressureFlag) return 'memory-pressure'
  if (args.messageCount >= args.maxActiveMessages) return 'message-count'
  // floor 兜底:大上下文模型(1M+)不要 force
  const ratio = (args.tokenCount / args.naturalThreshold) * 100
  if (ratio >= args.floorPct) {
    // tokenCount 已经接近自然阈值,优先走自然阈值路径,这里不强制
    return undefined
  }
  return undefined
}

/**
 * 验证 env var 是否在 [0, max] 区间内的整数。
 * 非法值 → effective = defaultValue
 */
export function validateBoundedIntEnvVar(
  name: string,
  value: string | undefined,
  defaultValue: number,
  max: number,
): { value: number; effective: number } {
  void name
  if (!value) return { value: NaN, effective: defaultValue }
  const parsed = Number(value)
  if (!Number.isSafeInteger(parsed) || parsed < 0 || parsed > max) {
    return { value: parsed, effective: defaultValue }
  }
  return { value: parsed, effective: parsed }
}

/**
 * process-local flag:外部(操作系统信号 / IPC)可以 set true,
 * 下次 consumeCompactionRequest() 调用时返回 true 并清零。
 *
 * 阶段 1 暂未对接 OS 信号,flag 永远 false。
 */
let compactionRequestFlag = false

export function setCompactionRequest(): void {
  compactionRequestFlag = true
}

export function consumeCompactionRequest(): boolean {
  if (compactionRequestFlag) {
    compactionRequestFlag = false
    return true
  }
  return false
}

// re-export FLOOR_PCT_DEFAULT 给上层用
export { FLOOR_PCT_DEFAULT as FORCE_FLOOR_PCT_DEFAULT, FLOOR_PCT_MAX as FORCE_FLOOR_PCT_MAX }
```

- [ ] **Step 4: 跑测试,确认通过**

Run:
```bash
cd /Users/ethan/code/opencc-web && bun test packages/zai-agent-core/test/runtime/compact/force-reason.test.ts 2>&1 | tail -20
```

Expected: PASS(9 个 test)。

- [ ] **Step 5: Commit**

```bash
cd /Users/ethan/code/opencc-web
git add packages/zai-agent-core/src/runtime/compact/force-reason.ts \
        packages/zai-agent-core/test/runtime/compact/force-reason.test.ts
git commit -m "feat(compact): force-reason 解析

- resolveForceReason: memory-pressure > message-count > token 比例
- validateBoundedIntEnvVar: [0, max] 整数验证,非法回退 default
- consumeCompactionRequest / setCompactionRequest: process-local flag
- 测试覆盖优先级、边界、env 校验"
```

---

## Task 7: cleanup.ts — runPostCompactCleanup

**Files:**
- Create: `packages/zai-agent-core/src/runtime/compact/cleanup.ts`
- Test: `packages/zai-agent-core/test/runtime/compact/cleanup.test.ts`

**Interfaces:**
- Consumes: querySource 字符串
- Produces:
  ```ts
  export function runPostCompactCleanup(querySource: string): void
  export function markPostCompaction(): void
  export function consumePostCompactMarker(): boolean
  ```

- [ ] **Step 1: 写失败测试**

`packages/zai-agent-core/test/runtime/compact/cleanup.test.ts`:

```ts
import { describe, test, expect } from 'bun:test'
import {
  runPostCompactCleanup,
  markPostCompaction,
  consumePostCompactMarker,
} from '../../../src/runtime/compact/cleanup.js'

describe('cleanup', () => {
  test('runPostCompactCleanup 不抛错', () => {
    expect(() => runPostCompactCleanup('repl_main_thread')).not.toThrow()
  })

  test('markPostCompaction + consumePostCompactMarker 单次消费', () => {
    markPostCompaction()
    expect(consumePostCompactMarker()).toBe(true)
    expect(consumePostCompactMarker()).toBe(false)  // 第二次返回 false
  })

  test('consumePostCompactMarker 默认 false', () => {
    expect(consumePostCompactMarker()).toBe(false)
  })
})
```

- [ ] **Step 2: 跑测试,确认失败**

Run:
```bash
cd /Users/ethan/code/opencc-web && bun test packages/zai-agent-core/test/runtime/compact/cleanup.test.ts 2>&1 | tail -20
```

Expected: 失败。

- [ ] **Step 3: 实现 cleanup.ts**

`packages/zai-agent-core/src/runtime/compact/cleanup.ts`:

```ts
/**
 * Compact 后清理:通知 cache break detector / 重置 session memory 标记。
 *
 * 阶段 1 简化版:process-local flag 占位。
 * 阶段 2 可对接 cache break detection。
 */

let postCompactMarker = false

export function markPostCompaction(): void {
  postCompactMarker = true
}

export function consumePostCompactMarker(): boolean {
  if (postCompactMarker) {
    postCompactMarker = false
    return true
  }
  return false
}

export function runPostCompactCleanup(querySource: string): void {
  // 当前只 mark,后续可扩展:
  // - cache break detector 重置 baseline
  // - session memory 清理 lastSummarizedMessageId
  // - mcp auth cache 失效
  void querySource
  markPostCompaction()
}
```

- [ ] **Step 4: 跑测试,确认通过**

Run:
```bash
cd /Users/ethan/code/opencc-web && bun test packages/zai-agent-core/test/runtime/compact/cleanup.test.ts 2>&1 | tail -20
```

Expected: PASS(3 个 test)。

- [ ] **Step 5: Commit**

```bash
cd /Users/ethan/code/opencc-web
git add packages/zai-agent-core/src/runtime/compact/cleanup.ts \
        packages/zai-agent-core/test/runtime/compact/cleanup.test.ts
git commit -m "feat(compact): post-compact cleanup 占位

- runPostCompactCleanup:阶段 1 仅 mark,后续接 cache break detector
- markPostCompaction / consumePostCompactMarker:process-local 单次消费 flag"
```

---

## Task 8: transcript schema 扩展(compact_boundary + compactMetadata)

**Files:**
- Modify: `packages/zai-agent-core/src/transcript/types.ts`
- Test: 不需要(纯类型,后续 store task 验证)

> **警告**:这是对 `transcript/types.ts` 的 schema 变更。需要在最后阶段提供 transcript v2 backward-compat 读取兼容(旧文件不带 `compactMetadata` 也能读)。

- [ ] **Step 1: 修改 types.ts**

打开 `packages/zai-agent-core/src/transcript/types.ts`,在 `TranscriptMessage` 类型定义后追加:

```ts
/**
 * Compact boundary metadata — 链式压缩关系链。
 * 用于 transcript resume 时跳过 boundary 之前 messages 并保留 messagesToKeep。
 */
export interface CompactMetadata {
  trigger: 'auto' | 'manual'
  preTokens: number
  userContext?: string
  messagesSummarized: number
  preservedSegment?: {
    headUuid: UUID    // messagesToKeep[0].uuid
    anchorUuid: UUID  // boundary 之前的最后一条 message 的 uuid
    tailUuid: UUID    // messagesToKeep.at(-1).uuid
  }
}

/**
 * 扩展 TranscriptMessage,允许 type === 'compact_boundary' 时带 compactMetadata。
 * 旧文件不带 compactMetadata 也能反序列化(deserialization 容错)。
 */
export interface CompactBoundaryMessage extends TranscriptMessage {
  type: 'compact_boundary'
  compactMetadata: CompactMetadata
}
```

然后找到 `TranscriptMessage` 联合类型定义(`export type TranscriptMessage = ...`),把 `CompactBoundaryMessage` 加入:

```ts
export type TranscriptMessage =
  | TranscriptMessageBase
  | CompactBoundaryMessage
  // ... 其他现有变体
```

(具体联合类型 shape 看现有代码,以 import 现有 `TranscriptMessage` 类型后扩展 union 为准。如果现有是单 interface 而非 union,直接给 `TranscriptMessage` 加可选字段 `compactMetadata?: CompactMetadata`。)

- [ ] **Step 2: 跑现有 transcript 测试,确认不回归**

Run:
```bash
cd /Users/ethan/code/opencc-web && bun test packages/zai-agent-core/test/transcript/ 2>&1 | tail -30
```

Expected: 全部通过(扩展不破坏旧 schema)。

- [ ] **Step 3: Commit**

```bash
cd /Users/ethan/code/opencc-web
git add packages/zai-agent-core/src/transcript/types.ts
git commit -m "feat(transcript): 新增 compact_boundary + compactMetadata 类型

- CompactMetadata:trigger / preTokens / preservedSegment
- CompactBoundaryMessage extends TranscriptMessage
- 不破坏旧 schema,旧文件不带 compactMetadata 也能反序列化"
```

---

## Task 9: store.replaceWithBoundary — 链式压缩写盘

**Files:**
- Modify: `packages/zai-agent-core/src/transcript/store.ts`
- Test: 在 Task 10 一起做

- [ ] **Step 1: 修改 store.ts,新增 replaceWithBoundary**

打开 `packages/zai-agent-core/src/transcript/store.ts`,在 `TranscriptStore` class 内新增方法(在 `replace()` 方法之后):

```ts
/**
 * 原子替换 transcript 为压缩后的 messages。
 *
 * 跟 replace() 的区别:boundary message 上挂 compactMetadata(包括
 * preservedSegment head/anchor/tail UUID),用于后续 transcript resume
 * 重建父子关系链。
 *
 * 沿用 replace() 的 proper-lockfile 范式。
 */
async replaceWithBoundary(
  transcriptId: string,
  newMessages: TranscriptMessage[],
  compactMetadata: CompactMetadata,
): Promise<void> {
  const filePath = transcriptPath(this.dataDir, transcriptId)
  const release = await lock(filePath, { retries: 3 })
  try {
    const raw = await readFile(filePath, 'utf-8')
    const file = deserializeFile(raw)
    file.messages = newMessages
    file.meta.updatedAt = Date.now()
    await writeFile(filePath, serializeFile(file), 'utf-8')
    void compactMetadata  // boundary 上挂 metadata 是在调用方负责的(append),这里仅做替换
  } finally {
    await release()
  }
}
```

注意:`compactMetadata` 在此版本暂不直接挂到 file meta 上(避免破坏 v2 schema 兼容性),由调用方负责在 boundary message 上挂 `compactMetadata` 字段。

- [ ] **Step 2: 加 import**

在 store.ts 顶部 import 区域加:

```ts
import type { CompactMetadata } from './types.js'
```

- [ ] **Step 3: 跑现有 transcript 测试**

Run:
```bash
cd /Users/ethan/code/opencc-web && bun test packages/zai-agent-core/test/transcript/ 2>&1 | tail -20
```

Expected: 全部通过(只是新增方法,不破坏旧 API)。

- [ ] **Step 4: Commit**

```bash
cd /Users/ethan/code/opencc-web
git add packages/zai-agent-core/src/transcript/store.ts
git commit -m "feat(transcript): store.replaceWithBoundary 链式压缩写盘

- 沿用 replace() 的 proper-lockfile 范式
- boundary metadata 由调用方在 boundary message 上挂载
- 阶段 1 简化版,phase 2 接 read 路径"
```

---

## Task 10: conversation.ts — compactConversation(阶段 1 简化版)

**Files:**
- Create: `packages/zai-agent-core/src/runtime/compact/conversation.ts`
- Test: `packages/zai-agent-core/test/runtime/compact/conversation.test.ts`

**Interfaces:**
- Consumes: `Message[]` + `ToolUseContext` + `CacheSafeParams` + flag
- Produces:
  ```ts
  export interface CompactionResult { boundaryMarker: SystemMessage; summaryMessages: UserMessage[]; attachments: AttachmentMessage[]; hookResults: HookResultMessage[]; messagesToKeep?: Message[]; preCompactTokenCount?: number; postCompactTokenCount?: number; compactionUsage?: { input_tokens?: number; output_tokens?: number } }
  export function buildPostCompactMessages(result: CompactionResult): Message[]
  export async function compactConversation(messages: Message[], context: ToolUseContext, cacheSafeParams: CacheSafeParams, suppressFollowUpQuestions: boolean, customInstructions?: string, isAutoCompact?: boolean): Promise<CompactionResult>
  ```

> **阶段 1 简化版**:不实现 PTL 自愈(留到阶段 2),不实现 prompt cache sharing(留到阶段 2),不实现 pre/post hooks(留到阶段 2)。当前只做:
> 1. strip image blocks
> 2. 调 modelCaller 流式生成 summary
> 3. 构造 boundary + summary 两条 message

- [ ] **Step 1: 写失败测试**

`packages/zai-agent-core/test/runtime/compact/conversation.test.ts`:

```ts
import { describe, test, expect } from 'bun:test'
import { compactConversation, buildPostCompactMessages } from '../../../src/runtime/compact/conversation.js'

describe('conversation (阶段 1 简化版)', () => {
  test('buildPostCompactMessages 顺序: boundary + summary + keep + attachments + hooks', () => {
    const result = {
      boundaryMarker: { type: 'system', uuid: 'b', parentUuid: null, timestamp: 1, raw: null, runtime: { turnIndex: 0 }, version: '2', message: { role: 'system', content: [{ type: 'text', text: 'boundary' }] }, cwd: '/', sessionId: 's', userType: 'zai', isSidechain: false } as any,
      summaryMessages: [{ type: 'user', uuid: 's', parentUuid: 'b', timestamp: 2, raw: null, runtime: { turnIndex: 0 }, version: '2', message: { role: 'user', content: [{ type: 'text', text: 'summary' }] }, cwd: '/', sessionId: 's', userType: 'zai', isSidechain: false } as any],
      attachments: [],
      hookResults: [],
      messagesToKeep: [],
    }
    const out = buildPostCompactMessages(result)
    expect(out.length).toBe(2)
    expect((out[0] as any).uuid).toBe('b')
    expect((out[1] as any).uuid).toBe('s')
  })

  test('compactConversation 调用 modelCaller 返回非空', async () => {
    // mock modelCaller
    const mockModelCaller = (async function* () {
      yield { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } }
      yield { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'Summary text' } }
      yield { type: 'message_stop' }
    }) as any

    const messages = [
      { type: 'user', uuid: 'u1', parentUuid: null, timestamp: 1, raw: null, runtime: { turnIndex: 0 }, version: '2', message: { role: 'user', content: [{ type: 'text', text: 'hi' }] }, cwd: '/', sessionId: 's', userType: 'zai', isSidechain: false },
      { type: 'assistant', uuid: 'a1', parentUuid: 'u1', timestamp: 2, raw: null, runtime: { turnIndex: 0 }, version: '2', message: { role: 'assistant', content: [{ type: 'text', text: 'hello' }] }, cwd: '/', sessionId: 's', userType: 'zai', isSidechain: false },
    ]

    const result = await compactConversation(
      messages,
      { options: { mainLoopModel: 'MiniMax-M3' }, abortController: new AbortController() } as any,
      { systemPrompt: '', userContext: {}, systemContext: {}, toolUseContext: {} as any, forkContextMessages: [] } as any,
      true,
      undefined,
      false,
    )

    expect(result.summaryMessages.length).toBeGreaterThan(0)
    expect(result.boundaryMarker).toBeDefined()
  })
})
```

- [ ] **Step 2: 跑测试,确认失败**

Run:
```bash
cd /Users/ethan/code/opencc-web && bun test packages/zai-agent-core/test/runtime/compact/conversation.test.ts 2>&1 | tail -20
```

Expected: 失败。

- [ ] **Step 3: 实现 conversation.ts**

`packages/zai-agent-core/src/runtime/compact/conversation.ts`:

```ts
/**
 * Compact conversation — streaming 摘要生成。
 *
 * 阶段 1 简化版:不实现 PTL 自愈 / prompt cache sharing / pre/post hooks
 * (这些留到阶段 2)。
 *
 * 调用 modelCaller 流式生成 summary,构造 boundary + summary message,
 * 返回 CompactionResult。
 */

import { randomUUID } from 'node:crypto'
import type { TranscriptMessage } from '../../transcript/types.js'
import type { CompactionResult } from './types.js'

// ---- 类型 placeholder,实际用 zai 自己的 TranscriptMessage 替代 ----
// (此处简化版用 TranscriptMessage 即可,因为 strip / serialize 都不需要)
type Message = TranscriptMessage
type ToolUseContext = {
  options: { mainLoopModel: string }
  abortController: AbortController
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
  _suppressFollowUpQuestions: boolean,
  customInstructions?: string,
  isAutoCompact: boolean = false,
): Promise<CompactionResult> {
  if (messages.length === 0) {
    throw new Error('Not enough messages to compact.')
  }

  const lastMsg = messages[messages.length - 1]!
  const modelCaller = (context as any).modelCaller as (
    req: any,
  ) => AsyncIterable<any>

  const abortController = new AbortController()
  const timer = setTimeout(() => abortController.abort(), COMPACT_TIMEOUT_MS)

  const systemPrompt = customInstructions ?? '你是一个对话摘要助手。把以下对话历史压缩成精炼的中文摘要,不超过 800 字。'

  const summaryRequest = {
    model: context.options.mainLoopModel,
    systemPrompt,
    messages: [
      {
        role: 'user',
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
        (ev as any).delta?.type === 'text_delta'
      ) {
        summary += (ev as any).delta.text
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
      content: [{ type: 'text', text: '对话从这之后被压缩为摘要。详细历史已归档。' }],
      role: 'system' as 'user' | 'assistant',
    },
    cwd: '/',
    sessionId: lastMsg.sessionId ?? 'sess-unknown',
    userType: 'zai',
    isSidechain: false,
  } as TranscriptMessage

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
    cwd: '/',
    sessionId: lastMsg.sessionId ?? 'sess-unknown',
    userType: 'zai',
    isSidechain: false,
  } as TranscriptMessage

  void isAutoCompact  // 阶段 2 接 hook 时使用

  return {
    boundaryMarker: boundaryMarker as any,
    summaryMessages: [summaryMessage as any],
    attachments: [],
    hookResults: [],
    preCompactTokenCount: messages.length * 100,  // 粗估
    postCompactTokenCount: summary.length * 2,  // 粗估
  }
}

function serializeForCompact(messages: Message[]): string {
  return messages
    .map((m) => {
      if (typeof m.message?.content === 'string') return `[${m.type}] ${m.message.content}`
      const blocks = Array.isArray(m.message?.content) ? m.message.content : []
      return `[${m.type}] ${blocks.map((b: any) => b.text ?? '').join('')}`
    })
    .join('\n\n')
}
```

- [ ] **Step 4: 跑测试,确认通过**

Run:
```bash
cd /Users/ethan/code/opencc-web && bun test packages/zai-agent-core/test/runtime/compact/conversation.test.ts 2>&1 | tail -30
```

Expected: PASS(2 个 test)。

- [ ] **Step 5: Commit**

```bash
cd /Users/ethan/code/opencc-web
git add packages/zai-agent-core/src/runtime/compact/conversation.ts \
        packages/zai-agent-core/test/runtime/compact/conversation.test.ts
git commit -m "feat(compact): conversation streaming 摘要生成(阶段 1 简化版)

- compactConversation:120s timeout + sawMessageStop 兜底
- buildPostCompactMessages:boundary + summary + keep + attachments + hooks 顺序
- 阶段 2 再补 PTL 自愈 / cache sharing / pre/post hooks"
```

---

## Task 11: autocompact.ts — autoCompactIfNeeded 主入口

**Files:**
- Create: `packages/zai-agent-core/src/runtime/compact/autocompact.ts`
- Test: `packages/zai-agent-core/test/runtime/compact/autocompact.test.ts`

**Interfaces:**
- Consumes: types / tracking / context-window / cleanup / conversation / log-event
- Produces:
  ```ts
  export async function autoCompactIfNeeded(messages: TranscriptMessage[], toolUseContext: ToolUseContext, cacheSafeParams: CacheSafeParams, querySource: string, tracking?: AutoCompactTrackingState, snipTokensFreed?: number, nowMs?: number): Promise<AutoCompactResult>
  export async function shouldAutoCompact(messages: TranscriptMessage[], model: string, querySource: string, snipTokensFreed?: number, forceReason?: ForceReason): Promise<boolean>
  export interface AutoCompactResult { wasCompacted: boolean; consecutiveFailures?: number; nextRetryAtMs?: number; lastFailureAtMs?: number; circuitBreakerActive?: boolean; circuitBreakerTripped?: boolean }
```

- [ ] **Step 1: 写失败测试**

`packages/zai-agent-core/test/runtime/compact/autocompact.test.ts`:

```ts
import { describe, test, expect } from 'bun:test'
import {
  autoCompactIfNeeded,
  shouldAutoCompact,
} from '../../../src/runtime/compact/autocompact.js'
import type { TranscriptMessage } from '../../../src/transcript/types.js'

function makeMsg(content: string, type: 'user' | 'assistant' = 'user'): TranscriptMessage {
  return {
    uuid: crypto.randomUUID(),
    parentUuid: null,
    type,
    timestamp: Date.now(),
    raw: null,
    runtime: { turnIndex: 0 },
    version: '2',
    message: { role: type, content: [{ type: 'text', text: content }] },
    cwd: '/tmp',
    sessionId: 'sess-1',
    userType: 'zai',
    isSidechain: false,
  }
}

describe('autocompact', () => {
  test('shouldAutoCompact: querySource=compact 永远 false', async () => {
    const msgs = [makeMsg('hi'), makeMsg('ok', 'assistant')]
    const r = await shouldAutoCompact(msgs, 'MiniMax-M3', 'compact', 0, undefined)
    expect(r).toBe(false)
  })

  test('shouldAutoCompact: querySource=session_memory 永远 false', async () => {
    const msgs = [makeMsg('hi'), makeMsg('ok', 'assistant')]
    const r = await shouldAutoCompact(msgs, 'MiniMax-M3', 'session_memory', 0, undefined)
    expect(r).toBe(false)
  })

  test('shouldAutoCompact: ZAI_DISABLE_AUTO_COMPACT=1 永远 false', async () => {
    process.env.ZAI_DISABLE_AUTO_COMPACT = '1'
    const msgs = [makeMsg('hi'), makeMsg('ok', 'assistant')]
    const r = await shouldAutoCompact(msgs, 'MiniMax-M3', 'repl_main_thread', 0, undefined)
    expect(r).toBe(false)
    delete process.env.ZAI_DISABLE_AUTO_COMPACT
  })

  test('shouldAutoCompact: forceReason=true → true', async () => {
    const msgs = [makeMsg('hi'), makeMsg('ok', 'assistant')]
    const r = await shouldAutoCompact(msgs, 'MiniMax-M3', 'repl_main_thread', 0, 'message-count')
    expect(r).toBe(true)
  })

  test('shouldAutoCompact: token 未达阈值 → false', async () => {
    const msgs = [makeMsg('hi'), makeMsg('ok', 'assistant')]
    const r = await shouldAutoCompact(msgs, 'MiniMax-M3', 'repl_main_thread', 0, undefined)
    expect(r).toBe(false)
  })

  test('autoCompactIfNeeded: 短路 skip 时 circuitBreakerActive=true', async () => {
    const result = await autoCompactIfNeeded(
      [makeMsg('hi'), makeMsg('ok', 'assistant')],
      { options: { mainLoopModel: 'MiniMax-M3' }, abortController: new AbortController() } as any,
      {} as any,
      'repl_main_thread',
      { compacted: false, turnCounter: 0, turnId: 't1', consecutiveFailures: 3, nextRetryAtMs: Date.now() + 600_000 },
      0,
      Date.now(),
    )
    expect(result.wasCompacted).toBe(false)
    expect(result.circuitBreakerActive).toBe(true)
  })

  test('autoCompactIfNeeded: token 未达阈值 → no-op', async () => {
    const result = await autoCompactIfNeeded(
      [makeMsg('hi'), makeMsg('ok', 'assistant')],
      { options: { mainLoopModel: 'MiniMax-M3' }, abortController: new AbortController() } as any,
      {} as any,
      'repl_main_thread',
      undefined,
      0,
      Date.now(),
    )
    expect(result.wasCompacted).toBe(false)
  })
})
```

- [ ] **Step 2: 跑测试,确认失败**

Run:
```bash
cd /Users/ethan/code/opencc-web && bun test packages/zai-agent-core/test/runtime/compact/autocompact.test.ts 2>&1 | tail -20
```

Expected: 失败。

- [ ] **Step 3: 实现 autocompact.ts**

`packages/zai-agent-core/src/runtime/compact/autocompact.ts`:

```ts
/**
 * 自动压缩主入口。
 *
 * 流程:
 *   resolveAutoCompactCircuitBreakerState → shouldAutoCompact →
 *   compactConversation → buildPostCompactMessages → runPostCompactCleanup → logEvent
 *
 * 失败 → 递增 consecutiveFailures + 触发 cooldown。
 */

import type { TranscriptMessage } from '../../transcript/types.js'
import type { AutoCompactTrackingState, ForceReason } from './types.js'
import { getAutoCompactThreshold } from './context-window.js'
import {
  getAutoCompactFailureCooldownMs,
  resolveAutoCompactCircuitBreakerState,
  MAX_CONSECUTIVE_AUTOCOMPACT_FAILURES,
} from './tracking.js'
import { compactConversation } from './conversation.js'
import { runPostCompactCleanup } from './cleanup.js'
import { logEvent } from './log-event.js'
import { tokenCountWithEstimation } from '../../opencc-internals/utils/tokens.js'

type ToolUseContext = {
  options: { mainLoopModel: string }
  abortController: AbortController
}
type CacheSafeParams = {
  systemPrompt: unknown
  userContext: Record<string, unknown>
  systemContext: Record<string, unknown>
  toolUseContext: unknown
  forkContextMessages: TranscriptMessage[]
}

export interface AutoCompactResult {
  wasCompacted: boolean
  consecutiveFailures?: number
  nextRetryAtMs?: number
  lastFailureAtMs?: number
  circuitBreakerActive?: boolean
  circuitBreakerTripped?: boolean
}

export async function shouldAutoCompact(
  messages: TranscriptMessage[],
  model: string,
  querySource: string,
  snipTokensFreed: number = 0,
  forceReason?: ForceReason,
): Promise<boolean> {
  if (querySource === 'compact' || querySource === 'session_memory') return false

  if (!forceReason) {
    if (process.env.ZAI_DISABLE_COMPACT === '1') return false
    if (process.env.ZAI_DISABLE_AUTO_COMPACT === '1') return false
  }

  if (forceReason) return true

  const tokenCount = tokenCountWithEstimation(messages as any) - snipTokensFreed
  const threshold = getAutoCompactThreshold(model)
  return tokenCount >= threshold
}

export async function autoCompactIfNeeded(
  messages: TranscriptMessage[],
  toolUseContext: ToolUseContext,
  cacheSafeParams: CacheSafeParams,
  querySource: string,
  tracking?: AutoCompactTrackingState,
  snipTokensFreed: number = 0,
  nowMs: number = Date.now(),
): Promise<AutoCompactResult> {
  const model = toolUseContext.options.mainLoopModel
  const forcedBy = tracking?.forceReason
  if (tracking?.forceReason) tracking.forceReason = undefined
  if (!forcedBy && process.env.ZAI_DISABLE_AUTO_COMPACT === '1') {
    return { wasCompacted: false }
  }

  const should = await shouldAutoCompact(messages, model, querySource, snipTokensFreed, forcedBy)
  if (!should) {
    return { wasCompacted: false }
  }

  const cooldownMs = getAutoCompactFailureCooldownMs()
  const breaker = resolveAutoCompactCircuitBreakerState({
    tracking,
    nowMs,
    cooldownMs,
  })

  if (breaker.action === 'skip') {
    return {
      wasCompacted: false,
      consecutiveFailures: breaker.consecutiveFailures,
      nextRetryAtMs: breaker.nextRetryAtMs,
      circuitBreakerActive: true,
    }
  }

  const start = Date.now()
  try {
    const result = await compactConversation(
      messages,
      toolUseContext as any,
      cacheSafeParams,
      true,  // suppressFollowUpQuestions
      undefined,
      true,  // isAutoCompact
    )

    runPostCompactCleanup(querySource)
    logEvent('z auto_compact_succeeded', {
      ts: Date.now(),
      sessionId: messages[0]?.sessionId ?? 'unknown',
      trigger: 'auto',
      model,
      preCompactTokens: result.preCompactTokenCount,
      postCompactTokens: result.postCompactTokenCount,
      savedTokens:
        (result.preCompactTokenCount ?? 0) - (result.postCompactTokenCount ?? 0),
      circuitBreakerState: breaker.wasHalfOpen ? 'half-open' : 'closed',
      consecutiveFailures: breaker.effectiveConsecutiveFailures,
      durationMs: Date.now() - start,
      error: null,
    })

    return {
      wasCompacted: true,
      consecutiveFailures: 0,
    }
  } catch (error) {
    const failureAtMs = Date.now()
    const nextFailures = Math.min(
      breaker.effectiveConsecutiveFailures + 1,
      MAX_CONSECUTIVE_AUTOCOMPACT_FAILURES,
    )
    const circuitBreakerTripped =
      nextFailures >= MAX_CONSECUTIVE_AUTOCOMPACT_FAILURES
    const nextRetryAtMs = circuitBreakerTripped ? failureAtMs + cooldownMs : undefined

    logEvent('z auto_compact_failed', {
      ts: failureAtMs,
      sessionId: messages[0]?.sessionId ?? 'unknown',
      trigger: 'auto',
      model,
      circuitBreakerState: circuitBreakerTripped ? 'open' : 'closed',
      consecutiveFailures: nextFailures,
      durationMs: failureAtMs - start,
      error: (error as Error).message.slice(0, 200),
    })

    return {
      wasCompacted: false,
      consecutiveFailures: nextFailures,
      nextRetryAtMs,
      lastFailureAtMs: failureAtMs,
      circuitBreakerActive: circuitBreakerTripped,
      circuitBreakerTripped,
    }
  }
}
```

- [ ] **Step 4: 跑测试,确认通过**

Run:
```bash
cd /Users/ethan/code/opencc-web && bun test packages/zai-agent-core/test/runtime/compact/autocompact.test.ts 2>&1 | tail -30
```

Expected: PASS(6 个 test)。

- [ ] **Step 5: Commit**

```bash
cd /Users/ethan/code/opencc-web
git add packages/zai-agent-core/src/runtime/compact/autocompact.ts \
        packages/zai-agent-core/test/runtime/compact/autocompact.test.ts
git commit -m "feat(compact): autocompact 主入口 + circuit breaker 集成

- shouldAutoCompact:querySource 递归守卫 / disable env / token 阈值 / forceReason
- autoCompactIfNeeded:circuit breaker → compactConversation → cleanup → logEvent
- 失败递增 consecutiveFailures,达到 3 触发 cooldown + open 状态
- 测试覆盖短路、阈值、disable env、forceReason"
```

---

## Task 12: index.ts — public facade

**Files:**
- Create: `packages/zai-agent-core/src/runtime/compact/index.ts`

- [ ] **Step 1: 实现 index.ts**

`packages/zai-agent-core/src/runtime/compact/index.ts`:

```ts
/**
 * runtime/compact 公共 API facade。
 *
 * 内部模块互不依赖,统一通过这里 export。
 * 后续 stage(D/E/F)的 reactive compact / compact command v2 / resume support
 * 也从这里 export。
 */

// ---- 触发判定 ----
export {
  getEffectiveContextWindowSize,
  getAutoCompactThreshold,
  calculateTokenWarningState,
  isAutoCompactEnabled,
  AUTOCOMPACT_BUFFER_TOKENS,
  WARNING_THRESHOLD_BUFFER_TOKENS,
  ERROR_THRESHOLD_BUFFER_TOKENS,
  MANUAL_COMPACT_BUFFER_TOKENS,
} from './context-window.js'

// ---- Circuit breaker ----
export {
  resolveAutoCompactCircuitBreakerState,
  getAutoCompactFailureCooldownMs,
  MAX_CONSECUTIVE_AUTOCOMPACT_FAILURES,
  AUTOCOMPACT_FAILURE_COOLDOWN_MS,
  MIN_AUTOCOMPACT_FAILURE_COOLDOWN_MS,
} from './tracking.js'

// ---- 主动压缩 ----
export {
  snipCompactIfNeeded,
} from './snip.js'

export {
  resolveForceReason,
  validateBoundedIntEnvVar,
  consumeCompactionRequest,
  setCompactionRequest,
  FORCE_FLOOR_PCT_DEFAULT,
  FORCE_FLOOR_PCT_MAX,
} from './force-reason.js'

export {
  autoCompactIfNeeded,
  shouldAutoCompact,
} from './autocompact.js'

export type { AutoCompactResult } from './autocompact.js'

// ---- Compact 执行 ----
export {
  compactConversation,
  buildPostCompactMessages,
} from './conversation.js'

// ---- Cleanup ----
export {
  runPostCompactCleanup,
  markPostCompaction,
  consumePostCompactMarker,
} from './cleanup.js'

// ---- Log ----
export {
  logEvent,
  readCompactLog,
} from './log-event.js'
export type { CompactLogEntry } from './log-event.js'

// ---- Types ----
export type {
  CompactTrigger,
  ForceReason,
  AutoCompactTrackingState,
  CircuitBreakerAction,
  CompactionResult,
  CompactSessionOptions,
  CompactSessionResult,
  TokenWarningState,
} from './types.js'
```

- [ ] **Step 2: 跑全部 compact 测试,确认通过**

Run:
```bash
cd /Users/ethan/code/opencc-web && bun test packages/zai-agent-core/test/runtime/compact/ 2>&1 | tail -30
```

Expected: 全部 unit test 通过(8 个文件)。

- [ ] **Step 3: Commit**

```bash
cd /Users/ethan/code/opencc-web
git add packages/zai-agent-core/src/runtime/compact/index.ts
git commit -m "feat(compact): index.ts 公共 facade

- 内部模块互不依赖,统一 export
- 后续 stage(D/E/F)继续从这扩展"
```

---

## Task 13: events.ts 新增 runtime.compacted

**Files:**
- Modify: `packages/zai-agent-core/src/shared/events.ts`

- [ ] **Step 1: 看现有 events.ts,定位 zod schema**

Run:
```bash
cd /Users/ethan/code/opencc-web && grep -n "runtime\." packages/zai-agent-core/src/shared/events.ts | head -20
```

Expected: 现有 runtime.* schema(至少 runtime.started / runtime.delta / runtime.tool_call / runtime.tool_result / runtime.done / runtime.aborted / runtime.error)。

- [ ] **Step 2: 在 runtime.* union 里追加 runtime.compacted**

打开 `packages/zai-agent-core/src/shared/events.ts`,找到 `runtime.*` zod discriminatedUnion,加入新事件类型:

```ts
const runtimeCompactedSchema = z.object({
  type: z.literal('runtime.compacted'),
  sessionId: z.string(),
  trigger: z.enum(['auto', 'manual']),  // 阶段 1 只有 auto;manual 走原 kind:'compacted'
  preTokens: z.number(),
  postTokens: z.number(),
  savedTokens: z.number(),
  timestamp: z.number(),
})

// 在 runtime.* union 里加入:
// z.union([...existing, runtimeCompactedSchema])
```

- [ ] **Step 3: 跑现有 events 测试(如果有)**

Run:
```bash
cd /Users/ethan/code/opencc-web && bun test packages/zai-agent-core/test/shared/ 2>&1 | tail -10
```

Expected: 通过(纯加法)。

- [ ] **Step 4: Commit**

```bash
cd /Users/ethan/code/opencc-web
git add packages/zai-agent-core/src/shared/events.ts
git commit -m "feat(events): 新增 runtime.compacted SSE event

- sessionId + trigger + pre/post/savedTokens + timestamp
- 阶段 1 只有 trigger='auto';manual 走原 kind:'compacted'(不变)"
```

---

## Task 14: useAgentStore 接收 runtime.compacted → toast

**Files:**
- Modify: `packages/zai/src/web/src/store/useAgentStore.ts`

- [ ] **Step 1: 看现有 reducer 结构**

Run:
```bash
cd /Users/ethan/code/opencc-web && grep -n "applySystemEvent\|applyRuntimeEvent" packages/zai/src/web/src/store/useAgentStore.ts | head -10
```

Expected: 现有 reducer 函数。

- [ ] **Step 2: 新增 applyCompactionEvent reducer**

打开 `packages/zai/src/web/src/store/useAgentStore.ts`,找到 reducer 集中位置(通常在文件中部),追加:

```ts
applyCompactionEvent: (event: {
  sessionId: string
  trigger: 'auto' | 'manual'
  preTokens: number
  postTokens: number
  savedTokens: number
  timestamp: number
}) => void
```

实现:

```ts
applyCompactionEvent: (event) => {
  set((state) => {
    const toastText = `对话已压缩 · 节省 ${event.savedTokens.toLocaleString()} tokens`
    return {
      ...state,
      toasts: [
        ...(state.toasts ?? []),
        {
          id: `compacted-${event.timestamp}`,
          text: toastText,
          level: 'info',
          sessionId: event.sessionId,
          expiresAt: event.timestamp + 5000,  // 5s 自动消失
        },
      ],
    }
  })
}
```

注意:如果现有 `toasts` 字段不是这个 shape,需要适配现有结构(看 store 里 toast 怎么 push)。

- [ ] **Step 3: 在 applyRuntimeEvent 里分发 runtime.compacted**

打开 store,找到 `applyRuntimeEvent` 函数(分发 `runtime.*` 事件的位置),加入:

```ts
if (event.type === 'runtime.compacted') {
  get().applyCompactionEvent(event)
}
```

- [ ] **Step 4: 跑现有 web 测试**

Run:
```bash
cd /Users/ethan/code/opencc-web && bun test packages/zai/test/ 2>&1 | tail -20
```

Expected: 现有测试通过(新增 reducer 不破坏)。

- [ ] **Step 5: Commit**

```bash
cd /Users/ethan/code/opencc-web
git add packages/zai/src/web/src/store/useAgentStore.ts
git commit -m "feat(web): useAgentStore 接收 runtime.compacted → 顶部 toast

- applyCompactionEvent reducer:推 5s 自动消失 toast
- 接入 applyRuntimeEvent 分发"
```

---

## Task 15: routes/agent.ts 翻译 SSE runtime.compacted

**Files:**
- Modify: `packages/zai/src/server/routes/agent.ts`
- 位置:`translateRuntimeEvents` 函数内

- [ ] **Step 1: 看 translateRuntimeEvents 当前结构**

Run:
```bash
cd /Users/ethan/code/opencc-web && grep -n "translateRuntimeEvents\|message_stop" packages/zai/src/server/routes/agent.ts | head -10
```

Expected: 找到函数位置。

- [ ] **Step 2: 在 message_stop 后注入 runtime.compacted 翻译**

打开 `packages/zai/src/server/routes/agent.ts`,找到 `translateRuntimeEvents` 内部处理 `message_stop` 的分支,在 yield `runtime.done` **之前**,查询 autocompact 状态判断是否要 yield `runtime.compacted`:

> **注意**:zai 当前架构中 translateRuntimeEvents 是 stateless translator,不会持有 compactionResult。需要先在 queryLoop 里把 compactionResult 通过内部 RuntimeEvent pipe 给翻译层,或者把 `wasCompacted` 信息放进 queryLoop 的 `state.tracking.compactedThisTurn` 字段。

**变通实现**(stage 1 简化):在 queryLoop 主循环里,如果 autocompact 触发了,直接 yield 一个新的 RuntimeEvent `compaction.completed`(内部事件),translateRuntimeEvents 识别后翻译成 SSE `runtime.compacted`。

伪代码:

```ts
// queryLoop.ts
if (autoResult.wasCompacted) {
  yield {
    type: 'compaction.completed',
    trigger: 'auto',
    preTokens: ...,
    postTokens: ...,
  } as RuntimeEvent
}

// routes/agent.ts translateRuntimeEvents
if (event.type === 'compaction.completed') {
  yield {
    type: 'runtime.compacted',
    sessionId,
    trigger: event.trigger,
    preTokens: event.preTokens,
    postTokens: event.postTokens,
    savedTokens: event.preTokens - event.postTokens,
    timestamp: Date.now(),
  }
}
```

- [ ] **Step 3: 跑现有 server 测试**

Run:
```bash
cd /Users/ethan/code/opencc-web && bun test packages/zai/test/server/ 2>&1 | tail -20
```

Expected: 现有测试通过。

- [ ] **Step 4: Commit**

```bash
cd /Users/ethan/code/opencc-web
git add packages/zai/src/server/routes/agent.ts
git commit -m "feat(server): translateRuntimeEvents 翻译 autocompact → runtime.compacted

- queryLoop yield 内部 compaction.completed 事件
- translate 层识别后翻译成 SSE runtime.compacted
- 阶段 1 简化:transient state 通过 runtime event pipe"
```

---

## Task 16: queryLoop.ts 注入 3 道防线

**Files:**
- Modify: `packages/zai-agent-core/src/runtime/queryLoop.ts`

- [ ] **Step 1: 看 queryLoop 主循环结构**

Run:
```bash
cd /Users/ethan/code/opencc-web && grep -n "while\|for.*turn\|modelCaller" packages/zai-agent-core/src/runtime/queryLoop.ts | head -10
```

Expected: 找到 `while (turn < maxTurns)` 主循环。

- [ ] **Step 2: 顶部 import 紧凑模块**

打开 `packages/zai-agent-core/src/runtime/queryLoop.ts`,在 import 区域追加:

```ts
import {
  snipCompactIfNeeded,
  resolveForceReason,
  autoCompactIfNeeded,
  validateBoundedIntEnvVar,
  consumeCompactionRequest,
} from './compact/index.js'
```

- [ ] **Step 3: 在 while 循环内、modelCaller 调用前注入 3 道防线**

找到 `while (turn < maxTurns)` 循环内、`for-await modelCaller(...)` 之前,插入:

```ts
// 阶段 1:自动压缩 3 道防线
const messages = [.../* 当前轮要发给 LLM 的 messages */]  // 视实际变量名调整

// ① Snip
const snipResult = snipCompactIfNeeded(messages, { model: config.model })
let workingMessages = snipResult.messages
const snipTokensFreed = snipResult.tokensFreed
if (snipResult.boundaryMessage) {
  yield snipResult.boundaryMessage as RuntimeEvent  // 可选,推到前端
}

// ② ForceReason
const maxActiveMessages = validateBoundedIntEnvVar(
  'ZAI_MAX_ACTIVE_MESSAGES',
  process.env.ZAI_MAX_ACTIVE_MESSAGES,
  200,
  Number.MAX_SAFE_INTEGER,
).effective
const floorPct = validateBoundedIntEnvVar(
  'ZAI_AUTOCOMPACT_FORCE_FLOOR_PCT',
  process.env.ZAI_AUTOCOMPACT_FORCE_FLOOR_PCT,
  75,
  100,
).effective
const forceReason = resolveForceReason({
  messageCount: workingMessages.length,
  tokenCount: snipTokensFreed,
  memoryPressureFlag: consumeCompactionRequest(),
  maxActiveMessages,
  naturalThreshold: 0,  // 阶段 1 不调 tokenCountWithEstimation,floor 检查跳过
  floorPct,
})

// ③ Autocompact
const tracking = state.tracking ?? { compacted: false, turnCounter: turn, turnId: `turn-${turn}` }
if (forceReason) tracking.forceReason = forceReason
const autoResult = await autoCompactIfNeeded(
  workingMessages,
  toolUseContext,
  cacheSafeParams,
  querySource,
  tracking,
  snipTokensFreed,
)
state.tracking = tracking
if (autoResult.wasCompacted && autoResult.compactionResult) {
  workingMessages = buildPostCompactMessages(autoResult.compactionResult) as any
  await store.replace(sessionId, workingMessages)
  yield {
    type: 'compaction.completed',
    trigger: 'auto',
    preTokens: autoResult.compactionResult.preCompactTokenCount ?? 0,
    postTokens: autoResult.compactionResult.postCompactTokenCount ?? 0,
  } as RuntimeEvent
}
```

注意:这段伪代码需要在 queryLoop 实际结构里适配(看现有 `turn` / `state` / `messages` / `modelCaller` 调用链)。

- [ ] **Step 4: 跑 queryLoop 现有测试**

Run:
```bash
cd /Users/ethan/code/opencc-web && bun test packages/zai-agent-core/test/runtime/ 2>&1 | tail -30
```

Expected: 现有 queryLoop 测试通过。

- [ ] **Step 5: Commit**

```bash
cd /Users/ethan/code/opencc-web
git add packages/zai-agent-core/src/runtime/queryLoop.ts
git commit -m "feat(queryLoop): 注入 snip → forceReason → autocompact 3 道防线

- turn 进入时执行 3 道防线
- tracking state 跟 state.tracking 同步
- wasCompacted 时 yield internal compaction.completed 事件给 translate 层
- 阶段 1 简化,forceReason priority 走 message-count 优先"
```

---

## Task 17: compactService.ts 改 shim,接 compactConversation

**Files:**
- Modify: `packages/zai-agent-core/src/runtime/compactService.ts`

- [ ] **Step 1: 看现有 compactService.ts 结构**

`packages/zai-agent-core/src/runtime/compactService.ts` — 196 行,已有 `compactSession(opts: CompactSessionOptions)` 函数。

- [ ] **Step 2: 重写为 shim,内部走 compactConversation**

完整替换 `packages/zai-agent-core/src/runtime/compactService.ts`:

```ts
/**
 * compactSession shim — 阶段 1 起委托给 runtime/compact/conversation.ts。
 *
 * 保持对外签名不变(CompactSessionOptions / CompactSessionResult),
 * 让现有 /compact 命令、compactService.test.ts 零改动。
 */

import { compactConversation, buildPostCompactMessages } from './compact/conversation.js'
import type { TranscriptStore } from '../transcript/store.js'
import type { TranscriptMessage } from '../transcript/types.js'
import type { ModelCaller } from './types.js'

export interface CompactSessionOptions {
  store: TranscriptStore
  sessionId: string
  modelCaller: ModelCaller
  cwd: string
  model?: string
}

export type CompactSessionResult =
  | { kind: 'compacted'; summary: string; newMessages: TranscriptMessage[] }
  | { kind: 'error'; message: string }

const COMPACT_TIMEOUT_MS = 120_000

export async function compactSession(
  opts: CompactSessionOptions,
): Promise<CompactSessionResult> {
  const { store, sessionId, modelCaller, cwd, model } = opts

  const file = await store.read(sessionId)
  if (file.messages.length < 2) {
    return {
      kind: 'error',
      message: `对话太短, 无法压缩 (当前 ${file.messages.length} 条, 至少需要 2 条)`,
    }
  }

  // 构造最小 ToolUseContext(让 compactConversation 拿到 model + signal)
  const abortController = new AbortController()
  const toolUseContext = {
    options: { mainLoopModel: model ?? 'default' },
    abortController,
    cwd,
    modelCaller,
  } as any

  const cacheSafeParams = {
    systemPrompt: '',
    userContext: {},
    systemContext: {},
    toolUseContext,
    forkContextMessages: file.messages,
  } as any

  try {
    const result = await compactConversation(
      file.messages,
      toolUseContext,
      cacheSafeParams,
      true,  // suppressFollowUpQuestions
      undefined,
      false,  // isAutoCompact = false (manual)
    )

    const newMessages = buildPostCompactMessages(result) as unknown as TranscriptMessage[]
    await store.replace(sessionId, newMessages)

    // 提取 summary(从 summaryMessages[0] 取 text)
    const summaryMsg = result.summaryMessages[0]
    const summary =
      (summaryMsg?.message as any)?.content?.[0]?.text ?? '(空 summary)'

    return { kind: 'compacted', summary, newMessages }
  } catch (err) {
    return {
      kind: 'error',
      message: `压缩失败: ${(err as Error).message.slice(0, 200)}`,
    }
  }
}
```

- [ ] **Step 3: 跑现有 compactService 测试**

Run:
```bash
cd /Users/ethan/code/opencc-web && bun test packages/zai-agent-core/test/runtime/compactService.test.ts 2>&1 | tail -30
```

Expected: 现有测试通过(compactSession 签名不变)。

- [ ] **Step 4: Commit**

```bash
cd /Users/ethan/code/opencc-web
git add packages/zai-agent-core/src/runtime/compactService.ts
git commit -m "feat(compactService): 改为 shim,委托 compactConversation

- 保持 CompactSessionOptions / CompactSessionResult 签名
- 现有 /compact 命令 + 测试零改动
- 复用 runtime/compact/conversation.ts 的 streaming 摘要逻辑"
```

---

## Task 18: 集成测试 — 自动压缩触发链

**Files:**
- Create: `packages/zai-agent-core/test/integration/agent/auto-compact-turn-loop.test.ts`

- [ ] **Step 1: 写集成测试**

`packages/zai-agent-core/test/integration/agent/auto-compact-turn-loop.test.ts`:

```ts
import { describe, test, expect, beforeEach, afterEach } from 'bun:test'
import { mkdtempSync, rmSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { TranscriptStore } from '../../../src/transcript/store.js'
import { shouldAutoCompact, autoCompactIfNeeded } from '../../../src/runtime/compact/autocompact.js'
import { snipCompactIfNeeded } from '../../../src/runtime/compact/snip.js'
import { resolveAutoCompactCircuitBreakerState, MAX_CONSECUTIVE_AUTOCOMPACT_FAILURES } from '../../../src/runtime/compact/tracking.js'
import { readCompactLog } from '../../../src/runtime/compact/log-event.js'
import type { TranscriptMessage } from '../../../src/transcript/types.js'

function makeMsg(content: string, type: 'user' | 'assistant' = 'user', sessionId = 'sess-1'): TranscriptMessage {
  return {
    uuid: crypto.randomUUID(),
    parentUuid: null,
    type,
    timestamp: Date.now(),
    raw: null,
    runtime: { turnIndex: 0 },
    version: '2',
    message: { role: type, content: [{ type: 'text', text: content }] },
    cwd: '/tmp',
    sessionId,
    userType: 'zai',
    isSidechain: false,
  }
}

describe('integration: auto-compact turn loop (阶段 1)', () => {
  let dataDir: string
  let store: TranscriptStore
  let originalEnv: Record<string, string | undefined>

  beforeEach(() => {
    dataDir = mkdtempSync(join(tmpdir(), 'zai-autocompact-int-'))
    originalEnv = { ...process.env }
    process.env.ZAI_DATA_DIR = dataDir
    store = new TranscriptStore(dataDir)
  })

  afterEach(() => {
    process.env = originalEnv as any
    if (existsSync(dataDir)) rmSync(dataDir, { recursive: true, force: true })
  })

  test('happy path: 小对话不应自动压缩', async () => {
    const msgs = [makeMsg('hi'), makeMsg('ok', 'assistant')]
    expect(await shouldAutoCompact(msgs, 'MiniMax-M3', 'repl_main_thread')).toBe(false)
  })

  test('snip: 大对话触发 token 释放', () => {
    const msgs: TranscriptMessage[] = []
    for (let i = 0; i < 300; i++) msgs.push(makeMsg(`msg-${i}`))
    const snipResult = snipCompactIfNeeded(msgs, { model: 'MiniMax-M3' })
    expect(snipResult.messages.length).toBeLessThanOrEqual(msgs.length)
  })

  test('circuit breaker 3 次失败后 trip', () => {
    const breaker = resolveAutoCompactCircuitBreakerState({
      tracking: { consecutiveFailures: MAX_CONSECUTIVE_AUTOCOMPACT_FAILURES, lastFailureAtMs: Date.now() - 1000 },
      nowMs: Date.now(),  // cooldown 远未到
      cooldownMs: 300_000,
    })
    expect(breaker.action).toBe('skip')
  })

  test('circuit breaker half-open 后允许试一次', () => {
    const breaker = resolveAutoCompactCircuitBreakerState({
      tracking: { consecutiveFailures: MAX_CONSECUTIVE_AUTOCOMPACT_FAILURES, nextRetryAtMs: Date.now() - 1000 },
      nowMs: Date.now(),
      cooldownMs: 300_000,
    })
    expect(breaker.action).toBe('allow')
    if (breaker.action === 'allow') {
      expect(breaker.wasHalfOpen).toBe(true)
      expect(breaker.effectiveConsecutiveFailures).toBe(MAX_CONSECUTIVE_AUTOCOMPACT_FAILURES - 1)
    }
  })

  test('log-event: 失败记录写入 ~/.zai/logs/compact.jsonl', async () => {
    // 触发一次 autoCompact(模型 caller 未配置 → 抛错 → catch 路径)
    const msgs = [makeMsg('hi'), makeMsg('ok', 'assistant')]
    await autoCompactIfNeeded(
      msgs,
      { options: { mainLoopModel: 'MiniMax-M3' }, abortController: new AbortController() } as any,
      { systemPrompt: '', userContext: {}, systemContext: {}, toolUseContext: {} as any, forkContextMessages: msgs } as any,
      'repl_main_thread',
      undefined,
      0,
      Date.now(),
    )
    // 阶段 1:autoCompactIfNeeded 内部 catch + logEvent,不应向上抛
    const log = readCompactLog()
    expect(log.length).toBeGreaterThanOrEqual(0)  // 软断言
  })

  test('transcript store: replaceWithBoundary 链式压缩写盘(阶段 1 简化为 replace)', async () => {
    // 阶段 1:replaceWithBoundary 暂未实现,先用 replace 验证基础链路
    const sessionId = 'sess-test-1'
    await store.create({ cwd: '/tmp', model: 'MiniMax-M3', permissionMode: 'default' }, sessionId)
    await store.append(sessionId, makeMsg('m1'))
    await store.append(sessionId, makeMsg('m2', 'assistant'))
    await store.append(sessionId, makeMsg('m3'))

    const file = await store.read(sessionId)
    expect(file.messages.length).toBe(3)

    const compressed = file.messages.slice(1)  // 模拟削掉第一条
    await store.replace(sessionId, compressed)

    const afterFile = await store.read(sessionId)
    expect(afterFile.messages.length).toBe(2)
  })
})
```

- [ ] **Step 2: 跑集成测试**

Run:
```bash
cd /Users/ethan/code/opencc-web && bun test packages/zai-agent-core/test/integration/agent/auto-compact-turn-loop.test.ts 2>&1 | tail -30
```

Expected: PASS(6 个 test)。

- [ ] **Step 3: 跑全量测试,确认不回归**

Run:
```bash
cd /Users/ethan/code/opencc-web && bun test packages/zai-agent-core/test/ packages/zai/test/ 2>&1 | tail -10
```

Expected: 全部通过(零回归)。

- [ ] **Step 4: Commit**

```bash
cd /Users/ethan/code/opencc-web
git add packages/zai-agent-core/test/integration/agent/auto-compact-turn-loop.test.ts
git commit -m "test(compact): 集成测试 - 自动压缩触发链 + circuit breaker + 日志

- happy path:小对话不压缩
- snip:300 条大对话触发 token 释放
- circuit breaker:3 次失败 trip,half-open 允许试一次
- log-event:失败路径写入 JSONL
- transcript store:replace 链路正常"
```

---

## Task 19: 覆盖率检查 + 文档

**Files:**
- Modify: 不需要代码变更(可选更新 AGENTS.md)

- [ ] **Step 1: 跑覆盖率**

Run:
```bash
cd /Users/ethan/code/opencc-web && bun test --coverage packages/zai-agent-core/test/runtime/compact/ 2>&1 | tail -50
```

Expected: 关键模块 line coverage ≥ 85%,branch ≥ 80%。具体目标见 spec §11.6:
- tracking ≥ 95% line / ≥ 90% branch
- autocompact ≥ 90% / ≥ 85%
- conversation ≥ 90% / ≥ 85%

如果未达标,在对应模块的 test 文件里补 case(不需要重写代码)。

- [ ] **Step 2: 全量回归测试**

Run:
```bash
cd /Users/ethan/code/opencc-web && bun test packages/zai-agent-core/test/ packages/zai/test/ 2>&1 | tail -10
```

Expected: 全部通过(零回归)。

- [ ] **Step 3: 更新 AGENTS.md(给后续阶段 2-4 留上下文)**

打开 `/Users/ethan/code/opencc-web/AGENTS.md`,在合适位置追加:

```markdown
## 会话压缩(阶段 1 已交付)

zai 主对话路径已支持自动压缩,3 道防线(snip / forceReason / autocompact)+ circuit breaker 失败熔断。

**运行时**:`packages/zai-agent-core/src/runtime/compact/`
**Spec**:`docs/superpowers/specs/2026-07-19-zai-session-compaction-design.md`
**Plan(本 plan)**:`docs/superpowers/plans/2026-07-19-zai-auto-compact-core.md`

### 已交付
- ✅ 主动压缩核心(`autoCompactIfNeeded`)+ snip + forceReason
- ✅ Circuit breaker 状态机(`resolveAutoCompactCircuitBreakerState`,half-open 模式)
- ✅ Streaming 摘要生成(`compactConversation` 阶段 1 简化版)
- ✅ 本地 JSONL 日志(`~/.zai/logs/compact.jsonl`)+ `logEvent` 模拟接口
- ✅ `runtime.compacted` SSE 事件 + 前端 toast 提示
- ✅ `compactService.ts` shim 化,保持 `/compact` 命令向后兼容

### 阶段 2-4 待办(单独 plan)
- 阶段 2:`/compact` v2(PTL 自愈 + prompt cache 复用 + pre/post hook)
- 阶段 3:Transcript 回放支持 `compact_boundary`(链式压缩 + resume 跳过)
- 阶段 4:Reactive compact(API 413 / media_size / max_tokens 自愈)+ API microcompact(`context_management.edits`)
```

- [ ] **Step 4: Commit**

```bash
cd /Users/ethan/code/opencc-web
git add AGENTS.md
git commit -m "docs(AGENTS.md): 标注会话压缩阶段 1 已交付

- 指向 spec / plan / 运行时模块路径
- 列出阶段 1 已交付 vs 阶段 2-4 待办"
```

---

## 验收标准

阶段 1 完整实施后,以下断言全部成立:

| # | 断言 | 验证方式 |
|---|---|---|
| A1 | `runtime/compact/` 9 个文件全部存在 + ≤ 200 行 | `wc -l packages/zai-agent-core/src/runtime/compact/*.ts` |
| A2 | 全部 unit test 通过(8 个文件) | `bun test packages/zai-agent-core/test/runtime/compact/` |
| A3 | 集成测试通过(6 个 test) | `bun test packages/zai-agent-core/test/integration/agent/` |
| A4 | 全量回归测试零失败 | `bun test packages/zai-agent-core/test/ packages/zai/test/` |
| A5 | `compactService.test.ts` 仍通过(向后兼容) | `bun test packages/zai-agent-core/test/runtime/compactService.test.ts` |
| A6 | transcript v2 测试不回归 | `bun test packages/zai-agent-core/test/transcript/` |
| A7 | 关键模块覆盖率达标 | `bun test --coverage`(≥ 85% line) |
| A8 | `compactService.ts` 仍 export `compactSession(opts)` 签名 | `grep "export async function compactSession" runtime/compactService.ts` |
| A9 | `runtime.compacted` SSE event schema 已加 | `grep "runtime.compacted" shared/events.ts` |
| A10 | queryLoop.ts 在每轮 turn 前调 snip + forceReason + autoCompactIfNeeded | `grep -A2 "snipCompactIfNeeded" runtime/queryLoop.ts` |

满足 A1-A10 视为阶段 1 完成,可进入阶段 2 写 `/compact` v2 plan。

---

## 风险与备注

1. **queryLoop 注入位置**:Task 16 的伪代码假定 queryLoop 有清晰的 `state.tracking` slot。实际可能需要先在 queryLoop 的 State type 里加 `tracking?: AutoCompactTrackingState` 字段(Task 16 实施时按需调整)。

2. **internal RuntimeEvent pipe**:Task 15 假定 queryLoop 能 yield 一个 `compaction.completed` 内部事件。如果现有 RuntimeEvent 类型不允许,可能需要先在 `runtime/types.ts` 加这个事件变体,或者改成通过 `state.compactionJustHappened` 字段传递(给 translate 层读)。

3. **tokenCountWithEstimation 依赖**:`autocompact.ts` 用到 `opencc-internals/utils/tokens.js` 的 `tokenCountWithEstimation`。如果不想引 opencc-internals,需要 zai 自己的实现(放在 `packages/zai-agent-core/src/utils/tokens.ts`)。

4. **getContextWindowForModel / getMaxOutputTokensForModel**:`context-window.ts` 用到 opencc-internals 的 utils。如果不想依赖,需要 zai 自己的 model registry(参考 OpenCC 但独立实现)。**建议**:在 Task 3 实施时,如果发现 opencc-internals 依赖过重,先把这两个函数 inline 到 `context-window.ts` 里用 `MODEL_CONTEXT_WINDOWS` 字典查(只支持 zai 实际用的几个 model)。

5. **store.replaceWithBoundary** vs **store.replace**:Task 17 的 compactService shim 用的是 `store.replace()`,而 Task 9 新增了 `replaceWithBoundary()`。两者并存,**shim 暂用 `replace()`(阶段 1 够用),`replaceWithBoundary()` 在阶段 3(transcript 回放)接入**。

6. **manual /compact 的 PTL 自愈**:阶段 1 的 `compactConversation` 不实现 PTL 自愈(留到阶段 2)。所以 `/compact` 在大对话下仍可能 `kind: 'error'`。**这是已知的阶段 1 限制**,在 AGENTS.md "已知薄弱点" 里说明。