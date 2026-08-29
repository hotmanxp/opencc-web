import { describe, it, expect } from 'vitest'
import {
  AgentSlotId,
  AgentConfig,
  AgentRegistry,
  AgentRegistryError,
  UnknownAgentError,
  AgentNotBoundError,
  BuiltinAgentsLoadError,
} from '../../src/opencc-src/server/agentRegistry.js'

describe('agentRegistry types', () => {
  it('AgentSlotId 是三个 slot 的联合', () => {
    const ids: AgentSlotId[] = ['systemPrompt', 'tools', 'mcp']
    expect(ids).toHaveLength(3)
  })

  it('AgentConfig 接受可选 slots', () => {
    const c: AgentConfig = { name: 'a', description: 'd', slots: {} }
    expect(c.name).toBe('a')
    const c2: AgentConfig = {
      name: 'b',
      description: 'd',
      slots: {
        systemPrompt: (origin) => origin,
        tools: (origin) => origin,
        mcp: (origin) => origin,
      },
    }
    expect(typeof c2.slots.systemPrompt).toBe('function')
  })

  it('AgentRegistry 接口完整', () => {
    // 仅检查形状,运行时用空 stub
    const _stub: AgentRegistry = {
      loadBuiltinAgents: () => {},
      loadUserAgents: async () => ({ loaded: [], failed: [] }),
      registryAgent: () => {},
      unregistryAgent: () => {},
      slot: async <T>(origin: T) => origin,
      listAgents: () => [],
      hasAgent: () => false,
      resolveAgent: () => undefined,
      getBoundAgentId: () => undefined,
      clear: () => {},
    }
    expect(_stub).toBeDefined()
  })

  it('错误类继承与 code', () => {
    const a = new UnknownAgentError('x')
    expect(a).toBeInstanceOf(AgentRegistryError)
    expect(a).toBeInstanceOf(Error)
    expect(a.code).toBe('AGENT_UNKNOWN')
    const b = new AgentNotBoundError('s')
    expect(b.code).toBe('AGENT_NOT_BOUND')
    const c = new BuiltinAgentsLoadError()
    expect(c.code).toBe('AGENT_BUILTIN_LOAD_FAILED')
  })
})