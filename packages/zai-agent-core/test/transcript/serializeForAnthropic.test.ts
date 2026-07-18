import { describe, expect, it } from 'vitest'
import { serializeForAnthropic } from '../../src/transcript/persistence.js'
import type { TranscriptMessage } from '../../src/transcript/types.js'

const msg = (overrides: Partial<TranscriptMessage>): TranscriptMessage => ({
  uuid: 'u', parentUuid: null, timestamp: 1,
  cwd: '/x', userType: 'zai', sessionId: 's', version: '2', isSidechain: false,
  message: { content: '', role: 'user' },
  type: 'user',
  ...overrides,
})

describe('serializeForAnthropic', () => {
  it('groups tool_result blocks under one user role', () => {
    const tr1 = msg({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'a', content: 'ok', is_error: false }], role: 'user' } })
    const tr2 = msg({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'b', content: 'err', is_error: true }], role: 'user' } })
    const out = serializeForAnthropic([tr1, tr2])
    expect(out).toHaveLength(1)
    expect(out[0].role).toBe('user')
    expect((out[0].content as any[])).toHaveLength(2)
  })

  it('emits tool_use messages as assistant with the block array', () => {
    const tu = msg({
      type: 'tool_use',
      message: { content: [{ type: 'tool_use', id: 't1', name: 'Bash', input: {} }], role: 'assistant' },
    })
    const out = serializeForAnthropic([tu])
    expect(out[0].role).toBe('assistant')
    expect((out[0].content as any[])[0].id).toBe('t1')
  })

  it('passes user text through verbatim', () => {
    const out = serializeForAnthropic([msg({ message: { content: 'hello', role: 'user' } })])
    expect(out[0]).toEqual({ role: 'user', content: 'hello' })
  })

  it('skips system/attachment entries', () => {
    const out = serializeForAnthropic([
      msg({ type: 'system' }),
      msg({ type: 'attachment' }),
    ])
    expect(out).toHaveLength(0)
  })
})
