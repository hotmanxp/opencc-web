import {
  clearBetaHeaderLatches,
  clearSystemPromptSectionState,
  getSystemPromptSectionCache,
  setSystemPromptSectionCacheEntry,
} from '../bootstrap/state.js'
import {
  dispatchModEngine,
  hasModHandlersFor,
} from '../mods/dispatch.js'

type ComputeFn = () => string | null | Promise<string | null>

type SystemPromptSection = {
  name: string
  compute: ComputeFn
  cacheBreak: boolean
}

/**
 * Create a memoized system prompt section.
 * Computed once, cached until /clear or /compact.
 */
export function systemPromptSection(
  name: string,
  compute: ComputeFn,
): SystemPromptSection {
  return { name, compute, cacheBreak: false }
}

/**
 * Create a volatile system prompt section that recomputes every turn.
 * This WILL break the prompt cache when the value changes.
 * Requires a reason explaining why cache-breaking is necessary.
 */
export function DANGEROUS_uncachedSystemPromptSection(
  name: string,
  compute: ComputeFn,
  _reason: string,
): SystemPromptSection {
  return { name, compute, cacheBreak: true }
}

/**
 * Resolve all system prompt sections, returning each one's name and text.
 *
 * The name travels with the text because upstream `prompt.compose` identifies
 * a section BY its id (d.ts:6737) — a hook replaces, moves or drops by name.
 * Returning positional strings threw that away and would have left every
 * dynamic section addressable only by its index.
 */
export async function resolveSystemPromptSections(
  sections: SystemPromptSection[],
): Promise<Array<{ name: string; text: string }>> {
  const cache = getSystemPromptSectionCache()

  const resolved = await Promise.all(
    sections.map(async s => {
      if (!s.cacheBreak && cache.has(s.name)) {
        return { name: s.name, text: cache.get(s.name) ?? null }
      }
      const computed = await s.compute()
      // Upstream `prompt.section` — a mod rewrites what a named section says,
      // or drops it by answering null.
      //
      // Between `compute` and the cache write, not after: a section is
      // memoized by name, so a value stored before the hook ran would make
      // every later turn serve the hook's answer out of the cache and never
      // ask it again. The name itself is not dispatched as mutable — it is
      // the cache key, and upstream pins it for the same reason.
      const value = hasModHandlersFor('prompt.section')
        ? await dispatchModEngine<string | null>(
            'prompt.section',
            { name: s.name, text: computed },
            e => (typeof e.text === 'string' ? e.text : null),
          )
        : computed
      setSystemPromptSectionCacheEntry(s.name, value)
      return { name: s.name, text: value }
    }),
  )
  // A section a hook dropped is absent, not a hole — upstream's "a section left
  // out is not sent".
  return resolved.filter(
    (s): s is { name: string; text: string } => s.text !== null,
  )
}

/**
 * Clear all system prompt section state. Called on /clear and /compact.
 * Also resets beta header latches so a fresh conversation gets fresh
 * evaluation of AFK/fast-mode/cache-editing headers.
 */
export function clearSystemPromptSections(): void {
  clearSystemPromptSectionState()
  clearBetaHeaderLatches()
}
