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
  // state.* — SSE state push
  'agent_task.changed',
  'bash_task.changed',
  'cwd.changed',
  'v2_task.changed',
] as const

// 打开一条 SSE 连接到 /api/event. 后端按 sid 过滤:
// - sid 非空: server 只推 sid 匹配 + 全局事件 (session.* / system.*),
//   防止多个 tab / 同一 tab 切会话时消息互串.
// - sid 为 null: 维持旧行为 (全量), 给未绑定会话的页面用.
//
// 调用方在 sessionId 变化时 close 旧 handle 重新 subscribe, 让 EventSource
// 用新 URL 重建连接 (新连接走 per-sid 切片 + Last-Event-ID 续读).
export function subscribeServerEvents(
  sid: string | null,
  onEvent: (event: ServerEvent) => void,
  onError?: (err: Event) => void,
): StreamHandle {
  const url = sid
    ? `${API_BASE}/event?sid=${encodeURIComponent(sid)}`
    : `${API_BASE}/event`
  const es = new EventSource(url)

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