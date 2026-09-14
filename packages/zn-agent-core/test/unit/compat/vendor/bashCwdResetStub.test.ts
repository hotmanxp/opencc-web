/**
 * Re-vendor canary (2026-09-14, cwd-multi-session-persistence).
 *
 * `resetCwdIfOutsideProject` (opencc-src/tools/BashTool/utils.ts) is
 * stubbed to `return false` by a zai patch: upstream pulls the shell cwd
 * back to `originalCwd` whenever it drifts outside the allowed working
 * directories, and that pull-back runs INSIDE `BashTool.call`
 * (BashTool.tsx:819-824) — i.e. before
 * `compat/tools/opencc/bashCwdWrap.ts` can read `ctx.cwd` and record it
 * into `CwdStore`. With upstream behaviour active, `cd /tmp` followed by
 * `pwd` in the next call reports the project root again (the
 * "Shell cwd was reset to ..." note in the tool output), which silently
 * kills zai's per-session cwd persistence.
 *
 * The stub lived in the pre-opencc `zai-agent-core` tree and was lost when
 * opencc 0.20.0 was copied in as full un-stripped source (commit
 * 98ee7e5a). This test fails the moment upstream's real implementation is
 * restored by a future re-vendor.
 *
 * Mocking strategy: `setCwd` / `pathInAllowedWorkingPath` / `shouldMaintain*`
 * are stubbed so the assertion can observe the reset attempt directly AND so
 * the file stays importable — upstream's own imports (Shell.ts →
 * BashTool/prompt chain) blow up under vitest with
 * "getMaxTimeoutMs is not a function" (pre-existing vendor ESM breakage,
 * same reason `test/unit/compat/bashCwdWrap.test.ts` mocks its deps).
 * `src/utils/cwd.js` is intentionally NOT mocked: the real `getCwd()` must
 * read the SDK context the same way the wrapped BashTool does.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { runWithSdkContext, type SdkContext } from 'src/bootstrap/state.js'
import { getCwd } from 'src/utils/cwd.js'
import type { ToolPermissionContext } from 'src/Tool.js'

const setCwdSpy = vi.fn()
const pathInAllowedWorkingPathSpy = vi.fn(() => false)

vi.mock('src/utils/Shell.js', () => ({
  setCwd: (...args: unknown[]) => setCwdSpy(...args),
}))

vi.mock('src/utils/permissions/filesystem.js', () => ({
  pathInAllowedWorkingPath: (...args: unknown[]) =>
    pathInAllowedWorkingPathSpy(...args),
}))

vi.mock('src/utils/envUtils.js', () => ({
  shouldMaintainProjectWorkingDir: () => false,
}))

vi.mock('src/services/analytics/index.js', () => ({
  logEvent: () => undefined,
}))

const { resetCwdIfOutsideProject } = await import(
  '../../../../src/opencc-src/tools/BashTool/utils.js'
)

describe('resetCwdIfOutsideProject (zai stub)', () => {
  let outsideDir: string
  let projectDir: string

  beforeEach(() => {
    setCwdSpy.mockClear()
    pathInAllowedWorkingPathSpy.mockClear()
    outsideDir = mkdtempSync(join(tmpdir(), 'zn-cwd-outside-'))
    projectDir = mkdtempSync(join(tmpdir(), 'zn-cwd-project-'))
  })

  afterEach(() => {
    rmSync(outsideDir, { recursive: true, force: true })
    rmSync(projectDir, { recursive: true, force: true })
  })

  /** Minimal context: only `originalCwd` counts as an allowed working dir. */
  const mkPermissionCtx = (): ToolPermissionContext =>
    ({
      mode: 'bypassPermissions',
      additionalWorkingDirectories: new Map<string, unknown>(),
    }) as unknown as ToolPermissionContext

  it('returns false (no reset) when cwd escaped the allowed working dirs', () => {
    const ctx: SdkContext = {
      sessionId: 'sid-canary' as never,
      sessionProjectDir: null,
      cwd: outsideDir,
      originalCwd: projectDir,
    }
    // Everything must be observed INSIDE the SDK context — outside it the
    // ALS is empty and getCwd() falls back to STATE.cwd (process.cwd()).
    const { didReset, cwdAfter } = runWithSdkContext(ctx, () => {
      const didReset = resetCwdIfOutsideProject(mkPermissionCtx())
      return { didReset, cwdAfter: getCwd() }
    })

    // Upstream implementation: cwd !== originalCwd && outside allowed dirs
    // → setCwd(originalCwd) + return true. Restoring it fails both asserts.
    expect(didReset).toBe(false)
    expect(setCwdSpy).not.toHaveBeenCalled()
    expect(cwdAfter).toBe(outsideDir)
    expect(ctx.cwd).toBe(outsideDir)
  })
})
