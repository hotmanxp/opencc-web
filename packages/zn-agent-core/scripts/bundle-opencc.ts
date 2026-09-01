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
// zai patch (2026-08-30, dev mode): ZAI_BUNDLE_DEV=1 flips the bundle into
// "development" mode — no minification, inline source maps, NODE_ENV
// banner. Set by `build:core:dev`. Default is production minified.
const isDev = process.env.ZAI_BUNDLE_DEV === '1'
// zai patch (2026-08-09): 单一入口 —— 聚合 vendor(query) + server
// (createOpenccRuntime) + compat(index.ts) 到同一份 bundle,让 zai 运行时
// vendor/compat 只有一个 module 实例(STATE/commandQueue/bashTracker 共享,
// 消除跨 bundle/dist 状态隔离导致的请求风暴)。
const SRC_ENTRY = join(ROOT, 'src', 'bundle-entry.ts')
const SRC_ROOT = join(ROOT, 'src', 'opencc-src')
// react → preact/compat shim(bundle 内联 preact 而非 react,见 src/compat/preact-shim.ts)
const PREACT_SHIM = join(ROOT, 'src', 'compat', 'preact-shim.ts')
// bun:bundle → bun-shim(zai patch 2026-08-29, vendor 1be705bb 半截
// cherry-pick 重引 `import { feature } from 'bun:bundle'`)。commit
// 67e147e7 把 90 个 vendor 文件的 `feature()` 调用内联成 `false` 字面值
// 并删除 `bun:bundle` import,所以以前 esbuild bundle 阶段不需要
// 处理。这次 1be705bb 从上游 cherry-pick 又带回 3 处 `feature()`
// 调用 + import(PR #2102 的部分代码),需要 esbuild 把 `bun:bundle`
// 重定向到 src/compat/runtime/bun-shim.ts(运行时 stub,见
// bun-shim.ts 头部注释)。运行时 tsx 路径上 bun-protocol.mjs loader
// 已经在做同样的事(见 vitest.config.ts:34 同样 alias);此 plugin
// 让 esbuild bundle 阶段也覆盖到,避免 "Could not resolve 'bun:bundle'"。
const BUN_SHIM = join(ROOT, 'src', 'compat', 'runtime', 'bun-shim.ts')
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
  h.update('recipe:v6\n')
  return h.digest('hex').slice(0, 16)
}

// ── bundle-entry.d.ts 机械生成(zai patch 2026-08-16)──────────────
// 主入口 types 指向 dist/bundle-entry.d.ts。src/ 与 dist/ 目录结构镜像,
// bundle-entry.ts 的 export 语句原样复制即可作为合法 d.ts(相对路径不变),
// 生成逻辑保证 types 与 bundle 永远同步,杜绝手写 stub 漂移。
// 注意:仅支持 re-export 语句(export * / export { } / export type * /
// export type { } from '...');若 bundle-entry.ts 未来出现本地导出声明,
// 需在生成器中补 d.ts 类型输出。
//
// 例外(2026-08-18):`export * from './opencc-src/query.js'` 等 4 条直接
// 引用的 vendor 模块被主 tsconfig exclude(opencc-src),tsc 不为它们发
// d.ts —— 原样镜像会在 bundle-entry.d.ts 里留下指向不存在文件的悬挂引用
// (靠 zai 的 skipLibCheck 静默消化,符号则碰巧在 dist/index.d.ts 里另有
// 本地声明)。运行时真值不受影响(esbuild 把它们打进了 opencc-core.mjs),
// 所以这里只在类型镜像层把这些路径改指 ./index.js,保持"每个运行时
// export 都有可用类型"的镜像契约。改动后由 emitDts 的悬挂校验兜底:
// 若有 re-export 目标在 dist 里仍解析不到,构建直接报错。
const DTS_PATH_REWRITE: Readonly<Record<string, string>> = {
  './opencc-src/query.js': './index.js',
  './opencc-src/services/api/claude.js': './index.js',
  './opencc-src/utils/systemPromptType.js': './index.js',
  './opencc-src/types/message.js': './index.js',
  // zai patch (2026-08-29): 暴露给回归测试的 commandQueue API —
  // vendor 模块无独立 d.ts,镜像到 ./index.js;运行时值由 esbuild 打进
  // opencc-core.mjs,类型只用于测试 import 类型推断。
  './opencc-src/utils/messageQueueManager.js': './index.js',
}

/** 把 bundle-entry.ts 的 re-export 目标改写为 dist 里真实存在的类型面。 */
function rewriteDtsSourcePath(line: string): string {
  for (const [from, to] of Object.entries(DTS_PATH_REWRITE)) {
    if (line.includes(from)) return line.replace(from, to)
  }
  return line
}

/** 校验生成文件里的每个 re-export 目标在 dist 下都可解析(.js → .d.ts)。
 *  冷构建(dist 尚未由 tsc -b 发射)时跳过 — 校验只服务于暖构建的人类
 *  反馈,真正的悬挂引用由后续 typecheck:consumer / verify-server-types-
 *  self-contained 捕获。
 *
 *  cold 判定用 dist/compat/cwdStore.d.ts 作为探针(只有 tsc -b 会发射它;
 *  与 scripts/ensure-fresh-tsc.mjs 一致)。**不要**用 `readdirSync(dist)
 *  .length === 0` 判断 — bundle-opencc 自己会写 Tool.d.ts 到 dist/opencc-
 *  src/Tool.d.ts(zai patch 2026-08-20),让 dist 永远非空,误判 warm。 */
