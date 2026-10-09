import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { ServerEvent } from '../../../src/shared/events.js'

// updater.ts 测试要点:
//   1. dev 模式 (ZAI_FROM_GLOBAL_INSTALL !== '1') 直接 return,不调 npm view
//   2. SKIP_ENV=1 直接 return
//   3. settings.autoUpdate=false 跳过 npm view
//   4. 已最新 (current >= latest) → emit idle,不 install
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
const mockProbeWritable = vi.fn()

vi.mock('../../../src/server/services/detect.js', () => ({
  // 只导出测试需要的 getter,其它函数不模拟 — vi.fn() 默认返回 undefined
  getCliStatuses: (...args: unknown[]) => mockGetCliStatuses(...args),
}))

vi.mock('../../../src/server/services/spawner.js', () => ({
  spawn: (...args: unknown[]) => mockSpawn(...args),
  resolveSpawnCommand: vi.fn((cmd: string, args: string[]) => ({ command: cmd, args })),
}))

// 权限预检默认「可写」,让既有用例走原路径;单独的用例覆盖不可写分支。
// 不 mock 的话会真跑 `npm config get prefix`,慢且随环境漂。
vi.mock('../../../src/server/services/npmPermissions.js', () => ({
  probeGlobalPrefixWritable: (...args: unknown[]) => mockProbeWritable(...args),
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
  mockProbeWritable.mockReset()
  // 默认前缀可写 — 大多数用例只关心版本比较/安装本身。
  mockProbeWritable.mockResolvedValue({ writable: true, prefix: '/writable/prefix' })
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

  it('emits idle when current >= latest (no install, and checking is closed)', async () => {
    mockGetCliStatuses.mockResolvedValue([
      { name: 'zai', pkg: '@zn-ai/zai', bin: 'zai', installed: true,
        path: '/x', currentVersion: '0.3.11', latestVersion: '0.3.11' },
    ])

    const { maybeAutoUpdate } = await import('../../../src/server/services/updater.js')
    await maybeAutoUpdate()
    expect(mockGetCliStatuses).toHaveBeenCalledWith(true, 'zai')
    expect(mockSpawn).not.toHaveBeenCalled()
    // checking 必须有 idle 收尾:前端「正在检查」通知 duration:0,不发
    // 终态事件它就永久悬挂(HRMSV3-ZN-WEBSITE#668)。
    expect(recordedEvents.map((e) => e.type)).toEqual([
      'app.update.checking',
      'app.update.idle',
    ])
    const idle = recordedEvents.find((e) => e.type === 'app.update.idle') as Extract<ServerEvent, { type: 'app.update.idle' }>
    expect(idle.reason).toBe('up-to-date')
  })

  it('emits idle when getCliStatuses throws', async () => {
    mockGetCliStatuses.mockRejectedValue(new Error('npm registry unreachable'))

    const { maybeAutoUpdate } = await import('../../../src/server/services/updater.js')
    await maybeAutoUpdate()
    expect(recordedEvents.map((e) => e.type)).toEqual([
      'app.update.checking',
      'app.update.idle',
    ])
    const idle = recordedEvents.find((e) => e.type === 'app.update.idle') as Extract<ServerEvent, { type: 'app.update.idle' }>
    expect(idle.reason).toBe('check-failed')
  })

  it('emits idle when no cli status is returned', async () => {
    mockGetCliStatuses.mockResolvedValue([])

    const { maybeAutoUpdate } = await import('../../../src/server/services/updater.js')
    await maybeAutoUpdate()
    const idle = recordedEvents.find((e) => e.type === 'app.update.idle') as Extract<ServerEvent, { type: 'app.update.idle' }>
    expect(idle.reason).toBe('no-status')
  })

  it('emits idle when latest version is unknown (npm view failed)', async () => {
    mockGetCliStatuses.mockResolvedValue([
      { name: 'zai', pkg: '@zn-ai/zai', bin: 'zai', installed: true,
        path: '/x', currentVersion: '0.3.11', latestVersion: null },
    ])

    const { maybeAutoUpdate } = await import('../../../src/server/services/updater.js')
    await maybeAutoUpdate()
    const idle = recordedEvents.find((e) => e.type === 'app.update.idle') as Extract<ServerEvent, { type: 'app.update.idle' }>
    expect(idle.reason).toBe('no-version')
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

  it('emits failed (without spawning npm) when global prefix is not writable', async () => {
    mockGetCliStatuses.mockResolvedValue([
      { name: 'zai', pkg: '@zn-ai/zai', bin: 'zai', installed: true,
        path: '/x', currentVersion: '0.3.8', latestVersion: '0.3.11' },
    ])
    mockProbeWritable.mockResolvedValue({ writable: false, prefix: '/usr/local' })

    const { maybeAutoUpdate } = await import('../../../src/server/services/updater.js')
    await maybeAutoUpdate()

    // 关键:npm 完全没有被 spawn — 否则 npm 会自己往 root 目录写并喷堆栈。
    expect(mockSpawn).not.toHaveBeenCalled()
    expect(recordedEvents.map((e) => e.type)).toEqual([
      'app.update.checking',
      'app.update.failed',
    ])
    const failed = recordedEvents.find((e) => e.type === 'app.update.failed') as Extract<ServerEvent, { type: 'app.update.failed' }>
    expect(failed.from).toBe('0.3.8')
    expect(failed.to).toBe('0.3.11')
    // 消息要说人话:含出错的目录 + 手动补救命令,而不是 npm 原始堆栈。
    expect(failed.error).toContain('/usr/local')
    expect(failed.error).toContain('npm install -g @zn-ai/zai@0.3.11')
  })

  it('proceeds when prefix probe is inconclusive (writable=null)', async () => {
    mockGetCliStatuses.mockResolvedValue([
      { name: 'zai', pkg: '@zn-ai/zai', bin: 'zai', installed: true,
        path: '/x', currentVersion: '0.3.8', latestVersion: '0.3.11' },
    ])
    mockProbeWritable.mockResolvedValue({ writable: null, prefix: null })
    mockSpawn.mockResolvedValue({ code: 0, signal: null })

    const { maybeAutoUpdate } = await import('../../../src/server/services/updater.js')
    await maybeAutoUpdate()

    // 探测失败不能阻断升级 — 交给 npm 自己报错。
    expect(mockSpawn).toHaveBeenCalledTimes(1)
    expect(recordedEvents.map((e) => e.type)).toEqual([
      'app.update.checking',
      'app.update.installing',
      'app.update.complete',
    ])
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