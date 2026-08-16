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

import { createHash } from 'node:crypto'
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import * as esbuild from 'esbuild'
import ts from 'typescript'

const __dirname = dirname(fileURLToPath(import.meta.url))
const ROOT = join(__dirname, '..')
// zai patch (2026-08-09): 单一入口 —— 聚合 vendor(query) + server
// (createOpenccRuntime) + compat(index.ts) 到同一份 bundle,让 zai 运行时
// vendor/compat 只有一个 module 实例(STATE/commandQueue/bashTracker 共享,
// 消除跨 bundle/dist 状态隔离导致的请求风暴)。
const SRC_ENTRY = join(ROOT, 'src', 'bundle-entry.ts')
const SRC_ROOT = join(ROOT, 'src', 'opencc-src')
// react → preact/compat shim(bundle 内联 preact 而非 react,见 src/compat/preact-shim.ts)
const PREACT_SHIM = join(ROOT, 'src', 'compat', 'preact-shim.ts')
const OUT_DIR = join(ROOT, 'dist')
const OUT_FILE = join(OUT_DIR, 'opencc-core.mjs')
// Stamp file holding the input hash for the last successful bundle.
// When the input hash matches and OUT_FILE exists, skip the esbuild
// call entirely (saves ~11s on warm builds).
const STAMP_FILE = join(OUT_DIR, '.bundle-opencc.stamp')

if (!existsSync(SRC_ENTRY)) {
  console.error(`[bundle-opencc] missing entry: ${SRC_ENTRY}`)
  process.exit(1)
}

// ── Input fingerprint cache ──────────────────────────────────────
// esbuild bundles the transitive graph from `SRC_ENTRY`. We can't
// know the exact input set without running esbuild, so we use a
// conservative fingerprint over every .ts/.tsx under `src/opencc-src/`.
// Mtime+size is enough — file content changes show up as mtime or
// size deltas; mtime is preserved on `cp` (which is what `git
// checkout` ultimately does), and on most editors. The hash includes
// the relative path so a renamed file also invalidates the cache.
function walkTs(root: string): string[] {
  const out: string[] = []
  const stack = [root]
  while (stack.length) {
    const dir = stack.pop()!
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name)
      if (entry.isDirectory()) {
        if (entry.name === 'node_modules' || entry.name.startsWith('.')) continue
        stack.push(full)
      } else if (entry.isFile() && /\.[cm]?tsx?$/.test(entry.name)) {
        out.push(full)
      }
    }
  }
  out.sort()
  return out
}

function inputHash(): string {
  const h = createHash('sha1')
  // zai patch (2026-08-09): 扫描 src/ 全量(含聚合入口 bundle-entry.ts、
  // compat/、agents/),不限于 opencc-src —— 单一入口后这些文件的变化都
  // 会改变 bundle 内容,漏扫会导致 stamp 缓存命中旧产物。
  for (const file of walkTs(join(ROOT, 'src'))) {
    const rel = relative(ROOT, file).split(sep).join('/')
    const st = statSync(file)
    h.update(`${rel}\0${st.mtimeMs}\0${st.size}\n`)
  }
  // Also hash this build script itself so editing
  // `vendorPatchesPlugin` (e.g. adding/removing a patch regex) is
  // picked up as a recipe change. Without this the stamp cache would
  // stay valid and the new patch logic would silently never run — the
  // "I added a patch but the bundle didn't change" trap.
  const scriptRel = relative(ROOT, fileURLToPath(import.meta.url))
    .split(sep)
    .join('/')
  const scriptSt = statSync(fileURLToPath(import.meta.url))
  h.update(
    `${scriptRel}\0${scriptSt.mtimeMs}\0${scriptSt.size}\n`,
  )
  // Bump this string when the bundle recipe (configCheckPatchRe,
  // plugins, externals) changes so old stamps are treated as stale.
  h.update('recipe:v4\n')
  return h.digest('hex').slice(0, 16)
}

if (existsSync(STAMP_FILE) && existsSync(OUT_FILE)) {
  let cached = ''
  try {
    cached = readFileSync(STAMP_FILE, 'utf8').trim()
  } catch {
    cached = ''
  }
  if (cached === inputHash()) {
    console.log(`[bundle-opencc] cached (input hash ${cached}) — skipping esbuild`)
    // Skip directly to the end — the second esbuild call below is for
    // the single-file type/const subpath exports, but those read the
    // already-emitted bundle and don't depend on the bundle's content
    // shape, so a content-hash match is sufficient to skip both.
    process.exit(0)
  }
}

// ── Vendor-patches plugin ─────────────────────────────────────────────
// Apply targeted, file-specific patches to vendored opencc files.
// Each replacement is the smallest possible text change — no
// embedded comments or backticks in replacement strings (those
// caused parse failures in earlier iterations).
//
//   * Config guard: opencc's `Config accessed before allowed.`
//     guard throws if getConfig() is called before `enableConfigs()`
//     runs. In zai's chat path the bridge can hit getConfig() (via
//     session setup) before the explicit enableOpenccConfigs() call
//     wired in compat/openccInit.ts. Flipping the default to `true`
//     is the cleanest way to disable the guard without rewriting
//     the read sites.
//
//   * Vendor return/else patches: silence esbuild warnings on
//     vendored files without modifying them on disk (AGENTS.md:
//     opencc-src/ is read-only).
//     - `return\n` → `return;\n` makes ASI disambiguation unambiguous
//       so esbuild stops flagging [semicolon-after-return]; the
//       unreachable statements after are tree-shaken regardless.
//     - `?? 0` → `` removal silences [suspicious-nullish-coalescing]
//       when the left operand is provably a number.
//
//   * Sub-agent prompt injection: the entry module is
//     `src/opencc-src/query.ts` — esbuild's tree-shaker trims every
//     named export it can't see referenced by the entry. The vendor
//     agent list loader (`getAgentDefinitionsWithOverrides` /
//     `clearAgentDefinitionsCache` in `tools/AgentTool/loadAgentsDir.ts`)
//     is dead code from query.ts' perspective, so its export would
//     not survive bundling. compat's buildOpenccQueryParams needs to
//     read the live agent list at runtime so AgentTool.prompt can
//     render the sub-agent table into the system prompt (otherwise
//     the LLM has no idea which sub-agents exist). Append a
//     re-export pinned to the entry so esbuild keeps the symbols
//     reachable AND names them on the bundle's export block.
//
//   * Messages-normalize re-export: compat needs vendor's
//     `normalizeMessagesForAPI` + `normalizeAttachmentForAPI` from
//     `utils/messages.ts` to translate `attachment` SDK messages
//     (agent_listing_delta / plan_mode_reentry / relevant_memories /
//     etc.) into user `<system-reminder>` text messages. Without
//     this translation compat's filter has to drop those messages,
//     losing model-facing state (plan re-entry flags, memory
//     injections, hook outputs, etc.). Pin the symbols here so they
//     survive tree-shaking and become reachable from compat.
//
//   * PreToolUse 'stop' suppression: some OpenCC plugins loaded
//     from `~/.zai/plugins/<name>/hooks/hooks.json` register a
//     PreToolUse hook that returns `{block: true}` (or `decision:
//     'block'}`) when they don't want a specific command to run (e.g.
//     `git commit` policy, dangerous shell pattern, etc.). vendor
//     exposes this via `runPreToolUseHooks` (services/tools/
//     toolHooks.ts:503) yielding `{type:'stop'}`. toolExecution.ts
//     case 'stop' at line 1044 then synthesizes a synthetic tool
//     result `{content: createToolResultStopMessage(toolUseID)}`
//     which expands to the CANCEL_MESSAGE constant from
//     utils/messages/factories.ts:36 — the exact "The user doesn't
//     want to take this action right now. STOP what you are doing
//     and wait for the user to tell you how to proceed." string
//     observed at the LLM boundary in screenshot #3.
//
//     For zai's HTTP-server deployment there is no interactive
//     dialog AND no plugin-ecosystem UX expectation that requires
//     these hooks — the user has not configured them interactively,
//     they get installed as a side-effect of `~/.zai/plugins/`
//     sharing with other Anthropic tooling that the user did opt
//     into elsewhere. Short-circuit `case 'stop'` to fall through
//     (return []), letting the existing permission / input gates
//     decide. The postToolHook bridge for `permissionDecision:
//     'block'` (line 554 `hookPermissionResult: { behavior: 'deny' }`)
//     is left intact — that path produces a zod-shaped denial
//     result the LLM can act on, not a STOP message.

