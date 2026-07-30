/**
 * Stub for `@orama/orama` + `@orama/plugin-data-persistence`.
 *
 * opencc vendor uses Orama for knowledge-graph storage
 * (src/opencc-src/utils/knowledgeGraph.ts). Vite's SSR dynamic-import
 * wrapper fails to unwrap the package's named exports
 * (`__vite_ssr_import_0__.createStore is not a function`) under
 * vite-node, even when we force the ESM entry. The vendor's
 * knowledge-graph use is offline analytics only — zai doesn't read
 * opencc's persisted knowledge graph state — so a no-op stub is
 * safe for the bridge path.
 *
 * If zai later needs real Orama search:
 *   1. Try `--experimental-loader` with a CJS-aware loader for Orama.
 *   2. Or migrate the bridge off `vite-node` (e.g. plain Node +
 *      `tsx --import` + the bun-protocol.mjs loader).
 *
 * Wired via vitest.config.ts + bun-protocol.mjs aliases.
 */

export function create(_schema: unknown): unknown {
  return {}
}

export function insert(_db: unknown, _doc: unknown): unknown {
  return {}
}

export function search(_db: unknown, _params: unknown): unknown {
  return { hits: [], count: 0 }
}

export function remove(_db: unknown, _id: string): unknown {
  return 0
}

export function getByID(_db: unknown, _id: string): unknown {
  return null
}

export function count(_db: unknown): number {
  return 0
}

export function update(_db: unknown, _token: unknown): unknown {
  return 0
}

export function save(_db: unknown): unknown {
  return ''
}

export function load(_db: unknown, _data: unknown): unknown {
  return {}
}

// Orama v3 also exports these (referenced internally)
export const createStore = create