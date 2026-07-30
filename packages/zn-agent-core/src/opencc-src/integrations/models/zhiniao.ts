import { defineModel } from '../define.js'

// Wizard AI (Ping An Tech gateway) hosts every model under the `zhiniao-`
// prefix. Each model descriptor carries the full prefixed apiName in
// `defaultModel` so the gateway catalog can return it verbatim and the
// shim's `applyZhiniaoModelPrefix` (providerUtils.ts) short-circuits with
// a no-op. The contextWindow / maxOutputTokens values mirror the static
// table in src/utils/model/openaiContextWindows.ts (entries 297-307, 490-493).

const zhiniaoCapabilities = {
  supportsVision: true,
  supportsStreaming: true,
  supportsFunctionCalling: true,
  supportsJsonMode: true,
  supportsReasoning: true,
  supportsPreciseTokenCount: false,
}

const zhiniaoGlmCapabilities = {
  ...zhiniaoCapabilities,
  supportsVision: false,
}

export default [
  defineModel({
    id: 'zhiniao-minimax-m2.7-highspeed',
    label: 'MiniMax-M2.7 Highspeed (ZhiNiao)',
    brandId: 'zhiniao',
    vendorId: 'openai-compatible',
    classification: ['chat', 'reasoning', 'coding'],
    defaultModel: 'zhiniao-MiniMax-M2.7-highspeed',
    capabilities: zhiniaoCapabilities,
    contextWindow: 204_800,
    maxOutputTokens: 131_072,
  }),
  defineModel({
    id: 'zhiniao-minimax-m2.7',
    label: 'MiniMax-M3 (ZhiNiao)',
    brandId: 'zhiniao',
    vendorId: 'openai-compatible',
    classification: ['chat', 'reasoning', 'vision', 'coding'],
    defaultModel: 'zhiniao-MiniMax-M2.7',
    capabilities: zhiniaoCapabilities,
    contextWindow: 1_000_000,
    maxOutputTokens: 512_000,
  }),
  defineModel({
    id: 'zhiniao-qwen3.6-plus',
    label: 'Qwen 3.6 Plus (ZhiNiao)',
    brandId: 'zhiniao',
    vendorId: 'openai-compatible',
    classification: ['chat', 'reasoning', 'vision', 'coding'],
    defaultModel: 'zhiniao-qwen3.6-plus',
    capabilities: zhiniaoCapabilities,
    contextWindow: 1_000_000,
    maxOutputTokens: 65_536,
  }),
  defineModel({
    id: 'zhiniao-glm-5.1',
    label: 'GLM 5.1 (ZhiNiao)',
    brandId: 'zhiniao',
    vendorId: 'openai-compatible',
    classification: ['chat', 'reasoning', 'coding'],
    defaultModel: 'zhiniao-glm-5.1',
    capabilities: zhiniaoGlmCapabilities,
    contextWindow: 1_000_000,
    maxOutputTokens: 262_144,
  }),
]