const TSC_PROBE = join(ROOT, 'dist', 'compat', 'cwdStore.d.ts')
function assertDtsTargetsResolve(bundleEntryDts: string): void {
  if (!existsSync(TSC_PROBE)) {
    console.log(
      '[bundle-opencc] cold build (tsc -b probe missing: dist/compat/cwdStore.d.ts) — skipping d.ts target assertion; subsequent tsc -b + typecheck:consumer + verify-server-types-self-contained will catch real dangling refs',
    )
    return
  }
  const fromRe = /from\s+['"](\.[^'"]+)['"]/g
  for (const m of bundleEntryDts.matchAll(fromRe)) {
    const target = m[1]
    if (target === './package.json' || !target.startsWith('.')) continue
    // opencc-src/server/* targets are mechanically emitted later in THIS
    // script by the `tsc -p tsconfig.server.json` step (their files are in
    // tsconfig.server.json include), so a warm dist that predates a new
    // server module must not hard-fail here before that step runs. Dangling
    // refs are still caught by typecheck:consumer + verify-server-types-
    // self-contained (the same net the cold-build guard relies on).
    if (target.startsWith('./opencc-src/server/')) continue
    const expected = join(OUT_DIR, target.replace(/\.js$/, '.d.ts'))
    if (!existsSync(expected)) {
      console.error(
        `[bundle-opencc] ERROR: bundle-entry.d.ts re-export target has no d.ts on disk: ${target} (expected ${relative(ROOT, expected)})`,
      )
      console.error(
        '[bundle-opencc] vendor opencc-src modules are excluded from tsc; add the target to DTS_PATH_REWRITE (point it at a module tsc emits, e.g. ./index.js) or make the emitter produce a d.ts for it.',
      )
      process.exit(1)
    }
  }
}

// ── Tool 类型声明(zai patch 2026-08-20)─────────────────────────────
// standalone 的 Tool.js 不发射(运行时随 bundle-entry.ts `export { buildTool
// } from './opencc-src/Tool.js'` 打进 opencc-core.mjs 主 bundle),主入口
// types(dist/bundle-entry.d.ts)与 server emit(dist/opencc-src/server/
// mainAgents.d.ts 都引用 `from '../Tool.js'`)的 d.ts 链都要 Tool.d.ts 在
// dist 里存在 —— 唯独 vendor 头文件 src/opencc-src/Tool.ts 不在主
// tsconfig.build.json / tsconfig.server.json 的 include 里,tsc 不会发
// 射,所以这里手写保持与源码同步。
//
// emit 顺序:这一步必须在 generateBundleEntryDts() 之前 —— 后者会调用
// assertDtsTargetsResolve,要求 dist/ 下能看到 bundle-entry.ts 每个
// re-export 目标对应的 .d.ts。手写 d.ts 缺位时该 assertion 失败。
//
// 公共表面是 buildTool(def) → Tool(generic),zai 消费只在 ctx 强转后
// 作为 `ctx.buildTool({...})` 注入外置 agent 文件,不依赖精确 return
// 形状,minimal callable signature 已够用;若 Tool.ts 加新字段(类
// `userFacingName` 等),zai 端不消费则不用同步。
{
  const { writeFileSync } = await import('node:fs')
  const TOOL_DTS = join(ROOT, 'dist', 'opencc-src', 'Tool.d.ts')
  mkdirSync(dirname(TOOL_DTS), { recursive: true })
  const dts = [
    `// Type declarations for the vendor Tool module.`,
    `// Mirror the public surface of src/opencc-src/Tool.ts; hand-written`,
    `// because the vendor module is excluded from both tsconfig.build.json`,
    `// and tsconfig.server.json (the latter only covers src/opencc-src/server/*).`,
    `// Downstream consumers (bundle-entry.ts re-export + server/mainAgents.ts`,
    `// import of buildTool / typeof Tool) rely on this file resolving to a`,
    `// callable signature.`,
    `export declare function buildTool<Def extends ToolDef = ToolDef>(def: Def): Tool;`,
    `export type Tool = {`,
    `  name: string;`,
    `  description: string | (() => string | Promise<string>);`,
    `  prompt: string | (() => string | Promise<string>);`,
    `  inputSchema: unknown;`,
    `  outputSchema: unknown;`,
    `  call: (input: any, context?: unknown) => Promise<any>;`,
    `  renderToolUseMessage?: (...args: unknown[]) => unknown;`,
    `  userFacingName?: (...args: unknown[]) => string;`,
    `  isEnabled?: (...args: unknown[]) => boolean;`,
    `  isConcurrencySafe?: (...args: unknown[]) => boolean;`,
    `  isReadOnly?: (...args: unknown[]) => boolean;`,
    `  isDestructive?: (...args: unknown[]) => boolean;`,
    `  checkPermissions?: (...args: unknown[]) => Promise<any>;`,
    `  toAutoClassifierInput?: (...args: unknown[]) => string;`,
    `  [key: string]: unknown;`,
    `};`,
    `export type ToolDef = { name: string } & Partial<Tool>;`,
    ``,
  ].join('\n')
  writeFileSync(TOOL_DTS, dts)
  console.log(`[bundle-opencc]   → ${TOOL_DTS}`)
}

