import { beforeEach, describe, expect, test } from 'vitest'
import { useAgentStore } from './useAgentStore.js'

beforeEach(() => {
  useAgentStore.setState({
    activeSessionId: null,
    messages: [],
    sendSeq: 0,
    status: 'idle',
    pendingAsk: null,
  })
})

describe('useAgentStore.applyRuntimeEvent', () => {
  test('runtime.started activates session and sets status to streaming', () => {
    useAgentStore.getState().applyRuntimeEvent({
      type: 'runtime.started',
      eventId: 'e1', ts: 1, sessionId: 's1', turnIndex: 0,
    })
    expect(useAgentStore.getState().activeSessionId).toBe('s1')
    expect(useAgentStore.getState().status).toBe('streaming')
  })

  test('runtime.delta appends to an assistant.text message via upsertStreamBlock', () => {
    useAgentStore.getState().applyRuntimeEvent({
      type: 'runtime.delta',
      eventId: 'e1', ts: 1, sessionId: 's1', turnIndex: 0, delta: 'hello',
    })
    useAgentStore.getState().applyRuntimeEvent({
      type: 'runtime.delta',
      eventId: 'e2', ts: 2, sessionId: 's1', turnIndex: 0, delta: ' world',
    })
    const msgs = useAgentStore.getState().messages
    // 同 sendSeq + turnIndex + blockIndex 命中同一 stream block, 二次 delta append 追加
    const textMsgs = msgs.filter((m) => m.type === 'assistant.text')
    expect(textMsgs.length).toBe(1)
    expect(textMsgs[0].text).toBe('hello world')
  })

  test('runtime.tool_call stores a tool_use:start message', () => {
    useAgentStore.getState().applyRuntimeEvent({
      type: 'runtime.tool_call',
      eventId: 'e1', ts: 1, sessionId: 's1', turnIndex: 0,
      toolUseId: 'toolu_abc', toolName: 'bash', input: { cmd: 'ls' },
    })
    const msgs = useAgentStore.getState().messages
    const toolMsgs = msgs.filter((m) => m.type === 'tool_use:start')
    expect(toolMsgs.length).toBe(1)
    expect(toolMsgs[0].name).toBe('bash')
    expect(toolMsgs[0].input).toEqual({ cmd: 'ls' })
    // toolUseId 直接用 server 给的 id, 不再合成. 这是修复的核心契约:
    // runtime.tool_call 与 runtime.tool_result 共用同一 id, upsert 才能命中.
    expect(toolMsgs[0].toolUseId).toBe('toolu_abc')
  })

  test('runtime.tool_result upserts the matching tool_use with output', () => {
    useAgentStore.getState().applyRuntimeEvent({
      type: 'runtime.tool_call',
      eventId: 'e1', ts: 1, sessionId: 's1', turnIndex: 0,
      toolUseId: 'toolu_abc', toolName: 'bash', input: { cmd: 'ls' },
    })
    useAgentStore.getState().applyRuntimeEvent({
      type: 'runtime.tool_result',
      eventId: 'e2', ts: 2, sessionId: 's1', turnIndex: 0,
      toolUseId: 'toolu_abc',
      output: 'file.txt',
    })
    const finalTool = useAgentStore.getState().messages.find(
      (m) => m.toolUseId === 'toolu_abc',
    )
    expect(finalTool?.type).toBe('tool_use:done')
    expect(finalTool?.output).toBe('file.txt')
  })

  test('runtime.done sets status to idle', () => {
    useAgentStore.getState().applyRuntimeEvent({
      type: 'runtime.done',
      eventId: 'e1', ts: 1, sessionId: 's1', turnIndex: 0,
    })
    expect(useAgentStore.getState().status).toBe('idle')
  })

  test('runtime.aborted sets status to aborted', () => {
    useAgentStore.getState().applyRuntimeEvent({
      type: 'runtime.aborted',
      eventId: 'e1', ts: 1, sessionId: 's1', turnIndex: 0, reason: 'timeout',
    })
    expect(useAgentStore.getState().status).toBe('aborted')
  })

  test('runtime.error sets status to error', () => {
    useAgentStore.getState().applyRuntimeEvent({
      type: 'runtime.error',
      eventId: 'e1', ts: 1, sessionId: 's1', turnIndex: 0,
      error: { category: 'internal', message: 'boom', recoverable: false },
    })
    expect(useAgentStore.getState().status).toBe('error')
  })

  test('runtime.error without toolUseId pushes a runtime.error message into messages', () => {
    // 这是 bug 修复的回归测试: 之前 turn-level / 引擎级 runtime.error
    // (server agent.ts:471 catch 块发的 eventId:'err' 那一类) 只 setStatus,
    // 错误信息没进 messages → 中间对话区看不到错误, 只有底栏"✗ 错误"标签.
    // 现在应当把错误消息 push 到 messages, 让 Agent.tsx:888 的 MessageBubble
    // 渲染分支 (红色 Card + error.message + error.category) 能命中.
    useAgentStore.getState().applyRuntimeEvent({
      type: 'runtime.error',
      eventId: 'err',
      ts: 1700000000000,
      sessionId: 's1',
      turnIndex: 0,
      error: { category: 'internal', message: 'LLM upstream returned 502', recoverable: false },
    })
    const msgs = useAgentStore.getState().messages
    const errMsgs = msgs.filter((m) => m.type === 'runtime.error')
    expect(errMsgs.length).toBe(1)
    expect(errMsgs[0]?.error).toEqual({
      category: 'internal',
      message: 'LLM upstream returned 502',
      recoverable: false,
    })
    // 不带 toolUseId 时不应影响 tool_use:* 记录
    const toolMsgs = msgs.filter((m) => (m.type as string).startsWith('tool_use:'))
    expect(toolMsgs.length).toBe(0)
  })

  test('runtime.error with toolUseId does NOT push a runtime.error message (still routes to tool_use:error)', () => {
    // 工具级 error 仍然走 upsertToolCall, 不应再额外 push 一条 runtime.error
    // 消息 (会与 ToolCallBlock 的错误显示重复).
    useAgentStore.getState().applyRuntimeEvent({
      type: 'runtime.tool_call',
      eventId: 'e1', ts: 1, sessionId: 's1', turnIndex: 0,
      toolUseId: 'toolu_abc', toolName: 'Bash', input: { command: 'rm -rf /' },
    })
    useAgentStore.getState().applyRuntimeEvent({
      type: 'runtime.error',
      eventId: 'err-toolu_abc',
      ts: 2, sessionId: 's1', turnIndex: 0,
      toolUseId: 'toolu_abc',
      error: { category: 'tool', message: 'permission denied', recoverable: false },
    })
    const msgs = useAgentStore.getState().messages
    const errMsgs = msgs.filter((m) => m.type === 'runtime.error')
    expect(errMsgs.length).toBe(0)
    // 工具记录应是 tool_use:error, error 字段目前是 message 字符串
    // (ToolCallBlock 已兼容这种 fallback 渲染, 见 Agent.tsx:449 / :503-506)
    const tool = msgs.find((m) => m.toolUseId === 'toolu_abc')
    expect(tool?.type).toBe('tool_use:error')
    expect(tool?.error).toBe('permission denied')
  })
})

