#!/usr/bin/env node
/**
 * 开发者本地首次拉取 vendor 二进制用。
 * 从 OpenCC 项目直接 cp，无 npm 依赖。
 *
 * Usage: node scripts/fetch-vendor-ripgrep.mjs
 * Prerequisite: OpenCC 项目需在 /Users/liangxuechao572/code/opencc
 */
import { copyFileSync, mkdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const openccVendor = '/Users/liangxuechao572/code/opencc/vendor/ripgrep'
const zaiVendor = join(__dirname, '..', 'vendor', 'ripgrep')
mkdirSync(zaiVendor, { recursive: true })

for (const f of ['rg-darwin-arm64', 'rg-darwin-x64', 'rg-win32-x64.exe']) {
  copyFileSync(join(openccVendor, f), join(zaiVendor, f))
  console.log(`copied ${f}`)
}
