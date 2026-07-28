import { describe, expect, test } from 'bun:test'
import {
  buildYoloRejectionMessage,
  createUserMessage,
  deriveShortMessageId,
  deriveUUID,
  extractTag,
  getMessagesAfterCompactBoundary,
  isClassifierDenial,
  isCompactBoundaryMessage,
  isNotEmptyMessage,
  isSyntheticMessage,
} from './messages.js'
import type { Message } from '../types/message.js'

const UUID_A = 'a1b2c3d4-0000-0000-0000-000000000099'
const UUID_B = 'b2c3d4e5-0000-0000-0000-000000000088'

describe('deriveShortMessageId', () => {
  test('returns 6-char base36 representation of first 10 hex chars', () => {
    const uuid = '12345678-1234-1234-1234-123456789abc'
    const id = deriveShortMessageId(uuid)
    expect(typeof id).toBe('string')
    expect(id.length).toBeLessThanOrEqual(6)
    expect(id).toMatch(/^[0-9a-z]+$/)
  })

  test('strips dashes before slicing', () => {
    const withDashes = 'aaaaaaaa-0000-0000-0000-000000000001'
    const withoutDashes = 'aaaaaaaa000000000000000000000001'
    expect(deriveShortMessageId(withDashes)).toBe(
      deriveShortMessageId(withoutDashes),
    )
  })

  test('different UUIDs produce different short ids (no collision for the first 10 hex chars)', () => {
    expect(deriveShortMessageId(UUID_A)).not.toBe(deriveShortMessageId(UUID_B))
  })
})

describe('deriveUUID', () => {
  test('preserves the first 24 chars of the parent UUID', () => {
    const out = deriveUUID(UUID_A, 1)
    expect(out.slice(0, 24)).toBe(UUID_A.slice(0, 24))
  })

  test('appends a 12-char zero-padded hex index', () => {
    expect(deriveUUID(UUID_A, 0) as string).toBe(UUID_A.slice(0, 24) + '000000000000')
    expect(deriveUUID(UUID_A, 1) as string).toBe(UUID_A.slice(0, 24) + '000000000001')
    expect(deriveUUID(UUID_A, 255) as string).toBe(UUID_A.slice(0, 24) + '0000000000ff')
  })

  test('different indices produce different UUIDs', () => {
    expect(deriveUUID(UUID_A, 0)).not.toBe(deriveUUID(UUID_A, 1))
  })
})

describe('extractTag', () => {
  test('returns the inner content of a simple tag', () => {
    expect(extractTag('<foo>hello</foo>', 'foo')).toBe('hello')
  })

  test('returns the inner content of a tag with attributes', () => {
    expect(extractTag('<foo class="x">hello</foo>', 'foo')).toBe('hello')
  })

  test('returns content of the outer tag when nested', () => {
    // Outer match captures only the immediate inner text (the function
    // returns inner content of the top-level tag, not including the closing
    // sibling tag). Document the actual behavior here.
    expect(extractTag('<foo><foo>inner</foo></foo>', 'foo')).toBe('<foo>inner')
  })

  test('returns the first match for multiple sibling tags', () => {
    expect(extractTag('<foo>a</foo><foo>b</foo>', 'foo')).toBe('a')
  })

  test('handles multiline content', () => {
    expect(extractTag('<foo>line1\nline2</foo>', 'foo')).toBe('line1\nline2')
  })

  test('returns null when no match', () => {
    expect(extractTag('<bar>x</bar>', 'foo')).toBeNull()
  })

  test('returns null on empty input or empty tag name', () => {
    expect(extractTag('', 'foo')).toBeNull()
    expect(extractTag('<foo></foo>', '')).toBeNull()
  })
})

describe('isNotEmptyMessage', () => {
  test('returns true for progress messages regardless of content', () => {
    const m = {
      type: 'progress',
      uuid: UUID_A,
      toolUseID: 't1',
      content: { type: 'agent_progress', agentId: 'a' },
    }
    expect(isNotEmptyMessage(m as any)).toBe(true)
  })

  test('returns true for attachment and system messages', () => {
    const a = { type: 'attachment', uuid: UUID_A } as any
    const s = { type: 'system', uuid: UUID_A, subtype: 'foo' } as any
    expect(isNotEmptyMessage(a)).toBe(true)
    expect(isNotEmptyMessage(s)).toBe(true)
  })

  test('returns true for user message with non-empty string content', () => {
    const m = { ...createUserMessage({ content: 'hello' }), uuid: UUID_A }
    expect(isNotEmptyMessage(m as Message)).toBe(true)
  })

  test('returns false for user message with whitespace-only content', () => {
    const m = { ...createUserMessage({ content: '   \n  ' }), uuid: UUID_A }
    expect(isNotEmptyMessage(m as Message)).toBe(false)
  })
})

