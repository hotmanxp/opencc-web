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
})