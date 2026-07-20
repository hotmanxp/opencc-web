// @ts-nocheck
// External build: the internal model-capabilities fetch/cache path is disabled.
// Preserve a stable public surface so callers can continue to import it.
//
// For firstParty (anthropic) routing, getContextWindowForModel consults this
// table BEFORE falling through to MODEL_CONTEXT_WINDOW_DEFAULT (200k). Without
// these entries, models registered in src/utils/model/openaiContextWindows.ts
// (which is only consulted on the openai-compatible / anthropic-proxy / local
// / gemini-native paths via resolveModelRuntimeLimits) would report a
// misleading 200k context window under firstParty routing.
//
// Values mirror the contextWindow / maxOutputTokens columns of
// openaiContextWindows.ts so the two stay consistent. Update both when
// adding or revising a model.

export type ModelCapability = {
  id: string
  max_input_tokens?: number
  max_tokens?: number
}

const STATIC_MODEL_CAPABILITIES: Readonly<Record<string, ModelCapability>> = {
  'MiniMax-M3': {
    id: 'MiniMax-M3',
    max_input_tokens: 1_000_000, // openaiContextWindows.ts:350
    max_tokens: 512_000, // openaiContextWindows.ts:535
  },
  'glm-5.2': {
    id: 'glm-5.2',
    max_input_tokens: 1_048_576, // openaiContextWindows.ts:399
    max_tokens: 131_072, // openaiContextWindows.ts:613
  },
  'MiniMax-M2.7-highspeed': {
    id: 'MiniMax-M2.7-highspeed',
    max_input_tokens: 204_800, // openaiContextWindows.ts:328
    max_tokens: 131_072, // openaiContextWindows.ts:522
  },
}

export function getModelCapability(
  model: string,
): ModelCapability | undefined {
  return STATIC_MODEL_CAPABILITIES[model]
}

export async function refreshModelCapabilities(): Promise<void> {}
