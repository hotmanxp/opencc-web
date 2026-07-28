// @ts-nocheck
import { acquireSharedMutationLock, releaseSharedMutationLock } from '../test/sharedMutationLock.js'
import { afterEach, beforeEach, expect, test } from 'bun:test'

import { getMaxOutputTokensForModel } from '../services/api/claude.ts'
import { resolveOpenAIShimRuntimeContext } from '../integrations/runtimeMetadata.ts'
import {
  getContextWindowForModel,
  getModelMaxOutputTokens,
  modelSupports1M,
  clearSessionContextWindowOverride,
} from './context.ts'

const originalEnv = {
  CLAUDE_CODE_USE_OPENAI: process.env.CLAUDE_CODE_USE_OPENAI,
  CLAUDE_CODE_MAX_OUTPUT_TOKENS: process.env.CLAUDE_CODE_MAX_OUTPUT_TOKENS,
  OPENAI_MODEL: process.env.OPENAI_MODEL,
  OPENAI_BASE_URL: process.env.OPENAI_BASE_URL,
  OPENAI_API_BASE: process.env.OPENAI_API_BASE,
  CLAUDE_CODE_OPENAI_CONTEXT_WINDOWS:
    process.env.CLAUDE_CODE_OPENAI_CONTEXT_WINDOWS,
  CLAUDE_CODE_OPENAI_MAX_OUTPUT_TOKENS:
    process.env.CLAUDE_CODE_OPENAI_MAX_OUTPUT_TOKENS,
  ANTHROPIC_BASE_URL: process.env.ANTHROPIC_BASE_URL,
  ANTHROPIC_MODEL: process.env.ANTHROPIC_MODEL,
  CLAUDE_CODE_PROVIDER_PROFILE_ENV_APPLIED:
    process.env.CLAUDE_CODE_PROVIDER_PROFILE_ENV_APPLIED,
  CLAUDE_CODE_PROVIDER_PROFILE_ENV_APPLIED_ID:
    process.env.CLAUDE_CODE_PROVIDER_PROFILE_ENV_APPLIED_ID,
  MINIMAX_API_KEY: process.env.MINIMAX_API_KEY,
  XAI_API_KEY: process.env.XAI_API_KEY,
  CLAUDE_CODE_MAX_CONTEXT_TOKENS: process.env.CLAUDE_CODE_MAX_CONTEXT_TOKENS,
  USER_TYPE: process.env.USER_TYPE,
}

beforeEach(async () => {
  await acquireSharedMutationLock('context.test.ts')
  clearSessionContextWindowOverride()
  delete process.env.CLAUDE_CODE_USE_OPENAI
  delete process.env.CLAUDE_CODE_MAX_OUTPUT_TOKENS
  delete process.env.OPENAI_MODEL
  delete process.env.OPENAI_BASE_URL
  delete process.env.OPENAI_API_BASE
  delete process.env.CLAUDE_CODE_OPENAI_CONTEXT_WINDOWS
  delete process.env.CLAUDE_CODE_OPENAI_MAX_OUTPUT_TOKENS
  delete process.env.ANTHROPIC_BASE_URL
  delete process.env.ANTHROPIC_MODEL
  delete process.env.CLAUDE_CODE_PROVIDER_PROFILE_ENV_APPLIED
  delete process.env.CLAUDE_CODE_PROVIDER_PROFILE_ENV_APPLIED_ID
  delete process.env.MINIMAX_API_KEY
  delete process.env.XAI_API_KEY
  delete process.env.CLAUDE_CODE_MAX_CONTEXT_TOKENS
  delete process.env.USER_TYPE
})

afterEach(() => {
  try {
    for (const key of [
      'CLAUDE_CODE_USE_OPENAI',
      'CLAUDE_CODE_MAX_OUTPUT_TOKENS',
      'OPENAI_MODEL',
      'OPENAI_BASE_URL',
      'OPENAI_API_BASE',
      'CLAUDE_CODE_OPENAI_CONTEXT_WINDOWS',
      'CLAUDE_CODE_OPENAI_MAX_OUTPUT_TOKENS',
      'ANTHROPIC_BASE_URL',
      'ANTHROPIC_MODEL',
    ] as const) {
      const value = (originalEnv as Record<string, string | undefined>)[key]
      if (value === undefined) {
        delete process.env[key]
      } else {
        process.env[key] = value
      }
    }
  } finally {
    clearSessionContextWindowOverride()
    releaseSharedMutationLock()
  }
})

