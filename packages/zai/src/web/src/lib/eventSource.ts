import { ServerEvent } from '../../../shared/events.js'
import { notifySseError } from './apiError.js'

const API_BASE = '/api'

export interface StreamHandle {
  close: () => void
}

// Every ServerEvent type the server writes as a named SSE event.
// Keep in sync with shared/events.ts discriminated union — when a new type is
// added there, append it here so addEventListener registers for it. Skipping
// one means the front end silently drops that event (the old onmessage bug).
const NAMED_EVENT_TYPES = [
  // runtime.*
  'runtime.started',
  'runtime.delta',
  'runtime.thinking',
  'runtime.tool_call',
  'runtime.tool_result',
  'runtime.done',
  'runtime.aborted',
  'runtime.error',
  // session.*
  'session.created',
  'session.deleted',
  'session.renamed',
  // job.*
  'job.started',
  'job.progress',
  'job.done',
  'job.failed',
  // prompt.*
  'prompt.ask',
  // system.*
  'server.connected',
  'server.error',
  'toast',
  'branch.changed',
] as const

export function subscribeServerEvents(
  onEvent: (event: ServerEvent) => void,
  onError?: (err: Event) => void,
): StreamHandle {
  const es = new EventSource(`${API_BASE}/event`)

  // The browser's EventSource only fires `onmessage` for the unnamed default
  // event. The server writes each frame as `event: <type>` so we must register
  // a listener per type — anything else silently drops on the front end.
  for (const name of NAMED_EVENT_TYPES) {
    es.addEventListener(name, (e: MessageEvent) => {
      try {
        const parsed = ServerEvent.parse(JSON.parse(e.data))
        onEvent(parsed)
      } catch (err) {
        console.error('[eventSource] parse failed', err, e.data)
      }
    })
  }

  es.onerror = (e) => {
    notifySseError('/event', '事件流已断开')
    onError?.(e)
  }

  return {
    close: () => es.close(),
  }
}