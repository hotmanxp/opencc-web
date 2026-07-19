import { create } from 'zustand'
import { flushSync } from 'react-dom'
import type { ServerEvent } from '../../../shared/events.js'
import type { ModelEntry } from '../../../shared/settings.js'
import type { PermissionMode } from '@zn-ai/zai-agent-core/runtime'
import type { BashTaskInfo, BackgroundTask, TaskStatus } from '../lib/taskApi.js'

// ========== URL <-> sessionId 双向同步 ==========
// Agent 页面: ?sid=xxx 锁住当前活跃会话, 让用户能刷新/分享链接.
// 读: 任何一次"需要确定 sessionId" 的时候(包括首次 loadSessions).
// 写: 当前 sessionId 改变(setCurrentSession / createNewSession 后 server
//     回的 id / deleteSession 后切到下一条),把 URL 同步成最新的 sid.
// 清: loadSessions 时如果 URL 里的 sid 不在 sessions 列表(被删/换机),
//     自动 replaceState 去掉 sid, 避免刷新又卡死.
// 实现选 history 直接读写,不走 react-router 的 useSearchParams: 想让
// 同步逻辑"无痛"地挂在 store 里(没有组件也能 sync),并且 react-router
// 自身的 setSearchParams 同样调 history.pushState/replaceState,效果一致.
// 只在浏览器侧调用, SSR/Node 测试环境下 window 不存在,函数降级为 no-op.
function readUrlSid(): string | null {
  if (typeof window === 'undefined') return null
  const sp = new URLSearchParams(window.location.search)
  return sp.get('sid')
}

function writeUrlSid(sid: string | null): void {
  if (typeof window === 'undefined') return
  const url = new URL(window.location.href)
  const sp = url.searchParams
  if (sid) sp.set('sid', sid)
  else sp.delete('sid')
  // 用 replaceState 避免污染 history (用户按返回键不应回到一个
  // 临时刷新的中间态). pushState 会让用户得按多次返回才能离开 Agent 页.
  window.history.replaceState(window.history.state, '', url.toString())
}

function clearUrlSid(): void {
  writeUrlSid(null)
}

// 与 agent-core TodoWriteInputSchema 的 zod 形态一致 (web 不直接 import zod schema,
// 避免循环依赖; 字段类型用本地 type 即可, 实时流拿到的 input.todos 由本文件内的
// safeParse 兜底, 失败时静默忽略).
export type TodoItem = {
  content: string
  status: 'pending' | 'in_progress' | 'completed'
  activeForm: string
}

// V2 TaskList 镜像 (mirror of zai-agent-core TaskListStore). 跟 TodoZone
// 字段对齐: 客户端只读, 写操作走 TaskCreate/TaskUpdate tool call, server
// 重新计算后通过本字段刷新. status 多一个 'deleted' (completed 之外
// 软删除态), UI 用删除线表达.
export type V2TaskItem = {
  id: string
  subject: string
  description?: string
  activeForm?: string
  status: 'pending' | 'in_progress' | 'completed' | 'deleted'
  blocks: string[]
  blockedBy: string[]
  owner?: string
  updatedAt: number
}

// 把 dataURL (data:<mime>;base64,<...>) 解码成 Blob. 仅用于 v2 协议里把
// 历史图片消息里的 base64 还原成浏览器可显示的 objectURL. 解析失败时
// 返回 null, 调用方回退到 raw dataURL 并把 status 标为 error.
function dataURLtoBlob(dataUrl: string): Blob | null {
  const m = dataUrl.match(/^data:([^;]+);base64,(.+)$/)
  if (!m) return null
  const mime = m[1]!
  const bin = atob(m[2]!)
  const arr = new Uint8Array(bin.length)
  for (let i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i)
  return new Blob([arr], { type: mime })
}

// RuntimeEvent: shape of events produced by the SSE pipeline.
// Kept locally since sseAgent.ts is deleted; matches what loadTranscript
// constructs for user.text / assistant.text / tool_use:* history events.
export type RuntimeEvent = {
  eventId: string
  sessionId: string
  ts: number
  turnIndex: number
  type: string
  text?: string
  thinking?: string
  toolUseId?: string
  name?: string
  input?: Record<string, unknown>
  output?: unknown
  error?: unknown
  reason?: string
  delta?: unknown
  content_block?: Record<string, unknown>
  index?: number
  [key: string]: unknown
}

export type AgentStatus = 'idle' | 'streaming' | 'aborted' | 'error'

export type AgentMessage = RuntimeEvent

export type AskState = {
  toolUseId: string
  questions: any[]
  metadata?: { source?: string }
  status: 'pending' | 'submitting' | 'error'
  errorMessage?: string
  answers: Record<string, string>
  annotations: Record<string, { notes?: string }>
}

// 后台 agent_task 任务的"summary 视图" (Task 10 — SSE state push).
//
// 形态与 hooks/useBackgroundTasks.ts 里的同名 export interface 完全一致 —
// 那里是 useBackgroundTasks hook 内部用的 view-model. 暂时不能在
// useAgentStore 直接 import (useBackgroundTasks 已经 import 了
// useAgentStore, 会形成循环), 故在 store 这一侧 inline 一份同样的
// 字段. Task 14 重构 useBackgroundTasks hook 时会把两边合一.
interface BackgroundTaskSummary {
  taskId: string
  status: TaskStatus
  prompt: string
  createdAt: number
  finishedAt?: number
  error?: string
  /** 后端完整 task 详情,延迟加载 */
  detail?: BackgroundTask
  /**
   * 该任务最近一次观察到的 sessionId (来自 SSE agent_task.changed.event.sessionId
   * 或 listTasks / fetchTask 详情.parentSessionId). 持久化在任务条目上,
   * 避免 dock 在 job.done 3s 清理窗口内, session 过滤因 sessionOfTask 查不到
   * 而把当前 session 的任务也隐藏.
   */
  lastKnownSessionId?: string
}

// 收到 server runtime.compacted 事件时 reducer 推入的 toast. expiresAt
// (timestamp + 5000ms) 让 UI 用 setTimeout 自动回收, 不用 reducer 再起
// 定时器. 注意: 不要复用 useAppStore 的 ToastInfo (message/ts 字段名),
// 这里用 text/level 走专属 display contract — 与 task 14 brief 对齐.
export type CompactionToast = {
  id: string
  text: string
  level: 'info'
  sessionId: string
  expiresAt: number
}

interface AgentState {
  sessionId: string | null
  sessions: Array<{
    transcriptId: string
    title?: string
    updatedAt: number
    /** Resolved model name (from transcript.meta.model). 'unknown' or absent = not set. */
    model?: string
    /** Per-session permission mode (default/acceptEdits/plan/bypassPermissions/dontAsk). */
    permissionMode?: PermissionMode
    cwd?: string
    createdAt?: number
    messageCount?: number
  }>
  cwd: string
  messages: AgentMessage[]
  status: AgentStatus
  abortController: AbortController | null
  pendingAsk: AskState | null
  // 工具边界计数: 每出现一个新的 tool_use 起点, 计数 +1, 用于把
  // 工具调用前后的文字段强制放进不同 stream block. 不依赖 Anthropic SDK
  // 的 content_block_delta.index 是否正确递增.
  textSegmentRev: number
  // 已经触发过 textSegmentRev++ 的 toolUseId 集合, 每个工具只 bump 一次.
  segmentedToolUseIds: Record<string, true>
  // 会话级 todo 列表 (按 sessionId 索引). 不持久化, 切换会话时保留旧 sid 的
  // todo, 刷新页面由 loadTranscript 走 extractTodosFromTranscript 还原.
  todosBySession: Record<string, TodoItem[]>
  setTodos: (sessionId: string, todos: TodoItem[]) => void

  // V2 TaskList 镜像: 与老 TodoWrite 分开存, 因为语义不同 (跨 turn、
  // 会话之间可被查询). key 用 sessionId (来自 tool_use:start.msg.sessionId).
  v2TasksBySession: Record<string, V2TaskItem[]>
  setV2Tasks: (sessionId: string, tasks: V2TaskItem[]) => void
  updateV2Task: (sessionId: string, task: V2TaskItem) => void
  deleteV2Task: (sessionId: string, taskId: string) => void

  // SSE state.* events (Task 10) — 服务端 in-process StateChangeBus
  // 经 stateBridge → eventBus → SSE 推到客户端的 4 类 state.* 事件的
  // per-session 落地. 客户端不再轮询 (Task 12-14 会把 useSessionCwd /
  // useBashBackgroundTasks / useBackgroundTasks 改成读这里).
  cwdBySession: Record<string, string>
  bashTasksBySession: Record<string, BashTaskInfo[]>
  agentTasksBySession: Record<string, BackgroundTaskSummary[]>

