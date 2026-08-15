import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { ServerEvent } from '../../../src/shared/events.js'

// updater.ts 测试要点:
//   1. dev 模式 (ZAI_FROM_GLOBAL_INSTALL !== '1') 直接 return,不调 npm view
//   2. SKIP_ENV=1 直接 return
//   3. settings.autoUpdate=false 跳过 npm view
//   4. 已最新 (current >= latest) 跳过 install
//   5. 有新版 → emit installing → (mock spawn) → emit complete
//   6. spawn 失败 → emit failed
//
// 实现策略:
//   - vi.mock services/detect.js → 用可控的 getCliStatuses
//   - vi.mock services/spawner.js → 用可控的 spawn
//   - 真实订阅 eventBus.subscribe 收集所有 emit,断言顺序与 payload
//   - ZAI_DATA_DIR / HOME 隔离到临时目录避免污染真实 ~/.zai/settings.json
//
// 各 case 都在同一 process 跑; maybeAutoUpdate 用 module-level bootPromise
// 缓存第二次调用 — 提供 __resetBootPromiseForTests() 在 beforeEach 重置。

let dataDir: string

const recordedEvents: ServerEvent[] = []
const eventListener = (e: ServerEvent) => recordedEvents.push(e)

// 模拟 getCliStatuses — 每个 case 单独覆盖返回值
const mockGetCliStatuses = vi.fn()
const mockSpawn = vi.fn()

vi.mock('../../../src/server/services/detect.js', () => ({
  // 只导出测试需要的 getter,其它函数不模拟 — vi.fn() 默认返回 undefined
  getCliStatuses: (...args: unknown[]) => mockGetCliStatuses(...args),
}))

vi.mock('../../../src/server/services/spawner.js', () => ({
  spawn: (...args: unknown[]) => mockSpawn(...args),
  resolveSpawnCommand: vi.fn((cmd: string, args: string[]) => ({ command: cmd, args })),
}))

beforeEach(async () => {
  dataDir = mkdtempSync(join(tmpdir(), 'zai-updater-'))
  process.env.ZAI_DATA_DIR = dataDir
  process.env.HOME = dataDir
  process.env.ZAI_FROM_GLOBAL_INSTALL = '1' // 默认开启全局模式,各 case 按需 unset
  delete process.env.ZAI_DISABLE_AUTO_UPDATE
  vi.resetModules()
  recordedEvents.length = 0
  mockGetCliStatuses.mockReset()
  mockSpawn.mockReset()
  const { eventBus } = await import('../../../src/server/services/eventBus.js')
  eventBus.subscribe(eventListener)
})

afterEach(() => {
  rmSync(dataDir, { recursive: true, force: true })
  delete process.env.ZAI_FROM_GLOBAL_INSTALL
  delete process.env.ZAI_DISABLE_AUTO_UPDATE
  delete process.env.ZAI_DATA_DIR
  delete process.env.HOME
})

