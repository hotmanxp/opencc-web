import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { mkdtemp, rm, writeFile, readFile, mkdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  FactorySettingsValidationError,
  FACTORY_SETTINGS_DEFAULTS,
  __resetForTests,
  factorySettingsPath,
  getFactorySettings,
  getFactorySettingsSync,
  setFactorySettings,
} from '../../../src/server/services/factorySettings.js'

let dir: string

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), 'factory-settings-'))
  process.env.ZAI_DATA_DIR = dir
})

afterAll(async () => {
  delete process.env.ZAI_DATA_DIR
  await rm(dir, { recursive: true, force: true })
})

beforeEach(() => {
  __resetForTests()
})

afterEach(async () => {
  await rm(factorySettingsPath(), { force: true })
  __resetForTests()
})

describe('factorySettings.getFactorySettings', () => {
  it('文件缺失 → 回落默认值', async () => {
    const s = await getFactorySettings()
    expect(s).toEqual(FACTORY_SETTINGS_DEFAULTS)
  })

  it('非法 JSON → 回落默认值(不抛)', async () => {
    await writeFile(factorySettingsPath(), '{ not json', 'utf-8')
    const s = await getFactorySettings()
    expect(s).toEqual(FACTORY_SETTINGS_DEFAULTS)
  })

  it('字段缺失 → 缺失项回落默认;非法值(并行数 9)逐字段回落', async () => {
    await writeFile(
      factorySettingsPath(),
      JSON.stringify({ docsDir: '/tmp/docs', maxParallelTasks: 9, preferSpawnAgent: 'nope' }),
      'utf-8',
    )
    const s = await getFactorySettings()
    expect(s.docsDir).toBe('/tmp/docs')
    expect(s.repoRoot).toBe('')
    expect(s.maxParallelTasks).toBe(4)
    expect(s.preferSpawnAgent).toBeNull()
    expect(s.historyArchiveHours).toBe(48)
  })

  it('sanitize 认 opencode 为合法 preferSpawnAgent(2026-09-03 provider 扩展)', async () => {
    await writeFile(
      factorySettingsPath(),
      JSON.stringify({ preferSpawnAgent: 'opencode' }),
      'utf-8',
    )
    const s = await getFactorySettings()
    expect(s.preferSpawnAgent).toBe('opencode')
  })

  it('historyArchiveHours 非法(0/8761/非整数/字符串)→ 回落 48;合法值保留', async () => {
    for (const bad of [0, 8761, 12.5, '72']) {
      await writeFile(factorySettingsPath(), JSON.stringify({ historyArchiveHours: bad }), 'utf-8')
      expect((await getFactorySettings()).historyArchiveHours).toBe(48)
    }
    await writeFile(factorySettingsPath(), JSON.stringify({ historyArchiveHours: 72 }), 'utf-8')
    expect((await getFactorySettings()).historyArchiveHours).toBe(72)
  })
})

describe('factorySettings.setFactorySettings', () => {
  it('patch 合并 + 持久化,重读(清缓存)保持', async () => {
    await setFactorySettings({ maxParallelTasks: 6 })
    await setFactorySettings({ docsDir: '/tmp/d', preferSpawnAgent: 'dsh' })
    __resetForTests()
    const s = await getFactorySettings()
    expect(s.maxParallelTasks).toBe(6)
    expect(s.docsDir).toBe('/tmp/d')
    expect(s.preferSpawnAgent).toBe('dsh')
    expect(s.repoRoot).toBe('')
  })

  it('preferSpawnAgent opencode 合法并可持久化', async () => {
    await setFactorySettings({ preferSpawnAgent: 'opencode' })
    __resetForTests()
    const s = await getFactorySettings()
    expect(s.preferSpawnAgent).toBe('opencode')
  })

  it('preferSpawnAgent 显式 null 可清除已选值', async () => {
    await setFactorySettings({ preferSpawnAgent: 'opencc' })
    const s = await setFactorySettings({ preferSpawnAgent: null })
    expect(s.preferSpawnAgent).toBeNull()
  })

  it('非法值(maxParallelTasks=1 / 9 / 非整数)拒绝且不落盘', async () => {
    await expect(setFactorySettings({ maxParallelTasks: 1 })).rejects.toBeInstanceOf(
      FactorySettingsValidationError,
    )
    await expect(setFactorySettings({ maxParallelTasks: 9 })).rejects.toBeInstanceOf(
      FactorySettingsValidationError,
    )
    await expect(setFactorySettings({ maxParallelTasks: 3.5 })).rejects.toBeInstanceOf(
      FactorySettingsValidationError,
    )
    let exists = true
    try {
      await readFile(factorySettingsPath(), 'utf-8')
    } catch {
      exists = false
    }
    expect(exists).toBe(false)
  })

  it('非法枚举值拒绝', async () => {
    await expect(
      setFactorySettings({ preferSpawnAgent: 'codex' as 'opencc' }),
    ).rejects.toBeInstanceOf(FactorySettingsValidationError)
  })

  it('historyArchiveHours patch 持久化;越界/非整数拒绝且不落盘改动', async () => {
    const s = await setFactorySettings({ historyArchiveHours: 24 })
    expect(s.historyArchiveHours).toBe(24)
    __resetForTests()
    expect((await getFactorySettings()).historyArchiveHours).toBe(24)
    await expect(setFactorySettings({ historyArchiveHours: 0 })).rejects.toBeInstanceOf(
      FactorySettingsValidationError,
    )
    await expect(setFactorySettings({ historyArchiveHours: 8761 })).rejects.toBeInstanceOf(
      FactorySettingsValidationError,
    )
    await expect(setFactorySettings({ historyArchiveHours: 2.5 })).rejects.toBeInstanceOf(
      FactorySettingsValidationError,
    )
    __resetForTests()
    expect((await getFactorySettings()).historyArchiveHours).toBe(24)
  })

  it('缓存: get 后 sync 读命中最新值', async () => {
    await setFactorySettings({ repoRoot: '/tmp/repo' })
    expect(getFactorySettingsSync().repoRoot).toBe('/tmp/repo')
    await getFactorySettings()
    expect(getFactorySettingsSync().repoRoot).toBe('/tmp/repo')
  })
})
