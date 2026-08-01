import { afterEach, describe, expect, it } from 'bun:test'
import { isManagedChild, sendToSupervisor, onSupervisorMessage } from '../../src/cli/managedChild.js'

afterEach(() => {
  delete process.env.ZAI_SUPERVISOR_PID
})

describe('managedChild', () => {
  it('isManagedChild returns true when ZAI_SUPERVISOR_PID is set', () => {
    process.env.ZAI_SUPERVISOR_PID = '1234'
    expect(isManagedChild()).toBe(true)
  })

  it('isManagedChild returns false when ZAI_SUPERVISOR_PID is unset', () => {
    expect(isManagedChild()).toBe(false)
  })

  it('sendToSupervisor returns false when not managed', () => {
    expect(sendToSupervisor({ type: 'ready', pid: 1, port: 1 })).toBe(false)
  })

  it('onSupervisorMessage registers and returns unsubscribe', () => {
    let calls = 0
    const off = onSupervisorMessage(() => calls++)
    expect(typeof off).toBe('function')
    off()
  })
})
