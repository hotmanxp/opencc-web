#!/usr/bin/env node
/**
 * 单入口 dist 清理(zai patch 2026-08-18)。
 *
 * 运行时的 import 面已统一到主入口 `@zn-ai/zn-agent-core` →
 * dist/opencc-core.mjs(唯一运行时入口,自包含,无相对 import)。dist 里
 * 其余 .js 全是"非入口"产物,没人会在运行时加载:
 *
 *   - dist/compat/ 下全部 .js、dist/index.js、dist/stateChangeBus.js
 *     是 `tsc -b` 全量编译 src/compat 的副产物。运行时所有 compat 逻辑
 *     都已被 bundle-opencc.ts 打进 opencc-core.mjs;这些 .js 只是占体积。
 *     (对应的 .d.ts 是 bundle-entry.d.ts re-export 链的 load-bearing,
 *     保留。)
 *   - dist/opencc-src/server/*.js(7 个)、sessionApiCounter.js、
 *     permissions.js、genericModelCapabilities.js 是 bundle-opencc.ts
 *     的单文件 esbuild 侧产物 —— 不进 package exports、不进 bundle,
 *     逻辑已双份存在于 opencc-core.mjs(经 bundle-entry.ts re-export)。
 *
 * 唯一例外(dist 里第二个"被访问"的 JS):
 *   dist/opencc-src/services/api/compressToolHistory.js —— 被 bundle 内
 *   compile 进 opencc-core.mjs 的 compat/transcript/persistence.ts 以
 *   `createRequire(import.meta.url)` 相对路径运行时加载(try/catch 降级)。
 *
 * 因此本脚本的规则极简:删掉 dist 下除 compressToolHistory.js 之外的一切
 * *.js(tsc/esbuild 只发射 .js;.mjs/.cjs/.ts 都是被复制/保留的源资产,
 * 不动),清理残留空目录,`.d.ts` 全量保留。
 */
import { existsSync, readdirSync, rmSync, statSync } from 'node:fs'
import { dirname, join, relative, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const DIST = join(ROOT, 'dist')

/** 运行时仍需从 dist 直接加载的".js 文件"(bundle 的 createRequire fallback)。 */
const KEEP_JS = new Set(['opencc-src/services/api/compressToolHistory.js'])

let deleted = 0

function walk(dir) {
  for (const name of readdirSync(dir)) {
    const full = join(dir, name)
    const stat = statSync(full)
    const rel = relative(DIST, full).split(sep).join('/')
    if (stat.isDirectory()) {
      walk(full)
      // 清理空目录(整洁打包;发布只打文件,空目录无影响,删了更干净)
      const remaining = readdirSync(full).length
      if (remaining === 0) rmSync(full, { recursive: true })
    } else if (name.endsWith('.js')) {
      if (KEEP_JS.has(rel)) continue
      rmSync(full)
      deleted++
      console.log(`[prune-dead-dist] removed ${rel}`)
    }
    // .mjs/.cjs/.ts/.d.ts/其它 —— 保留(源资产 / loader shim / 类型)
  }
}

if (!existsSync(DIST)) {
  console.log('[prune-dead-dist] dist not found — nothing to prune')
  process.exit(0)
}

walk(DIST)
console.log(`[prune-dead-dist] done — removed ${deleted} dead .js file(s); kept ${KEEP_JS.size} runtime-required file(s)`)