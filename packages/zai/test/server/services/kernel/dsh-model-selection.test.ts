/**
 * ds-021 hotfix — zai-side adapter unit 测试。
 *
 * 覆盖 dsh adapter 内 model selection 行为,但**不** spin up 完整 dsh
 * runtime(后者由 dsh-bridge 的 run-model-selection.test.ts 在下游守护)。
 *
 * 三块:
 *   1. `resolveSelectedModel` 纯函数测试 (5 cases)
 *   2. `__getModelSelectionRefForTests` 验证 module-level Map 状态
 *   3. import check — `@zn-ai/dsh-bridge` 透传的 `ModelSelectionRef` 与
 *      `createModelSelectionRef` 在 zai-side 可见
 *
 * 真 dsh ctx 装载路径(setup 中 installModelSelection 装入、agent loop
 * 启动后 ref.assembled 自动 snapshot)已在 packages/dsh-bridge/test/
 * run-model-selection.test.ts 端到端覆盖。
 */

import { describe, it, expect, beforeEach } from 'vitest'
import {
  __resetDshContextForTests,
  __getModelSelectionRefForTests,
  resolveSelectedModel,
  validateReasoningEffort,
} from '../../../../src/server/services/kernel/factories/dsh.js'
import {
  createModelSelectionRef,
  type ModelSelectionRef,
} from '@zn-ai/dsh-bridge'

describe('resolveSelectedModel() — ds-021 model 校验/回退', () => {
  const profileModels = [
    'MiniMax-M3',
    { id: 'MiniMax-M2.7' },
    { id: 'MiniMax-M2.7-highspeed' },
  ] as const

  it('requestedModel 在 profile 里 → 返回它', () => {
    expect(resolveSelectedModel('MiniMax-M3', profileModels, 'default'))
      .toBe('MiniMax-M3')
  })

  it('requestedModel 在 profile 里(DshModelEntry 形态的 id) → 返回它', () => {
    expect(resolveSelectedModel('MiniMax-M2.7', profileModels, 'default'))
      .toBe('MiniMax-M2.7')
    expect(resolveSelectedModel('MiniMax-M2.7-highspeed', profileModels, 'default'))
      .toBe('MiniMax-M2.7-highspeed')
  })

  it('requestedModel 不在 profile → fallback 到 defaultModel', () => {
    expect(resolveSelectedModel('unknown-model', profileModels, 'MiniMax-M3'))
      .toBe('MiniMax-M3')
  })

  it('requestedModel undefined → fallback 到 defaultModel', () => {
    expect(resolveSelectedModel(undefined, profileModels, 'MiniMax-M3'))
      .toBe('MiniMax-M3')
  })

  it('requestedModel 空串 → fallback 到 defaultModel(空串视为未指定)', () => {
    expect(resolveSelectedModel('', profileModels, 'MiniMax-M3'))
      .toBe('MiniMax-M3')
  })

  it('defaultModel 也空 → 用 profile 第一个 model(string 形态)', () => {
    const stringFirst = ['MiniMax-M3', 'MiniMax-M2.7']
    expect(resolveSelectedModel(undefined, stringFirst, ''))
      .toBe('MiniMax-M3')
  })

  it('defaultModel 空 + profile 第一个是 DshModelEntry → 用其 .id', () => {
    const entryFirst = [{ id: 'MiniMax-M2.7-highspeed' }, 'MiniMax-M3']
    expect(resolveSelectedModel(undefined, entryFirst, ''))
      .toBe('MiniMax-M2.7-highspeed')
  })

  it('全空 → 返回空串(让 dsh 报错,不偷偷生造)', () => {
    expect(resolveSelectedModel(undefined, [], ''))
      .toBe('')
  })
})

