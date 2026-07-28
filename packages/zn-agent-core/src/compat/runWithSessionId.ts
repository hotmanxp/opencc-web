/**
 * runWithSessionId — AsyncLocalStorage wrapper for propagating sessionId
 * through async call chains.
 */

import { AsyncLocalStorage } from 'async_hooks'

type SessionStore = { sessionId: string }

const storage = new AsyncLocalStorage<SessionStore>()

export function runWithSessionId<T>(sessionId: string, fn: () => T): T {
  return storage.run({ sessionId }, fn)
}

export function getCurrentSessionId(): string | undefined {
  return storage.getStore()?.sessionId
}
