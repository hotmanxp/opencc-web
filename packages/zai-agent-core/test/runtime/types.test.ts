import { describe, expect, test } from 'vitest'
import type { SandboxConfig, ModelCaller, AskRegistryLike, RuntimeConfig, QueryOptions } from '../../src/runtime/types.js'

describe('SandboxConfig / ModelCaller types', () => {
  test('SandboxConfig 必填字段可缺省', () => {
    const cfg: SandboxConfig = { executor: 'child_process', workdir: '/tmp' }
    expect(cfg.executor).toBe('child_process')
  })

  test('ModelCaller 是 async generator', async () => {
    const caller: ModelCaller = async function* () {
      yield { type: 'message_start', message: { id: 'm1' } }
    }
    const events: unknown[] = []
    for await (const e of caller({ model: 'm', systemPrompt: '', messages: [], tools: [], signal: new AbortController().signal })) {
      events.push(e)
    }
    expect(events).toHaveLength(1)
  })
})

describe('AskRegistryLike', () => {
  test('RuntimeConfig.askRegistry 字段可选', () => {
    const cfg: RuntimeConfig = { dataDir: '/d' }
    expect(cfg.askRegistry).toBeUndefined()
  })

  test('可以注入 askRegistry', () => {
    const registry: AskRegistryLike = {
      register: async () => ({ answers: { q1: 'yes' } }),
    }
    const cfg: RuntimeConfig = { dataDir: '/d', askRegistry: registry }
    expect(cfg.askRegistry).toBe(registry)
  })

  test('register 返回 Promise<AskUserAnswers>', async () => {
    const registry: AskRegistryLike = {
      register: async () => ({ answers: { q1: 'a' } }),
    }
    const result = await registry.register('t1', 's1', new AbortController().signal)
    expect(result.answers).toEqual({ q1: 'a' })
  })
})

describe('RuntimeConfig skill fields', () => {
  test('skillsDirs 可选', () => {
    const cfg: RuntimeConfig = { dataDir: '/tmp' }
    expect(cfg.skillsDirs).toBeUndefined()
  })

  test('enableSkillTool 默认未设置', () => {
    const cfg: RuntimeConfig = { dataDir: '/tmp', skillsDirs: ['/skills'] }
    expect(cfg.enableSkillTool).toBeUndefined()
  })

  test('enabledSkills 仍可作为 @deprecated 字段使用', () => {
    const cfg: RuntimeConfig = { dataDir: '/tmp', enabledSkills: ['pdf'] }
    expect(cfg.enabledSkills).toEqual(['pdf'])
  })
})

describe('QueryOptions skill fields', () => {
  test('skillsDirs 可选', () => {
    const opts: QueryOptions = { prompt: 'hi', cwd: '/tmp' }
    expect(opts.skillsDirs).toBeUndefined()
  })

  test('skillsDirs 与 RuntimeConfig.skillsDirs 不冲突', () => {
    const opts: QueryOptions = { prompt: 'hi', cwd: '/tmp', skillsDirs: ['/override'] }
    expect(opts.skillsDirs).toEqual(['/override'])
  })
})
