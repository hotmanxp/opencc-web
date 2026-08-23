// packages/zai/test/web/useAgentStore.v2Tasks.test.ts
// @vitest-environment happy-dom
//
// 修复目标:
// 1. createNewSession 应当同时清掉 v2TasksBySession 的当前 sid
//    (防止新建会话时残留上一个会话的 v2 任务)
// 2. loadTranscript 完成后, 自动 fetch /api/agent/sessions/:id/v2-tasks
//    把磁盘上该 session 的任务 (TaskListStore 按 sessionId 隔离,
//    实际存储 ~/.zai/tasks/<sessionId>.json) 回填进
//    v2TasksBySession[sid], 让"刷新页面 / 切历史会话"后 v2 任务列表
//    不空白.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { useAgentStore, type V2TaskItem } from '../../src/web/src/store/useAgentStore.js'

const sampleV2: V2TaskItem[] = [
  {
    id: 'v1',
    subject: 'V2 任务 A',
    status: 'pending',
    blocks: [],
    blockedBy: [],
    updatedAt: 1,
  },
  {
    id: 'v2',
    subject: 'V2 任务 B',
    status: 'in_progress',
    blocks: [],
    blockedBy: [],
    updatedAt: 2,
  },
]

beforeEach(() => {
  vi.restoreAllMocks()
  // happy-dom 提供 localStorage, fetchV2Tasks 会读 zai-token
  localStorage.setItem('zai-token', 'test-token')
  useAgentStore.setState({
    sessionId: 'sess-A',
    sessions: [
      { sessionId: 'sess-A', updatedAt: 1 },
      { sessionId: 'sess-B', updatedAt: 2 },
    ],
    messages: [],
    textSegmentRev: 0,
    segmentedToolUseIds: {},
    sendSeq: 0,
    v2TasksBySession: {},
  })
})

afterEach(() => {
  vi.restoreAllMocks()
})

describe('useAgentStore — v2TasksBySession session 隔离', () => {
  it('createNewSession 清掉当前 sid 的 v2TasksBySession', async () => {
    // 先给 sess-A 写入 v2 任务
    useAgentStore.getState().setV2Tasks('sess-A', sampleV2)
    useAgentStore.getState().setV2Tasks('sess-B', [
      {
        id: 'x',
        subject: 'B 的任务',
        status: 'pending',
        blocks: [],
        blockedBy: [],
        updatedAt: 3,
      },
    ])
    expect(useAgentStore.getState().v2TasksBySession['sess-A']).toHaveLength(2)

    // 创建新会话 → sess-A 的 v2 应该被清掉
    await useAgentStore.getState().createNewSession()
    const s = useAgentStore.getState()
    expect(s.v2TasksBySession['sess-A']).toBeUndefined()
    // 其它 sid 保留
    expect(s.v2TasksBySession['sess-B']).toHaveLength(1)
  })

  it('loadTranscript 不再自动 fetch v2-tasks (100% SSE)', async () => {
    // 100% SSE 设计: loadTranscript 完成后不再 fire-and-forget /v2-tasks.
    // v2 tasks 完全由 SSE v2_task.changed 推送 (Task 4 + Task 8 + Task 11 wiring).
    const transcriptPayload = {
      transcript: {
        messages: [
          {
            uuid: 'u1',
            parentUuid: null,
            type: 'user',
            timestamp: 1,
            message: { content: 'hello' },
            cwd: '/x',
            userType: 'zai',
            sessionId: 'sess-A',
            version: '2',
            isSidechain: false,
          },
        ],
      },
    }
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = typeof input === 'string' ? input : (input as URL).toString()
      // transcript GET 返回; v2-tasks 不应再被调
      if (url.includes('/api/agent/sessions/sess-A') && !url.includes('/v2-tasks')) {
        return {
          ok: true,
          status: 200,
          json: async () => transcriptPayload,
        } as any
      }
      throw new Error('unexpected URL: ' + url)
    })
    vi.stubGlobal('fetch', fetchMock as any)

    await useAgentStore.getState().loadTranscript('sess-A')
    // 等待 microtask
    await new Promise((r) => setTimeout(r, 10))

    // 验证没有调 v2-tasks
    const v2Calls = fetchMock.mock.calls.filter((call) => {
      const url = typeof call[0] === 'string' ? call[0] : (call[0] as URL).toString()
      return url.includes('/v2-tasks')
    })
    expect(v2Calls).toHaveLength(0)
    // transcript 加载了, 但 v2TasksBySession 仍是空
    expect(useAgentStore.getState().v2TasksBySession['sess-A']).toBeUndefined()
  })
})

