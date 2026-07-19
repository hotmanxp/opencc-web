/**
 * Branded type for system prompt arrays.
 *
 * Mirrors opencc's `src/utils/systemPromptType.ts`. Dependency-free so
 * it can be imported from anywhere without circular init issues.
 *
 * `SystemPrompt` is a `readonly string[]` with a phantom `__brand`
 * property. The brand prevents accidental mixing with raw `string[]`
 * in the assembly path (e.g. `asSystemPrompt([...])` is required at
 * boundaries; downstream code can rely on the brand for cache-key
 * computation in `services/api/claude.ts`-style splits).
 */
export type SystemPrompt = readonly string[] & {
  readonly __brand: 'SystemPrompt'
}

export function asSystemPrompt(value: readonly string[]): SystemPrompt {
  return value as SystemPrompt
}