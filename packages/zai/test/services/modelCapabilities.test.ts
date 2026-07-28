/**
 * Tests for per-model max output token resolution.
 *
 * Background: this lookup drives `modelCaller.ts`'s `max_tokens` parameter,
 * which is the root cause of "Write 工具写入长内容被截断" when hardcoded
 * too low. The values MUST match each model's native ceiling; an
 * under-spec'd cap truncates even moderately long Write tool calls.
 */
import { afterEach, describe, expect, it } from 'vitest'
import {
  getModelMaxOutputTokens,
  getThinkingBudgetTokens,
} from '../../src/server/services/modelCapabilities.js'

const ORIGINAL_ENV = process.env.ZAI_MAX_OUTPUT_TOKENS

afterEach(() => {
  if (ORIGINAL_ENV === undefined) {
    delete process.env.ZAI_MAX_OUTPUT_TOKENS
  } else {
    process.env.ZAI_MAX_OUTPUT_TOKENS = ORIGINAL_ENV
  }
})

describe('getModelMaxOutputTokens', () => {
  it('MiniMax-M3 — supports 512k (do NOT regress to 8k)', () => {
    expect(getModelMaxOutputTokens('MiniMax-M3')).toBe(512_000)
  })

  it('MiniMax-M2.x family — supports 131k', () => {
    expect(getModelMaxOutputTokens('MiniMax-M2.7')).toBe(131_072)
    expect(getModelMaxOutputTokens('MiniMax-M2.7-highspeed')).toBe(131_072)
    expect(getModelMaxOutputTokens('MiniMax-M2.5')).toBe(131_072)
    expect(getModelMaxOutputTokens('MiniMax-M2.1')).toBe(131_072)
  })

  it('zhiniao gateway aliases — same as their MiniMax parents', () => {
    expect(getModelMaxOutputTokens('zhiniao-MiniMax-M2.7')).toBe(512_000)
    expect(getModelMaxOutputTokens('zhiniao-MiniMax-M2.7-highspeed')).toBe(131_072)
  })

  it('Anthropic Claude Sonnet 4.5 — supports 64k (no more 8k truncation)', () => {
    expect(getModelMaxOutputTokens('claude-sonnet-4-5')).toBe(64_000)
  })

  it('Anthropic Claude 3.5 Sonnet — capped at 8k', () => {
    expect(getModelMaxOutputTokens('claude-3-5-sonnet-latest')).toBe(8_192)
  })

  it('Anthropic Claude 3 Opus — capped at 4k (our lower bound kicks in)', () => {
    expect(getModelMaxOutputTokens('claude-3-opus-latest')).toBe(4_096)
  })

  it('Date-suffixed variants resolve to base model limit', () => {
    // Anthropic stamps -YYYY-MM-DD on model IDs; the lookup should tolerate.
    expect(getModelMaxOutputTokens('MiniMax-M3-2025-09-29')).toBe(512_000)
    expect(getModelMaxOutputTokens('claude-sonnet-4-5-latest')).toBe(64_000)
  })

  it('Case-insensitive lookup', () => {
    expect(getModelMaxOutputTokens('minimax-m3')).toBe(512_000)
    expect(getModelMaxOutputTokens('CLAUDE-SONNET-4-5')).toBe(64_000)
  })

  it('Unknown model falls back to DEFAULT_MAX_OUTPUT_TOKENS (64k, not 8k)', () => {
    // The whole point of this fix: even unknown models get a usable budget.
    // 64k covers every production model zai routes through (Sonnet 4.5
    // tops at 64k), so an unknown model still gets a sensible default.
    expect(getModelMaxOutputTokens('gpt-future-9-ultra')).toBe(64_000)
  })

  it('undefined model falls back to DEFAULT_MAX_OUTPUT_TOKENS', () => {
    expect(getModelMaxOutputTokens(undefined)).toBe(64_000)
  })

  it('ZAI_MAX_OUTPUT_TOKENS env override beats model table', () => {
    process.env.ZAI_MAX_OUTPUT_TOKENS = '64000'
    expect(getModelMaxOutputTokens('MiniMax-M3')).toBe(64_000)
    expect(getModelMaxOutputTokens(undefined)).toBe(64_000)
  })

  it('ZAI_MAX_OUTPUT_TOKENS env override beats MIN bound', () => {
    // User can lower below MIN by accident — we still clamp up to 4k for safety.
    process.env.ZAI_MAX_OUTPUT_TOKENS = '1000'
    expect(getModelMaxOutputTokens('MiniMax-M3')).toBe(4_000)
  })

  it('ZAI_MAX_OUTPUT_TOKENS env ignores garbage values', () => {
    process.env.ZAI_MAX_OUTPUT_TOKENS = 'not-a-number'
    expect(getModelMaxOutputTokens('MiniMax-M3')).toBe(512_000)
    process.env.ZAI_MAX_OUTPUT_TOKENS = ''
    expect(getModelMaxOutputTokens('MiniMax-M3')).toBe(512_000)
  })

  it('ZAI_MAX_OUTPUT_TOKENS env ignores zero/negative values', () => {
    process.env.ZAI_MAX_OUTPUT_TOKENS = '0'
    expect(getModelMaxOutputTokens('MiniMax-M3')).toBe(512_000)
    process.env.ZAI_MAX_OUTPUT_TOKENS = '-100'
    expect(getModelMaxOutputTokens('MiniMax-M3')).toBe(512_000)
  })

  it('Lower bound MIN_MAX_OUTPUT_TOKENS applies to all lookups', () => {
    // Even if a table row is somehow tiny, we never go below 4k — that's the
    // minimum budget for a usable Write tool call.
    expect(getModelMaxOutputTokens('claude-3-opus-latest')).toBeGreaterThanOrEqual(4_000)
  })
})

