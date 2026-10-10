/**
 * zai patch (2026-10-10, mods 同步):内置 mod `modctl` 的单测。
 *
 * 在此之前 vendor 的 builtinSpecs 一直为空,所以「内置 mod」这条路径在 zai
 * 从未被真跑过:`@builtin` id、`noteDiscoveredMod(name, true)`、无 root 路径、
 * 以及内置 mod 的停用门禁,全是死代码。modctl 是第一个内置 mod,这个文件
 * 把该路径钉住。
 *
 * 特别覆盖一条构建期看不见的坑:内置 mod 模块必须**动态 import**。
 * 写成顶层 `import './builtin/modctl.js'` 会形成循环依赖,esbuild 打成
 * 单 bundle 后模块初始化顺序错位,`builtinSpecs` 此刻是 undefined,
 * registerBuiltinMod 里的 `.push` 抛 "Cannot read properties of undefined"。
 * **tsc 绿、build:core 绿、bundle 字节数不变,只有真 import bundle 才炸** ——
 * 所以下面第一件事就是加载并真的走一遍注册。
 */
import { describe, it, expect, beforeEach } from 'vitest'
import {
  loadBuiltinMods,
  isBuiltinMod,
  isBuiltinModName,
} from '../../src/opencc-src/mods/builtin.js'
import {
  getLoadedMods,
  clearKnownMods,
  resetModsRegistryForTesting,
} from '../../src/opencc-src/mods/registry.js'
import { buildModCommands } from '../../src/opencc-src/mods/engine.js'

describe('内置 mod modctl', () => {
  beforeEach(() => {
    clearKnownMods()
    resetModsRegistryForTesting()
  })

  it('注册成功且无失败项(动态 import 生效的直接证据)', async () => {
    const result = await loadBuiltinMods()
    expect(result.failed).toEqual([])
    expect(result.loaded.map(m => m.manifest.name)).toContain('modctl')
  })

  it('isBuiltinMod 认得出它 —— root 是 BUILTIN_ORIGIN 哨兵而非真实路径', async () => {
    const result = await loadBuiltinMods()
    const mod = result.loaded.find(m => m.manifest.name === 'modctl')!
    expect(isBuiltinMod(mod)).toBe(true)
    expect(mod.root).toBe('(builtin)')
    expect(mod.entryPath).toBe('(builtin)')
  })

  it('isBuiltinModName 按声明表判定,与是否加载无关', () => {
    // 声明表查询:被停用的内置 mod 不在注册表里,但仍要能查到,否则
    // setModEnabled 算不出它的 @builtin 开关键。
    expect(isBuiltinModName('modctl')).toBe(true)
    expect(isBuiltinModName('not-a-builtin')).toBe(false)
  })

  it('幂等:重复 loadBuiltinMods 不产生重复条目', async () => {
    await loadBuiltinMods()
    const first = getLoadedMods().filter(m => m.manifest.name === 'modctl').length
    await loadBuiltinMods()
    const second = getLoadedMods().filter(m => m.manifest.name === 'modctl').length
    expect(second).toBe(first)
  })

  it('命令进命令表,且名字无 mod 前缀(内置 mod 不加 `<mod>:` 前缀)', async () => {
    await loadBuiltinMods()
    const cmds = buildModCommands()
    const names = cmds.map(c => c.name)
    expect(names).toContain('modctl')
    // 磁盘 mod 的命令会带 `modName:command` 前缀,内置的不带。
    expect(names).not.toContain('modctl:modctl')
  })

  it('handler 真的产出自检报告,不是空串', async () => {
    const result = await loadBuiltinMods()
    const mod = result.loaded.find(m => m.manifest.name === 'modctl')!
    const out = await mod.commands[0].handler!()
    expect(typeof out).toBe('string')
    expect(out).toContain('modctl')
  })

  it('报告里能看出自己是内置', async () => {
    const result = await loadBuiltinMods()
    const mod = result.loaded.find(m => m.manifest.name === 'modctl')!
    const out = await mod.commands[0].handler!() as string
    expect(out).toContain('内置')
  })
})