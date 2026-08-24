import express from 'express'
import request from 'supertest'
import { afterEach, describe, expect, it, vi } from 'vitest'
import subagentTasksRouter from '../../../src/server/routes/subagentTasks.js'

// Mock the agentRuntime module before importing the router
vi.mock('../../../src/server/services/agentRuntime.js', () => ({
  getKernelAdapter: vi.fn(),
}))

describe('subagentTasks routes 走 seamRegistry', () => {
  afterEach(() => {
    vi.restoreAllMocks()
  })

  function makeApp() {
    const app = express()
    app.use(express.json())
    app.use('/api', subagentTasksRouter)
    return app
  }

  describe('GET /api/subagent-tasks', () => {
    it('调 seam.list with sessionId', async () => {
      const { getKernelAdapter } = await import('../../../src/server/services/agentRuntime.js')
      const mockSeam = {
        list: vi.fn().mockResolvedValue([
          { taskId: 't1', sessionId: 's1', status: 'running', description: 'test', startedAt: Date.now() },
        ]),
        get: vi.fn(),
        cancel: vi.fn(),
        sendMessage: vi.fn(),
        startContinuable: vi.fn(),
      }
      vi.mocked(getKernelAdapter).mockReturnValue({ kernel: 'dsh', getSeam: () => mockSeam } as never)

      const app = makeApp()
      const res = await request(app).get('/api/subagent-tasks?sessionId=s1')

      expect(res.status).toBe(200)
      expect(mockSeam.list).toHaveBeenCalledWith('s1')
      expect(res.body.tasks).toHaveLength(1)
    })

    it('dsh unavailable 时返回 503', async () => {
      const { getKernelAdapter } = await import('../../../src/server/services/agentRuntime.js')
      vi.mocked(getKernelAdapter).mockReturnValue({ kernel: 'opencc' } as never)

      const app = makeApp()
      const res = await request(app).get('/api/subagent-tasks')

      expect(res.status).toBe(503)
      expect(res.body.error).toBe('dsh_subagent_unavailable')
    })

    // 2026-08-24 blocker-fix: seam.list() 因废 snapshot 文件触发 TypeError
    // 时,route 不再 500 — 降级到空 tasks 列表 + warning,UI 走空态。
    it('seam.list 抛 TypeError 时降级到空 tasks (不再 500)', async () => {
      const { getKernelAdapter } = await import('../../../src/server/services/agentRuntime.js')
      const mockSeam = {
        list: vi.fn().mockRejectedValue(new TypeError("Cannot read properties of undefined (reading 'slice')")),
        get: vi.fn(),
        cancel: vi.fn(),
        sendMessage: vi.fn(),
        startContinuable: vi.fn(),
      }
      vi.mocked(getKernelAdapter).mockReturnValue({ kernel: 'dsh', getSeam: () => mockSeam } as never)

      const app = makeApp()
      const res = await request(app).get('/api/subagent-tasks?allSessions=true')

      expect(res.status).toBe(200)
      expect(res.body.tasks).toEqual([])
      expect(res.body.warning).toBe('list_partial_failure')
    })

    // 2026-08-24 blocker-fix: 单条 seam.get 在文件不可读时返回 404 而非 500
    it('seam.get 抛 TypeError 时返回 404 (单条废文件)', async () => {
      const { getKernelAdapter } = await import('../../../src/server/services/agentRuntime.js')
      const mockSeam = {
        list: vi.fn().mockResolvedValue([]),
        get: vi.fn().mockRejectedValue(new TypeError("Cannot read properties of undefined (reading 'slice')")),
        cancel: vi.fn(),
        sendMessage: vi.fn(),
        startContinuable: vi.fn(),
      }
      vi.mocked(getKernelAdapter).mockReturnValue({ kernel: 'dsh', getSeam: () => mockSeam } as never)

      const app = makeApp()
      const res = await request(app).get('/api/subagent-tasks/bad-task-id')

      expect(res.status).toBe(404)
      expect(res.body.error).toBe('subagent_task_unreadable')
    })
  })

  describe('GET /api/subagent-tasks/:id', () => {
    it('调 seam.get', async () => {
      const { getKernelAdapter } = await import('../../../src/server/services/agentRuntime.js')
      const mockTask = { taskId: 't1', sessionId: 's1', status: 'done', description: 'test', startedAt: Date.now() }
      const mockSeam = {
        list: vi.fn().mockResolvedValue([]),
        get: vi.fn().mockResolvedValue(mockTask),
        cancel: vi.fn(),
        sendMessage: vi.fn(),
        startContinuable: vi.fn(),
      }
      vi.mocked(getKernelAdapter).mockReturnValue({ kernel: 'dsh', getSeam: () => mockSeam } as never)

      const app = makeApp()
      const res = await request(app).get('/api/subagent-tasks/t1')

      expect(res.status).toBe(200)
      expect(mockSeam.get).toHaveBeenCalledWith('t1')
      expect(res.body.taskId).toBe('t1')
    })
  })

  describe('POST /api/subagent-tasks/:id/interrupt', () => {
    it('调 seam.cancel', async () => {
      const { getKernelAdapter } = await import('../../../src/server/services/agentRuntime.js')
      const mockSeam = {
        list: vi.fn().mockResolvedValue([
          { taskId: 't1', sessionId: 's1', status: 'running', description: 'test', startedAt: Date.now() },
        ]),
        get: vi.fn(),
        cancel: vi.fn().mockResolvedValue({ ok: true }),
        sendMessage: vi.fn(),
        startContinuable: vi.fn(),
      }
      vi.mocked(getKernelAdapter).mockReturnValue({ kernel: 'dsh', getSeam: () => mockSeam } as never)

      const app = makeApp()
      const res = await request(app).post('/api/subagent-tasks/t1/interrupt')

      expect(res.status).toBe(200)
      expect(mockSeam.cancel).toHaveBeenCalledWith('t1')
    })

    // 2026-08-24 blocker-fix: seam.list() 因废 snapshot 文件 TypeError
    // 时降级到 404,不再 500。
    it('seam.list 抛 TypeError 时返回 404 (不再 500)', async () => {
      const { getKernelAdapter } = await import('../../../src/server/services/agentRuntime.js')
      const mockSeam = {
        list: vi.fn().mockRejectedValue(new TypeError("Cannot read properties of undefined (reading 'slice')")),
        get: vi.fn(),
        cancel: vi.fn(),
        sendMessage: vi.fn(),
        startContinuable: vi.fn(),
      }
      vi.mocked(getKernelAdapter).mockReturnValue({ kernel: 'dsh', getSeam: () => mockSeam } as never)

      const app = makeApp()
      const res = await request(app).post('/api/subagent-tasks/some-task/interrupt')

      expect(res.status).toBe(404)
      expect(res.body.error).toBe('subagent_task_unreadable')
    })
  })

  describe('POST /api/subagent-tasks/:id/continuable', () => {
    it('调 seam.startContinuable', async () => {
      const { getKernelAdapter } = await import('../../../src/server/services/agentRuntime.js')
      const mockSeam = {
        list: vi.fn(),
        get: vi.fn(),
        cancel: vi.fn(),
        sendMessage: vi.fn(),
        startContinuable: vi.fn().mockResolvedValue({ childId: 'c1', messageId: 'm1' }),
      }
      vi.mocked(getKernelAdapter).mockReturnValue({ kernel: 'dsh', getSeam: () => mockSeam } as never)

      const app = makeApp()
      const res = await request(app)
        .post('/api/subagent-tasks/abc/continuable')
        .send({ prompt: 'hi' })

      expect(res.status).toBe(200)
      expect(mockSeam.startContinuable).toHaveBeenCalledWith({
        parentSessionId: 'abc',
        prompt: 'hi',
      })
      expect(res.body).toEqual({ childId: 'c1', messageId: 'm1' })
    })

    it('prompt 缺时返回 400', async () => {
      const { getKernelAdapter } = await import('../../../src/server/services/agentRuntime.js')
      const mockSeam = {
        list: vi.fn(),
        get: vi.fn(),
        cancel: vi.fn(),
        sendMessage: vi.fn(),
        startContinuable: vi.fn(),
      }
      vi.mocked(getKernelAdapter).mockReturnValue({ kernel: 'dsh', getSeam: () => mockSeam } as never)

      const app = makeApp()
      const res = await request(app)
        .post('/api/subagent-tasks/abc/continuable')
        .send({})

      expect(res.status).toBe(400)
      expect(res.body.error).toBe('prompt_required')
    })
  })
})
