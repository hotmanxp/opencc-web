import { describe, expect, it, beforeEach } from 'bun:test'
import {
  queueUltracodeReminder,
  ULTRACODE_EFFORT_ENTER_FULL,
  ULTRACODE_EFFORT_ENTER_SHORT,
  ULTRACODE_EFFORT_EXIT,
  resetUltracodeReminderState,
} from './ultracodeReminder.js'

describe('queueUltracodeReminder', () => {
  beforeEach(() => {
    // Reset module-level state before each test so they are independent
    resetUltracodeReminderState()
  })

  describe('enter', () => {
    it('first enter emits FULL text', () => {
      const result = queueUltracodeReminder('enter')
      expect(result).toEqual([ULTRACODE_EFFORT_ENTER_FULL])
    })

    it('second enter (while still on) emits SHORT text', () => {
      queueUltracodeReminder('enter') // first
      const result = queueUltracodeReminder('enter') // second
      expect(result).toEqual([ULTRACODE_EFFORT_ENTER_SHORT])
    })

    it('enter after exit emits FULL text again (full reset)', () => {
      queueUltracodeReminder('enter') // first
      queueUltracodeReminder('exit') // exit
      const result = queueUltracodeReminder('enter') // re-enter
      expect(result).toEqual([ULTRACODE_EFFORT_ENTER_FULL])
    })

    it('enter while already on is a no-op', () => {
      queueUltracodeReminder('enter') // first
      const result = queueUltracodeReminder('enter') // second - no-op
      expect(result).toEqual([ULTRACODE_EFFORT_ENTER_SHORT])
      // Calling again still returns short
      const result2 = queueUltracodeReminder('enter')
      expect(result2).toEqual([ULTRACODE_EFFORT_ENTER_SHORT])
    })
  })

  describe('exit', () => {
    it('exit after enter emits EXIT text and resets state', () => {
      queueUltracodeReminder('enter')
      const result = queueUltracodeReminder('exit')
      expect(result).toEqual([ULTRACODE_EFFORT_EXIT])
      // Next enter is full again
      const reenter = queueUltracodeReminder('enter')
      expect(reenter).toEqual([ULTRACODE_EFFORT_ENTER_FULL])
    })

    it('exit when already off is a no-op', () => {
      const result = queueUltracodeReminder('exit')
      expect(result).toEqual([])
    })
  })

  describe('verbatim upstream text', () => {
    it('ULTRACODE_EFFORT_ENTER_FULL matches upstream verbatim text', () => {
      expect(ULTRACODE_EFFORT_ENTER_FULL).toBe(
        'Ultracode is on: optimize for the most exhaustive, correct answer — not the fastest or cheapest. Use the Workflow tool on every substantive task; token cost is not a constraint. See the Workflow tool\u2019s **Ultracode** section and quality patterns. Solo only on conversational/trivial turns.',
      )
    })

    it('ULTRACODE_EFFORT_ENTER_SHORT matches upstream verbatim text', () => {
      expect(ULTRACODE_EFFORT_ENTER_SHORT).toBe(
        'Ultracode is still on — use the Workflow tool; see its Ultracode section.',
      )
    })

    it('ULTRACODE_EFFORT_EXIT matches upstream verbatim text', () => {
      expect(ULTRACODE_EFFORT_EXIT).toBe(
        'Ultracode is off — the Workflow tool\'s standard opt-in rule applies again.',
      )
    })
  })
})
