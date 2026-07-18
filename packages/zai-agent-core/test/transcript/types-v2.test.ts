import { describe, expect, it } from 'vitest'
import { ContentBlockSchema, TranscriptMessageSchema, LegacyTranscriptError } from '../../src/transcript/types.js'

describe('v2 schema', () => {
  it('ContentBlockSchema accepts a tool_use block', () => {
    const block = { type: 'tool_use', id: 'tu_1', name: 'Bash', input: { cmd: 'ls' } }
    expect(ContentBlockSchema.parse(block).type).toBe('tool_use')
  })

  it('ContentBlockSchema accepts a tool_result block with is_error=true', () => {
    const block = { type: 'tool_result', tool_use_id: 'tu_1', content: 'oops', is_error: true }
    const parsed = ContentBlockSchema.parse(block)
    expect(parsed.is_error).toBe(true)
  })

  it('TranscriptMessageSchema requires cwd + userType + sessionId + version=2', () => {
    const msg = {
      uuid: 'u1', parentUuid: null, type: 'tool_use', timestamp: 1,
      message: { content: [{ type: 'tool_use', id: 'tu_1', name: 'Bash', input: {} }] },
      cwd: '/x', userType: 'zai', sessionId: 'sess-1', version: '2', isSidechain: false,
    }
    expect(TranscriptMessageSchema.parse(msg).version).toBe('2')
  })

  it('LegacyTranscriptError is an Error subclass with name=LegacyTranscriptError', () => {
    const err = new LegacyTranscriptError('v1')
    expect(err).toBeInstanceOf(Error)
    expect(err.name).toBe('LegacyTranscriptError')
  })
})