describe('isClassifierDenial', () => {
  test('returns true when content starts with the AUTO_MODE_REJECTION_PREFIX', () => {
    expect(
      isClassifierDenial(
        'Permission for this action has been denied. Reason: too risky',
      ),
    ).toBe(true)
  })

  test('returns false for unrelated content', () => {
    expect(isClassifierDenial('Tool ran successfully')).toBe(false)
  })
})

describe('buildYoloRejectionMessage', () => {
  test('includes the reason and prefix', () => {
    const out = buildYoloRejectionMessage('file is too large')
    expect(out).toContain('Permission for this action has been denied. Reason: file is too large')
  })

  test('suggests permission rules', () => {
    const out = buildYoloRejectionMessage('too risky')
    expect(out).toContain('permission')
    expect(out).toContain('settings')
  })

  test('encourages continuing with other tasks', () => {
    const out = buildYoloRejectionMessage('blocked')
    expect(out.toLowerCase()).toContain('continue')
  })
})

describe('isSyntheticMessage', () => {
  test('returns true for synthetic user messages', () => {
    // SYNTHETIC_MESSAGES is the set of known synthetic markers. The function
    // requires content to be a non-empty array with a leading text block.
    const m = {
      ...createUserMessage({
        content: [{ type: 'text', text: '[Request interrupted by user]' }],
      }),
      uuid: UUID_A,
    }
    expect(isSyntheticMessage(m as Message)).toBe(true)
  })

  test('returns false for plain user messages', () => {
    const m = { ...createUserMessage({ content: 'hi' }), uuid: UUID_A }
    expect(isSyntheticMessage(m as Message)).toBe(false)
  })

  test('returns false for progress messages even if content matches', () => {
    const m = {
      type: 'progress',
      uuid: UUID_A,
      toolUseID: 't1',
      content: 'progress',
    }
    expect(isSyntheticMessage(m as any)).toBe(false)
  })
})

describe('isCompactBoundaryMessage', () => {
  test('returns true for a compact_boundary system message', () => {
    const m = {
      type: 'system',
      subtype: 'compact_boundary',
      uuid: UUID_A,
      content: 'summary',
    } as any
    expect(isCompactBoundaryMessage(m)).toBe(true)
  })

  test('returns false for non-system messages', () => {
    const m = { ...createUserMessage({ content: 'hi' }), uuid: UUID_A }
    expect(isCompactBoundaryMessage(m as Message)).toBe(false)
  })

  test('returns false for system messages with different subtypes', () => {
    const m = {
      type: 'system',
      subtype: 'other',
      uuid: UUID_A,
      content: 'x',
    } as any
    expect(isCompactBoundaryMessage(m)).toBe(false)
  })
})

describe('getMessagesAfterCompactBoundary', () => {
  function userMsg(content: string): Message {
    return { ...createUserMessage({ content }), uuid: UUID_A } as Message
  }

  function boundary(): Message {
    return {
      type: 'system',
      subtype: 'compact_boundary',
      uuid: UUID_A,
      content: 'summary',
    } as any
  }

  test('returns all messages when there is no boundary', () => {
    const msgs = [userMsg('a'), userMsg('b')]
    const out = getMessagesAfterCompactBoundary(msgs)
    expect(out.length).toBe(2)
  })

  test('slices to messages after the last boundary (inclusive)', () => {
    const msgs = [userMsg('a'), boundary(), userMsg('b'), userMsg('c')]
    const out = getMessagesAfterCompactBoundary(msgs)
    expect(out.length).toBe(3)
    expect((out[0] as any).subtype).toBe('compact_boundary')
    expect((out[1] as any).message.content).toBe('b')
    expect((out[2] as any).message.content).toBe('c')
  })

  test('uses only the last boundary when multiple exist', () => {
    const msgs = [
      userMsg('a'),
      boundary(),
      userMsg('b'),
      boundary(),
      userMsg('c'),
    ]
    const out = getMessagesAfterCompactBoundary(msgs)
    // slice(boundaryIndex=3) of 5-element array = 2 items: [boundary, 'c']
    expect(out.length).toBe(2)
    expect((out[0] as any).subtype).toBe('compact_boundary')
    expect((out[1] as any).message.content).toBe('c')
  })

  test('includeSnipped: true bypasses runtime snip projection (default-true flag means default path runs projectSnippedView)', () => {
    // Default-true HISTORY_SNIP means getMessagesAfterCompactBoundary will
    // call require('../services/compact/snipProjection.js') at runtime.
    // We only verify the includeSnipped bypass path doesn't throw — we don't
    // need to assert the exact projected shape here (covered by
    // snipProjection.test.ts).
    const msgs = [userMsg('a'), boundary(), userMsg('b')]
    const out = getMessagesAfterCompactBoundary(msgs, {
      includeSnipped: true,
    })
    expect(Array.isArray(out)).toBe(true)
    // slice(boundaryIndex=1) of 3-element array = 2 items: [boundary, 'b']
    expect(out.length).toBe(2)
  })
})