import { describe, expect, it, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setCommandRegistry, getCommandRegistry } from '@zn-ai/zn-agent-core'
import {
  loadUserCommands,
  reloadUserCommands,
  defaultCommandsDirs,
} from '../../../src/server/services/commands/userLoader.js'
import { commandsDir as writerCommandsDir } from '../../../src/server/services/commands/fileStore.js'

let tmpHome: string
let commandsDir: string

// isolation harness 已全局设过 ZAI_DATA_DIR,必须原样恢复而不是 delete,
// 否则会污染同 worker 里的后续测试文件。
const SAVED_ZAI_DATA_DIR = process.env.ZAI_DATA_DIR

beforeEach(() => {
  setCommandRegistry(null)
  tmpHome = mkdtempSync(join(tmpdir(), 'zai-cmd-test-'))
  // zai patch (2026-10-17, cl-003):此前这里是 `tmpHome/.zai/commands`,
  // 而 writer(`fileStore.ts` 的 `commandsDir()`)写的是 `<dataDir>/commands`
  // —— 测试断言的形态恰好就是缺陷形态本身,把「写 A 读 B」钉成了契约。
  // 已与 writer 对齐;`ZAI_DATA_DIR` 在测试里也指向 tmpHome,
  // 于是 writer 的解析结果应当正好等于这个路径(见下方回归用例)。
  process.env.ZAI_DATA_DIR = tmpHome
  commandsDir = join(tmpHome, 'commands')
  mkdirSync(commandsDir, { recursive: true })
})

afterEach(() => {
  if (SAVED_ZAI_DATA_DIR === undefined) delete process.env.ZAI_DATA_DIR
  else process.env.ZAI_DATA_DIR = SAVED_ZAI_DATA_DIR
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

  it('merges project-level .zai/commands with home-level commands', async () => {
    const cwd = join(tmpHome, 'proj')
    const projDir = join(cwd, '.zai', 'commands')
    mkdirSync(projDir, { recursive: true })
    // home-level
    writeCommand('greet', { description: 'home' }, 'home body')
    // project-level
    writeFileSync(join(projDir, 'release.md'), '---\ndescription: "Release OpenCC"\n---\nbody', 'utf-8')
    const cmds = await loadUserCommands({ cwd, dataDir: tmpHome })
    const names = cmds.map((c) => c.name)
    expect(names).toContain('greet')
    expect(names).toContain('release')
  })

  it('project-level command overrides same-named home command', async () => {
    const cwd = join(tmpHome, 'proj2')
    const projDir = join(cwd, '.zai', 'commands')
    mkdirSync(projDir, { recursive: true })
    writeCommand('greet', { description: 'home greet' }, 'home')
    writeFileSync(join(projDir, 'greet.md'), '---\ndescription: "proj greet"\n---\nproj', 'utf-8')
    const cmds = await loadUserCommands({ cwd, dataDir: tmpHome })
    expect(cmds).toHaveLength(1)
    expect(cmds[0]!.description).toBe('proj greet')
  })
})

/**
 * cl-003 回归:writer 与 reader 必须解析到**同一个**目录。
 *
 * 修复前的形态:writer(`fileStore.ts` 的 `commandsDir()`)写
 * `<dataDir>/commands`,而 reader 拼的是 `<dataDir>/.zai/commands` —— 多了
 * 一层 `.zai`,扫不到就 `else if` 回落真实 `~/.zai/commands`。结果是**写 A
 * 读 B**:刚通过 API 创建的命令读不到,隔离实例反而静默继承了用户真实的
 * 全套全局命令。
 *
 * 这两个用例刻意**不传 `dataDir`**,让 reader 走 `resolveZaiDir()`,因为
 * 缺陷恰恰在「只有 env 生效」的那条路径上。
 */
describe('cl-003 回归:writer / reader 同源', () => {
  it('writer 的解析结果就是 reader 用的目录', () => {
    expect(writerCommandsDir()).toBe(commandsDir)
    expect(defaultCommandsDirs({})).toEqual([commandsDir])
  })

  it('走 resolveZaiDir() 也能读到 writer 写进去的命令', async () => {
    writeCommand('roundtrip', { description: 'written by writer' }, 'body')
    const cmds = await loadUserCommands({ cwd: '/nonexistent-cwd' })
    expect(cmds.map((c) => c.name)).toContain('roundtrip')
  })

  it('隔离实例解析出的目录全部落在隔离目录内,不回落到真实 home', () => {
    // 修复前:reader 多拼一层 `.zai` → 扫不到 → `dirs` 为空,
    // 下面的循环会**空转通过**。所以先断言非空,否则这条用例是假绿。
    const dirs = defaultCommandsDirs({})
    expect(dirs.length).toBeGreaterThan(0)
    for (const dir of dirs) {
      expect(dir.startsWith(tmpHome)).toBe(true)
    }
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