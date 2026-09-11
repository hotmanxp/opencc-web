import { describe, expect, it, beforeEach } from 'vitest'
import { setCommandRegistry, getCommandRegistry } from '@zn-ai/zn-agent-core'
import { slashList } from '../../../src/server/services/commands/slashList.js'

beforeEach(() => setCommandRegistry(null))

describe('slashList', () => {
  it('returns built-in commands when no user commands', async () => {
    const r = getCommandRegistry()
    r.register({ type: 'local', name: 'clear', description: 'd', source: 'builtin', call: async () => ({ kind: 'cleared' }) })
    r.register({ type: 'local', name: 'compact', description: 'd', source: 'builtin', call: async () => ({ kind: 'error', message: 'x' }) })
    const out = await slashList({ skills: [{ name: 'frontend-design', description: 'design skill' }] })
    expect(out.map((i) => i.name)).toEqual(['clear', 'compact', 'frontend-design'])
    expect(out[0]!.kind).toBe('command')
    expect(out[0]!.isBuiltIn).toBe(true)
    expect(out[2]!.kind).toBe('skill')
  })

  it('user commands appear after built-ins', async () => {
    const r = getCommandRegistry()
    r.register({ type: 'local', name: 'clear', description: 'd', source: 'builtin', call: async () => ({ kind: 'cleared' }) })
    r.register({ type: 'prompt', name: 'greet', description: 'd', source: 'user', progressMessage: 'p', contentLength: 0, getPromptForCommand: async () => [{ type: 'text', text: 'hi' }] })
    const out = await slashList({ skills: [] })
    expect(out.map((i) => i.name)).toEqual(['clear', 'greet'])
    expect(out[1]!.kind).toBe('command')
    expect(out[1]!.isBuiltIn).toBe(false)
  })

  it('marks user: prefixed commands as isConflict when userLoader renamed a conflicting builtin', async () => {
    const r = getCommandRegistry()
    r.register({ type: 'local', name: 'clear', description: 'd', source: 'builtin', call: async () => ({ kind: 'cleared' }) })
    r.register({ type: 'prompt', name: 'user:clear', description: 'd', source: 'user', progressMessage: 'p', contentLength: 0, getPromptForCommand: async () => [{ type: 'text', text: 'hi' }] })
    const out = await slashList({ skills: [] })
    expect(out.map((i) => i.name)).toEqual(['clear', 'user:clear'])
    expect(out[0]!.kind).toBe('command')
    expect(out[0]!.isBuiltIn).toBe(true)
    expect(out[0]!.isConflict).toBeUndefined()
    expect(out[1]!.kind).toBe('command')
    expect(out[1]!.isBuiltIn).toBe(false)
    expect(out[1]!.isConflict).toBe(true)
  })

  it('includes plugin commands with pluginName (manifest preferred) and stripped displayName', async () => {
    const r = getCommandRegistry()
    // pluginInfo is on the vendor command shape, not the compat Command type —
    // cast past excess-property checking for the test fixture.
    r.register({
      type: 'prompt',
      name: 'superpowers:write-plan',
      description: 'write a plan',
      source: 'plugin',
      progressMessage: 'p',
      contentLength: 0,
      pluginInfo: { pluginManifest: { name: 'superpowers' } },
      getPromptForCommand: async () => [{ type: 'text', text: 'hi' }],
    } as never)
    const out = await slashList({ skills: [] })
    expect(out).toHaveLength(1)
    expect(out[0]!.name).toBe('superpowers:write-plan')
    expect(out[0]!.kind).toBe('command')
    expect(out[0]!.isBuiltIn).toBe(false)
    expect(out[0]!.pluginName).toBe('superpowers')
    expect(out[0]!.displayName).toBe('write-plan')
  })

  it('falls back to the name prefix for plugin command pluginName without pluginInfo', async () => {
    const r = getCommandRegistry()
    r.register({
      type: 'prompt',
      name: 'myplugin:ns:tool',
      description: 'namespaced plugin command',
      source: 'plugin',
      progressMessage: 'p',
      contentLength: 0,
      getPromptForCommand: async () => [{ type: 'text', text: 'hi' }],
    } as never)
    const out = await slashList({ skills: [] })
    expect(out[0]!.pluginName).toBe('myplugin')
    expect(out[0]!.displayName).toBe('tool')
  })

  it('plugin commands come after builtin and user commands, before skills', async () => {
    const r = getCommandRegistry()
    r.register({ type: 'local', name: 'clear', description: 'd', source: 'builtin', call: async () => ({ kind: 'cleared' }) })
    r.register({ type: 'prompt', name: 'greet', description: 'd', source: 'user', progressMessage: 'p', contentLength: 0, getPromptForCommand: async () => [] })
    r.register({ type: 'prompt', name: 'superpowers:commit', description: 'd', source: 'plugin', progressMessage: 'p', contentLength: 0, getPromptForCommand: async () => [] } as never)
    const out = await slashList({ skills: [{ name: 'my-skill', description: 's' }] })
    expect(out.map((i) => i.name)).toEqual(['clear', 'greet', 'superpowers:commit', 'my-skill'])
  })
})