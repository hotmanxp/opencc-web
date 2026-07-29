import { describe, expect, test } from 'bun:test'
import {
  findStackedMidInputSlashCommand,
  generateCommandSuggestions,
} from './commandSuggestions.ts'
import type { Command } from '../../commands.js'

// Helper to create a mock plugin command
function mockPluginCommand(name: string, pluginName: string): Command {
  return {
    type: 'prompt',
    name,
    description: 'Test command',
    source: 'plugin',
    pluginInfo: {
      pluginManifest: { name: pluginName },
      repository: 'test/repo',
    },
    getPromptForCommand: async () => [],
  } as unknown as Command
}

describe('generateCommandSuggestions - plugin name fuzzy search', () => {
  test('finds commands by plugin name prefix', () => {
    const commands: Command[] = [
      mockPluginCommand('brainstorming', 'superpowers'),
      mockPluginCommand('writing-plans', 'superpowers'),
      mockPluginCommand('code-review', 'another-plugin'),
    ]

    const results = generateCommandSuggestions('/sup', commands)
    const names = results.map(r => {
      const cmd = r.metadata as Command
      return cmd.name
    })

    expect(names).toContain('brainstorming')
    expect(names).toContain('writing-plans')
    expect(names).not.toContain('code-review')
  })

  test('command name match takes priority over plugin name match', () => {
    const commands: Command[] = [
      mockPluginCommand('superman', 'other-plugin'),
      mockPluginCommand('brainstorming', 'superpowers'),
    ]

    const results = generateCommandSuggestions('/sup', commands)
    const names = results.map(r => {
      const cmd = r.metadata as Command
      return cmd.name
    })

    // /superman should appear first due to command name prefix match
    expect(names[0]).toBe('superman')
    expect(names).toContain('brainstorming')
  })
})

describe('findStackedMidInputSlashCommand', () => {
  test('/foo /bar cursor at end returns /bar token', () => {
    expect(findStackedMidInputSlashCommand('/foo /bar', 9)).toEqual({
      token: '/bar',
      startPos: 5,
      partialCommand: 'bar',
    })
  })

  test('/a /b /c cursor at end returns last /c', () => {
    expect(findStackedMidInputSlashCommand('/a /b /c', 8)).toEqual({
      token: '/c',
      startPos: 6,
      partialCommand: 'c',
    })
  })

  test('/foo / cursor right after slash returns empty partial', () => {
    const r = findStackedMidInputSlashCommand('/foo /', 5)
    expect(r?.token).toBe('/')
    expect(r?.partialCommand).toBe('')
    expect(r?.startPos).toBe(5)
  })

  test('/foo (no second token) returns null', () => {
    expect(findStackedMidInputSlashCommand('/foo', 4)).toBeNull()
  })

  test('/a /b /c /d /e /f (6 stacked, at cap) returns null', () => {
    expect(findStackedMidInputSlashCommand('/a /b /c /d /e /f', 16)).toBeNull()
  })
})
