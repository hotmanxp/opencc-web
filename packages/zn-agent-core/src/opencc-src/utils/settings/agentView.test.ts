import { describe, test, expect, beforeEach, afterEach } from 'bun:test'
import { isAgentViewEnabled } from './agentView.js'

describe('isAgentViewEnabled (default-off; opt-in via env or setting)', () => {
  let origEnv: string | undefined
  beforeEach(() => {
    origEnv = process.env.CLAUDE_CODE_ENABLE_AGENT_VIEW
  })
  afterEach(() => {
    if (origEnv === undefined) delete process.env.CLAUDE_CODE_ENABLE_AGENT_VIEW
    else process.env.CLAUDE_CODE_ENABLE_AGENT_VIEW = origEnv
  })

  test('returns false by default (no env, no setting) — default-off', () => {
    delete process.env.CLAUDE_CODE_ENABLE_AGENT_VIEW
    expect(isAgentViewEnabled({})).toBe(false)
  })

  test('returns true when env var CLAUDE_CODE_ENABLE_AGENT_VIEW=1', () => {
    process.env.CLAUDE_CODE_ENABLE_AGENT_VIEW = '1'
    expect(isAgentViewEnabled({})).toBe(true)
  })

  test('env var "0" does NOT enable (only "1" enables)', () => {
    process.env.CLAUDE_CODE_ENABLE_AGENT_VIEW = '0'
    expect(isAgentViewEnabled({})).toBe(false)
  })

  test('env var "true" does NOT enable (only "1" enables)', () => {
    process.env.CLAUDE_CODE_ENABLE_AGENT_VIEW = 'true'
    expect(isAgentViewEnabled({})).toBe(false)
  })

  test('returns true when settings.enableAgentView is true', () => {
    delete process.env.CLAUDE_CODE_ENABLE_AGENT_VIEW
    expect(isAgentViewEnabled({ enableAgentView: true })).toBe(true)
  })

  test('env var wins over setting (both set → enabled)', () => {
    process.env.CLAUDE_CODE_ENABLE_AGENT_VIEW = '1'
    expect(isAgentViewEnabled({ enableAgentView: false })).toBe(true)
  })

  test('setting wins over non-"1" env values (env="0")', () => {
    process.env.CLAUDE_CODE_ENABLE_AGENT_VIEW = '0'
    expect(isAgentViewEnabled({ enableAgentView: true })).toBe(true)
  })

  test('empty-string env var does NOT enable (strict "1" only)', () => {
    process.env.CLAUDE_CODE_ENABLE_AGENT_VIEW = ''
    expect(isAgentViewEnabled({})).toBe(false)
  })

  test('setting wins over env when env is "0"', () => {
    process.env.CLAUDE_CODE_ENABLE_AGENT_VIEW = '0'
    expect(isAgentViewEnabled({ enableAgentView: true })).toBe(true)
  })

  test('setting true is honored (default-off otherwise)', () => {
    delete process.env.CLAUDE_CODE_ENABLE_AGENT_VIEW
    expect(isAgentViewEnabled({ enableAgentView: true })).toBe(true)
  })
})