/**
 * Phase 5P5 适配:dsh-tool-todo 上游走 whole-list snapshot 语义,
 * `action: 'snapshot'` 携带 `tasks: V2TaskItem[]`(已由 zai-side factories
 * 把 TodoItem[] 映射成 V2TaskItem[]),整 list 替换 v2TasksBySession[sid]。
 * opencc 模式仍走 upsert/delete 单 task CRUD,本 describe 只覆盖新分支。
 */
describe('useAgentStore — v2_task.changed action="snapshot" 整 list 替换', () => {
  it('snapshot:整 list 替换 v2TasksBySession[sid](空 → 2 个)', () => {
    const tasks: V2TaskItem[] = [
      {
        id: 'fix bug',
        subject: 'fix bug',
        status: 'in_progress',
        blocks: [],
        blockedBy: [],
        updatedAt: 100,
      },
      {
        id: 'add test',
        subject: 'add test',
        status: 'pending',
        blocks: [],
        blockedBy: [],
        updatedAt: 100,
      },
    ]
    useAgentStore.getState().applyV2TaskChanged({
      type: 'v2_task.changed',
      sessionId: 'sess-dsh',
      tasks,
      action: 'snapshot',
    } as never)
    expect(useAgentStore.getState().v2TasksBySession['sess-dsh']).toEqual(tasks)
  })

  it('snapshot:整 list 替换(N 个 → M 个,先清空再加)', () => {
    // 先有 3 个
    useAgentStore.getState().setV2Tasks('sess-dsh', [
      { id: 'old1', subject: 'o1', status: 'completed', blocks: [], blockedBy: [], updatedAt: 1 },
      { id: 'old2', subject: 'o2', status: 'completed', blocks: [], blockedBy: [], updatedAt: 1 },
      { id: 'old3', subject: 'o3', status: 'pending', blocks: [], blockedBy: [], updatedAt: 1 },
    ])
    // model 调 todo_write 新 list 2 个
    useAgentStore.getState().applyV2TaskChanged({
      type: 'v2_task.changed',
      sessionId: 'sess-dsh',
      tasks: [
        { id: 'new1', subject: 'n1', status: 'in_progress', blocks: [], blockedBy: [], updatedAt: 2 },
        { id: 'new2', subject: 'n2', status: 'pending', blocks: [], blockedBy: [], updatedAt: 2 },
      ],
      action: 'snapshot',
    } as never)
    const final = useAgentStore.getState().v2TasksBySession['sess-dsh']
    expect(final).toHaveLength(2)
    expect(final?.map((t) => t.id)).toEqual(['new1', 'new2'])
    expect(final?.find((t) => t.id === 'old1')).toBeUndefined()
  })

  it('snapshot:tasks=[] 表示整 list 被清空', () => {
    useAgentStore.getState().setV2Tasks('sess-dsh', sampleV2)
    expect(useAgentStore.getState().v2TasksBySession['sess-dsh']).toHaveLength(2)
    useAgentStore.getState().applyV2TaskChanged({
      type: 'v2_task.changed',
      sessionId: 'sess-dsh',
      tasks: [],
      action: 'snapshot',
    } as never)
    expect(useAgentStore.getState().v2TasksBySession['sess-dsh']).toEqual([])
  })

  it('snapshot 不影响其它 sid(per-session 隔离)', () => {
    useAgentStore.getState().setV2Tasks('sess-other', sampleV2)
    useAgentStore.getState().applyV2TaskChanged({
      type: 'v2_task.changed',
      sessionId: 'sess-dsh',
      tasks: [{ id: 'only', subject: 'only', status: 'pending', blocks: [], blockedBy: [], updatedAt: 1 }],
      action: 'snapshot',
    } as never)
    // sess-dsh 整 list 替换
    expect(useAgentStore.getState().v2TasksBySession['sess-dsh']).toHaveLength(1)
    // sess-other 不动
    expect(useAgentStore.getState().v2TasksBySession['sess-other']).toEqual(sampleV2)
  })
})