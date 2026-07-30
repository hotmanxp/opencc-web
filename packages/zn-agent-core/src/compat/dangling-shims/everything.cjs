// CJS Proxy stub — provides DYNAMIC named exports for any property
// access. Node treats this as a CommonJS module; consumers can
// `import { anything } from './everything.cjs'` and get a callable
// no-op. ESM named imports resolve against the CJS module's
// `module.exports` proxy at load time.
//
// Used by the bun-protocol.mjs last-resort catch-all for any
// dist/opencc-src import that points to a non-existent file
// (stripped at vendoring). Without this, every missing transitive
// import requires a hand-added named export to opencc-stripped.ts
// (whack-a-mole). With this, ANY name resolves.

const _callable = (..._args) => undefined

module.exports = new Proxy(function () {}, {
  get(_target, prop) {
    if (prop === Symbol.toPrimitive || prop === Symbol.iterator) return undefined
    if (prop === 'default') return _callable
    if (prop === '__esModule') return true
    // Named import. Return a callable no-op.
    return _callable
  },
  has(_target, prop) {
    return true
  },
  ownKeys() {
    // No static keys — consumers must use `import * as` or named
    // imports, both of which go through the Proxy `get` trap.
    return []
  },
  getOwnPropertyDescriptor() {
    return {
      configurable: true,
      enumerable: true,
      writable: true,
      value: _callable,
    }
  },
})