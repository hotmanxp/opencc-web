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

  // M2: both tool_use code paths must emit eventId === msg.uuid (or fall back
  // to tool-${b.id} when uuid is missing) so cross-path de-duplication works.
  // Direct tool_use message path: msg.uuid === 'u1'.
  // Assistant-message tool_use block path: previously `tool-${b.id}`; now also
  // msg.uuid so the same uuid string lands in both branches' eventId.
  it('unifies eventId for tool_use across direct + assistant-block paths (M2)', () => {
    const msgs = loadTranscriptMessages('sess-1', [
      { uuid: 'u1', parentUuid: null, type: 'tool_use', timestamp: 1,
        message: { content: [{ type: 'tool_use', id: 'tu_1', name: 'Bash', input: {} }] },
        cwd: '/x', userType: 'zai', sessionId: 'sess-1', version: '2', isSidechain: false },
      { uuid: 'u2', parentUuid: null, type: 'assistant', timestamp: 2,
        message: { content: [{ type: 'tool_use', id: 'tu_1', name: 'Bash', input: {} }] },
        cwd: '/x', userType: 'zai', sessionId: 'sess-1', version: '2', isSidechain: false },
    ])
    expect(msgs).toHaveLength(2)
    // Direct path uses msg.uuid === 'u1'.
    expect(msgs[0]?.eventId).toBe('u1')
    // Assistant-block path also uses msg.uuid === 'u2' (not `tool-tu_1`).
    expect(msgs[1]?.eventId).toBe('u2')
  })

  it('falls back to tool-${b.id} when assistant-block msg.uuid is missing (M2)', () => {
    const msgs = loadTranscriptMessages('sess-1', [
      // uuid intentionally absent (defensive — every persisted v2 message
      // has uuid, but the fallback guards against missing-key shapes).
      { parentUuid: null, type: 'assistant', timestamp: 1,
        message: { content: [{ type: 'tool_use', id: 'tu_x', name: 'Bash', input: {} }] },
        cwd: '/x', userType: 'zai', sessionId: 'sess-1', version: '2', isSidechain: false } as any,
    ])
    expect(msgs[0]?.eventId).toBe('tool-tu_x')
  })
})
