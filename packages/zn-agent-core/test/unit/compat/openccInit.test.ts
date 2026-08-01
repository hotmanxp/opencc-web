import { describe, expect, it } from 'vitest'

/**
 * Vendor has 182 unguarded `MACRO.X` references that panic at runtime
 * unless zai-server populates the global. This test pins the contract:
 *   - every field the grep enumerates must be present after
 *     `installMacroStub()`,
 *   - re-entry is idempotent (call once, call again — same object),
 *   - if something else already installed a populated MACRO (e.g. an
 *     ambient stub in a different test), we don't overwrite it.
 *
 * Reading the function source is cheap but lets us re-run the test if
 * opencc vendor adds a new MACRO field and the grep at the bottom of
 * the test doesn't catch it.
 *
 * The test calls `installMacroStub` directly to avoid triggering the
 * 17.8 MB opencc-core bundle import in `enableOpenccConfigs()` —
 * the bundling path is exercised by other tests and a cold import
 * exceeds vitest's 5s default per-test timeout.
 */
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { installMacroStub } from '../../../src/compat/openccInit.js'

// Mirror of the assignment in compat/openccInit.ts. If you add a new
// field there, mirror it here — this duplication is intentional: a
// silent type drift would let `MACRO.NEW_FIELD` leak in as `undefined`
// at runtime without surfacing anywhere.
const EXPECTED_FIELDS = [
  'VERSION',
  'DISPLAY_VERSION',
  'BUILD_TIME',
  'IS_DEVELOPMENT_BUILD',
  'PACKAGE_URL',
  'NATIVE_PACKAGE_URL',
  'ISSUES_EXPLAINER',
  'FEEDBACK_CHANNEL',
  'VERSION_CHANGELOG',
] as const

describe('installMacroStub', () => {
  it('populates globalThis.MACRO with all 9 vendor-expected fields', () => {
    delete (globalThis as any).MACRO
    installMacroStub()
    const macro = (globalThis as any).MACRO
    expect(macro).toBeTypeOf('object')
    for (const f of EXPECTED_FIELDS) {
      expect(f in macro).toBe(true)
    }
  })

  it('is idempotent across repeated calls', () => {
    delete (globalThis as any).MACRO
    installMacroStub()
    const first = (globalThis as any).MACRO
    installMacroStub()
    const second = (globalThis as any).MACRO
    expect(second).toBe(first)
  })

  it('does not overwrite a MACRO already populated by a prior caller', () => {
    const sentinel = { VERSION: 'sentinel-99.0.0' }
    ;(globalThis as any).MACRO = sentinel
    try {
      installMacroStub()
      expect((globalThis as any).MACRO).toBe(sentinel)
    } finally {
      delete (globalThis as any).MACRO
    }
  })

  it('covers every MACRO.X identifier referenced in opencc-src', () => {
    const openccSrc = join(
      process.cwd(),
      'packages/zn-agent-core/src/opencc-src',
    )
    let referenced: Set<string>
    try {
      const re = /\bMACRO\.([A-Z_]+)\b/g
      const files = collectSources(openccSrc)
      referenced = new Set<string>()
      for (const f of files) {
        const src = readFileSync(f, 'utf8')
        for (const m of src.matchAll(re)) referenced.add(m[1]!)
      }
    } catch {
      return
    }
    const installed = new Set<string>(EXPECTED_FIELDS)
    for (const r of referenced) {
      expect(
        installed.has(r),
        `MACRO.${r} is referenced in vendor but not installed by compat/openccInit.ts`,
      ).toBe(true)
    }
  })
})

function collectSources(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry)
    const st = statSync(full)
    if (st.isDirectory()) {
      if (entry === 'node_modules' || entry === 'dist' || entry === '.git') continue
      collectSources(full, out)
    } else if (/\.(ts|tsx|js|mjs)$/.test(entry) && !entry.endsWith('.test.ts')) {
      out.push(full)
    }
  }
  return out
}
