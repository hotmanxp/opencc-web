/**
 * dangerouslySkipPermissions — zai patch (2026-08-29) opt-in per-instance option
 * that locks `toolPermissionContext.isBypassPermissionsModeAvailable` to true so
 * vendor's runtime mode-switch guard (print.ts:4802-4823) does not block
 * plan→bypass transitions.
 *
 * Default behavior (no option): false (locked off). Opt-in via option `true`,
 * env `ZAI_DANGEROUSLY_SKIP_PERMISSIONS=1`, or `settings.dangerouslySkipPermissions=true`.
 *
 * Fails loud at construction if `settings.permissions.disableBypassPermissionsMode === 'disable'`
 * to prevent silent override of an explicit user opt-out.
 *
 * Does NOT bypass AskUserQuestion's `requiresUserInteraction()` (permissions.ts:1233)
 * or filesystem safetyCheck (permissions.ts:1256) — those remain bypass-immune.
 *
 * The fail-loud guard is tested separately via a vi.mock'd vendor settings
 * loader (see `dangerouslySkipPermissions.failLoud.test.ts` if added) —
 * vendor's `getSettings_DEPRECATED` reads from `~/.claude/` or cwd
 * `.claude/settings.local.json`, NOT from `${dataDir}/settings.json`, so
 * the dataDir pattern used by sibling tests can't trigger it.
 */

import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { createHeadlessContext } from '@zn-ai/zn-agent-core'

describe('createHeadlessContext — dangerouslySkipPermissions option', { timeout: 30_000 }, () => {
  let dataDir: string
  let cwd: string

  beforeEach(() => {
    dataDir = mkdtempSync(join(tmpdir(), 'zai-dangerously-skip-data-'))
    cwd = mkdtempSync(join(tmpdir(), 'zai-dangerously-skip-cwd-'))
    writeFileSync(
      join(dataDir, 'settings.json'),
      JSON.stringify({ env: {} }),
      'utf8',
    )
  })

  afterEach(() => {
    rmSync(dataDir, { recursive: true, force: true })
    rmSync(cwd, { recursive: true, force: true })
  })

  it('default (option undefined) → isBypassPermissionsModeAvailable === false', async () => {
    const ctx = await createHeadlessContext({
      cwd,
      dataDir,
      runtimeId: 'rt-default',
    })
    const toolPermissionContext = ctx.appState.getState().toolPermissionContext as {
      isBypassPermissionsModeAvailable?: boolean
    }
    expect(toolPermissionContext.isBypassPermissionsModeAvailable).toBe(false)
  })

  it('dangerouslySkipPermissions: false → isBypassPermissionsModeAvailable === false', async () => {
    const ctx = await createHeadlessContext({
      cwd,
      dataDir,
      runtimeId: 'rt-explicit-false',
      dangerouslySkipPermissions: false,
    })
    const toolPermissionContext = ctx.appState.getState().toolPermissionContext as {
      isBypassPermissionsModeAvailable?: boolean
    }
    expect(toolPermissionContext.isBypassPermissionsModeAvailable).toBe(false)
  })

  it('dangerouslySkipPermissions: true → isBypassPermissionsModeAvailable === true', async () => {
    const ctx = await createHeadlessContext({
      cwd,
      dataDir,
      runtimeId: 'rt-explicit-true',
      dangerouslySkipPermissions: true,
    })
    const toolPermissionContext = ctx.appState.getState().toolPermissionContext as {
      isBypassPermissionsModeAvailable?: boolean
    }
    expect(toolPermissionContext.isBypassPermissionsModeAvailable).toBe(true)
  })
})