describe('useAgentStore.applySessionEvent', () => {
  test('session.created registers session via transcriptId into array', () => {
    useAgentStore.getState().applySessionEvent({
      type: 'session.created',
      eventId: 'e1', ts: 1, sessionId: 's1', title: 'Hello', cwd: '/tmp',
    })
    const sessions = useAgentStore.getState().sessions
    expect(sessions.some((x) => x.transcriptId === 's1' && x.title === 'Hello')).toBe(true)
  })

  test('session.deleted removes session by transcriptId', () => {
    useAgentStore.getState().applySessionEvent({
      type: 'session.created',
      eventId: 'e1', ts: 1, sessionId: 's1', title: 'X', cwd: '/tmp',
    })
    useAgentStore.getState().applySessionEvent({
      type: 'session.deleted',
      eventId: 'e2', ts: 2, sessionId: 's1',
    })
    const sessions = useAgentStore.getState().sessions
    expect(sessions.some((x) => x.transcriptId === 's1')).toBe(false)
  })

  test('session.renamed updates existing session title by transcriptId', () => {
    // 这是修复的核心 regression: 老代码按 Record 索引 sessions[sid] 永远
    // undefined, case 静默早退. 现在改成按 transcriptId findIndex.
    useAgentStore.getState().applySessionEvent({
      type: 'session.created',
      eventId: 'e1', ts: 1, sessionId: 's1', title: 'old', cwd: '/tmp',
    })
    useAgentStore.getState().applySessionEvent({
      type: 'session.renamed',
      eventId: 'e2', ts: 2, sessionId: 's1', title: 'new',
    })
    const sessions = useAgentStore.getState().sessions
    const found = sessions.find((x) => x.transcriptId === 's1')
    expect(found?.title).toBe('new')
  })
})

describe('useAgentStore.applyPromptAsk', () => {
  test('stores pendingAsk', () => {
    useAgentStore.getState().applyPromptAsk({
      type: 'prompt.ask',
      eventId: 'e1', ts: 1, sessionId: 's1', toolUseId: 'tu1',
      questions: [{ question: 'q', header: 'h', options: [{ label: 'A' }] }],
    })
    expect(useAgentStore.getState().pendingAsk?.toolUseId).toBe('tu1')
  })

  test('initializes status/answers/annotations so QuestionCard can read them', () => {
    // 这是修复 QuestionCard 不渲染 的回归测试. 老实现只填
    // sessionId/toolUseId/questions, answers 是 undefined →
    // `questions.every((q) => answers[q.question])` 抛 TypeError →
    // 组件崩溃. 现在 applyPromptAsk 必须把 status/answers/annotations
    // 都填上, QuestionCard 才能安全渲染.
    useAgentStore.getState().applyPromptAsk({
      type: 'prompt.ask',
      eventId: 'e1', ts: 1, sessionId: 's1', toolUseId: 'tu1',
      questions: [{ question: 'q', header: 'h', options: [{ label: 'A' }] }],
    })
    const ask = useAgentStore.getState().pendingAsk!
    expect(ask.status).toBe('pending')
    expect(ask.answers).toEqual({})
    expect(ask.annotations).toEqual({})
  })
})
