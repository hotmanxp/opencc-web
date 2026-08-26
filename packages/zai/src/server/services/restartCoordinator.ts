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

export type StopCoordinatorDeps = {
  inFlightCount: () => number
  abortAll: () => number
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

async function drainUntilExit(
  deps: { inFlightCount: () => number; abortAll: () => number; sleep: (ms: number) => Promise<void>; now: () => number },
  cancelledRef: { cancelled: boolean },
): Promise<{ drain: DrainResult; cancelled: boolean }> {
  const start = deps.now()
  let inFlight = deps.inFlightCount()
  while (inFlight > 0 && !cancelledRef.cancelled) {
    if (deps.now() - start >= DRAIN_TIMEOUT_MS) break
    await deps.sleep(POLL_INTERVAL_MS)
    inFlight = deps.inFlightCount()
  }

  if (cancelledRef.cancelled) {
    return { drain: { drained: true as const, inFlight: 0 }, cancelled: true }
  }

  if (inFlight === 0) {
    return { drain: { drained: true as const, inFlight: 0 }, cancelled: false }
  }
  const aborted = deps.abortAll()
  return { drain: { drained: false as const, aborted, timeoutMs: DRAIN_TIMEOUT_MS }, cancelled: false }
}

export function requestRestart(
  reason: 'user_action' | 'auto_recovery' | 'update',
  deps: RestartCoordinatorDeps,
): RestartHandle {
  const cancelledRef = { cancelled: false }
  const cancel = () => { cancelledRef.cancelled = true }

  const promise = (async () => {
    const { drain, cancelled } = await drainUntilExit(deps, cancelledRef)

    if (cancelled) {
      deps.log('[restart] cancelled before close')
      return { exited: true as const, drain: { drained: true as const, inFlight: 0 } }
    }

    await deps.closeServer()
    deps.sendRestart(reason)
    deps.exit(0)
    return { exited: true as const, drain }
  })()

  return { promise, cancel }
}

// requestStop: 镜像 requestRestart 的 drain + abort 行为,但不调用
// closeServer / sendRestart。child exit → supervisor 看到没有 pendingRestart
// → supervisor 走正常退出路径 (`supervisor.ts` exitCode = code ?? 0),整个
// managed 进程退出。不可被 cancel:停服请求一旦发出,drain 就一直跑到退出。
export function requestStop(deps: StopCoordinatorDeps): RestartHandle {
  const cancelledRef = { cancelled: false }
  const cancel = () => { cancelledRef.cancelled = true }

  const promise = (async () => {
    const { drain, cancelled } = await drainUntilExit(deps, cancelledRef)

    if (cancelled) {
      deps.log('[stop] cancelled before exit (requestStop is not cancellable; this should not normally happen)')
      return { exited: true as const, drain: { drained: true as const, inFlight: 0 } }
    }

    deps.exit(0)
    return { exited: true as const, drain }
  })()

  return { promise, cancel }
}
