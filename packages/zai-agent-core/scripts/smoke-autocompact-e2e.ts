/**
 * E2E smoke for stage 1 autoCompact (非 manual /compact 路径)。
 *
 * 验证 plan 阶段 1 的 3 道防线 + circuit breaker + logEvent 真实跑通:
 *   1. 灌入 3 条对话
 *   2. forceReason='message-count' 强制触发 autocompact
 *   3. mock modelCaller 返 message_stop → wasCompacted=true, logEvent 写 JSONL
 *   4. 连续 3 次失败 → 第 3 次失败触发 cooldown + circuitBreakerTripped=true
 *   5. 第 4 次调用被 circuit breaker 拦住 → wasCompacted=false, circuitBreakerActive=true
 */

import { mkdtempSync, rmSync, existsSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { TranscriptMessage } from '../src/transcript/types.js'
import { autoCompactIfNeeded } from '../src/runtime/compact/autocompact.js'
import { readCompactLog } from '../src/runtime/compact/log-event.js'
import { MAX_CONSECUTIVE_AUTOCOMPACT_FAILURES } from '../src/runtime/compact/tracking.js'

function section(title: string) {
  console.log(`\n=== ${title} ===`)
}

function makeMsg(content: string, type: 'user' | 'assistant' = 'user', sid = 'sess-smoke'): TranscriptMessage {
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
    sessionId: sid,
    userType: 'zai',
    isSidechain: false,
  }
}

const okCaller = (summary: string) =>
  (async function* () {
    yield { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } }
    yield { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: summary } }
    yield { type: 'message_stop' }
  }) as any

const failingCaller = (() => {
  throw new Error('mock modelCaller unavailable')
}) as any

