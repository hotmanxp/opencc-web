// @ts-nocheck
import { describe, expect, it } from 'bun:test'

import { buildKeywordTurnRequest } from './ultracode.ts'

const UPSTREAM_VERBATIM_REMINDER =
  'The user included the keyword "ultracode", opting this turn into multi-agent orchestration — use the Workflow tool to fulfill the request.'

describe('buildKeywordTurnRequest', () => {
  describe('when trigger.triggered === true', () => {
    it('returns trigger.rest as userInput (no system-reminder prefix)', () => {
      const trigger = { triggered: true, keyword: 'ultracode', rest: 'fix the bug' }
      const result = buildKeywordTurnRequest('ultracode fix the bug', trigger)
      expect(result.userInput).toBe('fix the bug')
    })

    it('returns verbatim upstream reminder as metaMessages with isMeta: true', () => {
      const trigger = { triggered: true, keyword: 'ultracode', rest: 'fix the bug' }
      const result = buildKeywordTurnRequest('ultracode fix the bug', trigger)
      expect(result.metaMessages).toHaveLength(1)
      // Use createUserMessage's UserMessage shape: {type, message:{role, content}, isMeta, ...}
      // (not the hand-rolled {type, content, isMeta} which crashes normalizeMessages
      // because it lacks the message wrapper, see commit fixing runtime crash.)
      expect(result.metaMessages[0].type).toBe('user')
      expect(result.metaMessages[0].isMeta).toBe(true)
      expect(result.metaMessages[0].message.role).toBe('user')
      expect(result.metaMessages[0].message.content).toEqual([
        { type: 'text', text: UPSTREAM_VERBATIM_REMINDER },
      ])
    })

    it('uses the detected keyword in the reminder text', () => {
      const trigger = { triggered: true, keyword: 'ultracode', rest: 'do something' }
      const result = buildKeywordTurnRequest('ultracode do something', trigger)
      expect(result.metaMessages[0].message.content[0].text).toContain('"ultracode"')
    })
  })

  describe('when trigger.triggered === false', () => {
    it('returns input unchanged as userInput', () => {
      const trigger = { triggered: false, keyword: 'ultracode', rest: 'fix the bug' }
      const result = buildKeywordTurnRequest('fix the bug', trigger)
      expect(result.userInput).toBe('fix the bug')
    })

    it('returns empty metaMessages array', () => {
      const trigger = { triggered: false, keyword: 'ultracode', rest: 'fix the bug' }
      const result = buildKeywordTurnRequest('fix the bug', trigger)
      expect(result.metaMessages).toEqual([])
    })

    it('returns input unchanged when enabled=false (triggered=false case)', () => {
      const trigger = { triggered: false, keyword: 'ultracode', rest: 'ultracode fix the bug' }
      const result = buildKeywordTurnRequest('ultracode fix the bug', trigger)
      expect(result.userInput).toBe('ultracode fix the bug')
      expect(result.metaMessages).toEqual([])
    })
  })
})
