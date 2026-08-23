/**
 * dsh-core esbuild bundle — Phase A PoC。
 *
 * 把 `src/dsh-core-entry.ts`(只 re-export dsh-side named symbols)的所有
 * transitive 依赖静态内联到 `dist/dsh-core.mjs` 单文件 ESM 模块。
 *
 * 与 `packages/zn-agent-core/scripts/bundle-opencc.ts` 的关键差异:
 *   - **不需要** vendor-patches / ui-component-stub / ink-render-stub /
 *     command-impl-stub / preact-alias / optional-stub plugin(dsh-side
 *     无 React/Ink/UI 树,vendor 是 npm package 而非 verbatim copy)。
 *   - **需要** 精确 external:`koffi`(native FFI)/ `@deepseek-ai/cordis-
 *     plugin-loader`(内部探测 Node internal modules)/ `zod`(CJS↔ESM 嵌套
 *     helper 历史 bug)/ `@modelcontextprotocol/sdk`(zai-side 已有,避免
 *     双实例)。
 *   - STAMP 缓存复用 opencc bundle 的 inputHash 模式,扫描 src/ + bundle
 *     脚本自身的 mtime+size,content hash 一致时跳过 esbuild(11s 暖构
 *     建 → ~0.5s)。
 *
 * **范围声明**(Phase A):
 *   - 只打 dsh-side,**不打 dsh-bridge/src 自身**(对齐 opencc-core.mjs
 *     范式:vendor runtime 单文件,compat/adapter 留在 tsc 编译产物)。
 *   - zai-side 看到的 `@zn-ai/dsh-bridge` 主入口 dist/index.js 仍是
 *     tsc 编译产物,**对外 API 零变化**。
 *   - **不解决** Loader create 的双实例问题(那是 Phase B/C 的事)。
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
import { dirname, join, relative, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import * as esbuild from 'esbuild'

const __dirname = dirname(fileURLToPath(import.meta.url))
const ROOT = join(__dirname, '..')
const SRC_ENTRY = join(ROOT, 'src', 'dsh-core-entry.ts')
const SRC_ROOT = join(ROOT, 'src')
const OUT_DIR = join(ROOT, 'dist')
const OUT_FILE = join(OUT_DIR, 'dsh-core.mjs')
// Stamp file holding the input hash for the last successful bundle.
// When the input hash matches and OUT_FILE exists, skip the esbuild
// call entirely (saves ~10s on warm builds).
const STAMP_FILE = join(OUT_DIR, '.bundle-dsh.stamp')

if (!existsSync(SRC_ENTRY)) {
  console.error(`[bundle-dsh] missing entry: ${SRC_ENTRY}`)
  process.exit(1)
}

// ── Input fingerprint cache ──────────────────────────────────────
// Conservative fingerprint: scan every .ts under src/ + the build
// script itself. mtime+size is enough — file content changes show
// up as mtime/size deltas; mtime is preserved on cp and most editors.
// The hash includes relative path so renamed files invalidate too.
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
  for (const file of walkTs(SRC_ROOT)) {
    const rel = relative(ROOT, file).split(sep).join('/')
    const st = statSync(file)
    h.update(`${rel}\0${st.mtimeMs}\0${st.size}\n`)
  }
  // Hash the build script itself so editing externals / banner / options
  // invalidates the cache (the "I changed externals but bundle didn't
  // change" trap).
  const scriptRel = relative(ROOT, fileURLToPath(import.meta.url))
    .split(sep)
    .join('/')
  const scriptSt = statSync(fileURLToPath(import.meta.url))
  h.update(`${scriptRel}\0${scriptSt.mtimeMs}\0${scriptSt.size}\n`)
  // Bump this string when the bundle recipe (externals / plugins /
  // banner) changes so old stamps are treated as stale.
  h.update('recipe:v1\n')
  return h.digest('hex').slice(0, 16)
}

// ── dsh-core-entry.d.ts 由 tsc 生成 ─────────────────────────────
// esbuild bundle 只产 dist/dsh-core.mjs;dist/dsh-core-entry.d.ts 由
// `tsc -b` 编译 src/dsh-core-entry.ts 自然产出(multi-line export type
// 也能正确处理)。package.json subpath export `./dsh-core` 的 types 字段
// 指向 dist/dsh-core-entry.d.ts,ttsc 在 build script 中先于 esbuild 跑。
// dsh-core-entry.js 是死代码(exports map 强制指 .mjs),但 tsc 仍会产出。
//
// **不要** 在这里手动 mirror d.ts — multi-line `export type { ... } from`
// 块不容易正确镜像,且与 tsc 产物容易漂移。

// ── STAMP 缓存命中检测 ──────────────────────────────────────────
if (existsSync(STAMP_FILE) && existsSync(OUT_FILE)) {
  let cached = ''
  try {
    cached = readFileSync(STAMP_FILE, 'utf8').trim()
  } catch {
    cached = ''
  }
  if (cached === inputHash()) {
    console.log(`[bundle-dsh] cached (input hash ${cached}) — skipping esbuild`)
    process.exit(0)
  }
}

// ── Build ────────────────────────────────────────────────────────
// Externals(精确列举,Phase A 不做 glob plugin):
//   - koffi: native .node FFI binding(esbuild 不能 inline native binary)。
//     dsh-session-persistence-jsonl 内部 require('koffi'),external 让
//     Node 在 node_modules 解析 koffi,加载 libkoffi.node。
//   - @deepseek-ai/cordis-plugin-loader: 内部用 createRequire(import.meta.url)
//     + node-addon-require-builtin 探测 Node internal modules,bundler 不能
//     改写这条路径;external 保留原始模块行为。
//   - zod: **inline**(不在 external)。原因:zod 是 dsh-side 的 transitive
//     dep(`dsh-schemastery` 是 zod wrapper),pnpm 把 zod 装到 workspace 根
//     `.pnpm/`,Node ESM resolver 从 bundle 位置出发找不到这个隐藏路径。
//     opencc bundle 把 zod external 是因为 zn-agent-core 直接依赖 zod,
//     dsh-bridge 没有 —— Phase A 走 inline 路径让产物自包含。
//     体积影响:zod ~100KB minified,可接受。如果未来 zod CJS↔ESM helper
//     bug 触发,改为在 dsh-bridge deps 显式列 zod + 恢复 external。
//   - @modelcontextprotocol/sdk: zai-side 已有依赖,external 避免双实例
//     (zai 进程走同一 node_modules 实例)。
//
// **不** external:`@deepseek-ai/dsh-*`(让 esbuild 静态内联所有 dsh-side
// 子集到单文件,dsh-bridge/src 静态 import 全部 inline)。代价是 node_modules
// 中仍有 dsh-* 副本(被动态 import + Loader create 触发),与 bundle 内副本
// 形成双实例;Phase B 评估解决。
await esbuild.build({
  entryPoints: [SRC_ENTRY],
  outfile: OUT_FILE,
  bundle: true,
  format: 'esm',
  platform: 'node',
  target: 'node20',
  sourcemap: false,
  minify: true,
  logLevel: 'info',
  // Banner: provide a Node `require` so the bundle's compiled
  // `__require(...)` calls resolve. esbuild leaves top-level CJS-style
  // require() as `__require(...)` instead of converting to ESM imports;
  // we provide a real require via `createRequire(import.meta.url)`.
  banner: {
    js:
      "import { createRequire as __createRequire } from 'node:module';\n" +
      "import { fileURLToPath as __fileURLToPath } from 'node:url';\n" +
      "const require = __createRequire(import.meta.url);\n",
  },
  external: [
    // Native FFI — bundler can't inline .node binaries
    'koffi',
    // Cordis plugin loader — uses createRequire + Node internal modules
    '@deepseek-ai/cordis-plugin-loader',
    // zod (incl v3/v4/v4-mini): external 让 Node 走 node_modules 解析。
    // ⚠️ zod 不在 dsh-bridge 直接 deps 里(只有 zai/zn-agent-core 装),
    // pnpm 把它放到 workspace 根 .pnpm/;Node ESM resolver 从 dist/ 出发
    // 找不到 .pnpm 隐藏路径。**改方案**:Phase A 把 zod inline,产物自包含。
    // 'zod', 'zod/v3', 'zod/v4', 'zod/v4-mini',
    // MCP SDK — zai-side already has it
    '@modelcontextprotocol/sdk',
  ],
  treeShaking: true,
})

console.log(`[bundle-dsh] ✓ bundled ${SRC_ENTRY}`)
console.log(`[bundle-dsh]   → ${OUT_FILE}`)

// ── 更新 STAMP 文件 ─────────────────────────────────────────────
if (!existsSync(OUT_DIR)) mkdirSync(OUT_DIR, { recursive: true })
writeFileSync(STAMP_FILE, inputHash())
console.log(`[bundle-dsh]   → ${STAMP_FILE} (hash ${inputHash()})`)