const configCheckPatchRe = /^let configReadingAllowed = false$/m
const vendorReturnPatchRe = /^  return\n  delete processEnv\.CLAUDE_CODE_USE_OPENAI/m
const vendorReturnElseRe = /^      return\n      delete process\.env\.ANTHROPIC_API_KEY/m
const vendorNullishCoalesceRe =
  /\b(totalUsage|messageUsage)\?\.([a-zA-Z_]+) \?\? 0/g

const toolExecutionStopCaseRe =
  /case 'stop':\n        getStatsStore\(\)\?\.observe\(\n          'pre_tool_hook_duration_ms',\n          Date\.now\(\) - preToolHookStart,\n        \)\n        resultingMessages\.push\(\{\n          message: createUserMessage\(\{\n            content: \[createToolResultStopMessage\(toolUseID\)\],\n            toolUseResult: `Error: \$\{stopReason\}`,\n            sourceToolAssistantUUID: assistantMessage\.uuid,\n          \}\),\n        \}\)\n        return resultingMessages/

// zai patch (QueryEngine hardcoded `isNonInteractiveSession: true`):
// vendor's QueryEngine (src/opencc-src/QueryEngine.ts:380 and :536) builds
// toolUseContext.options with `isNonInteractiveSession: true` hardcoded,
// regardless of `STATE.isInteractive`. That makes
// `getCLISyspromptPrefix({isNonInteractive: true})` always return
// `AGENT_SDK_PREFIX` ("built on the OpenCC Agent SDK") even when zai is
// running as an interactive OpenCC CLI — the prefix is decoupled from
// STATE. zai wants the interactive prefix to flow through when the Web
// UI is active, so both hardcoded `true`s are rerouted to read STATE via
// `getIsNonInteractiveSession()`. With this patch in place, `zai --sdk`
// (which sets `STATE.isInteractive = false` via `createHeadlessContext`)
// flips the prefix to SDK, and default `zai dev` (STATE.isInteractive =
// true) gives the interactive prefix. Scoped to QueryEngine.ts only —
// other vendor files with hardcoded `isNonInteractiveSession: true`
// (entrypoints/mcp.ts:160, utils/queryContext.ts:157,
// services/awaySummary.ts:65, etc.) are intentionally SDK by design.
const queryEngineImportPatchRe =
  /import \{\n  getSessionId,\n  isSessionPersistenceDisabled,\n\} from 'src\/bootstrap\/state\.js'/
const queryEngineNonInteractivePatchRe =
  /isNonInteractiveSession: true,/g

