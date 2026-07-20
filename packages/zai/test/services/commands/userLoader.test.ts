import { describe, expect, it, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setCommandRegistry, getCommandRegistry } from '@zn-ai/zai-agent-core'
import { loadUserCommands, reloadUserCommands } from '../../../src/server/services/commands/userLoader.js'

let tmpHome: string
let commandsDir: string

beforeEach(() => {
  setCommandRegistry(null)
  tmpHome = mkdtempSync(join(tmpdir(), 'zai-cmd-test-'))
  commandsDir = join(tmpHome, '.zai', 'commands')
  mkdirSync(commandsDir, { recursive: true })
})

afterEach(() => {
  rmSync(tmpHome, { recursive: true, force: true })
})

function writeCommand(name: string, frontmatter: object, body: string): void {
  const yaml = Object.entries(frontmatter)
    .map(([k, v]) => `${k}: ${JSON.stringify(v)}`)
    .join('\n')
  const content = `---\n${yaml}\n---\n${body}`
  writeFileSync(join(commandsDir, `${name}.md`), content, 'utf-8')
}

describe('loadUserCommands', () => {
  it('returns [] when commands dir does not exist', async () => {
    rmSync(commandsDir, { recursive: true, force: true })
    const cmds = await loadUserCommands({ cwd: '/x', dataDir: tmpHome })
    expect(cmds).toEqual([])
  })

  it('loads a valid .md as PromptCommand', async () => {
    writeCommand('greet', {
      description: 'Say hi',
      argumentHint: '[name]',
      argNames: ['name'],
      whenToUse: 'Greet someone',
    }, 'Hello $ARGUMENTS')
    const cmds = await loadUserCommands({ cwd: '/x', dataDir: tmpHome })
    expect(cmds).toHaveLength(1)
    expect(cmds[0]!.name).toBe('greet')
    expect(cmds[0]!.source).toBe('user')
    expect(cmds[0]!.description).toBe('Say hi')
    expect(cmds[0]!.argumentHint).toBe('[name]')
    expect(cmds[0]!.argNames).toEqual(['name'])
    expect(cmds[0]!.contentLength).toBe('Hello $ARGUMENTS'.length)
    const rendered = await cmds[0]!.getPromptForCommand('alice', { cwd: '/x', dataDir: tmpHome })
    expect((rendered[0] as any).text).toBe('Hello alice')
  })

  it('skips files with invalid name', async () => {
    writeCommand('Bad-Name', { description: 'x' }, 'body')
    writeCommand('good', { description: 'y' }, 'body')
    const cmds = await loadUserCommands({ cwd: '/x', dataDir: tmpHome })
    expect(cmds.map((c) => c.name)).toEqual(['good'])
  })

  it('skips files with invalid YAML (no crash)', async () => {
    writeFileSync(join(commandsDir, 'broken.md'), '---\n: : invalid\n---\nbody', 'utf-8')
    writeCommand('good', { description: 'y' }, 'body')
    const cmds = await loadUserCommands({ cwd: '/x', dataDir: tmpHome })
    expect(cmds.map((c) => c.name)).toEqual(['good'])
  })
})

describe('reloadUserCommands', () => {
  it('removes old user commands and registers new', async () => {
    writeCommand('foo', { description: 'old' }, 'body')
    const r = getCommandRegistry()
    await reloadUserCommands({ cwd: '/x', dataDir: tmpHome })
    expect(r.get('foo')).toBeDefined()

    writeCommand('bar', { description: 'new' }, 'body')
    rmSync(join(commandsDir, 'foo.md'))
    await reloadUserCommands({ cwd: '/x', dataDir: tmpHome })
    expect(r.get('foo')).toBeUndefined()
    expect(r.get('bar')).toBeDefined()
  })

  it('does not overwrite built-in commands with same name (user gets user: prefix)', async () => {
    // Pre-register a built-in manually
    const reg = getCommandRegistry()
    reg.register({
      type: 'local',
      name: 'clear',
      description: 'builtin',
      source: 'builtin',
      call: async () => ({ kind: 'cleared' }),
    })
    writeCommand('clear', { description: 'user wants to override clear' }, 'hi')
    await reloadUserCommands({ cwd: '/x', dataDir: tmpHome })
    // builtin still wins
    expect(reg.get('clear')?.source).toBe('builtin')
    // user variant registered as user:clear
    expect(reg.get('user:clear')).toBeDefined()
    expect(reg.get('user:clear')?.source).toBe('user')
  })
})

describe('loadUserCommands — fallback to ~/.claude/commands', () => {
  let homeDir: string

  beforeEach(() => {
    homeDir = mkdtempSync(join(tmpdir(), 'zai-cmd-fallback-'))
    mkdirSync(join(homeDir, '.zai'), { recursive: true })
    mkdirSync(join(homeDir, '.claude'), { recursive: true })
    setCommandRegistry(null)
  })

  afterEach(() => {
    rmSync(homeDir, { recursive: true, force: true })
  })

  const writeCommandAt = (dir: string, name: string, body: string, extra: Record<string, unknown> = {}) => {
    const yaml = Object.entries({ description: name, ...extra })
      .map(([k, v]) => `${k}: ${JSON.stringify(v)}`).join('\n')
    writeFileSync(join(dir, `${name}.md`), `---\n${yaml}\n---\n${body}`, 'utf-8')
  }

  it('loads from ~/.claude/commands when ~/.zai/commands is absent', async () => {
    const claudeDir = join(homeDir, '.claude', 'commands')
    writeCommandAt(claudeDir, 'greet', 'Hello $ARGUMENTS')
    const cmds = await loadUserCommands({ cwd: '/x', dataDir: tmpHome, homeDir } as any)
    expect(cmds.map((c) => c.name)).toEqual(['greet'])
  })

  it('prefers ~/.zai/commands over ~/.claude/commands when both exist', async () => {
    const zaiDir = join(tmpHome, '.zai', 'commands')
    const claudeDir = join(homeDir, '.claude', 'commands')
    writeCommandAt(zaiDir, 'greet', 'Hello $ARGUMENTS')
    writeCommandAt(claudeDir, 'greet', 'Bye $ARGUMENTS')
    const [cmd] = await loadUserCommands({ cwd: '/x', dataDir: tmpHome, homeDir } as any)
    const rendered = await cmd!.getPromptForCommand('alice', { cwd: '/x', dataDir: tmpHome })
    expect((rendered[0] as any).text).toBe('Hello alice')
  })

  it('returns [] when neither directory exists', async () => {
    const empty = mkdtempSync(join(tmpdir(), 'zai-cmd-empty-'))
    const cmds = await loadUserCommands({ cwd: '/x', dataDir: empty, homeDir: empty } as any)
    expect(cmds).toEqual([])
    rmSync(empty, { recursive: true, force: true })
  })
})