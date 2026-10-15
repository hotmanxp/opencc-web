/**
 * Wrap vendor BashTool with per-session cwd sync.
 *
 * Why this exists:
 *   vendor's `Shell.exec()` writes the post-cd cwd into the SDK
 *   context (or STATE.cwd if no context) via the `pwd -P >| tmpfile`
 *   trailer. zai's `CwdStore` is a per-session Map but is **only
 *   written manually** at session create / weixin binding — BashTool's
 *   trailer never reaches it. Result: cross-turn cwd resets to
 *   process.cwd().
 *
 * How it works:
 *   1. Read sid from `getCurrentSessionId()` (compat ALS — zai
 *      `runQueryLoop` sets this via `runWithSessionId`).
 *   2. Read `CwdStore.get(sid)` as beforeCwd; fall back to
 *      `process.cwd()` if absent.
 *   3. Run `originalCall` inside `runWithSdkContext({ sessionId: sid,
 *      cwd: beforeCwd, ... })`. vendor's `setCwdState()` mutates
 *      `ctx.cwd` in place; the closure-captured `ctx` reference keeps
 *      the post-call value visible after the ALS context exits.
 *   4. If `ctx.cwd !== beforeCwd`, write to `CwdStore.set(sid, ctx.cwd)`.
 *
 * Edge cases:
 *   - `preventCwdChanges` (subagent path): vendor's `Shell.ts:425`
 *     guard skips `setCwdState`, so ctx.cwd stays at beforeCwd and
 *     we don't write — correct.
 *   - **deleted cwd**: when the session's cwd no longer exists on disk
 *     (`rm -rf`, `mv`, `git worktree remove`), `originalCwd` must not
 *     point at the same dead path — see `isLiveDir` in `call()`.
 *   - `cwdOverrideStorage` ALS (vendor subagent isolation): takes
 *     priority over ctx.cwd in vendor's `pwd()` — wrap still writes
 *     CwdStore with the absolute path, but vendor's subagent
 *     correctness is preserved.
 *   - getCurrentSessionId() === null (not inside zai runQueryLoop):
 *     fall through to originalCall without wrap.
 *
 * Return contract:
 *   the wrap is a transparent passthrough — it MUST resolve with
 *   whatever `originalCall` resolved with (vendor ToolResult) and
 *   MUST rethrow whatever it threw. vendor's caller reads
 *   `result.data` right after `await tool.call(...)`, so a dropped
 *   return value surfaces as "Cannot read properties of undefined
 *   (reading 'data')" inside toolExecution.
 *
 * Integration:
 *   Patched into vendor `opencc-src/tools.ts` via
 *   `scripts/bundle-opencc.ts:vendorPatchesPlugin` — the import line
 *   for BashTool is rewritten to call `wrapBashToolWithCwdSync` at
 *   module load time, so the wrapped identity is what propagates to
 *   `getAllBaseTools()` (and from there into the runtime tool pool).
 *
 * Kept in its own file (not in compat/tools/opencc/builtin.ts) so the
 * vendor patch's import surface stays minimal — builtin.ts pulls in
 * AskUserQuestionTool / SkillTool / CliAgentTool / etc., which are
 * dead weight for this 80-line cwd wrapper.
 *
 * Exported for unit testing — see
 * test/unit/compat/bashCwdWrap.test.ts.
 */
import { statSync } from 'node:fs'
import { homedir } from 'node:os'
import { CwdStore } from '../../cwdStore.js'
import {
  runWithSdkContext,
  type SdkContext,
} from 'src/bootstrap/state.js'
import { getCurrentSessionId } from '../../runWithSessionId.js'

type BashLikeTool = {
  call: (...args: unknown[]) => Promise<unknown>
  [k: string]: unknown
}

function isLiveDir(path: string): boolean {
  try {
    // statSync, not existsSync: existsSync also succeeds for a regular
    // file at the same path, which would fail later with ENOTDIR.
    return statSync(path).isDirectory()
  } catch {
    return false
  }
}

/**
 * A directory that is still on disk, to anchor recovery when the
 * session's own cwd has been deleted. `process.cwd()` throws ENOENT
 * when the *server's* cwd was removed (the `git worktree remove` case),
 * so fall back to the home directory, which always exists.
 */
function liveFallbackDir(): string {
  try {
    const p = process.cwd()
    if (isLiveDir(p)) return p
  } catch {
    // process.cwd() itself threw — server cwd was deleted.
  }
  return homedir()
}

export function wrapBashToolWithCwdSync(tool: BashLikeTool): BashLikeTool {
  const originalCall = tool.call.bind(tool)
  return {
    ...tool,
    // zai patch (2026-09-14, cwd-multi-session-persistence follow-up):
    // forward `checkPermissions` to the raw tool instead of freezing the
    // spread copy. The wrap runs at bundle module-init (see
    // bundle-opencc.ts vendorPatchesPlugin), which is EARLIER than
    // compat `getOpenccBuiltinTools()` → `forceAllowCheckPermissions()`
    // — that override uses Object.defineProperty on the raw tool, so a
    // spread copy would keep the vendor default and silently drop the
    // always-allow override (the toolFailureLoopGuard STOP bug).
    get checkPermissions() {
      return (tool as { checkPermissions?: unknown }).checkPermissions
    },
    async call(
      input: unknown,
      toolUseContext: unknown,
      ...rest: unknown[]
    ): Promise<unknown> {
      const sid = getCurrentSessionId()
      if (!sid) {
        return originalCall(input as never, toolUseContext as never, ...rest)
      }
      const beforeCwd = CwdStore.get(sid) ?? process.cwd()
      // originalCwd must differ from cwd when the cwd is gone.
      // vendor's recovery branch (opencc-src/utils/Shell.ts:247-260)
      // stats cwd, and on failure falls back to `getOriginalCwd()`.
      // When both hold the same deleted path, that branch can never
      // fire and every Bash call in the session fails with
      // `Working directory "..." is no longer a valid directory` —
      // permanently, since nothing ever rewrites CwdStore. `cd` in a
      // command doesn't help either: the check runs before spawn.
      // Anchoring originalCwd on a live dir lets vendor's own
      // self-heal run; ctx.cwd then gets rewritten to the fallback and
      // the write-back below heals CwdStore on the same call.
      const ctx: SdkContext = {
        sessionId: sid as never, // SessionId is branded string
        sessionProjectDir: null,
        cwd: beforeCwd,
        originalCwd: isLiveDir(beforeCwd) ? beforeCwd : liveFallbackDir(),
      }
      // CRITICAL: the tool result MUST be returned. vendor's caller
      // (opencc-src/services/tools/toolExecution.ts:1481) does
      // `const result = await tool.call(...)` and immediately reads
      // `result.data` — dropping the return value makes `result`
      // undefined and throws
      // "Cannot read properties of undefined (reading 'data')".
      const result = await runWithSdkContext(ctx, () =>
        originalCall(input as never, toolUseContext as never, ...rest),
      )
      // setCwdState mutated ctx.cwd in place during originalCall.
      // Closure-captured `ctx` retains the post-call value.
      // (Skipped on throw — the rejection propagates before this line.)
      if (ctx.cwd !== beforeCwd) {
        CwdStore.set(sid, ctx.cwd)
      }
      return result
    },
  }
}
