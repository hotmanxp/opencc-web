// packages/zn-agent-core/src/compat/repl/notifications/setupNotifications.ts
// @ts-nocheck
/**
 * zai patch (2026-08-30, plan P2): imperative notification bus.
 * Replaces 30+ REPL.tsx notification hooks (rateLimit / deprecation /
 * pluginAutoUpdate / mcpStatus / etc.) with a single typed event bus.
 * emit() pushes NotificationEvent; subscribers fire synchronously.
 */

import type { NotificationEvent, NotificationKind } from './types.js'

type SetupNotificationsOpts = {
  onNotification: (n: NotificationEvent) => void
}

export function setupNotifications(opts: SetupNotificationsOpts) {
  let disposed = false
  const additionalListeners = new Set<(n: NotificationEvent) => void>()

  function fire(kind: NotificationKind, payload?: unknown): void {
    if (disposed) return
    const event: NotificationEvent = { kind, payload, timestamp: Date.now() }
    try { opts.onNotification(event) } catch (e) { console.warn(e) }
    for (const cb of additionalListeners) {
      try { cb(event) } catch (e) { console.warn(e) }
    }
  }

  return {
    emit(kind: NotificationKind, payload?: unknown): void {
      fire(kind, payload)
    },
    subscribe(cb: (n: NotificationEvent) => void): () => void {
      additionalListeners.add(cb)
      return () => { additionalListeners.delete(cb) }
    },
    teardown(): void {
      if (disposed) return
      disposed = true
      additionalListeners.clear()
    },
  }
}
