import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { resolveVendorRgPath } from '../../../../src/compat/vendor/ripgrep.js'

/**
 * `resolveVendorRgPath` must locate `vendor/ripgrep/<bin>` relative to the
 * module's runtime location. The module is consumed in three different
 * shapes and each puts `here` at a different depth below the package root:
 *
 *   - esbuild bundle (production/dev via package exports):
 *       dist/opencc-core.mjs        → here = <pkg>/dist        → 1 level up
 *   - tsc-compiled subpath (legacy):
 *       dist/compat/vendor/*.js     → here = <pkg>/dist/compat/vendor → 3 levels up
 *   - tsx / vitest source:
 *       src/compat/vendor/*.ts      → here = <pkg>/src/compat/vendor → 3 levels up
 *
 * The BUNDLE regression (2026-08-09): the old implementation hardcoded
 * exactly 3 levels of `..`, which works for the source/compiled layouts
 * but overshoots to the monorepo root when the module is inlined into
 * dist/opencc-core.mjs — `resolveRgPath()` then returned null and the zai
 * content-search route reported "ripgrep 未安装,内容搜索不可用".
 */
describe('resolveVendorRgPath', () => {
  let root: string
  const PLATFORM = 'darwin'
  const ARCH = 'arm64'
  const BIN = `rg-${PLATFORM}-${ARCH}`

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'zn-core-rg-'))
    // Real package layout: vendor/ripgrep/<bin> at the package root.
    mkdirSync(join(root, 'vendor', 'ripgrep'), { recursive: true })
    writeFileSync(join(root, 'vendor', 'ripgrep', BIN), '')
  })

  afterEach(() => {
    rmSync(root, { recursive: true, force: true })
  })

  it('resolves from the bundled layout (here = <pkg>/dist)', () => {
    const here = join(root, 'dist')
    mkdirSync(here, { recursive: true })
    const resolved = resolveVendorRgPath(here, PLATFORM, ARCH)
    expect(resolved).toBe(join(root, 'vendor', 'ripgrep', BIN))
  })

  it('resolves from the compiled/source layout (here = <pkg>/src/compat/vendor)', () => {
    const here = join(root, 'src', 'compat', 'vendor')
    mkdirSync(here, { recursive: true })
    const resolved = resolveVendorRgPath(here, PLATFORM, ARCH)
    expect(resolved).toBe(join(root, 'vendor', 'ripgrep', BIN))
  })

  it('returns null for unsupported platform/arch', () => {
    expect(resolveVendorRgPath(root, 'linux', ARCH)).toBeNull()
    expect(resolveVendorRgPath(root, PLATFORM, 'ia32')).toBeNull()
  })

  it('returns null when vendor dir is absent', () => {
    const other = mkdtempSync(join(tmpdir(), 'zn-core-rg-novendor-'))
    try {
      expect(resolveVendorRgPath(join(other, 'dist'), PLATFORM, ARCH)).toBeNull()
    } finally {
      rmSync(other, { recursive: true, force: true })
    }
  })
})
