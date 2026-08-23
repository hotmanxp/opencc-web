import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import {
  agentEvents,
  type Agent,
  type LlmCallConfig,
  type ModelSelectionRef,
} from '@deepseek-ai/dsh-agent'
import { ReasoningEffortId as Reason } from '@deepseek-ai/dsh-llm'

import {
  createModelSelectionRef,
  installModelSelection,
  resolveModelSelection,
} from '../src/model.js'

/**
 * ds-021 hotfix:installModelSelection 真接线测试 — 验证 dsh-bridge wrapper
 * 转发到 @deepseek-ai/dsh-agent 的同名导出,scope-local listener 真生效。
 *
 * 测试形态对齐上游 model-selection.spec.ts:
 * - 创建 cordis Context
 * - ctx.plugin(SystemPrompt) 让 ctx.systemPrompt 可用
 * - installModelSelection(ctx, ref) 装上 listener
 * - 用 agentEvents(ctx, agent).waterfall('agent/request', ...) 验证
 *   LlmCallConfig 接收 ref.current 的 provider/model
 * - 用 ctx.systemPrompt.assemble() 验证 variables 字段被 ref 注入
 * - dispose 后 listener 不再触发
 *
 * 之前 dsh-bridge/src/model.ts 是 stub(只 ctx.set('modelSelection', ...)),
 * 没有任何真实效果 — 本测试是 B1a T1.4 + ds-021 收口的真接线守护。
 */
describe('createModelSelectionRef()', () => {
  it('缺省参数返回 undefined/empty ref', () => {
    const ref = createModelSelectionRef()
    expect(ref.current).toBeUndefined()
    expect(ref.assembled).toBeUndefined()
  })

  it('接受初始 selection', () => {
    const initial = { provider: 'anthropic', model: 'MiniMax-M3' }
    const ref = createModelSelectionRef(initial)
    expect(ref.current).toEqual(initial)
    expect(ref.assembled).toBeUndefined()
  })

  it('ref 是 mutable holder(caller mutate ref.current 生效)', () => {
    const ref = createModelSelectionRef({ provider: 'anthropic', model: 'foo' })
    ref.current = { provider: 'anthropic', model: 'bar' }
    expect(ref.current?.model).toBe('bar')
  })
})