async function main() {
  const dataDir = mkdtempSync(join(tmpdir(), 'zai-smoke-autocompact-'))
  process.env.ZAI_DATA_DIR = dataDir
  console.log(`[smoke] data dir: ${dataDir}`)

  try {
    section('1. happy path: 3 条消息 + forceReason=message-count → compact 成功')
    const msgs = [
      makeMsg('hi', 'user'),
      makeMsg('hello', 'assistant'),
      makeMsg('how are you', 'user'),
    ]
    const ctx = {
      options: { mainLoopModel: 'MiniMax-M3' },
      abortController: new AbortController(),
      modelCaller: okCaller('对话摘要:用户打招呼,助手回应。'),
    } as any
    const cacheSafeParams = { systemPrompt: '', userContext: {}, systemContext: {}, toolUseContext: {}, forkContextMessages: msgs } as any
    const tracking = { compacted: false, turnCounter: 0, turnId: 't1', forceReason: 'message-count' as const }

    const r1 = await autoCompactIfNeeded(msgs, ctx, cacheSafeParams, 'repl_main_thread', { ...tracking }, 0, Date.now())
    console.log(`[smoke] r1: wasCompacted=${r1.wasCompacted} consecutiveFailures=${r1.consecutiveFailures}`)
    if (!r1.wasCompacted) throw new Error('r1 should have compacted')
    if (r1.consecutiveFailures !== 0) throw new Error('r1 should reset consecutiveFailures')

    section('2. logEvent JSONL: 读 ~/.zai/logs/compact.jsonl')
    const logPath = join(dataDir, 'logs', 'compact.jsonl')
    if (!existsSync(logPath)) throw new Error('log file not created')
    const entries = readCompactLog()
    const okEntries = entries.filter((e) => e.trigger === 'auto')
    console.log(`[smoke] log entries (trigger=auto): ${okEntries.length}`)
    if (okEntries.length < 1) throw new Error('expected at least 1 auto log entry')
    const lastOk = okEntries[okEntries.length - 1]!
    console.log(`[smoke] last ok entry: circuitBreaker=${lastOk.circuitBreakerState} error=${lastOk.error}`)
    if (lastOk.error !== null) throw new Error('happy path should not have error')
    if (lastOk.circuitBreakerState !== 'closed') throw new Error('happy path should be closed')

    section('3. 失败路径: 缺 modelCaller + consecutiveFailures=2 → 第 3 次失败触发 cooldown')
    // 用同一个 msgs(forceReason 一次性消费,所以 tracking 现在是空的)
    const failTracking = {
      compacted: false,
      turnCounter: 0,
      turnId: 't-fail',
      consecutiveFailures: 2,
      forceReason: 'message-count' as const,
    }
    const failCtx = {
      options: { mainLoopModel: 'MiniMax-M3' },
      abortController: new AbortController(),
      // 不传 modelCaller → compactConversation 抛错 → catch 路径
    } as any

    const r2 = await autoCompactIfNeeded(msgs, failCtx, cacheSafeParams, 'repl_main_thread', { ...failTracking }, 0, Date.now())
    console.log(`[smoke] r2: wasCompacted=${r2.wasCompacted} consecutiveFailures=${r2.consecutiveFailures} tripped=${r2.circuitBreakerTripped}`)
    if (r2.wasCompacted) throw new Error('r2 should fail (no modelCaller)')
    if (r2.consecutiveFailures !== MAX_CONSECUTIVE_AUTOCOMPACT_FAILURES) {
      throw new Error(`r2 should hit MAX=${MAX_CONSECUTIVE_AUTOCOMPACT_FAILURES}, got ${r2.consecutiveFailures}`)
    }
    if (!r2.circuitBreakerTripped) throw new Error('r2 should trip circuit breaker')
    if (typeof r2.nextRetryAtMs !== 'number') throw new Error('r2 should set nextRetryAtMs')

    section('4. logEvent 失败 entry: circuitBreaker=open + error 非空')
    const entriesAfterFail = readCompactLog()
    const failEntries = entriesAfterFail.filter((e) => e.trigger === 'auto' && e.error !== null)
    console.log(`[smoke] fail entries: ${failEntries.length}`)
    if (failEntries.length < 1) throw new Error('expected fail log entry')
    const lastFail = failEntries[failEntries.length - 1]!
    console.log(`[smoke] last fail entry: circuitBreaker=${lastFail.circuitBreakerState} err="${lastFail.error?.slice(0, 50)}"`)
    if (lastFail.circuitBreakerState !== 'open') throw new Error('after trip should be open')

    section('5. circuit breaker 拦第 4 次: nextRetryAtMs 远未到 → skip')
    // 用 trip 后的 tracking 状态(连续失败 3 + nextRetryAtMs 在未来)再调
    const skipTracking = {
      compacted: false,
      turnCounter: 0,
      turnId: 't-skip',
      consecutiveFailures: 3,
      nextRetryAtMs: Date.now() + 600_000, // 10 分钟后才允许试
      forceReason: 'message-count' as const,
    }
    // 注意: 即使 forceReason 也会先被 shouldAutoCompact 放行,但 resolveAutoCompactCircuitBreakerState
    // 应该直接 return { action: 'skip' } — 这就是 breaker 的本质
    const r3 = await autoCompactIfNeeded(msgs, ctx, cacheSafeParams, 'repl_main_thread', { ...skipTracking }, 0, Date.now())
    console.log(`[smoke] r3: wasCompacted=${r3.wasCompacted} circuitBreakerActive=${r3.circuitBreakerActive}`)
    if (r3.wasCompacted) throw new Error('r3 should be blocked by circuit breaker')
    if (!r3.circuitBreakerActive) throw new Error('r3 should report circuitBreakerActive=true')

    section('✅ autoCompact 全部 E2E 通过')
    console.log('  - happy path (forceReason) → wasCompacted=true: ✅')
    console.log('  - logEvent 写成功 JSONL + circuitBreaker=closed: ✅')
    console.log('  - 第 N 次失败 → 触发 cooldown + trip: ✅')
    console.log('  - logEvent 失败 entry + circuitBreaker=open + error 非空: ✅')
    console.log('  - circuit breaker 拦后续调用: ✅')
  } finally {
    rmSync(dataDir, { recursive: true, force: true })
    console.log(`\n[smoke] cleaned up ${dataDir}`)
  }
}

main().catch((err) => {
  console.error('[smoke] ❌ FAIL:', err)
  process.exit(1)
})