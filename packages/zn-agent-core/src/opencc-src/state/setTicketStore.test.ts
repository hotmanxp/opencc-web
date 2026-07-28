import { describe, expect, test, beforeEach } from 'bun:test'
import { clearTicketId, getTicketId, setTicketId } from './setTicketStore.js'

describe('setTicketStore', () => {
  beforeEach(() => {
    clearTicketId()
  })

  test('initial state has null id', () => {
    expect(getTicketId()).toBeNull()
  })

  test('setTicketId stores a valid id', () => {
    setTicketId('HRMSV3-ZN-WEBSITE#668')
    expect(getTicketId()).toBe('HRMSV3-ZN-WEBSITE#668')
  })

  test('clearTicketId resets to null', () => {
    setTicketId('PROJ#1')
    clearTicketId()
    expect(getTicketId()).toBeNull()
  })

  test('clearTicketId is idempotent', () => {
    clearTicketId()
    clearTicketId()
    expect(getTicketId()).toBeNull()
  })

  test('setTicketId overwrites previous value', () => {
    setTicketId('PROJ#1')
    setTicketId('PROJ#2')
    expect(getTicketId()).toBe('PROJ#2')
  })
})
