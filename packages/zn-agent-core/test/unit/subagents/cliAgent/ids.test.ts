import { describe, it, expect } from 'vitest'
import {
  defaultCliRunId,
  formatAgentId,
  generateTaskId,
  parseAgentId,
  sanitizeAgentName,
} from '../../../../src/compat/subagents/cliAgent/ids.js'

describe('subagents/cliAgent/ids', () => {
  it('formatAgentId joins agent name and team name with @', () => {
    expect(formatAgentId('researcher', 'my-project')).toBe('researcher@my-project')
  })

  it('sanitizeAgentName strips @ from names', () => {
    expect(sanitizeAgentName('a@b')).toBe('a-b')
    expect(sanitizeAgentName('plain')).toBe('plain')
  })

  it('parseAgentId round-trips an agentName@teamName id', () => {
    expect(parseAgentId('researcher@my-project')).toEqual({
      agentName: 'researcher',
      teamName: 'my-project',
    })
  })

  it('parseAgentId returns null when no @ separator is present', () => {
    expect(parseAgentId('no-separator')).toBeNull()
  })

  it('generateTaskId yields a vendor-shaped t-prefixed 9-char id', () => {
    for (let i = 0; i < 50; i++) {
      const id = generateTaskId('in_process_teammate')
      expect(id).toMatch(/^t[0-9a-z]{8}$/)
    }
  })

  it('defaultCliRunId keeps the <prefix>-<rand8> shape', () => {
    const id = defaultCliRunId('opencc')
    expect(id).toMatch(/^opencc-[0-9a-z]{8}$/)
    // Distinct per call (rand8 suffix) — cheap collision sanity.
    expect(defaultCliRunId('opencc')).not.toBe(id)
  })
})