// ── Subagent registry barrel d.ts(zai patch 2026-08-26)──────────────
// compat/subagents/index.ts is a thin barrel that re-exports
// `registry.ts`. The barrel isn't referenced from src/index.ts
// (only bundle-entry.ts re-exports it for the runtime bundle), so
// `tsc -b` doesn't emit `dist/compat/subagents/index.d.ts` on a
// normal build. But `assertDtsTargetsResolve` runs before `tsc -b`
// in the build chain, so the build script can't rely on tsc to have
// produced the d.ts yet.
//
// We hand-write it here (matching the pattern used for Tool.d.ts
// above and sessionApiCounter.d.ts / genericModelCapabilities.d.ts
// below). The surface mirrors src/compat/subagents/registry.ts
// exactly — when registry.ts changes, sync the public surface here.
// bundle-entry.ts's `export * from './compat/subagents/index.js'`
// resolves to this file, keeping the main-entry d.ts self-contained.
{
  const SUBAGENT_INDEX_DTS = join(ROOT, 'dist', 'compat', 'subagents', 'index.d.ts')
  mkdirSync(dirname(SUBAGENT_INDEX_DTS), { recursive: true })
  const dts = [
    `// Type declarations for the compat subagent provider registry barrel.`,
    `// Mirror the public surface of src/compat/subagents/registry.ts.`,
    `// Hand-written because compat/subagents/index.ts is a thin barrel`,
    `// re-exported only by bundle-entry.ts (which main tsconfig.json`,
    `// excludes), so tsc -b does not emit dist/compat/subagents/index.d.ts`,
    `// in a normal build. Keep in sync with registry.ts.`,
    `export declare class SubagentRegistry {`,
    `  registerProvider(provider: SubagentProvider): () => void;`,
    `  getProvider(name: string): SubagentProvider | undefined;`,
    `  list(): string[];`,
    `  startProvider(name: string, req: SubagentRequest, ctx?: SubagentContext): Promise<SubagentRun>;`,
    `}`,
    `export declare class SubagentError extends Error {`,
    `  readonly code: string;`,
    `  constructor(code: string, message: string);`,
    `}`,
    `export declare function getSubagentRegistry(): SubagentRegistry;`,
    `export declare function _resetSubagentRegistryForTests(): void;`,
    `export declare const NO_START_CAPABILITIES: SubagentCapabilities;`,
    `export interface SubagentCapabilities {`,
    `  readonly agentOptions: boolean;`,
    `  readonly outputSchema: boolean;`,
    `  readonly depthLimit: boolean;`,
    `  readonly toolFilter: boolean;`,
    `  readonly persona: boolean;`,
    `}`,
    `export interface SubagentProvider {`,
    `  readonly name: string;`,
    `  readonly description: string;`,
    `  readonly inheritsParentContext: boolean;`,
    `  readonly capabilities: SubagentCapabilities;`,
    `  readonly agentRouteDefaults?: Readonly<{ provider: string; model: string }>;`,
    `  start(req: SubagentRequest, ctx: SubagentContext): Promise<SubagentRun>;`,
    `}`,
    `export interface SubagentRequest {`,
    `  readonly description: string;`,
    `  readonly prompt: string;`,
    `  readonly cwd?: string;`,
    `  readonly env?: Readonly<Record<string, string>>;`,
    `  readonly model?: string;`,
    `  readonly signal?: AbortSignal;`,
    `}`,
    `export interface SubagentContext {`,
    `  readonly parentCwd?: string;`,
    `  readonly parentEnv?: Readonly<Record<string, string>>;`,
    `}`,
    `export interface SubagentEvent {`,
    `  readonly type: string;`,
    `  readonly text?: string;`,
    `  readonly phase?: string | null;`,
    `  readonly raw?: unknown;`,
    `}`,
    `export type SubagentStopReason = 'completed' | 'error' | 'aborted' | 'max-tokens' | 'refusal';`,
    `export interface SubagentResult {`,
    `  readonly text: string;`,
    `  readonly stopReason: SubagentStopReason;`,
    `  readonly errorMessage?: string;`,
    `  readonly diagnostic?: string;`,
    `}`,
    `export interface SubagentRun {`,
    `  readonly id: string;`,
    `  readonly events: AsyncIterable<SubagentEvent>;`,
    `  readonly result: Promise<SubagentResult>;`,
    `  cancel(): Promise<void>;`,
    `}`,
    ``,
  ].join('\n')
  writeFileSync(SUBAGENT_INDEX_DTS, dts)
  console.log(`[bundle-opencc]   → ${SUBAGENT_INDEX_DTS}`)
}

