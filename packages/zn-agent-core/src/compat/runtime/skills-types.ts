/**
 * Compat placeholder for `LoadedSkill`. The real type lands in
 * `compat/runtime/skills/types.ts` (Batch 3). Until then, this stub
 * keeps `compat/plugins/types.ts` compiling by giving the same name
 * a structural placeholder.
 *
 * @deprecated Use the real `LoadedSkill` once Batch 3 lands.
 */
export type LoadedSkill = Record<string, unknown>