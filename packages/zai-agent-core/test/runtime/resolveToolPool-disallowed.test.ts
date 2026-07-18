import { describe, expect, test } from 'vitest'
import { resolveToolPool } from '../../src/runtime/queryEngine.js'
import type { QueryOptions } from '../../src/runtime/types.js'

type AnyTool = { name: string; description?: string }
type AnyConfig = { enableSkillTool?: boolean; skillsDirs?: string[] }

const fakeTool = (name: string): AnyTool => ({ name, description: `${name} tool` })

const baseTools: AnyTool[] = [
  fakeTool('Read'),
  fakeTool('Write'),
  fakeTool('Agent'),
  fakeTool('BackgroundAgent'),
  fakeTool('Bash'),
]

const emptyConfig: AnyConfig = {}

const noSkills: never[] = []

describe('resolveToolPool — disallowedTools filter', () => {
  test('removes a single named tool, leaves others alone', () => {
    const opts: QueryOptions = { disallowedTools: ['Agent'] }
    const result = resolveToolPool(opts, emptyConfig, baseTools, noSkills)
    const names = result.map(t => t.name)
    expect(names).toContain('Read')
    expect(names).toContain('Bash')
    expect(names).toContain('BackgroundAgent')
    expect(names).not.toContain('Agent')
  })

  test('removes multiple named tools', () => {
    const opts: QueryOptions = { disallowedTools: ['Agent', 'BackgroundAgent'] }
    const result = resolveToolPool(opts, emptyConfig, baseTools, noSkills)
    const names = result.map(t => t.name)
    expect(names).not.toContain('Agent')
    expect(names).not.toContain('BackgroundAgent')
    expect(names).toContain('Read')
    expect(names).toContain('Write')
    expect(names).toContain('Bash')
  })

  test('undefined disallowedTools is a no-op', () => {
    const opts: QueryOptions = {}
    const result = resolveToolPool(opts, emptyConfig, baseTools, noSkills)
    expect(result.map(t => t.name)).toEqual(['Read', 'Write', 'Agent', 'BackgroundAgent', 'Bash'])
  })

  test('empty disallowedTools array is a no-op', () => {
    const opts: QueryOptions = { disallowedTools: [] }
    const result = resolveToolPool(opts, emptyConfig, baseTools, noSkills)
    expect(result.length).toBe(baseTools.length)
  })

  test('filter applies AFTER additionalTools merge — additional tool also gets filtered', () => {
    const opts: QueryOptions = {
      disallowedTools: ['Agent'],
      additionalTools: [fakeTool('Agent'), fakeTool('CustomTool')],
    }
    const result = resolveToolPool(opts, emptyConfig, baseTools, noSkills)
    const names = result.map(t => t.name)
    // additionalTools' Agent is filtered out; the one in base is also filtered out
    expect(names.filter(n => n === 'Agent').length).toBe(0)
    expect(names).toContain('CustomTool')
  })

  test('filter applies under toolsOverride: "none"', () => {
    const opts: QueryOptions = {
      toolsOverride: 'none',
      disallowedTools: ['CustomTool'],
      additionalTools: [fakeTool('CustomTool'), fakeTool('Another')],
    }
    const result = resolveToolPool(opts, emptyConfig, baseTools, noSkills)
    const names = result.map(t => t.name)
    expect(names).not.toContain('CustomTool')
    expect(names).toContain('Another')
  })
})