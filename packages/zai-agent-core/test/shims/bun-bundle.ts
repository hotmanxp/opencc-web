// Node-side stub for `import { feature } from 'bun:bundle'` used by vendored
// OpenCC internals. Bun's `feature()` is a build-time tree-shake flag that
// returns true/false; in Node we just expose the value passed in so that the
// runtime can read whatever default OpenCC chose at sync time.
//
// We do NOT attempt to mimic Bun's exact API surface — only the minimal
// `feature(name)` and `feature(name, options)` signatures used by the vendored
// source files under src/opencc-internals/.
export interface FeatureOptions {
  defaultValue?: boolean
}

export function feature(name: string, options?: FeatureOptions): boolean {
  return options?.defaultValue ?? false
}

export default { feature }