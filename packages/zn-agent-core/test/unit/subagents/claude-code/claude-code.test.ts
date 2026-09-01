import { describe, it, expect } from 'vitest'
import {
  parseClaudeCodeConfig,
  safeParseClaudeCodeConfig,
  CLAUDE_OUTPUT_FORMAT,
  CLAUDE_PERMISSION_MODE,
} from '../../../../src/compat/subagents/claude-code/index.js'

describe('claude-code/config.parseClaudeCodeConfig', () => {
  it('returns all defaults on empty input', () => {
    const cfg = parseClaudeCodeConfig({})
    expect(cfg.enabled).toBe(false)
    expect(cfg.command).toBe('opencc')
    expect(cfg.args).toEqual(['--print', '--output-format', 'stream-json'])
    expect(cfg.outputFormat).toBe(CLAUDE_OUTPUT_FORMAT.streamJson)
    expect(cfg.permissionMode).toBe(CLAUDE_PERMISSION_MODE.bypassPermissions)
    expect(cfg.env).toEqual({})
    expect(cfg.disposeGraceMs).toBe(3000)
  })

  it('accepts explicit overrides', () => {
    const cfg = parseClaudeCodeConfig({
      enabled: true,
      command: '/opt/claude',
      args: ['--print', '--output-format', 'json', '--model', 'sonnet'],
      outputFormat: 'json',
      permissionMode: 'plan',
      env: { ANTHROPIC_API_KEY: 'sk-test' },
      disposeGraceMs: 5000,
    })
    expect(cfg.command).toBe('/opt/claude')
    expect(cfg.outputFormat).toBe(CLAUDE_OUTPUT_FORMAT.json)
    expect(cfg.permissionMode).toBe(CLAUDE_PERMISSION_MODE.plan)
    expect(cfg.env.ANTHROPIC_API_KEY).toBe('sk-test')
    expect(cfg.disposeGraceMs).toBe(5000)
  })

  it('rejects disposeGraceMs above MAX_TIMER_DELAY_MS', () => {
    expect(() =>
      parseClaudeCodeConfig({ disposeGraceMs: 2_147_483_648 }),
    ).toThrow()
  })
})

describe('claude-code/config.safeParseClaudeCodeConfig', () => {
  it('falls back to defaults when input is invalid', () => {
    // Malformed input would throw `parseClaudeCodeConfig`. The safe
    // variant returns defaults instead so the provider can register
    // with the all-defaults config.
    const cfg = safeParseClaudeCodeConfig({ disposeGraceMs: 'not-a-number' })
    expect(cfg.enabled).toBe(false)
  })

  it('returns the parsed config when input is valid', () => {
    const cfg = safeParseClaudeCodeConfig({ enabled: true })
    expect(cfg.enabled).toBe(true)
  })
})
