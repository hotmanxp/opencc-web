#!/usr/bin/env node
/**
 * Cold-build guard for `tsc -b` (zai patch 2026-08-18).
 *
 * `tsc -b` 的增量判断只看 tsconfig.tsbuildinfo 的时间戳,不校验输出文件
 * 是否真实存在。"rm -rf dist" 后 tsbuildinfo 仍是新的 → tsc -b 报
 * "up to date" 直接跳过 → dist/compat/ 下的 .d.ts 等产物不会被重新发射,
 * 消费端类型解析静默断裂,而 build 内的 contract/consumer tsc 查的是
 * src(不查 dist),捕不到。
 *
 * 这里在 build 最前面做探测:若 dist 缺失任何 tsc 发射产物(以
 * dist/compat/cwdStore.d.ts 为探针 —— 只有 tsc -b 会生成它),就删除
 * tsconfig.tsbuildinfo,强制 tsc -b 全量重编,保证干净重建总是收敛。
 */
import { existsSync, rmSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..')
const TSC_PROBE = join(ROOT, 'dist', 'compat', 'cwdStore.d.ts')
const TSBUILDINFO = join(ROOT, 'tsconfig.tsbuildinfo')

if (!existsSync(TSC_PROBE) && existsSync(TSBUILDINFO)) {
  rmSync(TSBUILDINFO)
  console.log(
    '[ensure-fresh-tsc] dist 缺失 tsc -b 产物(probe: dist/compat/cwdStore.d.ts)但 tsconfig.tsbuildinfo 存在 — 已删除 buildinfo,强制 tsc -b 重新编译',
  )
} else {
  console.log('[ensure-fresh-tsc] ok — tsc -b 增量状态有效')
}