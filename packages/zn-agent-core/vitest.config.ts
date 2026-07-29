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
      // Catch-all for files opencc vendor references but were stripped
      // at vendoring time (see packages/zn-agent-core/scripts/strip-list.ts).
      // opencc's transitive imports still reach into these stripped dirs
      // ("zombie" imports) — this alias routes any such relative `.js`
      // import to a single hand-written stub that exports safe defaults
      // for every name we've seen the hot path actually read. See
      // opencc-stripped.ts for the export list and default values.
      //
      // Stripped dirs (from strip-list.ts): components, ink, screens,
      // buddy, assistant, vim, voice, cli, commands, state, migrations,
      // __tests__, test, ssh, grpc, proto, remote, upstreamproxy,
      // integrations, memdir, outputStyles, proactive, keybindings,
      // moreright, coordinator, native-ts, context, bridge, tasks
      // (LocalAgentTask / LocalShellTask / RemoteAgentTask /
      // InProcessTeammateTask), utils/{processUserInput, swarm,
      // computerUse, backgroundHousekeeping, installationInfo,
      // doctorDiagnostic, updateStrategy, autoUpgrade,
      // autoUpdaterRouting, handleAutoUpdate, cleanup},
      // services/{voice, PromptSuggestion, MagicDocs, wiki,
      // extractMemories, goal, autoDream, autoFix, SessionMemory,
      // teamMemorySync, AgentSummary, remoteManagedSettings,
      // settingsSync, github}.
      {
        find: /(?:\.\.\/)+(?:components|ink|screens|buddy|assistant|vim|voice|cli|commands|state|migrations|__tests__|test|ssh|grpc|proto|remote|upstreamproxy|integrations|memdir|outputStyles|proactive|keybindings|moreright|coordinator|native-ts|context|bridge|tasks\/(?:RemoteAgentTask|InProcessTeammateTask|LocalShellTask|LocalAgentTask)|utils\/(?:processUserInput|swarm|computerUse|backgroundHousekeeping|installationInfo|doctorDiagnostic|updateStrategy|autoUpgrade|autoUpdaterRouting|handleAutoUpdate|cleanup)|services\/(?:voice|PromptSuggestion|MagicDocs|wiki|extractMemories|goal|autoDream|autoFix|SessionMemory|teamMemorySync|AgentSummary|remoteManagedSettings|settingsSync|github))\/[^/]+\.js$/,
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
  optimizeDeps: {
    // Pre-bundle CJS dependencies through esbuild so they're correctly
    // imported as ESM when the bridge does a dynamic `await import()`.
    // Without `include`, Vite SSR-imports them as-is and named imports
    // of constructor exports (e.g. `import { LRUCache } from 'lru-cache'`)
    // break with "X is not a constructor".
    include: ['lru-cache', '@anthropic-ai/sdk'],
  },
})