import { create } from 'zustand'
import { flushSync } from 'react-dom'
import type { ServerEvent } from '../../../../shared/events.js'

// 把 dataURL (data:<mime>;base64,<...>) 解码成 Blob, 用于把历史图片
// 消息里的 base64 还原成浏览器可显示的 objectURL. 解析失败时返回
// null, 调用方回退到 raw dataURL 并把 status 标为 error.
function dataURLtoBlob(dataUrl: string): Blob | null {
  const m = dataUrl.match(/^data:([^;]+);base64,(.+)$/)
  if (!m) return null
  const mime = m[1]!
  const bin = atob(m[2]!)
  const arr = new Uint8Array(bin.length)
  for (let i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i)
  return new Blob([arr], { type: mime })
}

// Runtime 工具调用 id 计数器: 每个 runtime.tool_call 递增一次, 给
// 没有自带 toolUseId 的 upstream runtime 事件合成一个稳定 id, 让
// 后续 runtime.tool_result 能通过 toolUseId 与之对齐. 模块级别常量
// 而非 store 字段, 因为它不需要被 UI 渲染或读取, 仅作为 reducer
// 内部状态.
let runtimeToolCounter = 0

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

interface AgentState {
  sessionId: string | null
  sessions: Array<{ transcriptId: string; title?: string; updatedAt: number }>
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

  setCwd: (cwd: string) => void
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
  sendMessage: (prompt: string, cwd?: string) => Promise<void>
  stop: () => Promise<void>
  setAskAnswer: (questionText: string, label: string) => void
  setAskNotes: (questionText: string, notes: string) => void
  submitAsk: () => Promise<void>
  rejectAsk: (reason?: string) => Promise<void>
}

