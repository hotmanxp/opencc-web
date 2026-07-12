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
  test('session.created registers session metadata via session records', () => {
    useAgentStore.getState().applySessionEvent({
      type: 'session.created',
      eventId: 'e1', ts: 1, sessionId: 's1', title: 'Hello', cwd: '/tmp',
    })
    // applySessionEvent 内部仍然按 Record 形态写入以便兼容旧 record 形态.
    const sessions = useAgentStore.getState().sessions as unknown as Record<
      string,
      { sessionId: string; title: string; cwd: string }
    >
    expect(sessions.s1).toEqual({
      sessionId: 's1', title: 'Hello', cwd: '/tmp',
    })
  })

  test('session.deleted removes session', () => {
    useAgentStore.getState().applySessionEvent({
      type: 'session.created',
      eventId: 'e1', ts: 1, sessionId: 's1', title: 'X', cwd: '/tmp',
    })
    useAgentStore.getState().applySessionEvent({
      type: 'session.deleted',
      eventId: 'e2', ts: 2, sessionId: 's1',
    })
    const sessions = useAgentStore.getState().sessions as unknown as Record<
      string,
      { sessionId: string; title: string; cwd: string }
    >
    expect(sessions.s1).toBeUndefined()
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
