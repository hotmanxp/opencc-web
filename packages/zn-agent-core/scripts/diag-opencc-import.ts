/**
 * Diagnostic: can opencc-src/query.ts be imported under Node with the bun-protocol loader?
 *
 * Usage:
 *   cd /Users/ethan/code/opencc-web
 *   node --import ./packages/zn-agent-core/src/compat/runtime/bun-protocol.mjs \
 *     ./packages/zn-agent-core/scripts/diag-opencc-import.ts
 *
 * Expected outcomes:
 *   SUCCESS  — opencc-src/query.ts loaded, exports logged
 *   ERR_UNSUPPORTED_ESM_URL_SCHEME — bun: redirect not working (Tasks 1+2 regressed)
 *   ERR_MODULE_NOT_FOUND (src/) — absolute src/ import not resolvable (Task 11 blocker)
 *   ERR_MODULE_NOT_FOUND (other) — another dangling import (record for Task 11)
 */

import { existsSync } from 'node:fs'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'

const QUERY = resolve(process.cwd(), 'packages/zn-agent-core/src/opencc-src/query.ts')

console.log('Loading:', QUERY)
console.log('Exists:', existsSync(QUERY))

try {
  const mod = await import(pathToFileURL(QUERY).href)
  const keys = Object.keys(mod).slice(0, 10)
  console.log('SUCCESS — exports:', keys)
} catch (err: unknown) {
  const e = err as { code?: string; message?: string }
  console.log('FAILED:', e.code)
  console.log('Message:', e.message?.split('\n').slice(0, 5).join('\n'))
}
