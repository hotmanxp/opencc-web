import type { TaskBucket, TaskDetails, TaskSummary } from '@zn-ai/zn-agent-core'

export interface SuperTaskListDto {
  buckets: TaskBucket
  managed: boolean
  supervisorSessionId: string
}

async function json<T>(res: Response): Promise<T> {
  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as { error?: string }
    throw new Error(body.error ?? `HTTP ${res.status}`)
  }
  return res.json() as Promise<T>
}

export function fetchSuperTasks(): Promise<SuperTaskListDto> {
  return fetch('/api/super-tasks').then((r) => json<SuperTaskListDto>(r))
}
export function fetchSuperTaskDetail(id: string): Promise<TaskDetails> {
  return fetch(`/api/super-tasks/${encodeURIComponent(id)}`).then((r) => json<{ task: TaskDetails }>(r)).then((d) => d.task)
}
export async function deleteSuperTasks(ids: string[]): Promise<void> {
  await fetch('/api/super-tasks', {
    method: 'DELETE',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ ids }),
  }).then((r) => json<{ ok: true }>(r))
}
export async function setSuperTasksManaged(enabled: boolean): Promise<void> {
  await fetch('/api/super-tasks/managed', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ enabled }),
  }).then((r) => json<{ ok: true }>(r))
}
export async function injectSuperTaskCommand(
  action: 'dispatch' | 'resume' | 'accept' | 'pause',
  id?: string,
): Promise<void> {
  await fetch('/api/super-tasks/inject', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ action, id }),
  }).then((r) => json<{ ok: true }>(r))
}

export function startSuperTask(id: string): Promise<void> {
  return fetch(`/api/super-tasks/${encodeURIComponent(id)}/start`, { method: 'POST' })
    .then((r) => json<{ ok: true }>(r)).then(() => undefined)
}
export function pauseSuperTask(id: string): Promise<void> {
  return fetch(`/api/super-tasks/${encodeURIComponent(id)}/pause`, { method: 'POST' })
    .then((r) => json<{ ok: true }>(r)).then(() => undefined)
}
export function resumeSuperTask(id: string): Promise<void> {
  return fetch(`/api/super-tasks/${encodeURIComponent(id)}/resume`, { method: 'POST' })
    .then((r) => json<{ ok: true }>(r)).then(() => undefined)
}
export function acceptSuperTask(id: string): Promise<void> {
  return fetch(`/api/super-tasks/${encodeURIComponent(id)}/accept`, { method: 'POST' })
    .then((r) => json<{ ok: true }>(r)).then(() => undefined)
}

export type { TaskBucket, TaskSummary, TaskDetails }