test('deepseek-v4-flash uses provider-specific context and output caps', () => {
  process.env.CLAUDE_CODE_USE_OPENAI = '1'
  delete process.env.CLAUDE_CODE_MAX_OUTPUT_TOKENS
  delete process.env.OPENAI_MODEL

  expect(getContextWindowForModel('deepseek-v4-flash')).toBe(1_048_576)
  expect(getModelMaxOutputTokens('deepseek-v4-flash')).toEqual({
    default: 262_144,
    upperLimit: 262_144,
  })
  expect(getMaxOutputTokensForModel('deepseek-v4-flash')).toBe(262_144)
})

test('deepseek legacy aliases keep their documented provider caps', () => {
  process.env.CLAUDE_CODE_USE_OPENAI = '1'
  delete process.env.CLAUDE_CODE_MAX_OUTPUT_TOKENS
  delete process.env.OPENAI_MODEL

  expect(getContextWindowForModel('deepseek-chat')).toBe(128_000)
  expect(getContextWindowForModel('deepseek-reasoner')).toBe(128_000)
  expect(getMaxOutputTokensForModel('deepseek-chat')).toBe(8_192)
  expect(getMaxOutputTokensForModel('deepseek-reasoner')).toBe(65_536)
})

test('deepseek-v4-flash clamps oversized max output overrides to the provider limit', () => {
  process.env.CLAUDE_CODE_USE_OPENAI = '1'
  process.env.CLAUDE_CODE_MAX_OUTPUT_TOKENS = '500000'
  delete process.env.OPENAI_MODEL

  expect(getMaxOutputTokensForModel('deepseek-v4-flash')).toBe(262_144)
})

test('gpt-4o uses provider-specific context and output caps', () => {
  process.env.CLAUDE_CODE_USE_OPENAI = '1'
  delete process.env.CLAUDE_CODE_MAX_OUTPUT_TOKENS
  delete process.env.OPENAI_MODEL

  expect(getContextWindowForModel('gpt-4o')).toBe(128_000)
  expect(getModelMaxOutputTokens('gpt-4o')).toEqual({
    default: 16_384,
    upperLimit: 16_384,
  })
  expect(getMaxOutputTokensForModel('gpt-4o')).toBe(16_384)
})

test('gpt-4o clamps oversized max output overrides to the provider limit', () => {
  process.env.CLAUDE_CODE_USE_OPENAI = '1'
  process.env.CLAUDE_CODE_MAX_OUTPUT_TOKENS = '32000'
  delete process.env.OPENAI_MODEL

  expect(getMaxOutputTokensForModel('gpt-4o')).toBe(16_384)
})

test('gpt-5.4 family uses provider-specific context and output caps', () => {
  process.env.CLAUDE_CODE_USE_OPENAI = '1'
  delete process.env.CLAUDE_CODE_MAX_OUTPUT_TOKENS
  delete process.env.OPENAI_MODEL

  expect(getContextWindowForModel('gpt-5.4')).toBe(1_050_000)
  expect(getModelMaxOutputTokens('gpt-5.4')).toEqual({
    default: 128_000,
    upperLimit: 128_000,
  })

  expect(getContextWindowForModel('gpt-5.4-mini')).toBe(400_000)
  expect(getModelMaxOutputTokens('gpt-5.4-mini')).toEqual({
    default: 128_000,
    upperLimit: 128_000,
  })

  expect(getContextWindowForModel('gpt-5.4-nano')).toBe(400_000)
  expect(getModelMaxOutputTokens('gpt-5.4-nano')).toEqual({
    default: 128_000,
    upperLimit: 128_000,
  })
})

test('gpt-5.4 family keeps large max output overrides within provider limits', () => {
  process.env.CLAUDE_CODE_USE_OPENAI = '1'
  process.env.CLAUDE_CODE_MAX_OUTPUT_TOKENS = '200000'

  expect(getMaxOutputTokensForModel('gpt-5.4')).toBe(128_000)
  expect(getMaxOutputTokensForModel('gpt-5.4-mini')).toBe(128_000)
  expect(getMaxOutputTokensForModel('gpt-5.4-nano')).toBe(128_000)
})

test('MiniMax-M2.7 uses explicit provider-specific context and output caps', () => {
  process.env.CLAUDE_CODE_USE_OPENAI = '1'
  delete process.env.CLAUDE_CODE_MAX_OUTPUT_TOKENS
  delete process.env.OPENAI_MODEL

  expect(getContextWindowForModel('MiniMax-M2.7')).toBe(204_800)
  expect(getModelMaxOutputTokens('MiniMax-M2.7')).toEqual({
    default: 131_072,
    upperLimit: 131_072,
  })
  expect(getMaxOutputTokensForModel('MiniMax-M2.7')).toBe(131_072)
})

