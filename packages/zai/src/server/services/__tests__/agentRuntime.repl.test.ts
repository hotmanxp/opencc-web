// @ts-nocheck
import { initAgentRuntime, getRuntime } from '../agentRuntime.js'

describe('agentRuntime ReplRuntime shape (阶段 3:runtimeCore 概念移除,只验 ReplRuntime)', () => {
  beforeEach(async () => {
    // 阶段 3(2026-09-12):`initAgentRuntime` 不再读 ZAI_RUNTIME_CORE env,
    // 永远走 REPL 路径(createOpenccRuntime → ReplRuntime 包装)。
    // Note: brief wrote `initAgentRuntime({ cwd: process.cwd() })` but
    // the actual signature is `initAgentRuntime(cwd: string, isSdk?)`.
    // Passing the object crashes on the post-runtime `initCommands` call
    // (`path argument must be of type string`); passing the bare cwd
    // string routes through ReplRuntime as the brief intends.
    await initAgentRuntime(process.cwd())
  })

  afterEach(() => {
    // 阶段 3 兼容:无 env 可清,afterEach 保留为 no-op 占位。
  })

  it('returns a ReplRuntime instance', () => {
    const runtime = getRuntime()
    expect(runtime).toBeDefined()
    expect(runtime.constructor.name).toBe('ReplRuntime')
  })

  it('repl runtime exposes submit + enqueue + interrupt', () => {
    const runtime = getRuntime() as any
    expect(typeof runtime.query).toBe('function')
    expect(typeof runtime.abort).toBe('function')
    expect(typeof runtime.enqueue).toBe('function')
    expect(typeof runtime.interrupt).toBe('function')
  })

  // zai patch (2026-09-06, plugin crash fix): ReplRuntime 必须提供 `plugins`
  // 字段,否则 routes/plugins.ts 的 r.plugins.listAvailable() 会 500
  // (Cannot read properties of undefined)。fallback stub 不注入
  // sharedRuntime 时生效,保证前端"插件管理"tab 永远能加载。
  it('repl runtime exposes plugins stub with full OpenccPluginApi shape', async () => {
    const runtime = getRuntime() as any
    expect(runtime.plugins).toBeDefined()
    expect(typeof runtime.plugins.listInstalled).toBe('function')
    expect(typeof runtime.plugins.listAvailable).toBe('function')
    expect(typeof runtime.plugins.setEnabled).toBe('function')
    expect(typeof runtime.plugins.install).toBe('function')
    expect(typeof runtime.plugins.uninstall).toBe('function')
    expect(typeof runtime.plugins.update).toBe('function')
    expect(typeof runtime.plugins.reload).toBe('function')
    expect(typeof runtime.plugins.listMarketplaces).toBe('function')
    expect(typeof runtime.plugins.addMarketplace).toBe('function')

    // listAvailable 在 fallback stub 路径返回空数组,前端不崩。
    const available = await runtime.plugins.listAvailable()
    expect(Array.isArray(available)).toBe(true)
  })
})
