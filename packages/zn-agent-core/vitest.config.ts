import { defineConfig } from 'vitest/config'

export default defineConfig({
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