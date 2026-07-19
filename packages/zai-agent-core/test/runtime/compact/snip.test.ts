import { describe, test, expect } from 'vitest'
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