describe('module-level modelSelectionRefs map — ds-021 zai 端 ref 持有', () => {
  // 每次测试前清 module-level state — 测试工厂内部用同一份 Map。
  beforeEach(() => {
    __resetDshContextForTests()
  })

  it('未注册过 sessionId 的 ref 查询 → 返回 undefined', () => {
    expect(__getModelSelectionRefForTests('unseen-session'))
      .toBeUndefined()
  })

  it('createModelSelectionRef 工厂(createModelSelectionRef 来自 dsh-bridge)形态正确', () => {
    const ref: ModelSelectionRef = createModelSelectionRef({
      provider: 'anthropic',
      model: 'MiniMax-M3',
    })
    expect(ref.current).toEqual({ provider: 'anthropic', model: 'MiniMax-M3' })
    expect(ref.assembled).toBeUndefined()

    // ref 是 mutable holder — caller 可 mutate
    ref.current = { provider: 'anthropic', model: 'MiniMax-M2.7' }
    expect(ref.current?.model).toBe('MiniMax-M2.7')
  })

  it('createModelSelectionRef() 不传初值 → current/assembled 都是 undefined', () => {
    const ref = createModelSelectionRef()
    expect(ref.current).toBeUndefined()
    expect(ref.assembled).toBeUndefined()
  })
})

describe('zai import — dsh-bridge 透传的 ModelSelectionRef 可见性', () => {
  it('@zn-ai/dsh-bridge 暴露 ModelSelectionRef 类型(compile-time 已通过)', () => {
    // 编译期 via tsconfig 检查 — import 出现在文件头,运行期只需
    // instanceof-style smoke check 防止 dsh-bridge 端的 export 漏掉。
    const ref: ModelSelectionRef = {
      current: { provider: 'anthropic', model: 'MiniMax-M3' },
      assembled: undefined,
    }
    expect(ref).toBeDefined()
    expect(ref.current?.provider).toBe('anthropic')
  })
})

/**
 * ds-022 effort-picker follow-up:user picker 选出的 reasoningEffort 必须
 * 验证对 selectedModel 合法。upstream `installModelSelection`
 * (`model-selection.ts:60-68`)的 emitter 设计:
 * - selected.reasoningEffort === undefined → 剥离 inherited reasoningEffort
 * - selected.reasoningEffort !== undefined → 覆盖
 *
 * 这个测试覆盖 user-effort × model 的几条关键决策路径。
 */
describe('validateReasoningEffort() — ds-022 per-model effort', () => {
  const PROFILE = [
    { id: 'MiniMax-M3',          reasoningEfforts: ['low', 'medium', 'high'] },
    { id: 'MiniMax-M2.7',        reasoningEfforts: ['low', 'medium', 'high'] },
    { id: 'MiniMax-M2.7-highspeed', reasoningEfforts: false },
  ]

  it('user-effort undefined → undefined(让 upstream 剥离 inherited)', () => {
    expect(validateReasoningEffort(undefined, 'MiniMax-M3', PROFILE)).toBeUndefined()
  })

  it('user-effort 空串 → undefined', () => {
    expect(validateReasoningEffort('', 'MiniMax-M3', PROFILE)).toBeUndefined()
  })

  it('reasoning-capable model + 在支持的 level 列表里 → brand 后返回', () => {
    expect(validateReasoningEffort('medium', 'MiniMax-M3', PROFILE)).toBe('medium')
    expect(validateReasoningEffort('low',    'MiniMax-M3', PROFILE)).toBe('low')
  })

  it('reasoning-capable model + 不在支持列表里 → undefined(静默降级 + ZAI_DEBUG warning)', () => {
    expect(validateReasoningEffort('ultracode', 'MiniMax-M3', PROFILE)).toBeUndefined()
  })

  it('non-reasoning model(标 reasoningEfforts: false)+ 任意 effort → undefined', () => {
    expect(validateReasoningEffort('medium', 'MiniMax-M2.7-highspeed', PROFILE)).toBeUndefined()
    expect(validateReasoningEffort('off',    'MiniMax-M2.7-highspeed', PROFILE)).toBeUndefined()
  })

  it('model 不在 profile 里 → undefined(防御性)', () => {
    expect(validateReasoningEffort('medium', 'some-unknown-model', PROFILE)).toBeUndefined()
  })

  it('profile 仅含 string 形态 model id → 仍能匹配', () => {
    const stringProfile = ['MiniMax-M3', 'MiniMax-M2.7']
    expect(validateReasoningEffort('medium', 'MiniMax-M3', stringProfile)).toBe('medium')
  })
})
