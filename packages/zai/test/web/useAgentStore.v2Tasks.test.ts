// packages/zai/test/web/useAgentStore.v2Tasks.test.ts
// @vitest-environment happy-dom
//
// 修复目标:
// 1. createNewSession 应当同时清掉 v2TasksBySession 的当前 sid
//    (与 todosBySession 对称 — 老 TODO 已经在 createNewSession 里清,
//    但 v2 任务被漏掉, 导致新建会话时残留上一个会话的 v2 任务)
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
      { transcriptId: 'sess-A', updatedAt: 1 },
      { transcriptId: 'sess-B', updatedAt: 2 },
    ],
    messages: [],
    textSegmentRev: 0,
    segmentedToolUseIds: {},
    sendSeq: 0,
    todosBySession: {},
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

  it('loadTranscript 后自动 fetch /api/agent/sessions/:id/v2-tasks 回填 v2TasksBySession', async () => {
    // mock transcript 端点返回一条 transcript (不挂 TodoWrite, 只触发
    // loadTranscript 主流程)
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
    const v2Payload = {
      tasks: sampleV2,
    }
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = typeof input === 'string' ? input : (input as URL).toString()
      // 注意顺序: v2-tasks 必须先匹配 (它的路径含 sess-A)
      if (url.includes('/v2-tasks')) {
        return {
          ok: true,
          status: 200,
          json: async () => v2Payload,
        } as any
      }
      if (url.includes('/api/agent/sessions/sess-A')) {
        // transcript GET
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

    // 等待 microtask (fetchV2Tasks 是 async)
    await new Promise((r) => setTimeout(r, 10))

    const s = useAgentStore.getState()
    expect(s.v2TasksBySession['sess-A']).toEqual(sampleV2)
    expect(fetchMock).toHaveBeenCalledWith(
      expect.stringContaining('/api/agent/sessions/sess-A/v2-tasks'),
      expect.objectContaining({ headers: expect.any(Object) }),
    )
  })

  it('loadTranscript v2 fetch 失败时静默, 不抛错', async () => {
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
      if (url.includes('/v2-tasks')) {
        return { ok: false, status: 500, json: async () => ({}) } as any
      }
      return {
        ok: true,
        status: 200,
        json: async () => transcriptPayload,
      } as any
    })
    vi.stubGlobal('fetch', fetchMock as any)

    // 不应抛错
    await expect(useAgentStore.getState().loadTranscript('sess-A')).resolves.toBeUndefined()
    await new Promise((r) => setTimeout(r, 10))
    expect(useAgentStore.getState().v2TasksBySession['sess-A']).toBeUndefined()
  })
})