// compat/subagents/claude-code/index.ts is a subagent provider
// registration module. Like compat/subagents/index.ts
// (the registry barrel above), it's only reached from bundle-entry.ts
// for its apply function:
//   export { apply as applyClaudeCodeProvider } from './compat/subagents/claude-code/index.js'
// so tsc -b does not emit d.ts for it. Hand-write a minimal d.ts file
// covering only the apply surface the bundle-entry re-exports;
// the SubagentRegistry type is imported from the barrel d.ts above.
// NOTE (2026-08-28): the codex provider d.ts mirror was removed along
// with its bundle-entry export (app-server handshake fails unattended);
// compat/subagents/codex/ module stays for a future fix.
{
  const SUBAGENT_PROVIDER_DTS_DIR = join(ROOT, 'dist', 'compat', 'subagents')
  const claudeCodeDts = [
    '// Type declarations for the claude-code subagent provider apply entry.',
    '// Mirror src/compat/subagents/claude-code/index.ts (only apply is',
    '// consumed by bundle-entry.ts). Hand-written because the file is only',
    '// referenced from bundle-entry.ts (excluded from main tsconfig.json).',
    "import { SubagentRegistry } from '../index.js';",
    'export declare function apply(registry: SubagentRegistry, config?: unknown): void;',
    '',
  ].join('\n')
  {
    const dshDts = [
      '// Type declarations for the dsh (deepseek-harness) subagent provider',
      '// apply entry. Mirror src/compat/subagents/dsh/index.ts (only apply is',
      '// consumed by bundle-entry.ts). Hand-written because the file is only',
      "// referenced from bundle-entry.ts (excluded from main tsconfig.json).",
      '// apply is config-gated: returns the unregister disposer only when',
      "// `config.enabled === true`; undefined otherwise.",
      "import { SubagentRegistry } from '../index.js';",
      'export declare function apply(registry: SubagentRegistry, config?: unknown): (() => void) | undefined;',
      '',
    ].join('\n')
    const out = join(SUBAGENT_PROVIDER_DTS_DIR, 'dsh', 'index.d.ts')
    mkdirSync(dirname(out), { recursive: true })
    writeFileSync(out, dshDts)
    console.log(`[bundle-opencc]   → ${out}`)
  }
  for (const [rel, dtsBody] of [
    ['claude-code/index.d.ts', claudeCodeDts],
  ] as const) {
    const out = join(SUBAGENT_PROVIDER_DTS_DIR, rel)
    mkdirSync(dirname(out), { recursive: true })
    writeFileSync(out, dtsBody)
    console.log(`[bundle-opencc]   → ${out}`)
  }
}

// ── printSessionRuntime 类型(zai patch 2026-08-27, P1 inproc-print)──
// opencc-src/utils 被 tsc 全树排除(见 tsconfig.server.json exclude),
// bundle-entry.ts 的值 re-export 需要手写 d.ts 落盘 —— 与上面
// genericModelCapabilities 同款先例。公共表面窄(一个 type + 四个函数),
// 字段/签名变更时同步下面这块。
//
// emit 顺序:这一步必须在 generateBundleEntryDts() 之前 —— 后者会调用
// assertDtsTargetsResolve,要求 dist/ 下能看到 bundle-entry.ts 每个
// re-export 目标对应的 .d.ts。手写 d.ts 缺位时该 assertion 失败。
{
  const { writeFileSync } = await import('node:fs')
  const PRINT_SESSION_RUNTIME_DTS = join(
    ROOT, 'dist', 'opencc-src', 'utils', 'printSessionRuntime.d.ts',
  )
  mkdirSync(dirname(PRINT_SESSION_RUNTIME_DTS), { recursive: true })
  const dts2 = [
    `// Type declarations mirroring src/opencc-src/utils/printSessionRuntime.ts`,
    `export type PrintSessionContext = {`,
    `  sessionId: string;`,
    `  writeOutput: (line: string) => void;`,
    `  onComplete: (exitCode: number) => void;`,
    `  cleanups: Set<() => Promise<void>>;`,
    `  dispose: () => Promise<void>;`,
    `  disableCron?: boolean;`,
    `}`,
    `export declare function runWithPrintSession<T>(ctx: PrintSessionContext, fn: () => T): T;`,
    `export declare function getPrintSessionContext(): PrintSessionContext | undefined;`,
    `export declare function isPrintSessionMode(): boolean;`,
    `export declare const CLI_SESSION_KEY: string;`,
    `export declare function getPrintSessionKey(): string;`,
    ``,
  ].join('\n')
  writeFileSync(PRINT_SESSION_RUNTIME_DTS, dts2)
  console.log(`[bundle-opencc]   → ${PRINT_SESSION_RUNTIME_DTS}`)
}

