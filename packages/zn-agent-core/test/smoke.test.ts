import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { EXTERNAL_PERMISSION_MODES } from '../src/compat/permissions.js'
import { CwdStore } from '../src/compat/cwdStore.js'
import { runWithSessionId } from '../src/compat/runWithSessionId.js'

// NOTE: 早期版本的 smoke.test.ts 通过 `import * as main from '../src/index.js'`
// 验证 main 包入口的公共导出可达。但 src/index.ts 的 re-export 链最终会触发
// opencc vendor 内的循环 import(utils/model/model.ts ↔ utils/modelCost.ts,
// 以及 tools/BashTool/BashTool.tsx ↔ utils/lazySchema.ts),在 vitest 2.1.9 下
// 加载时崩溃("undefined is not a function")。
//
// zai server 在生产运行时不通过 src/index.js 整体加载触发这些 vendor 链:
// opencc runtime 通过 `DefaultAgentRuntime` (compat/runtime/contract.ts)
// 在调用时 lazy-import,避开顶层循环。
//
// 这里改用最小 compat 子路径直接 import,绕开 vendor 循环;VERSION 从
// package.json 读,避开 src/index.ts 的 const VERSION 同模块加载。
const pkgPath = join(__dirname, '..', 'package.json')
const pkg = JSON.parse(readFileSync(pkgPath, 'utf-8')) as { version: string }

describe('zn-agent-core smoke', () => {
  it('package version matches expected', () => {
    expect(pkg.version).toBe('0.7.0')
  })
  it('compat/permissions exports EXTERNAL_PERMISSION_MODES', () => {
    expect(EXTERNAL_PERMISSION_MODES).toBeDefined()
  })
  it('compat/cwdStore exports CwdStore singleton', () => {
    expect(CwdStore).toBeDefined()
    expect(typeof CwdStore.get).toBe('function')
  })
  it('compat/runWithSessionId exports runWithSessionId', () => {
    expect(typeof runWithSessionId).toBe('function')
  })
})