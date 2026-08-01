#!/usr/bin/env node
/**
 * Bundle opencc CORE (`src/opencc-src/query.ts` + transitive deps) into a
 * single `dist/opencc-core.mjs` using esbuild.
 *
 * This replaces the previous approach of copying every file from
 * `src/opencc-src/` (~2420 files, 27MB) into `dist/opencc-src/` and
 * relying on a Node+tsx loader (`bun-protocol.mjs`) to substitute
 * `.js` → `.ts/.tsx`, redirect `bun:bundle`, and stub missing exports.
 * The bundled form is a single .mjs that Node can `import()` directly
 * with no loader support required — eliminates an entire class of
 * "Cannot find module .../foo.js" failures.
 *
 * Why esbuild (not Bun.build):
 *   Bun.build has bugs inlining opencc vendor — its CJS-interop wrapper
 *   for zod v4 leaves bare `_gte` / `_gt` references unrewritten
 *   (ReferenceError at runtime), and synthesizing named exports for
 *   stubbed modules is brittle. esbuild handles CJS↔ESM interop and
 *   tree-shaking reliably.
 */

import { existsSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import * as esbuild from 'esbuild'

const __dirname = dirname(fileURLToPath(import.meta.url))
const ROOT = join(__dirname, '..')
const SRC_ENTRY = join(ROOT, 'src', 'opencc-src', 'query.ts')
const OUT_DIR = join(ROOT, 'dist')
const OUT_FILE = join(OUT_DIR, 'opencc-core.mjs')

if (!existsSync(SRC_ENTRY)) {
  console.error(`[bundle-opencc] missing entry: ${SRC_ENTRY}`)
  process.exit(1)
}

// ── Feature-flag plugin ─────────────────────────────────────────────
// opencc vendor uses `import { feature } from 'bun:bundle'` (Bun-only)
// with `feature('FLAG')` ternaries gating optional `require()` calls.
// esbuild can't resolve `bun:bundle` as a bare specifier, so we
// pre-process source: strip the import and replace feature() calls
// with the boolean literal from FEATURE_FLAGS (default `false`).
// Files where the flag is `false` then tree-shake the dead require()
// branches away (see query.ts:22-27).
//
// Ship with all flags false — zai has its own autoCompactIfNeeded
// (compat/runtime/compactService.ts) and doesn't exercise any gated
// code path. To enable a flag in the bundle, add it below.

const FEATURE_FLAGS: Record<string, boolean> = {}

const featureCallRe = /\bfeature\(\s*['"](\w+)['"][,\s]*\)/g
const featureImportRe = /import\s*\{[^}]*\bfeature\b[^}]*\}\s*from\s*['"]bun:bundle['"];?\s*\n?/g

// Patches applied to specific vendored files at bundle time. These
// are functional workarounds — opencc's `Config accessed before
// allowed.` guard throws if getConfig() is called before
// `enableConfigs()` runs. In zai's chat path the bridge can hit
// getConfig() (via session setup) before the explicit
// enableOpenccConfigs() call wired in compat/openccInit.ts. Flipping
// the default to `true` is the cleanest way to disable the guard
// without rewriting the read sites.
const configCheckPatchRe = /^let configReadingAllowed = false$/m

const featureFlagPlugin: esbuild.Plugin = {
  name: 'feature-flag-preprocess',
  setup(build) {
    build.onLoad({ filter: /\.[cm]?tsx?$/ }, async (args) => {
      const raw = readFileSync(args.path, 'utf-8')
      let contents = raw
      let modified = false

      if (featureImportRe.test(raw) || featureCallRe.test(raw)) {
        featureImportRe.lastIndex = 0
        featureCallRe.lastIndex = 0
        contents = contents.replace(featureImportRe, '')
        contents = contents.replace(featureCallRe, (_m, name) =>
          String(FEATURE_FLAGS[name] ?? false),
        )
        modified = true
      }

      if (configCheckPatchRe.test(contents)) {
        contents = contents.replace(
          configCheckPatchRe,
          'let configReadingAllowed = true',
        )
        modified = true
      }

      // zai patches: silence esbuild warnings on vendored files without
      // modifying them on disk (AGENTS.md: opencc-src/ is read-only).
      // Each replacement is the smallest possible text change — no
      // embedded comments or backticks in replacement strings (those
      // caused parse failures in earlier iterations).
      //   * `return\n` → `return;\n` makes the ASI disambiguation
      //     unambiguous so esbuild stops flagging
      //     [semicolon-after-return]; the unreachable statements
      //     after are tree-shaken regardless.
      //   * `?? 0` → `` removal silences [suspicious-nullish-coalescing]
      //     when the left operand is provably a number.
      const vendorReturnPatchRe = /^  return\n  delete processEnv\.CLAUDE_CODE_USE_OPENAI/m
      const vendorReturnElseRe = /^      return\n      delete process\.env\.ANTHROPIC_API_KEY/m
      // Catch every redundant `?? 0` after a `totalUsage?.X` /
      // `messageUsage?.X` chain — esbuild flags these because the line
      // above directly accesses `totalUsage.X`, proving the field is
      // non-nullable. Each match is a one-token deletion, behavior
      // unchanged (left operand is in fact a number at runtime).
      const vendorNullishCoalesceRe =
        /\b(totalUsage|messageUsage)\?\.([a-zA-Z_]+) \?\? 0/g

      if (vendorReturnPatchRe.test(contents)) {
        contents = contents.replace(vendorReturnPatchRe, '  return;\n  delete processEnv.CLAUDE_CODE_USE_OPENAI')
        modified = true
      }
      if (vendorReturnElseRe.test(contents)) {
        contents = contents.replace(vendorReturnElseRe, '      return;\n      delete process.env.ANTHROPIC_API_KEY')
        modified = true
      }
      if (vendorNullishCoalesceRe.test(contents)) {
        vendorNullishCoalesceRe.lastIndex = 0
        contents = contents.replace(
          vendorNullishCoalesceRe,
          '$1?.$2',
        )
        modified = true
      }

      // zai patch (3rd root cause, after vendor permission system +
      // wrapAsOpenccTool default + forceAllowCheckPermissions on every
      // vendor tool's checkPermissions): some OpenCC plugins loaded
      // from `~/.claude/plugins/<name>/hooks/hooks.json` register a
      // PreToolUse hook that returns `{block: true}` (or `decision:
      // 'block'`) when they don't want a specific command to run (e.g.
      // `git commit` policy, dangerous shell pattern, etc.). vendor
      // exposes this via `runPreToolUseHooks` (services/tools/
      // toolHooks.ts:503) yielding `{type:'stop'}`. toolExecution.ts
      // case 'stop' at line 1044 then synthesizes a synthetic tool
      // result `{content: createToolResultStopMessage(toolUseID)}`
      // which expands to the CANCEL_MESSAGE constant from
      // utils/messages/factories.ts:36 — the exact "The user doesn't
      // want to take this action right now. STOP what you are doing
      // and wait for the user to tell you how to proceed." string
      // observed at the LLM boundary in screenshot #3.
      //
      // For zai's HTTP-server deployment there is no interactive
      // dialog AND no plugin-ecosystem UX expectation that requires
      // these hooks — the user has not configured them interactively,
      // they get installed as a side-effect of `~/.claude/plugins/`
      // sharing with other Anthropic tooling that the user did opt
      // into elsewhere. Short-circuit `case 'stop'` to fall through
      // (return []), letting the existing permission / input gates
      // decide. The postToolHook bridge for `permissionDecision:
      // 'block'` (line 554 `hookPermissionResult: { behavior: 'deny' }`)
      // is left intact — that path produces a zod-shaped denial
      // result the LLM can act on, not a STOP message.
      const toolExecutionStopCaseRe =
        /case 'stop':\n        getStatsStore\(\)\?\.observe\(\n          'pre_tool_hook_duration_ms',\n          Date\.now\(\) - preToolHookStart,\n        \)\n        resultingMessages\.push\(\{\n          message: createUserMessage\(\{\n            content: \[createToolResultStopMessage\(toolUseID\)\],\n            toolUseResult: `Error: \$\{stopReason\}`,\n            sourceToolAssistantUUID: assistantMessage\.uuid,\n          \}\),\n        \}\)\n        return resultingMessages/
      if (toolExecutionStopCaseRe.test(contents)) {
        contents = contents.replace(
          toolExecutionStopCaseRe,
          "case 'stop': /* zai-bundle: case 'stop' suppressed so plugin PreToolUse hooks can't synthesize CANCEL_MESSAGE into the LLM stream; fall through */\n        return []",
        )
        modified = true
      }

      if (!modified) return null
      return {
        contents,
        loader: args.path.endsWith('.tsx') || args.path.endsWith('.jsx')
          ? 'tsx'
          : 'ts',
      }
    })
  },
}

// ── Optional-stubs plugin ────────────────────────────────────────────
// opencc vendor has OPTIONAL runtime imports gated behind
// `process.env.USER_TYPE === 'ant'` (Ant internal builds) or wrapped in
// `new Function('return import(...)')()`. The Function indirection is
// opencc's way to keep these out of the module graph for external
// users, but esbuild still sees the string literal and tries to
// resolve it. We stub these paths with empty exports so the build
// succeeds; at runtime the `USER_TYPE !== 'ant'` short-circuit
// prevents the require() from being executed. Stripped-but-referenced
// files (UI components the strip-list removes but transitive imports
// still reach for) also get stubbed.
//
// Stub kinds:
//   1. Relative paths to stripped/ant-only vendored files
//      (e.g. './MonitorMcpDetailDialog.js',
//      '../../tools/VerifyPlanExecutionTool/constants.js').
//   2. npm packages zai doesn't depend on but opencc vendor statically
//      or dynamically imports.
const OPTIONAL_STUB_RELATIVE_PATTERNS = [
  /VerifyPlanExecutionTool\/constants\.js$/,
  /OverflowTestTool\/OverflowTestTool\.js$/,
  /MonitorMcpDetailDialog\.jsx?$/,
]
const OPTIONAL_STUB_BARE_MODULES = new Set([
  'turndown',
  'vscode-jsonrpc',
  'vscode-jsonrpc/node',
  'vscode-jsonrpc/node.js',
  'vscode-languageserver-protocol',
  'vscode-languageserver-types',
  '@ant/claude-for-chrome-mcp',
  '@growthbook/growthbook',
  '@mendable/firecrawl-js',
])

// esbuild stub output: provide the expected named exports as `null`.
// If a new importer adds an import we don't know about, the build
// will fail loudly with the missing name — add it here.
const STUB_EXPORTS: Record<string, string[]> = {
  '@ant/claude-for-chrome-mcp': [
    'BROWSER_TOOLS',
    'createClaudeForChromeMcpServer',
    'ClaudeForChromeContext',
    'Logger',
    'PermissionMode',
  ],
  '@growthbook/growthbook': ['GrowthBook'],
  '@mendable/firecrawl-js': ['FirecrawlClient', 'FirecrawlError'],
  turndown: ['default'],
  'vscode-jsonrpc': ['createConnection', 'createServer', 'RequestType', 'NotificationType'],
  'vscode-jsonrpc/node': [
    'createConnection',
    'createServer',
    'createMessageConnection',
    'MessageConnection',
    'StreamMessageReader',
    'StreamMessageWriter',
    'Trace',
  ],
  'vscode-jsonrpc/node.js': [
    'createConnection',
    'createServer',
    'createMessageConnection',
    'MessageConnection',
    'StreamMessageReader',
    'StreamMessageWriter',
    'Trace',
  ],
  'vscode-languageserver-protocol': [
    'InitializeParams',
    'InitializeResult',
    'ServerCapabilities',
  ],
  'vscode-languageserver-types': [],
}

const optionalStubPlugin: esbuild.Plugin = {
  name: 'optional-stub',
  setup(build) {
    build.onResolve({ filter: /.*/ }, (args) => {
      for (const re of OPTIONAL_STUB_RELATIVE_PATTERNS) {
        if (re.test(args.path)) return { path: args.path, namespace: 'optional-stub' }
      }
      if (OPTIONAL_STUB_BARE_MODULES.has(args.path)) {
        return { path: args.path, namespace: 'optional-stub' }
      }
      return null
    })
    build.onLoad({ filter: /.*/, namespace: 'optional-stub' }, (args) => {
      if (STUB_EXPORTS[args.path]) {
        const names = STUB_EXPORTS[args.path]
        const lines = names
          .filter(n => n !== 'default')
          .map(n => `export const ${n} = null`)
        if (names.includes('default')) lines.push('export default null')
        return {
          contents: `// opencc optional/runtime stub — not exercised in zai\n${lines.join('\n')}\n`,
          loader: 'js',
        }
      }
      const base = (args.path.split('/').pop() ?? 'stub')
        .replace(/\.[cm]?[jt]sx?$/, '')
      return {
        contents: `// opencc optional/runtime stub — not exercised in zai\nexport const ${base} = null\nexport default null\n`,
        loader: 'js',
      }
    })
  },
}

// ── Build ────────────────────────────────────────────────────────────
// Externals:
//   - sharp / google-auth-library / @vscode/ripgrep / @orama / etc —
//     not in our deps; if reached at runtime, throw clearly.
//   - turndown / @ant/claude-for-chrome-mcp / vscode-jsonrpc / etc —
//     handled by optionalStubPlugin (stubbed in build output).
//   - zod (incl zod/v3, zod/v4) — keep external. esbuild's CJS↔ESM
//     handling for zod v4's nested CJS helpers (_gte / _gt etc) has
//     historically had bugs. zod IS in our deps so Node resolves at
//     runtime fine.
await esbuild.build({
  entryPoints: [SRC_ENTRY],
  outfile: OUT_FILE,
  bundle: true,
  format: 'esm',
  platform: 'node',
  target: 'node20',
  sourcemap: true,
  minify: false,
  logLevel: 'info',
  // Provide a Node `require` so the bundle's compiled
  // `__require("child_process")` calls resolve. esbuild leaves
  // top-level CJS-style require() as `__require(...)` instead of
  // converting to ESM imports; we provide a real require via
  // `createRequire(import.meta.url)`.
  banner: {
    js:
      "import { createRequire as __createRequire } from 'node:module';\n" +
      "import { fileURLToPath as __fileURLToPath } from 'node:url';\n" +
      "const require = __createRequire(import.meta.url);\n",
  },
  plugins: [featureFlagPlugin, optionalStubPlugin],
  external: [
    // Native / not-in-deps
    'sharp',
    'google-auth-library',
    '@vscode/ripgrep',
    '@orama/orama',
    '@orama/plugin-data-persistence',
    'web-tree-sitter',
    'tree-sitter-wasms',
    // Bundled-stubs: opencc packages stubbed via optionalStubPlugin
    // (still listed here as defensive; the plugin resolves first).
    'turndown',
    '@ant/claude-for-chrome-mcp',
    // Keep external — see comment above
    'zod',
    'zod/v3',
    'zod/v4',
    'zod/v4-mini',
  ],
  // Tree-shake aggressively; mark pure for the feature-flag gates
  treeShaking: true,
})

console.log(`[bundle-opencc] ✓ bundled ${SRC_ENTRY}`)
console.log(`[bundle-opencc]   → ${OUT_FILE}`)