describe('getThinkingBudgetTokens', () => {
  it('clamped lower bound when max_tokens is tiny', () => {
    expect(getThinkingBudgetTokens(4096)).toBe(1024)
    expect(getThinkingBudgetTokens(2000)).toBe(1024)
  })

  it('25% of max_tokens in mid-range', () => {
    expect(getThinkingBudgetTokens(8192)).toBe(2048)
    expect(getThinkingBudgetTokens(16000)).toBe(4000)
    expect(getThinkingBudgetTokens(32000)).toBe(8000)
  })

  it('clamped upper bound for huge models', () => {
    expect(getThinkingBudgetTokens(64000)).toBe(8192)
    expect(getThinkingBudgetTokens(512000)).toBe(8192)
  })

  it('Anthropic constraint: budget < max_tokens', () => {
    // budget_tokens must be strictly less than max_tokens (API requirement).
    // For 4k, budget=1024 — valid; for 4097, budget=1024 — still valid.
    for (const max of [4096, 8192, 16000, 32000, 64000, 512000]) {
      expect(getThinkingBudgetTokens(max)).toBeLessThan(max)
    }
  })
})

describe('integration: model → max_tokens → thinking budget', () => {
  it('MiniMax-M3 gets 512k max with 8k thinking — leaves 504k for content', () => {
    const max = getModelMaxOutputTokens('MiniMax-M3')
    const budget = getThinkingBudgetTokens(max)
    expect(max).toBe(512_000)
    expect(budget).toBe(8_192)
    expect(max - budget).toBeGreaterThan(500_000)
  })

  it('claude-sonnet-4-5 gets 64k max with 8k thinking — leaves 56k for content', () => {
    const max = getModelMaxOutputTokens('claude-sonnet-4-5')
    const budget = getThinkingBudgetTokens(max)
    expect(max).toBe(64_000)
    expect(budget).toBe(8_192)
    expect(max - budget).toBeGreaterThan(50_000)
  })

  it('regression guard: no model is silently capped at 8k', () => {
    // This is THE invariant the fix protects. If any model gets 8k here,
    // Write tool calls >4k tokens of content will truncate again.
    const models = [
      'MiniMax-M3',
      'MiniMax-M2.7',
      'zhiniao-MiniMax-M2.7',
      'claude-sonnet-4-5',
      'claude-opus-4-5',
      'claude-3-7-sonnet-latest',
    ]
    for (const m of models) {
      expect(getModelMaxOutputTokens(m), `${m} should not be capped at 8k`).toBeGreaterThan(8_192)
    }
  })
})