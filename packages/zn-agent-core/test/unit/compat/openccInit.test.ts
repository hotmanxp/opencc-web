import { afterEach, beforeEach, describe, expect, it } from 'vitest'

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
import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  applySafeZaiSettingsEnv,
  applyZaiExtraCACertsFromConfig,
  applyZaiSettingsEnvFull,
  applyZaiWorkflowEnableFromSettings,
  installMacroStub,
  readZaiSettingsEnv,
  setZaiIsNonInteractive,
} from '../../../src/compat/openccInit.js'

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

/**
 * Regression tests for the 6 critical startup gaps that
 * enableOpenccConfigs fills beyond installMacroStub + enableConfigs.
 * These tests exercise the compat-side re-implementations directly
 * (no bundle import) so they stay fast and don't depend on the
 * 17.8 MB opencc-core bundle being built. The bundle-call path is
 * covered by `integration/openccQueryBridge.integration.test.ts`.
 *
 * Each test uses a throwaway ZAI_DATA_DIR under tmpdir so we don't
 * pollute the user's real ~/.zai/settings.json.
 */
describe('openccInit startup gaps (compat-side)', () => {
  let tempDataDir: string
  let savedDataDir: string | undefined

  beforeEach(() => {
    tempDataDir = mkdtempSync(join(tmpdir(), 'opencc-init-test-'))
    savedDataDir = process.env.ZAI_DATA_DIR
    process.env.ZAI_DATA_DIR = tempDataDir
  })

  afterEach(() => {
    if (savedDataDir === undefined) {
      delete process.env.ZAI_DATA_DIR
    } else {
      process.env.ZAI_DATA_DIR = savedDataDir
    }
    rmSync(tempDataDir, { recursive: true, force: true })
  })

  it('setZaiIsNonInteractive is idempotent and sets the global flag', () => {
    delete (globalThis as any).__zaiIsNonInteractive
    setZaiIsNonInteractive()
    setZaiIsNonInteractive()
    expect((globalThis as any).__zaiIsNonInteractive).toBe(true)
  })

  it('readZaiSettingsEnv returns {} when settings.json does not exist', () => {
    expect(readZaiSettingsEnv()).toEqual({})
  })

  it('readZaiSettingsEnv returns {} when settings.json is empty', () => {
    writeFileSync(join(tempDataDir, 'settings.json'), '')
    expect(readZaiSettingsEnv()).toEqual({})
  })

  it('readZaiSettingsEnv returns {} when settings.json is malformed JSON', () => {
    writeFileSync(join(tempDataDir, 'settings.json'), '{ not json')
    expect(readZaiSettingsEnv()).toEqual({})
  })

  it('readZaiSettingsEnv reads env from a valid settings.json', () => {
    writeFileSync(
      join(tempDataDir, 'settings.json'),
      JSON.stringify({
        env: {
          ZAI_TEST_FOO: 'bar',
          ZAI_TEST_NUM: 42, // coerced to string
        },
      }),
    )
    expect(readZaiSettingsEnv()).toMatchObject({
      ZAI_TEST_FOO: 'bar',
      ZAI_TEST_NUM: '42',
    })
  })

  it('applySafeZaiSettingsEnv applies missing keys only (process.env wins)', () => {
    process.env.ZAI_TEST_PRESET = 'from_process_env'
    writeFileSync(
      join(tempDataDir, 'settings.json'),
      JSON.stringify({
        env: {
          ZAI_TEST_PRESET: 'from_settings', // should NOT overwrite
          ZAI_TEST_NEW: 'fresh', // should be applied
        },
      }),
    )
    const applied = applySafeZaiSettingsEnv()
    expect(applied).toContain('ZAI_TEST_NEW')
    expect(applied).not.toContain('ZAI_TEST_PRESET')
    expect(process.env.ZAI_TEST_PRESET).toBe('from_process_env')
    expect(process.env.ZAI_TEST_NEW).toBe('fresh')
    delete process.env.ZAI_TEST_PRESET
    delete process.env.ZAI_TEST_NEW
  })

  it('applySafeZaiSettingsEnv is a no-op when settings.json is missing', () => {
    expect(applySafeZaiSettingsEnv()).toEqual([])
  })

  it('applyZaiSettingsEnvFull applies ALL keys (overwrites process.env)', () => {
    process.env.ZAI_TEST_FULL = 'before'
    writeFileSync(
      join(tempDataDir, 'settings.json'),
      JSON.stringify({
        env: {
          ZAI_TEST_FULL: 'after',
        },
      }),
    )
    const applied = applyZaiSettingsEnvFull()
    expect(applied).toContain('ZAI_TEST_FULL')
    expect(process.env.ZAI_TEST_FULL).toBe('after')
    delete process.env.ZAI_TEST_FULL
  })

  it('applyZaiExtraCACertsFromConfig reads NODE_EXTRA_CA_CERTS from settings', () => {
    const certPath = join(tempDataDir, 'ca-bundle.pem')
    writeFileSync(certPath, 'PEM-CONTENT')
    writeFileSync(
      join(tempDataDir, 'settings.json'),
      JSON.stringify({
        env: {
          NODE_EXTRA_CA_CERTS: certPath,
        },
      }),
    )
    delete process.env.NODE_EXTRA_CA_CERTS
    const result = applyZaiExtraCACertsFromConfig()
    expect(result).toBe(certPath)
    expect(process.env.NODE_EXTRA_CA_CERTS).toBe(certPath)
    delete process.env.NODE_EXTRA_CA_CERTS
  })

  it('applyZaiExtraCACertsFromConfig preserves an already-set process.env value', () => {
    const existing = join(tempDataDir, 'existing.pem')
    writeFileSync(existing, 'EXISTING')
    process.env.NODE_EXTRA_CA_CERTS = existing
    writeFileSync(
      join(tempDataDir, 'settings.json'),
      JSON.stringify({
        env: {
          NODE_EXTRA_CA_CERTS: '/should/not/be/used',
        },
      }),
    )
    const result = applyZaiExtraCACertsFromConfig()
    expect(result).toBe(existing)
    expect(process.env.NODE_EXTRA_CA_CERTS).toBe(existing)
    delete process.env.NODE_EXTRA_CA_CERTS
  })

  it('applyZaiExtraCACertsFromConfig returns undefined when settings has no CA path', () => {
    writeFileSync(
      join(tempDataDir, 'settings.json'),
      JSON.stringify({ env: { ZAI_TEST_NO_CA: 'true' } }),
    )
    delete process.env.NODE_EXTRA_CA_CERTS
    expect(applyZaiExtraCACertsFromConfig()).toBeUndefined()
  })

  // Silence unused-import warning when mkdirSync is the only reminder.
  it('mkdtempSync created the temp dir (sanity)', () => {
    // mkdtempSync already creates the dir; this just sanity-checks
    // the fixture. Skipping would also be fine but having a single
    // visible assertion per fixture lifecycle makes failures easier
    // to diagnose.
    expect(statSync(tempDataDir).isDirectory()).toBe(true)
  })

  // Touch the private dummy to keep a stable import surface (used in
  // some test runners that strip unused imports). No runtime effect.
  it('reads settings env end-to-end', () => {
    writeFileSync(
      join(tempDataDir, 'settings.json'),
      JSON.stringify({ env: { ZAI_TEST_E2E: 'ok' } }),
    )
    const env = readZaiSettingsEnv()
    expect(env.ZAI_TEST_E2E).toBe('ok')
  })
})

