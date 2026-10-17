/**
 * 回归测试 — `ZAI_DATA_DIR` 必须真的隔离 zai 自己的数据 (oc-001 / cc-r2 / tc-002)。
 *
 * 背景:2026-10-16 的 bug-hunt 比赛发现 zai 各模块各写各的 `homedir()`,
 * 没有统一的目录解析函数。设了 `ZAI_DATA_DIR` 的实例**仍然**读写真实
 * `~/.zai/`。更严重的是 `zaiSettingsCache` 在 boot 期对任何缺 `permissions`
 * 块的用户无条件回填并落盘 —— 两个缺陷合并的效果是:
 * 一个设了 `ZAI_DATA_DIR` 的实例**启动即改写用户真实配置**。
 *
 * 本测试用哨兵实验(fix-plan §批2 验收条款):重定向 HOME 到临时目录并植入
 * 哨兵值,同时设 `ZAI_DATA_DIR`,断言:
 *   1. 读路径不返回哨兵值(证明没读假 HOME)
 *   2. 写路径落在 $ZAI_DATA_DIR 下(证明隔离生效)
 *   3. 假 HOME 的 mtime 不变(证明 boot 期没偷偷写真实配置)
 *
 * 刻意**不**覆盖这些(它们属于别的工具/项目级,覆盖是错的):
 *   `~/.claude/*`、`~/.nova/*`、`~/.zai.json`、`<cwd>/.zai/*`
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const REAL_HOME = process.env.HOME
let fakeHome: string
let dataDir: string

beforeEach(() => {
  fakeHome = mkdtempSync(join(tmpdir(), 'zai-fakehome-'))
  dataDir = mkdtempSync(join(tmpdir(), 'zai-datadir-'))
  // 假 HOME 里植入哨兵 settings.json —— 若隔离失效, 读路径会返回它
  mkdirSync(join(fakeHome, '.zai'), { recursive: true })
  writeFileSync(
    join(fakeHome, '.zai', 'settings.json'),
    JSON.stringify({ env: { ANTHROPIC_DEFAULT_SONNET_MODEL: 'SENTINEL-LEAKED' } }),
  )
})

afterEach(() => {
  process.env.HOME = REAL_HOME
  if (process.env.ZAI_DATA_DIR === dataDir) delete process.env.ZAI_DATA_DIR
  rmSync(fakeHome, { recursive: true, force: true })
  rmSync(dataDir, { recursive: true, force: true })
  vi.resetModules()
})

describe('zai 数据目录解析 (oc-001 / cc-r2 / tc-002)', () => {
  it('zaiSettingsPath() 必须在 ZAI_DATA_DIR 下,而不是 homedir()', async () => {
    process.env.HOME = fakeHome
    process.env.ZAI_DATA_DIR = dataDir
    vi.resetModules()
    const { zaiSettingsPath } = await import('../../src/server/services/zaiSettingsStore.js')
    expect(zaiSettingsPath()).toBe(join(dataDir, 'settings.json'))
    expect(zaiSettingsPath()).not.toContain(fakeHome)
  })

  it('readZaiSettings() 不返回假 HOME 的哨兵值', async () => {
    process.env.HOME = fakeHome
    process.env.ZAI_DATA_DIR = dataDir
    vi.resetModules()
    const { readZaiSettings } = await import('../../src/server/services/zaiSettingsStore.js')
    const settings = await readZaiSettings()
    // 隔离生效 → 读的是空的 $ZAI_DATA_DIR,拿不到假 HOME 的哨兵
    expect((settings as any)?.env?.ANTHROPIC_DEFAULT_SONNET_MODEL).not.toBe('SENTINEL-LEAKED')
  })

  it('写入落在 $ZAI_DATA_DIR,假 HOME 的 settings.json 不被触碰', async () => {
    process.env.HOME = fakeHome
    process.env.ZAI_DATA_DIR = dataDir
    vi.resetModules()
    const { writeZaiSettings } = await import('../../src/server/services/zaiSettingsStore.js')

    const sentinelFile = join(fakeHome, '.zai', 'settings.json')
    const before = statSync(sentinelFile).mtimeMs
    // 抹掉 mtime 精度差异,确保任何写都会被察觉
    utimesSync(sentinelFile, new Date(0), new Date(0))
    const zeroed = statSync(sentinelFile).mtimeMs

    await writeZaiSettings({ env: { ANTHROPIC_DEFAULT_SONNET_MODEL: 'written-by-test' } } as any)

    // 真配置写在隔离目录下
    expect(existsSync(join(dataDir, 'settings.json'))).toBe(true)
    expect(readFileSync(join(dataDir, 'settings.json'), 'utf-8')).toContain('written-by-test')
    // 假 HOME 的哨兵文件一个字节都没变
    expect(statSync(sentinelFile).mtimeMs).toBe(zeroed)
    expect(readFileSync(sentinelFile, 'utf-8')).toContain('SENTINEL-LEAKED')
    expect(before).toBeGreaterThan(0)
  })

  it('boot 期 permissions 回填不得写穿到 ZAI_DATA_DIR 之外 (cc-r2)', async () => {
    process.env.HOME = fakeHome
    process.env.ZAI_DATA_DIR = dataDir
    vi.resetModules()
    const { initZaiSettingsCache } = await import('../../src/server/services/zaiSettingsCache.js')

    const sentinelFile = join(fakeHome, '.zai', 'settings.json')
    utimesSync(sentinelFile, new Date(0), new Date(0))
    const zeroed = statSync(sentinelFile).mtimeMs

    await initZaiSettingsCache()

    // 回填必须落在隔离目录
    expect(existsSync(join(dataDir, 'settings.json'))).toBe(true)
    // 假 HOME 不得被自动写穿 —— 这正是 cc-r2 描述的用户数据被改写
    expect(statSync(sentinelFile).mtimeMs).toBe(zeroed)
    expect(readFileSync(sentinelFile, 'utf-8')).not.toContain('permissions')
  })
})