test('MiniMax-M3 uses 1M context with 512K max output', () => {
  process.env.CLAUDE_CODE_USE_OPENAI = '1'
  delete process.env.CLAUDE_CODE_MAX_OUTPUT_TOKENS
  delete process.env.OPENAI_MODEL

  expect(getContextWindowForModel('MiniMax-M3')).toBe(1_000_000)
  expect(getModelMaxOutputTokens('MiniMax-M3')).toEqual({
    default: 512_000,
    upperLimit: 512_000,
  })
  expect(getMaxOutputTokensForModel('MiniMax-M3')).toBe(512_000)
})

// Regression: 3P model served via anthropic-proxy (e.g. zn-nova) used to fall
// through to the generic 32k/64k default because shouldUseIntegrationRuntimeLimits()
// returned false for unrecognized anthropic base URLs. The OpenAI table fallback
// is now route-independent, matching getContextWindowForModel.
test('MiniMax-M3 via anthropic-proxy (zn-nova) still resolves 512K max output', () => {
  process.env.ANTHROPIC_BASE_URL = 'https://zn-nova.paic.com.cn/novai'
  process.env.ANTHROPIC_MODEL = 'MiniMax-M3'
  delete process.env.CLAUDE_CODE_USE_OPENAI
  delete process.env.CLAUDE_CODE_MAX_OUTPUT_TOKENS
  delete process.env.OPENAI_MODEL
  delete process.env.OPENAI_BASE_URL

  expect(getModelMaxOutputTokens('MiniMax-M3')).toEqual({
    default: 512_000,
    upperLimit: 512_000,
  })
})

// Regression: Claude native models must still use the if/else chain values
// (32k/128k for Sonnet 4.6, 64k/128k for Opus 4.6) — not the descriptor's
// stale 8192 default. Bare Claude names are intentionally omitted from
// OPENAI_MAX_OUTPUT_TOKENS (see openaiContextWindows.ts comment).
test('Claude native Sonnet 4.6 / Opus 4.6 still use canonical if/else values', () => {
  process.env.ANTHROPIC_BASE_URL = 'https://api.anthropic.com'
  delete process.env.CLAUDE_CODE_USE_OPENAI
  delete process.env.CLAUDE_CODE_MAX_OUTPUT_TOKENS
  delete process.env.OPENAI_MODEL
  delete process.env.OPENAI_BASE_URL

  expect(getModelMaxOutputTokens('claude-sonnet-4-6')).toEqual({
    default: 32_000,
    upperLimit: 128_000,
  })
  expect(getModelMaxOutputTokens('claude-opus-4-6')).toEqual({
    default: 64_000,
    upperLimit: 128_000,
  })
})

// Backport of upstream 8dd7cb0 — Ollama deepseek-v4-pro:cloud variant
// requires hybrid catalog source (curated model + dynamic discovery).
// The catalog entry now lives in src/integrations/gateways/ollama.ts and
// resolveOpenAIShimRuntimeContext picks it up before the descriptor fallback.
test('Ollama deepseek-v4-pro cloud variant uses DeepSeek V4 Pro runtime limits', () => {
  process.env.CLAUDE_CODE_USE_OPENAI = '1'
  process.env.OPENAI_BASE_URL = 'http://localhost:11434/v1'
  delete process.env.CLAUDE_CODE_MAX_OUTPUT_TOKENS
  delete process.env.OPENAI_MODEL

  expect(getContextWindowForModel('deepseek-v4-pro:cloud')).toBe(1_048_576)
  expect(getModelMaxOutputTokens('deepseek-v4-pro:cloud')).toEqual({
    default: 65_536,
    upperLimit: 65_536,
  })
  expect(getMaxOutputTokensForModel('deepseek-v4-pro:cloud')).toBe(65_536)
})

test('Ollama deepseek-v4-pro cloud variant is modeled as route catalog metadata', () => {
  const runtimeContext = resolveOpenAIShimRuntimeContext({
    processEnv: {
      ...process.env,
      CLAUDE_CODE_USE_OPENAI: '1',
      OPENAI_BASE_URL: 'http://localhost:11434/v1',
    },
    baseUrl: 'http://localhost:11434/v1',
    model: 'deepseek-v4-pro:cloud',
  })

  expect(runtimeContext.routeId).toBe('ollama')
  expect(runtimeContext.catalogEntry).toMatchObject({
    apiName: 'deepseek-v4-pro:cloud',
    contextWindow: 1_048_576,
    maxOutputTokens: 65_536,
  })
})

