/**
 * resolveRuntimeCore 单测(spec 2026-08-30 §5.1:未配置时兜底从 'default'
 * 翻为 'repl')。agentRuntime 模块级静态 import 会拉起 @zn-ai/zn-agent-core
 * (冷启动 transform ~5s),沿用 agent-runtime-server.test.ts 的宽松超时。
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { ZaiSettings } from '../../src/shared/settings.js'

const TEST_TIMEOUT_MS = 90_000

describe('resolveRuntimeCore (agentRuntime priority chain)', () => {
  let prevRuntimeCore: string | undefined

  beforeEach(() => {
    prevRuntimeCore = process.env.ZAI_RUNTIME_CORE
    delete process.env.ZAI_RUNTIME_CORE
  })

  afterEach(() => {
    if (prevRuntimeCore === undefined) delete process.env.ZAI_RUNTIME_CORE
    else process.env.ZAI_RUNTIME_CORE = prevRuntimeCore
  })

  // 动态 import 共享一次模块加载;resolveRuntimeCore 读的是调用时刻的
  // process.env,测试内改 env 无需 resetModules。
  const mod = () => import('../../src/server/services/agentRuntime.js')

  it("(a) no env + no settings → 'repl'", async () => {
    const { resolveRuntimeCore } = await mod()
    expect(resolveRuntimeCore({})).toBe('repl')
    expect(resolveRuntimeCore({ runtimeCore: undefined })).toBe('repl')
  }, TEST_TIMEOUT_MS)

  it("(b) invalid env value → 'repl'; empty env treated as unset; 废弃值 inproc/spawn → 'repl'", async () => {
    const { resolveRuntimeCore } = await mod()
    process.env.ZAI_RUNTIME_CORE = 'bogus'
    expect(resolveRuntimeCore({})).toBe('repl')
    process.env.ZAI_RUNTIME_CORE = ''
    expect(resolveRuntimeCore({})).toBe('repl')
    process.env.ZAI_RUNTIME_CORE = ''
    // env 空串时 settings 仍生效,但废弃值 inproc/spawn 视同未配置落 'repl'
    expect(resolveRuntimeCore({ runtimeCore: 'spawn' })).toBe('repl')
    expect(resolveRuntimeCore({ runtimeCore: 'inproc' })).toBe('repl')
  }, TEST_TIMEOUT_MS)

  it("(c) invalid settings value → 'repl'", async () => {
    const { resolveRuntimeCore } = await mod()
    expect(resolveRuntimeCore({ runtimeCore: 'print' as never })).toBe('repl')
  }, TEST_TIMEOUT_MS)

  it("(d) explicit env values honored, flag(env) > settings", async () => {
    const { resolveRuntimeCore } = await mod()
    // 阶段 1(2026-09-12):'default' deprecated,无论 env 还是 settings 都
    // 折叠为 'repl';'repl' 仍走原通道。
    for (const v of ['default', 'repl'] as const) {
      process.env.ZAI_RUNTIME_CORE = v
      // env 显式值盖过 settings(模拟 --runtimeCore flag 经 env 强制覆盖)
      expect(resolveRuntimeCore({ runtimeCore: 'repl' })).toBe('repl')
    }
  }, TEST_TIMEOUT_MS)

  it("(d') explicit settings values honored when env unset", async () => {
    const { resolveRuntimeCore } = await mod()
    const settings = (v: ZaiSettings['runtimeCore']): ZaiSettings => ({ runtimeCore: v })
    // 阶段 1(2026-09-12):'default' 折叠成 'repl';inproc/spawn 仍落 'repl'。
    expect(resolveRuntimeCore(settings('default'))).toBe('repl')
    expect(resolveRuntimeCore(settings('inproc'))).toBe('repl')
    expect(resolveRuntimeCore(settings('spawn'))).toBe('repl')
    expect(resolveRuntimeCore(settings('repl'))).toBe('repl')
  }, TEST_TIMEOUT_MS)

  it("getRuntimeCore() before init reports unconfigured default 'repl'", async () => {
    const { __resetAgentRuntimeForTests, getRuntimeCore } = await mod()
    __resetAgentRuntimeForTests()
    expect(getRuntimeCore()).toBe('repl')
  }, TEST_TIMEOUT_MS)
})
