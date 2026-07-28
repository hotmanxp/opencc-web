import { describe, expect, test } from 'bun:test'
import { applyZhiniaoModelPrefix, isWizardAiBaseUrl } from './providerUtils.js'

describe('isWizardAiBaseUrl', () => {
  test('matches wizard-ai subdomain', () => {
    expect(isWizardAiBaseUrl('https://wizard-ai.paic.com.cn/v1')).toBe(true)
  })

  test('matches when wizard-ai is a hostname token', () => {
    expect(isWizardAiBaseUrl('https://api.wizard-ai.example.com/v1')).toBe(true)
  })

  test('is case-insensitive on hostname', () => {
    expect(isWizardAiBaseUrl('https://WIZARD-AI.paic.com.cn/v1')).toBe(true)
  })

  test('does not match unrelated hosts', () => {
    expect(isWizardAiBaseUrl('https://api.openai.com/v1')).toBe(false)
    expect(isWizardAiBaseUrl('https://api.moonshot.cn/v1')).toBe(false)
    expect(isWizardAiBaseUrl('http://localhost:11434/v1')).toBe(false)
  })

  test('does not substring-match a path that happens to contain wizard-ai', () => {
    // hostname-only check; this URL has "wizard-ai" only in the path
    expect(isWizardAiBaseUrl('https://api.example.com/wizard-ai/v1')).toBe(false)
  })

  test('returns false for undefined and invalid URLs', () => {
    expect(isWizardAiBaseUrl(undefined)).toBe(false)
    expect(isWizardAiBaseUrl('')).toBe(false)
    expect(isWizardAiBaseUrl('not-a-url')).toBe(false)
  })
})

describe('applyZhiniaoModelPrefix', () => {
  test('prepends zhiniao- when base URL is wizard-ai and model lacks prefix', () => {
    expect(
      applyZhiniaoModelPrefix(
        'https://wizard-ai.paic.com.cn/v1',
        'MiniMax-M2.7-highspeed',
      ),
    ).toBe('zhiniao-MiniMax-M2.7-highspeed')
  })

  test('leaves model untouched when it already has the prefix', () => {
    expect(
      applyZhiniaoModelPrefix(
        'https://wizard-ai.paic.com.cn/v1',
        'zhiniao-MiniMax-M2.7-highspeed',
      ),
    ).toBe('zhiniao-MiniMax-M2.7-highspeed')
  })

  test('does not prepend when base URL is not wizard-ai', () => {
    expect(
      applyZhiniaoModelPrefix(
        'https://api.openai.com/v1',
        'MiniMax-M2.7-highspeed',
      ),
    ).toBe('MiniMax-M2.7-highspeed')
  })

  test('passes through empty model unchanged', () => {
    expect(applyZhiniaoModelPrefix('https://wizard-ai.paic.com.cn/v1', '')).toBe('')
    expect(applyZhiniaoModelPrefix(undefined, '')).toBe('')
  })

  test('handles invalid base URL gracefully (no prefix applied)', () => {
    expect(applyZhiniaoModelPrefix('not-a-url', 'foo')).toBe('foo')
  })
})