function generateBundleEntryDts(): void {
  // Ensure OUT_DIR exists — this runs before any esbuild call, so we
  // can't rely on esbuild to create the dist/ directory for us.
  if (!existsSync(OUT_DIR)) mkdirSync(OUT_DIR, { recursive: true })
  const src = readFileSync(SRC_ENTRY, 'utf8')
  const sf = ts.createSourceFile(SRC_ENTRY, src, ts.ScriptTarget.Latest, true)
  const exportLines: string[] = []
  for (const stmt of sf.statements) {
    if (ts.isExportDeclaration(stmt)) {
      // export * / export { a, b } / export type * / export type { ... } from '...'
      exportLines.push(rewriteDtsSourcePath(stmt.getText(sf)))
      continue
    }
    if (ts.isExportAssignment(stmt)) {
      console.warn(
        `[bundle-opencc] WARN: bundle-entry.ts default export not representable in generated d.ts — skipping (${SRC_ENTRY})`,
      )
      continue
    }
    if (stmt.modifiers?.some((m) => m.kind === ts.SyntaxKind.ExportKeyword)) {
      console.warn(
        `[bundle-opencc] WARN: bundle-entry.ts local export declaration not copied to bundle-entry.d.ts (${SRC_ENTRY})`,
      )
    }
  }
  const dts = [
    '// Generated by scripts/bundle-opencc.ts — do not edit by hand.',
    '// Mirrors the re-export surface of src/bundle-entry.ts so the package',
    '// main-entry types stay in sync with the runtime bundle',
    '// (dist/opencc-core.mjs). All exports are re-exports; local',
    '// declarations would need explicit d.ts emission here.',
    '',
    ...exportLines,
    '',
  ].join('\n')
  assertDtsTargetsResolve(dts)
  const out = join(OUT_DIR, 'bundle-entry.d.ts')
  writeFileSync(out, dts)
  console.log(
    `[bundle-opencc]   → ${out} (${exportLines.length} export statement(s))`,
  )
}
generateBundleEntryDts()

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
//
// zai patch (2026-08-22): 列表首项加入 'components'(无尾斜杠),让
// components/ 顶层 .tsx(VirtualMessageList / Messages / LogSelector /
// Speller 等)也走 stub。components/ 顶层目前 ~1MB,但 stub 后依赖
// (preact + 其他组件 + 设计系统)被 esbuild tree-shake,实际 bundle
// 字节节省 ~3.5%(实测)。KEEP_FILES 继续生效,纯函数/hooks 文件照旧。
const UI_COMPONENT_STUB_DIRS = [
  'components',
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
  // ThemeProvider.tsx — 工作块 C:从 KEEP_FILES 移到 FILE_LOCAL_STUB_PATHS,
  //            用 file-local AST 替换只 stub 组件函数体,保留 hooks。
  //            见 THEME_PROVIDER_FILE + commandImplStubPlugin。
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
  // zai patch (2026-08-22): components/ 顶层 stub 范围扩大到整棵目录,
  // 这 4 个 .ts 纯文件当前没被外部 import,保险起见保留以便未来引用。
  'components/EffortIndicator.ts',
  'components/SentryErrorBoundary.ts',
  'components/StartupScreen.ts',
  'components/useCodexOAuthFlow.ts',
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

// 工作块 C:ThemeProvider 函数体 stub
// ThemeProvider.tsx 是"组件 + hooks(useTheme / useThemeSetting /
// usePreviewTheme)混排":hooks 被 hooks/useCopyOnSelect.ts 等 .ts 引用
// 保留;组件 JSX 在 zai 上不会被渲染(zai 是 HTTP server,ink 渲染
// 入口已在工作块 B stub,ThemeProvider.Provider 只在 ink.ts 的
// withTheme 包裹里被引用 → withTheme 自身是死代码)。所以这里登记
// 单文件走 file-local AST 替换:只把 `ThemeProvider` 函数体换成
// `return null`,hooks 全部保留。
//
// 之前 ThemeProvider.tsx 在 UI_COMPONENT_KEEP_FILES 里,理由是
// "hooks 不能 stub";现在 file-local AST 路径可以细粒度只动组件
// 函数体,所以从 KEEP_FILES 移除、加入 FILE_LOCAL_STUB_PATHS。
const THEME_PROVIDER_FILE = join(
  ROOT,
  'src',
  'opencc-src',
  'components',
  'design-system',
  'ThemeProvider.tsx',
)
const FILE_LOCAL_STUB_PATHS: Set<string> = new Set([
  ...COMMAND_IMPL_STUB_PATHS,
  ...(existsSync(THEME_PROVIDER_FILE) ? [THEME_PROVIDER_FILE] : []),
])

// 工作块 C 兜底 —— 当前为空;未来其它"组件+hooks 混排"文件加入后,
// 这里登记需要走 file-local 替换但当前不在 COMMAND_IMPL_STUB_PATHS
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
    //
    // namespace 维度:ThemeProvider.tsx 在 design-system/ 下,被
    // uiComponentStubPlugin 的 onResolve 标 `ui-component-stub`
    // namespace。esbuild 的 onLoad 只调用匹配 namespace 的 handler,
    // 所以这里两个 namespace 都注册(file 默认 namespace 也覆盖
    // 命令模块路径)。
    const handler = (args: { path: string }): esbuild.OnLoadResult | null => {
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
        // ThemeProvider.tsx 在 ui-component-stub namespace(被
        // uiComponentStubPlugin 标 namespace 后被本 plugin 接管),
        // esbuild 默认不再用文件路径作为 resolveDir,必须显式提供
        // 否则它内嵌的 import('../../utils/config.js') 等无法解析。
        resolveDir: dirname(args.path),
      }
    }
    build.onLoad({ filter: /\.[cm]?tsx?$/ }, handler)
    build.onLoad(
      { filter: /\.[cm]?tsx?$/, namespace: 'ui-component-stub' },
      handler,
    )
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

const bunBundleAliasPlugin: esbuild.Plugin = {
  name: 'bun-bundle-alias',
  setup(build) {
    build.onResolve({ filter: /^bun:bundle$/ }, (args) => {
      return { path: BUN_SHIM }
    })
  },
}

