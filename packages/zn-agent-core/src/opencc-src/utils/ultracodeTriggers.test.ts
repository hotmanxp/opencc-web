import { describe, expect, it } from 'bun:test'

import { findUltracodeTriggerPositions, isUltracodeKeywordTriggered } from './ultracode.js'

describe('findUltracodeTriggerPositions', () => {
  it('finds a leading ultracode keyword (case-insensitive)', () => {
    // 'ultracode' is 9 chars; `end` is exclusive.
    const positions = findUltracodeTriggerPositions('ultracode fix the bug')
    expect(positions).toHaveLength(1)
    expect(positions[0]).toMatchObject({ start: 0, end: 9 })
  })

  it('matches case-insensitively (ULTRAcode)', () => {
    // Mirror case-insensitive behavior of findKeywordTriggerPositions.
    // Note: 'ULTRA-CODE' (with hyphen) does NOT match because \bultracode\b
    // can't cross the non-word boundary; the keyword is literal 'ultracode'.
    const positions = findUltracodeTriggerPositions('please ULTRAcode this now')
    expect(positions).toHaveLength(1)
    expect(positions[0]?.start).toBe(7)
  })

  it('does NOT match ultra-code with hyphen (word boundary breaks)', () => {
    // Hyphen is a non-word char; the underlying \bultracode\b regex
    // doesn't cross it. The keyword is literal 'ultracode'.
    expect(findUltracodeTriggerPositions('please ULTRA-CODE this now')).toEqual([])
  })

  it('returns empty when no keyword', () => {
    expect(findUltracodeTriggerPositions('just fix the bug')).toEqual([])
  })

  it('skips /ultracode (slash command, not a keyword)', () => {
    // Mirrors findUltraplanTriggerPositions: slash commands route via
    // processSlashCommand, not the keyword detector.
    expect(findUltracodeTriggerPositions('/ultracode fix things')).toEqual([])
  })

  it('skips ultracode in a path-like context (src/ultracode/foo.ts)', () => {
    expect(findUltracodeTriggerPositions('see src/ultracode/foo.ts')).toEqual([])
  })

  it('skips ultracode? (question about the feature)', () => {
    expect(findUltracodeTriggerPositions('what does ultracode?')).toEqual([])
  })

  it('skips ultracode inside backticks', () => {
    expect(findUltracodeTriggerPositions('look at `ultracode` docs')).toEqual([])
  })

  it('finds multiple occurrences', () => {
    // 'ultracode one ultracode two'
    //  0         1
    //  0123456789012345678901234567
    //  second 'ultracode' starts at index 14
    const positions = findUltracodeTriggerPositions('ultracode one ultracode two')
    expect(positions).toHaveLength(2)
    expect(positions[0]?.start).toBe(0)
    expect(positions[1]?.start).toBe(14)
  })
})

describe('isUltracodeKeywordTriggered', () => {
  it('is true when findUltracodeTriggerPositions returns any position', () => {
    expect(isUltracodeKeywordTriggered('ultracode do thing')).toBe(true)
  })
  it('is false when no keyword', () => {
    expect(isUltracodeKeywordTriggered('just do thing')).toBe(false)
  })
  it('respects /ultracode exclusion', () => {
    expect(isUltracodeKeywordTriggered('/ultracode do thing')).toBe(false)
  })
})