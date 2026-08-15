/**
 * System default ProviderProfile catalog.
 *
 * Two Ping An gateways — these are the same gateways OpenCC's
 * src/integrations/models/{zhiniao,openplatform}.ts talk to, but the
 * data shape here is ProviderProfile (the zai/opencc provider
 * registry), not ModelDescriptor. Per-model contextWindow /
 * maxOutputTokens / capability flags are sourced from the OpenCC
 * descriptors and verified against
 * src/utils/model/openaiContextWindows.ts.
 *
 * Used by:
 *   - Config UI (ProviderForm "Add" modal presets) — packages/zai/src/web/src/pages/Config.tsx
 *   - First-run provisioning — if ~/.zai.json has no providerProfiles,
 *     zai can seed it from this catalog so the picker isn't empty.
 *
 * Edit this file to add/remove a system provider or refresh capability
 * data after a model catalog update. The OpenCC descriptor tables are
 * the source of truth for capability values; copy them here verbatim.
 */
import type { ProviderProfile, ModelCapabilities } from './types.js';

/** Common capability flags reused across many models. */
const allCaps = (overrides: Partial<ModelCapabilities> = {}): ModelCapabilities => ({
  supportsStreaming: true,
  supportsFunctionCalling: true,
  supportsJsonMode: true,
  supportsReasoning: true,
  ...overrides,
});

/** zhiniao-* capability map. Mirrors src/integrations/models/zhiniao.ts. */
const zhiniaoCaps: Record<string, ModelCapabilities> = {
  'zhiniao-MiniMax-M2.7-highspeed': allCaps({ contextWindow: 204_800, maxOutputTokens: 131_072, supportsVision: false }),
  'zhiniao-MiniMax-M2.7':           allCaps({ contextWindow: 1_000_000, maxOutputTokens: 512_000, supportsVision: true }),
  'zhiniao-qwen3.6-plus':           allCaps({ contextWindow: 1_000_000, maxOutputTokens: 65_536, supportsVision: true }),
  'zhiniao-glm-5.1':                allCaps({ contextWindow: 1_000_000, maxOutputTokens: 262_144, supportsVision: false }),
};

/** openplatform-* capability map. Mirrors src/integrations/models/openplatform.ts. */
const openplatformCaps: Record<string, ModelCapabilities> = {
  'MiniMax-M3':           allCaps({ contextWindow: 1_000_000, maxOutputTokens: 512_000, supportsVision: true }),
  'MiniMax-M2.7-highspeed': allCaps({ contextWindow: 204_800, maxOutputTokens: 131_072, supportsVision: false }),
  'qwen3.6-plus':         allCaps({ contextWindow: 1_000_000, maxOutputTokens: 65_536, supportsVision: true }),
  'qwen3.7-plus':         allCaps({ contextWindow: 1_000_000, maxOutputTokens: 65_536, supportsVision: true }),
  'qwen3.7-max':          allCaps({ contextWindow: 1_048_576, maxOutputTokens: 131_072, supportsVision: true }),
  'glm-5.1':              allCaps({ contextWindow: 202_745, maxOutputTokens: 65_536, supportsVision: false }),
  'glm-5.2':              allCaps({ contextWindow: 1_048_576, maxOutputTokens: 131_072, supportsVision: false }),
  'deepseek-v4-flash':    allCaps({ contextWindow: 1_048_576, maxOutputTokens: 262_144, supportsVision: false }),
  'deepseek-v4-pro':      allCaps({ contextWindow: 1_048_576, maxOutputTokens: 262_144, supportsVision: false }),
};

/**
 * The system default catalog — two Ping An gateways:
 *
 *   1. openplatform  — Anthropic protocol (Nova gateway).
 *      11 models including M3, Qwen 3.6/3.7, GLM 5/5.1/5.2, DeepSeek V4.
 *   2. zhiniao       — OpenAI-compatible protocol (Wizard AI gateway).
 *      4 models including M2.7, Qwen 3.6 Plus, GLM 5.1.
 *
 * `id` is a hard-coded stable slug (see plan §阶段 1) — sessions can
 * persist this id in transcript.meta.providerId to mean "this model
 * came from the built-in openplatform / zhiniao profile", and the
 * matcher will route back to the matching builtin even if the user
 * has not saved the profile into their providerProfiles yet.
 *
 * The `id` does NOT collide with user-created profiles (which use
 * the `provider_<timestamp>` scheme in ProviderForm.handleModalOk) —
 * both namespaces live in the same provider list but are
 * disambiguated by the slug prefix.
 */
export const BUILTIN_PROVIDERS: ProviderProfile[] = [
  {
    id: 'builtin-openplatform',
    name: 'Open Platform (Nova)',
    provider: 'anthropic',
    baseUrl: 'https://zn-nova.paic.com.cn/novai',
    model: Object.keys(openplatformCaps).join(','),
    capabilities: openplatformCaps,
  },
  {
    id: 'builtin-zhiniao',
    name: 'ZhiNiao (Wizard AI)',
    provider: 'openai',
    baseUrl: 'https://wizard-ai.paic.com.cn/code_pilot/api/v1',
    model: Object.keys(zhiniaoCaps).join(','),
    apiFormat: 'chat_completions',
    capabilities: zhiniaoCaps,
  },
];