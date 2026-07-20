import { defineConfig } from 'vitest/config'
import { resolve } from 'node:path'

export default defineConfig({
  resolve: {
    alias: {
      // Node-side stub for OpenCC's `bun:bundle` feature-flag API used by the
      // vendored source under src/opencc-internals/. Lets vitest load those
      // files at all; the actual flag values still come from each call site
      // via options.defaultValue.
      'bun:bundle': resolve(__dirname, 'test/shims/bun-bundle.ts'),
    },
  },
  test: {
    globals: true,
    environment: 'node',
    include: ['test/**/*.test.ts', 'src/**/*.test.ts'],
    coverage: {
      provider: 'v8',
      include: ['src/**/*.ts'],
    },
  },
})