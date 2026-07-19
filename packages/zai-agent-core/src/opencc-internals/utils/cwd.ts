// @ts-nocheck
import { AsyncLocalStorage } from 'async_hooks'
import { CwdStore } from '../../runtime/cwdStore.js'

const cwdOverrideStorage = new AsyncLocalStorage<string>()
const sessionIdStorage = new AsyncLocalStorage<string>()

/**
 * Run a function with a sessionId injected into the current async context.
 * All calls to getCwd() within the function (and its async descendants) will
 * resolve via CwdStore keyed on sessionId.
 */
export function runWithSessionId<T>(sessionId: string, fn: () => T): T {
  return sessionIdStorage.run(sessionId, fn)
}

/**
 * Get the sessionId injected by the nearest runWithSessionId ancestor, or undefined.
 */
export function getCurrentSessionId(): string | undefined {
  return sessionIdStorage.getStore()
}

/**
 * Run a function with an overridden working directory for the current async context.
 * All calls to pwd()/getCwd() within the function (and its async descendants) will
 * return the overridden cwd instead of the one resolved from sessionId/CwdStore.
 * This is the same as the opencc cwdOverrideStorage semantics — kept for future
 * sub-agent per-context cwd isolation.
 */
export function runWithCwdOverride<T>(cwd: string, fn: () => T): T {
  return cwdOverrideStorage.run(cwd, fn)
}

/**
 * Get the current working directory.
 *
 * Resolution order:
 *   1. cwdOverrideStorage (per-async-context override for sub-agents / tests)
 *   2. sessionIdStorage → CwdStore.get(sid) (per-session tracked cwd)
 *   3. process.cwd() (fallback when no sessionId is active)
 */
export function pwd(): string {
  const override = cwdOverrideStorage.getStore()
  if (override !== undefined) return override

  const sid = sessionIdStorage.getStore()
  if (sid !== undefined) {
    const fromStore = CwdStore.get(sid)
    if (fromStore !== undefined) return fromStore
  }

  return process.cwd()
}

/**
 * Get the current working directory or process.cwd() if unavailable.
 */
export function getCwd(): string {
  try {
    return pwd()
  } catch {
    return process.cwd()
  }
}