import { describe, it, expect } from 'vitest'
import {
  apply as applyOpencode,
  parseOpencodeConfig,
  safeParseOpencodeConfig,
  OpencodeProvider,
} from '../../../../src/compat/subagents/opencode/index.js'
import { SubagentRegistry } from '../../../../src/compat/subagents/registry.js'

describe('opencode/config.parseOpencodeConfig', () => {
  it('returns all defaults on empty input', () => {
    const cfg = parseOpencodeConfig({})
    expect(cfg.enabled).toBe(false)
    expect(cfg.command).toBe('opencode')
    expect(cfg.args).toEqual(['run', '--format', 'json'])
    expect(cfg.model).toBeUndefined()
    expect(cfg.env).toEqual({})
    expect(cfg.disposeGraceMs).toBe(3000)
  })

  it('accepts explicit overrides', () => {
    const cfg = parseOpencodeConfig({
      enabled: true,
      command: '/opt/opencode',
      args: ['run', '--format', 'json'],
      model: 'minimax-cn/MiniMax-M3',
      env: { OPENCODE_FOO: 'bar' },
      disposeGraceMs: 5000,
    })
    expect(cfg.enabled).toBe(true)
    expect(cfg.command).toBe('/opt/opencode')
    expect(cfg.model).toBe('minimax-cn/MiniMax-M3')
    expect(cfg.env.OPENCODE_FOO).toBe('bar')
    expect(cfg.disposeGraceMs).toBe(5000)
  })

  it('rejects a non-positive disposeGraceMs', () => {
    expect(() => parseOpencodeConfig({ disposeGraceMs: 0 })).toThrow()
  })
})

describe('opencode/config.safeParseOpencodeConfig', () => {
  it('falls back to defaults when input is invalid', () => {
    const cfg = safeParseOpencodeConfig({ disposeGraceMs: 'not-a-number' })
    expect(cfg.enabled).toBe(false)
    expect(cfg.command).toBe('opencode')
  })

  it('returns the parsed config when input is valid', () => {
    const cfg = safeParseOpencodeConfig({ enabled: true })
    expect(cfg.enabled).toBe(true)
  })
})

describe('opencode/provider descriptor', () => {
  it('is a non-inheriting, capability-free one-shot provider named opencode', () => {
    const provider = new OpencodeProvider(parseOpencodeConfig({ enabled: true }))
    expect(provider.name).toBe('opencode')
    expect(provider.inheritsParentContext).toBe(false)
    expect(provider.capabilities).toEqual({
      agentOptions: false,
      outputSchema: false,
      depthLimit: false,
      toolFilter: false,
      persona: false,
    })
    // Model-facing description is English prose, not a Chinese string.
    expect(provider.description).toMatch(/[a-z]/)
    expect(/[\u4e00-\u9fff]/.test(provider.description)).toBe(false)
  })
})

describe('opencode/apply (config-gated registration)', () => {
  it('is a no-op when config is undefined', () => {
    const registry = new SubagentRegistry()
    expect(applyOpencode(registry)).toBeUndefined()
    expect(registry.list()).not.toContain('opencode')
  })

  it('is a no-op when disabled', () => {
    const registry = new SubagentRegistry()
    const disposer = applyOpencode(registry, { enabled: false })
    expect(disposer).toBeUndefined()
    expect(registry.list()).not.toContain('opencode')
  })

  it('registers under "opencode" when enabled and returns a disposer', () => {
    const registry = new SubagentRegistry()
    const disposer = applyOpencode(registry, { enabled: true })
    expect(typeof disposer).toBe('function')
    expect(registry.list()).toContain('opencode')
    disposer!()
    expect(registry.list()).not.toContain('opencode')
  })
})
