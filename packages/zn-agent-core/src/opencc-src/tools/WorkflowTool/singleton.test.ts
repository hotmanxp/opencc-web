import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { getWorkflowRegistry, invalidateWorkflowCache } from './singleton.ts'

// CRITICAL: pass an isolated userDir to every registry so the cold-scan
// in registry.scanDir never imports real scripts from ~/.claude/workflows/*.js
// into the test process. Side effects of those scripts (timers, top-level
// imports, etc.) would otherwise bleed into the test run.
let isolatedUserDir: string

beforeEach(() => {
  isolatedUserDir = mkdtempSync(join(tmpdir(), 'opencc-workflow-test-user-'))
  invalidateWorkflowCache()
})

afterEach(() => {
  invalidateWorkflowCache()
})

describe('invalidateWorkflowCache (port of upstream 2.1.170)', () => {
  test('forces the next getWorkflowRegistry() to return a fresh instance', () => {
    const a = getWorkflowRegistry('/tmp/invalidate-test-a', isolatedUserDir)
    const b = getWorkflowRegistry('/tmp/invalidate-test-a', isolatedUserDir)
    expect(a).toBe(b) // same cwd + userDir → same cached instance

    invalidateWorkflowCache()

    const c = getWorkflowRegistry('/tmp/invalidate-test-a', isolatedUserDir)
    expect(c).not.toBe(a) // fresh instance after invalidation
  })

  test('after invalidation, getWorkflowRegistry() re-runs initBundledWorkflows', async () => {
    invalidateWorkflowCache()
    const r = getWorkflowRegistry('/tmp/invalidate-test-b', isolatedUserDir)
    // bundled workflows (deep-research) must still be present after a
    // fresh registry is constructed
    expect(await r.get('deep-research')).toBeDefined()
  })

  test('isolated userDir prevents importing real ~/.claude/workflows/*.js', async () => {
    // Regression guard: place a sentinel script inside the isolated
    // userDir that mutates a global marker on import. If registry.scanDir
    // ever drifts to scanning homedir() again, this script in the
    // isolated dir still proves the scan path is wired correctly; the
    // marker assertion below catches the inverse — a script placed
    // OUTSIDE the isolated dir must NOT be imported.
    const sentinelGlobal = '__opencc_workflow_sentinel_marker__'
    const workflowsDir = join(isolatedUserDir, '.claude', 'workflows')
    mkdirSync(workflowsDir, { recursive: true })
    writeFileSync(
      join(workflowsDir, 'sentinel.js'),
      `globalThis.${sentinelGlobal} = (globalThis.${sentinelGlobal} ?? 0) + 1;\n`,
    )

    const outsideDir = mkdtempSync(join(tmpdir(), 'opencc-workflow-outside-'))
    const outsideWorkflows = join(outsideDir, '.claude', 'workflows')
    mkdirSync(outsideWorkflows, { recursive: true })
    writeFileSync(
      join(outsideWorkflows, 'outside.js'),
      `globalThis.${sentinelGlobal} = (globalThis.${sentinelGlobal} ?? 0) + 100;\n`,
    )

    invalidateWorkflowCache()
    const r = getWorkflowRegistry('/tmp/invalidate-test-outside', isolatedUserDir)
    await r.list()

    // sentinel.js (inside isolatedUserDir) WAS imported (count = 1).
    // outside.js (in a different dir) was NOT imported (no +100).
    expect((globalThis as Record<string, unknown>)[sentinelGlobal]).toBe(1)
  })
})