  // 每次 sendMessage 递增的发送序号. 拼进 stream block key 作为"本轮命名空间",
  // 保证跨轮次的文本块 key 永不碰撞. 后端 turnIndex 恒为 0 (wrapWithZaiMeta 被
  // 逐事件调用导致其内部计数器每次归零), textSegmentRev 只在工具调用时 bump,
  // blockIndex 每轮新回复都从 0 起 — 三者在"上一轮纯文本回答"的场景下会让
  // 相邻两轮首个文本块拼出同一个 key `0:0:0:text`, 新一轮文本被 append 进上一轮
  // 气泡. sendSeq 提供跨轮唯一性, 根治该归并 bug.
  sendSeq: number

  // SSE reducers (Task 6)
  activeSessionId: string | null
  applyRuntimeEvent: (event: ServerEvent) => void
  applySessionEvent: (event: ServerEvent) => void
  applyPromptAsk: (event: ServerEvent) => void

  // SSE state.* event reducers (Task 10) — 由 useEventStream (Task 11) 在
  // 收到 cwd.changed / bash_task.changed / v2_task.changed /
  // agent_task.changed 时按 type dispatch. 入参虽然是 ServerEvent union 的
  // 具体子类型, 但 reducer 内部对 payload 字段名做 lenient access (兼容
  // server 端 zod schema 的可选/必填差异), 与 eventSource.ts 已有的
  // applyRuntimeEvent pattern 一致.
  applyCwdChanged: (event: { sessionId: string; cwd: string }) => void
  applyBashTaskChanged: (event: { sessionId: string; task: BashTaskInfo }) => void
  applyV2TaskChanged: (event: {
    sessionId: string
    task: V2TaskItem
    action: 'upsert' | 'delete'
  }) => void
  applyAgentTaskChanged: (event: {
    sessionId: string | null
    task: BackgroundTask
  }) => void

  // Compaction toast: 收到 server 推的 runtime.compacted 时, 往 toasts
  // 顶一条 5s 自动消失的信息 (UI 层订阅本字段做顶部提示). 与 useAppStore
  // 的系统级 toast (server.error / 'toast' 事件) 完全独立 — 这里只追踪
  // conversation-level 的 compact 事件, 与 sessionId 绑定, 避免全局 toast
  // 池被会话级噪音污染.
  toasts: CompactionToast[]
  applyCompactionEvent: (event: Extract<ServerEvent, { type: 'runtime.compacted' }>) => void
  dismissCompactionToast: (id: string) => void

  addMessage: (msg: AgentMessage) => void
  upsertToolCall: (msg: AgentMessage) => void
  upsertStreamBlock: (
    kind: 'text' | 'thinking',
    base: AgentMessage,
    delta: string
  ) => void
  setStatus: (status: AgentStatus) => void
  clearMessages: () => void
  loadSessions: () => Promise<void>
  loadTranscript: (sessionId: string) => Promise<void>
  setCurrentSession: (sessionId: string) => void
  createNewSession: () => void
  deleteSession: (sessionId: string) => Promise<void>
  /** Models list synced from /api/agent/settings → models[]. */
  availableModels: ModelEntry[]
  /** Optimistic PATCH /api/agent/sessions/:id + local session model update. */
  patchSessionModel: (sid: string, model: string) => Promise<void>
  /** Optimistic PATCH /api/agent/sessions/:id + local session mode update. */
  patchSessionMode: (sid: string, mode: PermissionMode) => Promise<void>
  sendMessage: (prompt: string) => Promise<void>
  stop: () => Promise<void>
  setAskAnswer: (questionText: string, label: string) => void
  setAskNotes: (questionText: string, notes: string) => void
  submitAsk: () => Promise<void>
  rejectAsk: (reason?: string) => Promise<void>
}

// 把 transcript.messages 还原成 AgentMessage[] (供 React 渲染).
// 设计: 必须与 SSE 流水线 (applyRuntimeEvent) 产出的 AgentMessage 形态等价,
// 使 UI 渲染层 (ToolCallBlock / MessageList 等) 不需要区分"实时流"还是"历史回放".
// 仅处理 v2 协议: msg.message.content 可能是 string (用户纯文本 prompt) 或
// ContentBlock[] (多模态 / 工具结果); 不同 msg.type 走精细分支.
export function loadTranscriptMessages(
  sessionId: string,
  rawMessages: any[],
): AgentMessage[] {
  const out: AgentMessage[] = []
  for (const msg of rawMessages) {
    const baseFields = {
      sessionId,
      ts: msg.timestamp,
      turnIndex: msg.runtime?.turnIndex ?? 0,
    }
    const content = msg.message?.content

    // 字符串 content: 用户在输入框发出的纯文本 prompt.
    if (typeof content === 'string') {
      const text = content
      if (msg.type === 'user') {
        out.push({ ...baseFields, eventId: msg.uuid, type: 'user.text', text })
      } else if (msg.type === 'assistant') {
        out.push({ ...baseFields, eventId: msg.uuid, type: 'assistant.text', text })
      }
      // tool_use / tool_result 等类型不会出现字符串 content, 跳过.
      continue
    }

    if (!Array.isArray(content)) continue
    const blocks = content as Array<Record<string, unknown>>

    if (msg.type === 'tool_use') {
      const b = blocks[0] as { id: string; name: string; input?: Record<string, unknown> }
      out.push({
        ...baseFields,
        eventId: msg.uuid,
        type: 'tool_use:start',
        toolUseId: b.id,
        name: b.name,
        input: b.input,
      })
      continue
    }
    if (msg.type === 'user') {
      // tool_result 块: 把对应 tool_use:start 合并为 done/error.
      const tr = blocks.find((b) => b.type === 'tool_result') as
        | { tool_use_id: string; content: unknown; is_error: boolean }
        | undefined
      if (tr) {
        const idx = out.findIndex((m) => m.toolUseId === tr.tool_use_id)
        if (idx >= 0) {
          out[idx] = {
            ...out[idx],
            type: tr.is_error ? 'tool_use:error' : 'tool_use:done',
            output: tr.content,
            error: tr.is_error ? tr.content : undefined,
          }
        }
        continue
      }
      // 多模态 user 消息 (image / text 块): 提取 text 拼成 user.text,
      // 把 image 块还原成 PendingAttachment (dataURL → objectURL).
      const text = blocks
        .filter((b) => b.type === 'text' && typeof (b as { text?: unknown }).text === 'string')
        .map((b) => (b as { text: string }).text)
        .join('\n')
      const attachments = blocks
        .filter(
          (b) =>
            b.type === 'image' &&
            (b as { source?: { type?: string; media_type?: string; data?: string } }).source?.type === 'base64',
        )
        .map((b, i) => {
          const src = (b as { source: { media_type?: string; data?: string } }).source
          const dataUrl = `data:${src.media_type ?? 'image/png'};base64,${src.data ?? ''}`
          const blob = dataURLtoBlob(dataUrl)
          return {
            localId: `${msg.uuid}-img-${i}`,
            mime: src.media_type ?? 'image/png',
            filename: '[历史图片]',
            thumbnailUrl: blob ? URL.createObjectURL(blob) : dataUrl,
            status: blob ? ('ready' as const) : ('error' as const),
            error: blob ? undefined : '图片已损坏',
          }
        })
      out.push({
        ...baseFields,
        eventId: msg.uuid,
        type: 'user.text',
        text,
        ...(attachments.length ? { attachments } : {}),
      })
      continue
    }
    if (msg.type === 'assistant') {
      for (const b of blocks) {
        if (b.type === 'thinking') {
          out.push({
            ...baseFields,
            eventId: `${msg.uuid}-thinking`,
            type: 'assistant.thinking',
            thinking: b.thinking as string,
          })
        } else if (b.type === 'text') {
          out.push({
            ...baseFields,
            eventId: msg.uuid,
            type: 'assistant.text',
            text: b.text as string,
          })
        } else if (b.type === 'tool_use') {
          // TodoWrite tool_use 不进 messages 流; 它对应的状态由 TodoZone 渲染.
          if ((b.name as string) === 'TodoWrite') continue
          out.push({
            ...baseFields,
            eventId: msg.uuid ?? `tool-${b.id}`,
            type: 'tool_use:start',
            toolUseId: b.id as string,
            name: b.name as string,
            input: b.input as Record<string, unknown>,
          })
        }
      }
    }
  }
  return out
}

