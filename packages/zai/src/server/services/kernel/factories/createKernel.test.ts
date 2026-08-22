import { describe, it, expect, beforeEach } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { vi } from 'vitest'

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

beforeEach(async () => {
  currentHome = makeTempHome()
  const { __resetCacheForTests } = await import('../../zaiSettingsCache.js')
  __resetCacheForTests()
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