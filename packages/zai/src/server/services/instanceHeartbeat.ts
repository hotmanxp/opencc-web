const DEFAULT_INTERVAL_MS = 5_000
const MIN_INTERVAL_MS = 1_000

export interface InstanceHeartbeat {
  start: () => void
  stop: () => void
}

export function getInstanceHeartbeatConfig():
  | { enabled: true; instanceId: string; intervalMs: number }
  | null {
  const instanceId = process.env.ZAI_INSTANCE_ID
  const supervisorPid = process.env.ZAI_SUPERVISOR_PID
  if (!instanceId || !supervisorPid) return null
  const raw = process.env.ZAI_INSTANCE_HEARTBEAT_MS
  const parsed = raw ? Number(raw) : DEFAULT_INTERVAL_MS
  const intervalMs =
    Number.isFinite(parsed) && parsed >= MIN_INTERVAL_MS ? Math.floor(parsed) : DEFAULT_INTERVAL_MS
  return { enabled: true, instanceId, intervalMs }
}

export interface CreateInstanceHeartbeatOptions {
  intervalMs: number
  instanceId: string
  getPort: () => number | null
  send?: (msg: unknown) => boolean
  now?: () => number
  setInterval?: (callback: () => void, ms: number) => unknown
  clearInterval?: (timer: unknown) => void
}

export function createInstanceHeartbeat(opts: CreateInstanceHeartbeatOptions): InstanceHeartbeat {
  const now = opts.now ?? Date.now
  const scheduleInterval = opts.setInterval ?? setInterval
  const clearScheduledInterval = opts.clearInterval ?? ((t: unknown) => clearInterval(t as ReturnType<typeof setInterval>))
  const send = opts.send ?? defaultSend
  let timer: unknown
  let lastSentAt = 0

  const emit = (): void => {
    const ts = now()
    if (ts - lastSentAt < opts.intervalMs) return
    lastSentAt = ts
    try {
      send({
        type: 'heartbeat',
        instanceId: opts.instanceId,
        port: opts.getPort(),
        ts,
        pid: process.pid,
      })
    } catch {
      // parent process gone — best-effort silent
    }
  }

  return {
    start() {
      if (timer !== undefined) return
      lastSentAt = now()
      timer = scheduleInterval(emit, opts.intervalMs)
      unrefTimer(timer)
    },
    stop() {
      if (timer === undefined) return
      clearScheduledInterval(timer)
      timer = undefined
    },
  }
}

function defaultSend(msg: unknown): boolean {
  if (typeof process.send !== 'function') return false
  try {
    return Boolean(process.send(msg))
  } catch {
    return false
  }
}

function unrefTimer(timer: unknown): void {
  if (
    timer !== undefined &&
    timer !== null &&
    typeof timer === 'object' &&
    'unref' in timer &&
    typeof (timer as { unref: () => void }).unref === 'function'
  ) {
    (timer as { unref: () => void }).unref()
  }
}
