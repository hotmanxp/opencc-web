import { describe, expect, it, beforeEach } from 'vitest'
import { setCommandRegistry, getCommandRegistry } from '../../src/commands/registry.js'
import type { LocalCommand, Command } from '../../src/commands/types.js'

function makeLocal(name: string, aliases?: string[]): LocalCommand {
  return {
    type: 'local',
    name,
    description: `cmd ${name}`,
    source: 'builtin',
    call: async () => ({ kind: 'message', text: name }),
    ...(aliases ? { aliases } : {}),
  }
}

beforeEach(() => setCommandRegistry(null))

describe('CommandRegistry', () => {
  it('register + get by primary name', () => {
    const r = getCommandRegistry()
    const cmd = makeLocal('clear')
    r.register(cmd)
    expect(r.get('clear')).toBe(cmd)
  })

  it('register + get is case-insensitive', () => {
    const r = getCommandRegistry()
    r.register(makeLocal('clear'))
    expect(r.get('CLEAR')).toBeDefined()
  })

  it('get by alias', () => {
    const r = getCommandRegistry()
    r.register(makeLocal('clear', ['c', 'reset']))
    expect(r.get('reset')).toBeDefined()
    expect(r.get('C')).toBeDefined()
  })

  it('unregister by primary name', () => {
    const r = getCommandRegistry()
    r.register(makeLocal('clear'))
    r.unregister('clear')
    expect(r.get('clear')).toBeUndefined()
  })

  it('all returns registered commands', () => {
    const r = getCommandRegistry()
    r.register(makeLocal('a'))
    r.register(makeLocal('b'))
    expect(r.all().map((c) => c.name).sort()).toEqual(['a', 'b'])
  })

  it('resolve("/clear") returns the clear command with empty args', () => {
    const r = getCommandRegistry()
    r.register(makeLocal('clear'))
    const res = r.resolve('/clear')
    expect(res?.command.name).toBe('clear')
    expect(res?.args).toBe('')
  })

  it('resolve("/compact --force") returns compact with args="--force"', () => {
    const r = getCommandRegistry()
    r.register(makeLocal('compact'))
    const res = r.resolve('/compact --force')
    expect(res?.command.name).toBe('compact')
    expect(res?.args).toBe('--force')
  })

  it('resolve("/foo") returns null for unknown command', () => {
    const r = getCommandRegistry()
    r.register(makeLocal('clear'))
    expect(r.resolve('/foo')).toBeNull()
  })

  it('resolve("/") returns null (empty name)', () => {
    expect(getCommandRegistry().resolve('/')).toBeNull()
  })

  it('all() filters by source for reloadUserCommands pattern', () => {
    const r = getCommandRegistry()
    const a: Command = makeLocal('a')
    const b: LocalCommand = makeLocal('b')
    b.source = 'user'
    r.register(a)
    r.register(b)
    const users = r.all().filter((c) => c.source === 'user')
    expect(users).toHaveLength(1)
    expect(users[0]!.name).toBe('b')
  })

  it('setCommandRegistry(null) resets the singleton', () => {
    const r1 = getCommandRegistry()
    r1.register(makeLocal('a'))
    setCommandRegistry(null)
    const r2 = getCommandRegistry()
    expect(r2).not.toBe(r1)
    expect(r2.get('a')).toBeUndefined()
  })
})