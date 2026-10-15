/**
 * How opencc's memory tiers map onto upstream's `InstructionFileKind`
 * vocabulary (docs/mods-upstream-contract.md §2).
 *
 * Upstream has five tiers — `managed`, `user`, `project`, `local`, `memory` —
 * and opencc shares the first four by name. It splits the fifth: `AutoMem` and
 * `TeamMem` are both memories, and BOTH report as `memory`.
 *
 * That collapse is deliberate. A hook filtering on `kind === 'memory'` is asking
 * "is this a memory file?", not "which store held it". Splitting them would hand
 * every such mod a filter that silently matches half of what it meant to — and a
 * filter that quietly misses is worse than one that errors, because the mod goes
 * on believing it saw everything.
 */

/** The tiers opencc and upstream share, matched case-insensitively. */
const SHARED_TIERS = new Set(['managed', 'user', 'project', 'local'])

export function resolveInstructionFileKind(type: string): string {
  const lower = type.toLowerCase()
  return SHARED_TIERS.has(lower) ? lower : 'memory'
}
