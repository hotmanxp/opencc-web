import { describe, expect, test } from 'vitest'
import {
  serializeMessage,
  deserializeMessage,
  serializeFile,
  deserializeFile,
  extractMeta,
} from '../../src/transcript/serialization.js'
import type { TranscriptFile, TranscriptMessage } from '../../src/transcript/types.js'

describe('serialization', () => {
  test('message round-trip', () => {
    const msg: TranscriptMessage = {
      uuid: 'abc-123',
      parentUuid: null,
      type: 'user',
      timestamp: 1700000000000,
      raw: { content: 'hello' },
    }
    const json = serializeMessage(msg)
    const restored = deserializeMessage(json)
    expect(restored).toEqual(msg)
  })

  test('file round-trip', () => {
    const file: TranscriptFile = {
      version: 1,
      transcriptId: 'sess-xyz',
      meta: { cwd: '/test', model: 'gpt-4', createdAt: 1, updatedAt: 2 },
      messages: [],
    }
    const json = serializeFile(file)
    const restored = deserializeFile(json)
    expect(restored).toEqual(file)
  })

  test('deserializeFile throws on unknown version', () => {
    expect(() => deserializeFile(JSON.stringify({ version: 99 }))).toThrow('Unsupported transcript version')
  })

  test('extractMeta', () => {
    const file: TranscriptFile = {
      version: 1,
      transcriptId: 'sess-xyz',
      meta: { cwd: '/test', model: 'gpt-4', createdAt: 1, updatedAt: 2, title: 'my session' },
      messages: [{ uuid: 'a', parentUuid: null, type: 'user', timestamp: 1, raw: {} }],
    }
    const meta = extractMeta(file)
    expect(meta.messageCount).toBe(1)
    expect(meta.title).toBe('my session')
  })
})
