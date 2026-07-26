import { describe, test, expect } from 'vitest'
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
      { options: { mainLoopModel: 'MiniMax-M3' }, abortController: new AbortController(), modelCaller: mockModelCaller } as any,
      { systemPrompt: '', userContext: {}, systemContext: {}, toolUseContext: {} as any, forkContextMessages: [] } as any,
      true,
      undefined,
      false,
    )

    expect(result.summaryMessages.length).toBeGreaterThan(0)
    expect(result.boundaryMarker).toBeDefined()
  })

  // ---- 阶段 1 简化版的 throw 守卫分支(覆盖率补全) ----

  test('空 messages 抛 Not enough messages', async () => {
    await expect(
      compactConversation(
        [],
        { options: { mainLoopModel: 'MiniMax-M3' }, abortController: new AbortController() } as any,
        {} as any,
        true,
      ),
    ).rejects.toThrow(/Not enough messages/)
  })

  test('缺 modelCaller 抛 modelCaller is required', async () => {
    const messages = [
      { type: 'user', uuid: 'u1', parentUuid: null, timestamp: 1, raw: null, runtime: { turnIndex: 0 }, version: '2', message: { role: 'user', content: [{ type: 'text', text: 'hi' }] }, cwd: '/', sessionId: 's', userType: 'zai', isSidechain: false },
    ]
    await expect(
      compactConversation(
        messages,
        { options: { mainLoopModel: 'MiniMax-M3' }, abortController: new AbortController() } as any,
        {} as any,
        true,
      ),
    ).rejects.toThrow(/modelCaller is required/)
  })

  test('modelCaller 没吐 message_stop 抛 未收到 message_stop', async () => {
    // mock 只吐 start + delta,不发 message_stop
    const mockModelCaller = (async function* () {
      yield { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } }
      yield { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'partial' } }
      // 故意不发 message_stop → 触发 sawMessageStop = false 抛错
    }) as any

    const messages = [
      { type: 'user', uuid: 'u1', parentUuid: null, timestamp: 1, raw: null, runtime: { turnIndex: 0 }, version: '2', message: { role: 'user', content: [{ type: 'text', text: 'hi' }] }, cwd: '/', sessionId: 's', userType: 'zai', isSidechain: false },
    ]
    await expect(
      compactConversation(
        messages,
        { options: { mainLoopModel: 'MiniMax-M3' }, abortController: new AbortController(), modelCaller: mockModelCaller } as any,
        {} as any,
        true,
      ),
    ).rejects.toThrow(/未收到 message_stop/)
  })
})

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