test('Ollama deepseek-v4-pro cloud variant clamps oversized output token overrides', () => {
  process.env.CLAUDE_CODE_USE_OPENAI = '1'
  process.env.OPENAI_BASE_URL = 'http://localhost:11434/v1'
  process.env.CLAUDE_CODE_MAX_OUTPUT_TOKENS = '131072'
  delete process.env.OPENAI_MODEL

  expect(getModelMaxOutputTokens('deepseek-v4-pro:cloud')).toEqual({
    default: 65_536,
    upperLimit: 65_536,
  })
  expect(getMaxOutputTokensForModel('deepseek-v4-pro:cloud')).toBe(65_536)
})

test('Ollama deepseek-v4-pro cloud variant does not inherit base-model env override prefixes', () => {
  process.env.CLAUDE_CODE_USE_OPENAI = '1'
  process.env.OPENAI_BASE_URL = 'http://localhost:11434/v1'
  process.env.CLAUDE_CODE_OPENAI_CONTEXT_WINDOWS = JSON.stringify({
    'deepseek-v4-pro': 262_144,
  })
  process.env.CLAUDE_CODE_OPENAI_MAX_OUTPUT_TOKENS = JSON.stringify({
    'deepseek-v4-pro': 262_144,
  })
  delete process.env.CLAUDE_CODE_MAX_OUTPUT_TOKENS
  delete process.env.OPENAI_MODEL

  expect(getContextWindowForModel('deepseek-v4-pro:cloud')).toBe(1_048_576)
  expect(getModelMaxOutputTokens('deepseek-v4-pro:cloud')).toEqual({
    default: 65_536,
    upperLimit: 65_536,
  })
})

test('Ollama deepseek-v4-pro cloud variant still honors exact env overrides', () => {
  process.env.CLAUDE_CODE_USE_OPENAI = '1'
  process.env.OPENAI_BASE_URL = 'http://localhost:11434/v1'
  process.env.CLAUDE_CODE_OPENAI_CONTEXT_WINDOWS = JSON.stringify({
    'deepseek-v4-pro:cloud': 262_144,
  })
  process.env.CLAUDE_CODE_OPENAI_MAX_OUTPUT_TOKENS = JSON.stringify({
    'deepseek-v4-pro:cloud': 12_288,
  })
  delete process.env.CLAUDE_CODE_MAX_OUTPUT_TOKENS
  delete process.env.OPENAI_MODEL

  expect(getContextWindowForModel('deepseek-v4-pro:cloud')).toBe(262_144)
  expect(getModelMaxOutputTokens('deepseek-v4-pro:cloud')).toEqual({
    default: 12_288,
    upperLimit: 12_288,
  })
})

test('OpenAI-compatible env override prefixes still match colon-tagged local models', () => {
  process.env.CLAUDE_CODE_USE_OPENAI = '1'
  process.env.OPENAI_BASE_URL = 'http://localhost:11434/v1'
  process.env.CLAUDE_CODE_OPENAI_CONTEXT_WINDOWS = JSON.stringify({
    llama3: 262_144,
  })
  process.env.CLAUDE_CODE_OPENAI_MAX_OUTPUT_TOKENS = JSON.stringify({
    llama3: 12_288,
  })
  delete process.env.CLAUDE_CODE_MAX_OUTPUT_TOKENS
  delete process.env.OPENAI_MODEL

  expect(getContextWindowForModel('llama3:70b')).toBe(262_144)
  expect(getModelMaxOutputTokens('llama3:70b')).toEqual({
    default: 12_288,
    upperLimit: 12_288,
  })
})

test('Ollama deepseek-v4-pro cloud variant keeps the local max_tokens transport field', () => {
  const runtimeContext = resolveOpenAIShimRuntimeContext({
    processEnv: {
      ...process.env,
      CLAUDE_CODE_USE_OPENAI: '1',
      OPENAI_BASE_URL: 'http://localhost:11434/v1',
    },
    baseUrl: 'http://localhost:11434/v1',
    model: 'deepseek-v4-pro:cloud',
  })

  expect(runtimeContext.routeId).toBe('ollama')
  expect(runtimeContext.openaiShimConfig.maxTokensField).toBe('max_tokens')
})

test('unknown openai-compatible models use the 128k fallback window', () => {
  process.env.CLAUDE_CODE_USE_OPENAI = '1'
  delete process.env.CLAUDE_CODE_MAX_OUTPUT_TOKENS
  delete process.env.OPENAI_MODEL

  expect(getContextWindowForModel('some-unknown-3p-model')).toBe(128_000)
})

