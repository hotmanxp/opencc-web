/**
 * Boundary marker separating static (cacheable) content from dynamic content
 * in the system prompt array.
 *
 * In `buildSystemPrompt`, the array is laid out as
 *
 *   [staticIntro, BOUNDARY, ...dynamicSections]
 *
 * The boundary is a plain string with no semantic content; it never reaches
 * the model (downstream consumers in `modelCaller.ts` and Anthropic API
 * payload assembly must filter it out). It exists purely so the array shape
 * is unambiguous: anything before the boundary can use Anthropic's
 * `cache_control: { type: 'ephemeral' }` on the corresponding text block.
 *
 * zai-agent-core does not yet emit `cache_control` blocks — see
 * `modelCaller.ts:155` for the current filter behavior. The boundary
 * string is exported here so we can wire cache-control without having
 * to chase this constant through runtime/ and services/.
 *
 * WARNING: Do not change this value. Anthropic prompt-cache hashing
 * is sensitive to the byte-level contents of any cached prefix; if you
 * must rename it, also bump the cache-key namespace in the modelCaller.
 *
 * Mirrors opencc's `src/constants/prompts.ts:128-129`.
 */
export const SYSTEM_PROMPT_DYNAMIC_BOUNDARY = '__SYSTEM_PROMPT_DYNAMIC_BOUNDARY__'