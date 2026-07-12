import { ServerEvent } from '../../../shared/events.js'

const API_BASE = '/api'

export interface StreamHandle {
  close: () => void
}

export function subscribeServerEvents(
  onEvent: (event: ServerEvent) => void,
  onError?: (err: Event) => void,
): StreamHandle {
  const es = new EventSource(`${API_BASE}/event`)

  es.onmessage = (e) => {
    try {
      const parsed = ServerEvent.parse(JSON.parse(e.data))
      onEvent(parsed)
    } catch (err) {
      console.error('[eventSource] parse failed', err, e.data)
    }
  }

  es.onerror = (e) => {
    onError?.(e)
  }

  return {
    close: () => es.close(),
  }
}
