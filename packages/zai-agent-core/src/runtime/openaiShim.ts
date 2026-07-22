/**
 * Public re-export of the OpenAI-compatible shim (cherry-picked from
 * OpenCC src/services/api/openaiShim/). Lets downstream consumers (zai's
 * modelCaller) instantiate the shim with a `providerOverride` and get a
 * duck-typed Anthropic SDK client back, without depending on the upstream
 * internal path.
 *
 * IMPORTANT: The shim's transitive runtime graph is incomplete in the
 * cherry-pick mirror (see packages/zai-agent-core/scripts/sync-from-opencc.ts
 * which hard-excludes `bootstrap/` and the wider `utils/` tree used by
 * `debug.ts`). Downstream consumers MUST use dynamic `import()` rather than
 * a static top-level import, so the chain only fires when an OpenAI
 * profile is actually requested. The Anthropic-only default path must
 * never evaluate this module.
 *
 * Why a re-export, not a wrapper: the shim's `createOpenAIShimClient`
 * already accepts `{ providerOverride?: { model, baseURL, apiKey } }` —
 * the exact shape zai needs. Adding a wrapper would just be ceremony.
 *
 * @see packages/zai-agent-core/src/opencc-internals/services/api/openaiShim/openaiClient.ts
 */
export { createOpenAIShimClient } from '../opencc-internals/services/api/openaiShim/openaiClient.js'
