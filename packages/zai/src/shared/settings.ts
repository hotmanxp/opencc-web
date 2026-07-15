/**
 * Per-model capability metadata — mirrors ModelCapabilities in
 * shared/types.ts but flattened onto the alias-table entry that the
 * picker UI consumes. Kept separate so ModelEntry stays self-contained
 * (settings.json consumers don't have to thread ProviderProfile).
 */
export interface ModelCapabilities {
  contextWindow?: number
  maxOutputTokens?: number
  supportsVision?: boolean
  supportsFunctionCalling?: boolean
  supportsReasoning?: boolean
  supportsJsonMode?: boolean
  supportsStreaming?: boolean
}

/**
 * Alias-table entry powering the model picker UI.
 *
 * - `alias`: short identifier shown in the UI ("M3", "haiku").
 * - `model`: full model ID sent to the upstream API ("MiniMax-M3",
 *   "MiniMax-M2.7-highspeed"). This is the value stored in
 *   transcript.meta.model after a picker selection.
 * - `label` / `description`: optional UI presentation fields.
 * - `capabilities`: optional per-model capabilities (context window,
 *   vision, tool calling, …). Populated when the entry is sourced
 *   from a ProviderProfile that ships a `capabilities` map; otherwise
 *   undefined and the UI hides capability badges.
 */
export interface ModelEntry {
  alias: string
  model: string
  label?: string
  description?: string
  /** Upstream OpenAI-compatible base URL; falls back to OpenAI default when omitted. */
  baseUrl?: string
  capabilities?: ModelCapabilities
}

/** Shape of ~/.zai/settings.json. */
export interface ZaiSettings {
  env?: Record<string, string>
  /** Global default (resolution chain layer 4). */
  model?: string
  /** Alias table powering the picker UI. */
  models?: ModelEntry[]
}