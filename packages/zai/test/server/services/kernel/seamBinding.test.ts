import { describe, expect, it } from 'vitest'
import { bindSeams } from '../../../../src/server/services/kernel/seamBinding.js'
import { SeamRegistry } from '../../../../src/server/services/kernel/seamRegistry.js'

describe('bindSeams', () => {
  it('registers subagent + jobs', () => {
    const reg = new SeamRegistry()
    bindSeams({
      registry: reg,
      ctx: { on: () => () => {}, get: () => undefined, subagents: {} } as never,
      eventBus: { emit: () => {} },
      getParentAgent: () => undefined,
    })
    expect(reg.has('subagent')).toBe(true)
    expect(reg.has('jobs')).toBe(true)
  })
})