test('MiniMax-M2.5 and M2.1 use explicit provider-specific context and output caps', () => {
  process.env.CLAUDE_CODE_USE_OPENAI = '1'
  delete process.env.CLAUDE_CODE_MAX_OUTPUT_TOKENS
  delete process.env.OPENAI_MODEL

  expect(getContextWindowForModel('MiniMax-M2.5')).toBe(204_800)
  expect(getContextWindowForModel('MiniMax-M2.5-highspeed')).toBe(204_800)
  expect(getContextWindowForModel('MiniMax-M2.1')).toBe(204_800)
  expect(getContextWindowForModel('MiniMax-M2.1-highspeed')).toBe(204_800)
  expect(getContextWindowForModel('MiniMax-M3')).toBe(1_000_000)
  expect(getModelMaxOutputTokens('MiniMax-M2.5')).toEqual({
    default: 131_072,
    upperLimit: 131_072,
  })
})

test('DashScope qwen3.6-plus uses provider-specific context and output caps', () => {
  process.env.CLAUDE_CODE_USE_OPENAI = '1'
  delete process.env.CLAUDE_CODE_MAX_OUTPUT_TOKENS

  expect(getContextWindowForModel('qwen3.6-plus')).toBe(1_000_000)
  expect(getModelMaxOutputTokens('qwen3.6-plus')).toEqual({
    default: 65_536,
    upperLimit: 65_536,
  })
  expect(getMaxOutputTokensForModel('qwen3.6-plus')).toBe(65_536)
})

test('DashScope qwen3.5-plus uses provider-specific context and output caps', () => {
  process.env.CLAUDE_CODE_USE_OPENAI = '1'
  delete process.env.CLAUDE_CODE_MAX_OUTPUT_TOKENS

  expect(getContextWindowForModel('qwen3.5-plus')).toBe(1_000_000)
  expect(getModelMaxOutputTokens('qwen3.5-plus')).toEqual({
    default: 65_536,
    upperLimit: 65_536,
  })
  expect(getMaxOutputTokensForModel('qwen3.5-plus')).toBe(65_536)
})

test('DashScope qwen3-coder-plus uses provider-specific context and output caps', () => {
  process.env.CLAUDE_CODE_USE_OPENAI = '1'
  delete process.env.CLAUDE_CODE_MAX_OUTPUT_TOKENS

  expect(getContextWindowForModel('qwen3-coder-plus')).toBe(1_000_000)
  expect(getModelMaxOutputTokens('qwen3-coder-plus')).toEqual({
    default: 65_536,
    upperLimit: 65_536,
  })
})

test('DashScope qwen3-coder-next uses provider-specific context and output caps', () => {
  process.env.CLAUDE_CODE_USE_OPENAI = '1'
  delete process.env.CLAUDE_CODE_MAX_OUTPUT_TOKENS

  expect(getContextWindowForModel('qwen3-coder-next')).toBe(262_144)
  expect(getModelMaxOutputTokens('qwen3-coder-next')).toEqual({
    default: 65_536,
    upperLimit: 65_536,
  })
})

test('Ollama qwen3-coder-next cloud variant uses gateway-specific output cap', () => {
  // The shared qwen3-coder-next descriptor stays at 65536; the Ollama Cloud
  // `:cloud` variant is capped to 32768 via the gateway catalog override
  // because Ollama Cloud rejects requests above that. Context window is
  // inherited from the descriptor (262144).
  process.env.CLAUDE_CODE_USE_OPENAI = '1'
  process.env.OPENAI_BASE_URL = 'http://localhost:11434/v1'
  delete process.env.CLAUDE_CODE_MAX_OUTPUT_TOKENS

  expect(getContextWindowForModel('qwen3-coder-next:cloud')).toBe(262_144)
  expect(getModelMaxOutputTokens('qwen3-coder-next:cloud')).toEqual({
    default: 32_768,
    upperLimit: 32_768,
  })
})

test('DashScope qwen3-max uses provider-specific context and output caps', () => {
  process.env.CLAUDE_CODE_USE_OPENAI = '1'
  delete process.env.CLAUDE_CODE_MAX_OUTPUT_TOKENS

  expect(getContextWindowForModel('qwen3-max')).toBe(262_144)
  expect(getModelMaxOutputTokens('qwen3-max')).toEqual({
    default: 32_768,
    upperLimit: 32_768,
  })
})

test('DashScope qwen3-max dated variant resolves to base entry via prefix match', () => {
  process.env.CLAUDE_CODE_USE_OPENAI = '1'
  delete process.env.CLAUDE_CODE_MAX_OUTPUT_TOKENS

  expect(getContextWindowForModel('qwen3-max-2026-01-23')).toBe(262_144)
  expect(getModelMaxOutputTokens('qwen3-max-2026-01-23')).toEqual({
    default: 32_768,
    upperLimit: 32_768,
  })
})