describe('maybeAutoUpdate', () => {
  it('returns immediately in dev mode (ZAI_FROM_GLOBAL_INSTALL unset)', async () => {
    delete process.env.ZAI_FROM_GLOBAL_INSTALL
    vi.resetModules()
    const { maybeAutoUpdate } = await import('../../../src/server/services/updater.js')
    await maybeAutoUpdate()
    expect(mockGetCliStatuses).not.toHaveBeenCalled()
    expect(mockSpawn).not.toHaveBeenCalled()
    expect(recordedEvents).toEqual([])
  })

  it('returns immediately when ZAI_DISABLE_AUTO_UPDATE=1', async () => {
    process.env.ZAI_DISABLE_AUTO_UPDATE = '1'
    vi.resetModules()
    const { maybeAutoUpdate } = await import('../../../src/server/services/updater.js')
    await maybeAutoUpdate()
    expect(mockGetCliStatuses).not.toHaveBeenCalled()
    expect(mockSpawn).not.toHaveBeenCalled()
    expect(recordedEvents).toEqual([])
  })

  it('skips npm view when settings.autoUpdate=false', async () => {
    // 写一个 settings.json 到隔离 dataDir 标记 autoUpdate=false
    const { writeFileSync, mkdirSync } = await import('node:fs')
    mkdirSync(join(dataDir, '.zai'), { recursive: true })
    writeFileSync(join(dataDir, '.zai', 'settings.json'), JSON.stringify({ autoUpdate: false }))

    const { maybeAutoUpdate } = await import('../../../src/server/services/updater.js')
    await maybeAutoUpdate()
    expect(mockGetCliStatuses).not.toHaveBeenCalled()
    expect(mockSpawn).not.toHaveBeenCalled()
  })

  it('skips install when current >= latest (no events emitted besides checking)', async () => {
    mockGetCliStatuses.mockResolvedValue([
      { name: 'zai', pkg: '@zn-ai/zai', bin: 'zai', installed: true,
        path: '/x', currentVersion: '0.3.11', latestVersion: '0.3.11' },
    ])

    const { maybeAutoUpdate } = await import('../../../src/server/services/updater.js')
    await maybeAutoUpdate()
    expect(mockGetCliStatuses).toHaveBeenCalledWith(true, 'zai')
    expect(mockSpawn).not.toHaveBeenCalled()
    // 只发了 checking,没有 installing / complete / failed
    expect(recordedEvents.map((e) => e.type)).toEqual(['app.update.checking'])
  })

  it('emits installing + complete when newer version found and spawn succeeds', async () => {
    mockGetCliStatuses.mockResolvedValue([
      { name: 'zai', pkg: '@zn-ai/zai', bin: 'zai', installed: true,
        path: '/x', currentVersion: '0.3.8', latestVersion: '0.3.11' },
    ])
    mockSpawn.mockResolvedValue({ code: 0, signal: null })

    const { maybeAutoUpdate } = await import('../../../src/server/services/updater.js')
    await maybeAutoUpdate()

    // spawn 被调且 npm install -g @zn-ai/zai@0.3.11
    expect(mockSpawn).toHaveBeenCalledTimes(1)
    const [cmd, args] = mockSpawn.mock.calls[0]
    expect(cmd).toBe('npm')
    expect(args).toContain('install')
    expect(args).toContain('-g')
    expect(args).toContain('@zn-ai/zai@0.3.11')

    // 事件序列: checking → installing → complete
    expect(recordedEvents.map((e) => e.type)).toEqual([
      'app.update.checking',
      'app.update.installing',
      'app.update.complete',
    ])
    const installing = recordedEvents.find((e) => e.type === 'app.update.installing') as Extract<ServerEvent, { type: 'app.update.installing' }>
    expect(installing.from).toBe('0.3.8')
    expect(installing.to).toBe('0.3.11')
    const complete = recordedEvents.find((e) => e.type === 'app.update.complete') as Extract<ServerEvent, { type: 'app.update.complete' }>
    expect(complete.from).toBe('0.3.8')
    expect(complete.to).toBe('0.3.11')
  })

  it('emits failed when spawn exits non-zero', async () => {
    mockGetCliStatuses.mockResolvedValue([
      { name: 'zai', pkg: '@zn-ai/zai', bin: 'zai', installed: true,
        path: '/x', currentVersion: '0.3.8', latestVersion: '0.3.11' },
    ])
    mockSpawn.mockResolvedValue({ code: 1, signal: null })

    const { maybeAutoUpdate } = await import('../../../src/server/services/updater.js')
    await maybeAutoUpdate()

    expect(recordedEvents.map((e) => e.type)).toEqual([
      'app.update.checking',
      'app.update.installing',
      'app.update.failed',
    ])
    const failed = recordedEvents.find((e) => e.type === 'app.update.failed') as Extract<ServerEvent, { type: 'app.update.failed' }>
    expect(failed.from).toBe('0.3.8')
    expect(failed.to).toBe('0.3.11')
    expect(failed.error).toMatch(/exited with code 1/)
  })

  it('emits failed when spawn throws', async () => {
    mockGetCliStatuses.mockResolvedValue([
      { name: 'zai', pkg: '@zn-ai/zai', bin: 'zai', installed: true,
        path: '/x', currentVersion: '0.3.8', latestVersion: '0.3.11' },
    ])
    mockSpawn.mockRejectedValue(new Error('ENOSPC'))

    const { maybeAutoUpdate } = await import('../../../src/server/services/updater.js')
    await maybeAutoUpdate()

    expect(recordedEvents.map((e) => e.type)).toEqual([
      'app.update.checking',
      'app.update.installing',
      'app.update.failed',
    ])
    const failed = recordedEvents.find((e) => e.type === 'app.update.failed') as Extract<ServerEvent, { type: 'app.update.failed' }>
    expect(failed.error).toBe('Error: ENOSPC')
  })

  it('skips install on prerelease latest (does not parse semver with suffix)', async () => {
    // 0.4.0-beta.1 — isNewer 解析失败,返回 false,不升级
    mockGetCliStatuses.mockResolvedValue([
      { name: 'zai', pkg: '@zn-ai/zai', bin: 'zai', installed: true,
        path: '/x', currentVersion: '0.3.11', latestVersion: '0.4.0-beta.1' },
    ])

    const { maybeAutoUpdate } = await import('../../../src/server/services/updater.js')
    await maybeAutoUpdate()
    expect(mockSpawn).not.toHaveBeenCalled()
  })

  it('caches the boot promise across calls within same process', async () => {
    mockGetCliStatuses.mockResolvedValue([
      { name: 'zai', pkg: '@zn-ai/zai', bin: 'zai', installed: true,
        path: '/x', currentVersion: '0.3.11', latestVersion: '0.3.11' },
    ])

    const { maybeAutoUpdate } = await import('../../../src/server/services/updater.js')
    await maybeAutoUpdate()
    await maybeAutoUpdate()
    await maybeAutoUpdate()
    // 即使调三次,getCliStatuses 只跑一次 — bootPromise 命中
    expect(mockGetCliStatuses).toHaveBeenCalledTimes(1)
  })
})

describe('isNewer', () => {
  it('returns true when latest > current (patch bump)', async () => {
    const { isNewer } = await import('../../../src/server/services/updater.js')
    expect(isNewer('0.3.11', '0.3.10')).toBe(true)
  })

  it('returns true when latest > current (minor bump)', async () => {
    const { isNewer } = await import('../../../src/server/services/updater.js')
    expect(isNewer('0.4.0', '0.3.99')).toBe(true)
  })

  it('returns false when equal', async () => {
    const { isNewer } = await import('../../../src/server/services/updater.js')
    expect(isNewer('0.3.11', '0.3.11')).toBe(false)
  })

  it('returns false when latest < current (already on newer than registry)', async () => {
    const { isNewer } = await import('../../../src/server/services/updater.js')
    expect(isNewer('0.3.10', '0.3.11')).toBe(false)
  })

  it('returns false when versions unparseable (prerelease/build)', async () => {
    const { isNewer } = await import('../../../src/server/services/updater.js')
    expect(isNewer('0.4.0-beta.1', '0.3.11')).toBe(false)
    expect(isNewer('not-a-version', '0.3.11')).toBe(false)
  })

  it('strips leading v', async () => {
    const { isNewer } = await import('../../../src/server/services/updater.js')
    expect(isNewer('v1.2.3', 'v1.2.2')).toBe(true)
  })
})