const vendorPatchesPlugin: esbuild.Plugin = {
  name: 'vendor-patches',
  setup(build) {
    build.onLoad({ filter: /\.[cm]?tsx?$/ }, async (args) => {
      const contents0 = readFileSync(args.path, 'utf-8')
      let contents = contents0
      let modified = false

      if (configCheckPatchRe.test(contents)) {
        contents = contents.replace(
          configCheckPatchRe,
          'let configReadingAllowed = true',
        )
        modified = true
      }

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

      // zai patch (sub-agent prompt injection): see vendor-patches header.
      const queryReExportSentinel = /\/\/ zai-bundle: agent-loader re-export\n$/
      if (
        args.path.endsWith('opencc-src/query.ts') &&
        !queryReExportSentinel.test(contents)
      ) {
        contents =
          contents +
          '\n// zai-bundle: agent-loader re-export\n' +
          'export { getAgentDefinitionsWithOverrides, clearAgentDefinitionsCache } from "./tools/AgentTool/loadAgentsDir.js"\n'
        modified = true
      }

      // zai patch (messages-normalize re-export): see vendor-patches header.
      const normalizeReExportSentinel =
        /\/\/ zai-bundle: messages-normalize re-export\n$/
      if (
        args.path.endsWith('opencc-src/query.ts') &&
        !normalizeReExportSentinel.test(contents)
      ) {
        contents =
          contents +
          '\n// zai-bundle: messages-normalize re-export\n' +
          'export { normalizeMessagesForAPI, normalizeAttachmentForAPI } from "./utils/messages.js"\n'
        modified = true
      }

      // zai patch (task-changed signal re-export): expose onTaskChanged so
      // the compat layer can subscribe to task mutations and bridge them to
      // stateChangeBus for SSE delivery to the web frontend. Also export
      // listTasks + getTaskListId for cold-start hydration fallback (sessionState
      // route reads vendor task storage when the compat TaskListStore is empty).
      const taskChangedReExportSentinel =
        /\/\/ zai-bundle: task-changed re-export\n$/
      if (
        args.path.endsWith('opencc-src/query.ts') &&
        !taskChangedReExportSentinel.test(contents)
      ) {
        contents =
          contents +
          '\n// zai-bundle: task-changed re-export\n' +
          'export { onTaskChanged, listTasks, getTaskListId } from "./utils/tasks.js"\n'
        modified = true
      }

      // zai patch (PreToolUse 'stop' suppression): see vendor-patches header.
      if (toolExecutionStopCaseRe.test(contents)) {
        contents = contents.replace(
          toolExecutionStopCaseRe,
          "case 'stop': /* zai-bundle: case 'stop' suppressed so plugin PreToolUse hooks can't synthesize CANCEL_MESSAGE into the LLM stream; fall through */\n        return []",
        )
        modified = true
      }

      // zai patch (QueryEngine hardcoded `isNonInteractiveSession: true`):
      // see regex header above. Scoped to QueryEngine.ts so other vendor
      // files' intentional SDK flags aren't touched. Match by basename
      // (not full path) because esbuild may pass absolute or relative
      // `args.path` depending on entry resolution.
      if (args.path.endsWith('/QueryEngine.ts') || args.path.endsWith('QueryEngine.ts')) {
        console.log('[zai-debug] QueryEngine.ts plugin hit, endsWith:', true)
        if (queryEngineImportPatchRe.test(contents)) {
          contents = contents.replace(
            queryEngineImportPatchRe,
            `import {\n  getIsNonInteractiveSession,\n  getSessionId,\n  isSessionPersistenceDisabled,\n} from 'src/bootstrap/state.js'`,
          )
          modified = true
        } else {
          console.log('[zai-debug] QueryEngine import regex DID NOT MATCH')
        }
        if (queryEngineNonInteractivePatchRe.test(contents)) {
          contents = contents.replace(
            queryEngineNonInteractivePatchRe,
            `isNonInteractiveSession: getIsNonInteractiveSession(),`,
          )
          modified = true
        } else {
          console.log('[zai-debug] QueryEngine noninteractive regex DID NOT MATCH')
        }
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
  // react-reconciler:ink 专用渲染引擎,preact 无等价,stub 掉(死代码)。
  // 加载时 ink/reconciler.ts 顶层调用 createReconciler(config) +
  // discreteUpdates.bind —— stub 提供最小可工作实现,渲染方法不被 zai 调用。
  'react-reconciler',
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
  'react-reconciler': ['default'],
}

// ── UI 组件 stub 清单(zai patch 2026-08-16)────────────────────────────
// opencc-src/components/ 下的 React UI 组件在 zai 运行路径上完全不会被
// 渲染(zai 是 Node HTTP server,无 DOM/TTY;preact-shim.ts:12 已确认)。
// 但 vendor 命令注册表(commands.ts)静态 import 命令模块,命令模块 import
// 组件 → esbuild 把整棵组件树打进 bundle(17MB 中 1.5MB 来自 components/)。
// 这里把"纯组件模块"列入 stub 清单,组件导出变成 `() => null`,依赖
// (preact/design-system/其他组件)随之被 tree-shake。
//
// 不动 ink/、screens/、state/、cli/、buddy/、assistant/、vim/、
// voice/ —— 那些混排运行逻辑/非组件导出,留给二期后续或不动。
// commands/<name>/<name>.tsx 是"组件 + call 回调/逻辑函数"混排,工作块 A
// 在 line ~723+ 用 file-local AST 替换(只 stub 大写命名 + 含 JSX 的
// 函数体),不走此清单。ink/ 在工作块 B 用 inkRenderStubPlugin 单独处理。
const UI_COMPONENT_STUB_DIRS = [
  'components/design-system',
  'components/agents',
  'components/CustomSelect',
  'components/FeedbackSurvey',
  'components/LogoV2',
  'components/mcp',
  'components/memory',
  'components/messages',
  'components/permissions',
  'components/PromptInput',
  'components/Spinner',
  'components/StructuredDiff',
  'components/tasks',
  'components/wizard',
  'components/ui',
  'components/hooks',
  'components/shell',
  'components/sandbox',
  'components/Settings',
  'components/teams',
  'components/diff',
  'components/HelpV2',
  'components/ClaudeCodeHint',
  'components/DesktopUpsell',
  'components/grove',
  'components/HighlightedCode',
  'components/LspRecommendation',
  'components/ManagedSettingsSecurityDialog',
  'components/Passes',
  'components/TrustDialog',
  'components/StartupHeader',
  'components/ExitDialog',
  'components/skills',
]

// 显式"不能 stub"的混排文件(被 .ts 文件 import 了非组件导出 —— 纯
// 函数/常量/hooks/类型)。explore 报告已系统排查 .ts 引用方。
//
// 设计原则:路径匹配以"完整路径"或"目录前缀"形式登记,plugin 在
// `endsWith(/${keep})` 命中时跳过 stub,走原始文件。re-export/类型导出
// 即使留存在 stub 模块里也不影响运行时(类型编译擦除、re-export 走
// 原文件保留),所以这里保守地"只排除确实有非组件导出被 .ts 用的"。
const UI_COMPONENT_KEEP_FILES = [
  // color.ts — color() 纯函数被 ink.ts, services/tips/tipRegistry.ts,
  //            utils/treeify.ts, utils/completionCache.ts, utils/markdown.ts 引用
  'components/design-system/color.ts',
  // ThemeProvider.tsx — useTheme/useThemeSetting/usePreviewTheme hooks
  //            被 hooks/useCopyOnSelect.ts 引用,组件 JSX 是死代码但 hooks 不能 stub
  'components/design-system/ThemeProvider.tsx',
  // PromptInput 纯函数工具 — 被 hooks/useHistorySearch.ts、
  //            hooks/useTextInput.ts、hooks/useCancelRequest.ts 引用
  'components/PromptInput/inputModes.ts',
  'components/PromptInput/utils.ts',
  'components/PromptInput/footerVisibility.ts',
  'components/PromptInput/goalFormat.ts',
  'components/PromptInput/inputPaste.ts',
  // Spinner 工具 — types.ts 的 SpinnerMode 类型被 .ts hooks/services
  //            引用(types 编译擦除,保留即可);utils.ts + index.ts 提供
  //            纯函数给组件本身用,组件被 stub 后这些 .ts 不再被
  //            import,可一起 stub 但保险起见保留
  'components/Spinner/types.ts',
  'components/Spinner/index.ts',
  'components/Spinner/utils.ts',
  // FeedbackSurvey 工具 — utils.ts 类型被 hooks/useSkillImprovementSurvey.ts 引用
  'components/FeedbackSurvey/utils.ts',
  // mcp/types.ts, mcp/index.ts — 类型/re-export 被 services/mcp/utils.ts 引用
  'components/mcp/types.ts',
  'components/mcp/index.ts',
  'components/mcp/utils',
  // CustomSelect 内部 hooks + 类型 re-export
  'components/CustomSelect/index.ts',
  'components/CustomSelect/option-map.ts',
  'components/CustomSelect/use-select-state.ts',
  'components/CustomSelect/use-select-input.ts',
  'components/CustomSelect/use-select-navigation.ts',
  'components/CustomSelect/use-multi-select-state.ts',
  // agents 内部纯函数工具
  'components/agents/agentFileUtils.ts',
  'components/agents/generateAgent.ts',
  'components/agents/types.ts',
  'components/agents/utils.ts',
  'components/agents/validateAgent.ts',
  // StartupHeader 工具
  'components/StartupHeader/StartupHeader.pure.ts',
]

// ── 文件内 AST 替换(工作块 A:commands/ 实现层)──────────────────────
// 一期 uiComponentStubPlugin 整文件 stub(所有 export 替换为 () => null),
// 但 commands/<name>/<name>.tsx 是 "组件 + call 回调/逻辑函数" 混排 —— `call`
// 是 LocalJSXCommandCall 运行时回调被 vendor 命令表调用(`/help` 等场景),
// 必须保留;若整文件 stub,call 变 `() => null`,vendor 走 call 时抛错。
//
// 此 plugin 走精细化 "文件内 AST 替换":对 FILE_LOCAL_STUB_PATHS 命中的文件,
// 只把 "名字首字母大写 + 函数体含 JSX/createElement 信号" 的顶层
// `function Xxx(...)` 函数体替换为 `return null`。其他 export(箭头
// `call`、小写纯函数、class、type、const)原样保留。
//
// 工作块 A:COMMAND_IMPL_STUB_PATHS = commands/ 下所有 .tsx 实现文件(86 个)。
// const Xxx = forwardRef(...) / const Xxx = (...) => JSX 暂时不替换 —— 命令
// `call` 多为 `export const call = async (...) => {...}`,const 形式误伤面积
// 太大,稳妥走 function 声明形式。
const COMMAND_IMPL_STUB_PATHS: ReadonlySet<string> = (() => {
  // 扫描 src/opencc-src/commands 下所有 .tsx 实现文件。注册层
  // commands/<name>/index.ts 不含 JSX,无需处理。
  const out: string[] = []
  const root = join(ROOT, 'src', 'opencc-src', 'commands')
  if (!existsSync(root)) return new Set()
  const stack = [root]
  while (stack.length) {
    const dir = stack.pop()!
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, e.name)
      if (e.isDirectory()) stack.push(full)
      else if (e.isFile() && e.name.endsWith('.tsx')) out.push(full)
    }
  }
  return new Set(out)
})()

const FILE_LOCAL_STUB_PATHS: Set<string> = new Set(COMMAND_IMPL_STUB_PATHS)

// 工作块 C 兜底 —— 当前为空;未来 ThemeProvider.tsx 等"组件+hooks 混排"文件
// 加入后,这里登记需要走 file-local 替换但当前不在 COMMAND_IMPL_STUB_PATHS
// 范围(commands/ 外)的文件。
const FILE_LOCAL_STUB_KEEP_FILES: string[] = []

// 工作块 C 注入入口:Map<绝对路径, Set<函数名>>。如果只有 Set 空集合或未命中,
// 走默认规则(大写命名 + JSX 信号);如果命中,只替换指定函数名(无视命名)。
const FILE_LOCAL_STUB_ONLY_NAMES: Map<string, ReadonlySet<string>> = new Map()

function isComponentFunction(
  node: ts.Node,
  onlyNames: ReadonlySet<string> | undefined,
): boolean {
  if (!ts.isFunctionDeclaration(node) || !node.name || !node.body) return false
  const name = node.name.text
  if (onlyNames) {
    if (!onlyNames.has(name)) return false
  } else {
    // 大写驼峰组件名约定(见 components/AGENTS.md "Named exports (not
    // default): `export function ComponentName`")。纯函数 buildXxx 即使
    // 大写开头,函数体不含 JSX 时也不被识别 → 安全。
    if (!/^[A-Z]/.test(name)) return false
  }
  // 强信号:函数体内任一处出现 JSX 节点或 createElement 调用 → 判定为组件
  let isComponent = false
  function walk(n: ts.Node) {
    if (isComponent) return
    if (
      ts.isJsxElement(n) ||
      ts.isJsxSelfClosingElement(n) ||
      ts.isJsxFragment(n)
    ) {
      isComponent = true
      return
    }
    if (
      ts.isCallExpression(n) &&
      ts.isIdentifier(n.expression) &&
      n.expression.text === 'createElement'
    ) {
      isComponent = true
      return
    }
    ts.forEachChild(n, walk)
  }
  walk(node.body)
  return isComponent
}

function runFileLocalTransform(
  contents: string,
  filePath: string,
): string | null {
  const onlyNames = FILE_LOCAL_STUB_ONLY_NAMES.get(filePath)
  const sf = ts.createSourceFile(filePath, contents, ts.ScriptTarget.Latest, true)
  const transformer: ts.TransformerFactory<ts.SourceFile> = (context) => (rootNode) => {
    function visitor(node: ts.Node): ts.Node {
      if (isComponentFunction(node, onlyNames)) {
        const fn = node as ts.FunctionDeclaration
        return ts.factory.updateFunctionDeclaration(
          fn,
          fn.modifiers,
          fn.asteriskToken,
          fn.name,
          fn.typeParameters,
          fn.parameters,
          fn.type,
          ts.factory.createBlock(
            [ts.factory.createReturnStatement(ts.factory.createNull())],
            true,
          ),
        )
      }
      return ts.visitEachChild(node, visitor, context)
    }
    return ts.visitNode(rootNode, visitor) as ts.SourceFile
  }
  const result = ts.transform(sf, [transformer])
  const printer = ts.createPrinter()
  const out = printer.printFile(result.transformed[0] as ts.SourceFile)
  result.dispose()
  return out
}

const commandImplStubPlugin: esbuild.Plugin = {
  name: 'command-impl-stub',
  setup(build) {
    // 关键发现:esbuild 处理 `commands/<name>/index.ts` 里
    // `load: () => import('./<name>.js')` 这条动态 import 字符串时,
    // 把目标模块 (<name>.tsx) 经内建 dynamic-import 流程直接交给 file
    // loader,**绕过我 plugin 的 onResolve filter**。onLoad 对任何进
    // 入 graph 的文件必经(无论 import 路径形态),更适合精确匹配本地
    // 路径清单做"文件内 AST 替换"。
    build.onLoad({ filter: /\.[cm]?tsx?$/ }, (args) => {
      if (!FILE_LOCAL_STUB_PATHS.has(args.path)) return null
      // 一期 UI_COMPONENT_KEEP_FILES 命中的仍走原文件,避免整文件 stub
      // 与文件内 AST stub 同时命中的混乱场景。
      for (const keep of UI_COMPONENT_KEEP_FILES) {
        if (
          args.path.endsWith(`/${keep}`) ||
          args.path.includes(`/${keep}/`)
        ) {
          return null
        }
      }
      for (const keep of FILE_LOCAL_STUB_KEEP_FILES) {
        if (args.path.endsWith(`/${keep}`)) return null
      }
      const contents = readFileSync(args.path, 'utf8')
      const out = runFileLocalTransform(contents, args.path)
      if (out === null) return null
      return {
        contents: out,
        loader: args.path.endsWith('.tsx') ? 'tsx' : 'ts',
      }
    })
  },
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
      if (args.path === 'react-reconciler') {
        // ink/reconciler.ts 顶层 createReconciler(config) 创建实例 +
        // dispatcher.discreteUpdates = reconciler.discreteUpdates.bind ——
        // 加载时必须可工作;渲染方法(render/createContainer)是 ink 专用
        // 死代码,zai 从不渲染,调用即抛错。
        return {
          contents: `// react-reconciler stub — ink 渲染引擎,zai 不渲染(dead code)
export default function createReconciler(config) { return {
  render: () => { throw new Error('[react-reconciler-stub] render called (zai does not render ink)') },
  unmount: () => {},
  discreteUpdates: (fn, ...args) => fn(...args),
  createContainer: () => ({ root: null, tag: 0 }),
  updateContainer: () => 0,
  updateContainerSync: () => 0,
  flushSyncWork: () => {},
  injectIntoDevTools: () => {},
  getPublicRootInstance: () => null,
  batchedUpdates: (fn) => fn(),
} }
export const createHostConfig = null
export const injectIntoDevTools = () => {}
export const reconciler = null
export const getPublicRootInstance = () => null
`,
          loader: 'js',
        }
      }
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

// ── UI 组件 stub 插件(zai patch 2026-08-16)─────────────────────────────
// 把 UI_COMPONENT_STUB_DIRS 下、被 import 的纯组件模块在构建时替换为
// "导出全部为 () => null"的 stub 模块。被 stub 的模块的依赖(preact
// 运行时、其他组件、design-system 原子)被 esbuild 视为无引用,自动
// tree-shake。预期:components/ 对 bundle 输出的字节贡献从 1.5MB 降到
// ~0.3-0.4MB(只剩 KEEP_FILES 中混排的纯函数/类型),整体 bundle
// 从 17MB → ~15.7MB。
//
// stub 内容生成:用 TypeScript 编译器 API 读原文件顶层 export 标识符。
// 兜底覆盖 function/const/var/class/default;类型/接口 export 编译时
// 擦除,不需要生成。re-export 在纯组件模块里罕见,如漏报
// "No matching export",定位后追加即可。
function extractExportedNames(contents: string, filePath: string): string[] {
  const sf = ts.createSourceFile(filePath, contents, ts.ScriptTarget.Latest, true)
  const names: string[] = []
  const EXPORT = ts.SyntaxKind.ExportKeyword
  const DEFAULT = ts.SyntaxKind.DefaultKeyword
  for (const stmt of sf.statements) {
    // export default X 是 ExportAssignment 节点,本身就是 export 形式,
    // 不需要 ExportKeyword modifier。优先识别避免漏 default export。
    if (ts.isExportAssignment(stmt)) {
      names.push('default')
      continue
    }
    // export { X, Y } from './foo.js'(re-export)和 export { X, Y }(本地 re-export)
    // 是 ExportDeclaration 节点,同样自带 export 语义。
    if (ts.isExportDeclaration(stmt)) {
      if (stmt.exportClause && ts.isNamedExports(stmt.exportClause)) {
        for (const el of stmt.exportClause.elements) {
          names.push(el.name.text)
        }
      }
      continue
    }
    const mods = stmt.modifiers
    if (!mods || !mods.some((m: { kind: number }) => m.kind === EXPORT)) continue
    // export default fn/const/class 同时含 ExportKeyword + DefaultKeyword;
    // export default X 单独 assignment 已被上面的 isExportAssignment 捕获。
    const isDefault = mods.some((m: { kind: number }) => m.kind === DEFAULT)
    if (ts.isFunctionDeclaration(stmt) && stmt.name) {
      if (isDefault) names.push('default')
      names.push(stmt.name.text)
    } else if (ts.isVariableStatement(stmt)) {
      if (isDefault) names.push('default')
      for (const decl of stmt.declarationList.declarations) {
        if (ts.isIdentifier(decl.name)) names.push(decl.name.text)
      }
    } else if (ts.isClassDeclaration(stmt) && stmt.name) {
      if (isDefault) names.push('default')
      names.push(stmt.name.text)
    }
    // type/interface/enum 编译擦除,跳过
  }
  return names
}

function buildUiStub(exportedNames: string[], isTsx: boolean): string {
  const seen = new Set<string>()
  const lines: string[] = []
  for (const name of exportedNames) {
    if (seen.has(name)) continue
    seen.add(name)
    if (name === 'default') {
      // 默认导出:组件 → () => null;常量/类 → null。stub 目录都是纯
      // 组件,但 .ts 也可能 default export 一个函数/常量 —— 统一
      // () => null 在 zai 渲染语境下安全(返回 null 由调用方处理)
      lines.push('export default () => null')
    } else if (isTsx) {
      lines.push(`export function ${name}() { return null }`)
    } else {
      lines.push(`export const ${name} = null`)
    }
  }
  if (lines.length === 0) lines.push('export default {}')
  return lines.join('\n') + '\n'
}

const uiComponentStubPlugin: esbuild.Plugin = {
  name: 'ui-component-stub',
  setup(build) {
    build.onResolve({ filter: /.*/ }, (args) => {
      // 只对文件路径解析,跳过 npm 包和已 namespace 化的路径
      if (args.namespace !== 'file' && args.namespace !== '') return null
      if (!args.path.startsWith('/') && !args.path.startsWith('.')) return null
      // esbuild 的 args.path 对相对 import 是 import 字符串(常以 .js
      // 后缀结尾,即使源是 .ts/.tsx),onLoad 里 readFileSync 需要磁盘上
      // 真实存在的文件路径,这里 resolve + 扩展名候选解析。
      const absolutePath = isAbsolute(args.path)
        ? args.path
        : resolve(args.resolveDir, args.path)
      // components/ 下都是 .ts/.tsx;尝试加/替扩展名直到 exists
      let resolvedPath = absolutePath
      if (!existsSync(resolvedPath)) {
        const stripped = resolvedPath.replace(/\.js$/, '')
        if (existsSync(stripped + '.tsx')) resolvedPath = stripped + '.tsx'
        else if (existsSync(stripped + '.ts')) resolvedPath = stripped + '.ts'
        else return null
      }
      for (const dir of UI_COMPONENT_STUB_DIRS) {
        // 匹配 `/${dir}/`(components/ 子目录)避免误伤 opencc-src 之外
        // 同名路径
        if (resolvedPath.includes(`/${dir}/`)) {
          // 保留清单命中 → 走原始文件
          for (const keep of UI_COMPONENT_KEEP_FILES) {
            if (
              resolvedPath.endsWith(`/${keep}`) ||
              resolvedPath.includes(`/${keep}/`)
            ) {
              return null
            }
          }
          return { path: resolvedPath, namespace: 'ui-component-stub' }
        }
      }
      return null
    })
    build.onLoad({ filter: /.*/, namespace: 'ui-component-stub' }, (args) => {
      const contents = readFileSync(args.path, 'utf8')
      const exportedNames = extractExportedNames(contents, args.path)
      const isTsx = args.path.endsWith('.tsx')
      return {
        contents: buildUiStub(exportedNames, isTsx),
        loader: 'js',
      }
    })
  },
}

// ── react → preact/compat alias 插件 ─────────────────────────────────
// opencc-src 的 'react' import 全部指向 preact-shim(见 src/compat/preact-shim.ts)。
// preact/compat 提供 react 兼容 API 且体积远小于 react;bundle 不再内联
// react core + development 双份源码。
const preactAliasPlugin: esbuild.Plugin = {
  name: 'preact-alias',
  setup(build) {
    build.onResolve({ filter: /^react$/ }, (args) => {
      return { path: PREACT_SHIM }
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
  plugins: [commandImplStubPlugin, vendorPatchesPlugin, optionalStubPlugin, uiComponentStubPlugin, preactAliasPlugin],
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
    // fflate: vendored via dynamic import in zip.ts / zipCache.ts.
    // Listed in deps (0.8.3) but esbuild can't statically resolve
    // `await import('fflate')` from outside its bundle graph when the
    // call site is reached; keep external so Node resolves at runtime.
    'fflate',
  ],
  // Tree-shake aggressively.
  treeShaking: true,
})

console.log(`[bundle-opencc] ✓ bundled ${SRC_ENTRY}`)
console.log(`[bundle-opencc]   → ${OUT_FILE}`)

// ── Single-file esbuild for opencc-src pure type/const files ──
// Some compat shims are verbatim ports of opencc-src modules
// (e.g. permissions.ts). Compile just the single file (no bundle,
// no transitive imports) so we don't drag React/JSX/opentelemetry/
// lodash-es from opencc's vendored tree.
const PERMISSIONS_ENTRY = join(ROOT, 'src', 'opencc-src', 'types', 'permissions.ts')
const PERMISSIONS_OUT = join(ROOT, 'dist', 'opencc-src', 'types', 'permissions.js')

await esbuild.build({
  entryPoints: [PERMISSIONS_ENTRY],
  bundle: false,
  format: 'esm',
  outfile: PERMISSIONS_OUT,
  platform: 'node',
  target: 'node22',
})

// Generate .d.ts for permissions by parsing the source const+type exports
// (esbuild doesn't emit .d.ts for bundle:false; tsc would need the full project
// graph — so we emit it manually here).
{
  const { readFileSync, writeFileSync } = await import('node:fs')
  const src = readFileSync(PERMISSIONS_ENTRY, 'utf8')
  const dts = [
    `export declare const EXTERNAL_PERMISSION_MODES: readonly ["acceptEdits", "bypassPermissions", "default", "dontAsk", "plan"];`,
    `export type ExternalPermissionMode = (typeof EXTERNAL_PERMISSION_MODES)[number];`,
    `export type InternalPermissionMode = ExternalPermissionMode | 'auto' | 'bubble';`,
    `export type PermissionMode = InternalPermissionMode;`,
    `export declare const INTERNAL_PERMISSION_MODES: readonly ["acceptEdits", "bypassPermissions", "default", "dontAsk", "plan", "auto", "bubble"];`,
    `export declare const PERMISSION_MODES: readonly ["acceptEdits", "bypassPermissions", "default", "dontAsk", "plan", "auto", "bubble"];`,
  ].join('\n')
  writeFileSync(PERMISSIONS_OUT.replace('.js', '.d.ts'), dts)
  console.log(`[bundle-opencc]   → ${PERMISSIONS_OUT.replace('.js', '.d.ts')}`)
}

console.log(`[bundle-opencc] permissions: ${PERMISSIONS_OUT}`)

// ── Session API counter (zai patch) ────────────────────────────────
// Per-session API request counter consumed by the zai conversation
// panel via `@zn-ai/zn-agent-core/opencc-src/services/api/sessionApiCounter`.
// The module is fully self-contained (no imports), so a single-file
// `bundle: false` esbuild emit is safe — it won't drag the vendored
// tree into the zai runtime the way a transitive import would. The
// hand-written d.ts mirrors the permissions pattern above (esbuild
// doesn't emit d.ts for `bundle: false`).
const API_COUNTER_ENTRY = join(ROOT, 'src', 'opencc-src', 'services', 'api', 'sessionApiCounter.ts')
const API_COUNTER_OUT = join(ROOT, 'dist', 'opencc-src', 'services', 'api', 'sessionApiCounter.js')

await esbuild.build({
  entryPoints: [API_COUNTER_ENTRY],
  bundle: false,
  format: 'esm',
  outfile: API_COUNTER_OUT,
  platform: 'node',
  target: 'node22',
})

{
  const dts = [
    `// Type declarations for the self-contained session API counter.`,
    `// Mirror the source signatures in src/opencc-src/services/api/sessionApiCounter.ts.`,
    `export declare function setLastContextUsage(usage: {`,
    `  input: number;`,
    `  cache_creation: number;`,
    `  cache_read: number;`,
    `  output: number;`,
    `}): void;`,
    `export declare function getLastContextTokens(): number | null;`,
    `export declare function setCurrentApiCountSession(sessionId: string | null | undefined): void;`,
    `export declare function recordApiCall(): void;`,
    `export declare function getApiCallCount(sessionId: string): number;`,
    `export declare function clearApiCallCount(sessionId: string): void;`,
    `export declare function __resetApiCallCountsForTests(): void;`,
  ].join('\n')
  writeFileSync(API_COUNTER_OUT.replace('.js', '.d.ts'), dts)
  console.log(`[bundle-opencc]   → ${API_COUNTER_OUT.replace('.js', '.d.ts')}`)
}

console.log(`[bundle-opencc] session-api-counter: ${API_COUNTER_OUT}`)

// ── OpenCC server runtime seam (Task 1) ────────────────────────────
//
// `src/opencc-src/server/index.ts` re-exports the public types +
// `createOpenccRuntime` factory. It's a thin module — no React, no
// JSX, no opencc vendor coupling — so it compiles cleanly with
// `bundle: false` (single-file esbuild) and lands at
// `dist/opencc-src/server/index.js`. The package's `./opencc-server`
// export subpath points at that file (see package.json).
//
// Declarations (`*.d.ts`) are mechanically emitted by `tsc -p
// tsconfig.server.json` below, NOT written by hand. Hand-written d.ts
// drifts from the source the moment someone extends
// `OpenccRuntimeOptions` or adds methods to `OpenccRuntime`. The
// dedicated tsconfig:
//   * includes only the server module + the (vendor-tree-excluded)
//     `compat/` types the module imports from;
//   * excludes the opencc vendor tree (`src/opencc-src/**` except
//     `server/`) so the emit doesn't drag React/JSX/opentelemetry/
//     lodash-es into the dist;
//   * uses `emitDeclarationOnly: true` + a tmp outDir — we only
//     need the two `dist/opencc-src/server/*.d.ts` files, the rest
//     of the tmp output is discarded.
//
// Without a d.ts, downstream TypeScript consumers of
// `@zn-ai/zn-agent-core/opencc-server` fall back to `any` for every
// type — which defeats the seam's purpose (locking the contract so
// callers and implementations agree).
const SERVER_ENTRY = join(ROOT, 'src', 'opencc-src', 'server', 'index.ts')
const SERVER_OUT = join(ROOT, 'dist', 'opencc-src', 'server', 'index.js')
const SERVER_TSCONFIG = join(ROOT, 'tsconfig.server.json')
const SERVER_TYPES_TMP = join(ROOT, 'dist', '.server-types-tmp')
const SERVER_DIST_DIR = join(ROOT, 'dist', 'opencc-src', 'server')

// `createHeadlessContext.ts` is the public-surface re-export module
// (Task 2). The runtime body lives in `createHeadlessContext-impl.ts`
// (also emitted). `bundle: false` matches the index.ts path — single-
// file esbuild for each entry, no transitive bundling — so the d.ts
// emit (`tsc -p tsconfig.server.json`) and the JS emit stay in sync.
// `@ts-nocheck` on the impl file keeps tsc's transitive-vendor-error
// noise out of the build's exit code; runtime contract is locked by
// vitest (`test/unit/server/headless-context.test.ts`).
const HEADLESS_CONTEXT_ENTRY = join(ROOT, 'src', 'opencc-src', 'server', 'createHeadlessContext.ts')
const HEADLESS_CONTEXT_OUT = join(ROOT, 'dist', 'opencc-src', 'server', 'createHeadlessContext.js')
const HEADLESS_CONTEXT_IMPL_ENTRY = join(ROOT, 'src', 'opencc-src', 'server', 'createHeadlessContext-impl.ts')
const HEADLESS_CONTEXT_IMPL_OUT = join(ROOT, 'dist', 'opencc-src', 'server', 'createHeadlessContext-impl.js')

// `sessionFacade.ts` is the public-surface re-export module for
// Task 3 (server session/transcript lifecycle). Same thin/impl split
// as `createHeadlessContext`. The impl file (`sessionFacade-impl.ts`)
// is bundled separately because it pulls in vendored
// `sessionStoragePortable.ts` whose compiled .js doesn't ship as a
// separate file in dist/ (same situation as createHeadlessContext-impl).
const SESSION_FACADE_ENTRY = join(ROOT, 'src', 'opencc-src', 'server', 'sessionFacade.ts')
const SESSION_FACADE_IMPL_ENTRY = join(ROOT, 'src', 'opencc-src', 'server', 'sessionFacade-impl.ts')
const SESSION_FACADE_IMPL_OUT = join(ROOT, 'dist', 'opencc-src', 'server', 'sessionFacade-impl.js')

await esbuild.build({
  entryPoints: [SERVER_ENTRY, HEADLESS_CONTEXT_ENTRY, SESSION_FACADE_ENTRY],
  bundle: false,
  format: 'esm',
  outdir: SERVER_DIST_DIR,
  platform: 'node',
  target: 'node22',
  // Per-entry outfile naming: esbuild's `outdir` mode derives the
  // output filename from each entry's basename. We want:
  //   src/opencc-src/server/index.ts                    → dist/opencc-src/server/index.js
  //   src/opencc-src/server/createHeadlessContext.ts    → dist/opencc-src/server/createHeadlessContext.js
  // `entryNames` defaults to `[dir]/[name]-[hash]`; we override to
  // `[name]` (no hash) so the d.ts copy logic below can match `.d.ts`
  // files to their `.js` siblings by basename.
  entryNames: '[name]',
})

// The impl file (`createHeadlessContext-impl.ts`) reaches into many
// vendored opencc-src modules whose compiled .js files are NOT in
// `dist/` (only `opencc-core.mjs` is bundled; the rest of the
// vendored tree is consumed in-process under vitest's alias map, not
// shipped as separate files). For the published `opencc-server`
// subpath to resolve its imports at runtime, the impl file must be
// a SINGLE-FILE bundle with all transitive deps inlined — same
// pattern as `opencc-core.mjs` for the runtime.
//
// `bundle: true` makes esbuild walk the import graph and inline.
// Plugins mirror the opencc-core bundle (`vendorPatchesPlugin` +
// `optionalStubPlugin`) so the same ant-only / stripped-dir fallbacks
// apply. Externals are kept narrow — only npm deps that are also in
// the published package's deps (so Node resolves at runtime).
await esbuild.build({
  entryPoints: [HEADLESS_CONTEXT_IMPL_ENTRY],
  bundle: true,
  format: 'esm',
  outfile: HEADLESS_CONTEXT_IMPL_OUT,
  platform: 'node',
  target: 'node22',
  sourcemap: true,
  minify: false,
  logLevel: 'warning',
  banner: {
    js:
      "import { createRequire as __createRequire } from 'node:module';\n" +
      "import { fileURLToPath as __fileURLToPath } from 'node:url';\n" +
      "const require = __createRequire(import.meta.url);\n",
  },
  plugins: [commandImplStubPlugin, vendorPatchesPlugin, optionalStubPlugin, uiComponentStubPlugin, preactAliasPlugin],
  // Keep external — Node resolves at runtime via package deps.
  external: [
    'sharp',
    'google-auth-library',
    '@vscode/ripgrep',
    '@orama/orama',
    '@orama/plugin-data-persistence',
    'web-tree-shaker',
    'tree-sitter-wasms',
    'turndown',
    '@ant/claude-for-chrome-mcp',
    'zod',
    'zod/v3',
    'zod/v4',
    'zod/v4-mini',
    'fflate',
  ],
  treeShaking: true,
})
console.log(`[bundle-opencc] headless-context impl: ${HEADLESS_CONTEXT_IMPL_OUT}`)

// `sessionFacade-impl.ts` reaches into vendored
// `sessionStoragePortable.ts` (sanitizePath + readTranscriptForLoad).
// Same situation as `createHeadlessContext-impl.ts` above — the
// vendored tree is consumed in-process under vitest's alias map, not
// shipped as separate files. The impl is bundled as a single file
// for the published `opencc-server` subpath to resolve at runtime.
await esbuild.build({
  entryPoints: [SESSION_FACADE_IMPL_ENTRY],
  bundle: true,
  format: 'esm',
  outfile: SESSION_FACADE_IMPL_OUT,
  platform: 'node',
  target: 'node22',
  sourcemap: true,
  minify: false,
  logLevel: 'warning',
  banner: {
    js:
      "import { createRequire as __createRequire } from 'node:module';\n" +
      "import { fileURLToPath as __fileURLToPath } from 'node:url';\n" +
      "const require = __createRequire(import.meta.url);\n",
  },
  plugins: [commandImplStubPlugin, vendorPatchesPlugin, optionalStubPlugin, uiComponentStubPlugin, preactAliasPlugin],
  external: [
    'sharp',
    'google-auth-library',
    '@vscode/ripgrep',
    '@orama/orama',
    '@orama/plugin-data-persistence',
    'web-tree-shaker',
    'tree-sitter-wasms',
    'turndown',
    '@ant/claude-for-chrome-mcp',
    'zod',
    'zod/v3',
    'zod/v4',
    'zod/v4-mini',
    'fflate',
  ],
  treeShaking: true,
})
console.log(`[bundle-opencc] session-facade impl: ${SESSION_FACADE_IMPL_OUT}`)

// `compat/transcript/persistence.ts` does a runtime
// `createRequire(import.meta.url)` to load
// `../../opencc-src/services/api/compressToolHistory.js` as a graceful
// fallback (the require is wrapped in try/catch so a missing file
// only logs a debug warning, never crashes boot). We ship the real
// vendored `compressToolHistory.ts` so the dynamic require resolves
// at runtime. Without this entry the zai-server boot path logs
//   `[transcript] compressToolHistory load failed error: Cannot find
//    module '../../opencc-src/services/api/compressToolHistory.js'`
// on every /api/agent/prompt call, polluting the request log with
// 1.8 KB of stack frames per request.
//
// `bundle: true` because compressToolHistory.ts transitively
// imports 4+ vendored helpers (autoCompact + microCompact +
// toolResultStorage + config) that aren't separately emitted to
// dist. The transitive import graph from these helpers reaches
// into the full opencc-src vendor tree (bootstrap/state,
// SessionMemory, forkedAgent, ...), and `bundle: false` would
// require emitting every transitively-reachable file (hundreds of
// files) before the require can resolve at runtime. The 18 MB
// single-file bundle is the cost of keeping the full real
// implementation. We accept the size in exchange for the dynamic
// require resolving at runtime.
const COMPRESS_TOOL_HISTORY_ENTRY = join(ROOT, 'src', 'opencc-src', 'services', 'api', 'compressToolHistory.ts')
const COMPRESS_TOOL_HISTORY_OUT = join(ROOT, 'dist', 'opencc-src', 'services', 'api', 'compressToolHistory.js')

await esbuild.build({
  entryPoints: [COMPRESS_TOOL_HISTORY_ENTRY],
  bundle: true,
  format: 'esm',
  outfile: COMPRESS_TOOL_HISTORY_OUT,
  platform: 'node',
  target: 'node22',
  sourcemap: true,
  minify: false,
  logLevel: 'warning',
  banner: {
    js:
      "import { createRequire as __createRequire } from 'node:module';\n" +
      "import { fileURLToPath as __fileURLToPath } from 'node:url';\n" +
      "const require = __createRequire(import.meta.url);\n",
  },
  plugins: [commandImplStubPlugin, vendorPatchesPlugin, optionalStubPlugin, uiComponentStubPlugin, preactAliasPlugin],
  external: [
    'sharp', 'google-auth-library', '@vscode/ripgrep',
    '@orama/orama', '@orama/plugin-data-persistence',
    'web-tree-shaker', 'tree-sitter-wasms',
    'turndown', '@ant/claude-for-chrome-mcp',
    'zod', 'zod/v3', 'zod/v4', 'zod/v4-mini', 'fflate',
  ],
  treeShaking: true,
})
console.log(`[bundle-opencc] compress-tool-history: ${COMPRESS_TOOL_HISTORY_OUT}`)

// ── Generic model capabilities (zai patch) ──────────────────────────
// Single-file `bundle: true` emit so zai-server can import
// `@zn-ai/zn-agent-core/opencc-src/utils/model/genericModelCapabilities`
// without pulling in the full opencc-core.mjs bundle at every consumer.
//
// The module aggregates per-model capability data from three already-built
// sources (defineModel registry, OPENAI_CONTEXT_WINDOWS /
// OPENAI_MAX_OUTPUT_TOKENS, COPILOT_MODELS) so a `bundle: true` emit
// inlines ~25 KB of static tables + lookup helpers. Acceptable trade-off:
// the only consumer is zai-server's profile → ModelEntry projection
// (agentSettings.ts:70), which runs once per request to /api/agent/settings.
// The alternative (re-exporting through `bundle-entry.ts` into
// opencc-core.mjs) bloats every consumer of the main bundle (CLI,
// server runtime, etc.) for a UI-only concern.
//
// `bundle: true` is necessary because the module imports
// `integrations/index.js` (which itself imports vendor descriptor
// files); emitting without bundling would leave those imports
// unresolvable at runtime since vendored opencc-src is not shipped as
// separate .js files in dist.
//
// State isolation note: the descriptor registry
// (`integrations/registry.ts → _models: Map`) is initialised at module
// load via `ensureIntegrationsLoaded()`. This single-file bundle has
// its own private registry instance, separate from the one in
// opencc-core.mjs. That's fine here — we only READ descriptors (immutable
// data), never mutate them. Lookup results are deterministic.
const GENERIC_MODEL_CAPABILITIES_ENTRY = join(ROOT, 'src', 'opencc-src', 'utils', 'model', 'genericModelCapabilities.ts')
const GENERIC_MODEL_CAPABILITIES_OUT = join(ROOT, 'dist', 'opencc-src', 'utils', 'model', 'genericModelCapabilities.js')

await esbuild.build({
  entryPoints: [GENERIC_MODEL_CAPABILITIES_ENTRY],
  outfile: GENERIC_MODEL_CAPABILITIES_OUT,
  bundle: true,
  format: 'esm',
  platform: 'node',
  target: 'node22',
  // `sourcemap: false` (not true): the build's final `find dist -name
  // '*.map' -delete` removes every .map, so a generated sourceMappingURL
  // comment would dangle — and because zai-server imports this file via
  // the `@zn-ai/zn-agent-core/opencc-src/utils/model/genericModelCapabilities`
  // subpath, vite/vitest transforms it and logs
  // `[vite] Failed to load source map ... ENOENT` on every load.
  sourcemap: false,
  minify: false,
  logLevel: 'warning',
  banner: {
    js:
      "import { createRequire as __createRequire } from 'node:module';\n" +
      "import { fileURLToPath as __fileURLToPath } from 'node:url';\n" +
      "const require = __createRequire(import.meta.url);\n",
  },
  plugins: [commandImplStubPlugin, vendorPatchesPlugin, optionalStubPlugin, uiComponentStubPlugin, preactAliasPlugin],
  external: [
    'sharp', 'google-auth-library', '@vscode/ripgrep',
    '@orama/orama', '@orama/plugin-data-persistence',
    'web-tree-shaker', 'tree-sitter-wasms',
    'turndown', '@ant/claude-for-chrome-mcp',
    'zod', 'zod/v3', 'zod/v4', 'zod/v4-mini', 'fflate',
  ],
  treeShaking: true,
})
console.log(`[bundle-opencc] generic-model-capabilities: ${GENERIC_MODEL_CAPABILITIES_OUT}`)

// Hand-written .d.ts for the genericModelCapabilities subpath.
// esbuild doesn't emit d.ts for `bundle: true`. The public surface is
// narrow (one type alias + one function), so a hand-written d.ts stays
// in sync without much maintenance burden. Update this block if
// `GenericModelCapabilities` adds fields or `lookupGenericModelCapabilities`
// changes signature.
{
  const GENERIC_MODEL_CAPABILITIES_DTS = join(
    ROOT, 'dist', 'opencc-src', 'utils', 'model', 'genericModelCapabilities.d.ts',
  )
  const dts = [
    `// Type declarations for the generic model capability lookup.`,
    `// Mirror the source in src/opencc-src/utils/model/genericModelCapabilities.ts.`,
    `export interface GenericModelCapabilities {`,
    `  contextWindow?: number;`,
    `  maxOutputTokens?: number;`,
    `  supportsVision?: boolean;`,
    `  supportsFunctionCalling?: boolean;`,
    `  supportsReasoning?: boolean;`,
    `  supportsJsonMode?: boolean;`,
    `  supportsStreaming?: boolean;`,
    `}`,
    `export declare function lookupGenericModelCapabilities(model: string | undefined): GenericModelCapabilities | undefined;`,
    ``,
  ].join('\n')
  writeFileSync(GENERIC_MODEL_CAPABILITIES_DTS, dts)
  console.log(`[bundle-opencc]   → ${GENERIC_MODEL_CAPABILITIES_DTS}`)
}

// Mechanically emit declaration files for the server module via tsc.
// `noEmit` requires the tsc program to typecheck; we point outDir at
// a tmp dir, run the emit, then copy only the server d.ts files into
// the real dist/opencc-src/server/ location (the compat/ and other
// dependency d.ts the emit also produces are already produced by
// `tsc -b` in the main build, so we discard the duplicates).
{
  // Ensure a clean tmp dir.
  if (existsSync(SERVER_TYPES_TMP)) {
    const { rmSync } = await import('node:fs')
    rmSync(SERVER_TYPES_TMP, { recursive: true, force: true })
  }

  const { spawnSync } = await import('node:child_process')
  const tsBin = join(ROOT, 'node_modules', 'typescript', 'bin', 'tsc')
  const proc = spawnSync(process.execPath, [tsBin, '-p', SERVER_TSCONFIG], {
    cwd: ROOT,
    stdio: ['inherit', 'pipe', 'pipe'],
  })
  if (proc.status !== 0) {
    // tsc reports errors in vendored transitive files (the opencc-src
    // tree has known vendor-type drift — 89× TS2742 lodash portability
    // + other assorted strict-mode issues — that does not affect our
    // server public surface). The server emit contract is "the two
    // required d.ts files exist" — we sanity-check that below. tsc
    // emits declaration files for the include files regardless of
    // errors in transitive dependencies (default `noEmitOnError: false`),
    // so the d.ts we need are written before this branch fires.
    //
    // The runtime contract is enforced by vitest
    // (test/unit/server/headless-context.test.ts), NOT by `tsc -p
    // tsconfig.server.json`. Vendor files MAY be edited for type fixes
    // (see AGENTS.md — opencc-src is a zai patch surface, not a frozen
    // upstream copy); any remaining errors are logged as a one-line
    // summary and we rely on the required-d.ts sanity check below.
    //
    // tsc writes its errors to stdout (not stderr) by default; capture
    // from both streams so the count is accurate regardless of host
    // tsc version.
    const stdoutStr = proc.stdout?.toString() ?? ''
    const stderrStr = proc.stderr?.toString() ?? ''
    const errorCount = (stdoutStr.match(/error TS/g) ?? []).length +
      (stderrStr.match(/error TS/g) ?? []).length
    if (errorCount > 0) {
      process.stderr.write(
        `[bundle-opencc] note: tsc -p tsconfig.server.json reported ${errorCount} errors in vendored transitive files; ` +
          `relying on the emit + required-d.ts sanity check below.\n`,
      )
      // Temporary: dump full stderr/stdout to investigate remaining errors.
      if (process.env.BUNDLE_OPENCC_DEBUG_TS) {
        if (proc.stdout) process.stderr.write(proc.stdout)
        if (proc.stderr) process.stderr.write(proc.stderr)
      }
    }
  }

  // Copy the two server d.ts files from the tmp emit into the real
  // dist location. The other emitted files (compat/*, etc.) are
  // produced by the main `tsc -b` pass — discarding the duplicates
  // keeps the dist layout consistent with the rest of the build.
  const { copyFileSync, mkdirSync, readdirSync, statSync } = await import('node:fs')
  mkdirSync(SERVER_DIST_DIR, { recursive: true })
  const tmpServerDir = join(SERVER_TYPES_TMP, 'opencc-src', 'server')
  for (const name of readdirSync(tmpServerDir)) {
    if (!name.endsWith('.d.ts')) continue
    copyFileSync(join(tmpServerDir, name), join(SERVER_DIST_DIR, name))
    console.log(`[bundle-opencc]   → ${join(SERVER_DIST_DIR, name)}`)
  }
  // Sanity check: the emit must have produced both .d.ts files the
  // brief mandates. If a future task renames or drops one, fail fast
  // here so the build doesn't silently produce an empty dist.
  for (const required of ['index.d.ts', 'serverTypes.d.ts']) {
    const p = join(SERVER_DIST_DIR, required)
    if (!existsSync(p) || statSync(p).size === 0) {
      console.error(`[bundle-opencc] missing or empty required declaration: ${p}`)
      process.exit(1)
    }
  }
}

const RUNTIME_ENTRY = join(ROOT, 'src', 'opencc-src', 'server', 'createOpenccRuntime.ts')
const RUNTIME_OUT = join(ROOT, 'dist', 'opencc-src', 'server', 'createOpenccRuntime.js')
const RUNTIME_IMPL_ENTRY = join(ROOT, 'src', 'opencc-src', 'server', 'createOpenccRuntime-impl.ts')
const RUNTIME_IMPL_OUT = join(ROOT, 'dist', 'opencc-src', 'server', 'createOpenccRuntime-impl.js')

await esbuild.build({
  entryPoints: [RUNTIME_ENTRY],
  bundle: false,
  format: 'esm',
  outdir: SERVER_DIST_DIR,
  platform: 'node',
  target: 'node22',
  entryNames: '[name]',
})

await esbuild.build({
  entryPoints: [RUNTIME_IMPL_ENTRY],
  bundle: true,
  format: 'esm',
  outfile: RUNTIME_IMPL_OUT,
  platform: 'node',
  target: 'node22',
  sourcemap: true,
  minify: false,
  logLevel: 'warning',
  banner: {
    js:
      "import { createRequire as __createRequire } from 'node:module';\n" +
      "const require = __createRequire(import.meta.url);\n",
  },
  plugins: [commandImplStubPlugin, vendorPatchesPlugin, optionalStubPlugin, uiComponentStubPlugin, preactAliasPlugin],
  external: [
    'sharp',
    'google-auth-library',
    'zod',
    'zod/v3',
    'zod/v4',
    'zod/v4-mini',
    'fflate',
  ],
  treeShaking: true,
})
console.log(`[bundle-opencc] runtime: ${RUNTIME_OUT}`)

// ── Persist input fingerprint stamp ──────────────────────────────
// Write the input hash after all esbuild calls succeed so the next
// build can short-circuit via the cache check at the top of this
// file. We compute the hash once and reuse it (avoid the second
// walkTs() pass on the same build).
if (!existsSync(OUT_DIR)) mkdirSync(OUT_DIR, { recursive: true })
writeFileSync(STAMP_FILE, `${inputHash()}\n`)
console.log(`[bundle-opencc] stamp: ${STAMP_FILE} (${inputHash()})`)

