import { describe, it, expect } from 'vitest'
import {
  getAgentRegistry,
  AgentRegistryImpl,
} from '../../src/opencc-src/server/agentRegistry.js'

describe('agentRegistry exports', () => {
  it('getAgentRegistry 返回单例', () => {
    const a = getAgentRegistry()
    const b = getAgentRegistry()
    expect(a).toBe(b)
    expect(a).toBeInstanceOf(AgentRegistryImpl)
  })
})