// ── ink 渲染入口 stub 插件(工作块 B)───────────────────────────────
// zai 是 Node HTTP server,无 DOM/TTY。opencc 启动交互模式会调 ink 的
// `render(node, options)` / `createRoot(options)` 在 terminal 渲染
// React 树——zai 走自己的 React/SSE/Express 链路,根本不调这两个函数;
// 它们只是被 main.tsx / interactiveHelpers.tsx / dialogLaunchers.tsx /
// replLauncher.tsx 等 import,但运行时调用路径在 zai 上永远不触发
// (main.tsx 入口走 `launchRepl`,非 `render`)。
//
// 不 stub 时,ink/root.ts 的 `render` → `renderSync` → `new Ink(...)`
// → react-reconciler / Yoga / 实例池,这些被 components/ 通过
// Box/Text 间接引用而被打进 bundle。即便 components/ 已 stub 到 ()=>null,
// ink 的 reconciler/yoga/termio/log-update/screen 还在 bundle 里(~1MB+)。
//
// 此 plugin 拦截 ink/root.ts(ink 的渲染入口),把所有 export 替换为
// no-op dummy:
//
//   - default export `wrappedRender`: () => Promise<{rerender:noop,
//     unmount:noop, waitUntilExit:noop-resolved, cleanup:noop}>
//   - `renderSync`: () => 同上 Instance
//   - `createRoot`: () => Promise<{render:noop, unmount:noop,
//     waitUntilExit:noop-resolved}>
//   - 类型 export(Instance / Root / RenderOptions / InkOptions)保留为空
//     import,因为 opencc-src 内很多 .ts 用 `import type`,tsc -b 不会
//     走这个文件,但 esbuild 见到 runtime import 会用 stub 替身。
//
// 副作用:ink.ts(顶层 re-export)、instances.ts、App.tsx、ink 自己的
// components/(Box/Text/...)、layout/yoga、reconciler、screen、frame 等
// 都不再有 root 引用它们(因为 root.ts 自身只 no-op),esbuild
// tree-shake 掉整棵 ink 运行时树。
//
// 不动 ink 组件层(Box / Text / useInput / useApp 等)——它们仍可能被
// 非渲染路径(如 util、类型推导)间接引用,stub 太激进会伤及无辜。这
// 里只动 root.ts 一个文件的源码 body。
const inkRenderStubPlugin: esbuild.Plugin = {
  name: 'ink-render-stub',
  setup(build) {
    build.onLoad({ filter: /\.[cm]?tsx?$/ }, (args) => {
      // 只拦截 ink/root.ts 一个文件。绝对路径匹配,避免误伤同名组件。
      // ink 在 src/opencc-src/ink/root.ts,这是 ink 渲染的唯一入口。
      if (!args.path.endsWith(`${sep}src${sep}opencc-src${sep}ink${sep}root.ts`)) {
        return null
      }
      return {
        contents: [
          '// ink render-entry stub (zai patch 2026-08-16)',
          '// zai is a Node HTTP server — no TTY, no DOM. opencc\'s interactive',
          '// ink render path (render / createRoot / renderSync) is never invoked.',
          '// Replace with no-op dummies so esbuild tree-shakes ink.tsx, instances.ts,',
          '// Box/Text/components/, layout/yoga, reconciler, screen, frame, termio, etc.',
          '',
          'export type Instance = {',
          '  rerender: (...args: unknown[]) => void',
          '  unmount: (...args: unknown[]) => void',
          '  waitUntilExit: () => Promise<void>',
          '  cleanup: (...args: unknown[]) => void',
          '}',
          '',
          'export type Root = {',
          '  render: (...args: unknown[]) => void',
          '  unmount: (...args: unknown[]) => void',
          '  waitUntilExit: () => Promise<void>',
          '}',
          '',
          'export type RenderOptions = Record<string, unknown>',
          '',
          'const noopInstance: Instance = {',
          '  rerender: () => {},',
          '  unmount: () => {},',
          '  waitUntilExit: () => Promise.resolve(),',
          '  cleanup: () => {},',
          '}',
          '',
          'export const renderSync = (): Instance => noopInstance',
          '',
          'export default async function wrappedRender(): Promise<Instance> {',
          '  return noopInstance',
          '}',
          '',
          'export async function createRoot(): Promise<Root> {',
          '  return {',
          '    render: () => {},',
          '    unmount: () => {},',
          '    waitUntilExit: () => Promise.resolve(),',
          '  }',
          '}',
          '',
        ].join('\n'),
        loader: 'ts',
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
// zai patch (2026-08-22): minify 开启。bundle 字节 14.46MB → 6.93MB
// (-52%)。
//
// zai patch (2026-08-22): sourcemap 关闭。本仓库 sourcemap 实际无用:
// zai dev 用 tsx 直接跑 src（不走 bundle），生产发版前 `find ... -delete`
// 已清掉 .map，线上 stack trace 必然是 minified 字符。关闭后省 ~30MB
// dist 磁盘占用 + esbuild 不再生成 sourcemap 的 build 时间。
// zai patch (2026-08-30, dev mode): ZAI_BUNDLE_DEV=1 时 sourcemap 开 + minify
// 关，dist/opencc-core.mjs 体积变大但 stack trace 保留源码位置 + 变量名。
// `build:core:dev` script 启用此模式。
await esbuild.build({
  entryPoints: [SRC_ENTRY],
  outfile: OUT_FILE,
  bundle: true,
  format: 'esm',
  platform: 'node',
  target: 'node20',
  sourcemap: isDev ? 'inline' : false,
  minify: !isDev,
  logLevel: 'info',
  // Provide a Node `require` so the bundle's compiled
  // `__require("child_process")` calls resolve. esbuild leaves
  // top-level CJS-style require() as `__require(...)` instead of
  // converting to ESM imports; we provide a real require via
  // `createRequire(import.meta.url)`.
  banner: {
    js:
      (isDev ? "globalThis.process = globalThis.process || {}; " +
              "globalThis.process.env = globalThis.process.env || {}; " +
              "globalThis.process.env.NODE_ENV = 'development';\n" : '') +
      "import { createRequire as __createRequire } from 'node:module';\n" +
      "import { fileURLToPath as __fileURLToPath } from 'node:url';\n" +
      "const require = __createRequire(import.meta.url);\n",
  },
  plugins: [commandImplStubPlugin, vendorPatchesPlugin, optionalStubPlugin, uiComponentStubPlugin, inkRenderStubPlugin, preactAliasPlugin, bunBundleAliasPlugin],
  external: [
    // sharp: native .node binary binding(zai 前端直接用 sharp 处理图片),
    // esbuild 不能 inline native binding,必须 external 留给运行时 Node 解析。
    'sharp',
    // zod (incl v3/v4/v4-mini): esbuild CJS↔ESM 转换历史上有 bug (zod v4 nested
    // _gte/_gt helper)。zai 进程跑的是 zod/v4 (bundle-entry.ts 主入口 re-export),
    // external 让 Node 在 core/node_modules 解析 zod,避免 bundle 损坏运行时。
    'zod',
    'zod/v3',
    'zod/v4',
    'zod/v4-mini',
    // fflate: vendored via dynamic import in zip.ts / zipCache.ts. esbuild 不能
    // 静态解析 dynamic import 跨出 bundle 图的包,external 让 Node 运行时解析。
    'fflate',
    // @orama/orama + plugin-data-persistence: zai 自己 deps 已有,external 让
    // zai 进程走 node_modules 解析,bundle 不内联(避免双份 module 实例)。
    '@orama/orama',
    '@orama/plugin-data-persistence',
    // 下列 packages 之前列在 external 但 zai 没装、zai 也不该装(只在 opencc
    // vendor 内部使用,且 vendor 路径在 zai entry 图里不触发 —— inline 实验
    // 证明 bundle 字节无变化,删除可降低 zai 部署对这些包的依赖假设)。
    // 如未来 vendor 代码真的触发这些 import(zai 跑 GCP Vertex / 跑 ripgrep
    // / 跑 LSP tree-sitter),会由 optionalStubPlugin 处理(stub 成空 export),
    // 不需要再把 external 加回来。
    //
    // 已移除: 'google-auth-library', '@vscode/ripgrep', 'web-tree-sitter',
    //         'tree-sitter-wasms', 'turndown', '@ant/claude-for-chrome-mcp'
  ],
  // Tree-shake aggressively.
  treeShaking: true,
})

console.log(`[bundle-opencc] ✓ bundled ${SRC_ENTRY}`)
console.log(`[bundle-opencc]   → ${OUT_FILE}`)

// ── Session API counter 类型(zai patch 2026-08-18)─────────────────
// standalone 的 sessionApiCounter.js 不再发射:subpath 废除后无人
// import,运行时经 bundle-entry.ts `export * from
// './opencc-src/services/api/sessionApiCounter.js'` 打进
// opencc-core.mjs 单入口。这里只保留手写 d.ts —— bundle-entry.d.ts
// 的类型链经该 re-export 依赖它,消费端 typecheck 必需。
// (permissions 的独立 d.ts 已在 2026-08-18 移除:主入口类型链不经过
// 它,compat/permissions.ts 是 verbatim 移植自包含,无读者。)
const API_COUNTER_OUT = join(ROOT, 'dist', 'opencc-src', 'services', 'api', 'sessionApiCounter.d.ts')

{
  const { writeFileSync } = await import('node:fs')
  mkdirSync(dirname(API_COUNTER_OUT), { recursive: true })
  writeFileSync(API_COUNTER_OUT, [
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
  ].join('\n'))
  console.log(`[bundle-opencc]   → ${API_COUNTER_OUT}`)
}

// ── OpenCC server 类型声明(zai patch 2026-08-18)──────────────────
// server 的运行时入口(createOpenccRuntime / createHeadlessContext /
// createSessionFacade + plugin DTO 类型)统一经 src/bundle-entry.ts
// re-export 打进 opencc-core.mjs 单入口,不再发射独立的
// dist/opencc-src/server/*.js(2026-08-16 废除 subpath 后无人 import,
// 之前遗留的 bundle:false thin 层与 bundle:true impl 单文件均冗余)。
//
// 声明文件(`*.d.ts`)由下方 `tsc -p tsconfig.server.json` 机械发射:
//   * includes only the server module + the (vendor-tree-excluded)
//     `compat/` types the module imports from;
//   * excludes the opencc vendor tree (`src/opencc-src/**` except
//     `server/`) so the emit doesn't drag React/JSX/opentelemetry/
//     lodash-es into the dist;
//   * uses `emitDeclarationOnly: true` + a tmp outDir — we only
//     need the server d.ts files, the rest of the tmp output is
//     discarded.
//
// 主入口 types(dist/bundle-entry.d.ts)re-export 自
// `./opencc-src/server/index.js` / `createOpenccRuntime.js` 等,TS 消费
// 者顺着这些路径解析对应的 .d.ts —— 没有 d.ts,下游 import type 全变
// `any`,契约锁不住。
const SERVER_TSCONFIG = join(ROOT, 'tsconfig.server.json')
const SERVER_TYPES_TMP = join(ROOT, 'dist', '.server-types-tmp')
const SERVER_DIST_DIR = join(ROOT, 'dist', 'opencc-src', 'server')

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
// 注意(zai patch 2026-08-18):这是 dist 里唯一被运行时加载的第二个
// JS 文件 —— opencc-core.mjs 自包含、无相对 import,只有这一处
// `createRequire(import.meta.url)` 指向 dist 内的独立产物,所以必须
// 保留发射(prune-dead-dist.mjs 也以此为唯一豁免)。
//
// `bundle: true` because compressToolHistory.ts transitively
// imports 4+ vendored helpers (autoCompact + microCompact +
// toolResultStorage + config) that aren't separately emitted to
// dist. The transitive import graph from these helpers reaches
// into the full opencc-src vendor tree (bootstrap/state,
// SessionMemory, forkedAgent, ...), and `bundle: false` would
// require emitting every transitively-reachable file (hundreds of
// files) before the require can resolve at runtime. Single-file
// bundle 保真实实现,换取 createRequire 在运行时解析成功。
const COMPRESS_TOOL_HISTORY_ENTRY = join(ROOT, 'src', 'opencc-src', 'services', 'api', 'compressToolHistory.ts')
const COMPRESS_TOOL_HISTORY_OUT = join(ROOT, 'dist', 'opencc-src', 'services', 'api', 'compressToolHistory.js')

await esbuild.build({
  entryPoints: [COMPRESS_TOOL_HISTORY_ENTRY],
  bundle: true,
  format: 'esm',
  outfile: COMPRESS_TOOL_HISTORY_OUT,
  platform: 'node',
  target: 'node22',
  // zai patch (2026-08-22): sourcemap 关闭 + minify 开（与主 bundle 对齐）。
  // zai patch (2026-08-30, dev mode): ZAI_BUNDLE_DEV=1 时关 minify 开 inline sourcemap
  sourcemap: isDev ? 'inline' : false,
  minify: !isDev,
  logLevel: 'warning',
  banner: {
    js:
      (isDev ? "globalThis.process = globalThis.process || {}; " +
              "globalThis.process.env = globalThis.process.env || {}; " +
              "globalThis.process.env.NODE_ENV = 'development';\n" : '') +
      "import { createRequire as __createRequire } from 'node:module';\n" +
      "import { fileURLToPath as __fileURLToPath } from 'node:url';\n" +
      "const require = __createRequire(import.meta.url);\n",
  },
  plugins: [commandImplStubPlugin, vendorPatchesPlugin, optionalStubPlugin, uiComponentStubPlugin, inkRenderStubPlugin, preactAliasPlugin, bunBundleAliasPlugin],
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

// ── Generic model capabilities 类型(zai patch 2026-08-18)──────────
// standalone 的 genericModelCapabilities.js 不再发射:逻辑已经 bundle-opencc
// 的主 bundle 打进 opencc-core.mjs(bundle-entry.ts `export * from
// './opencc-src/utils/model/genericModelCapabilities.js'`),zai 的
// profileProjection 从主入口消费它(见 zai/src/shared/profileProjection.ts)。
// 这里只保留手写 d.ts —— bundle-entry.d.ts 的类型链经该 re-export 依赖它。
// 公共表面窄(一个 interface + 一个函数),d.ts 手写即可保持同步。若
// `GenericModelCapabilities` 加字段或 `lookupGenericModelCapabilities`
// 改签名,记得同步下面这块。
{
  const { writeFileSync } = await import('node:fs')
  const GENERIC_MODEL_CAPABILITIES_DTS = join(
    ROOT, 'dist', 'opencc-src', 'utils', 'model', 'genericModelCapabilities.d.ts',
  )
  mkdirSync(dirname(GENERIC_MODEL_CAPABILITIES_DTS), { recursive: true })
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

// ── Persist input fingerprint stamp ──────────────────────────────
// Write the input hash after all esbuild calls succeed so the next
// build can short-circuit via the cache check at the top of this
// file. We compute the hash once and reuse it (avoid the second
// walkTs() pass on the same build).
if (!existsSync(OUT_DIR)) mkdirSync(OUT_DIR, { recursive: true })
writeFileSync(STAMP_FILE, `${inputHash()}\n`)
console.log(`[bundle-opencc] stamp: ${STAMP_FILE} (${inputHash()})`)

