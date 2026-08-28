import { describe, expect, it, beforeAll, afterAll } from 'vitest'
import {
  applyCoreRuntimeFlag,
  getForcedCoreRuntimeFlag,
  reapplyCoreRuntimeFlag,
} from '../../src/cli/coreRuntimeFlag.js'

// zai patch (2026-08-28 命名统一):CLI `--coreRuntime` 与 settings.env 的
// 覆盖关系回归。enableOpenccConfigs() 会把 settings 的 env 块 Object.assign
// 回 process.env,晚于 CLI 入口执行。`reapplyCoreRuntimeFlag()` 必须在解析
// 运行时前恢复 `--coreRuntime` 的强制语义(spec: flag = 强制覆盖 settings)。
// 注:forcedRuntime 是模块级状态,用例按声明顺序执行、依次递进。

const ENV = 'ZAI_CORE_RUNTIME'
const original = process.env[ENV]

beforeAll(() => {
  delete process.env[ENV]
})

afterAll(() => {
  if (original === undefined) delete process.env[ENV]
  else process.env[ENV] = original
})

describe('coreRuntimeFlag: --coreRuntime 强制语义不被 settings.env 覆盖', () => {
  it('applyCoreRuntimeFlag(undefined) 不动 env,reapply 不恢复', () => {
    applyCoreRuntimeFlag(undefined)
    expect(getForcedCoreRuntimeFlag()).toBeNull()
    process.env[ENV] = 'spawn'
    reapplyCoreRuntimeFlag()
    expect(process.env[ENV]).toBe('spawn')
    delete process.env[ENV]
  })

  it("applyCoreRuntimeFlag('inproc') 写 env 并记住强制值", () => {
    applyCoreRuntimeFlag('inproc')
    expect(process.env[ENV]).toBe('inproc')
    expect(getForcedCoreRuntimeFlag()).toBe('inproc')
  })

  it('模拟 settings env 覆盖后,reapplyCoreRuntimeFlag 恢复 inproc', () => {
    process.env[ENV] = 'default'
    reapplyCoreRuntimeFlag()
    expect(process.env[ENV]).toBe('inproc')
  })

  it("applyCoreRuntimeFlag('default') 强制 default 并盖过脏 env", () => {
    process.env[ENV] = 'inproc'
    applyCoreRuntimeFlag('default')
    expect(process.env[ENV]).toBe('default')
    process.env[ENV] = 'inproc'
    reapplyCoreRuntimeFlag()
    expect(process.env[ENV]).toBe('default')
  })
})
