import { afterEach, beforeAll, afterAll, describe, expect, it } from 'vitest'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  CORE_FACTORY_SETTINGS_DEFAULTS,
  coreFactorySettingsPath,
  readCoreFactorySettings,
} from '../../src/opencc-src/server/factorySettingsCore.js'
import { taskFactorySettingsSection } from '../../src/opencc-src/server/mainAgents-taskFactory.js'

let dir: string

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), 'core-fs-'))
  process.env.ZAI_DATA_DIR = dir
})

afterAll(async () => {
  delete process.env.ZAI_DATA_DIR
  await rm(dir, { recursive: true, force: true })
})

afterEach(async () => {
  await rm(coreFactorySettingsPath(), { force: true })
})

describe('readCoreFactorySettings', () => {
  it('文件缺失 → 全默认值(纯 core 环境 no-op)', () => {
    expect(readCoreFactorySettings()).toEqual(CORE_FACTORY_SETTINGS_DEFAULTS)
  })

  it('坏 JSON → 全默认值', async () => {
    await writeFile(coreFactorySettingsPath(), '{oops', 'utf-8')
    expect(readCoreFactorySettings()).toEqual(CORE_FACTORY_SETTINGS_DEFAULTS)
  })

  it('合法字段读取,非法值逐字段回落', async () => {
    await writeFile(
      coreFactorySettingsPath(),
      JSON.stringify({
        docsDir: '/tmp/d',
        repoRoot: '/tmp/r',
        maxParallelTasks: 6,
        preferSpawnAgent: 'dsh',
      }),
      'utf-8',
    )
    expect(readCoreFactorySettings()).toEqual({
      docsDir: '/tmp/d',
      repoRoot: '/tmp/r',
      maxParallelTasks: 6,
      preferSpawnAgent: 'dsh',
    })
    await writeFile(
      coreFactorySettingsPath(),
      JSON.stringify({ maxParallelTasks: 42, preferSpawnAgent: 'nope' }),
      'utf-8',
    )
    const s = readCoreFactorySettings()
    expect(s.maxParallelTasks).toBe(4)
    expect(s.preferSpawnAgent).toBeNull()
  })
})

describe('taskFactorySettingsSection', () => {
  it('默认值 → 仅并行上限行,无 repoRoot/preferSpawnAgent 行', () => {
    const lines = taskFactorySettingsSection(CORE_FACTORY_SETTINGS_DEFAULTS)
    const text = lines.join('\n')
    expect(text).toContain('at most 4 tasks may execute concurrently')
    expect(text).not.toContain('Preferred repo root')
    expect(text).not.toContain('Preferred spawnAgent')
  })

  it('配置值注入:maxParallelTasks / repoRoot / preferSpawnAgent 全部出现', () => {
    const lines = taskFactorySettingsSection({
      docsDir: '',
      repoRoot: '/work/repos',
      maxParallelTasks: 3,
      preferSpawnAgent: 'opencc',
    })
    const text = lines.join('\n')
    expect(text).toContain('at most 3 tasks may execute concurrently')
    expect(text).toContain('/work/repos')
    expect(text).toContain('prefer "opencc"')
  })
})
