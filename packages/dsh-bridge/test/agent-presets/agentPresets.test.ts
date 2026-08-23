/**
 * dsh-agent-presets 装配 wiring 测试。
 *
 * 覆盖 (Phase 5P6+)：
 *   - `createDshRuntime()` 完成后 `ctx.get('agentPresets')` 可用
 *   - `agentPresets.list()` 至少返回 zai-shipped 的 'general-purpose' preset
 *   - `agentPresets.defaultId === 'general-purpose'`
 *   - `agentPresets.resolve('general-purpose')` 不抛(不 broken)
 *   - zai-shipped system root 在 `agent-presets/` 下,preset 路径可解析
 *
 * 不测 mount() 的子 scope 副作用(需要构造 agent factory)—— 那是
 * dsh-agent-presets 自己的 contract。zai-side 只验证 service 装载 +
 * 默认 preset 暴露正确。
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { tmpdir } from 'node:os'
import { mkdtempSync, rmSync, existsSync } from 'node:fs'
import { join, resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

import { createDshRuntime, type DshProviderProfile } from '../../src/createDshRuntime.js'

describe('dsh-agent-presets 装配', () => {
  const tmpDataDir = mkdtempSync(join(tmpdir(), 'dsh-bridge-presets-'))

  const provider: DshProviderProfile = {
    name: 'anthropic',
    baseURL: 'https://api.example.com/anthropic',
    apiKeyEnv: 'TEST_API_KEY',
    defaultReasoningEffort: 'off',
    models: ['fake-model'],
  }

  let handle: Awaited<ReturnType<typeof createDshRuntime>>

  beforeAll(async () => {
    process.env.TEST_API_KEY = 'test-key'
    handle = await createDshRuntime({
      dataDir: tmpDataDir,
      runtimeId: 'presets-test',
      defaultCwd: tmpDataDir,
      defaultModel: 'fake-model',
      providers: [provider],
    })
    await handle.start()
  }, 60_000)

  afterAll(async () => {
    await handle.shutdown()
    rmSync(tmpDataDir, { recursive: true, force: true })
  })

  it('ctx.agentPresets 已装载', () => {
    const agentPresets = handle.ctx.get('agentPresets')
    expect(agentPresets).toBeDefined()
    expect(typeof agentPresets.list).toBe('function')
    expect(typeof agentPresets.defaultId).toBe('string')
  })

  it('默认 preset id === "general-purpose"', () => {
    const agentPresets = handle.ctx.get('agentPresets') as { defaultId: string }
    expect(agentPresets.defaultId).toBe('general-purpose')
  })

  it('list() 至少包含 zai-shipped 的 general-purpose', async () => {
    const agentPresets = handle.ctx.get('agentPresets') as {
      list: () => Promise<Array<{ id: string; trust: string; path: string }>>
    }
    const presets = await agentPresets.list()
    expect(presets.length).toBeGreaterThanOrEqual(1)
    const general = presets.find((p) => p.id === 'general-purpose')
    expect(general).toBeDefined()
    expect(general!.trust).toBe('system')
    // AgentPreset.path 是 composition 文件路径(以 agent.cordis.yml 结尾),
    // 不是目录路径 — 但目录前缀应该命中 agent-presets/general-purpose/
    expect(general!.path).toMatch(/agent-presets[\\/]general-purpose[\\/]agent\.cordis\.yml$/)
  })

  it('resolve("general-purpose") 不抛错且返回 AgentPreset', async () => {
    const agentPresets = handle.ctx.get('agentPresets') as {
      resolve: (id?: string) => Promise<{ id: string; broken?: string }>
    }
    const resolved = await agentPresets.resolve('general-purpose')
    expect(resolved.id).toBe('general-purpose')
    expect(resolved.broken).toBeUndefined()
  })

  it('zai-shipped preset 目录存在且含 agent.cordis.yml + preset.yml', () => {
    // resolve 路径相对于 createDshRuntime.ts 源位置 — src/, build 后是 dist/。
    // 不依赖运行时分发路径,通过 import.meta.url 上溯到 package root。
    const here = dirname(fileURLToPath(import.meta.url))
    const presetRoot = resolve(here, '..', '..', 'agent-presets', 'general-purpose')
    expect(existsSync(join(presetRoot, 'agent.cordis.yml'))).toBe(true)
    expect(existsSync(join(presetRoot, 'preset.yml'))).toBe(true)
  })
})
