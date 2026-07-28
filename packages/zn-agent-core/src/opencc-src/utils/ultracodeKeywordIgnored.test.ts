import { describe, test, expect, mock } from 'bun:test'

import {
  isUltracodeKeywordIgnored,
  KEYWORD_IGNORED_TEXT,
  KEYWORD_IGNORED_UNDO_TEXT,
  logKeywordIgnoredDismissed,
  logKeywordIgnoredRestored,
} from './ultracodeKeywordIgnored.js'

describe('ultracodeKeywordIgnored', () => {
  test('KEYWORD_IGNORED_TEXT is verbatim from upstream v2.1.177', () => {
    expect(KEYWORD_IGNORED_TEXT).toBe('Ultracode keyword ignored for this prompt')
    expect(KEYWORD_IGNORED_UNDO_TEXT).toBe(' to undo')
  })

  test('returns false when trigger is disabled', () => {
    expect(isUltracodeKeywordIgnored('tell me about ultracode', 'ultracode', false, false)).toBe(false)
  })

  test('returns false when triggered is true', () => {
    expect(isUltracodeKeywordIgnored('ultracode fix bug', 'ultracode', true, true)).toBe(false)
  })

  test('returns false when keyword is not in input', () => {
    expect(isUltracodeKeywordIgnored('hello world', 'ultracode', true, false)).toBe(false)
  })

  test('returns true when keyword is present but trigger did not match', () => {
    expect(isUltracodeKeywordIgnored('tell me about ultracode', 'ultracode', true, false)).toBe(true)
  })

  test('case-insensitive match for keyword in input', () => {
    expect(isUltracodeKeywordIgnored('tell me about ULTRACODE', 'ultracode', true, false)).toBe(true)
  })

  test('case-insensitive match when input is lowercase and keyword is uppercase', () => {
    expect(isUltracodeKeywordIgnored('tell me about ultracode', 'ULTRACODE', true, false)).toBe(true)
  })

  describe('analytics telemetry', () => {
    test('logKeywordIgnoredDismissed emits tengu_workflow_keyword_dismissed', async () => {
      const calls: Array<{ name: string; meta: unknown }> = []
      mock.module('../services/analytics/index.js', () => ({
        logEvent: (name: string, meta: unknown) => {
          calls.push({ name, meta })
        },
      }))
      const mod = await import(`./ultracodeKeywordIgnored.js?ts=${Date.now()}-${Math.random()}`)
      mod.logKeywordIgnoredDismissed()
      const dismissCalls = calls.filter(c => c.name === 'tengu_workflow_keyword_dismissed')
      expect(dismissCalls.length).toBe(1)
      expect(dismissCalls[0]?.meta).toEqual({ keyword: 'ultracode' })
    })

    test('logKeywordIgnoredRestored emits tengu_workflow_keyword_restored', async () => {
      const calls: Array<{ name: string; meta: unknown }> = []
      mock.module('../services/analytics/index.js', () => ({
        logEvent: (name: string, meta: unknown) => {
          calls.push({ name, meta })
        },
      }))
      const mod = await import(`./ultracodeKeywordIgnored.js?ts=${Date.now()}-${Math.random()}`)
      mod.logKeywordIgnoredRestored()
      const restoreCalls = calls.filter(c => c.name === 'tengu_workflow_keyword_restored')
      expect(restoreCalls.length).toBe(1)
      expect(restoreCalls[0]?.meta).toEqual({ keyword: 'ultracode' })
    })
  })
})
