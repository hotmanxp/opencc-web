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
      // opencc vendor build artifacts (.generated.js / events_mono).
      // These don't ship with the vendored source — opencc's internal
      // build pipeline produces them. We route them all to a single
      // hand-written stub. The leading `(?:\.\.\/)*` matches one or
      // more `../` segments so the alias catches relative imports
      // like `../integrations/generated/foo.generated.js` or
      // `../../types/generated/events_mono/.../auth.ts`.
      {
        find: /(?:\.\.\/)+integrations\/generated\/.*\.generated\.js$/,
        replacement: resolve(__dirname, 'src/compat/dangling-shims/opencc-generated.ts'),
      },
      {
        find: /(?:\.\.\/)+types\/generated\/.*\.ts$/,
        replacement: resolve(__dirname, 'src/compat/dangling-shims/opencc-generated.ts'),
      },
      // Small npm packages opencc vendor references but that aren't in
      // our `dependencies`. Add more as the bridge's vendored-reference
      // check surfaces them.
      {
        find: /^env-paths$/,
        replacement: resolve(__dirname, 'src/compat/dangling-shims/env-paths.ts'),
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