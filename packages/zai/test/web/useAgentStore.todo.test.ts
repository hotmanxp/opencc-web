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
