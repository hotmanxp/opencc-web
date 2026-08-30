// @ts-nocheck
/**
 * zai patch (2026-08-30, plan P0): L2 CommandKeybindingsState tests.
 */

import { setupCommandKeybindings } from '../setup/setupCommandKeybindings.js'

describe('setupCommandKeybindings', () => {
  it('parse extracts command from /-prefixed input', () => {
    const { state, teardown } = setupCommandKeybindings()
    const result = state.parse('/help')
    expect(result?.command).toBe('help')
    expect(result?.args).toBe('')
    teardown()
  })

  it('parse returns null for non-command input', () => {
    const { state, teardown } = setupCommandKeybindings()
    const result = state.parse('hello world')
    expect(result).toBeNull()
    teardown()
  })

  it('parse extracts args after command', () => {
    const { state, teardown } = setupCommandKeybindings()
    const result = state.parse('/commit -m "fix bug"')
    expect(result?.command).toBe('commit')
    expect(result?.args).toBe('-m "fix bug"')
    teardown()
  })

  it('reset clears any buffered state', () => {
    const { state, teardown } = setupCommandKeybindings()
    state.parse('/partial')
    state.reset()
    // After reset, fresh parse works
    const result = state.parse('/help')
    expect(result?.command).toBe('help')
    teardown()
  })

  it('teardown is idempotent', () => {
    const { teardown } = setupCommandKeybindings()
    teardown()
    expect(() => teardown()).not.toThrow()
  })

  it('onCommand callback fires when parse matches', () => {
    const calls: Array<[string, string]> = []
    const { state, teardown } = setupCommandKeybindings({
      onCommand: (cmd, args) => { calls.push([cmd, args]) },
    })
    state.parse('/test arg1 arg2')
    expect(calls.length).toBe(1)
    expect(calls[0][0]).toBe('test')
    expect(calls[0][1]).toBe('arg1 arg2')
    teardown()
  })

  it('onKeybinding callback is accepted in opts', () => {
    const calls: string[] = []
    const { teardown } = setupCommandKeybindings({
      onKeybinding: (key) => { calls.push(key) },
    })
    // P0: onKeybinding is a placeholder; just verify it doesn't throw
    expect(() => teardown()).not.toThrow()
  })
})
