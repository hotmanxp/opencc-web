// @ts-nocheck
import { AsyncLocalStorage } from 'async_hooks'

// zai-local stubs for opencc's bootstrap/state.ts exports. opencc keeps
// process-global cwd in module state; zai's RuntimeConfig already provides
// cwd at session create, so we just fall back to process.cwd() and let the
// per-session AsyncLocalStorage override above handle concurrent contexts.
function getCwdState(): string {
  return process.env['ZAI_CWD'] ?? process.cwd()
}
function getOriginalCwd(): string {
  return process.env['ZAI_ORIG_CWD'] ?? process.cwd()
}

const cwdOverrideStorage = new AsyncLocalStorage<string>()
const sessionIdStorage = new AsyncLocalStorage<string>()

/**
 * Run a function with an overridden working directory for the current async context.
 * All calls to pwd()/getCwd() within the function (and its async descendants) will
 * return the overridden cwd instead of the global one. This enables concurrent
 * agents to each see their own working directory without affecting each other.
 */
export function runWithCwdOverride<T>(cwd: string, fn: () => T): T {
  return cwdOverrideStorage.run(cwd, fn)
}

/**
 * Run a function with a sessionId bound to the current async context.
 * getCurrentSessionId() returns the bound value (or '' outside the context).
 * Used by zai's session-scoped state (CwdStore, bash tracker) to isolate
 * concurrent sessions sharing a single server process.
 */
export function runWithSessionId<T>(sessionId: string, fn: () => T): T {
  return sessionIdStorage.run(sessionId, fn)
}

/**
 * Get the sessionId for the current async context, or '' if none is bound.
 */
export function getCurrentSessionId(): string {
  return sessionIdStorage.getStore() ?? ''
}

/**
 * Get the current working directory
 */
export function pwd(): string {
  return cwdOverrideStorage.getStore() ?? getCwdState()
}

/**
 * Get the current working directory or the original working directory if the current one is not available
 */
export function getCwd(): string {
  try {
    return pwd()
  } catch {
    return getOriginalCwd()
  }
}