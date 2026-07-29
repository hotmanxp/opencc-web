import { describe, expect, test } from 'bun:test'
import {
  modelLooksZaiCompatible,
  normalizeZaiReasoningEffort,
  supportsZaiReasoningEffort,
} from './effort.ts'

describe('supportsZaiReasoningEffort', () => {
  test('passes glm-5.2 (canonical id)', () => {
    expect(supportsZaiReasoningEffort('glm-5.2')).toBe(true)
  })

  test('passes zai-org/glm-5.2 (vendor-namespaced id)', () => {
    expect(supportsZaiReasoningEffort('zai-org/glm-5.2')).toBe(true)
  })

  test('passes zhiniao-glm-5.1 (openai provider alias for glm-5.2)', () => {
    // opencc keeps the historical brand-id `zhiniao-glm-5.1` for the openai
    // provider's opus-tier alias, but routes the call to GLM-5.2. Both ids
    // (and the alias) must surface the zai reasoning_effort vocabulary so
    // users pick a real level rather than seeing only the default.
    expect(supportsZaiReasoningEffort('zhiniao-glm-5.1')).toBe(true)
  })

  test('strips `?reasoning=<level>` query suffix before matching', () => {
    expect(supportsZaiReasoningEffort('glm-5.2?reasoning=xhigh')).toBe(true)
    expect(supportsZaiReasoningEffort('zhiniao-glm-5.1?reasoning=high')).toBe(true)
  })

  test('rejects older GLM models that do not accept reasoning_effort', () => {
    expect(supportsZaiReasoningEffort('glm-5.1')).toBe(false)
    expect(supportsZaiReasoningEffort('GLM-5')).toBe(false)
    expect(supportsZaiReasoningEffort('GLM-5-Turbo')).toBe(false)
    expect(supportsZaiReasoningEffort('GLM-4.7')).toBe(false)
    expect(supportsZaiReasoningEffort('GLM-4.5-Air')).toBe(false)
    expect(supportsZaiReasoningEffort('zai-org/glm-5.1')).toBe(false)
  })

  test('rejects unrelated model ids', () => {
    expect(supportsZaiReasoningEffort('claude-opus-4-6')).toBe(false)
    expect(supportsZaiReasoningEffort('minimax-m3')).toBe(false)
    expect(supportsZaiReasoningEffort('gpt-4o')).toBe(false)
    expect(supportsZaiReasoningEffort(undefined)).toBe(false)
    expect(supportsZaiReasoningEffort('')).toBe(false)
  })

  test('is case-insensitive on the base model portion', () => {
    expect(supportsZaiReasoningEffort('GLM-5.2')).toBe(true)
    expect(supportsZaiReasoningEffort('Zhiniao-GLM-5.1')).toBe(true)
  })
})

describe('modelLooksZaiCompatible', () => {
  test('matches the glm-* family prefix', () => {
    expect(modelLooksZaiCompatible('glm-5.2')).toBe(true)
    expect(modelLooksZaiCompatible('glm-5.1')).toBe(true)
    expect(modelLooksZaiCompatible('glm-4.5-air')).toBe(true)
  })

  test('matches zai-org/glm-* vendor-namespaced prefix', () => {
    expect(modelLooksZaiCompatible('zai-org/glm-5.2')).toBe(true)
    expect(modelLooksZaiCompatible('zai-org/glm-4.7')).toBe(true)
  })

  test('strips trailing query string', () => {
    expect(modelLooksZaiCompatible('glm-5.2?reasoning=high')).toBe(true)
    expect(modelLooksZaiCompatible('glm-5.1?thinking=disabled')).toBe(true)
  })

  test('does not match Claude / GPT / DeepSeek / MiniMax model ids', () => {
    expect(modelLooksZaiCompatible('claude-opus-4-6')).toBe(false)
    expect(modelLooksZaiCompatible('gpt-4o')).toBe(false)
    expect(modelLooksZaiCompatible('minimax-m3')).toBe(false)
    expect(modelLooksZaiCompatible('deepseek-v4-flash')).toBe(false)
  })

  test('does not fuzzy-match glm later in the string', () => {
    expect(modelLooksZaiCompatible('claude-glm-fake')).toBe(false)
    expect(modelLooksZaiCompatible('openai-compatible-glm-5.2')).toBe(false)
  })
})

describe('normalizeZaiReasoningEffort', () => {
  test('low / medium collapse to high (zai rejects low|medium on the wire)', () => {
    expect(normalizeZaiReasoningEffort('low')).toBe('high')
    expect(normalizeZaiReasoningEffort('medium')).toBe('high')
  })

  test('high stays high', () => {
    expect(normalizeZaiReasoningEffort('high')).toBe('high')
  })

  test('xhigh upgrades to max (zai\'s deepest reasoning marker)', () => {
    expect(normalizeZaiReasoningEffort('xhigh')).toBe('max')
  })

  test('max / ultracode (opencc deep-reasoning markers) map to max', () => {
    expect(normalizeZaiReasoningEffort('max')).toBe('max')
    expect(normalizeZaiReasoningEffort('ultracode')).toBe('max')
  })
})
