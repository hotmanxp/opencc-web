import { describe, it, expect, beforeEach } from 'vitest'
import {
  AgentRegistryImpl,
  UnknownAgentError,
} from '../../src/opencc-src/server/agentRegistry.js'

describe('AgentRegistry sessionBindings', () => {
  let r: AgentRegistryImpl
  beforeEach(() => {
    r = new AgentRegistryImpl()
    r.loadBuiltinAgents()
  })

  it('registryAgent 注册后 getBoundAgentId 返回 agentId', () => {
    r.registryAgent('s1', 'default')
    expect(r.getBoundAgentId('s1')).toBe('default')
  })

  it('registryAgent 未知 agentId 抛 UnknownAgentError', () => {
    expect(() => r.registryAgent('s1', 'nonexistent')).toThrow(UnknownAgentError)
  })

  it('registryAgent 重复同 (sid, agentId) 幂等', () => {
    r.registryAgent('s1', 'default')
    r.registryAgent('s1', 'default')
    expect(r.getBoundAgentId('s1')).toBe('default')
  })

  it('registryAgent 同 sid 不同 agentId 覆盖', () => {
    r.registryAgent('s1', 'default')
    r.registryAgent('s1', 'office')
    expect(r.getBoundAgentId('s1')).toBe('office')
  })

  it('unregistryAgent 后 getBoundAgentId 返回 undefined', () => {
    r.registryAgent('s1', 'default')
    r.unregistryAgent('s1')
    expect(r.getBoundAgentId('s1')).toBeUndefined()
  })

  it('unregistryAgent 未注册 sid 无抛', () => {
    expect(() => r.unregistryAgent('nope')).not.toThrow()
  })

  it('clear 清 sessionBindings 但保留 agents', () => {
    r.registryAgent('s1', 'default')
    r.clear()
    expect(r.getBoundAgentId('s1')).toBeUndefined()
    expect(r.hasAgent('default')).toBe(true)
  })

  it('并发 100 次 registryAgent 同 sid 不死锁', async () => {
    const ps = Array.from({ length: 100 }, () =>
      Promise.resolve().then(() => r.registryAgent('s1', 'default')),
    )
    await Promise.all(ps)
    expect(r.getBoundAgentId('s1')).toBe('default')
  })
})