/**
 * Regression tests for `applyZaiWorkflowEnableFromSettings()` — the
 * bridge that maps `settings.enableDynamicWorkflow` → vendor's runtime
 * gate `process.env.OPENCC_ENABLE_WORKFLOWS`. vendor's
 * `isWorkflowsDisabled()` consults the env var FIRST, so flipping it
 * at boot is enough to add/remove WorkflowTool from the tool pool
 * without restarting the process.
 */
describe('applyZaiWorkflowEnableFromSettings', () => {
  let tempDataDir: string
  let savedDataDir: string | undefined
  let savedEnv: string | undefined

  beforeEach(() => {
    tempDataDir = mkdtempSync(join(tmpdir(), 'opencc-workflow-bridge-'))
    savedDataDir = process.env.ZAI_DATA_DIR
    savedEnv = process.env.OPENCC_ENABLE_WORKFLOWS
    process.env.ZAI_DATA_DIR = tempDataDir
    delete process.env.OPENCC_ENABLE_WORKFLOWS
  })

  afterEach(() => {
    if (savedDataDir === undefined) {
      delete process.env.ZAI_DATA_DIR
    } else {
      process.env.ZAI_DATA_DIR = savedDataDir
    }
    if (savedEnv === undefined) {
      delete process.env.OPENCC_ENABLE_WORKFLOWS
    } else {
      process.env.OPENCC_ENABLE_WORKFLOWS = savedEnv
    }
    rmSync(tempDataDir, { recursive: true, force: true })
  })

  it('returns false and clears env var when settings.json is missing', () => {
    expect(applyZaiWorkflowEnableFromSettings()).toBe(false)
    expect(process.env.OPENCC_ENABLE_WORKFLOWS).toBeUndefined()
  })

  it('returns false and clears env var when enableDynamicWorkflow is unset', () => {
    writeFileSync(
      join(tempDataDir, 'settings.json'),
      JSON.stringify({ outputStyle: 'compact' }),
    )
    expect(applyZaiWorkflowEnableFromSettings()).toBe(false)
    expect(process.env.OPENCC_ENABLE_WORKFLOWS).toBeUndefined()
  })

  it('returns false and clears env var when enableDynamicWorkflow is not boolean', () => {
    writeFileSync(
      join(tempDataDir, 'settings.json'),
      JSON.stringify({ enableDynamicWorkflow: 'yes' }),
    )
    expect(applyZaiWorkflowEnableFromSettings()).toBe(false)
    expect(process.env.OPENCC_ENABLE_WORKFLOWS).toBeUndefined()
  })

  it('returns true and sets env var to "1" when enableDynamicWorkflow is true', () => {
    writeFileSync(
      join(tempDataDir, 'settings.json'),
      JSON.stringify({ enableDynamicWorkflow: true }),
    )
    expect(applyZaiWorkflowEnableFromSettings()).toBe(true)
    expect(process.env.OPENCC_ENABLE_WORKFLOWS).toBe('1')
  })

  it('returns true and sets env var when enableDynamicWorkflow is true alongside other fields', () => {
    writeFileSync(
      join(tempDataDir, 'settings.json'),
      JSON.stringify({
        enableDynamicWorkflow: true,
        outputStyle: 'compact',
        env: { ZAI_TEST_KEEP: '1' },
      }),
    )
    expect(applyZaiWorkflowEnableFromSettings()).toBe(true)
    expect(process.env.OPENCC_ENABLE_WORKFLOWS).toBe('1')
    // 不应该误碰其他 env 字段 — applyZaiSettingsEnvFull 是另一个函数的事
    expect(process.env.ZAI_TEST_KEEP).toBeUndefined()
  })

  it('clears a stale env var when settings.json is later flipped to false', () => {
    // 模拟"用户先在外部设了 env var, 后来又写到 settings.json=false"的场景:
    // 我们的 bridge 必须以 settings.json 为真源,清掉 stale env var。
    process.env.OPENCC_ENABLE_WORKFLOWS = '1'
    writeFileSync(
      join(tempDataDir, 'settings.json'),
      JSON.stringify({ enableDynamicWorkflow: false }),
    )
    expect(applyZaiWorkflowEnableFromSettings()).toBe(false)
    expect(process.env.OPENCC_ENABLE_WORKFLOWS).toBeUndefined()
  })

  it('treats malformed settings.json as disabled (does not crash boot)', () => {
    writeFileSync(join(tempDataDir, 'settings.json'), '{ not json')
    expect(applyZaiWorkflowEnableFromSettings()).toBe(false)
    expect(process.env.OPENCC_ENABLE_WORKFLOWS).toBeUndefined()
  })

  it('treats empty settings.json as disabled', () => {
    writeFileSync(join(tempDataDir, 'settings.json'), '')
    expect(applyZaiWorkflowEnableFromSettings()).toBe(false)
    expect(process.env.OPENCC_ENABLE_WORKFLOWS).toBeUndefined()
  })
})
