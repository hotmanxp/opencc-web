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

  it("(b) invalid env value → 'repl'; empty env treated as unset", async () => {
    const { resolveRuntimeCore } = await mod()
    process.env.ZAI_RUNTIME_CORE = 'bogus'
    expect(resolveRuntimeCore({})).toBe('repl')
    process.env.ZAI_RUNTIME_CORE = ''
    expect(resolveRuntimeCore({})).toBe('repl')
    // env 空串时 settings 仍生效
    expect(resolveRuntimeCore({ runtimeCore: 'spawn' })).toBe('spawn')
  }, TEST_TIMEOUT_MS)

  it("(c) invalid settings value → 'repl'", async () => {
    const { resolveRuntimeCore } = await mod()
    expect(resolveRuntimeCore({ runtimeCore: 'print' as never })).toBe('repl')
  }, TEST_TIMEOUT_MS)

  it("(d) explicit env values honored, flag(env) > settings", async () => {
    const { resolveRuntimeCore } = await mod()
    for (const v of ['default', 'inproc', 'spawn', 'repl'] as const) {
      process.env.ZAI_RUNTIME_CORE = v
      // env 显式值盖过 settings(模拟 --runtimeCore flag 经 env 强制覆盖)
      expect(resolveRuntimeCore({ runtimeCore: 'inproc' })).toBe(v)
    }
  }, TEST_TIMEOUT_MS)

  it("(d') explicit settings values honored when env unset", async () => {
    const { resolveRuntimeCore } = await mod()
    const settings = (v: ZaiSettings['runtimeCore']): ZaiSettings => ({ runtimeCore: v })
    expect(resolveRuntimeCore(settings('default'))).toBe('default')
    expect(resolveRuntimeCore(settings('inproc'))).toBe('inproc')
    expect(resolveRuntimeCore(settings('spawn'))).toBe('spawn')
    expect(resolveRuntimeCore(settings('repl'))).toBe('repl')
  }, TEST_TIMEOUT_MS)

  it("getRuntimeCore() before init reports unconfigured default 'repl'", async () => {
    const { __resetAgentRuntimeForTests, getRuntimeCore } = await mod()
    __resetAgentRuntimeForTests()
    expect(getRuntimeCore()).toBe('repl')
  }, TEST_TIMEOUT_MS)
})
