import { beforeAll, describe, test, expect } from 'bun:test'

// The bg-agent feature is default-off; this command is conditionally
// registered only when `isBgAgentRuntimeEnabled()` returns true. Enable
// it for the file so the registration assertion can find the command.
beforeAll(() => {
  process.env.CLAUDE_CODE_ENABLE_AGENT_VIEW = '1'
})

describe('backgroundCommand (T8)', () => {
  test('has the expected Command shape', async () => {
    const mod = await import('./index.js')
    const cmd = mod.default
    expect(cmd.type).toBe('local-jsx')
    expect(cmd.name).toBe('background')
    expect(typeof cmd.description).toBe('string')
    expect(cmd.description.length).toBeGreaterThan(0)
    expect(typeof cmd.load).toBe('function')
  })

  test('loader returns a module with a call() function', async () => {
    const mod = await import('./index.js')
    const loaded = await mod.default.load()
    expect(typeof loaded.call).toBe('function')
  })

  test('is registered in the commands registry', async () => {
    const { getCommands } = await import('../../commands.js')
    const cmds = await getCommands(process.cwd())
    const names = cmds.map(c => c.name)
    expect(names).toContain('background')
  })
})