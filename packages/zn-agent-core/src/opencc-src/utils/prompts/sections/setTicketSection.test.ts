import { describe, expect, test, beforeEach } from 'bun:test'
import { createSetTicketSection } from './setTicketSection.ts'
import { clearTicketId, setTicketId } from '../../../state/setTicketStore.js'

describe('setTicketSection', () => {
  beforeEach(() => {
    clearTicketId()
  })

  test('returns null when no id is set', () => {
    const section = createSetTicketSection()
    expect(section.compute()).toBeNull()
  })

  test('returns a string containing the id when set', () => {
    setTicketId('HRMSV3-ZN-WEBSITE#668')
    const section = createSetTicketSection()
    const result = section.compute()
    expect(typeof result).toBe('string')
    expect(result).toContain('HRMSV3-ZN-WEBSITE#668')
  })

  test('section name is set_ticket', () => {
    const section = createSetTicketSection()
    expect(section.name).toBe('set_ticket')
  })

  test('cacheBreak is false (cacheable: prompt-cache friendly)', () => {
    const section = createSetTicketSection()
    expect(section.cacheBreak).toBe(false)
  })

  test('section is in english for LLM consumption', () => {
    setTicketId('ZN-INTERNATIONAL#801')
    const section = createSetTicketSection()
    expect(section.compute()).toContain('ZN-INTERNATIONAL#801')
    expect(section.compute()).toContain('Prefix')
  })

  test('mentions /set-ticket clear command', () => {
    setTicketId('PROJ#42')
    const section = createSetTicketSection()
    expect(section.compute()).toContain('/set-ticket clear')
  })

  test('contains commit prefix example', () => {
    setTicketId('ZN-INTERNATIONAL#801')
    const section = createSetTicketSection()
    expect(section.compute()).toContain('ZN-INTERNATIONAL#801 feat(login): xxx')
  })
})
