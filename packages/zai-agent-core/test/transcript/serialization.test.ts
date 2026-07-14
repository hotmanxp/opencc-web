import { describe, expect, it } from 'bun:test'
import {
  serializeMessage,
  deserializeMessage,
  serializeFile,
  deserializeFile,
  extractMeta,
} from '../../src/transcript/serialization.js'
import { LegacyTranscriptError } from '../../src/transcript/types.js'
import type { TranscriptFile, TranscriptMessage } from '../../src/transcript/types.js'

const sampleMsg: TranscriptMessage = {
  uuid: 'abc-123',
  parentUuid: null,
  type: 'user',
  timestamp: 1700000000000,
  message: { content: 'hello', role: 'user' },
  cwd: '/home/user/project',
  userType: 'zai',
  sessionId: 'sess-abc',
  version: '2',
  isSidechain: false,
}

describe('serialization', () => {
  it('message round-trip', () => {
    const json = serializeMessage(sampleMsg)
    const restored = deserializeMessage(json)
    expect(restored).toEqual(sampleMsg)
    expect(restored.message.content).toBe('hello')
  })

  it('file round-trip', () => {
    const file: TranscriptFile = {
      version: 2,
      transcriptId: 'sess-xyz',
      meta: { cwd: '/test', model: 'gpt-4', createdAt: 1, updatedAt: 2 },
      messages: [sampleMsg],
    }
    const json = serializeFile(file)
    const restored = deserializeFile(json)
    expect(restored).toEqual(file)
    expect(restored.version).toBe(2)
    expect(restored.messages[0].message.content).toBe('hello')
  })

  it('deserializeFile throws LegacyTranscriptError on v1', () => {
    const v1Raw = JSON.stringify({
      version: 1,
      transcriptId: 'sess-xyz',
      meta: { cwd: '/test', model: 'gpt-4', createdAt: 1, updatedAt: 2 },
      messages: [{ uuid: 'a', parentUuid: null, type: 'user', timestamp: 1, raw: { content: 'hi' } }],
    })
    expect(() => deserializeFile(v1Raw)).toThrow(LegacyTranscriptError)
  })

  it('deserializeFile throws on unknown version', () => {
    expect(() => deserializeFile(JSON.stringify({ version: 99 }))).toThrow('Unsupported transcript version')
  })

  it('extractMeta', () => {
    const file: TranscriptFile = {
      version: 2,
      transcriptId: 'sess-xyz',
      meta: { cwd: '/test', model: 'gpt-4', createdAt: 1, updatedAt: 2, title: 'my session' },
      messages: [
        { ...sampleMsg, uuid: 'msg-a', message: { content: 'first', role: 'user' } },
        { ...sampleMsg, uuid: 'msg-b', message: { content: 'second', role: 'assistant' } },
      ],
    }
    const meta = extractMeta(file)
    expect(meta.version).toBe(2)
    expect(meta.messageCount).toBe(2)
    expect(meta.title).toBe('my session')
    expect(meta.transcriptId).toBe('sess-xyz')
  })
})