// 从 transcript 历史里提取最近一次 TodoWrite 的 todos. 返回 null 表示没找到
// 或解析失败. zai-web 用这个函数在 loadTranscript 末尾回填 todosBySession.
export function extractTodosFromTranscript(
  rawMessages: any[],
): TodoItem[] | null {
  // 倒序找最后一条 assistant message 含 TodoWrite tool_use 块.
  for (let i = rawMessages.length - 1; i >= 0; i--) {
    const msg = rawMessages[i]
    if (!msg || msg.type !== 'assistant') continue
    const content = msg.message?.content
    if (!Array.isArray(content)) continue
    const blocks = content as Array<Record<string, unknown>>
    for (const b of blocks) {
      if (b.type !== 'tool_use') continue
      if ((b.name as string) !== 'TodoWrite') continue
      const input = b.input as { todos?: unknown } | undefined
      const rawTodos = input?.todos
      if (!Array.isArray(rawTodos)) return null
      const parsed: TodoItem[] = []
      for (const raw of rawTodos) {
        if (
          !raw || typeof raw !== 'object' ||
          typeof (raw as { content?: unknown }).content !== 'string' || (raw as { content: string }).content === '' ||
          typeof (raw as { activeForm?: unknown }).activeForm !== 'string' || (raw as { activeForm: string }).activeForm === ''
        ) {
          return null
        }
        const s0 = (raw as { status?: unknown }).status
        if (s0 !== 'pending' && s0 !== 'in_progress' && s0 !== 'completed') {
          return null
        }
        parsed.push({
          content: (raw as { content: string }).content,
          status: s0,
          activeForm: (raw as { activeForm: string }).activeForm,
        })
      }
      return parsed
    }
  }
  return null
}

