import { defineConfig } from 'vitest/config'
import { existsSync } from 'node:fs'
import { resolve } from 'node:path'
import { ABSOLUTE_RE, RELATIVE_RE } from './src/compat/runtime/stripped-dirs.mjs'
import type { Plugin } from 'vite'

const OPENCC_SRC_DIR = resolve(__dirname, 'src/opencc-src')

/**
 * opencc spells every project-relative import with a `.js` suffix
 * (`from 'src/tools/BashTool/BashTool.js'`) regardless of what is on disk.
 *
 * This used to be a plain alias to `<OPENCC_SRC_DIR>/<path>.ts` — `.ts` only.
 * That covers most of the tree, but a number of vendored modules are `.tsx`
 * (`tools/BashTool/BashTool.tsx` among them), and for those the alias resolved
 * to a path that does not exist, so the import was reported as a missing
 * *package*.
 *
 * It lives in a plugin rather than the alias table because Vite's built-in alias
 * plugin runs ahead of `enforce: 'pre'` user plugins and would win the match.
 * The stripped-directory entries stay in the alias table, which is what routes
 * `src/<stripped>/...` to its dangling shim.
 */
const OPENCC_SRC_RE = /^src\/(.+)$/

/**
 * Vite plugin that intercepts module resolution at the deepest level.
 * vite-node (vitest's runner) sometimes bypasses resolve.alias when
 * handling dynamic `await import(absolute_path)` calls — particularly
 * for `__vite_ssr_import_0__` wrapped imports. As a safety net we
 * force-redirect a few known-problematic packages here too.
 */
const forceResolvePlugin: Plugin = {
  name: 'zn-agent-core-force-resolve',
  enforce: 'pre',
  async resolveId(source: string) {
    // @orama/orama + plugin-data-persistence — CJS interop breaks
    // under vite-node. Redirect to no-op stubs that satisfy the
    // names opencc vendor imports.
    if (source === '@orama/orama' || source === '@orama/plugin-data-persistence') {
      return resolve(__dirname, 'src/compat/dangling-shims/orama.ts')
    }
    const match = OPENCC_SRC_RE.exec(source)
    if (match) {
      const base = match[1].endsWith('.js') ? match[1].slice(0, -3) : match[1]
      // A specifier that already carries a real extension is taken as-is first.
      for (const candidate of [
        resolve(OPENCC_SRC_DIR, match[1]),
        resolve(OPENCC_SRC_DIR, `${base}.ts`),
        resolve(OPENCC_SRC_DIR, `${base}.tsx`),
      ]) {
        if (existsSync(candidate)) return candidate
      }
    }
    return null
  },
}