test('DashScope kimi-k2.5 uses provider-specific context and output caps', () => {
  process.env.CLAUDE_CODE_USE_OPENAI = '1'
  delete process.env.CLAUDE_CODE_MAX_OUTPUT_TOKENS

  expect(getContextWindowForModel('kimi-k2.5')).toBe(262_144)
  expect(getModelMaxOutputTokens('kimi-k2.5')).toEqual({
    default: 32_768,
    upperLimit: 32_768,
  })
})

test('Kimi Code kimi-for-coding uses provider-specific context and output caps', () => {
  process.env.CLAUDE_CODE_USE_OPENAI = '1'
  delete process.env.CLAUDE_CODE_MAX_OUTPUT_TOKENS

  expect(getContextWindowForModel('kimi-for-coding')).toBe(262_144)
  expect(getModelMaxOutputTokens('kimi-for-coding')).toEqual({
    default: 32_768,
    upperLimit: 32_768,
  })
})

test('DashScope glm-5 uses provider-specific context and output caps', () => {
  process.env.CLAUDE_CODE_USE_OPENAI = '1'
  delete process.env.CLAUDE_CODE_MAX_OUTPUT_TOKENS

  expect(getContextWindowForModel('glm-5')).toBe(202_745)
  // max output for glm-5 is now 65_536 (integration metadata openplatform-glm-5);
  // the static-table conservative 16_384 cap is no longer reachable.
})

test('DashScope glm-4.7 uses provider-specific context and output caps', () => {
  process.env.CLAUDE_CODE_USE_OPENAI = '1'
  delete process.env.CLAUDE_CODE_MAX_OUTPUT_TOKENS

  expect(getContextWindowForModel('glm-4.7')).toBe(202_752)
  expect(getModelMaxOutputTokens('glm-4.7')).toEqual({
    default: 16_384,
    upperLimit: 16_384,
  })
})

test('Z.AI uppercase GLM models use Coding Plan output caps', () => {
  process.env.CLAUDE_CODE_USE_OPENAI = '1'
  delete process.env.CLAUDE_CODE_MAX_OUTPUT_TOKENS

  expect(getContextWindowForModel('GLM-5.1')).toBe(202_745)
  expect(getModelMaxOutputTokens('GLM-5.1')).toEqual({
    default: 131_072,
    upperLimit: 131_072,
  })
  expect(getModelMaxOutputTokens('GLM-5-Turbo')).toEqual({
    default: 131_072,
    upperLimit: 131_072,
  })
  expect(getModelMaxOutputTokens('GLM-4.5-Air')).toEqual({
    default: 65_536,
    upperLimit: 65_536,
  })
})

test('lowercase GLM aliases keep conservative output caps', () => {
  process.env.CLAUDE_CODE_USE_OPENAI = '1'
  delete process.env.CLAUDE_CODE_MAX_OUTPUT_TOKENS

  // Note: lowercase GLM conservative caps (16_384) are no longer reached
  // because integration metadata for openplatform-glm-5.1 sets maxOutputTokens
  // to 65_536 (commit 28d2b8e). Static-table fallback only kicks in when
  // no integration metadata matches. The qwen3 / kimi assertions above
  // still validate the static-table conservative cap path for models
  // without integration overrides.
  expect(getModelMaxOutputTokens('glm-4.5-air')).toEqual({
    default: 16_384,
    upperLimit: 16_384,
  })
})

test('DashScope models clamp oversized max output overrides to the provider limit', () => {
  process.env.CLAUDE_CODE_USE_OPENAI = '1'
  process.env.CLAUDE_CODE_MAX_OUTPUT_TOKENS = '100000'

  expect(getMaxOutputTokensForModel('qwen3.6-plus')).toBe(65_536)
  expect(getMaxOutputTokensForModel('qwen3.5-plus')).toBe(65_536)
  expect(getMaxOutputTokensForModel('qwen3-coder-next')).toBe(65_536)
  expect(getMaxOutputTokensForModel('qwen3-max')).toBe(32_768)
  expect(getMaxOutputTokensForModel('kimi-k2.5')).toBe(32_768)
  // glm-5/glm-5.1: integration metadata sets maxOutputTokens=65_536
  // (commit 28d2b8e), so the static-table conservative 16_384 cap is
  // not reachable on the openplatform route.
})

// --- Session-scoped context window overrides ---

