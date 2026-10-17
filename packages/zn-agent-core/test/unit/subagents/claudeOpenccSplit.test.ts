/**
 * 回归测试 — `claude` 与 `opencc` 是两个可并存的子 agent provider。
 *
 * 背景 (zai patch 2026-10-17):`compat/subagents/claude-code/` 这个目录名叫
 * claude-code,但 provider 的注册名是 `'opencc'`、默认 `command` 也是
 * `'opencc'` —— 它一直 spawn 的是 opencc 二进制。后果是**真正的 Claude Code
 * CLI 无法启用**:要加就得注册第二个 provider,而
 * `SubagentRegistry.registerProvider` 对重名直接 throw
 * (`PROVIDER_ALREADY_REGISTERED`)。
 *
 * 现在按二进制拆开:
 *   - `claude-code/` → `name:'claude'`,默认 command `claude`,按 enabled 注册
 *   - `opencc/`      → `name:'opencc'`,默认 command `opencc`,无条件注册
 * 两者 wire 协议相同(`--print --output-format stream-json`),共用同一套
 * run / wire / result。
 *
 * 本文件钉住的是「两者能同时注册」这个契约 —— 它正是当年被重名挡住的。
 */
import { describe, expect, it } from 'vitest'
import { SubagentRegistry } from '../../../src/compat/subagents/registry.js'
import { apply as applyClaude } from '../../../src/compat/subagents/claude-code/index.js'
import { apply as applyOpencc } from '../../../src/compat/subagents/opencc/index.js'

describe('claude / opencc 双 provider', () => {
  it('两者可同时注册,互不冲突(这正是当年被重名挡住的)', () => {
    const registry = new SubagentRegistry()
    const openccDisposer = applyOpencc(registry, { enabled: true })
    const claudeDisposer = applyClaude(registry, { enabled: true })

    expect(registry.list().sort()).toEqual(['claude', 'opencc'])
    expect(registry.getProvider('claude')).toBeDefined()
    expect(registry.getProvider('opencc')).toBeDefined()

    openccDisposer?.()
    claudeDisposer?.()
    expect(registry.list()).toEqual([])
  })

  it('claude 默认 spawn claude 二进制,opencc 默认 spawn opencc', () => {
    const registry = new SubagentRegistry()
    applyOpencc(registry, {})
    applyClaude(registry, { enabled: true })

    // provider 本身不暴露 command,但它的描述与 name 必须自洽:
    // 描述里说的 CLI 名字要与 name 对上,否则模型会被误导。
    const claude = registry.getProvider('claude')!
    const opencc = registry.getProvider('opencc')!
    expect(claude.name).toBe('claude')
    expect(opencc.name).toBe('opencc')
    expect(claude.description).toMatch(/Claude/i)
    expect(opencc.description).toMatch(/OpenCC/i)
    expect(claude.description).not.toBe(opencc.description)
  })

  it('claude 默认关闭(需 enabled),opencc 无条件注册', () => {
    const registry = new SubagentRegistry()

    // 未传配置 → 不注册(claude 需要用户自行安装并登录)
    expect(applyClaude(registry, undefined)).toBeUndefined()
    expect(applyClaude(registry, {})).toBeUndefined()
    expect(registry.list()).toEqual([])

    // opencc 随 zai 一起装,无条件可用
    expect(applyOpencc(registry, undefined)).toBeTypeOf('function')
    expect(registry.list()).toEqual(['opencc'])

    // 显式开启 claude 后两者并存
    expect(applyClaude(registry, { enabled: true })).toBeTypeOf('function')
    expect(registry.list().sort()).toEqual(['claude', 'opencc'])
  })

  it('opencc 的 enabled:false 不会把 provider 摘掉 —— 它随 zai 一起装', () => {
    // 与 dsh / opencode 不同:那两个需要外部 CLI,故可开关;
    // opencc 是 zai 自带的 CLI,关掉它等于让模型被告知存在的 provider
    // 凭空消失。apply 只覆写默认值,不做开关。
    const registry = new SubagentRegistry()
    expect(applyOpencc(registry, { enabled: false })).toBeTypeOf('function')
    expect(registry.list()).toEqual(['opencc'])
  })
})