export const useAgentStore = create<AgentState>((set, get) => ({
  sessionId: null,
  sessions: [],
  availableModels: [],
  cwd: '',
  messages: [],
  status: 'idle',
  abortController: null,
  pendingAsk: null,
  textSegmentRev: 0,
  segmentedToolUseIds: {},
  sendSeq: 0,
  todosBySession: {},
  v2TasksBySession: {},
  // SSE state.* event 缓存 (Task 10): 每个 sessionId 一份, 默认空,
  // 由 applyCwdChanged / applyBashTaskChanged / applyV2TaskChanged /
  // applyAgentTaskChanged 4 个 reducer 写入. 切会话/清屏 时保留旧 sid
  // 的条目, 与 todosBySession / v2TasksBySession 一致 — 用户切回 A 仍
  // 能看到 A 的 bash 任务 / agent 任务历史.
  cwdBySession: {},
  bashTasksBySession: {},
  agentTasksBySession: {},
  // Compaction toast 队列 (Task 14): 收到 server runtime.compacted 时由
  // applyCompactionEvent 推入. UI 端 (未来的 dedupe component) 用 expiresAt
  // (event.timestamp + 5000ms) 自动回收, 而不用 reducer 内部起 setTimeout.
  // 与 useAppStore 的 ToastInfo (server.system toast / server.error) 完全独立,
  // 不混用同一个池.
  toasts: [],
  // 待清空定时器: 每 sessionId 一份, "全部任务完成" 后 5s 自动从 store 移除
  // (避免"全部完成还一直挂着"的 UI 噪音). 重新写入含未完成任务时取消.
  _taskClearTimers: {} as Record<string, ReturnType<typeof setTimeout>>,

  setTodos: (sessionId: string, todos: TodoItem[]) => {
    set((s) => ({
      todosBySession: { ...s.todosBySession, [sessionId]: todos },
    }))
    scheduleTaskListClearIfAllDone(sessionId)
  },

  setV2Tasks: (sessionId, tasks) => {
    set((s) => ({
      v2TasksBySession: { ...s.v2TasksBySession, [sessionId]: tasks },
    }))
    scheduleTaskListClearIfAllDone(sessionId)
  },

  updateV2Task: (sessionId, task) => {
    set((s) => {
      const cur = s.v2TasksBySession[sessionId] ?? []
      const next = cur.some((t) => t.id === task.id)
        ? cur.map((t) => (t.id === task.id ? task : t))
        : [...cur, task]
      return {
        v2TasksBySession: { ...s.v2TasksBySession, [sessionId]: next },
      }
    })
    scheduleTaskListClearIfAllDone(sessionId)
  },

  deleteV2Task: (sessionId, taskId) => {
    set((s) => {
      const cur = s.v2TasksBySession[sessionId] ?? []
      return {
        v2TasksBySession: {
          ...s.v2TasksBySession,
          [sessionId]: cur.filter((t) => t.id !== taskId),
        },
      }
    })
    scheduleTaskListClearIfAllDone(sessionId)
  },

  // SSE reducer state (Task 6)
  activeSessionId: null,

  // Compaction toast reducer (Task 14):
  // 服务端 runtime.compacted 来时往 toasts 顶一条 5s 自动消失的信息. UI
  // 端 (未来的 TopToast / ToastDock 组件) 用 expiresAt = timestamp + 5000
  // 自动回收; reducer 不在这里起 setTimeout, 避免 React 渲染路径之外的
  // 异步写状态导致意外 race.
  //
  // sessionId 防御: brief Step 2 设的契约是 "sessionId 透传". 与
  // applyRuntimeEvent 的 currentSid 防御不一致 — 那里会直接吞错 sid
  // 以保护 messages 流, 但 toast 是会话级而非流级展示, 切到 B 后
  // A 的压缩仍应能弹一条 (用户切回 A 也能看到底栏历史); 这里不做
  // sid 过滤.
  applyCompactionEvent: (event) => {
    set((state) => {
      const saved = Math.max(0, Math.floor(event.savedTokens))
      const newToast: CompactionToast = {
        id: `compacted-${event.timestamp}`,
        text: `对话已压缩 · 节省 ${saved.toLocaleString()} tokens`,
        level: 'info',
        sessionId: event.sessionId,
        expiresAt: event.timestamp + 5000,
      }
      return {
        ...state,
        toasts: [...(state.toasts ?? []), newToast],
      }
    })
  },
  // UI 端可主动 dismiss (例如用户点 ×); reducer 不强制依赖 expiresAt 清理
  // 路径, 两条路并存, 兼容未来需要的"立即清除"交互.
  dismissCompactionToast: (id) => {
    set((state) => ({
      ...state,
      toasts: (state.toasts ?? []).filter((t) => t.id !== id),
    }))
  },

  addMessage: (msg: AgentMessage) =>
    set((s) => ({ messages: [...s.messages, msg] })),
  // 把 tool_use:* 与 content_block_start(tool_use) 合并到同一条消息.
  // 后端 tool_use:done 只带 {toolUseId, output}, name/input 在 start 已经定型,
  // 单纯 append 会得到 "unknown 已完成" 的破损条目. 按 toolUseId upsert 后,
  // 同一个工具的 start → done/error 全程复用一条消息 + 一个 DOM 节点,
  // ToolCallBlock 内部 Collapse 折叠态不丢, React 也不再报 duplicate key.
  //
  // 重要: TodoWrite 的 tool_use (start 阶段) 会主动 *吞掉* 这一帧不写 store,
  // 但 tool_result (done 阶段) 来自 SSE, schema 上 *不* 带 toolName / input —
  // shared/events.ts:27-29. 如果只在消息本身上看 name/input, 守卫在 done
  // 路径永远漏判, TodoWrite 会被当成 unknown 工具渲染 JSON 卡片. 修法:
  // 守卫同时检查 msg.name, 也从 prev (同 toolUseId 已存在的 start entry)
  // 拿 name / input 兜底.
  upsertToolCall: (msg: AgentMessage) =>
    set((s) => {
      const t = msg.type as string
      // 同 toolUseId 的 prev entry: SSE start 阶段已经在 store 里建好了,
      // 由于 TodoWrite start 在守卫被吞掉, prev 在 done 路径上没有 prev,
      // 但 *内容层面* 该条 toolUse 的 TodoWrite 身份仍能从 prev 没有 / 当前
      // 输入中识别 — 守卫先看 msg.name, 拿不到再用 prev.name 做 fallback.
      // (TodoWrite start 同样吞掉不留 prev, 所以此处实际只覆盖 '先有 prev
      // entry' 的旁路场景, 主路径仍是看 msg.name 与 msg.input.)
      const prevEntry = (() => {
        if (!msg.toolUseId) return undefined
        return s.messages.find(
          (m) =>
            (m.type as string).startsWith('tool_use:') &&
            (m.toolUseId as string) === msg.toolUseId,
        )
      })()
      const effectiveName =
        (msg.name as string | undefined) ??
        (prevEntry?.name as string | undefined)
      // TodoWrite 的 tool_use/tool_result 全部不进 messages 流 (按 spec:
      // TodoWrite 不显示 ToolCallBlock, 它的可见状态由 todosBySession 渲染).
      if (effectiveName === 'TodoWrite') {
        // done / error 阶段: 解析 todos 写回 todosBySession. 失败静默忽略.
        // input 既可能来自 msg (手工调用 upsertToolCall), 也可能需要从
        // prev entry 的 input 拿 (SSE done 路径 schema 不携带 input).
        const t2 = t as string
        if (t2 === 'tool_use:done' || t2 === 'tool_use:error') {
          const msgInput = msg.input as { todos?: unknown } | undefined
          const prevInput = prevEntry?.input as { todos?: unknown } | undefined
          const rawTodos = msgInput?.todos ?? prevInput?.todos
          if (Array.isArray(rawTodos)) {
            const parsed: TodoItem[] = []
            let ok = true
            for (const raw of rawTodos) {
              if (
                !raw || typeof raw !== 'object' ||
                typeof (raw as { content?: unknown }).content !== 'string' || (raw as { content: string }).content === '' ||
                typeof (raw as { activeForm?: unknown }).activeForm !== 'string' || (raw as { activeForm: string }).activeForm === ''
              ) {
                ok = false
                break
              }
              const s0 = (raw as { status?: unknown }).status
              if (s0 !== 'pending' && s0 !== 'in_progress' && s0 !== 'completed') {
                ok = false
                break
              }
              parsed.push({
                content: (raw as { content: string }).content,
                status: s0,
                activeForm: (raw as { activeForm: string }).activeForm,
              })
            }
            if (ok) {
              const sid = (msg.sessionId as string | undefined) ?? s.sessionId
              if (sid) {
                return {
                  todosBySession: { ...s.todosBySession, [sid]: parsed },
                }
              }
            }
            // parse 失败: 静默忽略, 不 push messages, 不 bump segment.
            return {}
          }
        }
        // start 阶段 或 parse 后 sid 缺失: 直接吞掉, 不动 messages.
        return {}
      }
      // tool_use:ask_pending → 设置 pendingAsk 状态 (不进入 messages, 由 QuestionCard 独立渲染)
      if (t === 'tool_use:ask_pending') {
        const toolUseId = msg.toolUseId as string
        return {
          pendingAsk: {
            toolUseId,
            questions: (msg.questions as any[]) ?? [],
            ...(msg.metadata ? { metadata: msg.metadata as { source?: string } } : {}),
            status: 'pending',
            answers: {},
            annotations: {},
          },
        }
      }
      const block = msg.content_block as
        | { type?: string; id?: string; name?: string; input?: Record<string, unknown> }
        | undefined
      const toolUseId =
        (t.startsWith('tool_use:') && (msg.toolUseId as string)) ||
        (t === 'content_block_start' && block?.type === 'tool_use' && block.id) ||
        undefined
      if (!toolUseId) {
        return { messages: [...s.messages, msg] }
      }
      // tool_use:done / error / invalid / denied 命中当前 pendingAsk → 清空 pendingAsk 继续往下走 messages upsert
      const shouldClearPending =
        s.pendingAsk &&
        (t === 'tool_use:done' || t === 'tool_use:error' ||
         t === 'tool_use:invalid' || t === 'tool_use:denied') &&
        s.pendingAsk.toolUseId === toolUseId
      // 归一化成 'tool_use:start' 形态, ToolCallBlock 据此识别 status / 显示字段.
      // name 优先取 incoming (start 第一次写), 之后 done/error 不会带 name,
      // 落到 prev 上保留 start 的 name; 同理 input.
      const incomingName =
        (msg.name as string) ||
        (block?.type === 'tool_use' ? block.name : undefined)
      // 用 typeof === 'object' + 非 null 替代 `||`:
      // 关键: server 在 content_block_stop stale 状态时, 会用空字符串当 input
      // 二次 emit runtime.tool_call. `"" || {}` = `{}` (空字符串 falsy,
      // 空对象 truthy), 旧写法会把 prev.input 覆盖成 `{}` 导致 ToolCallBlock
      // 折叠态预览丢失. 显式判对象 + 非空, 拒绝空字符串/null/undefined.
      const msgInputObj = (msg.input !== null && typeof msg.input === 'object' && !Array.isArray(msg.input))
        ? (msg.input as Record<string, unknown>)
        : undefined
      const incomingInput =
        msgInputObj ??
        (block?.type === 'tool_use' ? block.input : undefined)
      // 找任意 tool_use:* 记录 (start/done/error/invalid/denied), 不只匹配
      // 'start'. 否则后端重复发 runtime.tool_call 到达 tool_use:done 之后
      // (例如 SSE 重连后重发, 或 server 在 content_block_stop 之后又来
      // 一次 tool_use:start), idx 会返回 -1 落入新建分支, 残留第二条
      // 'tool_use:start' 与已完成的 done 条目并存 — React 用同一个 key
      // (tool-${toolUseId}) 渲染两条, UI 同时显示"已完成"+"调用中"卡死.
      const idx = s.messages.findIndex(
        (m) =>
          (m.type as string).startsWith('tool_use:') &&
          (m.toolUseId as string) === toolUseId
      )
      // 当前事件是否代表 "新工具边界": tool_use:start 第一次出现,
      // 或者是 Anthropic 提前宣告的 content_block_start(tool_use)。
      // 任何一条命中都触发一次 textSegmentRev++ + 标记 toolUseId 已计入,
      // 下一个 text_delta 落到不同的 key, 渲染层就开新气泡.
      const isToolBoundary =
        t === 'tool_use:start' ||
        (t === 'content_block_start' && block?.type === 'tool_use')
      const shouldBumpSegment =
        isToolBoundary && !s.segmentedToolUseIds[toolUseId]

      // 防御: 新事件是 tool_use:start, 但已有 done/error/invalid/denied 记录,
      // 说明这是一个迟到的重复 call — 直接吞掉, 不要把已完成状态打回"调用中".
      // 仍触发 segmentedToolUseIds 标记 + textSegmentRev bump, 避免文本段粘连,
      // 因为新事件至少意味着"模型重新声明了这个工具边界", 上下文上是真边界.
      if (idx !== -1 && t === 'tool_use:start') {
        const prev = s.messages[idx] as Record<string, unknown>
        const prevType = prev.type as string
        if (prevType !== 'tool_use:start') {
          const updates: Partial<AgentState> = {}
          if (shouldClearPending) updates.pendingAsk = null
          if (shouldBumpSegment) {
            updates.textSegmentRev = s.textSegmentRev + 1
            updates.segmentedToolUseIds = {
              ...s.segmentedToolUseIds,
              [toolUseId]: true,
            }
          }
          return updates
        }
      }

      if (idx === -1) {
        const created: AgentMessage = {
          ...msg,
          eventId: `tool-${toolUseId}`,
          // 初始 type 用 msg.type 而不是硬编码 'tool_use:start': 万一 done/error
          // 先到 (顺序异常), 也要正确建出对应状态的记录, 而不是建一条永远卡
          // 在"调用中"的 start.
          type: (msg.type as string).startsWith('tool_use:') ? msg.type : 'tool_use:start',
          toolUseId,
          name: incomingName || (msg.name as string) || 'unknown',
          // input 同 incomingInput: 优先 incomingInput (已过滤空字符串/数组),
          // 否则用 msg.input (同样过滤), 避免 `||` 把空字符串当 falsy 落到
          // 下一个候选, 最后写到 store 的 input 是 `{}` / 损坏对象.
          input: incomingInput ?? (msgInputObj ?? (msg.input as Record<string, unknown> | undefined) ?? undefined),
          // start 阶段先不带 output / error; done / error 阶段由后续事件填
          output: msg.output,
          error: msg.error,
          reason: msg.reason,
        }
        if (!incomingName && !(msg.name as string | undefined)) {
          // 数据收集: 流式阶段 server 漏传 toolName 的次数 + 上下文 toolUseId,
          // 排查 Bug A (实时流式期间显示 "unknown") 的现场统计.
          if (typeof console !== 'undefined') {
            console.warn('[tool_unknown] runtime.tool_call 漏传 toolName', {
              toolUseId,
              sessionId: msg.sessionId,
              turnIndex: msg.turnIndex,
              ts: msg.ts,
              input: msg.input,
            })
          }
        }
        const updates: Partial<AgentState> = { messages: [...s.messages, created] }
        if (shouldBumpSegment) {
          updates.textSegmentRev = s.textSegmentRev + 1
          updates.segmentedToolUseIds = {
            ...s.segmentedToolUseIds,
            [toolUseId]: true,
          }
        }
        return updates
      }
      // 已存在任意 tool_use:* 条目: 保留 name/input, 更新 type / output / error
      const prev = s.messages[idx] as Record<string, unknown>
      const next = s.messages.slice()
      next[idx] = {
        ...prev,
        // 落到新 type (start / done / error / invalid / denied)
        type: msg.type,
        // 后半段事件携带的输出 / 错误覆盖到 prev; name / input 维持不变
        output: msg.output !== undefined ? msg.output : prev.output,
        error: msg.error !== undefined ? msg.error : prev.error,
        reason: msg.reason !== undefined ? msg.reason : prev.reason,
        name: incomingName || prev.name,
        // 用 `??` 而非 `||`: incomingInput 是 null/undefined 时才回退 prev,
        // 避免空字符串/空对象覆盖已有 input (与 idx===-1 分支同一漏洞).
        input: incomingInput ?? prev.input,
      } as unknown as AgentMessage
      const updates: Partial<AgentState> = { messages: next }
      if (shouldClearPending) updates.pendingAsk = null
      // 安全网: 如果 start 条目早已存在但因为某种原因 segmented 标记缺失
      // (例如服务重启后部分状态恢复), 同样补一次 bump, 避免文段粘连.
      if (shouldBumpSegment) {
        updates.textSegmentRev = s.textSegmentRev + 1
        updates.segmentedToolUseIds = {
          ...s.segmentedToolUseIds,
          [toolUseId]: true,
        }
      }
      return updates
    }),
  // 把 content_block_delta 合并到同一 stream block.
  // 关键 key = `${turnIndex}:${textSegmentRev}:${blockIndex}:${kind}` —
  // - textSegmentRev 由 upsertToolCall 在 tool_use 起点处 +1, 强制把
  //   "工具调用前后的文字段" 落到不同 entry (即使 Anthropic SDK 没正确
  //   递增 content_block_delta.index 也能保证分割).
  // - 同一 turn/segment/block 的 delta 持续 append, 复用同一个 React key,
  //   避免每条 delta 都新开 Card / ThinkingBlock.
  // - kind=text 和 thinking 也互斥, 不会串到同一 entry.
  upsertStreamBlock: (kind, base, delta) =>
    set((s) => {
      const textField = kind === 'thinking' ? 'thinking' : 'text'
      const type = kind === 'thinking' ? 'assistant.thinking' : 'assistant.text'
      const blockIndex = (base as { index?: number }).index ?? 0
      const turnIndex = (base as { turnIndex?: number }).turnIndex ?? 0
      // 工具边界工具启动时已经 bumped, 这里的 s.textSegmentRev 反映
      // "现在属于第几个文字段"; 同段内的 delta 共享同一 key.
      // sendSeq 作为最外层命名空间: 每次 sendMessage 递增一次, 保证
      // 相邻两轮 (尤其上一轮无工具调用时 textSegmentRev/blockIndex 都停在 0)
      // 的文本块 key 不再碰撞, 新一轮文本不会被 append 进上一轮气泡.
      const key = `${s.sendSeq}:${turnIndex}:${s.textSegmentRev}:${blockIndex}:${kind}`
      const idx = s.messages.findIndex((m) => m.eventId === key)
      if (idx === -1) {
        const created: AgentMessage = {
          ...base,
          eventId: key,
          type,
          [textField]: delta,
        }
        return { messages: [...s.messages, created] }
      }
      const prev = s.messages[idx] as Record<string, unknown>
      const next = s.messages.slice()
      next[idx] = {
        ...prev,
        [textField]: ((prev[textField] as string) ?? '') + delta,
      } as AgentMessage
      return { messages: next }
    }),
  setStatus: (status: AgentStatus) => set({ status }),

  clearMessages: () =>
    set((s) => {
      // 仅清空当前 sid 的 todo, 其他 sid 保留以便切回.
      const sid = s.sessionId
      const { [sid as string]: _drop, ...rest } = (s.todosBySession ?? {}) as Record<string, TodoItem[]>
      void _drop
      // v2TasksBySession 与 todosBySession 一致: 切会话/清屏 只清理当前 sid
      const { [sid as string]: _dropV2, ...restV2 } = (s.v2TasksBySession ?? {}) as Record<string, V2TaskItem[]>
      void _dropV2
      return {
        messages: [],
        status: 'idle',
        // 重置 stream block 状态: 切会话/清屏 后, 工具边界计数器也得回到 0,
        // 否则新会话的 text 段会被旧会话遗留的 textSegmentRev 错位归并.
        textSegmentRev: 0,
        segmentedToolUseIds: {},
        sendSeq: 0,
        todosBySession: sid ? rest : s.todosBySession,
        v2TasksBySession: sid ? restV2 : s.v2TasksBySession,
      }
    }),

  loadSessions: async () => {
    try {
      const token = localStorage.getItem('zai-token') || ''
      const [sessionsRes, settingsRes] = await Promise.all([
        fetch('/api/agent/sessions', { headers: { 'X-Zai-Token': token } }),
        fetch('/api/agent/settings').catch(() => null),
      ])
      const data = await sessionsRes.json()
      const sessions = data.sessions ?? []
      let availableModels: ModelEntry[] = []
      if (settingsRes && settingsRes.ok) {
        const settingsData = await settingsRes.json()
        availableModels = Array.isArray(settingsData.models) ? settingsData.models : []
      }
      set({ sessions, availableModels })
      if (sessions.length > 0) {
        // 优先使用 URL ?sid=... 指定的会话, 让刷新/分享链接能落到对应会话上.
        // URL 不带 / 带但 sid 不存在(已删除/换机) → 回退到首条, 并清掉 URL
        // 里的 sid, 避免下次刷新又卡在已死的 sid 上.
        const requested = readUrlSid()
        const target = requested && sessions.some((s: { transcriptId: string }) => s.transcriptId === requested)
          ? sessions.find((s: { transcriptId: string }) => s.transcriptId === requested)
          : undefined
        if (requested && !target) clearUrlSid()
        const picked = target ?? sessions[0]
        set({ sessionId: picked.transcriptId })
        await get().loadTranscript(picked.transcriptId)
      }
    } catch {
      // ignore — list load is best-effort
    }
  },

  setCurrentSession: (sessionId: string) => {
    set({ sessionId, messages: [], textSegmentRev: 0, segmentedToolUseIds: {}, sendSeq: 0 })
    // 同步 URL ?sid=..., 让刷新/分享链接落到同一会话.
    writeUrlSid(sessionId)
  },

  createNewSession: async () => {
    // 立即清空当前 UI 态, 让用户感觉"切到了新会话"
    set((state) => {
      const sid = state.sessionId
      const nextTodos = sid
        ? Object.fromEntries(
            Object.entries(state.todosBySession).filter(([k]) => k !== sid),
          )
        : state.todosBySession
      const nextV2 = sid
        ? Object.fromEntries(
            Object.entries(state.v2TasksBySession).filter(([k]) => k !== sid),
          )
        : state.v2TasksBySession
      // 清掉自动清空 timer (旧 sid 不会再有 completed 任务了)
      const nextTimers = sid
        ? Object.fromEntries(
            Object.entries(state._taskClearTimers).filter(([k]) => k !== sid),
          )
        : state._taskClearTimers
      return {
        sessionId: null,
        activeSessionId: null,
        messages: [],
        status: 'idle',
        textSegmentRev: 0,
        segmentedToolUseIds: {},
        sendSeq: 0,
        todosBySession: nextTodos,
        v2TasksBySession: nextV2,
        _taskClearTimers: nextTimers,
      }
    })
    // 同步在 server 端建一条空 transcript, 让 sidebar 立即多一条
    // '新会话' 占位条目 (而不是等第一条消息发出去才出现).
    try {
      const token = localStorage.getItem('zai-token') || ''
      const res = await fetch('/api/agent/sessions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Zai-Token': token },
        body: JSON.stringify({}),
      })
      if (!res.ok) return
      const data = (await res.json()) as { sessionId: string }
      // 把新 sessionId 设上 + 刷新 sidebar 列表
      set({ sessionId: data.sessionId })
      // 同步 URL ?sid=..., 新建的会话也能刷新/分享出去.
      writeUrlSid(data.sessionId)
      await get().loadSessions()
    } catch {
      // 静默失败: 用户还能继续在本地空态发消息, server 端会按旧路径新建
    }
  },

  deleteSession: async (sessionId: string) => {
    const token = localStorage.getItem('zai-token') || ''
    try {
      const res = await fetch(`/api/agent/sessions/${encodeURIComponent(sessionId)}`, {
        method: 'DELETE',
        headers: { 'X-Zai-Token': token },
      })
      if (!res.ok) return
    } catch {
      return
    }
    const s = get()
    const remaining = s.sessions.filter((x) => x.transcriptId !== sessionId)
    set({ sessions: remaining })
    // 删掉的是当前会话时, 切到剩余里最新的一条; 没有则回到空白新会话.
    if (s.sessionId === sessionId) {
      if (remaining.length > 0) {
        const nextSid = remaining[0].transcriptId
        set({ sessionId: nextSid })
        // 同步 URL: 避免 URL 还指着已删除的 sid, 下次刷新卡死.
        writeUrlSid(nextSid)
        await get().loadTranscript(nextSid)
      } else {
        get().createNewSession()
      }
    }
  },

  patchSessionModel: async (sid, model) => {
    // Snapshot for revert on failure.
    const prev = get().sessions
    // Optimistic local update so the badge switches immediately.
    set({
      sessions: prev.map((x) =>
        x.transcriptId === sid ? { ...x, model } : x,
      ),
    })
    try {
      const token = localStorage.getItem('zai-token') || ''
      const res = await fetch(`/api/agent/sessions/${encodeURIComponent(sid)}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json', 'X-Zai-Token': token },
        body: JSON.stringify({ model }),
      })
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
    } catch {
      // Revert the optimistic update.
      set({ sessions: prev })
    }
  },

  patchSessionMode: async (sid, mode) => {
    // Snapshot for revert on failure.
    const prev = get().sessions
    // Optimistic local update so the badge switches immediately.
    set({
      sessions: prev.map((x) =>
        x.transcriptId === sid ? { ...x, permissionMode: mode } : x,
      ),
    })
    try {
      const token = localStorage.getItem('zai-token') || ''
      const res = await fetch(`/api/agent/sessions/${encodeURIComponent(sid)}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json', 'X-Zai-Token': token },
        body: JSON.stringify({ permissionMode: mode }),
      })
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
    } catch {
      // Revert the optimistic update.
      set({ sessions: prev })
    }
  },

  loadTranscript: async (sessionId: string) => {
    try {
      const token = localStorage.getItem('zai-token') || ''
      const res = await fetch(`/api/agent/sessions/${encodeURIComponent(sessionId)}`, {
        headers: { 'X-Zai-Token': token },
      })
      const data = await res.json()
      const transcript = data.transcript
      if (!transcript) return
      // 把 transcript messages 转换成 AgentMessage 格式 (v2 ContentBlock[] + v1 旧 fallback)
      const messages = loadTranscriptMessages(sessionId, (transcript.messages ?? []) as any[])
      set({
        messages,
        sessionId,
        // transcript 回放没有流式事件, 工具边界计数器无需保留;
        // 重置防止后续 turn 用过期的 textSegmentRev 错位归并.
        textSegmentRev: 0,
        segmentedToolUseIds: {},
        sendSeq: 0,
      })
      // 还原 transcript 中最后一次 TodoWrite 的 todos. 失败静默 — 不清空 store 已有 todo.
      const todos = extractTodosFromTranscript((transcript.messages ?? []) as any[])
      if (todos !== null) {
        set((s) => ({
          todosBySession: { ...s.todosBySession, [sessionId]: todos },
        }))
      }
    } catch {
      // ignore
    }
    // 100% SSE 设计: 不再 fetch /v2-tasks. v2 tasks 由 SSE v2_task.changed
    // 推送,通过 applyV2TaskChanged reducer 维护 v2TasksBySession。冷启动
    // 期间 v2TasksBySession 为空,直到第一个 TaskCreate/TaskUpdate tool_call
    // 触发 SSE 推送。这是有意的 trade-off — 不再用一次性 REST 拉取。
  },

  sendMessage: async (_prompt: string) => {
    // Deleted: sendMessage now lives in Agent.tsx calling /agent/prompt.
    // The SSE stream is consumed by useEventStream -> applyRuntimeEvent.
    throw new Error('sendMessage has been removed; use api.post("/agent/prompt") in Agent.tsx')
  },

  stop: async () => {
    const { abortController } = get()
    abortController?.abort('user_stop')
    set({ status: 'aborted', abortController: null })
    // 透传 sid 给 server: server 端 /agent/abort 现在用 getCurrentSessionId()
    // (来自 queryLoop 的 in-memory state), header 是冗余校验 + 日志/审计的
    // 双重保险. 切了会话后再点 stop 时, in-memory state 可能还没跟上
    // (createNewSession → setCurrentSessionId 之间), header 里 sid 能让 server
    // 校验这就是本会话的 stop 请求, 避免误杀其它正在跑的 turn.
    const sid = get().sessionId
    await fetch('/api/agent/abort', {
      method: 'POST',
      headers: sid ? { 'X-Session-Id': sid } : {},
    })
  },

  setAskAnswer: (questionText, label) => set((s) => {
    if (!s.pendingAsk) return s
    return {
      pendingAsk: {
        ...s.pendingAsk,
        answers: { ...s.pendingAsk.answers, [questionText]: label },
      },
    }
  }),

  setAskNotes: (questionText, notes) => set((s) => {
    if (!s.pendingAsk) return s
    return {
      pendingAsk: {
        ...s.pendingAsk,
        annotations: {
          ...s.pendingAsk.annotations,
          [questionText]: { ...(s.pendingAsk.annotations[questionText] ?? {}), notes },
        },
      },
    }
  }),

  submitAsk: async () => {
    const s = get()
    if (!s.pendingAsk) return
    set({ pendingAsk: { ...s.pendingAsk, status: 'submitting' } })
    try {
      // X-Session-Id 让 server 能校验 pendingAsk 是不是本会话的, 防御
      // "切到 B 后 A 的 ask 还在 pending, 用户在 B 的 QuestionCard 上点
      // submit, A 的 prompt 收到 B 的答案" 这种串号.
      // pendingAsk.sessionId 由 applyPromptAsk 写入, 兜底用 store.sessionId
      // (老 schema 没写, 给旧 transcript 残留的 pendingAsk 留 fallback).
      const askSid = s.pendingAsk.sessionId ?? s.sessionId
      const res = await fetch('/api/agent/answer', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(askSid ? { 'X-Session-Id': askSid } : {}),
        },
        body: JSON.stringify({
          toolUseId: s.pendingAsk.toolUseId,
          answers: s.pendingAsk.answers,
          annotations: s.pendingAsk.annotations,
        }),
      })
      if (res.status === 404) {
        set({ pendingAsk: { ...s.pendingAsk, status: 'error', errorMessage: 'Session 已过期' } })
        return
      }
      if (!res.ok) {
        set({ pendingAsk: { ...s.pendingAsk, status: 'error', errorMessage: `HTTP ${res.status}` } })
        return
      }
      set({ pendingAsk: null })
    } catch (err) {
      set({ pendingAsk: { ...s.pendingAsk, status: 'error', errorMessage: (err as Error).message } })
    }
  },

  rejectAsk: async (reason) => {
    const s = get()
    if (!s.pendingAsk) return
    try {
      const askSid = s.pendingAsk.sessionId ?? s.sessionId
      await fetch('/api/agent/answer/reject', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(askSid ? { 'X-Session-Id': askSid } : {}),
        },
        body: JSON.stringify({ toolUseId: s.pendingAsk.toolUseId, reason }),
      })
    } finally {
      set({ pendingAsk: null })
    }
  },

  // SSE reducers (Task 6)
  applyRuntimeEvent: (event) => {
    if (!('sessionId' in event) || typeof event.sessionId !== 'string') return
    const sid = event.sessionId
    // Task 14 — runtime.compacted: 不经过 currentSid 过滤, 直接推顶部 toast.
    // 原因: 压缩 toast 是会话级"提示", 而非流式事件 — 切到 B 后即使迟到
    // 收到 A 的 compact 事件 (极少, 但 SSE 重连 / 后台压缩排队时可能发生),
    // 用户期望被告知 "刚刚后台压缩了 N tokens". 把它放在 switch 之前保证
    // 不被下面的 defense-in-depth 误吞.
    //
    // 注意: 它仍然要走 applyRuntimeEvent (而不是 useAppStore.applySystemEvent),
    // 因为 toast 形态与 system.toast 不同 (CompactionToast 带 expiresAt +
    // sessionId), 不能借用系统 toast 池.
    if (event.type === 'runtime.compacted') {
      useAgentStore.getState().applyCompactionEvent(event)
      return
    }
    // Defense-in-depth: 后端已经按 sid 过滤 (subscribeScoped), 但切换会话
    // 时旧 sid 的迟到事件可能穿透 (e.g. EventSource 重建有几十 ms 真空期,
    // 旧连接还没 close 时最后一批事件已落地). 这种事件不应该写入当前
    // store 的 messages — 否则切到 B 后还会看到 A 的最后几帧.
    //
    // 兜底动作: 直接丢弃 — transcript 重连后会用 tool_use_id 把 runtime 流
    // 合并回 A 的 messages, 用户切回 A 不会丢. 不写 store.messages 是因为
    // store 是单一数组, 写进去就污染当前视图.
    //
    // 例外: activeSessionId (流式期间标记当前活跃 sid) 不同步更新, 因为
    // 切到 B 后 B 的 runtime.started 会自然覆盖.
    const currentSid = useAgentStore.getState().sessionId
    if (currentSid && sid !== currentSid) return
    // runtime.* 事件全部带 sessionId, 上面的 narrow 已保证它存在.
    // runtime.* 不在 ServerEvent union 之外的 type 才会进入这里.
    switch (event.type) {
      case 'runtime.started': {
        // 标记当前活跃 session + 进入 streaming 态. status 已经是
        // 'idle' 时也会被覆盖成 'streaming'; UI 看到 streaming 后立即
        // 显示流式动画与 elapsed 计时.
        const prevStatus = useAgentStore.getState().status
        if (prevStatus === 'streaming') {
          // SSE 重连: server 重新发 runtime.started, status 仍是 streaming,
          // 属于同一 turn 的延续. 不能 bump textSegmentRev, 否则同一个
          // turn 的 text 会被切到不同 bubble, 用户看到流式回答中段莫名
          // 换气泡 / 重置 markdown.
          useAgentStore.setState({ activeSessionId: sid, status: 'streaming' })
        } else {
          // 新 turn 起点. SubagentNotifier 触发的 sub-agent 续写也走这条:
          // 上一轮已 runtime.done / aborted / error, status 不再 streaming,
          // 续写 turn 的 text_delta 必须落到新 bubble, 不能 append 到上一轮
          // 末尾的 text (否则"等待结果..."和"结果已收到"被拼成一段).
          // 修法: 把 textSegmentRev +1, 让新一轮首个 stream block key 改变,
          // upsertStreamBlock 自然开新 bubble.
          useAgentStore.setState((s) => ({
            activeSessionId: sid,
            status: 'streaming',
            textSegmentRev: s.textSegmentRev + 1,
          }))
        }
        return
      }
      case 'runtime.delta': {
        // 沿用 store 内已有的 upsertStreamBlock. blockIndex 即 sendSeq:
        // 每次 sendMessage 都会递增 sendSeq, 跨轮次文本块 key 永不碰撞;
        // 拼上 turnIndex 即使同一 sendSeq 内出现多轮也保持稳定.
        const sendSeq = useAgentStore.getState().sendSeq
        const base: AgentMessage = {
          eventId: '',
          sessionId: sid,
          ts: event.ts,
          turnIndex: event.turnIndex,
          type: 'assistant.text',
          index: sendSeq,
        }
        useAgentStore.getState().upsertStreamBlock('text', base, event.delta)
        return
      }
      case 'runtime.thinking': {
        // 思考块流式: 复用 upsertStreamBlock('thinking', ...) — 与 text 走
        // 独立 key, 不混淆. base type 留 'assistant.thinking' 标识.
        const sendSeq = useAgentStore.getState().sendSeq
        const base: AgentMessage = {
          eventId: '',
          sessionId: sid,
          ts: event.ts,
          turnIndex: event.turnIndex,
          type: 'assistant.thinking',
          index: sendSeq,
        }
        useAgentStore.getState().upsertStreamBlock('thinking', base, event.thinking)
        return
      }
      case 'runtime.tool_call': {
        // server (translateRuntimeEvents) 把 upstream block.id 填进
        // runtime.tool_call.toolUseId, 这里直接拿来当工具边界 key, 不再合成.
        // 旧的 `tu_runtime_${sid}_${++counter}` 合成路径与 server 发出的
        // runtime.tool_result (用 upstream block.id) 不匹配, upsert 永远
        // 命中不到 start 条目, ToolCallBlock 停在 "调用中" 永远不变.
        const tuId = event.toolUseId
        const startMsg: AgentMessage = {
          eventId: `tool-${tuId}`,
          sessionId: sid,
          ts: event.ts,
          turnIndex: event.turnIndex,
          type: 'tool_use:start',
          toolUseId: tuId,
          name: event.toolName,
          input: event.input as Record<string, unknown>,
        }
        useAgentStore.getState().upsertToolCall(startMsg)
        // V2 TaskList 增量刷新: 100% SSE 设计,不再 fetch /v2-tasks。
        // TaskCreate/TaskUpdate tool_call 触发 server 端 TaskListStore.write,
        // 后者 emit v2_task.changed (Task 4 + Task 8 + Task 11 wiring),前端
        // useEventStream dispatch 调用 applyV2TaskChanged 自动更新 v2TasksBySession。
        return
      }
      case 'runtime.tool_result': {
        // runtime.tool_result schema 携带 toolUseId / toolName / input
        // (2026-07-18 加 toolName/input: 前端 upsertToolCall 守卫要靠这
        // 两个字段识别 TodoWrite — TodoWrite tool_use (start) 在守卫被
        // 吞掉, prev 同 toolUseId 不存在, 必须用本事件自身字段).
        const resultMsg: AgentMessage = {
          eventId: `tool-${event.toolUseId}`,
          sessionId: sid,
          ts: event.ts,
          turnIndex: event.turnIndex,
          type: 'tool_use:done',
          toolUseId: event.toolUseId,
          name: event.toolName,
          input: event.input as Record<string, unknown>,
          output: event.output,
        }
        useAgentStore.getState().upsertToolCall(resultMsg)
        return
      }
      case 'runtime.done':
        useAgentStore.getState().setStatus('idle')
        return
      case 'runtime.aborted':
        useAgentStore.getState().setStatus('aborted')
        return
      case 'runtime.error': {
        // 携带 toolUseId 的 runtime.error 来自 server 把 runtime 的
        // tool_use:error/invalid/denied 翻译过来的事件 — 指向一个具体的
        // 工具, 需要把对应 tool_use:start upsert 成 tool_use:error 让
        // ToolCallBlock 从"调用中"切到"错误". 不携带 toolUseId 的 error
        // 是 turn-level / 引擎级错误 (server agent.ts:471 catch 块发的
        // eventId:'err' 那一类), 仅 setStatus 会让底栏亮"✗ 错误"但中间
        // 对话区看不到任何错误详情. 也要把完整 error 写入 messages,
        // 让 Agent.tsx:888 的 MessageBubble 渲染分支 (红色 Card +
        // error.message + error.category) 命中, 错误才能被用户看到.
        const toolUseId = (event as { toolUseId?: unknown }).toolUseId
        if (typeof toolUseId === 'string' && toolUseId) {
          useAgentStore.getState().upsertToolCall({
            eventId: `err-${toolUseId}`,
            sessionId: sid,
            ts: event.ts,
            turnIndex: event.turnIndex,
            type: 'tool_use:error',
            toolUseId,
            error: event.error.message,
          })
        } else {
          useAgentStore.setState((s) => ({
            messages: [
              ...s.messages,
              {
                eventId: event.eventId,
                sessionId: sid,
                ts: event.ts,
                turnIndex: event.turnIndex,
                type: 'runtime.error',
                error: event.error,
              },
            ],
          }))
        }
        useAgentStore.getState().setStatus('error')
        return
      }
      default:
        return
    }
  },
  applySessionEvent: (event) => set((state) => {
    if (!('sessionId' in event) || typeof event.sessionId !== 'string') return state
    const sid = event.sessionId
    switch (event.type) {
      case 'session.created': {
        // state.sessions 实际是 Array<{ transcriptId, title?, updatedAt }>
        // (loadSessions 从 /api/agent/sessions 拿到的就是数组, sidebar 用
        // s.transcriptId 渲染). 老代码当 Record 处理, sessions[sid] 完全
        // 不工作, 静默吞掉 server 来的 session.created. 改成 unshift 进数组.
        const list = state.sessions as Array<{ transcriptId: string; title?: string; updatedAt: number; permissionMode?: PermissionMode }>
        if (list.some((x) => x.transcriptId === sid)) return state
        return {
          ...state,
          sessions: [{ transcriptId: sid, title: event.title, updatedAt: Date.now() }, ...list],
        }
      }
      case 'session.deleted': {
        const list = state.sessions as Array<{ transcriptId: string; title?: string; updatedAt: number; permissionMode?: PermissionMode }>
        return { ...state, sessions: list.filter((x) => x.transcriptId !== sid) }
      }
      case 'session.renamed': {
        // 跟 session.created 同样的根因: 老代码 sessions[sid] 在 Array 上
        // 永远 undefined, case 静默早退, server SSE 来的 session.renamed
        // 被丢掉 — 这就是"刷新页面才生效"的根因. 改成按 transcriptId 查找.
        const list = state.sessions as Array<{ transcriptId: string; title?: string; updatedAt: number }>
        const idx = list.findIndex((x) => x.transcriptId === sid)
        if (idx === -1) return state
        const next = list.slice()
        next[idx] = { ...list[idx], title: event.title }
        return { ...state, sessions: next }
      }
      default:
        return state
    }
  }),
  applyPromptAsk: (event) => set((state) => {
    if (event.type !== 'prompt.ask') return state
    // 必须初始化 status / answers / annotations: QuestionCard 拿到 pendingAsk
    // 后, `questions.every((q) => answers[q.question])` 立刻读 answers, 缺
    // 字段直接抛 TypeError → 组件崩溃 → 用户看到 "卡片不渲染". 旧实现
    // 只填了 sessionId/toolUseId/questions, 隐式 undefined 把组件搞挂.
    return {
      ...state,
      pendingAsk: {
        sessionId: event.sessionId,
        toolUseId: event.toolUseId,
        questions: event.questions,
        status: 'pending',
        answers: {},
        annotations: {},
      },
    }
  }),

  // ── SSE state.* event reducers (Task 10) ───────────────────────────
  // 由 useEventStream (Task 11) 在收到 state.* ServerEvent 时按 type
  // dispatch. 入参虽然是 ServerEvent union 的具体子类型, 但 reducer
  // 内部对 payload 字段名做 lenient access (兼容 server 端 zod schema
  // 的可选/必填差异), 与 eventSource.ts 已有的 applyRuntimeEvent
  // pattern 一致.

  applyCwdChanged: (event) => {
    set((s) => ({
      cwdBySession: { ...s.cwdBySession, [event.sessionId]: event.cwd },
    }))
  },

  applyBashTaskChanged: (event) => {
    set((s) => {
      const list = s.bashTasksBySession[event.sessionId] ?? []
      let next: BashTaskInfo[]
      // 终态 (completed / failed / killed) → 删掉旧的 running entry
      // (同 taskId), 把终态条目 prepend 到列表顶部. 这样 UI 端
      // TaskDock 立即显示"已完成"而不是"运行中 30 分钟".
      // 注: BashTaskStatus 实际取值是 'running' / 'completed' /
      // 'failed' / 'killed' (lib/taskApi.ts), 终态 ≠ 'running'.
      if (event.task.status !== 'running') {
        next = [
          event.task,
          ...list.filter((t) => t.taskId !== event.task.taskId),
        ]
      } else {
        // running → 同一 taskId 的旧 entry 直接替换 (status delta);
        // 新的 taskId prepend 到列表顶部.
        const idx = list.findIndex((t) => t.taskId === event.task.taskId)
        next =
          idx >= 0
            ? list.map((t) => (t.taskId === event.task.taskId ? event.task : t))
            : [event.task, ...list]
      }
      return {
        bashTasksBySession: { ...s.bashTasksBySession, [event.sessionId]: next },
      }
    })
  },

  applyV2TaskChanged: (event) => {
    set((s) => {
      const list = s.v2TasksBySession[event.sessionId] ?? []
      // action='delete' → 按 task.id 过滤掉; action='upsert' →
      // 已存在则替换, 不存在则 append. V2 task 与 BashTask 不同,
      // 没有"终态替换运行中"的概念 — TaskList 是 CRUD 模型, status
      // 在 v2_task.changed 里通过 upsert 携带新 status 来更新.
      const next =
        event.action === 'delete'
          ? list.filter((t) => t.id !== event.task.id)
          : (() => {
              const idx = list.findIndex((t) => t.id === event.task.id)
              if (idx >= 0) return list.map((t) => (t.id === event.task.id ? event.task : t))
              return [...list, event.task]
            })()
      return {
        v2TasksBySession: { ...s.v2TasksBySession, [event.sessionId]: next },
      }
    })
  },

  applyAgentTaskChanged: (event) => {
    // agent_task.changed.sessionId 可能为 null: cli 派发 (非 agent_task)
    // 或老数据没有 parentSessionId. 这种任务不归属任何 session, dock
    // 不展示, 这里直接 no-op 落掉.
    if (event.sessionId === null) return
    const sid = event.sessionId
    set((s) => {
      const list = s.agentTasksBySession[sid] ?? []
      // 把后端 BackgroundTask 转换成 dock 用的 BackgroundTaskSummary.
      // prompt 走 event.task.input.prompt (cli 派发时由 LLM 在 input
      // 里塞入, 与 BackgroundTask.input schema 一致).
      const summary: BackgroundTaskSummary = {
        taskId: event.task.id,
        status: event.task.status,
        prompt: event.task.input.prompt,
        createdAt: event.task.createdAt,
        finishedAt: event.task.finishedAt,
        error: event.task.error?.message,
        detail: event.task,
        lastKnownSessionId: sid,
      }
      // 已存在 → 替换; 不存在 → prepend (新派发的 task 排在顶部).
      const idx = list.findIndex((t) => t.taskId === event.task.id)
      const next =
        idx >= 0
          ? list.map((t) => (t.taskId === event.task.id ? summary : t))
          : [summary, ...list]
      return {
        agentTasksBySession: { ...s.agentTasksBySession, [sid]: next },
      }
    })
  },
}))

