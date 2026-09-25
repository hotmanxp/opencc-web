import { defineConfig } from 'tsdown'

// The Electron main process is a single ESM bundle. It imports only `electron`,
// Node builtins, and its own relative modules — the packaged zai runtime is
// spawned as a child process and never imported, so nothing else has to be
// resolved at runtime.
//
// `lib/main.js` is bundled from the `tsc` output in `lib/types/` rather than
// from `src/` so that the same compiler options (`tsconfig.json`) govern both
// the type check and the emitted JavaScript.
export default defineConfig({
  entry: { main: 'lib/types/main.js' },
  outDir: 'lib',
  format: ['esm'],
  platform: 'node',
  target: 'es2023',
  fixedExtension: false,
  dts: false,
  clean: false,
  deps: { neverBundle: ['electron'] },
})