export default defineConfig({
  plugins: [forceResolvePlugin],
  resolve: {
    alias: [
      {
        find: /^bun:bundle$/,
        replacement: resolve(__dirname, 'src/compat/runtime/bun-shim.ts'),
      },
      {
        find: /^bun:feature$/,
        replacement: resolve(__dirname, 'src/compat/runtime/bun-feature-shim.ts'),
      },
      // CRITICAL ORDER: stripped-dir `src/<stripped>/...` aliases MUST come
      // BEFORE the generic `src/...` catch-all below. Vite walks this
      // array in order and stops at the first regex match — without this
      // precedence, project-relative imports like `src/memdir/paths.js`
      // would route to `<OPENCC_SRC_DIR>/memdir/paths.ts` (doesn't exist;
      // stripped at vendoring) instead of the dangling-shim.
      {
        find: ABSOLUTE_RE,
        replacement: resolve(__dirname, 'src/compat/dangling-shims/opencc-stripped.ts'),
      },
      // opencc's vendored source uses project-relative `src/...` specifiers
      // (e.g. `from 'src/utils/abortReasons.js'`) which Node's ESM resolver
      // can't handle — non-relative specifiers are looked up in node_modules.
      //
      // These live in `forceResolvePlugin` rather than here: Vite's built-in
      // alias plugin runs ahead of `enforce: 'pre'` user plugins, so an alias
      // would win the match and could only ever map to `.ts` — while a fair
      // number of vendored modules are `.tsx`. The plugin tries `.ts` then
      // `.tsx`. (Stripped dirs are already handled by ABSOLUTE_RE above.)

      // Relative-path stripped dirs (`../../state/store.js` etc.).
      // Same routing — to dangling-shims/opencc-stripped.ts.
      {
        find: RELATIVE_RE,
        replacement: resolve(__dirname, 'src/compat/dangling-shims/opencc-stripped.ts'),
      },
      // opencc vendor build artifacts (.generated.js / events_mono).
      // These don't ship with the vendored source — opencc's internal
      // build pipeline produces them. We route them all to a single
      // hand-written stub.
      {
        find: /(?:\.\.\/)+integrations\/generated\/.*\.generated\.js$/,
        replacement: resolve(__dirname, 'src/compat/dangling-shims/opencc-generated.ts'),
      },
      {
        find: /(?:\.\.\/)+types\/generated\/.*\.ts$/,
        replacement: resolve(__dirname, 'src/compat/dangling-shims/opencc-generated.ts'),
      },
      // Small npm packages opencc vendor references but that aren't in
      // our `dependencies`.
      {
        find: /^env-paths$/,
        replacement: resolve(__dirname, 'src/compat/dangling-shims/env-paths.ts'),
      },
      // CJS dep with broken Vite SSR dynamic-import interop. Use a tiny
      // hand-rolled ESM stub (lru-cache.ts) so `import { LRUCache } from
      // 'lru-cache'` resolves to a working constructor.
      {
        find: /^lru-cache$/,
        replacement: resolve(__dirname, 'src/compat/dangling-shims/lru-cache.ts'),
      },
      // jsonc-parser — installed as a real dep (see package.json). No alias
      // needed; vite-node resolves it from node_modules normally.
      // modelCost.ts — opencc vendor has a circular import
      // (utils/model/model.ts ↔ utils/modelCost.ts) that throws
      // "undefined is not a function" under Node ESM because the
      // top-level MODEL_COSTS object uses `firstPartyNameToCanonical`
      // as computed property keys while model.ts is still evaluating.
      // The stub breaks the cycle by using hardcoded string keys.
      // See dangling-shims/modelCost-stub.ts for the trade-off.
      //
      // Vite's resolve.alias replaces ONLY the regex match (not the
      // whole specifier), so the regex must capture the full
      // specifier including any leading `../`. Anchored regex:
      {
        find: /^(?:\.\.\/)+modelCost\.ts$/,
        replacement: resolve(__dirname, 'src/compat/dangling-shims/modelCost-stub.ts'),
      },
      {
        find: /^(?:\.\.\/)+modelCost\.js$/,
        replacement: resolve(__dirname, 'src/compat/dangling-shims/modelCost-stub.ts'),
      },
      // Same as above but for single-`./` relative paths
      // (cost-tracker.ts:57 uses `./utils/modelCost.js`, not `../modelCost.js`).
      {
        find: /^(?:\.\/)+utils\/modelCost\.ts$/,
        replacement: resolve(__dirname, 'src/compat/dangling-shims/modelCost-stub.ts'),
      },
      {
        find: /^(?:\.\/)+utils\/modelCost\.js$/,
        replacement: resolve(__dirname, 'src/compat/dangling-shims/modelCost-stub.ts'),
      },
      // @orama/orama has dual ESM+CJS entries; Vite SSR-import picks
      // the CJS path which doesn't unwrap named exports correctly
      // (`__vite_ssr_import_0__.createStore is not a function`).
      // Including them in optimizeDeps.include above forces esbuild
      // pre-bundling to the ESM entry, fixing this. (Earlier alias to
      // a no-op stub also worked but pulled in ~30 lines of code we
      // don't need; optimizeDeps is cleaner.)
    ],
  },
  test: {
    globals: true,
    environment: 'node',
    // Only run tests in packages/zn-agent-core/test/ (our smoke tests).
    // Exclude the vendored opencc-src/** — those are opencc's own tests
    // (vitest globals, bun:test imports, etc.) that fail under Node.
    include: ['test/**/*.test.ts', 'test/**/*.test.mjs', 'src/compat/repl/__tests__/**/*.test.ts'],
    setupFiles: [
      // First: optional-feature gates must come from the test, not from the
      // developer's shell. See the file header for why an inherited gate makes
      // a whole test file fail to load.
      './src/compat/runtime/test-feature-gates.mjs',
      './src/compat/runtime/bun-protocol.mjs',
    ],
    exclude: ['**/node_modules/**', '**/dist/**', 'src/opencc-src/**'],
    // 默认 vitest 5s testTimeout 在 zn-agent-core 太紧:
    // 1) bundle self-check after build:core 要 import dist/opencc-core.mjs
    //    (un-stripped 全量 vendor,Node 冷启动慢,属预期)
    // 2) agentRegistry.load.test.ts 跑 mkdtemp + 扫描 + import .js 文件
    //    磁盘 I/O,macOS 首次 / docker mount / 慢盘场景下偶尔超过 5s
    // 全局提到 30s,留足余量,不影响确定性失败暴露。
    testTimeout: 30_000,
  },
  optimizeDeps: {
    // Pre-bundle CJS dependencies through esbuild so they're correctly
    // imported as ESM when the bridge does a dynamic `await import()`.
    // Without `include`, Vite SSR-imports them as-is and named imports
    // of constructor exports (e.g. `import { LRUCache } from 'lru-cache'`)
    // break with "X is not a constructor".
    //
    // @orama/orama + plugin-data-persistence — package.json has dual
    // ESM+CJS entries. Vite picks CJS by default, which vite-node can't
    // unwrap correctly. Including them here forces esbuild pre-bundling
    // to the ESM entry, fixing the `__vite_ssr_import_0__.createStore
    // is not a function` error.
    include: ['lru-cache', '@anthropic-ai/sdk', '@orama/orama', '@orama/plugin-data-persistence'],
  },
})