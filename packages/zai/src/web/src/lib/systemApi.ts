export type RestartReason = 'user_action' | 'auto_recovery' | 'update'

export type SystemStatus = { state: 'running' | 'starting' | 'restarting' | 'failed'; childPid: number | null }

export async function requestRestart(reason: RestartReason): Promise<{ status: number }> {
  const res = await fetch('/api/system/restart', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ reason }),
  })
  return { status: res.status }
}

export async function cancelRestart(): Promise<{ status: number }> {
  const res = await fetch('/api/system/restart/cancel', { method: 'POST' })
  return { status: res.status }
}

export async function getStatus(): Promise<SystemStatus | null> {
  const res = await fetch('/api/system/status')
  if (!res.ok) return null
  return res.json() as Promise<SystemStatus>
}
