/**
 * Minimal stub for `lru-cache` (opencc vendor uses it for FileStateCache).
 *
 * Vite's SSR-import of CJS deps via `await import()` returns a wrapped
 * namespace that doesn't unwrap named exports correctly
 * (`__vite_ssr_import_0__.LRUCache is not a constructor`). This stub
 * sidesteps that by aliasing `^lru-cache$` to a plain ESM shim that
 * exports a working `LRUCache` class.
 *
 * Behavior matches the small subset opencc uses: bounded LRU with
 * optional `max` (entry count) + `maxSize` (byte-size) + `sizeCalculation`
 * callback. Enough to keep query.ts alive; semantics are approximate —
 * zai has its own ReadFileState (compat/runtime/openccQueryBridge's
 * ToolUseContext exposes it), so this never matters in production.
 */

type Entry<V> = { value: V; size: number }
type Dispose<V> = (value: V, key: string) => void

export class LRUCache<K, V> {
  private max?: number
  private maxSize?: number
  private sizeCalculation?: (value: V, key: K) => number
  private dispose?: Dispose<V>
  private map = new Map<K, Entry<V>>()

  constructor(opts: {
    max?: number
    maxSize?: number
    sizeCalculation?: (value: V, key: K) => number
    dispose?: Dispose<V>
  } = {}) {
    this.max = opts.max
    this.maxSize = opts.maxSize
    this.sizeCalculation = opts.sizeCalculation
    this.dispose = opts.dispose
  }

  get(key: K): V | undefined {
    const entry = this.map.get(key)
    if (entry) {
      // refresh LRU order
      this.map.delete(key)
      this.map.set(key, entry)
    }
    return entry?.value
  }

  set(key: K, value: V): this {
    const size = this.sizeCalculation ? this.sizeCalculation(value, key) : 1
    if (this.map.has(key)) this.map.delete(key)
    this.map.set(key, { value, size })
    this.enforceMaxSize()
    return this
  }

  has(key: K): boolean {
    return this.map.has(key)
  }

  delete(key: K): boolean {
    const had = this.map.has(key)
    if (had) {
      const entry = this.map.get(key)
      this.map.delete(key)
      if (entry && this.dispose) this.dispose(entry.value, key as unknown as string)
    }
    return had
  }

  clear(): void {
    this.map.clear()
  }

  get size(): number {
    return this.map.size
  }

  *[Symbol.iterator](): IterableIterator<[K, V]> {
    for (const [k, e] of this.map) yield [k, e.value]
  }

  *entries(): IterableIterator<[K, V]> {
    for (const [k, e] of this.map) yield [k, e.value]
  }

  *keys(): IterableIterator<K> {
    for (const k of this.map.keys()) yield k
  }

  *values(): IterableIterator<V> {
    for (const e of this.map.values()) yield e.value
  }

  private enforceMaxSize(): void {
    if (this.max !== undefined && this.map.size > this.max) {
      // drop oldest
      const first = this.map.keys().next().value as K | undefined
      if (first !== undefined) this.delete(first)
    }
    // byte-size limit (approx: drop oldest until under maxSize)
    if (this.maxSize !== undefined) {
      let total = 0
      for (const e of this.map.values()) total += e.size
      while (total > this.maxSize && this.map.size > 0) {
        const first = this.map.keys().next().value as K | undefined
        if (first === undefined) break
        const entry = this.map.get(first)!
        total -= entry.size
        this.delete(first)
      }
    }
  }
}
