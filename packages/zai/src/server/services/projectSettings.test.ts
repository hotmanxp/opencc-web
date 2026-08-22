import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const tempDirs: string[] = []

function makeTempHome(): string {
  const dir = mkdtempSync(join(tmpdir(), 'zai-project-settings-test-'))
  tempDirs.push(dir)
  return dir
}

let currentHome = makeTempHome()

vi.mock('node:os', async () => {
  const actual = await vi.importActual<typeof import('node:os')>('node:os')
  return {
    ...actual,
    homedir: () => currentHome,
  }
})

beforeEach(async () => {
  currentHome = makeTempHome()
  const { __resetCacheForTests } = await import('./zaiSettingsCache.js')
  __resetCacheForTests()
})

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop()
    if (dir) rmSync(dir, { recursive: true, force: true })
  }
})

describe('projectSettings', () => {
  it('projectSettingsPath 拼装为 <cwd>/.zai/settings.json', async () => {
    const { projectSettingsPath } = await import('./projectSettings.js')
    expect(projectSettingsPath('/work/proj')).toBe(join('/work/proj', '.zai', 'settings.json'))
  })

  it('无项目级文件时 resolveProjectAwareSettings 返回用户级（builtin default）', async () => {
    const { resolveProjectAwareSettings } = await import('./projectSettings.js')
    const cwd = '/no/project/settings/here'
    const settings = await resolveProjectAwareSettings(cwd)
    // 用户级是 builtin default + permissions backfill；不应含 agent 字段
    expect(settings.agent).toBeUndefined()
  })

  it('项目级覆盖用户级 — agent.kernel=dysh 透传', async () => {
    // 写项目级 settings.json
    const cwd = currentHome
    mkdirSync(join(cwd, '.zai'), { recursive: true })
    writeFileSync(
      join(cwd, '.zai', 'settings.json'),
      JSON.stringify({ agent: { kernel: 'dsh' } }, null, 2),
      'utf-8',
    )

    const { resolveProjectAwareSettings, resolveAgentKernel } = await import('./projectSettings.js')
    const settings = await resolveProjectAwareSettings(cwd)
    expect(settings.agent?.kernel).toBe('dsh')
    expect(await resolveAgentKernel(cwd)).toBe('dsh')
  })

  it('三层合并：项目级 + 用户级都有字段时项目级胜出', async () => {
    // 用户级设置 theme
    const { writeZaiSettings } = await import('./zaiSettingsStore.js')
    await writeZaiSettings({ theme: 'light', outputStyle: 'compact' })

    // 项目级覆盖 agent.kernel 和 outputStyle
    const cwd = currentHome
    mkdirSync(join(cwd, '.zai'), { recursive: true })
    writeFileSync(
      join(cwd, '.zai', 'settings.json'),
      JSON.stringify({ agent: { kernel: 'dsh' }, outputStyle: 'default' }, null, 2),
      'utf-8',
    )

    const { resolveProjectAwareSettings } = await import('./projectSettings.js')
    const settings = await resolveProjectAwareSettings(cwd)
    expect(settings.theme).toBe('light')           // 来自用户级
    expect(settings.outputStyle).toBe('default')   // 项目级覆盖
    expect(settings.agent?.kernel).toBe('dsh')     // 项目级独有
  })

  it('非法 agent.kernel 抛 InvalidAgentKernelError（fail loud）', async () => {
    const cwd = currentHome
    mkdirSync(join(cwd, '.zai'), { recursive: true })
    writeFileSync(
      join(cwd, '.zai', 'settings.json'),
      JSON.stringify({ agent: { kernel: 'DSH' } }, null, 2),
      'utf-8',
    )

    const { resolveProjectAwareSettings, InvalidAgentKernelError } = await import('./projectSettings.js')
    await expect(resolveProjectAwareSettings(cwd)).rejects.toBeInstanceOf(InvalidAgentKernelError)
  })

  it('非法 agent.kernel 包含修复指引文本', async () => {
    const { InvalidAgentKernelError } = await import('./projectSettings.js')
    const err = new InvalidAgentKernelError('DSH')
    expect(err.message).toMatch(/合法值/)
    expect(err.message).toMatch(/opencc|dsh/)
    expect(err.message).toMatch(/restart|重启/)
  })

  it("resolveAgentKernel 默认 'opencc' 当 agent 字段未设置", async () => {
    const cwd = '/no/project/here'
    const { resolveAgentKernel } = await import('./projectSettings.js')
    expect(await resolveAgentKernel(cwd)).toBe('opencc')
  })

  it('项目级 JSON 损坏 → 走用户级（不抛）', async () => {
    const cwd = currentHome
    mkdirSync(join(cwd, '.zai'), { recursive: true })
    writeFileSync(join(cwd, '.zai', 'settings.json'), '{not json', 'utf-8')

    const { resolveProjectAwareSettings } = await import('./projectSettings.js')
    const settings = await resolveProjectAwareSettings(cwd)
    // 用户级 builtin default，不抛错
    expect(settings).toBeDefined()
  })

  it('writeProjectSettings 原子写到 <cwd>/.zai/settings.json', async () => {
    const cwd = currentHome
    const { writeProjectSettings } = await import('./projectSettings.js')
    await writeProjectSettings(cwd, { agent: { kernel: 'dsh' } })
    // 回读确认
    const raw = await import('node:fs/promises').then(({ readFile }) =>
      readFile(join(cwd, '.zai', 'settings.json'), 'utf-8'),
    )
    expect(JSON.parse(raw)).toEqual({ agent: { kernel: 'dsh' } })
  })
})

