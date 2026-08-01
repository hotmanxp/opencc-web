export type DrainResult =
  | { drained: true; inFlight: number }
  | { drained: false; aborted: number; timeoutMs: number }

export type RestartCoordinatorDeps = {
  inFlightCount: () => number
  abortAll: () => number
  closeServer: () => Promise<void>
  sendRestart: (reason: 'user_action' | 'auto_recovery' | 'update') => boolean
  exit: (code: number) => void
  log: (line: string) => void
  sleep: (ms: number) => Promise<void>
  now: () => number
}

export type RestartHandle = {
  promise: Promise<{ exited: true; drain: DrainResult }>
  cancel: () => void
}

const DRAIN_TIMEOUT_MS = 10000
const POLL_INTERVAL_MS = 100

export function requestRestart(
  reason: 'user_action' | 'auto_recovery' | 'update',
  deps: RestartCoordinatorDeps,
): RestartHandle {
  let cancelled = false
  const cancel = () => { cancelled = true }

  const promise = (async () => {
    const start = deps.now()
    let inFlight = deps.inFlightCount()
    while (inFlight > 0 && !cancelled) {
      if (deps.now() - start >= DRAIN_TIMEOUT_MS) break
      await deps.sleep(POLL_INTERVAL_MS)
      inFlight = deps.inFlightCount()
    }

    if (cancelled) {
      deps.log('[restart] cancelled before close')
      return { exited: true as const, drain: { drained: true as const, inFlight: 0 } }
    }

    let drain: DrainResult
    if (inFlight === 0) {
      drain = { drained: true, inFlight: 0 }
    } else {
      const aborted = deps.abortAll()
      drain = { drained: false, aborted, timeoutMs: DRAIN_TIMEOUT_MS }
    }

    await deps.closeServer()
    deps.sendRestart(reason)
    deps.exit(0)
    return { exited: true as const, drain }
  })()

  return { promise, cancel }
}
