import { describe, it, expect, beforeEach } from 'vitest'
import {
  AgentRegistryImpl,
  AgentNotBoundError,
} from '../../src/opencc-src/server/agentRegistry.js'

describe('AgentRegistry.slot', () => {
  let r: AgentRegistryImpl
  beforeEach(() => {
    r = new AgentRegistryImpl()
  })

  it('未绑定 sid 抛 AgentNotBoundError', async () => {
    await expect(r.slot(['x'], 'systemPrompt', 'unbound')).rejects.toBeInstanceOf(
      AgentNotBoundError,
    )
  })

  it('agent 未实现 slotId → pass-through 原 origin', async () => {
    // 注入无 slots 的 agent
    ;(r as any).agents.set('noop', { name: 'noop', description: 'd', slots: {} })
    r.registryAgent('s1', 'noop')
    const out = await r.slot(['a', 'b'], 'tools', 's1')
    expect(out).toEqual(['a', 'b'])
  })

  it('agent 实现 slotId → 调 fn 并返回结果', async () => {
    ;(r as any).agents.set('ext', {
      name: 'ext',
      description: 'd',
      slots: {
        tools: (origin: string[]) => [...origin, 'extra'],
      },
    })
    r.registryAgent('s1', 'ext')
    const out = await r.slot(['a'], 'tools', 's1')
    expect(out).toEqual(['a', 'extra'])
  })

  it('fn 是 async 时 await 返回', async () => {
    ;(r as any).agents.set('async-ext', {
      name: 'async-ext',
      description: 'd',
      slots: {
        systemPrompt: async (origin: string[]) => {
          await new Promise((res) => setTimeout(res, 1))
          return [...origin, 'async-line']
        },
      },
    })
    r.registryAgent('s1', 'async-ext')
    const out = await r.slot(['base'], 'systemPrompt', 's1')
    expect(out).toEqual(['base', 'async-line'])
  })

  it('fn 抛错 → 原错误透传', async () => {
    ;(r as any).agents.set('thrower', {
      name: 'thrower',
      description: 'd',
      slots: {
        tools: () => {
          throw new Error('agent tools fail')
        },
      },
    })
    r.registryAgent('s1', 'thrower')
    await expect(r.slot([], 'tools', 's1')).rejects.toThrow('agent tools fail')
  })

  it('sessionId 透传给 slot fn', async () => {
    let captured: string | undefined
    ;(r as any).agents.set('spy', {
      name: 'spy',
      description: 'd',
      slots: {
        tools: (origin: string[], sid: string) => {
          captured = sid
          return origin
        },
      },
    })
    r.registryAgent('s1', 'spy')
    await r.slot([], 'tools', 's1')
    expect(captured).toBe('s1')
  })
})