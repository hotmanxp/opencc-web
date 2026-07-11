import { create } from 'zustand'
import { flushSync } from 'react-dom'
import type { RuntimeEvent } from '../lib/sseAgent'
import { runAgentStream, abortAgent } from '../lib/sseAgent'

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
      const key = `${turnIndex}:${s.textSegmentRev}:${blockIndex}:${kind}`
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
    set({ sessionId, messages: [], textSegmentRev: 0, segmentedToolUseIds: {} })
  },

  createNewSession: () => {
    set({
      sessionId: null,
      messages: [],
      status: 'idle',
      textSegmentRev: 0,
      segmentedToolUseIds: {},
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
          messages.push({ ...baseFields, eventId: msg.uuid, type: 'user.text', text })
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
      })
    } catch {
      // ignore
    }
  },

  sendMessage: async (prompt: string, cwd?: string) => {
    const abortController = new AbortController()
    // 先把用户消息放进 store,前端立即看到自己发出去的内容
    const userMsg: AgentMessage = {
      eventId: `user-${Date.now()}`,
      sessionId: '',
      ts: Date.now(),
      turnIndex: 0,
      type: 'user.text',
      text: prompt,
    }
    set((s) => ({
      status: 'streaming',
      abortController,
      messages: [...s.messages, userMsg],
    }))

    await runAgentStream({
      prompt,
      cwd: cwd || get().cwd || undefined,
      sessionId: get().sessionId ?? undefined,
      signal: abortController.signal,
      onEvent: (event: RuntimeEvent) => {
        const state = get()
        // === TEMP DIAGNOSTIC: 跟踪事件流, 排查 message 归并 bug ===
        // eslint-disable-next-line no-console
        console.log('[zai-diag] event', {
          type: event.type,
          turnIndex: event.turnIndex,
          toolUseId: event.toolUseId,
          blockIndex: (event as any).index,
          content_block: event.content_block,
          textSegmentRev_before: state.textSegmentRev,
          msgCount: state.messages.length,
        })
        // 首次收到事件时记录 sessionId,并刷新侧栏 title
        if (!state.sessionId && event.sessionId) {
          set({ sessionId: event.sessionId })
          void state.loadSessions()
        }

        // content_block_delta 走 upsert 合并: 同一 stream block 复用同一 eventId
        // 持续追加, 避免每条 delta 都新开气泡 / 折叠块.
        // key 由 store 内部按 `${turnIndex}:${textSegmentRev}:${blockIndex}:${kind}`
        // 拼出 — textSegmentRev 由 upsertToolCall 在工具起点 bump, 保证
        // 工具前后的文字段落到不同 entry.
        // 用 flushSync 强制同步提交, 否则 React 18 会把同一 microtask 内的
        // 多次 set() 合并成一次渲染, 用户看到的就是"原子出现"而非逐字流出.
        if (event.type === 'content_block_delta') {
          const delta = event.delta as
            | { type?: string; text?: string; thinking?: string }
            | undefined
          const base: AgentMessage = {
            ...event,
            eventId: '', // upsertStreamBlock 会覆盖
          }
          flushSync(() => {
            if (delta?.type === 'thinking_delta') {
              state.upsertStreamBlock('thinking', base, delta.thinking || '')
            } else {
              state.upsertStreamBlock('text', base, delta?.text || '')
            }
          })
          // eslint-disable-next-line no-console
          console.log('[zai-diag] after text_delta', {
            msgCount: get().messages.length,
            textSegmentRev: get().textSegmentRev,
            lastTextSnippet: String(get().messages.findLast?.((m) => m.type === 'assistant.text')?.text ?? '').slice(-40),
          })
          return
        }

        // tool_use:* 与 modelCaller 提前宣告的 content_block_start(tool_use)
        // 走 upsertToolCall: 按 toolUseId 复用同一条消息, 保留 start 阶段的
        // name/input, done/error 阶段只覆盖 output/error/reason + type.
        // 这样渲染时同一工具只有一个 ToolCallBlock, 不会因为 done 不带 name
        // 而冒出 "unknown 已完成" 的破损条目.
        const t = event.type as string
        const block = event.content_block as
          | { type?: string; id?: string }
          | undefined
        const isToolFlow =
          t === 'tool_use:start' ||
          t === 'tool_use:done' ||
          t === 'tool_use:error' ||
          t === 'tool_use:invalid' ||
          t === 'tool_use:denied' ||
          t === 'tool_use:ask_pending' ||
          (t === 'content_block_start' && block?.type === 'tool_use')
        if (isToolFlow) {
          state.upsertToolCall(event)
          // eslint-disable-next-line no-console
          console.log('[zai-diag] after tool_event', {
            type: t,
            textSegmentRev: get().textSegmentRev,
            msgCount: get().messages.length,
          })
          return
        }

        state.addMessage(event)

        if (event.type === 'runtime.error') {
          set({ status: 'error' })
        }
      },
      onEnd: () => {
        const state = get()
        if (state.status === 'streaming') {
          set({ status: 'idle', abortController: null })
        }
      },
    })
  },

  stop: async () => {
    const { abortController } = get()
    abortController?.abort('user_stop')
    set({ status: 'aborted', abortController: null })
    await abortAgent()
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
}))
