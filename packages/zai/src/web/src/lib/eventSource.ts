import { ServerEvent } from '../../../shared/events.js'
import { notifySseError } from './apiError.js'

const API_BASE = '/api'

// 客户端 SSE 调试开关 — 前端不能用 process.env。
// 三种启用方式(任一为 true 即开启):
//   1. 浏览器 console: window.__ZAI_DEBUG_SSE__ = true
//   2. localStorage: localStorage.setItem('zai-debug-sse', '1')
//   3. URL query: ?zai-debug-sse=1
function isDebugSse(): boolean {
  if (typeof window === 'undefined') return false
  const w = window as any
  if (w.__ZAI_DEBUG_SSE__ === true) return true
  try {
    if (window.localStorage?.getItem('zai-debug-sse') === '1') return true
    const sp = new URLSearchParams(window.location.search)
    if (sp.get('zai-debug-sse') === '1') return true
  } catch {
    // ignore
  }
  return false
}
const DEBUG_SSE = isDebugSse()

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
  // task_factory — 任务工厂生命周期 (created/finished/state.changed)。
  // 2026-09-02: 接入 shared/events.ts union 后必须在此登记, 否则前端
  // addEventListener 白名单静默丢事件 (弹窗完成条不出现的根因)。
  'task_factory',
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
  // command.* — 命令生命周期埋点。routes/command.ts 入口 emit command.run
  // + 出口 emit command.done, commandId 配对。前端 useCommandLifecycle
  // (TBD) 可选择性订阅(默认不弹 toast, 调试面板可见)。与 shared/events.ts
  // CommandEvent union 同步, 新增事件必须同步加到 NAMED_EVENT_TYPES,
  // 否则 EventSource 静默丢事件。
  'command.run',
  'command.done',
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
        const raw = JSON.parse(e.data)
        // ★ ZAI_DEBUG_SSE: 浏览器收到 SSE 帧的原始数据,按 type + turnIndex
        // + sid + seq 打印。和 server 端 [server-sse] 一一对应。
        if (DEBUG_SSE) {
          // eslint-disable-next-line no-console
          console.log('[client-sse] recv', JSON.stringify({
            type: name,
            sessionId: raw?.sessionId,
            turnIndex: raw?.turnIndex,
            seq: raw?.seq,
            eventId: raw?.eventId,
          }))
        }
        const parsed = ServerEvent.parse(raw)
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