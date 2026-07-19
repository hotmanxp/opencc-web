/**
 * Token budget section.
 *
 * Mirrors opencc's `systemPromptSection('token_budget', ...)` from
 * prompts.ts:561-565.
 *
 * Originally this was `DANGEROUS_uncached` (toggled on
 * `getCurrentTurnTokenBudget()`) which busted ~20K tokens per budget
 * flip. Opencc rewrote it as a cached no-op — see PR #21577. We
 * follow the same pattern: cached unconditionally, with phrasing
 * that makes it a no-op when no budget is active.
 *
 * Returning the section unconditionally costs us ~120 tokens of
 * context per turn; saving the section is not worth the cache bust.
 */

import { systemPromptSection } from '../section.js'

const TOKEN_BUDGET_SECTION = `When the user specifies a token target (e.g., "+500k", "spend 2M tokens", "use 1B tokens"), your output token count will be shown each turn. Keep working until you approach the target — plan your work to fill it productively. The target is a hard minimum, not a suggestion. If you stop early, the system will automatically continue you.`

export const getTokenBudgetSection = systemPromptSection(
  'token_budget',
  () => TOKEN_BUDGET_SECTION,
)