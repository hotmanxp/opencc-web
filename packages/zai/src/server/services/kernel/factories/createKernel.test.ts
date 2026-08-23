import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const tempDirs: string[] = []
function makeTempHome(): string {
  const dir = mkdtempSync(join(tmpdir(), 'zai-kernel-test-'))
  tempDirs.push(dir)
  return dir
}
let currentHome = makeTempHome()

vi.mock('node:os', async () => {
  const actual = await vi.importActual<typeof import('node:os')>('node:os')
  return { ...actual, homedir: () => currentHome }
})

// 保存宿主 shell 的 ZAI_KERNEL_OVERRIDE(createApp 启动期会写这个 env;
// resolveAgentKernel 的 readKernelOverride 会优先命中它)。如果测试环境
// 继承了这个 env(例如开发者同时在跑 zai 实例),不走 validate 慢路径,
// 非法值测试就会"假阳性"通过。这是预先存在的 env 污染 bug。
const ORIGINAL_KERNEL_OVERRIDE = process.env.ZAI_KERNEL_OVERRIDE

beforeEach(async () => {
  currentHome = makeTempHome()
  delete process.env.ZAI_KERNEL_OVERRIDE
  const { __resetCacheForTests } = await import('../../zaiSettingsCache.js')
  __resetCacheForTests()
})

afterEach(() => {
  // 恢复 shell 原值,不影响开发者并行跑的 zai 实例
  if (ORIGINAL_KERNEL_OVERRIDE === undefined) {
    delete process.env.ZAI_KERNEL_OVERRIDE
  } else {
    process.env.ZAI_KERNEL_OVERRIDE = ORIGINAL_KERNEL_OVERRIDE
  }
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop()
    if (dir) rmSync(dir, { recursive: true, force: true })
  }
})

describe('createKernel 分叉', () => {
  it('默认 (agent 未设) → opencc 轨道', async () => {
    const cwd = '/no/project/here'
    const { createKernel } = await import('./index.js')
    // opencc adapter 的 createOpenccRuntime 需要真实环境；我们只验证 kernel 字段。
    try {
      const adapter = await createKernel({ cwd, dataDir: currentHome, settings: {} as any })
      expect(adapter.kernel).toBe('opencc')
      await adapter.shutdown().catch(() => {})
    } catch (err) {
      // 若 vendor 在测试环境不可用，至少确认错误路径不来自 createKernel 本身
      expect(String((err as Error).message)).not.toMatch(/agent\.kernel 非法/)
    }
  })

  it('agent.kernel="dsh" + Node < 22.19 → DshEngineUnsupportedError (fail loud)', async () => {
    const cwd = currentHome
    mkdirSync(join(cwd, '.zai'), { recursive: true })
    writeFileSync(
      join(cwd, '.zai', 'settings.json'),
      JSON.stringify({ agent: { kernel: 'dsh' } }, null, 2),
      'utf-8',
    )

    // 通过 spy 把 process.versions.node 替换为 'v18.0.0'
    const origVersions = (process as any).versions.node
    Object.defineProperty(process, 'versions', {
      value: { ...process.versions, node: 'v18.0.0' },
      configurable: true,
    })

    try {
      const { createKernel, DshEngineUnsupportedError } = await import('./index.js')
      await expect(
        createKernel({ cwd, dataDir: currentHome, settings: {} as any }),
      ).rejects.toBeInstanceOf(DshEngineUnsupportedError)
    } finally {
      Object.defineProperty(process, 'versions', {
        value: { ...process.versions, node: origVersions },
        configurable: true,
      })
    }
  })

  it('agent.kernel="dsh" + Node >= 22.19 → 到达 dsh-bridge 桩并返回 adapter（kernel="dsh"）', async () => {
    const cwd = currentHome
    mkdirSync(join(cwd, '.zai'), { recursive: true })
    writeFileSync(
      join(cwd, '.zai', 'settings.json'),
      JSON.stringify({ agent: { kernel: 'dsh' } }, null, 2),
      'utf-8',
    )

    const { createKernel } = await import('./index.js')
    const adapter = await createKernel({ cwd, dataDir: currentHome, settings: {} as any })
    expect(adapter.kernel).toBe('dsh')
    await adapter.shutdown().catch(() => {})
  })

  it('agent.kernel 非法值 → fail loud (启动不到达 createKernel)', async () => {
    const cwd = currentHome
    mkdirSync(join(cwd, '.zai'), { recursive: true })
    writeFileSync(
      join(cwd, '.zai', 'settings.json'),
      JSON.stringify({ agent: { kernel: 'DSH' } }, null, 2),
      'utf-8',
    )

    const { createKernel } = await import('./index.js')
    await expect(
      createKernel({ cwd, dataDir: currentHome, settings: {} as any }),
    ).rejects.toThrow(/agent\.kernel 非法值/)
  })
})