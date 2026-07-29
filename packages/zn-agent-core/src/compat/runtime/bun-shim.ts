/**
 * Static stub for `bun:bundle` `feature()` flag.
 *
 * opencc uses `bun:bundle` (a Bun-only built-in module) to gate experimental
 * features. Since zai runs opencc under Node 22 + tsx, we intercept the
 * `bun:bundle` specifier at the Node loader level (see `bun-protocol.mjs`)
 * and redirect to this shim.
 *
 * Default: every flag is `false` unless explicitly listed in STATIC_FEATURES.
 * Override per flag via env: `ZAI_OPENCC_FEATURE_<FLAG>=1|0|true|false`.
 *
 * `require()` is unsupported — call sites must use static imports.
 */

type FeatureTree = Readonly<Record<string, boolean>>

const STATIC_FEATURES: FeatureTree = Object.freeze({
  REACTIVE_COMPACT: true,
  MULTI_TURN_CONTEXT: true,
  HISTORY_SNIP: true,
  FILE_PERSISTENCE: true,
  BASH_CLASSIFIER: true,
})

export function feature<T>(flag: string, defaultValue?: T): T | boolean {
  const envKey = `ZAI_OPENCC_FEATURE_${flag.replace(/[^A-Z0-9]/gi, '_')}`
  const envVal = process.env[envKey]
  if (envVal !== undefined) {
    if (envVal === '1' || envVal === 'true') return true
    if (envVal === '0' || envVal === 'false') return false
  }
  if (flag in STATIC_FEATURES) return STATIC_FEATURES[flag]
  return defaultValue ?? false
}

export function require(_id: string): never {
  throw new Error(
    `[zn-agent-core] bun:bundle stub: require() inside feature() gate is not supported. ` +
      `Refactor the caller to a static import or move the conditional to runtime.`,
  )
}