export const useAgentStore = create<AgentState>((set, get) => ({
  sessionId: null,
  sessions: [],
  cwd: '',
  messages: [],
  status: 'idle',
  abortController: null,
  pendingAsk: null,
  textSegmentRev: 0,
  segmentedToolUseIds: {},
  sendSeq: 0,

  // SSE reducer state (Task 6)
  activeSessionId: null,

  setCwd: (cwd: string) => set({ cwd }),
  addMessage: (msg: AgentMessage) =>
    set((s) => ({ messages: [...s.messages, msg] })),
  // 把 tool_use:* 与 content_block_start(tool_use) 合并到同一条消息.
  // 后端 tool_use:done 只带 {toolUseId, output}, name/input 在 start 已经定型,
  // 单纯 append 会得到 "unknown 已完成" 的破损条目. 按 toolUseId upsert 后,
  // 同一个工具的 start → done/error 全程复用一条消息 + 一个 DOM 节点,
  // ToolCallBlock 内部 Collapse 折叠态不丢, React 也不再报 duplicate key.
  upsertToolCall: (msg: AgentMessage) =>
    set((s) => {
      const t = msg.type as string
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
      const incomingInput =
        (msg.input as Record<string, unknown>) ||
        (block?.type === 'tool_use' ? block.input : undefined)
      const idx = s.messages.findIndex(
        (m) =>
          (m.type as string) === 'tool_use:start' &&
          (m.toolUseId as string) === toolUseId
      )
      // 当前事件是否代表 "新工具边界": tool_use:start 第一次出现,
      // 或者是 Anthropic 提前宣告的 content_block_start(tool_use).
      // 任何一条命中都触发一次 textSegmentRev++ + 标记 toolUseId 已计入,
      // 下一个 text_delta 落到不同的 key, 渲染层就开新气泡.
      const isToolBoundary =
        t === 'tool_use:start' ||
        (t === 'content_block_start' && block?.type === 'tool_use')
      const shouldBumpSegment =
        isToolBoundary && !s.segmentedToolUseIds[toolUseId]

      if (idx === -1) {
        const created: AgentMessage = {
          ...msg,
          eventId: `tool-${toolUseId}`,
          type: 'tool_use:start',
          toolUseId,
          name: incomingName || (msg.name as string) || 'unknown',
          input: incomingInput || (msg.input as Record<string, unknown>),
          // start 阶段先不带 output / error; done / error 阶段由后续事件填
          output: msg.output,
          error: msg.error,
          reason: msg.reason,
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
      // 已存在 start 条目: 保留 name/input, 更新 type / output / error
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
        input: incomingInput || prev.input,
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
    set({
      messages: [],
      status: 'idle',
      // 重置 stream block 状态: 切会话/清屏 后, 工具边界计数器也得回到 0,
      // 否则新会话的 text 段会被旧会话遗留的 textSegmentRev 错位归并.
      textSegmentRev: 0,
      segmentedToolUseIds: {},
      sendSeq: 0,
    }),

  loadSessions: async () => {
    try {
      const token = localStorage.getItem('zai-token') || ''
      const res = await fetch('/api/agent/sessions', {
        headers: { 'X-Zai-Token': token },
      })
      const data = await res.json()
      const sessions = data.sessions ?? []
      set({ sessions })
      if (sessions.length > 0) {
        set({ sessionId: sessions[0].transcriptId })
        await get().loadTranscript(sessions[0].transcriptId)
      }
    } catch {
      // ignore
    }
  },

  setCurrentSession: (sessionId: string) => {
    set({ sessionId, messages: [], textSegmentRev: 0, segmentedToolUseIds: {}, sendSeq: 0 })
  },

  createNewSession: () => {
    set({
      sessionId: null,
      messages: [],
      status: 'idle',
      textSegmentRev: 0,
      segmentedToolUseIds: {},
      sendSeq: 0,
    })
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
        set({ sessionId: remaining[0].transcriptId })
        await get().loadTranscript(remaining[0].transcriptId)
      } else {
        get().createNewSession()
      }
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
      // 把 transcript messages 转换成 AgentMessage 格式
      const messages: AgentMessage[] = []
      for (const msg of (transcript.messages ?? []) as any[]) {
        // user 类型 raw = { content: string }
        // assistant 类型 raw = { text: string, thinking?: string, tool_uses: [...] }
        const rawObj = (msg.raw ?? {}) as Record<string, unknown>
        const text = typeof rawObj.text === 'string'
          ? rawObj.text
          : typeof rawObj.content === 'string'
            ? rawObj.content
            : ''
        const baseFields = {
          sessionId,
          ts: msg.timestamp,
          turnIndex: msg.runtime?.turnIndex ?? 0,
        }
        if (msg.type === 'user') {
          // SkillTool 注入的 skill body 在 transcript 里以 user message 形态保存
          // (kind:'skill_injection'), 供后续 turn 的 LLM 上下文使用. 但 UI 上
          // 它属于工具侧产物, 不应当被渲染成 user.text 卡片 — 否则刷新页面后
          // 用户看到 "skill 文字输出变成了我发出的消息".
          if (rawObj.kind === 'skill_injection') continue
          if (Array.isArray(rawObj.content)) {
            // ContentBlock[] (可能含 image) — 还原 text 拼接 + 重建 attachments
            const blocks = rawObj.content as Array<{
              type: string
              source?: { type?: string; media_type?: string; data?: string }
              text?: string
            }>
            const textFromBlocks = blocks
              .filter((b) => b.type === 'text' && typeof b.text === 'string')
              .map((b) => b.text!)
              .join('\n')
            const restoredAttachments = blocks
              .filter((b) => b.type === 'image' && b.source?.type === 'base64')
              .map((b, i) => {
                const dataUrl = `data:${b.source!.media_type};base64,${b.source!.data}`
                const blob = dataURLtoBlob(dataUrl)
                const thumbnailUrl = blob ? URL.createObjectURL(blob) : dataUrl
                return {
                  localId: `${msg.uuid}-img-${i}`,
                  mime: b.source!.media_type ?? 'image/png',
                  filename: '[历史图片]',
                  thumbnailUrl,
                  status: blob ? ('ready' as const) : ('error' as const),
                  error: blob ? undefined : '图片已损坏',
                }
              })
            messages.push({
              ...baseFields,
              eventId: msg.uuid,
              type: 'user.text',
              text: textFromBlocks,
              ...(restoredAttachments.length ? { attachments: restoredAttachments } : {}),
            })
          } else {
            messages.push({ ...baseFields, eventId: msg.uuid, type: 'user.text', text })
          }
        } else if (msg.type === 'assistant') {
          // 先 emit thinking 块（若有），再 emit 文本块，让折叠面板显示在 response 上方
          const thinking = typeof rawObj.thinking === 'string' ? rawObj.thinking : ''
          if (thinking) {
            messages.push({
              ...baseFields,
              eventId: `${msg.uuid}-thinking`,
              type: 'assistant.thinking',
              thinking,
            })
          }
          messages.push({ ...baseFields, eventId: msg.uuid, type: 'assistant.text', text })
        } else {
          messages.push({ ...baseFields, eventId: msg.uuid, type: `runtime.${msg.type}`, text })
        }
      }
      set({
        messages,
        sessionId,
        // transcript 回放没有流式事件, 工具边界计数器无需保留;
        // 重置防止后续 turn 用过期的 textSegmentRev 错位归并.
        textSegmentRev: 0,
        segmentedToolUseIds: {},
        sendSeq: 0,
      })
    } catch {
      // ignore
    }
  },

  sendMessage: async (_prompt: string, _cwd?: string) => {
    // Deleted: sendMessage now lives in Agent.tsx calling /agent/prompt.
    // The SSE stream is consumed by useEventStream -> applyRuntimeEvent.
    throw new Error('sendMessage has been removed; use api.post("/agent/prompt") in Agent.tsx')
  },

  stop: async () => {
    const { abortController } = get()
    abortController?.abort('user_stop')
    set({ status: 'aborted', abortController: null })
    await fetch('/api/agent/abort', { method: 'POST' })
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
      const res = await fetch('/api/agent/answer', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
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
      await fetch('/api/agent/answer/reject', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
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
    // runtime.* 事件全部带 sessionId, 上面的 narrow 已保证它存在.
    // runtime.* 不在 ServerEvent union 之外的 type 才会进入这里.
    switch (event.type) {
      case 'runtime.started':
        // 标记当前活跃 session + 进入 streaming 态. status 已经是
        // 'idle' 时也会被覆盖成 'streaming'; UI 看到 streaming 后立即
        // 显示流式动画与 elapsed 计时.
        useAgentStore.setState({ activeSessionId: sid, status: 'streaming' })
        return
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
      case 'runtime.tool_call': {
        // runtime.tool_call schema 不带 toolUseId, 但 upsertToolCall
        // 按 toolUseId upsert 合并 start→done/error, 必须生成稳定 id.
        // 用 session 内顺序计数器 + ts 拼一个足够唯一的 id. 同步记录到
        // pendingToolResults[sid], 让后续无 toolUseId 的 result 能找到
        // 对应 start. 注意 result 实际是带 toolUseId 的, 这里匹配只是
        // 兜底.
        const tuId = `tu_runtime_${sid}_${++runtimeToolCounter}`
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
        return
      }
      case 'runtime.tool_result': {
        // runtime.tool_result schema 携带 toolUseId, 直接复用.
        const resultMsg: AgentMessage = {
          eventId: `tool-${event.toolUseId}`,
          sessionId: sid,
          ts: event.ts,
          turnIndex: event.turnIndex,
          type: 'tool_use:done',
          toolUseId: event.toolUseId,
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
      case 'runtime.error':
        useAgentStore.getState().setStatus('error')
        return
      default:
        return
    }
  },
  applySessionEvent: (event) => set((state) => {
    if (!('sessionId' in event) || typeof event.sessionId !== 'string') return state
    const sid = event.sessionId
    switch (event.type) {
      case 'session.created': {
        const sessions = { ...state.sessions as Record<string, { sessionId: string; title: string; cwd: string }> }
        sessions[sid] = { sessionId: sid, title: event.title, cwd: event.cwd }
        return { ...state, sessions }
      }
      case 'session.deleted': {
        const sessions = { ...state.sessions as Record<string, { sessionId: string; title: string; cwd: string }> }
        delete sessions[sid]
        return { ...state, sessions }
      }
      case 'session.renamed': {
        const existing = (state.sessions as Record<string, { sessionId: string; title: string; cwd: string }>)[sid]
        if (!existing) return state
        return { ...state, sessions: { ...state.sessions as Record<string, { sessionId: string; title: string; cwd: string }>, [sid]: { ...existing, title: event.title } } }
      }
      default:
        return state
    }
  }),
  applyPromptAsk: (event) => set((state) => {
    if (event.type !== 'prompt.ask') return state
    return {
      ...state,
      pendingAsk: {
        sessionId: event.sessionId,
        toolUseId: event.toolUseId,
        questions: event.questions,
      },
    }
  }),
}))
