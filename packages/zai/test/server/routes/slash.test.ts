import { describe, expect, it, beforeEach } from 'vitest'
import { setCommandRegistry, getCommandRegistry } from '@zn-ai/zai-agent-core'
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
})
