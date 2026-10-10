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
import { MOD_SUPPORTED_EVENTS } from '../../src/opencc-src/mods/dispatch.js'
import {
  __resetModctlHitsForTesting,
  getModctlHits,
} from '../../src/opencc-src/mods/builtin/modctl.js'

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

/**
 * 事件链实测:把每个事件真的投进 `runModChain`,断言 handler 被调到、
 * 计数入账、上下文按预期注入。
 *
 * 为什么必须真跑而不是只断言注册:`ctx.on('PostToolUse', h)` 写错字段名
 * 不会报错,只会静默什么都不发生 —— 只有把真实载荷喂进去,才能证明这条链
 * 在 zai 侧真的通。
 */
describe('内置 mod modctl — 事件订阅', () => {
  /** 把 modctl 的 handler 找出来,包装成直接可调的形状。 */
  async function loadModctl() {
    await loadBuiltinMods()
    const mod = getLoadedMods().find(m => m.manifest.name === 'modctl')!
    const byEvent = new Map(mod.handlers.map(h => [h.event, h.handler]))
    return { mod, byEvent }
  }

  /** 造一个 terminal:记录它有没有被调到,以及拿到什么。 */
  function terminalSpy(extra: Record<string, unknown> = {}) {
    const calls: Record<string, unknown>[] = []
    return {
      calls,
      terminal: async (e: Record<string, unknown>) => {
        calls.push(e)
        return { ...e, ...extra }
      },
    }
  }

  beforeEach(() => {
    __resetModctlHitsForTesting()
    clearKnownMods()
    resetModsRegistryForTesting()
  })

  it('注册了全部 7 个非 ui 事件,一个不落', async () => {
    const { mod } = await loadModctl()
    const registered = mod.handlers.map(h => h.event).sort()
    const expected = [...MOD_SUPPORTED_EVENTS].sort()
    expect(registered).toEqual(expected)
    // 刻意不订阅 ui.render —— 它已随 TUI 能力面删除,订阅会被
    // isModSupportedEvent 拒绝。
    expect(registered).not.toContain('ui.render')
  })

  // 每个事件一条:真跑 + 断言计数 + 断言上下文语义。
  const CASES = [
    {
      event: 'PreToolUse' as const,
      input: { hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command: 'ls' } },
      detail: 'Bash',
      context: 'Bash',
    },
    {
      event: 'PostToolUse' as const,
      input: { hook_event_name: 'PostToolUse', tool_name: 'Read', tool_output: 'ok' },
      detail: 'Read',
      context: 'Read',
    },
    {
      event: 'UserPromptSubmit' as const,
      input: { hook_event_name: 'UserPromptSubmit', prompt: '你好世界' },
      detail: '你好世界',
      context: '4 字',
    },
    {
      event: 'SessionStart' as const,
      input: { hook_event_name: 'SessionStart', cwd: '/tmp/proj' },
      detail: '/tmp/proj',
      context: '/tmp/proj',
    },
    {
      event: 'SessionEnd' as const,
      input: { hook_event_name: 'SessionEnd', reason: 'clear' },
      detail: 'reason=clear',
      // SessionEnd 不注入上下文(会话已结束,注入了也没人消费)。
      context: null,
    },
    {
      event: 'Stop' as const,
      input: { hook_event_name: 'Stop', stop_reason: 'end_turn' },
      detail: 'stop_reason=end_turn',
      context: null,
    },
    {
      event: 'Notification' as const,
      input: { hook_event_name: 'Notification', message: '磁盘空间不足' },
      detail: '磁盘空间不足',
      context: '磁盘空间不足',
    },
  ]

  for (const c of CASES) {
    it(`${c.event}:handler 被调用、计数入账、不打断下游`, async () => {
      const { byEvent } = await loadModctl()
      const handler = byEvent.get(c.event)
      expect(handler).toBeDefined()

      const { terminal, calls } = terminalSpy()
      const out = await handler!(c.input, terminal)

      // 1) 事件确实被记到
      expect(getModctlHits().get(c.event)?.count).toBe(1)
      // 2) 载荷字段读对了(没写成别的字段名)
      expect(getModctlHits().get(c.event)?.detail).toContain(c.detail)
      // 3) 下游核心 tier 照常执行 —— mod 不能吞掉事件
      expect(calls).toHaveLength(1)
      expect(calls[0]).toEqual(c.input)
      // 4) 返回值保留了下游结果(透传而非中断)
      expect(out).toMatchObject({ hook_event_name: c.input.hook_event_name })

      // 5) 上下文注入语义
      const injected = (out.hookSpecificOutput as { additionalContext?: string } | undefined)
        ?.additionalContext
      if (c.context === null) {
        expect(injected).toBeUndefined()
      } else {
        expect(injected).toContain(c.context)
      }
    })
  }

  it('注入时必带 hookEventName —— 缺了会 throw 并打断每一轮对话', async () => {
    // 回归防线:processHookJSONOutput 先拿 hookEventName 与 expectedHookEvent
    // 比对,不匹配直接 throw;随后整个 switch 也靠它分派。缺字段的真实症状
    // 不是「注入没生效」,而是每轮对话都被
    // "expected 'UserPromptSubmit' but got 'undefined'" 打断。
    const { byEvent } = await loadModctl()
    const handler = byEvent.get('UserPromptSubmit')!
    const { terminal } = terminalSpy()
    const out = await handler({ hook_event_name: 'UserPromptSubmit', prompt: 'hi' }, terminal)
    expect((out.hookSpecificOutput as { hookEventName?: string }).hookEventName).toBe(
      'UserPromptSubmit',
    )
  })

  it('五个注入事件的 hookEventName 与各自事件一致', async () => {
    const { byEvent } = await loadModctl()
    const { terminal } = terminalSpy()
    for (const ev of ['PreToolUse', 'PostToolUse', 'UserPromptSubmit', 'SessionStart', 'Notification']) {
      const out = await byEvent.get(ev)!({ hook_event_name: ev, tool_name: 'Bash' }, terminal)
      expect(
        (out.hookSpecificOutput as { hookEventName?: string }).hookEventName,
        `${ev} 的 hookEventName 不匹配`,
      ).toBe(ev)
    }
  })

  it('多次触发时计数累加,detail 保留最近一次', async () => {
    const { byEvent } = await loadModctl()
    const handler = byEvent.get('PostToolUse')!
    const { terminal } = terminalSpy()

    await handler({ hook_event_name: 'PostToolUse', tool_name: 'Bash' }, terminal)
    await handler({ hook_event_name: 'PostToolUse', tool_name: 'Grep' }, terminal)

    const hit = getModctlHits().get('PostToolUse')
    expect(hit?.count).toBe(2)
    expect(hit?.detail).toContain('Grep')
  })

  it('注入不覆盖其他 mod 已写入的 additionalContext', async () => {
    const { byEvent } = await loadModctl()
    const handler = byEvent.get('SessionStart')!
    // 下游已经有人写了 additionalContext(模拟另一个 mod 或宿主)。
    const terminal = async () => ({
      hookSpecificOutput: { additionalContext: '来自下游的内容' },
    })
    const out = await handler({ hook_event_name: 'SessionStart' }, terminal)
    const ctx = (out.hookSpecificOutput as { additionalContext: string }).additionalContext
    expect(ctx).toContain('来自下游的内容')
    expect(ctx).toContain('[modctl]')
  })

  it('下游保留 hookSpecificOutput 里的其他字段', async () => {
    const { byEvent } = await loadModctl()
    const handler = byEvent.get('PreToolUse')!
    const terminal = async () => ({
      hookSpecificOutput: { permissionDecision: 'allow' as const },
    })
    const out = await handler({ hook_event_name: 'PreToolUse', tool_name: 'Bash' }, terminal)
    // 注入上下文时不能把 permissionDecision 之类的东西冲掉。
    expect(out.hookSpecificOutput).toMatchObject({ permissionDecision: 'allow' })
  })

  it('超长载荷被截断,不会把面板撑爆', async () => {
    const { byEvent } = await loadModctl()
    const handler = byEvent.get('Notification')!
    const { terminal } = terminalSpy()
    await handler({ hook_event_name: 'Notification', message: 'x'.repeat(5000) }, terminal)
    const detail = getModctlHits().get('Notification')?.detail ?? ''
    expect(detail.length).toBeLessThan(200)
    expect(detail.endsWith('…')).toBe(true)
  })

  it('/modctl 把「支持但从未收到」的事件标出来 —— 便于区分没发生 vs 没接线', async () => {
    const { mod } = await loadModctl()
    // 一个事件都不投,面板应逐条报 ×0
    const out = await mod.commands[0].handler!() as string
    for (const event of MOD_SUPPORTED_EVENTS) {
      expect(out).toContain(event)
      expect(out).toContain('从未收到')
    }
    expect(out).toContain('从未收到。可能是该事件本会话未发生')
  })

  it('/modctl 在收到部分事件后如实显示计数与最近载荷', async () => {
    const { byEvent, mod } = await loadModctl()
    const { terminal } = terminalSpy()
    await byEvent.get('SessionStart')!({ hook_event_name: 'SessionStart', cwd: '/w' }, terminal)
    await byEvent.get('SessionStart')!({ hook_event_name: 'SessionStart', cwd: '/w' }, terminal)

    const out = await mod.commands[0].handler!() as string
    expect(out).toContain('SessionStart')
    expect(out).toContain('×  2')
    expect(out).toContain('/w')
    // 未触发的仍应标为 0
    expect(out).toContain('从未收到')
  })
})