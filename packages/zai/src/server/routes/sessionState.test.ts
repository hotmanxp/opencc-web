import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import express from 'express'
import request from 'supertest'

// Mock the zai-agent-core modules before importing the router under test.
// Methods must be vi.fn() (not arrow functions) so vi.mocked(...).mockReturnValue
// has a real spy to attach behavior to — plain `() => ...` makes
// `vi.mocked(...).mockReturnValue` fail with "is not a function".
vi.mock('@zn-ai/zai-agent-core/runtime', () => ({
  CwdStore: {
    clear: vi.fn(),
    has: vi.fn(() => false),
    get: vi.fn(() => undefined as string | undefined),
    set: vi.fn(),
  },
}))
vi.mock('@zn-ai/zai-agent-core/taskListStore', () => ({
  getTaskListStore: vi.fn(() => ({
    list: vi.fn(async (_sid: string) => []),
  })),
}))
vi.mock('@zn-ai/zai-agent-core/bashTracker', () => ({
  bashBackgroundTracker: {
    list: vi.fn((_filter?: { sessionId?: string; limit?: number }) => []),
  },
}))
vi.mock('../services/backgroundRuntime.js', () => ({
  getBackgroundRuntime: vi.fn(() => ({
    list: vi.fn(async () => []),
  })),
}))

import sessionStateRouter from './sessionState.js'
import { CwdStore } from '@zn-ai/zai-agent-core/runtime'
import { bashBackgroundTracker } from '@zn-ai/zai-agent-core/bashTracker'
import { getBackgroundRuntime } from '../services/backgroundRuntime.js'

describe('GET /api/agent/sessions/:id/state', () => {
  let app: express.Express

  beforeEach(() => {
    // Reset every mock's implementation to "no-op returning undefined"
    // before each test, so previous-test mockImplementation throws (test
    // 4, test 6, test 7) don't leak into later tests. Without this,
    // mocked store helpers from earlier tests poison later ones and the
    // endpoint request hangs until the 5s vitest timeout.
    vi.resetAllMocks()
    app = express()
    app.use('/api', sessionStateRouter)
  })

  afterEach(() => {
    vi.clearAllMocks()
  })

  it('returns 200 with 4 fields, all empty when stores are empty', async () => {
    const res = await request(app).get('/api/agent/sessions/sess-1/state')
    expect(res.status).toBe(200)
    expect(res.body).toEqual({
      cwd: null,
      v2Tasks: [],
      bashTasks: [],
      agentTasks: [],
    })
  })

  it('returns cwd when CwdStore has the session', async () => {
    vi.mocked(CwdStore.has).mockImplementation((sid) => sid === 'sess-1')
    vi.mocked(CwdStore.get).mockImplementation((sid) =>
      sid === 'sess-1' ? '/abs/path' : undefined,
    )
    const res = await request(app).get('/api/agent/sessions/sess-1/state')
    expect(res.status).toBe(200)
    expect(res.body.cwd).toEqual({ cwd: '/abs/path', updatedAt: expect.any(Number) })
  })

  it('returns cwd=null when CwdStore does not have the session', async () => {
    vi.mocked(CwdStore.has).mockReturnValue(false)
    const res = await request(app).get('/api/agent/sessions/sess-x/state')
    expect(res.body.cwd).toBeNull()
  })

  it('falls back to cwd=null when CwdStore.has throws, others unaffected', async () => {
    vi.mocked(CwdStore.has).mockImplementation(() => {
      throw new Error('boom')
    })
    const res = await request(app).get('/api/agent/sessions/sess-1/state')
    expect(res.body.cwd).toBeNull()
    expect(res.body.v2Tasks).toEqual([])
    expect(res.body.bashTasks).toEqual([])
    expect(res.body.agentTasks).toEqual([])
  })

  it('falls back to v2Tasks=[] when TaskListStore throws, others unaffected', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    const { getTaskListStore } = await import('@zn-ai/zai-agent-core/taskListStore')
    vi.mocked(getTaskListStore).mockReturnValue({
      list: async () => {
        throw new Error('boom')
      },
    } as ReturnType<typeof getTaskListStore>)
    const res = await request(app).get('/api/agent/sessions/sess-1/state')
    expect(res.body.v2Tasks).toEqual([])
    expect(res.body.bashTasks).toEqual([])
    expect(res.body.agentTasks).toEqual([])
    expect(warn).toHaveBeenCalledWith('[sessionState] v2 failed', expect.any(Error))
    warn.mockRestore()
  })

  it('falls back to bashTasks=[] when BashTracker throws, others unaffected', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    vi.mocked(bashBackgroundTracker.list).mockImplementation(() => {
      throw new Error('boom')
    })
    const res = await request(app).get('/api/agent/sessions/sess-1/state')
    expect(res.body.bashTasks).toEqual([])
    expect(res.body.cwd).toBeNull()
    expect(res.body.v2Tasks).toEqual([])
    expect(res.body.agentTasks).toEqual([])
    expect(warn).toHaveBeenCalledWith('[sessionState] bash failed', expect.any(Error))
    warn.mockRestore()
  })

  it('falls back to agentTasks=[] when BackgroundRuntime throws, others unaffected', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined)
    vi.mocked(getBackgroundRuntime).mockReturnValue({
      list: async () => {
        throw new Error('boom')
      },
    } as ReturnType<typeof getBackgroundRuntime>)
    const res = await request(app).get('/api/agent/sessions/sess-1/state')
    expect(res.body.agentTasks).toEqual([])
    expect(res.body.cwd).toBeNull()
    expect(res.body.v2Tasks).toEqual([])
    expect(res.body.bashTasks).toEqual([])
    expect(warn).toHaveBeenCalledWith('[sessionState] agent failed', expect.any(Error))
    warn.mockRestore()
  })

  it('agentTasks only returns tasks whose parentSessionId matches the session', async () => {
    vi.mocked(getBackgroundRuntime).mockReturnValue({
      list: async () => [
        { id: 't1', parentSessionId: 'sess-1', status: 'completed' },
        { id: 't2', parentSessionId: 'sess-2', status: 'completed' },
        { id: 't3', parentSessionId: 'sess-1', status: 'running' },
        { id: 't4', status: 'completed' }, // no parentSessionId
      ],
    } as ReturnType<typeof getBackgroundRuntime>)
    const res = await request(app).get('/api/agent/sessions/sess-1/state')
    expect(res.body.agentTasks).toHaveLength(2)
    expect(res.body.agentTasks.map((t: { id: string }) => t.id).sort()).toEqual(['t1', 't3'])
  })
})
