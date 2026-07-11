import { describe, expect, test } from 'bun:test'
import { matchToolName } from '../../src/mcp/permission-matcher.js'

describe('matchToolName', () => {
  test('exact string match', () => {
    expect(matchToolName('mcp__github__create_issue', 'mcp__github__create_issue')).toBe(true)
    expect(matchToolName('mcp__github__create_issue', 'mcp__github__close_issue')).toBe(false)
  })

  test('pattern with single star', () => {
    expect(matchToolName({ pattern: 'mcp__github__*' }, 'mcp__github__create_issue')).toBe(true)
    expect(matchToolName({ pattern: 'mcp__github__*' }, 'mcp__gitlab__create_issue')).toBe(false)
  })

  test('pattern with multiple stars', () => {
    expect(matchToolName({ pattern: 'mcp__*__read_*' }, 'mcp__fs__read_file')).toBe(true)
    expect(matchToolName({ pattern: 'mcp__*__read_*' }, 'mcp__fs__write_file')).toBe(false)
  })

  test('action defaults to allow', () => {
    expect(matchToolName({ pattern: 'Bash' }, 'Bash')).toBe(true)
  })
})
