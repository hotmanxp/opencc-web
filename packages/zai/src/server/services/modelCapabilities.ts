/**
 * Per-model max output tokens.
 *
 * Background — root cause of "Write 工具写入长内容被截断":
 *
 *   zai's `modelCaller.ts` previously hardcoded `max_tokens: 8192` for every
 *   model. MiniMax-M3 supports up to 512k output tokens, Claude Sonnet 4.5
 *   supports 64k. With 8k cap (and 4k reserved for thinking), the actual
 *   budget for `Write` tool `content` was <4k tokens. Any LLM attempting to
 *   write a moderately long file (a 200-line Python module, a long markdown
 *   doc) hits `stop_reason: 'max_tokens'` and the file is either written
 *   half-truncated (OpenAI path with naive `"}` repair) or rejected with
 *   `tool_use:invalid` (Anthropic path with `JSON.parse` fallback to `{}`).
 *
 *   OpenCC upstream uses `getMaxOutputTokensForModel(model)` (services/api/
 *   claude.ts:3596) which respects the per-model limit and a `CLAUDE_CODE_
 *   MAX_OUTPUT_TOKENS` env override. We port the same shape, scoped to zai.
 *
 * Lookup chain (highest priority first):
 *   1. ZAI_MAX_OUTPUT_TOKENS env var (unconditional user override)
 *   2. Per-model static table below
 *   3. DEFAULT_MAX_OUTPUT_TOKENS fallback (64k — covers unknown models)
 *
 * Only the MIN bound is applied to every lookup. There is NO upper cap —
 * MiniMax-M3 genuinely supports 512k output and we want to honour that
 * when the user explicitly selects it. Users can lower via the env var.
 */

/**
 * Sensible fallback when the model is unknown. 64k covers every
 * production model zai routes through as of 2026-07; raising to this
 * level means even unknown models get a budget generous enough for
 * moderately long Write tool calls without hitting max_tokens truncation.
 */
const DEFAULT_MAX_OUTPUT_TOKENS = 64_000

/**
 * Lower bound. Some cheap models cap at 4k or 8k. We never go below the
 * explicit model limit, but we also never go below 4k — otherwise Write
 * tool calls of even tiny scripts would truncate.
 */
const MIN_MAX_OUTPUT_TOKENS = 4_000

/**
 * Per-model max output tokens.
 *
 * Sources:
 * - MiniMax row sourced from zai-agent-core's openaiContextWindows.ts
 * - Anthropic row from the published Anthropic model cards
 *
 * Lookup is case-insensitive and tolerant of common variant suffixes:
 * "MiniMax-M3", "minimax-m3", "MiniMax-M3-2025-09-29" all match.
 */
const MODEL_MAX_OUTPUT_TOKENS: ReadonlyMap<string, number> = new Map([
  // MiniMax (default models in zai)
  ['MiniMax-M3', 512_000],
  ['MiniMax-M2.7', 131_072],
  ['MiniMax-M2.7-highspeed', 131_072],
  ['MiniMax-M2.5', 131_072],
  ['MiniMax-M2.5-highspeed', 131_072],
  ['MiniMax-M2.1', 131_072],
  ['MiniMax-M2.1-highspeed', 131_072],
  ['MiniMax-M2', 131_072],
  // zhiniao prefix (Wizard AI gateway)
  ['zhiniao-MiniMax-M2.7', 512_000],
  ['zhiniao-MiniMax-M2.7-highspeed', 131_072],
  ['zhiniao-qwen3.6-plus', 65_536],
  ['zhiniao-glm-5.1', 262_144],
  // Anthropic (first-party through Anthropic SDK)
  ['claude-opus-4-5', 64_000],
  ['claude-opus-4-1', 32_000],
  ['claude-opus-4-0', 32_000],
  ['claude-sonnet-4-5', 64_000],
  ['claude-sonnet-4-1', 32_000],
  ['claude-sonnet-4-0', 32_000],
  ['claude-3-7-sonnet-latest', 64_000],
  ['claude-3-5-sonnet-latest', 8_192],
  ['claude-3-5-haiku-latest', 8_192],
  ['claude-3-opus-latest', 4_096],
])

function lookupModelLimit(model: string): number | undefined {
  // Exact match first.
  const exact = MODEL_MAX_OUTPUT_TOKENS.get(model)
  if (exact !== undefined) return exact

  // Strip "-YYYY-MM-DD" date suffix or "-latest".
  const base = model.replace(/-20\d{2}-\d{2}-\d{2}$/, '').replace(/-latest$/, '')
  if (base !== model) {
    const stripped = MODEL_MAX_OUTPUT_TOKENS.get(base)
    if (stripped !== undefined) return stripped
  }

  // Case-insensitive fallback.
  const lower = model.toLowerCase()
  for (const [k, v] of MODEL_MAX_OUTPUT_TOKENS) {
    if (k.toLowerCase() === lower) return v
  }

  return undefined
}

export function getModelMaxOutputTokens(model: string | undefined): number {
  // 1. Env override — user knows their provider better than we do.
  const envOverride = process.env.ZAI_MAX_OUTPUT_TOKENS
  if (envOverride) {
    const parsed = Number.parseInt(envOverride, 10)
    if (Number.isFinite(parsed) && parsed > 0) {
      return Math.max(MIN_MAX_OUTPUT_TOKENS, parsed)
    }
  }

  // 2. Per-model lookup.
  if (model) {
    const fromTable = lookupModelLimit(model)
    if (typeof fromTable === 'number' && fromTable > 0) {
      return Math.max(MIN_MAX_OUTPUT_TOKENS, fromTable)
    }
  }

  // 3. Unknown model fallback.
  return DEFAULT_MAX_OUTPUT_TOKENS
}

/**
 * Resolve thinking budget as a fraction of max output tokens.
 *
 * Anthropic constraint: `budget_tokens < max_tokens` (must be at least 1
 * less). OpenCC upstream uses a hard 4096 budget for non-adaptive models.
 * We scale with max_tokens instead — 25% budget, clamped to [1024, 8192]:
 *
 *   max=4096  → budget=1024 (clamped from 1024)
 *   max=8192  → budget=2048
 *   max=32000 → budget=8000 (clamped from 8192)
 *   max=64000 → budget=8192
 *   max=512000→ budget=8192
 *
 * 8k budget covers Claude Sonnet 4.5's recommended thinking range while
 * never starving the visible output.
 */
export function getThinkingBudgetTokens(maxOutputTokens: number): number {
  const fraction = Math.floor(maxOutputTokens * 0.25)
  return Math.max(1024, Math.min(8192, fraction))
}