// 使用 fetch POST + ReadableStream 解析 SSE（EventSource 不支持 POST）
const API_BASE = '/api'

export type RuntimeEvent = {
  eventId: string
  sessionId: string
  ts: number
  turnIndex: number
  type: string
  [key: string]: unknown
}

export type AgentStreamOptions = {
  prompt: string
  cwd?: string
  sessionId?: string
  onEvent: (event: RuntimeEvent) => void
  onEnd?: () => void
  signal?: AbortSignal
}

export async function runAgentStream(opts: AgentStreamOptions): Promise<void> {
  const { prompt, cwd, sessionId, onEvent, onEnd, signal } = opts

  const token = localStorage.getItem('zai-token') || ''

  const response = await fetch(`${API_BASE}/agent/stream`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Zai-Token': token,
    },
    body: JSON.stringify({ prompt, cwd, sessionId }),
    signal,
  })

  if (!response.ok) {
    const err = await response.text().catch(() => response.statusText)
    onEvent({
      eventId: 'err',
      sessionId: '',
      ts: Date.now(),
      turnIndex: 0,
      type: 'runtime.error',
      error: { category: 'internal', message: err, recoverable: false },
    })
    onEnd?.()
    return
  }

  const reader = response.body?.getReader()
  if (!reader) {
    onEnd?.()
    return
  }

  const decoder = new TextDecoder()
  let buffer = ''

  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break

      buffer += decoder.decode(value, { stream: true })
      const lines = buffer.split('\n')
      // 保留最后一个不完整的行
      buffer = lines.pop() ?? ''

      for (const line of lines) {
        const trimmed = line.trim()
        if (!trimmed || !trimmed.startsWith('data: ')) continue
        try {
          const event = JSON.parse(trimmed.slice(6)) as RuntimeEvent
          onEvent(event)
          if (event.type === 'runtime.done' || event.type === 'runtime.aborted') {
            onEnd?.()
            return
          }
        } catch {
          // 跳过解析失败的 event
        }
      }
    }
  } catch (err) {
    if ((err as Error).name !== 'AbortError') {
      onEvent({
        eventId: 'err',
        sessionId: '',
        ts: Date.now(),
        turnIndex: 0,
        type: 'runtime.error',
        error: { category: 'internal', message: (err as Error).message, recoverable: false },
      })
    }
  } finally {
    reader.releaseLock()
    onEnd?.()
  }
}

export async function abortAgent(): Promise<void> {
  await fetch(`${API_BASE}/agent/abort`, { method: 'POST' })
}
