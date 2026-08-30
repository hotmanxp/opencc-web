import { useEffect, useRef } from 'react'
import { setupNotifications } from '../../compat/repl/notifications/setupNotifications.js'
import type { NotificationEvent, NotificationKind } from '../../compat/repl/notifications/types.js'

// zai patch (2026-08-30, plan P2): also export imperative setupNotifications.
export { setupNotifications }
export type { NotificationEvent, NotificationKind }

type Props = {
  onNotification: (n: NotificationEvent) => void
}

/**
 * Imperative notification bus adapter — replaces 30+ REPL.tsx notification
 * hooks (rateLimit / deprecation / pluginAutoUpdate / mcpStatus / etc.)
 * with a single typed event bus. Subscribers registered via `setupNotifications`
 * can also be added at runtime via the returned subscribe() handle.
 */
export function useNotifications({ onNotification }: Props): void {
  const onNotificationRef = useRef(onNotification)
  onNotificationRef.current = onNotification

  useEffect(() => {
    const handle = setupNotifications({
      onNotification: (n) => onNotificationRef.current(n),
    })
    return () => handle.teardown()
  }, [])
}