describe('CLI --kernel override (ZAI_KERNEL_OVERRIDE env)', () => {
  // env 是进程级单例,所有测试共享同一份 process.env。每个用例前后清理避免互相污染。
  const ORIGINAL_ENV = process.env.ZAI_KERNEL_OVERRIDE

  beforeEach(() => {
    delete process.env.ZAI_KERNEL_OVERRIDE
  })
  afterEach(() => {
    if (ORIGINAL_ENV === undefined) {
      delete process.env.ZAI_KERNEL_OVERRIDE
    } else {
      process.env.ZAI_KERNEL_OVERRIDE = ORIGINAL_ENV
    }
  })

  it('readKernelOverride: env 未设 → undefined', async () => {
    const { readKernelOverride } = await import('./projectSettings.js')
    expect(readKernelOverride()).toBeUndefined()
  })

  it('readKernelOverride: env="opencc" → "opencc"', async () => {
    process.env.ZAI_KERNEL_OVERRIDE = 'opencc'
    const { readKernelOverride } = await import('./projectSettings.js')
    expect(readKernelOverride()).toBe('opencc')
  })

  it('readKernelOverride: env="dsh" → "dsh"', async () => {
    process.env.ZAI_KERNEL_OVERRIDE = 'dsh'
    const { readKernelOverride } = await import('./projectSettings.js')
    expect(readKernelOverride()).toBe('dsh')
  })

  it('readKernelOverride: env="DSH" 大小写敏感 → 抛 InvalidAgentKernelError', async () => {
    process.env.ZAI_KERNEL_OVERRIDE = 'DSH'
    const { readKernelOverride, InvalidAgentKernelError } = await import('./projectSettings.js')
    expect(() => readKernelOverride()).toThrow(InvalidAgentKernelError)
  })

  it('resolveAgentKernel: --kernel=dsh 覆盖 settings.agent.kernel=opencc', async () => {
    // 用户级写 opencc,env 写 dsh,env 胜
    const { writeZaiSettings } = await import('./zaiSettingsStore.js')
    await writeZaiSettings({ agent: { kernel: 'opencc' } })

    process.env.ZAI_KERNEL_OVERRIDE = 'dsh'
    const { resolveAgentKernel } = await import('./projectSettings.js')
    expect(await resolveAgentKernel('/any/cwd')).toBe('dsh')
  })

  it('resolveAgentKernel: 无 env 时仍按 settings 解析', async () => {
    // 用户级写 dsh,env 无 → settings 胜
    const { writeZaiSettings } = await import('./zaiSettingsStore.js')
    await writeZaiSettings({ agent: { kernel: 'dsh' } })

    const { resolveAgentKernel } = await import('./projectSettings.js')
    expect(await resolveAgentKernel('/any/cwd')).toBe('dsh')
  })
})