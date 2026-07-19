// @ts-nocheck
// Local stub for opencc-internals/utils/cwd.ts.
//
// Upstream imports from '../bootstrap/state.js' which zai does NOT sync
// (it pulls in TUI/desktop deps). We replace those with simple
// process.cwd() / process.env.ORIGINAL_CWD fallbacks.
//
// We also add TWO functions that zai requires but upstream does not ship:
//
//   - runWithSessionId(sid, fn)
//   - getCurrentSessionId()
//
// Both are implemented via an AsyncLocalStorage<string> layered into the
// same ALS that handles cwd override, matching what BashTool / CwdStore
// expect at runtime (cwd.test.ts asserts the contract).
//
// ALL local edits to this file must survive `pnpm sync-from-opencc`. The
// sync script lists cwd.ts in HARD_EXCLUDE_FILES, so re-syncs skip it.
//
// If you need to change behavior, edit this file in place.

import { AsyncLocalStorage } from 'async_hooks'
import { CwdStore } from '../../runtime/cwdStore.js'

const cwdOverrideStorage = new AsyncLocalStorage<string>()
const sessionIdStorage = new AsyncLocalStorage<string>()

/**
 * Run a function with an overridden working directory for the current async context.
 */
export function runWithCwdOverride<T>(cwd: string, fn: () => T): T {
  return cwdOverrideStorage.run(cwd, fn)
}

/**
 * Run a function bound to a sessionId for the current async context.
 *
 * Inside the callback, getCwd() and getCurrentSessionId() return values
 * scoped to this session. CwdStore.get(sid) takes precedence over the
 * process cwd, so concurrent agents each see their own working dir.
 *
 * Nested calls restore the outer session on return.
 */
export function runWithSessionId<T>(sid: string, fn: () => T): T {
  return sessionIdStorage.run(sid, fn)
}

/**
 * Read the sessionId currently bound to this async context, or undefined.
 */
export function getCurrentSessionId(): string | undefined {
  return sessionIdStorage.getStore()
}

/**
 * Fallback for upstream's `getCwdState()` — return process.cwd() when no
 * cwd override / CwdStore entry applies. Bootstrap file is intentionally
 * absent in zai.
 */
function fallbackCwdState(): string {
  return process.cwd()
}

/**
 * Fallback for upstream's `getOriginalCwd()`. Honors ORIGINAL_CWD env
 * if set (opencc's bootstrap pin), else process.cwd().
 */
function fallbackOriginalCwd(): string {
  return process.env.ORIGINAL_CWD ?? process.cwd()
}

/**
 * Get the current working directory.
 *
 * Resolution order:
 *   1. runWithCwdOverride override (highest priority, wins even inside ALS)
 *   2. CwdStore.get(currentSessionId) (per-session cwd tracking)
 *   3. cwdOverrideStorage.getStore() (legacy override)
 *   4. process.cwd() (final fallback)
 */
export function pwd(): string {
  const override = cwdOverrideStorage.getStore()
  if (override !== undefined) return override

  const sid = sessionIdStorage.getStore()
  if (sid !== undefined) {
    const stored = CwdStore.get(sid)
    if (stored) return stored
  }

  return fallbackCwdState()
}

/**
 * Get the current working directory, or the original cwd if the
 * current one is unavailable for any reason.
 */
export function getCwd(): string {
  try {
    return pwd()
  } catch {
    return fallbackOriginalCwd()
  }
}
