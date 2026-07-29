import { defineConfig } from 'vitest/config'
import { resolve } from 'node:path'

const OPENCC_SRC_DIR = resolve(__dirname, 'src/opencc-src')

export default defineConfig({
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
      // opencc's vendored source uses project-relative `src/...` specifiers
      // (e.g. `from 'src/utils/abortReasons.js'`) which Node's ESM resolver
      // can't handle — non-relative specifiers are looked up in node_modules.
      // Strip the prefix and map to <OPENCC_SRC_DIR>/... (Vite's bundler
      // resolves `.js` → `.ts` automatically per moduleResolution:"bundler").
      // The `.mjs` and other-extension variants fall through to default
      // resolution below; we only own the `.js` and no-ext forms here.
      {
        find: /^src\/(.+)\.js$/,
        replacement: resolve(OPENCC_SRC_DIR, '$1.ts'),
      },
      {
        find: /^src\/(.+)$/,
        replacement: resolve(OPENCC_SRC_DIR, '$1'),
      },
    ],
  },
  test: {
    globals: true,
    environment: 'node',
    // Only run tests in packages/zn-agent-core/test/ (our smoke tests).
    // Exclude the vendored opencc-src/** — those are opencc's own tests
    // (vitest globals, bun:test imports, etc.) that fail under Node.
    include: ['test/**/*.test.ts', 'test/**/*.test.mjs'],
    setupFiles: ['./src/compat/runtime/bun-protocol.mjs'],
    exclude: ['**/node_modules/**', '**/dist/**', 'src/opencc-src/**'],
  },
})