/**
 * zai patch (2026-10-06, mods 同步):mainAgent 第四槽 `mods` 的单测。
 *
 * 覆盖 per-session 门禁的三个消费点 + 语义边界:
 *   - 工具池(getModTools)
 *   - 命令表(buildModCommands)
 *   - handler 链(runModChain)
 *
 * 以及三条语义线:不设槽 = 零回归(全部可见)、`[]` = 全禁、白名单 = 子集。
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'
import {
  registerLoadedMod,
  resetModsRegistryForTesting,
  setSessionModGate,
  clearSessionModGate,
  resetSessionModGatesForTesting,
  isModVisibleForSession,
  hasSessionModGate,
  BUILTIN_ORIGIN,
  type LoadedMod,
} from '../../src/opencc-src/mods/registry.js'
import { getModTools, buildModCommands } from '../../src/opencc-src/mods/engine.js'
import { runModChain } from '../../src/opencc-src/mods/dispatch.js'
import type { ModChainEntry } from '../../src/opencc-src/types/hooks.js'

function makeMod(name: string, isBuiltin = false): LoadedMod {
  return {
    manifest: { name, entry: isBuiltin ? BUILTIN_ORIGIN : `/tmp/${name}/register.js` },
    root: isBuiltin ? BUILTIN_ORIGIN : `/tmp/${name}`,
    entryPath: isBuiltin ? BUILTIN_ORIGIN : `/tmp/${name}/register.js`,
    handlers: [],
    commands: [],
    tools: [
      {
        name: 'ping',
        description: `ping from ${name}`,
        inputSchema: { type: 'object', properties: {} },
        execute: async () => `${name}:pong`,
      },
    ],
  }
}

function withCommand(mod: LoadedMod, cmdName: string): LoadedMod {
  mod.commands.push({
    name: cmdName,
    description: `${cmdName} from ${mod.manifest.name}`,
    handler: async () => 'ok',
  })
  return mod
}

beforeEach(() => {
  resetModsRegistryForTesting()
  resetSessionModGatesForTesting()
})

describe('mods 槽 — per-session 门禁', () => {
  it('不设槽 = 全部 mod 可见（opencc 零回归基线）', () => {
    registerLoadedMod(makeMod('alpha'))
    registerLoadedMod(makeMod('beta'))
    // 不调 setSessionModGate —— 未设门禁
    expect(hasSessionModGate('sess-1')).toBe(false)
    expect(getModTools().map(t => t.name).sort()).toEqual([
      'mods_alpha_ping',
      'mods_beta_ping',
    ])
  })

  it('未知会话 = 全部可见（门禁不误伤）', () => {
    registerLoadedMod(makeMod('alpha'))
    setSessionModGate('sess-known', [])
    expect(getModTools('sess-unknown').map(t => t.name)).toEqual(['mods_alpha_ping'])
  })

  it('tools: 白名单只放行列出的 mod', () => {
    registerLoadedMod(makeMod('alpha'))
    registerLoadedMod(makeMod('beta'))
    setSessionModGate('sess-2', ['alpha'])
    expect(getModTools('sess-2').map(t => t.name)).toEqual(['mods_alpha_ping'])
  })

  it('tools: 空数组 = 禁用所有 mod 工具', () => {
    registerLoadedMod(makeMod('alpha'))
    setSessionModGate('sess-3', [])
    expect(getModTools('sess-3')).toEqual([])
  })

  it('tools: 两个会话互不污染（这正是 2026-08-20 tools 槽踩过的坑）', () => {
    registerLoadedMod(makeMod('alpha'))
    registerLoadedMod(makeMod('beta'))
    setSessionModGate('sess-A', ['alpha'])
    setSessionModGate('sess-B', ['beta'])
    expect(getModTools('sess-A').map(t => t.name)).toEqual(['mods_alpha_ping'])
    expect(getModTools('sess-B').map(t => t.name)).toEqual(['mods_beta_ping'])
    // 未设门禁的第三个会话仍看到全部
    expect(getModTools('sess-C').map(t => t.name).sort()).toEqual([
      'mods_alpha_ping',
      'mods_beta_ping',
    ])
  })

  it('commands: 白名单同样生效（磁盘 mod 带 <mod>:<cmd> 前缀）', () => {
    const a = withCommand(makeMod('alpha'), 'hello')
    const b = withCommand(makeMod('beta'), 'hello')
    registerLoadedMod(a)
    registerLoadedMod(b)
    expect(buildModCommands().map(c => c.name).sort()).toEqual([
      'alpha:hello',
      'beta:hello',
    ])
    setSessionModGate('sess-4', ['alpha'])
    expect(buildModCommands('sess-4').map(c => c.name)).toEqual(['alpha:hello'])
  })

  it('commands: 内置 mod 用裸名，也受门禁约束', () => {
    registerLoadedMod(withCommand(makeMod('diff', true), 'diff'))
    registerLoadedMod(withCommand(makeMod('other', true), 'other'))
    setSessionModGate('sess-5', ['diff'])
    expect(buildModCommands('sess-5').map(c => c.name)).toEqual(['diff'])
  })

  it('handler: 不可见 mod 的 handler 被跳过，核心 tier 照常执行', async () => {
    const seen: string[] = []
    const chain: ModChainEntry[] = [
      {
        modName: 'blocked',
        handler: async (_e, next) => {
          seen.push('blocked')
          return next()
        },
      },
      {
        modName: 'allowed',
        handler: async (_e, next) => {
          seen.push('allowed')
          return next()
        },
      },
    ]
    setSessionModGate('sess-6', ['allowed'])
    const result = await runModChain(
      chain,
      { hook_event_name: 'Stop' },
      async () => {
        seen.push('core')
        return { continue: true }
      },
      undefined,
      undefined,
      'sess-6',
    )
    expect(seen).toEqual(['allowed', 'core'])
    expect(result.continue).toBe(true)
  })

  it('handler: 全部禁用时退化为直通核心 tier', async () => {
    const seen: string[] = []
    const chain: ModChainEntry[] = [
      {
        modName: 'a',
        handler: async (_e, next) => {
          seen.push('a')
          return next()
        },
      },
    ]
    setSessionModGate('sess-7', [])
    await runModChain(
      chain,
      {},
      async () => {
        seen.push('core')
        return { continue: true }
      },
      undefined,
      undefined,
      'sess-7',
    )
    expect(seen).toEqual(['core'])
  })

  it('handler: 未传 sessionId 时行为与 opencc 一致（全部执行）', async () => {
    const seen: string[] = []
    const chain: ModChainEntry[] = [
      {
        modName: 'a',
        handler: async (_e, next) => {
          seen.push('a')
          return next()
        },
      },
    ]
    await runModChain(chain, {}, async () => {
      seen.push('core')
      return { continue: true }
    })
    expect(seen).toEqual(['a', 'core'])
  })

  it('clearSessionModGate 恢复全可见', () => {
    registerLoadedMod(makeMod('alpha'))
    setSessionModGate('sess-8', [])
    expect(getModTools('sess-8')).toEqual([])
    clearSessionModGate('sess-8')
    expect(getModTools('sess-8').map(t => t.name)).toEqual(['mods_alpha_ping'])
  })

  it('空 sid 被忽略（不写门禁）', () => {
    setSessionModGate('', [])
    expect(hasSessionModGate('')).toBe(false)
  })

  it('isModVisibleForSession 直觉一致', () => {
    setSessionModGate('sess-9', ['x'])
    expect(isModVisibleForSession('x', 'sess-9')).toBe(true)
    expect(isModVisibleForSession('y', 'sess-9')).toBe(false)
    expect(isModVisibleForSession('y', undefined)).toBe(true)
  })
})

// ─────────────────────────────────────────────────────────────────────
// zai patch (2026-10-06):TUI 能力面已移除 —— 下面锁住这个决定。
//
// zai 的 UI 是 Web UI,与 opencc 的 Ink TUI 不是一套体系,所以
// `ui.pane` / `ui.closePane` / `ui.notify` / `ui.render` 事件整块删除。
// 这里测两件事:
//   1. 保留的通道(notice / status)仍然工作 —— 别把有用的数据推送误删
//   2. `ui.render` 事件被显式拒绝(fail-fast),不是静默无效
// ─────────────────────────────────────────────────────────────────────

describe('mods 槽 — TUI 能力面已移除', () => {
  it('ctx.ui 上没有 pane / closePane / notify', async () => {
    const mod = makeMod('uitest')
    const { createModContext } = await import(
      '../../src/opencc-src/mods/engine.js'
    )
    const ctx = createModContext(mod) as unknown as Record<string, unknown>
    const ui = ctx.ui as Record<string, unknown>
    expect(ui.pane).toBeUndefined()
    expect(ui.closePane).toBeUndefined()
    expect(ui.notify).toBeUndefined()
    // 保留的两个:单向数据推送,不绑定渲染技术
    expect(typeof ui.notice).toBe('function')
    expect(typeof ui.log).toBe('function')
    expect(typeof ui.status).toBe('function')
  })

  it("ctx.on('ui.render') 被显式拒绝,不是静默无效", async () => {
    const { createModContext } = await import(
      '../../src/opencc-src/mods/engine.js'
    )
    const mod = makeMod('rendertest')
    const ctx = createModContext(mod)
    expect(() =>
      ctx.on('ui.render' as never, (() => 'x') as never),
    ).toThrow(/unsupported event/i)
    // 且没有把 handler 记进 mod —— 失败要干净
    expect(mod.handlers).toHaveLength(0)
  })

  it('保留的 7 个 hook 事件仍全部可用', async () => {
    const { createModContext } = await import(
      '../../src/opencc-src/mods/engine.js'
    )
    const mod = makeMod('hooktest')
    const ctx = createModContext(mod)
    for (const ev of [
      'PreToolUse',
      'PostToolUse',
      'UserPromptSubmit',
      'SessionStart',
      'SessionEnd',
      'Stop',
      'Notification',
    ] as const) {
      ctx.on(ev, async (_e, next) => next())
    }
    expect(mod.handlers).toHaveLength(7)
  })

  it('ui.status 仍能写入快照(notice/status 是数据通道,不是渲染)', async () => {
    const { createModContext, getModStatusSnapshot } = await import(
      '../../src/opencc-src/mods/engine.js'
    )
    const mod = makeMod('statustest')
    const ctx = createModContext(mod)
    ctx.ui.status('working…')
    expect(getModStatusSnapshot().statustest).toBe('working…')
    // 空串清除
    ctx.ui.status('')
    expect(getModStatusSnapshot().statustest).toBeUndefined()
  })
})
