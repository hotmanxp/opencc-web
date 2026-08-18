/**
 * Tests for generic per-model capability lookup.
 *
 * Sources (priority high → low):
 *   1. defineModel() registry — vendor model descriptors
 *   2. OPENAI_CONTEXT_WINDOWS / OPENAI_MAX_OUTPUT_TOKENS — legacy aliases
 *   3. COPILOT_MODELS — github-copilot route catalogue
 *
 * Each test pins a model that should hit a known source with known values,
 * so regressions in any single layer surface as a concrete value mismatch.
 */
// Test the compiled MAIN-ENTRY bundle (dist/opencc-core.mjs), exactly as
// zai consumes it — not the source. The source path
// `src/opencc-src/utils/model/genericModelCapabilities.ts` imports
// from `../../integrations/registry.js`, which under vitest's
// resolve.alias (see vitest.config.ts → RELATIVE_RE) routes to the
// stripped-dir stub `dangling-shims/opencc-stripped.ts` and breaks
// `getModel` / `getAllModels`. The bundle has the registry inlined,
// so it works under both vitest and the runtime. (dist 清理后不再保留
// standalone 的 genericModelCapabilities.js,统一走主入口。)
import { describe, expect, it } from 'vitest'
import { lookupGenericModelCapabilities } from '@zn-ai/zn-agent-core'

describe('lookupGenericModelCapabilities', () => {
  describe('defineModel() registry hits', () => {
    it('deepseek-v4-flash — exact descriptor match returns context + flags', () => {
      // integrations/models/deepseek.ts:41-57 — defineModel('deepseek-v4-flash')
      //   contextWindow: 1_048_576, maxOutputTokens: 65_536
      //   capabilities.supportsStreaming: true, supportsFunctionCalling: true,
      //                  supportsJsonMode: true, supportsVision: false
      const caps = lookupGenericModelCapabilities('deepseek-v4-flash')
      expect(caps).toBeDefined()
      expect(caps!.contextWindow).toBe(1_048_576)
      expect(caps!.supportsStreaming).toBe(true)
      expect(caps!.supportsFunctionCalling).toBe(true)
      expect(caps!.supportsJsonMode).toBe(true)
      expect(caps!.supportsVision).toBe(false)
    })

    it('deepseek-v4-pro — descriptor returns 1M context + reasoning flag', () => {
      // integrations/models/deepseek.ts:58-75 — defineModel('deepseek-v4-pro')
      //   capabilities.supportsReasoning: true
      const caps = lookupGenericModelCapabilities('deepseek-v4-pro')
      expect(caps).toBeDefined()
      expect(caps!.contextWindow).toBe(1_048_576)
      expect(caps!.supportsReasoning).toBe(true)
    })

    it('case-insensitive descriptor lookup (lowercase id)', () => {
      // OPENAI_CONTEXT_WINDOWS lists both 'MiniMax-M3' and 'minimax-m3'
      // (lines 327-350); descriptor registry is case-sensitive but we
      // accept either to keep behavior symmetric.
      const caps = lookupGenericModelCapabilities('minimax-m3')
      // Not all defineModel entries are guaranteed to cover MiniMax-M3,
      // so we don't pin contextWindow. We only assert the function
      // returns SOMETHING (i.e. didn't crash on lowercase).
      expect(caps).toBeDefined()
    })
  })

  describe('OPENAI_CONTEXT_WINDOWS / OPENAI_MAX_OUTPUT_TOKENS fallback', () => {
    it('MiniMax-M3 — context comes from openai table (1_000_000)', () => {
      // openaiContextWindows.ts:350 — 'MiniMax-M3': 1_000_000
      const caps = lookupGenericModelCapabilities('MiniMax-M3')
      expect(caps).toBeDefined()
      expect(caps!.contextWindow).toBe(1_000_000)
      // maxOutputTokens also from openaiContextWindows.ts:535
      expect(caps!.maxOutputTokens).toBe(512_000)
    })

    it('gpt-4o-2024-11-20 — prefix match against gpt-4o (128k)', () => {
      // openaiContextWindows.ts:240 — 'gpt-4o': 128_000; prefix matching
      // via lookupByKey should resolve dated variants.
      const caps = lookupGenericModelCapabilities('gpt-4o-2024-11-20')
      expect(caps).toBeDefined()
      expect(caps!.contextWindow).toBe(128_000)
    })

    it('deepseek-v4-flash — descriptor maxOutputTokens (65_536) wins over openai table (262_144)', () => {
      // descriptor (integrations/models/deepseek.ts:55) declares 65_536.
      // openaiContextWindows.ts:505 lists 262_144 with a comment noting
      // "Flash is treated as the same family for local budgeting" — a
      // temporary placeholder until a dedicated public model card lands.
      // We treat defineModel as canonical and pin the descriptor value.
      const caps = lookupGenericModelCapabilities('deepseek-v4-flash')
      expect(caps).toBeDefined()
      expect(caps!.maxOutputTokens).toBe(65_536)
    })
  })

  describe('COPILOT_MODELS fallback', () => {
    it('claude-haiku-4.5 — copilot table maps attachment → supportsVision', () => {
      // copilotModels.ts:291-306 — COPILOT_MODELS['claude-haiku-4.5']:
      //   attachment: true, tool_call: true, reasoning: true
      //   limit.context: 144_000, limit.output: 32_768
      const caps = lookupGenericModelCapabilities('claude-haiku-4.5')
      expect(caps).toBeDefined()
      expect(caps!.contextWindow).toBe(144_000)
      expect(caps!.maxOutputTokens).toBe(32_768)
      expect(caps!.supportsVision).toBe(true)
      expect(caps!.supportsFunctionCalling).toBe(true)
      expect(caps!.supportsReasoning).toBe(true)
    })

    it('gpt-4o — copilot attachment flag wins supportsVision=true', () => {
      // copilotModels.ts:195-210 — COPILOT_MODELS['gpt-4o']:
      //   attachment: true (vision)
      const caps = lookupGenericModelCapabilities('gpt-4o')
      expect(caps).toBeDefined()
      expect(caps!.supportsVision).toBe(true)
    })
  })

  describe('unknown / malformed input', () => {
    it('returns undefined for totally unknown model', () => {
      // Not in any of the three sources — should return undefined
      // without throwing.
      const caps = lookupGenericModelCapabilities('totally-future-model-xyz')
      expect(caps).toBeUndefined()
    })

    it('returns undefined for empty string', () => {
      expect(lookupGenericModelCapabilities('')).toBeUndefined()
    })

    it('returns undefined for whitespace-only string', () => {
      expect(lookupGenericModelCapabilities('   ')).toBeUndefined()
    })

    it('returns undefined for undefined input', () => {
      expect(lookupGenericModelCapabilities(undefined)).toBeUndefined()
    })
  })
})
