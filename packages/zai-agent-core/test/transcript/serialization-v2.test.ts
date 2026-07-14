import { describe, expect, it } from 'bun:test'
import { serializeFile, deserializeFile } from '../../src/transcript/serialization.js'
import { LegacyTranscriptError } from '../../src/transcript/types.js'

const sampleFile = {
  version: 2 as const,
  transcriptId: 'sess-1',
  meta: { cwd: '/x', model: 'm', createdAt: 1, updatedAt: 2 },
  messages: [
    {
      uuid: 'u1',
      parentUuid: null,
      type: 'user' as const,
      timestamp: 1,
      message: { content: 'hi', role: 'user' as const },
      cwd: '/x',
      userType: 'zai',
      sessionId: 'sess-1',
      version: '2' as const,
      isSidechain: false,
    },
  ],
}

describe('serialization v2', () => {
  it('round-trips a v2 file', () => {
    const raw = serializeFile(sampleFile)
    const back = deserializeFile(raw)
    expect(back.messages[0].message.content).toBe('hi')
  })

  it('deserializeFile throws LegacyTranscriptError on v1', () => {
    const v1Raw = JSON.stringify({
      ...sampleFile,
      version: 1,
      messages: [{ uuid: 'u1', parentUuid: null, type: 'user', timestamp: 1, raw: { content: 'hi' } }],
    })
    expect(() => deserializeFile(v1Raw)).toThrow(LegacyTranscriptError)
  })

  it('deserializeFile throws SyntaxError on malformed v2', () => {
    expect(() => deserializeFile('{not-json')).toThrow()
  })
})