describe('installModelSelection()', () => {
  it('返回 disposer(转发上游 installModelSelection 返回值)', () => {
    const ctx = new Context()
    const ref: ModelSelectionRef = { current: undefined, assembled: undefined }
    const dispose = installModelSelection(ctx, ref)
    expect(typeof dispose).toBe('function')
    dispose() // 应当无害清理(没 listener 跑过也算正常 dispose)
    // ctx dispose 防止泄漏
    return ctx.fiber.dispose()
  })

  it('scope-local:assemble → request 的两步链把 ref.current 写到 LlmCallConfig', async () => {
    // **upstream contract**:上游 installModelSelection 的两步链是
    //   1. system-prompt/assemble 阶段 snapshot ref.current → ref.assembled
    //   2. agent/request 阶段读 ref.assembled → 写到 LlmCallConfig
    // 跳过 assemble 直接 emit agent/request 时,ref.assembled 仍是 undefined,
    // listener 走 no-op 分支(seed 原样传出)— 这是设计意图,防止同 turn
    // 切换撕裂两个 surface。
    const ctx = new Context()
    await ctx.plugin(SystemPrompt)
    const ref: ModelSelectionRef = { current: undefined, assembled: undefined }
    const dispose = installModelSelection(ctx, ref)

    const agent = {} as Agent
    const signal = new AbortController().signal
    const seed: LlmCallConfig = { provider: 'seed-provider', model: 'seed-model' }

    // 1) 初始 ref.current = undefined — assemble 时 assembled 不被 set
    await ctx.systemPrompt.assemble()
    await expect(agentEvents(ctx, agent).waterfall(
      'agent/request', { turn: 1, step: 0, signal }, () => Promise.resolve(seed),
    )).resolves.toBe(seed)

    // 2) mutate ref.current + assemble → assembled 同步反映
    ref.current = { provider: 'anthropic', model: 'MiniMax-M3' }
    await ctx.systemPrompt.assemble()
    expect(ref.assembled).toEqual({ provider: 'anthropic', model: 'MiniMax-M3' })
    await expect(agentEvents(ctx, agent).waterfall(
      'agent/request', { turn: 1, step: 1, signal }, () => Promise.resolve(seed),
    )).resolves.toEqual({ provider: 'anthropic', model: 'MiniMax-M3' })

    // 3) 切到另一个 model → 下一次 assemble + emit 命中
    ref.current = { provider: 'anthropic', model: 'MiniMax-M2.7' }
    await ctx.systemPrompt.assemble()
    expect(ref.assembled).toEqual({ provider: 'anthropic', model: 'MiniMax-M2.7' })
    await expect(agentEvents(ctx, agent).waterfall(
      'agent/request', { turn: 1, step: 2, signal }, () => Promise.resolve(seed),
    )).resolves.toEqual({ provider: 'anthropic', model: 'MiniMax-M2.7' })

    // 4) seed 中的 reasoningEffort 被 ref 覆盖(per upstream contract)。
    //
    // LlmCallConfig.reasoningEffort 是 `ReasoningEffortId` = Branded<'ReasoningEffortId'>
    // (参见 deepseek-harness packages/llm/llm/src/brand.ts:55-63),不是 plain string;
    // 用上游同时 import 的 Reason() 工厂 brand 一下,而不是用 `as` 跨 brand cast。
    const inherited: LlmCallConfig = {
      provider: 'alpha', model: 'a1', reasoningEffort: Reason('high'),
    }
    ref.current = { provider: 'anthropic', model: 'MiniMax-M3' }
    await ctx.systemPrompt.assemble()
    await expect(agentEvents(ctx, agent).waterfall(
      'agent/request', { turn: 1, step: 3, signal }, () => Promise.resolve(inherited),
    )).resolves.toEqual({ provider: 'anthropic', model: 'MiniMax-M3' })

    // 5) dispose 后 listener 不再生效
    dispose()
    ref.current = { provider: 'anthropic', model: 'override-after-dispose' }
    await ctx.systemPrompt.assemble()
    await expect(agentEvents(ctx, agent).waterfall(
      'agent/request', { turn: 2, step: 0, signal }, () => Promise.resolve(seed),
    )).resolves.toBe(seed)

    await ctx.fiber.dispose()
  })

  it('systemPrompt.assemble() 同步读 ref.current 的 provider/model', async () => {
    const ctx = new Context()
    await ctx.plugin(SystemPrompt)
    const ref: ModelSelectionRef = { current: undefined, assembled: undefined }
    installModelSelection(ctx, ref)

    // 初始空 ref → 空 variables
    expect((await ctx.systemPrompt.assemble()).variables).toEqual({})

    // 设 ref 后 variables 反映
    ref.current = { provider: 'anthropic', model: 'MiniMax-M3' }
    expect((await ctx.systemPrompt.assemble()).variables).toMatchObject({
      provider: 'anthropic',
      model: 'MiniMax-M3',
    })

    // 切换 model → 下次 assemble 同步更新
    ref.current = { provider: 'anthropic', model: 'MiniMax-M2.7' }
    expect((await ctx.systemPrompt.assemble()).variables).toMatchObject({
      provider: 'anthropic',
      model: 'MiniMax-M2.7',
    })

    await ctx.fiber.dispose()
  })
})

describe('resolveModelSelection()', () => {
  it('settingsModel 优先', () => {
    process.env.ANTHROPIC_DEFAULT_SONNET_MODEL = 'env-default'
    expect(resolveModelSelection({ settingsModel: 'settings-model' }))
      .toEqual({ provider: 'anthropic', model: 'settings-model' })
  })

  it('缺 settingsModel 时退化到 ANTHROPIC_DEFAULT_SONNET_MODEL', () => {
    process.env.ANTHROPIC_DEFAULT_SONNET_MODEL = 'env-default'
    delete process.env.ANTHROPIC_SMALL_FAST_MODEL
    expect(resolveModelSelection({}))
      .toEqual({ provider: 'anthropic', model: 'env-default' })
  })

  it('再退化到 ANTHROPIC_SMALL_FAST_MODEL', () => {
    delete process.env.ANTHROPIC_DEFAULT_SONNET_MODEL
    process.env.ANTHROPIC_SMALL_FAST_MODEL = 'env-fast'
    expect(resolveModelSelection({}))
      .toEqual({ provider: 'anthropic', model: 'env-fast' })
  })

  it('全空时退化到 MiniMax-M3', () => {
    delete process.env.ANTHROPIC_DEFAULT_SONNET_MODEL
    delete process.env.ANTHROPIC_SMALL_FAST_MODEL
    expect(resolveModelSelection({}))
      .toEqual({ provider: 'anthropic', model: 'MiniMax-M3' })
  })
})
