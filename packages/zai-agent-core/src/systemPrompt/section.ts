/**
 * Memoized section registry for the system prompt.
 *
 * Mirrors opencc's `src/constants/systemPromptSections.ts` (the section
 * registry that backs `getSystemPrompt`'s dynamic half). Each section
 * is named and cached until `clearSystemPromptSections()` runs.
 *
 * The cache is intentionally module-scoped (not per-cwd): a section like
 * `env_info:${model}` is a function of model + runtime config, not cwd.
 * For cwd-scoped state (AGENTS.md / .claude/rules chain), the underlying
 * section's `compute` fn should consult `memoryLoader`'s per-cwd cache
 * instead of relying on this module's flat map.
 *
 * Two factories:
 *
 *   - `systemPromptSection(name, compute)`
 *       Cached. Compute once, reuse until cleared. Use for everything
 *       that doesn't change mid-conversation.
 *
 *   - `DANGEROUS_uncachedSystemPromptSection(name, compute, reason)`
 *       Recomputed every call. WILL break the prompt cache when the
 *       value changes. The `reason` argument is mandatory — it ends up
 *       in PR review when this section blows up Anthropic prompt-cache
 *       hit rate. Use only when the value is genuinely session-bound
 *       (e.g. MCP server instructions: clients connect/disconnect
 *       between turns).
 *
 * Cache invalidation: `clearSystemPromptSections()` resets every entry.
 * The runtime calls this on `/clear` and `/compact` (see
 * `compactService.ts`).
 */

type ComputeFn = () => string | null | Promise<string | null>

export type SystemPromptSection = {
  name: string
  compute: ComputeFn
  cacheBreak: boolean
}

export function systemPromptSection(
  name: string,
  compute: ComputeFn,
): SystemPromptSection {
  return { name, compute, cacheBreak: false }
}

export function DANGEROUS_uncachedSystemPromptSection(
  name: string,
  compute: ComputeFn,
  _reason: string,
): SystemPromptSection {
  return { name, compute, cacheBreak: true }
}

const cache = new Map<string, string | null>()

export async function resolveSystemPromptSections(
  sections: readonly SystemPromptSection[],
): Promise<(string | null)[]> {
  return Promise.all(
    sections.map(async s => {
      if (!s.cacheBreak && cache.has(s.name)) {
        return cache.get(s.name) ?? null
      }
      const value = await s.compute()
      if (!s.cacheBreak) cache.set(s.name, value)
      return value
    }),
  )
}

export function clearSystemPromptSections(): void {
  cache.clear()
}

/**
 * Test-only: peek at the current cache without forcing recompute.
 */
export function peekSystemPromptSectionCache(): ReadonlyMap<string, string | null> {
  return cache
}