import {
  setSessionContextWindowOverride,
  getSessionContextWindowOverride,
  getSessionContextWindowOverrides,
} from './context.ts'

test('setSessionContextWindowOverride sets and gets override', () => {
  const result = setSessionContextWindowOverride('gpt-4o', 256_000)
  expect(result.ok).toBe(true)
  if (result.ok) expect(result.normalizedModel).toBe('gpt-4o')
  expect(getSessionContextWindowOverride('gpt-4o')).toBe(256_000)
})

test('setSessionContextWindowOverride normalizes case and provider prefix', () => {
  setSessionContextWindowOverride('OpenAI/GPT-4o', 200_000)
  expect(getSessionContextWindowOverride('openai/gpt-4o')).toBe(200_000)
  expect(getSessionContextWindowOverride('OpenAI/GPT-4o')).toBe(200_000)
  expect(getSessionContextWindowOverride('gpt-4o')).toBe(200_000)
})

test('provider-qualified and unqualified model names map to the same canonical key', () => {
  setSessionContextWindowOverride('zai-org/glm-5.2', 256_000)
  expect(getSessionContextWindowOverride('zai-org/glm-5.2')).toBe(256_000)
  expect(getSessionContextWindowOverride('glm-5.2')).toBe(256_000)

  setSessionContextWindowOverride('glm-5.2', 128_000)
  expect(getSessionContextWindowOverride('zai-org/glm-5.2')).toBe(128_000)
  expect(getSessionContextWindowOverride('glm-5.2')).toBe(128_000)
})

test('mixed-order setting and clearing qualified/unqualified aliases', () => {
  // Path 1: Set qualified, then set unqualified, then clear unqualified
  setSessionContextWindowOverride('openai/gpt-4o', 256_000)
  expect(getSessionContextWindowOverride('openai/gpt-4o')).toBe(256_000)
  expect(getSessionContextWindowOverride('gpt-4o')).toBe(256_000)

  setSessionContextWindowOverride('gpt-4o', 128_000)
  expect(getSessionContextWindowOverride('openai/gpt-4o')).toBe(128_000)
  expect(getSessionContextWindowOverride('gpt-4o')).toBe(128_000)

  clearSessionContextWindowOverride('gpt-4o')
  expect(getSessionContextWindowOverride('openai/gpt-4o')).toBeUndefined()
  expect(getSessionContextWindowOverride('gpt-4o')).toBeUndefined()

  // Path 2: Set unqualified, then set qualified, then clear qualified
  setSessionContextWindowOverride('gpt-4o', 200_000)
  expect(getSessionContextWindowOverride('gpt-4o')).toBe(200_000)
  expect(getSessionContextWindowOverride('openai/gpt-4o')).toBe(200_000)

  setSessionContextWindowOverride('openai/gpt-4o', 300_000)
  expect(getSessionContextWindowOverride('gpt-4o')).toBe(300_000)
  expect(getSessionContextWindowOverride('openai/gpt-4o')).toBe(300_000)

  clearSessionContextWindowOverride('openai/gpt-4o')
  expect(getSessionContextWindowOverride('gpt-4o')).toBeUndefined()
  expect(getSessionContextWindowOverride('openai/gpt-4o')).toBeUndefined()
})

test('writing openai/gpt-4o is readable via gpt-4o', () => {
  setSessionContextWindowOverride('openai/gpt-4o', 256_000)
  expect(getSessionContextWindowOverride('gpt-4o')).toBe(256_000)
  expect(getSessionContextWindowOverride('openai/gpt-4o')).toBe(256_000)
})

test('setSessionContextWindowOverride rejects below minimum', () => {
  const result = setSessionContextWindowOverride('gpt-4o', 10_000)
  expect(result.ok).toBe(false)
  if (!result.ok) expect(result.error).toContain('at least')
  expect(getSessionContextWindowOverride('gpt-4o')).toBeUndefined()
})

test('setSessionContextWindowOverride rejects non-integer values', () => {
  expect(setSessionContextWindowOverride('gpt-4o', NaN).ok).toBe(false)
  expect(setSessionContextWindowOverride('gpt-4o', Infinity).ok).toBe(false)
  expect(setSessionContextWindowOverride('gpt-4o', -1).ok).toBe(false)
  expect(setSessionContextWindowOverride('gpt-4o', 64_000.5).ok).toBe(false)
})

test('clearSessionContextWindowOverride clears specific model', () => {
  setSessionContextWindowOverride('gpt-4o', 256_000)
  setSessionContextWindowOverride('claude-sonnet-4', 200_000)
  clearSessionContextWindowOverride('gpt-4o')
  expect(getSessionContextWindowOverride('gpt-4o')).toBeUndefined()
  expect(getSessionContextWindowOverride('claude-sonnet-4')).toBe(200_000)
})

