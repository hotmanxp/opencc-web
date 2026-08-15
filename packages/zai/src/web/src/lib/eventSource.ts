import { ServerEvent } from '../../../shared/events.js'
import { notifySseError } from './apiError.js'

const API_BASE = '/api'

export interface StreamHandle {
  close: () => void
}

// SSE 连接状态机 — UI 顶栏据此显示连接指示。
// - connecting   : 首次连接尚未 onopen
// - connected    : onopen 成功 (或 server.connected 事件到达)
// - reconnecting : EventSource 自动重连中 (onerror, attempt <= 3)
// - error        : 连续失败 > 3 次, 需要 UI 错误态 + 手动重连
export type StreamState = 'connecting' | 'connected' | 'reconnecting' | 'error'

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
  'runtime.compacted',
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
  'prompt.approve',
  'prompt.permission',
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
  // instance.*
  'instance.changed',
  // queue.* — 消息排队状态快照 (追齐 OPENCC 排队交互)
  'queue.changed',
  // app.update.* — zai 自身版本自动升级通道。UpdaterNotifier 监听,
  // 弹窗「升级完成 / 失败」。对齐 shared/events.ts SystemEvent union,
  // 新增事件必须同步加到 NAMED_EVENT_TYPES,否则 EventSource 静默丢事件。
  'app.update.checking',
  'app.update.installing',
  'app.update.complete',
  'app.update.failed',
  // stream/error — 结构化帧级错误 (server SSE 写入崩溃时关闭前发一帧)
  'stream/error',
  // session/projection — host 算完的派生值快照 (title / context.tokens)
  'session/projection',
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
  onState?: (state: StreamState, attempt: number) => void,
): StreamHandle {
  const url = sid
    ? `${API_BASE}/event?sid=${encodeURIComponent(sid)}`
    : `${API_BASE}/event`
  const es = new EventSource(url)

  let attempt = 0
  // 首次连接: 尚未 onopen, 先报 connecting (UI 显示"连接中").
  onState?.('connecting', attempt)

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

  es.onopen = () => {
    // 连接建立成功: 重置失败计数, 置 connected.
    attempt = 0
    onState?.('connected', attempt)
  }
  es.onerror = () => {
    // EventSource 自带自动重连. 连续失败计数: <=3 次视为"重连中",
    // 超过则进入 error 态 (UI 显示错误 + 手动重连按钮).
    attempt += 1
    onState?.(attempt <= 3 ? 'reconnecting' : 'error', attempt)
    notifySseError('/event', '事件流已断开')
  }

  return {
    close: () => es.close(),
  }
}