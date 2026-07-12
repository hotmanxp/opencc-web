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
      toolName: 'bash', input: { cmd: 'ls' },
    })
    const msgs = useAgentStore.getState().messages
    const toolMsgs = msgs.filter((m) => m.type === 'tool_use:start')
    expect(toolMsgs.length).toBe(1)
    expect(toolMsgs[0].name).toBe('bash')
    expect(toolMsgs[0].input).toEqual({ cmd: 'ls' })
    expect(typeof toolMsgs[0].toolUseId).toBe('string')
  })

  test('runtime.tool_result upserts the matching tool_use with output', () => {
    useAgentStore.getState().applyRuntimeEvent({
      type: 'runtime.tool_call',
      eventId: 'e1', ts: 1, sessionId: 's1', turnIndex: 0,
      toolName: 'bash', input: { cmd: 'ls' },
    })
    const startTool = useAgentStore.getState().messages.find(
      (m) => m.type === 'tool_use:start' && (m.toolUseId as string).startsWith('tu_runtime_s1_'),
    )
    expect(startTool).toBeDefined()
    useAgentStore.getState().applyRuntimeEvent({
      type: 'runtime.tool_result',
      eventId: 'e2', ts: 2, sessionId: 's1', turnIndex: 0,
      toolUseId: startTool!.toolUseId as string,
      output: 'file.txt',
    })
    const finalTool = useAgentStore.getState().messages.find(
      (m) => m.toolUseId === startTool!.toolUseId,
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
})
