import { describe, expect, it } from 'bun:test'
import { loadTranscriptMessages } from '../../src/web/src/store/useAgentStore.js'

describe('loadTranscriptMessages (v2)', () => {
  it('emits tool_use:start for type=tool_use messages', () => {
    const msgs = loadTranscriptMessages('sess-1', [
      { uuid: 'u1', parentUuid: null, type: 'tool_use', timestamp: 1,
        message: { content: [{ type: 'tool_use', id: 'tu_1', name: 'Bash', input: { cmd: 'ls' } }] },
        cwd: '/x', userType: 'zai', sessionId: 'sess-1', version: '2', isSidechain: false },
    ])
    expect(msgs[0]?.type).toBe('tool_use:start')
    expect(msgs[0]?.toolUseId).toBe('tu_1')
  })

  it('upserts output + error onto tool_use when tool_result arrives', () => {
    const msgs = loadTranscriptMessages('sess-1', [
      { uuid: 'u1', parentUuid: null, type: 'tool_use', timestamp: 1,
        message: { content: [{ type: 'tool_use', id: 'tu_1', name: 'Bash', input: {} }] },
        cwd: '/x', userType: 'zai', sessionId: 'sess-1', version: '2', isSidechain: false },
      { uuid: 'u2', parentUuid: 'u1', type: 'user', timestamp: 2,
        message: { content: [{ type: 'tool_result', tool_use_id: 'tu_1', content: 'err', is_error: true }] },
        cwd: '/x', userType: 'zai', sessionId: 'sess-1', version: '2', isSidechain: false },
    ])
    expect(msgs).toHaveLength(1)
    expect(msgs[0]?.type).toBe('tool_use:error')
    expect(msgs[0]?.error).toBe('err')
  })

  it('emits assistant.thinking + assistant.text in order from ContentBlock[]', () => {
    const msgs = loadTranscriptMessages('sess-1', [
      { uuid: 'u1', parentUuid: null, type: 'assistant', timestamp: 1,
        message: { content: [{ type: 'thinking', thinking: 'hmm' }, { type: 'text', text: 'hi' }] },
        cwd: '/x', userType: 'zai', sessionId: 'sess-1', version: '2', isSidechain: false },
    ])
    expect(msgs.map(m => m.type)).toEqual(['assistant.thinking', 'assistant.text'])
  })
})
