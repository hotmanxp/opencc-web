import { describe, expect, it, mock } from 'bun:test'
import { createRestartHooks } from '../../src/server/services/restartHooks.js'

describe('restartHooks', () => {
  it('inFlightCount returns sum of agent and background', () => {
    const h = createRestartHooks({
      agentActive: () => 2,
      backgroundActive: () => 3,
      abortAgent: () => undefined,
      abortBackground: () => undefined,
    })
    expect(h.inFlightCount()).toBe(5)
  })

  it('abortAll returns total aborted across both subsystems', () => {
    const calls: string[] = []
    const h = createRestartHooks({
      agentActive: () => 1,
      backgroundActive: () => 1,
      abortAgent: () => calls.push('a'),
      abortBackground: () => calls.push('b'),
    })
    expect(h.abortAll()).toBe(2)
    expect(calls).toEqual(['a', 'b'])
  })
})
