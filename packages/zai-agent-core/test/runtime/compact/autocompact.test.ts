import { describe, test, expect } from 'vitest'
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
      { compacted: false, turnCounter: 0, turnId: 't1', consecutiveFailures: 3, nextRetryAtMs: Date.now() + 600_000, forceReason: 'message-count' },
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

  test('autoCompactIfNeeded: 缺 modelCaller → catch 路径 + logEvent + 递增 consecutiveFailures', async () => {
    const msgs = [makeMsg('hi'), makeMsg('ok', 'assistant')]
    // tracking.consecutiveFailures = 2 + forceReason → 失败后应到 3,触发 cooldown
    const tracking = {
      compacted: false,
      turnCounter: 0,
      turnId: 't-trip',
      consecutiveFailures: 2,
      forceReason: 'message-count' as const,
    }
    const result = await autoCompactIfNeeded(
      msgs,
      { options: { mainLoopModel: 'MiniMax-M3' }, abortController: new AbortController() } as any,
      {} as any,
      'repl_main_thread',
      tracking,
      0,
      Date.now(),
    )
    expect(result.wasCompacted).toBe(false)
    expect(result.consecutiveFailures).toBe(3)
    expect(result.circuitBreakerTripped).toBe(true)
    expect(result.circuitBreakerActive).toBe(true)
    expect(result.nextRetryAtMs).toBeDefined()
  })
})