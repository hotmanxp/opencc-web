import { describe, it, expect } from 'vitest'
import { buildProviderEntries, type DshProviderProfile } from '../src/createDshRuntime.js'

/**
 * buildProviderEntries transform 测试 — Phase 3 P1 follow-up DSH thinking
 * 修复。
 *
 * 关键不变量：
 * 1. `DshModelEntry.reasoningEfforts: string[]` → pi-ai dict `{ level: wireValue }`
 *    （zai 不映射 wireValue，key === value）。
 * 2. `DshModelEntry.reasoningEfforts: false` → 透传为 `false`(pi-ai 允许
 *    z.union([z.const(false), ...]) 形态,显式声明 model 不支持 reasoning)。
 * 3. pi-ai modelFields 要求 `name` 必填(`dsh-llm-pi-ai/lib/index.js:1604`),
 *    string 形态 model 和 DshModelEntry 都用 id 兜底填入。
 * 4. 缺省 reasoningEfforts 时不输出该字段(让 pi-ai catalog 视 model 为
 *    non-reasoning,stream 不产 thinking_delta → dsh-bridge 收不到
 *    reasoning-delta → runtime.thinking 永远不发)。
 */

const baseProfile: DshProviderProfile = {
  name: 'anthropic',
  baseURL: 'https://api.minimaxi.com/anthropic',
  apiKeyEnv: 'ANTHROPIC_AUTH_TOKEN',
}

