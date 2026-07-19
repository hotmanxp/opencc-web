import { useEffect, useState } from 'react'

const POLL_INTERVAL_MS = 5_000

/**
 * Fetch the current cwd for a session, polling every 5s.
 *
 * - Returns `undefined` until the first successful fetch (or forever if sessionId is null)
 * - Keeps last known value on fetch error / 404 (silent)
 * - Restarts polling when sessionId changes
 * - Clears interval on unmount
 */
export function useSessionCwd(sessionId: string | null): string | undefined {
  const [cwd, setCwd] = useState<string | undefined>(undefined)

  useEffect(() => {
    if (!sessionId) {
      setCwd(undefined)
      return
    }

    let cancelled = false

    const fetchOnce = async () => {
      try {
        const res = await fetch(`/api/agent/sessions/${sessionId}/pwd`)
        if (!res.ok) return  // 404 / 5xx — keep old value
        const data = (await res.json()) as { cwd?: string }
        if (!cancelled && typeof data.cwd === 'string') {
          setCwd(data.cwd)
        }
      } catch {
        // network error — keep old value
      }
    }

    void fetchOnce()  // immediate
    const id = setInterval(() => { void fetchOnce() }, POLL_INTERVAL_MS)
    return () => {
      cancelled = true
      clearInterval(id)
    }
  }, [sessionId])

  return cwd
}