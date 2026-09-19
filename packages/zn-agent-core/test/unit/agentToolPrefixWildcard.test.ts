import { describe, expect, it } from 'vitest'
import {
  isPrefixWildcard,
  toolSpecMatches,
} from '../../src/opencc-src/tools/AgentTool/agentToolMatching.js'

type T = { name: string }
const tool = (name: string): T => ({ name })

describe('toolSpecMatches', () => {
  it('matches an exact tool name', () => {
    expect(toolSpecMatches('Bash', tool('Bash'))).toBe(true)
    expect(toolSpecMatches('Bash', tool('Read'))).toBe(false)
  })

  it('matches every tool under a prefix wildcard', () => {
    const spec = 'mcp__cua-driver__*'
    expect(toolSpecMatches(spec, tool('mcp__cua-driver__list_apps'))).toBe(true)
    expect(toolSpecMatches(spec, tool('mcp__cua-driver__click'))).toBe(true)
  })

  it('does not leak tools from a different server sharing a prefix substring', () => {
    expect(toolSpecMatches('mcp__cua-driver__*', tool('mcp__other-server__ping'))).toBe(false)
  })

  it('anchors the prefix at the start of the name', () => {
    expect(toolSpecMatches('driver__*', tool('mcp__cua-driver__click'))).toBe(false)
  })

  it('expands a bare trailing star to everything sharing the prefix', () => {
    expect(toolSpecMatches('Bash*', tool('Bash'))).toBe(true)
    expect(toolSpecMatches('Bash*', tool('BashOutput'))).toBe(true)
  })

  it('treats a star in the candidate name literally', () => {
    expect(toolSpecMatches('Bash', tool('Bash*'))).toBe(false)
  })
})

describe('isPrefixWildcard', () => {
  it('is false for exact names', () => {
    expect(isPrefixWildcard('Bash')).toBe(false)
    expect(isPrefixWildcard('mcp__cua-driver__list_apps')).toBe(false)
  })

  it('is true for a trailing star with a prefix', () => {
    expect(isPrefixWildcard('mcp__cua-driver__*')).toBe(true)
  })

  it('is false for the bare all-tools sentinel, which the caller handles first', () => {
    expect(isPrefixWildcard('*')).toBe(false)
  })
})
