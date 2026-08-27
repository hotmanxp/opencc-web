import { defineModel } from '../define.js'

// All 13 model descriptors live under brandId 'openplatform'. The catalog
// on the zn-nova gateway references all 13. Each defaultModel is the bare
// apiName the 平安 Nova gateway expects (no zhiniao- prefix, unlike the
// wizard-ai gateway).
//
// Context/output values are sourced from src/utils/model/openaiContextWindows.ts
// (zhiniao-* entries for shared M2.7 / Qwen / GLM models; static table
// entries for qwen3.7-max / deepseek-v4-* / glm-5). MiniMax-M3 uses
// 1,000,000 / 512,000 per the minimax-m3 descriptor in models/minimax.ts.
const openplatformCapabilities = {
  supportsVision: true,
  supportsStreaming: true,
  supportsFunctionCalling: true,
  supportsJsonMode: true,
  supportsReasoning: true,
  supportsPreciseTokenCount: true,
}

const openplatformTextOnlyCapabilities = {
  ...openplatformCapabilities,
  supportsVision: false,
}

export default [
  defineModel({
    id: 'openplatform-minimax-m3',
    label: 'MiniMax M3 (Open Platform)',
    brandId: 'openplatform',
    vendorId: 'anthropic',
    classification: ['chat', 'reasoning', 'vision', 'coding'],
    defaultModel: 'MiniMax-M3',
    capabilities: openplatformCapabilities,
    contextWindow: 1_000_000,
    maxOutputTokens: 512_000,
  }),
  defineModel({
    id: 'openplatform-minimax-m2.7-highspeed',
    label: 'MiniMax M2.7 Highspeed (Open Platform)',
    brandId: 'openplatform',
    vendorId: 'anthropic',
    classification: ['chat', 'reasoning', 'coding'],
    defaultModel: 'MiniMax-M2.7-highspeed',
    capabilities: openplatformCapabilities,
    contextWindow: 204_800,
    maxOutputTokens: 131_072,
  }),
  defineModel({
    id: 'openplatform-minimax-m2.7',
    label: 'MiniMax M2.7 (Open Platform)',
    brandId: 'openplatform',
    vendorId: 'anthropic',
    classification: ['chat', 'reasoning', 'coding'],
    defaultModel: 'MiniMax-M2.7',
    capabilities: openplatformTextOnlyCapabilities,
    contextWindow: 204_800,
    maxOutputTokens: 131_072,
  }),
  defineModel({
    id: 'openplatform-qwen3.6-plus',
    label: 'Qwen 3.6 Plus (Open Platform)',
    brandId: 'openplatform',
    vendorId: 'anthropic',
    classification: ['chat', 'reasoning', 'vision', 'coding'],
    defaultModel: 'qwen3.6-plus',
    capabilities: openplatformCapabilities,
    contextWindow: 1_000_000,
    maxOutputTokens: 65_536,
  }),
  // Context/output values per user instruction — reuse qwen3.6-plus's
  // 1,000,000 / 65,536 (openaiContextWindows.ts has no qwen3.7-plus entry).
  defineModel({
    id: 'openplatform-qwen3.7-plus',
    label: 'Qwen 3.7 Plus (Open Platform)',
    brandId: 'openplatform',
    vendorId: 'anthropic',
    classification: ['chat', 'reasoning', 'vision', 'coding'],
    defaultModel: 'qwen3.7-plus',
    capabilities: openplatformCapabilities,
    contextWindow: 1_000_000,
    maxOutputTokens: 65_536,
  }),
  defineModel({
    id: 'openplatform-qwen3.7-max',
    label: 'Qwen 3.7 Max (Open Platform)',
    brandId: 'openplatform',
    vendorId: 'anthropic',
    classification: ['chat', 'reasoning', 'vision', 'coding'],
    defaultModel: 'qwen3.7-max',
    capabilities: openplatformCapabilities,
    contextWindow: 1_048_576,
    maxOutputTokens: 131_072,
  }),
  defineModel({
    id: 'openplatform-qwen3.8-flash',
    label: 'Qwen 3.8 Flash (Open Platform)',
    brandId: 'openplatform',
    vendorId: 'anthropic',
    classification: ['chat', 'reasoning', 'vision', 'coding'],
    defaultModel: 'qwen3.8-flash',
    capabilities: openplatformCapabilities,
    contextWindow: 1_000_000,
    maxOutputTokens: 131_072,
  }),
  defineModel({
    id: 'openplatform-glm-5.1',
    label: 'GLM 5.1 (Open Platform)',
    brandId: 'openplatform',
    vendorId: 'anthropic',
    classification: ['chat', 'reasoning', 'coding'],
    defaultModel: 'glm-5.1',
    capabilities: openplatformTextOnlyCapabilities,
    contextWindow: 202_745,
    maxOutputTokens: 65_536,
  }),
  defineModel({
    id: 'openplatform-glm-5',
    label: 'GLM 5 (Open Platform)',
    brandId: 'openplatform',
    vendorId: 'anthropic',
    classification: ['chat', 'reasoning', 'coding'],
    defaultModel: 'glm-5',
    capabilities: openplatformTextOnlyCapabilities,
    contextWindow: 202_745,
    maxOutputTokens: 65_536,
  }),
  defineModel({
    id: 'openplatform-glm-5.2',
    label: 'GLM 5.2 (Open Platform)',
    brandId: 'openplatform',
    vendorId: 'anthropic',
    classification: ['chat', 'reasoning', 'coding'],
    defaultModel: 'glm-5.2',
    capabilities: openplatformTextOnlyCapabilities,
    contextWindow: 1_048_576,
    maxOutputTokens: 131_072,
  }),
  defineModel({
    id: 'openplatform-deepseek-v4-flash',
    label: 'DeepSeek V4 Flash (Open Platform)',
    brandId: 'openplatform',
    vendorId: 'anthropic',
    classification: ['chat', 'reasoning', 'coding'],
    defaultModel: 'deepseek-v4-flash',
    capabilities: openplatformCapabilities,
    contextWindow: 1_048_576,
    maxOutputTokens: 262_144,
  }),
  defineModel({
    id: 'openplatform-deepseek-v4-pro',
    label: 'DeepSeek V4 Pro (Open Platform)',
    brandId: 'openplatform',
    vendorId: 'anthropic',
    classification: ['chat', 'reasoning', 'coding'],
    defaultModel: 'deepseek-v4-pro',
    capabilities: openplatformCapabilities,
    contextWindow: 1_048_576,
    maxOutputTokens: 262_144,
  }),
  defineModel({
    id: 'openplatform-deepseek-v4-pro-0813',
    label: 'DeepSeek V4 Pro 0813 (Open Platform)',
    brandId: 'openplatform',
    vendorId: 'anthropic',
    classification: ['chat', 'reasoning', 'coding'],
    defaultModel: 'deepseek-v4-pro-0813',
    capabilities: openplatformCapabilities,
    contextWindow: 1_000_000,
    maxOutputTokens: 384_000,
  }),
]
