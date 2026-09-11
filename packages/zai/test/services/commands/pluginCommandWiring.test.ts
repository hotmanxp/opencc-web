import { describe, expect, it, beforeEach, vi } from 'vitest'
import {
  setCommandRegistry,
  getCommandRegistry,
  getLoadedPluginCommands,
} from '@zn-ai/zn-agent-core'
import { reloadPluginCommands } from '../../../src/server/services/commands/registry.js'
import { slashList } from '../../../src/server/services/commands/slashList.js'

// Partial-mock the core entry: keep the real InMemoryCommandRegistry so we
// exercise actual idempotent register/unregister behavior, and only stub the
// plugin command channel so we can feed controlled fixtures.
vi.mock('@zn-ai/zn-agent-core', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@zn-ai/zn-agent-core')>()
  return { ...actual, getLoadedPluginCommands: vi.fn() }
})

const mockedChannel = vi.mocked(getLoadedPluginCommands)

// Vendor plugin command shape (name `pluginName[:ns:]cmd`, source 'plugin',
// pluginInfo.pluginManifest.name). pluginInfo isn't on the compat Command type,
// so fixtures are cast past excess-property checking — same as slash.test.ts.
function pluginCmd(name: string, pluginName: string, description: string) {
  return {
    type: 'prompt' as const,
    name,
    description,
    source: 'plugin' as const,
    progressMessage: 'p',
    contentLength: 0,
    pluginInfo: { pluginManifest: { name: pluginName } },
    getPromptForCommand: async () => [{ type: 'text' as const, text: 'x' }],
  }
}

beforeEach(() => {
  setCommandRegistry(null)
  mockedChannel.mockReset()
})

describe('reloadPluginCommands wiring', () => {
  it('registers plugin commands so slashList surfaces them with pluginName + stripped displayName', async () => {
    mockedChannel.mockResolvedValue([
      pluginCmd('superpowers:write-plan', 'superpowers', 'write a plan'),
      pluginCmd('superpowers:brainstorming:go', 'superpowers', 'namespaced'),
    ] as never)

    await reloadPluginCommands()
    const out = await slashList({ skills: [] })

    expect(out).toHaveLength(2)
    expect(out[0]).toMatchObject({
      kind: 'command',
      name: 'superpowers:write-plan',
      isBuiltIn: false,
      pluginName: 'superpowers',
      displayName: 'write-plan',
    })
    // namespaced command → displayName strips both plugin and namespace prefix
    expect(out[1]).toMatchObject({
      name: 'superpowers:brainstorming:go',
      pluginName: 'superpowers',
      displayName: 'go',
    })
  })

  it('is idempotent — a second registration does not duplicate entries', async () => {
    mockedChannel.mockResolvedValue([
      pluginCmd('superpowers:commit', 'superpowers', 'commit'),
    ] as never)

    await reloadPluginCommands()
    await reloadPluginCommands()
    const out = await slashList({ skills: [] })

    const pluginItems = out.filter((i) => i.name === 'superpowers:commit')
    expect(pluginItems).toHaveLength(1)
  })

  it('does not affect builtin/user commands', async () => {
    const r = getCommandRegistry()
    r.register({
      type: 'local',
      name: 'clear',
      description: 'd',
      source: 'builtin',
      call: async () => ({ kind: 'cleared' }),
    })
    r.register({
      type: 'prompt',
      name: 'greet',
      description: 'd',
      source: 'user',
      progressMessage: 'p',
      contentLength: 0,
      getPromptForCommand: async () => [{ type: 'text', text: 'hi' }],
    })

    mockedChannel.mockResolvedValue([
      pluginCmd('superpowers:commit', 'superpowers', 'commit'),
    ] as never)

    await reloadPluginCommands()
    const out = await slashList({ skills: [] })

    expect(out.map((i) => i.name)).toEqual(['clear', 'greet', 'superpowers:commit'])
    expect(out[0]!.isBuiltIn).toBe(true)
    expect(out[1]!.isBuiltIn).toBe(false)
    expect(out[2]!.pluginName).toBe('superpowers')
  })

  it('degrades safely when the core channel is unavailable (no throw, no items)', async () => {
    mockedChannel.mockRejectedValue(new Error('channel missing'))
    const r = getCommandRegistry()
    r.register({
      type: 'local',
      name: 'clear',
      description: 'd',
      source: 'builtin',
      call: async () => ({ kind: 'cleared' }),
    })

    await expect(reloadPluginCommands()).resolves.toBeUndefined()
    const out = await slashList({ skills: [] })
    expect(out.map((i) => i.name)).toEqual(['clear'])
  })
})
