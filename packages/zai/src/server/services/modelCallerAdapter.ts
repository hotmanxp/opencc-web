/**
 * Adapter that bridges zai's `createAnthropicModelCaller` (zai-ModelCaller
 * shape) to the vendor `queryModelWithStreaming` shape that the headless
 * `QueryEngine` consumes via `QueryDeps.callModel`.
 *
 * The two shapes differ only on the input side:
 *
 *   - vendor callModel: { messages, systemPrompt, thinkingConfig, tools,
 *     signal, options: { model, fastMode, ... } }
 *   - zai ModelCaller:  { model, systemPrompt, messages, tools, signal }
 *
 * The output stream is the same on both sides: vendor snake_case
 * `StreamEvent` (the SDK's `BetaRawMessageStreamEvent` union). zai's
 * `createAnthropicModelCaller` already yields events in that exact shape
 * (`yield event as unknown as StreamEvent`), so the adapter is a thin
 * pass-through on the output side.
 *
 * On the input side, we:
 *   1. Lift `req.options.model` (vendor Options shape) up to the zai
 *      `model` field. This is the model the user picked in the UI / model
 *      selector, NOT the global default — important because zai-server
 *      sessions can target different model profiles per request.
 *   2. Fall back to a configured `fallbackModel` when `options.model` is
 *      missing, so the modelCaller never receives an empty model string
 *      and short-circuits to vendor defaults.
 *   3. Pass `req.messages` / `req.systemPrompt` / `req.tools` / `req.signal`
 *      through unchanged. zai's modelCaller reads from
 *      `getCachedZaiSettingsSync().env` to apply model alias mapping
 *      (`haiku` / `sonnet` / `opus` → concrete ID) and per-model
 *      provider profile resolution, so we don't need to do that here.
 *
 * The `thinkingConfig` field is intentionally NOT forwarded to the zai
 * modelCaller — zai's `createAnthropicModelCaller` always enables
 * extended thinking with a 25%-of-max_tokens budget and a [1024, 8192]
 * clamp (see modelCaller.ts:393). Forwarding vendor's `thinkingConfig`
 * would have to plumb through a new knob on the ModelCaller contract
 * and update every modelCaller call site; the current 25% rule is
 * already what the rest of zai uses, so we accept the asymmetry.
 *
 * If the zai modelCaller contract grows a `thinkingConfig` field later
 * (likely), the adapter can be extended in one place.
 */
import type { ModelCaller } from '@zn-ai/zn-agent-core/runtime'

type VendorCallModelInput = {
  messages: Array<{ role: 'user' | 'assistant'; content: unknown }>
  systemPrompt: string | string[] | Array<{ type: string; [key: string]: unknown }>
  thinkingConfig: unknown
  tools: Array<{ name: string; description?: string; inputSchema?: unknown }>
  signal: AbortSignal
  options: { model?: string; [key: string]: unknown }
}

export interface WrapOptions {
  /**
   * Default model to use when `req.options.model` is missing or empty.
   * The previous zai synthetic runtime read this from
   * `process.env.ANTHROPIC_DEFAULT_SONNET_MODEL` /
   * `ANTHROPIC_SMALL_FAST_MODEL`; the same env vars are still honored
   * by `createAnthropicModelCaller` itself, so this fallback is only
   * a belt-and-suspenders default for tests / unit paths that bypass
   * env.
   */
  fallbackModel?: string
}

export function wrapZaiModelCallerAsCallModel(
  modelCaller: ModelCaller,
  options: WrapOptions = {},
): (req: VendorCallModelInput) => AsyncGenerator<unknown, void, unknown> {
  const fallbackModel =
    options.fallbackModel
    ?? process.env.ANTHROPIC_DEFAULT_SONNET_MODEL
    ?? process.env.ANTHROPIC_SMALL_FAST_MODEL
  return async function* (req: VendorCallModelInput) {
    const model = req.options?.model || fallbackModel || 'MiniMax-M3'
    // Vendor `Message` shape is { type, message: { role, content }, uuid,
    // timestamp, ... }, NOT the Anthropic `{ role, content }` shape. zai's
    // createAnthropicModelCaller does `messages.map((m) => ({ role: m.role,
    // content: m.content }))` which would yield `{ role: undefined, content:
    // undefined }` and Anthropic would 400 with "input json is empty"
    // (2013). Lift the inner `m.message.{role, content}` here so the zai
    // adapter downstream sees the right shape.
    //
    // Drop empty messages: a session can have a synthetic
    // placeholder entry with `{ type, message: { role: undefined,
    // content: undefined }, ... }` (e.g. a previous-turn assistant
    // stub that never received a body). Sending these to upstream
    // trips Anthropic's parser with the same "input json is empty"
    // 2013 — the empty `{ role: undefined, content: undefined }` is
    // indistinguishable from a literal empty body once serialized.
    // We filter at the adapter boundary so all callers benefit.
    const sdkMessages = req.messages
      .map((m: any) => ({
        role: m.message?.role ?? m.role,
        content: m.message?.content ?? m.content,
      }))
      .filter((m: any) => m.role && m.content !== undefined && m.content !== null && m.content !== '')
    yield* modelCaller({
      model: String(model),
      systemPrompt: req.systemPrompt as any,
      messages: sdkMessages as any,
      tools: req.tools as any,
      signal: req.signal,
    })
  }
}
