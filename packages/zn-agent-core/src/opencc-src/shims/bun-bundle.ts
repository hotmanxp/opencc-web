/**
 * Static stub for `bun:bundle` `feature()` flag. opencc uses bun-bundle
 * to gate experimental features; zai runs opencc under Node 22 + tsx (no Bun),
 * so the bun-bundle feature() returns `undefined` and every `if (feature('X'))`
 * branch crashes. This stub compiles a static tree at module load and returns
 * the configured value for each flag.
 *
 * Default: every flag is `false` unless explicitly listed below. The list is
 * curated per `docs/superpowers/plans/2026-07-28-zn-agent-core-rescue-opencc-runtime.md`
 * Phase 1 Step 2.
 *
 * If you need to flip a flag for debugging, override via env:
 *   ZAI_OPENCC_FEATURE_<FLAG>=1 → true, anything else → false
 * (uppercase flag name, replace non-alnum with _).
 */

type FeatureTree = Readonly<Record<string, boolean>>

const STATIC_FEATURES: FeatureTree = Object.freeze({
  // --- zai 核心依赖 (Phase 1: 默认开) ---
  REACTIVE_COMPACT: true,
  MULTI_TURN_CONTEXT: true,
  HISTORY_SNIP: true,
  FILE_PERSISTENCE: true,
  BASH_CLASSIFIER: true,
})

export function feature<T>(flag: string, defaultValue?: T): T | boolean {
  // Env override (e.g. ZAI_OPENCC_FEATURE_REACTIVE_COMPACT=1)
  const envKey = `ZAI_OPENCC_FEATURE_${flag.replace(/[^A-Z0-9]/gi, '_')}`
  const envVal = process.env[envKey]
  if (envVal !== undefined) {
    if (envVal === '1' || envVal === 'true') return true
    if (envVal === '0' || envVal === 'false') return false
  }
  if (flag in STATIC_FEATURES) return STATIC_FEATURES[flag]
  // Opencc calls `feature('FOO')` and reads it as truthy/falsy. Default to
  // the boolean false so gated branches are tree-shaken out at runtime
  // (no behavior change vs `bun:bundle`'s undefined-falsy default).
  return defaultValue ?? false
}

// Some opencc files do `const reactiveCompact = feature('X') ? require(...) : null`.
// The `require()` form is CJS; we have no CJS here. Stub it.
export function require(_id: string): never {
  throw new Error(
    `[zn-agent-core] bun:bundle stub: require() inside feature() gate is not supported. ` +
      `Refactor the caller to a static import or move the conditional to runtime.`,
  )
}