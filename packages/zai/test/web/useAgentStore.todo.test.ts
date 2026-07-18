// packages/zai/test/web/useAgentStore.todo.test.ts
// @vitest-environment happy-dom
import { describe, it, expect, beforeEach } from 'vitest'
import {
  useAgentStore,
  extractTodosFromTranscript,
  type TodoItem,
} from '../../src/web/src/store/useAgentStore.js'

const sampleTodos: TodoItem[] = [
  { content: 'A', status: 'in_progress', activeForm: 'A' },
  { content: 'B', status: 'pending', activeForm: 'B' },
]

beforeEach(() => {
  // 重置 store 到隔离初态, 不污染其他 test 文件
  useAgentStore.setState({
    sessionId: 'sess-1',
    messages: [],
    textSegmentRev: 0,
    segmentedToolUseIds: {},
    sendSeq: 0,
    todosBySession: {},
  })
})

describe('useAgentStore — todosBySession', () => {
  it('setTodos 写入并保留其他 sid', () => {
    const { setTodos } = useAgentStore.getState()
    setTodos('sess-1', sampleTodos)
    setTodos('sess-2', [])
    const s = useAgentStore.getState()
    expect(s.todosBySession['sess-1']).toEqual(sampleTodos)
    expect(s.todosBySession['sess-2']).toEqual([])
  })

  it('clearMessages 仅清当前 sid, 其他 sid 保留', () => {
    const { setTodos } = useAgentStore.getState()
    setTodos('sess-1', sampleTodos)
    setTodos('sess-2', [{ content: 'C', status: 'completed', activeForm: 'C' }])
    useAgentStore.getState().clearMessages()
    const s = useAgentStore.getState()
    expect(s.todosBySession['sess-1']).toBeUndefined()
    expect(s.todosBySession['sess-2']).toHaveLength(1)
  })

  it('upsertToolCall TodoWrite start 不进 messages, 不 bump segment', () => {
    useAgentStore.getState().upsertToolCall({
      eventId: 'start',
      sessionId: 'sess-1',
      ts: 1,
      turnIndex: 0,
      type: 'tool_use:start',
      toolUseId: 'toolu_todo_1',
      name: 'TodoWrite',
      input: { todos: sampleTodos },
    } as any)
    const s = useAgentStore.getState()
    expect(s.messages).toHaveLength(0)
    expect(s.textSegmentRev).toBe(0)
    expect(s.segmentedToolUseIds['toolu_todo_1']).toBeUndefined()
  })

  it('upsertToolCall TodoWrite done 触发 setTodos, 不进 messages', () => {
    useAgentStore.getState().upsertToolCall({
      eventId: 'done',
      sessionId: 'sess-1',
      ts: 1,
      turnIndex: 0,
      type: 'tool_use:done',
      toolUseId: 'toolu_todo_1',
      name: 'TodoWrite',
      input: { todos: sampleTodos },
    } as any)
    const s = useAgentStore.getState()
    expect(s.todosBySession['sess-1']).toEqual(sampleTodos)
    expect(s.messages).toHaveLength(0)
  })

  it('upsertToolCall TodoWrite done + 损坏 input → 静默忽略', () => {
    useAgentStore.getState().upsertToolCall({
      eventId: 'done-bad',
      sessionId: 'sess-1',
      ts: 1,
      turnIndex: 0,
      type: 'tool_use:done',
      toolUseId: 'toolu_todo_2',
      name: 'TodoWrite',
      input: { todos: [{ content: '', status: 'pending', activeForm: '' }] },
    } as any)
    const s = useAgentStore.getState()
    // 静默: 不 push messages, 不写 todosBySession
    expect(s.messages).toHaveLength(0)
    expect(s.todosBySession['sess-1']).toBeUndefined()
  })

  it('applyRuntimeEvent: 真实 SSE 路径 runtime.tool_call + tool_result (TodoWrite) 不进 messages 并写入 todosBySession', () => {
    // 真实 SSE 流水线: server 发 runtime.tool_call + runtime.tool_result,
    // schema 上 result 不携带 toolName/input — 这些字段是 runtime.tool_call
    // 阶段从 store 拿 prev 的. 但 TodoWrite 的守卫在 upsertToolCall 里按
    // (msg.name as string) === 'TodoWrite' 判断, 没有 name 字段就被绕过.
    // 修复后: start 路径虽然吞掉 event, 但 done 路径必须能从 prev 同
    // toolUseId 那条已存在的 start entry 找回 'TodoWrite' 身份, 进而触发
    // 守卫写 todosBySession + 不进 messages.
    const sid = 'sess-1'
    // 1. tool_call: 即使有 toolName, TodoWrite 守卫吞掉, 不进 messages.
    useAgentStore.getState().applyRuntimeEvent({
      type: 'runtime.tool_call',
      eventId: 'tc-todo', ts: 1, sessionId: sid, turnIndex: 0,
      toolUseId: 'toolu_todo_rt1',
      toolName: 'TodoWrite',
      input: { todos: sampleTodos },
    } as any)
    // 2. tool_result: schema 现在带 toolName (2026-07-18 修复) + input,
    //     前端守卫才能在 done 路径识别 TodoWrite 身份 + 解析 todos 写 store.
    useAgentStore.getState().applyRuntimeEvent({
      type: 'runtime.tool_result',
      eventId: 'tr-todo', ts: 2, sessionId: sid, turnIndex: 0,
      toolUseId: 'toolu_todo_rt1',
      toolName: 'TodoWrite',
      input: { todos: sampleTodos },
      output: { todoCount: 2, firstItem: 'A' },
    } as any)
    const s = useAgentStore.getState()
    // 关键断言: 修复前 messages 会有 1 条 'unknown 已完成' 卡片 (Bug),
    // 修复后 messages 长度为 0, todosBySession 写入 sampleTodos.
    expect(s.messages).toHaveLength(0)
    expect(s.todosBySession[sid]).toEqual(sampleTodos)
  })

  it('applyRuntimeEvent: 真实 SSE 路径并发 Bash (TodoWrite 守卫不影响非 TodoWrite 工具)', () => {
    // 反向断言: 修复 TodoWrite 守卫不应该误伤其他工具.
    const sid = 'sess-1'
    useAgentStore.getState().applyRuntimeEvent({
      type: 'runtime.tool_call',
      eventId: 'tc-bash', ts: 1, sessionId: sid, turnIndex: 0,
      toolUseId: 'toolu_bash_rt1',
      toolName: 'Bash',
      input: { command: 'ls' },
    } as any)
    useAgentStore.getState().applyRuntimeEvent({
      type: 'runtime.tool_result',
      eventId: 'tr-bash', ts: 2, sessionId: sid, turnIndex: 0,
      toolUseId: 'toolu_bash_rt1',
      toolName: 'Bash',
      input: { command: 'ls' },
      output: 'file.txt',
    } as any)
    const s = useAgentStore.getState()
    // Bash 仍然正常 push + done.
    expect(s.messages).toHaveLength(1)
    expect(s.messages[0]!.name).toBe('Bash')
    expect((s.messages[0]!.output as string) ?? '').toContain('file.txt')
  })

  it('upsertToolCall 非 TodoWrite 工具正常 upsert', () => {
    useAgentStore.getState().upsertToolCall({
      eventId: 'start-bash',
      sessionId: 'sess-1',
      ts: 1,
      turnIndex: 0,
      type: 'tool_use:start',
      toolUseId: 'toolu_bash_1',
      name: 'Bash',
      input: { command: 'ls' },
    } as any)
    const s = useAgentStore.getState()
    expect(s.messages).toHaveLength(1)
    expect(s.messages[0]!.name).toBe('Bash')
    expect(s.textSegmentRev).toBe(1)
    expect(s.segmentedToolUseIds['toolu_bash_1']).toBe(true)
  })
})

