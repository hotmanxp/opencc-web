export type SupervisorMessage =
  | { type: 'ready'; pid: number; port: number }
  | { type: 'restart'; reason: 'user_action' | 'auto_recovery' | 'update' }
  | { type: 'shutdown' }

/**
 * 子进程 → supervisor 消息。
 *
 * 注意:`restart` 必须是 child → supervisor 方向的「我要重启」消息,
 * supervisor 收到后 pendingRestart 置位,等 child exit 后 spawn 新 child
 * (见 supervisor.ts:188)。早期占位的 `'restarted'` 类型 supervisor 不识别,
 * 导致 SettingsDrawer 的「重启服务」按钮即便走通 IPC 也不会触发 respawn —
 * 这是按钮无响应的一个根因。spec `2026-08-01-zai-service-restart-design.md`
 * §4.2 step 4 与本类型对齐。
 */
export type ChildMessage =
  | { type: 'ready'; pid: number; port: number }
  | { type: 'restart'; reason: 'user_action' | 'auto_recovery' | 'update' }
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