/**
 * 自动清理 helper: 当某个 sessionId 的 todos + v2 tasks 全部 completed /
 * deleted, 5 秒后从 store 里把对应的 todosBySession[sid] + v2TasksBySession[sid]
 * 一起清掉. 中途重新写入含未完成任务则取消定时器.
 *
 * 设计: 不依赖 React 组件挂载, 直接用模块级 setTimeout + 写入 store.
 * - 使用 getState() 拿到最新值, 不需要通过 set 闭包传递
 * - 重复调用时若 sid 的清除定时器已存在, 先 clear 再调度 (debounce)
 * - hasUnfinished 决定是否调度: 全部完成 → 调度; 任意未完成 → 取消
 */
const TASK_CLEAR_DELAY_MS = 5_000
function scheduleTaskListClearIfAllDone(sessionId: string): void {
  const s = useAgentStore.getState()
  const todos = s.todosBySession[sessionId] ?? []
  const v2 = s.v2TasksBySession[sessionId] ?? []
  // 没任务 → 取消已有定时器
  if (todos.length === 0 && v2.length === 0) {
    if (s._taskClearTimers[sessionId]) {
      clearTimeout(s._taskClearTimers[sessionId])
      useAgentStore.setState((cur) => {
        const { [sessionId]: _, ...rest } = cur._taskClearTimers
        void _
        return { _taskClearTimers: rest }
      })
    }
    return
  }
  // todo 的 completed 是终态; v2 的 completed + deleted 都是终态
  const hasUnfinished =
    todos.some((t) => t.status !== 'completed') ||
    v2.some((t) => t.status !== 'completed' && t.status !== 'deleted')
  if (hasUnfinished) {
    if (s._taskClearTimers[sessionId]) {
      clearTimeout(s._taskClearTimers[sessionId])
      useAgentStore.setState((cur) => {
        const { [sessionId]: _, ...rest } = cur._taskClearTimers
        void _
        return { _taskClearTimers: rest }
      })
    }
    return
  }
  // 全部终态 → 调度 (或刷新) 5s 后清空
  if (s._taskClearTimers[sessionId]) clearTimeout(s._taskClearTimers[sessionId])
  const timer = setTimeout(() => {
    useAgentStore.setState((cur) => {
      const { [sessionId]: _, ...restTodos } = cur.todosBySession
      const { [sessionId]: __, ...restV2 } = cur.v2TasksBySession
      const { [sessionId]: ___, ...restTimers } = cur._taskClearTimers
      void _; void __; void ___
      return {
        todosBySession: restTodos,
        v2TasksBySession: restV2,
        _taskClearTimers: restTimers,
      }
    })
  }, TASK_CLEAR_DELAY_MS)
  useAgentStore.setState((cur) => ({
    _taskClearTimers: { ...cur._taskClearTimers, [sessionId]: timer },
  }))
}