describe('extractTodosFromTranscript', () => {
  it('提取最近一次 TodoWrite tool_use 的 todos', () => {
    const raw = [
      {
        type: 'assistant',
        message: {
          content: [
            { type: 'tool_use', id: 'old', name: 'TodoWrite', input: { todos: [
              { content: 'old', status: 'pending', activeForm: 'old' },
            ]}},
          ],
        },
      },
      { type: 'user', message: { content: '继续' } },
      {
        type: 'assistant',
        message: {
          content: [
            { type: 'text', text: '好的' },
            { type: 'tool_use', id: 'new', name: 'TodoWrite', input: { todos: sampleTodos } },
          ],
        },
      },
    ]
    expect(extractTodosFromTranscript(raw)).toEqual(sampleTodos)
  })

  it('没有 TodoWrite 时返回 null', () => {
    const raw = [{ type: 'assistant', message: { content: [{ type: 'text', text: 'hi' }] } }]
    expect(extractTodosFromTranscript(raw)).toBeNull()
  })

  it('最近 TodoWrite 损坏时返回 null', () => {
    const raw = [{
      type: 'assistant',
      message: {
        content: [
          { type: 'tool_use', id: 'x', name: 'TodoWrite', input: { todos: 'not-array' } },
        ],
      },
    }]
    expect(extractTodosFromTranscript(raw)).toBeNull()
  })
})
