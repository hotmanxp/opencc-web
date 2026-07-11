import { describe, expect, test } from 'bun:test'
import { makeMcpToolName, parseMcpToolName } from '../../src/mcp/tool-name.js'

describe('makeMcpToolName', () => {
  test('joins server and tool with double underscore', () => {
    expect(makeMcpToolName('github', 'create_issue')).toBe('mcp__github__create_issue')
  })
})

describe('parseMcpToolName', () => {
  test('parses valid mcp name', () => {
    expect(parseMcpToolName('mcp__github__create_issue')).toEqual({
      serverName: 'github',
      originalName: 'create_issue',
    })
  })

  test('returns null on non-mcp name', () => {
    expect(parseMcpToolName('Bash')).toBeNull()
  })

  test('returns null on malformed mcp name with single underscore segment', () => {
    expect(parseMcpToolName('mcp__github__')).toEqual({
      serverName: 'github',
      originalName: '',
    })
  })
})