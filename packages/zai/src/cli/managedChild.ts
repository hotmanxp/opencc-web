export type SupervisorMessage =
  | { type: 'ready'; pid: number; port: number }
  | { type: 'restart'; reason: 'user_action' | 'auto_recovery' | 'update' }
  | { type: 'shutdown' }

export type ChildMessage =
  | { type: 'ready'; pid: number; port: number }
  | { type: 'restarted' }
  | { type: 'shutdown-ack' }

export function isManagedChild(): boolean {
  const v = process.env.ZAI_SUPERVISOR_PID
  return typeof v === 'string' && v.length > 0 && Number.isFinite(Number(v))
}

export function sendToSupervisor(msg: ChildMessage): boolean {
  if (!isManagedChild()) return false
  if (typeof process.send !== 'function') return false
  try {
    process.send(msg)
    return true
  } catch {
    return false
  }
}

type Handler = (msg: SupervisorMessage) => void

export function onSupervisorMessage(handler: Handler): () => void {
  const wrapped = (raw: unknown) => {
    if (raw && typeof raw === 'object' && 'type' in raw) {
      handler(raw as SupervisorMessage)
    }
  }
  process.on('message', wrapped)
  return () => process.off('message', wrapped)
}
