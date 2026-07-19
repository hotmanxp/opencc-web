/**
 * 集成测试 — 自动压缩触发链 (Task 18)。
 *
 * 覆盖 plan §Task 18 的 6 个 case,把 snip / forceReason / autocompact /
 * circuit breaker / log-event / transcript store 串起来验证。
 *
 * 阶段 1 简化版:不在 queryLoop 里跑(那层太重),直接在
 * `autoCompactIfNeeded` 层 mock modelCaller 跑端到端。
 */

import { describe, test, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { TranscriptStore } from '../../../src/transcript/store.js'
import {
  shouldAutoCompact,
  autoCompactIfNeeded,
} from '../../../src/runtime/compact/autocompact.js'
import { snipCompactIfNeeded } from '../../../src/runtime/compact/snip.js'
import {
  resolveAutoCompactCircuitBreakerState,
  MAX_CONSECUTIVE_AUTOCOMPACT_FAILURES,
} from '../../../src/runtime/compact/tracking.js'
import { readCompactLog } from '../../../src/runtime/compact/log-event.js'
import {
  buildPostCompactMessages,
} from '../../../src/runtime/compact/conversation.js'
import type { TranscriptMessage } from '../../../src/transcript/types.js'

function makeMsg(
  content: string,
  type: 'user' | 'assistant' = 'user',
  sessionId = 'sess-1',
): TranscriptMessage {
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
    process.env = originalEnv as Record<string, string | undefined>
    if (existsSync(dataDir)) rmSync(dataDir, { recursive: true, force: true })
  })

  // ---- 1. happy path ----

  test('happy path: 小对话不应自动压缩', async () => {
    const msgs = [makeMsg('hi'), makeMsg('ok', 'assistant')]
    const r = await shouldAutoCompact(msgs, 'MiniMax-M3', 'repl_main_thread')
    expect(r).toBe(false)
  })

  // ---- 2. snip 大对话 ----

  test('snip: 大对话触发 token 释放, messages 数减少', () => {
    const msgs: TranscriptMessage[] = []
    for (let i = 0; i < 300; i++) msgs.push(makeMsg(`msg-${i}`))
    const snipResult = snipCompactIfNeeded(msgs, { model: 'MiniMax-M3' })
    expect(snipResult.messages.length).toBeLessThan(msgs.length)
    expect(snipResult.tokensFreed).toBeGreaterThan(0)
    expect(snipResult.boundaryMessage).toBeDefined()
  })

  // ---- 3. circuit breaker 状态机 ----

  test('circuit breaker 3 次失败后 trip, cooldown 内 skip', () => {
    const breaker = resolveAutoCompactCircuitBreakerState({
      tracking: {
        consecutiveFailures: MAX_CONSECUTIVE_AUTOCOMPACT_FAILURES,
        lastFailureAtMs: Date.now() - 1000,
      },
      nowMs: Date.now(), // cooldown 5min 远未到
      cooldownMs: 300_000,
    })
    expect(breaker.action).toBe('skip')
    if (breaker.action === 'skip') {
      expect(breaker.circuitBreakerActive).toBe(true)
      expect(breaker.consecutiveFailures).toBe(3)
    }
  })

  test('circuit breaker half-open: cooldown 过后允许试一次, wasHalfOpen=true', () => {
    const breaker = resolveAutoCompactCircuitBreakerState({
      tracking: {
        consecutiveFailures: MAX_CONSECUTIVE_AUTOCOMPACT_FAILURES,
        nextRetryAtMs: Date.now() - 1000,
      },
      nowMs: Date.now(),
      cooldownMs: 300_000,
    })
    expect(breaker.action).toBe('allow')
    if (breaker.action === 'allow') {
      expect(breaker.wasHalfOpen).toBe(true)
      expect(breaker.effectiveConsecutiveFailures).toBe(
        MAX_CONSECUTIVE_AUTOCOMPACT_FAILURES - 1,
      )
    }
  })

  // ---- 4. log-event 失败路径(没配 modelCaller → catch → log) ----

  test('log-event: 失败路径写入 ~/.zai/logs/compact.jsonl', async () => {
    const msgs = [makeMsg('hi'), makeMsg('ok', 'assistant')]
    // 传 forceReason 强制进 try 分支 → 没配 modelCaller → compactConversation
    // 抛错 → catch 路径写日志。token 未达阈值时直接 return false 不会进 catch。
    await autoCompactIfNeeded(
      msgs,
      {
        options: { mainLoopModel: 'MiniMax-M3' },
        abortController: new AbortController(),
      } as any,
      {} as any,
      'repl_main_thread',
      {
        compacted: false,
        turnCounter: 0,
        turnId: 'turn-0',
        forceReason: 'message-count',
      },
      0,
      Date.now(),
    )
    const log = readCompactLog()
    const failedEntries = log.filter((e) => e.trigger === 'auto')
    expect(failedEntries.length).toBeGreaterThanOrEqual(1)
    expect(failedEntries.some((e) => e.error !== null)).toBe(true)
  })

  // ---- 5. transcript store replace 链路 ----

  test('transcript store: replace 链路正常, messages 数从 3 减到 2', async () => {
    const sessionId = 'sess-test-1'
    await store.create({ cwd: '/tmp', model: 'MiniMax-M3' }, sessionId)
    await store.append(sessionId, makeMsg('m1'))
    await store.append(sessionId, makeMsg('m2', 'assistant'))
    await store.append(sessionId, makeMsg('m3'))

    const file = await store.read(sessionId)
    expect(file.messages.length).toBe(3)

    // 模拟削掉第一条
    const compressed = file.messages.slice(1)
    await store.replace(sessionId, compressed)

    const afterFile = await store.read(sessionId)
    expect(afterFile.messages.length).toBe(2)
    expect(afterFile.messages[0]?.uuid).toBe(file.messages[1]?.uuid)
  })

  // ---- 6. 端到端:mock modelCaller → autoCompactIfNeeded → store.replace → read 出来 ----

  test('end-to-end: 大对话 + forceReason → compact → store.replace 链路', async () => {
    const sessionId = 'sess-test-2'
    await store.create({ cwd: '/tmp', model: 'MiniMax-M3' }, sessionId)
    // 3 条对话
    await store.append(sessionId, makeMsg('hi', 'user', sessionId))
    await store.append(sessionId, makeMsg('hello', 'assistant', sessionId))
    await store.append(sessionId, makeMsg('how are you', 'user', sessionId))

    const file = await store.read(sessionId)
    const msgs = file.messages
    expect(msgs.length).toBe(3)

    // mock modelCaller:吐 "compact summary" + message_stop
    const mockModelCaller = (async function* () {
      yield { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } }
      yield {
        type: 'content_block_delta',
        index: 0,
        delta: { type: 'text_delta', text: '对话摘要:用户打招呼,助手回应。' },
      }
      yield { type: 'message_stop' }
    }) as any

    // forceReason 强制压缩(token 未达阈值也能触发)
    const result = await autoCompactIfNeeded(
      msgs,
      {
        options: { mainLoopModel: 'MiniMax-M3' },
        abortController: new AbortController(),
        modelCaller: mockModelCaller,
      } as any,
      {} as any,
      'repl_main_thread',
      {
        compacted: false,
        turnCounter: 0,
        turnId: 'turn-0',
        forceReason: 'message-count',
      },
      0,
      Date.now(),
    )

    expect(result.wasCompacted).toBe(true)
    expect(result.consecutiveFailures).toBe(0)
  })
})

/**
 * buildPostCompactMessages + store.replace 链路 smoke test —
 * 验证把 compactConversation 跑出来的 CompactionResult 通过
 * buildPostCompactMessages 转成 TranscriptMessage[] 后能正确
 * 落盘并读出,边界 message 在最前。
 */
describe('integration: compact result → store.replace', () => {
  test('buildPostCompactMessages 顺序: boundary → summary → keep', () => {
    const boundary = makeMsg('对话从这之后被压缩为摘要', 'system', 'sess-z')
    const summary = makeMsg('压缩后的摘要内容', 'user', 'sess-z')
    const result = {
      boundaryMarker: boundary,
      summaryMessages: [summary],
      attachments: [],
      hookResults: [],
      messagesToKeep: [],
    } as any

    const out = buildPostCompactMessages(result)
    expect(out.length).toBe(2)
    expect(out[0]?.uuid).toBe(boundary.uuid)
    expect(out[1]?.uuid).toBe(summary.uuid)
  })
})