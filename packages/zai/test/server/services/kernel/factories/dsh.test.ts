/**
 * Task 9 — `factories/dsh.ts` 注入 SeamRegistry + getSeam 接口的集成测试。
 *
 * 目标：调 `createDshKernelAdapter` 后,产物 KernelAdapter 上
 *   - `kernel.getSeam('subagent')` 可解析(返回非 undefined 对象)
 *   - `kernel.getSeam('jobs')` 可解析
 *   - `kernel.seamRegistry.has('subagent' | 'jobs')` 都 true
 *
 * 不去 spin 真 dsh runtime — 把 `bridge.createDshRuntime` / `registerZaiTools` /
 * `installInteractionBridges` 等 P0 装配层 mock 掉,只验证 factory 装配
 * 顺序能把 seam 注入到产物 adapter。
 *
 * **Step 1 (failing test) → Step 3 实现后该通过**。
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// 在 import 工厂前先把 dsh-bridge mock 掉,避免 module-level `await import()`
// 真的去装配 dsh runtime。
vi.mock('@zn-ai/dsh-bridge', () => {
  const mockHandle = {
    ctx: {
      // minimal mock — bindSeams 内部 DshSubagentControlAdapter 走
      // `ctx.on('subagent/start' | 'subagent/end')` 订阅,这里返回 no-op disposer。
      on: () => () => undefined,
      get: () => undefined,
      // bindSeams 不直接用 plugin / scope,留空防 missing。
      plugin: () => () => undefined,
      scope: () => ({ plugin: () => () => undefined }),
    },
    start: async () => undefined,
    shutdown: async () => undefined,
  }
  return {
    // 工厂主入口
    createDshRuntime: async () => mockHandle,
    // registerZaiTools / installInteractionBridges / installSlashCommands /
    // installZaiPlugins / registerAskUserProvider / registerAskUserTool 都 no-op。
    registerZaiTools: async () => () => undefined,
    installInteractionBridges: () => ({
      setSink: () => undefined,
      dispose: () => undefined,
    }),
    installSlashCommands: () => () => undefined,
    installZaiPlugins: async () => () => undefined,
    registerAskUserProvider: () => () => undefined,
    registerAskUserTool: () => () => undefined,
    // runOnce 走空生成器 + 翻译 no-op
    runOnce: async function* () {
      // empty
    },
    translateSessionEvent: () => null,
    // DshTranscriptAdapter 是 list/deleteSession 路径要用的
    DshTranscriptAdapter: class {
      constructor() {}
      async list() {
        return []
      }
      async remove() {
        return undefined
      }
    },
    // vendorSeam adapters — factory 通过 `bindSeams({ registry, ctx, ... })`
    // 实例化这两个。bindSeams 内部 `new DshSubagentControlAdapter(...)` /
    // `new DshJobsControlAdapter(...)`。我们这里 mock 掉它们的构造行为,
    // 只确认 factory 把 seam 注册到了 registry 上。
    DshSubagentControlAdapter: class {
      constructor(_opts: unknown) {}
      destroy() {}
      list() {
        return Promise.resolve([])
      }
      dispatch() {
        return Promise.resolve({ ok: true })
      }
      onChange() {
        return () => undefined
      }
    },
    DshJobsControlAdapter: class {
      constructor(_opts: unknown) {}
      destroy() {}
      list() {
        return Promise.resolve([])
      }
      onChange() {
        return () => undefined
      }
    },
    // model selection
    createModelSelectionRef: (init?: { provider: string; model: string }) => ({
      current: init,
      assembled: undefined as unknown,
    }),
    ReasoningEffortId: undefined,
    SessionId: (s: string) => s,
    createUserMessage: (msg: unknown) => msg,
  }
})

// globalThis 桥里的 `__zaiEventBus` factory 内 `askUserSink` 也会读,先打桩。
;(globalThis as { __zaiEventBus?: { emit: (e: unknown) => void } }).__zaiEventBus = {
  emit: () => undefined,
}

describe('createDshKernelAdapter — Task 9 seam 注入', () => {
  beforeEach(async () => {
    // 重置 factory 内部的 module-level singleton,避免上一次跑残留。
    const mod = await import(
      '../../../../../src/server/services/kernel/factories/dsh.js' as string
    )
    ;(mod as { __resetDshContextForTests?: () => void }).__resetDshContextForTests?.()
  })

  afterEach(() => {
    vi.clearAllMocks()
  })

  it('产物 adapter.seamRegistry 注册了 subagent + jobs;adapter.getSeam 可解析', async () => {
    const { createDshKernelAdapter } = await import(
      '../../../../../src/server/services/kernel/factories/dsh.js' as string
    )

    const adapter = await createDshKernelAdapter({
      cwd: '/tmp',
      dataDir: '/tmp/.zai-data',
      settings: {
        model: 'MiniMax-M3',
      } as never,
    })

    // seamRegistry 已注入,subagent + jobs 两个 seam 都被注册
    expect(adapter.seamRegistry).toBeDefined()
    expect(adapter.seamRegistry!.has('subagent')).toBe(true)
    expect(adapter.seamRegistry!.has('jobs')).toBe(true)

    // getSeam 是 typed accessor — 返回非 undefined 对象(具体 adapter
    // 类型在 dsh-bridge 内,这里只用 unknown 校验存在性)。
    const subagent = adapter.getSeam?.('subagent')
    const jobs = adapter.getSeam?.('jobs')
    expect(subagent).toBeDefined()
    expect(jobs).toBeDefined()

    // cleanup — 避免下一 test 撞上 active dsh ctx。
    await adapter.shutdown()
  })
})