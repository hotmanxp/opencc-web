import { describe, expect, it, beforeAll, afterAll } from 'vitest'
import {
  applyRuntimeCoreFlag,
  getForcedRuntimeCoreFlag,
  reapplyRuntimeCoreFlag,
} from '../../src/cli/runtimeCoreFlag.js'

// zai patch (2026-08-28 命名统一,2026-08-30 全部统一为 `runtimeCore` 字段):
// CLI `--runtimeCore` 与 settings.env 的覆盖关系回归。enableOpenccConfigs()
// 会把 settings 的 env 块 Object.assign 回 process.env,晚于 CLI 入口执行。
// `reapplyRuntimeCoreFlag()` 必须在解析运行时前恢复 `--runtimeCore` 的强制语义
// (spec: flag = 强制覆盖 settings)。注:forcedRuntimeCore 是模块级状态,
// 用例按声明顺序执行、依次递进。

const ENV = 'ZAI_RUNTIME_CORE'
const original = process.env[ENV]

beforeAll(() => {
  delete process.env[ENV]
})

afterAll(() => {
  if (original === undefined) delete process.env[ENV]
  else process.env[ENV] = original
})

describe('runtimeCoreFlag: --runtimeCore 强制语义不被 settings.env 覆盖', () => {
  it('applyRuntimeCoreFlag(undefined) 不动 env,reapply 不恢复', () => {
    applyRuntimeCoreFlag(undefined)
    expect(getForcedRuntimeCoreFlag()).toBeNull()
    process.env[ENV] = 'repl'
    reapplyRuntimeCoreFlag()
    expect(process.env[ENV]).toBe('repl')
    delete process.env[ENV]
  })

  it("applyRuntimeCoreFlag('repl') 写 env 并记住强制值", () => {
    applyRuntimeCoreFlag('repl')
    expect(process.env[ENV]).toBe('repl')
    expect(getForcedRuntimeCoreFlag()).toBe('repl')
  })

  it('模拟 settings env 覆盖后,reapplyRuntimeCoreFlag 恢复 repl', () => {
    process.env[ENV] = 'default'
    reapplyRuntimeCoreFlag()
    expect(process.env[ENV]).toBe('repl')
  })

  it("applyRuntimeCoreFlag('default') 强制 default 并盖过脏 env", () => {
    process.env[ENV] = 'repl'
    applyRuntimeCoreFlag('default')
    expect(process.env[ENV]).toBe('default')
    process.env[ENV] = 'repl'
    reapplyRuntimeCoreFlag()
    expect(process.env[ENV]).toBe('default')
  })
})