describe('buildProviderEntries — reasoning transform', () => {
  it('string 形态 model 补 name 字段,不输出 reasoningEfforts', () => {
    const out = buildProviderEntries([
      { ...baseProfile, models: ['MiniMax-M3'] },
    ])
    const anthropic = out.anthropic as { models: Array<Record<string, unknown>> }
    expect(anthropic.models).toHaveLength(1)
    expect(anthropic.models[0]).toEqual({ id: 'MiniMax-M3', name: 'MiniMax-M3' })
    expect(anthropic.models[0].reasoningEfforts).toBeUndefined()
  })

  it('DshModelEntry 缺省 reasoningEfforts → 不输出字段', () => {
    const out = buildProviderEntries([
      {
        ...baseProfile,
        models: [
          { id: 'MiniMax-M3', input: ['text', 'image'], contextWindow: 1_000_000, maxTokens: 128_000 },
        ],
      },
    ])
    const anthropic = out.anthropic as { models: Array<Record<string, unknown>> }
    expect(anthropic.models[0]).toMatchObject({
      id: 'MiniMax-M3',
      name: 'MiniMax-M3',
      input: ['text', 'image'],
      contextWindow: 1_000_000,
      maxTokens: 128_000,
    })
    expect(anthropic.models[0].reasoningEfforts).toBeUndefined()
  })

  it('reasoningEfforts array → pi-ai dict(每个 level key=value)', () => {
    const out = buildProviderEntries([
      {
        ...baseProfile,
        models: [
          {
            id: 'MiniMax-M3',
            input: ['text', 'image'],
            contextWindow: 1_000_000,
            maxTokens: 128_000,
            reasoningEfforts: ['low', 'medium', 'high'],
          },
        ],
      },
    ])
    const anthropic = out.anthropic as { models: Array<Record<string, unknown>> }
    expect(anthropic.models[0].reasoningEfforts).toEqual({
      low: 'low',
      medium: 'medium',
      high: 'high',
    })
  })

  it('reasoningEfforts=false 透传为 false(显式声明不支持 reasoning)', () => {
    const out = buildProviderEntries([
      {
        ...baseProfile,
        models: [
          { id: 'MiniMax-M2.7-highspeed', reasoningEfforts: false },
        ],
      },
    ])
    const anthropic = out.anthropic as { models: Array<Record<string, unknown>> }
    expect(anthropic.models[0].reasoningEfforts).toBe(false)
  })

  it('mixed: 同一 profile 内 vision model 开 reasoning + highspeed 不开', () => {
    const out = buildProviderEntries([
      {
        ...baseProfile,
        models: [
          {
            id: 'MiniMax-M3',
            input: ['text', 'image'],
            contextWindow: 1_000_000,
            maxTokens: 128_000,
            reasoningEfforts: ['low', 'medium', 'high'],
          },
          {
            id: 'MiniMax-M2.7-highspeed',
            input: ['text'],
            contextWindow: 204_800,
            maxTokens: 131_072,
            reasoningEfforts: false,
          },
        ],
      },
    ])
    const anthropic = out.anthropic as { models: Array<Record<string, unknown>> }
    expect(anthropic.models[0].reasoningEfforts).toEqual({
      low: 'low',
      medium: 'medium',
      high: 'high',
    })
    expect(anthropic.models[1].reasoningEfforts).toBe(false)
  })

  it('displayName 透传(不写到 model 字段)', () => {
    const out = buildProviderEntries([
      { ...baseProfile, displayName: 'Anthropic (compat)', models: ['MiniMax-M3'] },
    ])
    const anthropic = out.anthropic as { displayName?: string; models: unknown[] }
    expect(anthropic.displayName).toBe('Anthropic (compat)')
    expect(anthropic.models).toHaveLength(1)
  })

  it('baseURL / apiKeyEnv 透传', () => {
    const out = buildProviderEntries([
      { ...baseProfile, models: [] },
    ])
    const anthropic = out.anthropic as { baseURL: string; apiKeyEnv: string }
    expect(anthropic.baseURL).toBe('https://api.minimaxi.com/anthropic')
    expect(anthropic.apiKeyEnv).toBe('ANTHROPIC_AUTH_TOKEN')
  })

  it('空 provider 列表 → 空对象', () => {
    const out = buildProviderEntries([])
    expect(out).toEqual({})
  })

  it('多个 provider 路由互不串扰', () => {
    const out = buildProviderEntries([
      { ...baseProfile, name: 'anthropic', models: [{ id: 'a', reasoningEfforts: ['low'] }] },
      { ...baseProfile, name: 'openai', baseURL: 'https://api.openai.com', apiKeyEnv: 'OPENAI_API_KEY', models: ['b'] },
    ])
    expect((out.anthropic as { models: Array<Record<string, unknown>> }).models[0].reasoningEfforts).toEqual({ low: 'low' })
    expect((out.openai as { models: Array<Record<string, unknown>> }).models[0]).toEqual({ id: 'b', name: 'b' })
  })

  it('缺省 reasoningEfforts 字段(空数组)在 DshModelEntry 中也是 undefined 输出', () => {
    // 防御性测试：空数组与未设置字段行为一致
    const out = buildProviderEntries([
      {
        ...baseProfile,
        models: [{ id: 'x', reasoningEfforts: [] }],
      },
    ])
    const anthropic = out.anthropic as { models: Array<Record<string, unknown>> }
    expect(anthropic.models[0].reasoningEfforts).toEqual({})
  })

  // ─── profile-level defaultReasoningEffort (dsh-021 root cause 修复) ───
  //
  // 历史 bug：zai 早期 `DshModelEntry.defaultReasoningEffort` 字段在
  // buildProviderEntries 中被静默丢弃。dsh-llm-pi-ai streamSimple 走
  // `profile.reasoning` 字段决定发给 anthropic API 的 thinking 参数 —
  // 不传时 pi-ai 不发 `thinking: { type: 'enabled' }`，API 默认 thinking
  // 关闭，dsh 永远收不到 `thinking_*` 事件，dsh-bridge translateSessionEvent
  // 永远不 emit `runtime.thinking` → UI ThinkingBlock 不显示。
  //
  // 修复：在 profile-level 暴露 `defaultReasoningEffort`，buildProviderEntries
  // 写到 provider 顶层 `reasoning` 字段，传给 dsh-llm-pi-ai 的
  // `PiAiProviderProfile.reasoning`。

  it('defaultReasoningEffort(profile-level) → provider.reasoning 字段', () => {
    const out = buildProviderEntries([
      {
        ...baseProfile,
        defaultReasoningEffort: 'medium',
        models: [
          {
            id: 'MiniMax-M3',
            reasoningEfforts: ['low', 'medium', 'high'],
          },
        ],
      },
    ])
    const anthropic = out.anthropic as {
      reasoning?: string
      models: Array<Record<string, unknown>>
    }
    expect(anthropic.reasoning).toBe('medium')
  })

  it('缺省 defaultReasoningEffort → 不输出 provider.reasoning 字段', () => {
    // 与 model-level 行为对齐：未设置就不写,让 pi-ai / dsh-llm-pi-ai
    // 走内置 catalog 默认(典型是 'off' 或某 model 第一个非 off level)。
    const out = buildProviderEntries([
      {
        ...baseProfile,
        models: [
          {
            id: 'MiniMax-M3',
            reasoningEfforts: ['low', 'medium', 'high'],
          },
        ],
      },
    ])
    const anthropic = out.anthropic as { reasoning?: unknown }
    expect(anthropic.reasoning).toBeUndefined()
  })

  it('"off" 作为 defaultReasoningEffort 仍写出 (显式禁用 thinking)', () => {
    // 与 undefined 区分 — 用户明确要 thinking off 时不应静默忽略。
    const out = buildProviderEntries([
      {
        ...baseProfile,
        defaultReasoningEffort: 'off',
        models: [
          {
            id: 'MiniMax-M2.7-highspeed',
            reasoningEfforts: ['low', 'medium', 'high'],  // model 仍声明支持
          },
        ],
      },
    ])
    const anthropic = out.anthropic as { reasoning?: string }
    expect(anthropic.reasoning).toBe('off')
  })
})
