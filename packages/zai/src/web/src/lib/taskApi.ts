// /api/tasks REST + SSE 客户端工具。
//
// 注意:浏览器 EventSource 不支持自定义 request header,无法传 Last-Event-ID,
// 所以 SSE 续读必须用 fetch + ReadableStream 自己解析 SSE 帧。

const API_BASE = '/api'

export type TaskStatus = 'queued' | 'running' | 'completed' | 'failed' | 'cancelled'

export interface BackgroundTask {
  id: string
  status: TaskStatus
  input: { prompt: string; cwd?: string; agent?: string; model?: string; metadata?: Record<string, unknown> }
  createdAt: number
  startedAt?: number
  finishedAt?: number
  error?: { message: string; category: string }
  resultText?: string
  eventCount: number
}

export interface TaskEvent {
  seq: number
  eventId: string
  ts: number
  type: string
  data: Record<string, unknown>
}

export interface TaskListResponse {
  tasks: BackgroundTask[]
}

export async function fetchTask(taskId: string): Promise<BackgroundTask | null> {
  const res = await fetch(`${API_BASE}/tasks/${encodeURIComponent(taskId)}`)
  if (res.status === 404) return null
  if (!res.ok) throw new Error(`fetch task ${taskId} failed: ${res.status}`)
  return res.json() as Promise<BackgroundTask>
}

export async function listTasks(filter?: { status?: TaskStatus; limit?: number }): Promise<BackgroundTask[]> {
  const params = new URLSearchParams()
  if (filter?.status) params.set('status', filter.status)
  if (filter?.limit !== undefined) params.set('limit', String(filter.limit))
  const qs = params.toString()
  const res = await fetch(`${API_BASE}/tasks${qs ? `?${qs}` : ''}`)
  if (!res.ok) throw new Error(`list tasks failed: ${res.status}`)
  const data = (await res.json()) as TaskListResponse
  return data.tasks
}

export async function cancelTask(taskId: string, reason?: string): Promise<{ ok: boolean }> {
  const res = await fetch(`${API_BASE}/tasks/${encodeURIComponent(taskId)}`, {
    method: 'DELETE',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ reason }),
  })
  if (!res.ok) throw new Error(`cancel task failed: ${res.status}`)
  return res.json() as Promise<{ ok: boolean }>
}

export async function dispatchTask(input: {
  prompt: string
  cwd?: string
  agent?: string
  model?: string
  metadata?: Record<string, unknown>
}): Promise<{ taskId: string; status: TaskStatus }> {
  const res = await fetch(`${API_BASE}/tasks`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(input),
  })
  if (!res.ok) throw new Error(`dispatch failed: ${res.status}`)
  return res.json() as Promise<{ taskId: string; status: TaskStatus }>
}

/** 解析后的单帧 SSE 消息。 */
export interface SseFrame {
  id: number
  event: string
  data: unknown
}

/**
 * 订阅任务事件流。支持 Last-Event-ID 续读。
 * 返回的 AsyncIterable 会在 SSE 流关闭时结束。
 */
export async function* subscribeTaskEvents(
  taskId: string,
  lastEventId?: number,
  signal?: AbortSignal,
): AsyncGenerator<SseFrame> {
  const headers: Record<string, string> = { Accept: 'text/event-stream' }
  if (lastEventId !== undefined) headers['Last-Event-ID'] = String(lastEventId)
  const res = await fetch(`${API_BASE}/tasks/${encodeURIComponent(taskId)}/events`, {
    headers,
    signal,
  })
  if (!res.ok || !res.body) {
    throw new Error(`subscribe events failed: ${res.status}`)
  }

  const reader = res.body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''

  try {
    while (true) {
      const { value, done } = await reader.read()
      if (done) break
      buffer += decoder.decode(value, { stream: true })

      let sepIdx: number
      while ((sepIdx = buffer.indexOf('\n\n')) >= 0) {
        const raw = buffer.slice(0, sepIdx)
        buffer = buffer.slice(sepIdx + 2)
        const frame = parseFrame(raw)
        if (frame) yield frame
      }
    }
  } finally {
    try {
      reader.releaseLock()
    } catch {
      // ignore
    }
  }
}

function parseFrame(raw: string): SseFrame | null {
  let id: number | null = null
  let event: string | null = null
  const dataLines: string[] = []
  for (const line of raw.split('\n')) {
    if (!line) continue
    if (line.startsWith(':')) continue // comment / heartbeat
    const colon = line.indexOf(':')
    const field = colon === -1 ? line : line.slice(0, colon)
    const value = colon === -1 ? '' : line.slice(colon + 1).replace(/^ /, '')
    if (field === 'id') id = Number(value)
    else if (field === 'event') event = value
    else if (field === 'data') dataLines.push(value)
  }
  if (event === null || id === null || Number.isNaN(id)) return null
  if (dataLines.length === 0) return null
  let data: unknown
  try {
    data = JSON.parse(dataLines.join('\n'))
  } catch {
    return null
  }
  return { id, event, data }
}