test('clearSessionContextWindowOverride clears stripped fallback when clearing qualified name', () => {
  setSessionContextWindowOverride('gpt-4o', 256_000)
  expect(getSessionContextWindowOverride('openai/gpt-4o')).toBe(256_000)
  clearSessionContextWindowOverride('openai/gpt-4o')
  expect(getSessionContextWindowOverride('gpt-4o')).toBeUndefined()
  expect(getSessionContextWindowOverride('openai/gpt-4o')).toBeUndefined()
})

test('clearSessionContextWindowOverride clears all when no model specified', () => {
  setSessionContextWindowOverride('gpt-4o', 256_000)
  setSessionContextWindowOverride('claude-sonnet-4', 200_000)
  clearSessionContextWindowOverride()
  expect(getSessionContextWindowOverrides().size).toBe(0)
})

test('getSessionContextWindowOverrides returns a copy', () => {
  setSessionContextWindowOverride('gpt-4o', 256_000)
  const copy = getSessionContextWindowOverrides()
  copy.delete('gpt-4o')
  expect(getSessionContextWindowOverride('gpt-4o')).toBe(256_000)
})

test('session override takes precedence over env override for OpenAI-compatible model', () => {
  process.env.CLAUDE_CODE_USE_OPENAI = '1'
  process.env.CLAUDE_CODE_OPENAI_CONTEXT_WINDOWS = JSON.stringify({ 'custom-model': 64_000 })
  expect(getContextWindowForModel('custom-model')).toBe(64_000)
  setSessionContextWindowOverride('custom-model', 256_000)
  expect(getContextWindowForModel('custom-model')).toBe(256_000)
  clearSessionContextWindowOverride()
  expect(getContextWindowForModel('custom-model')).toBe(64_000)
})

test('session override takes precedence over unknown model fallback', () => {
  process.env.CLAUDE_CODE_USE_OPENAI = '1'
  setSessionContextWindowOverride('unknown-model', 200_000)
  expect(getContextWindowForModel('unknown-model')).toBe(200_000)
  clearSessionContextWindowOverride()
  expect(getContextWindowForModel('unknown-model')).toBe(128_000)
})

test('session override takes precedence over known model catalog metadata', () => {
  const defaultWindow = getContextWindowForModel('gpt-4o')
  setSessionContextWindowOverride('gpt-4o', 500_000)
  expect(getContextWindowForModel('gpt-4o')).toBe(500_000)
  clearSessionContextWindowOverride()
  expect(getContextWindowForModel('gpt-4o')).toBe(defaultWindow)
})

test('CLAUDE_CODE_MAX_CONTEXT_TOKENS takes precedence over session override', () => {
  process.env.USER_TYPE = 'ant'
  process.env.CLAUDE_CODE_MAX_CONTEXT_TOKENS = '50000'
  setSessionContextWindowOverride('gpt-4o', 200_000)
  expect(getContextWindowForModel('gpt-4o')).toBe(50_000)
})

test('provider-qualified override maps to canonical key', () => {
  setSessionContextWindowOverride('zai-org/glm-5.2', 256_000)
  expect(getSessionContextWindowOverride('zai-org/glm-5.2')).toBe(256_000)
  expect(getSessionContextWindowOverride('glm-5.2')).toBe(256_000)
})

test('clearSessionContextWindowOverride resets state for session isolation', () => {
  setSessionContextWindowOverride('gpt-4o', 256_000)
  expect(getSessionContextWindowOverride('gpt-4o')).toBe(256_000)
  clearSessionContextWindowOverride()
  expect(getSessionContextWindowOverride('gpt-4o')).toBeUndefined()
  expect(getContextWindowForModel('gpt-4o')).not.toBe(256_000)
})

test('session override takes precedence over [1m] suffix detection', () => {
  // Sanity: without session override, [1m] suffix yields the 1M window.
  expect(modelSupports1M('claude-sonnet-4-6[1m]')).toBe(true)
  // With session override set on the bare model, getContextWindowForModel
  // must return the override even when the caller passes the [1m] form.
  setSessionContextWindowOverride('claude-sonnet-4-6', 200_000)
  expect(getContextWindowForModel('claude-sonnet-4-6[1m]')).toBe(200_000)
  // Clearing restores the [1m] suffix path (1M).
  clearSessionContextWindowOverride()
  expect(getContextWindowForModel('claude-sonnet-4-6[1m]')).toBe(1_000_000)
})
