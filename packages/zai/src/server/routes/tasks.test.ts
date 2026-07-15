import { describe, expect, test, beforeEach, afterEach } from 'vitest'
import { mkdtemp, rm } from 'fs/promises'
import { join } from 'path'
import { tmpdir } from 'os'
import express from 'express'
import request from 'supertest'
import {
  DefaultBackgroundRuntime,
  JsonTaskStore,
  type AgentRuntime,
  type BackgroundRuntime,
  type RuntimeEvent,
} from '@zn-ai/zai-agent-core'
import tasksRouter from './tasks.js'
import { __setBackgroundRuntime } from '../services/backgroundRuntime.js'

let tmpDir: string
let mockRuntime: DefaultBackgroundRuntime

function makeNoopAgent(): AgentRuntime {
  return {
    async *run(): AsyncGenerator<RuntimeEvent> {
      // empty stream completes immediately
    },
    async abort() {},
    async listSessions() {
      return []
    },
    async readSession() {
      throw new Error('not used')
    },
    async patchSession() {},
    async removeSession() {},
  } as unknown as AgentRuntime
}

function makeYieldingAgent(events: RuntimeEvent[]): AgentRuntime {
  return {
    async *run(): AsyncGenerator<RuntimeEvent> {
      for (const ev of events) {
        yield ev
      }
    },
    async abort() {},
    async listSessions() {
      return []
    },
    async readSession() {
      throw new Error('not used')
    },
    async patchSession() {},
    async removeSession() {},
  } as unknown as AgentRuntime
}

async function createRuntime(
  agentRuntime: AgentRuntime = makeNoopAgent(),
): Promise<DefaultBackgroundRuntime> {
  const store = new JsonTaskStore(tmpDir)
  await store.ensureDirs()
  return new DefaultBackgroundRuntime({
    agentRuntime,
    store,
    maxConcurrent: 1,
    shutdownTimeoutMs: 200,
  })
}

beforeEach(async () => {
  tmpDir = await mkdtemp(join(tmpdir(), 'zai-tasks-route-'))
  mockRuntime = await createRuntime()
  __setBackgroundRuntime(mockRuntime)
})

afterEach(async () => {
  await mockRuntime.shutdown().catch(() => {})
  __setBackgroundRuntime(null)
  await rm(tmpDir, { recursive: true, force: true })
})

function makeApp() {
  const app = express()
  app.use(express.json())
  app.use('/api', tasksRouter)
  return app
}

async function waitForStatus(
  runtime: BackgroundRuntime,
  id: string,
  expected: string,
  timeoutMs = 1000,
): Promise<void> {
  const start = Date.now()
  while (Date.now() - start < timeoutMs) {
    const t = await runtime.get(id)
    if (t && t.status === expected) return
    await new Promise((r) => setTimeout(r, 10))
  }
  throw new Error(`timeout waiting for task ${id} to reach ${expected}`)
}

describe('POST /api/tasks', () => {
  test('returns 201 and taskId for valid input', async () => {
    const res = await request(makeApp())
      .post('/api/tasks')
      .send({ prompt: 'hello', cwd: '/tmp' })
    expect(res.status).toBe(201)
    expect(res.body.taskId).toHaveLength(12)
    expect(res.body.status).toBe('queued')
  })

  test('returns 400 when prompt is empty', async () => {
    const res = await request(makeApp())
      .post('/api/tasks')
      .send({ prompt: '' })
    expect(res.status).toBe(400)
    expect(res.body.error).toMatch(/prompt/)
  })
})

describe('GET /api/tasks', () => {
  test('lists all tasks', async () => {
    await mockRuntime.dispatch({ prompt: 'a' })
    await mockRuntime.dispatch({ prompt: 'b' })
    const res = await request(makeApp()).get('/api/tasks')
    expect(res.status).toBe(200)
    expect(res.body.tasks).toHaveLength(2)
  })

  test('filters by status query', async () => {
    // 默认 noop agent 立即完成 → dispatch 后状态会在 microtask 间隙
    // 推到 completed,导致 ?status=queued/running 查询为 0(flaky)。
    // 用 hanging agent 让 task 保持 running,dispatch 后等待 status 稳定再查。
    await mockRuntime.shutdown().catch(() => {})
    const hangingAgent: AgentRuntime = {
      async *run(): AsyncGenerator<RuntimeEvent> {
        await new Promise<RuntimeEvent>(() => {}) // 永不 resolve,依赖 shutdown 强制 abort
      },
      async abort() {},
      async listSessions() { return [] },
      async readSession() { throw new Error('not used') },
      async patchSession() {},
      async removeSession() {},
    } as unknown as AgentRuntime
    mockRuntime = await createRuntime(hangingAgent)
    __setBackgroundRuntime(mockRuntime)

    const dispatched = await mockRuntime.dispatch({ prompt: 'a' })
    // 等 scheduleNext (setImmediate macrotask) 把 task 推到 running
    const deadline = Date.now() + 1000
    while (Date.now() < deadline) {
      const t = await mockRuntime.get(dispatched.id)
      if (t?.status === 'running') break
      await new Promise((r) => setTimeout(r, 5))
    }
    const res = await request(makeApp()).get('/api/tasks?status=running')
    expect(res.body.tasks).toHaveLength(1)
  })

  test('returns 400 for invalid status', async () => {
    const res = await request(makeApp()).get('/api/tasks?status=bogus')
    expect(res.status).toBe(400)
  })
})

describe('GET /api/tasks/:id', () => {
  test('returns task or 404', async () => {
    const t = await mockRuntime.dispatch({ prompt: 'a' })
    const ok = await request(makeApp()).get(`/api/tasks/${t.id}`)
    expect(ok.status).toBe(200)
    expect(ok.body.id).toBe(t.id)

    const miss = await request(makeApp()).get('/api/tasks/nonexistent')
    expect(miss.status).toBe(404)
    expect(miss.body.error).toBe('task_not_found')
  })
})

describe('DELETE /api/tasks/:id', () => {
  test('returns ok:true', async () => {
    const t = await mockRuntime.dispatch({ prompt: 'a' })
    const res = await request(makeApp()).delete(`/api/tasks/${t.id}`)
    expect(res.status).toBe(200)
    expect(res.body.ok).toBe(true)
  })

  test('returns ok:false for unknown task', async () => {
    const res = await request(makeApp()).delete('/api/tasks/does-not-exist')
    expect(res.status).toBe(200)
    expect(res.body.ok).toBe(false)
  })
})

describe('GET /api/tasks/:id/events', () => {
  test('streams events with task.ended terminal event', async () => {
    // 用 yielding agent 替换默认 noop agent
    await mockRuntime.shutdown().catch(() => {})
    const agent = makeYieldingAgent([
      {
        eventId: 'e1',
        sessionId: 's1',
        ts: 1,
        turnIndex: 0,
        type: 'content_block_delta',
        delta: { type: 'text_delta', text: 'hi' },
      },
      {
        eventId: 'e2',
        sessionId: 's1',
        ts: 2,
        turnIndex: 0,
        type: 'runtime.done',
        text: 'done',
      },
    ])
    mockRuntime = await createRuntime(agent)
    __setBackgroundRuntime(mockRuntime)

    const dispatchRes = await request(makeApp())
      .post('/api/tasks')
      .send({ prompt: 'a' })
    const taskId = dispatchRes.body.taskId

    // wait for task to finish so SSE stream completes
    await waitForStatus(mockRuntime, taskId, 'completed')

    const capture = await new Promise<{ body: string }>((resolve) => {
      let body = ''
      const timer = setTimeout(() => resolve({ body }), 1000)
      const req = request(makeApp())
        .get(`/api/tasks/${taskId}/events`)
        .buffer(false)
      req.on('response', (res) => {
        res.on('data', (chunk: Buffer) => {
          body += chunk.toString()
          if (body.includes('event: task.ended')) {
            clearTimeout(timer)
            res.destroy()
            resolve({ body })
          }
        })
        res.on('end', () => resolve({ body }))
        res.on('error', () => resolve({ body }))
      })
      req.on('error', () => resolve({ body }))
      req.end()
    })

    expect(capture.body).toMatch(/event: task\.ended/)
    expect(capture.body).toMatch(/event: content_block_delta/)
    expect(capture.body).toMatch(/event: runtime\.done/)
  })

  test('returns 404 for unknown task', async () => {
    const res = await request(makeApp()).get('/api/tasks/nonexistent/events')
    expect(res.status).toBe(404)
    expect(res.body.error).toBe('task_not_found')
  })

  test('supports Last-Event-ID resume (skips prior events)', async () => {
    await mockRuntime.shutdown().catch(() => {})
    const agent = makeYieldingAgent([
      {
        eventId: 'e1',
        sessionId: 's1',
        ts: 1,
        turnIndex: 0,
        type: 'content_block_delta',
        delta: { type: 'text_delta', text: '1' },
      },
      {
        eventId: 'e2',
        sessionId: 's1',
        ts: 2,
        turnIndex: 0,
        type: 'content_block_delta',
        delta: { type: 'text_delta', text: '2' },
      },
      {
        eventId: 'e3',
        sessionId: 's1',
        ts: 3,
        turnIndex: 0,
        type: 'content_block_delta',
        delta: { type: 'text_delta', text: '3' },
      },
    ])
    mockRuntime = await createRuntime(agent)
    __setBackgroundRuntime(mockRuntime)

    const dispatchRes = await request(makeApp())
      .post('/api/tasks')
      .send({ prompt: 'a' })
    const taskId = dispatchRes.body.taskId
    await waitForStatus(mockRuntime, taskId, 'completed')

    const capture = await new Promise<{ body: string }>((resolve) => {
      let body = ''
      const timer = setTimeout(() => resolve({ body }), 1000)
      const req = request(makeApp())
        .get(`/api/tasks/${taskId}/events`)
        .set('Last-Event-ID', '2')
        .buffer(false)
      req.on('response', (res) => {
        res.on('data', (chunk: Buffer) => {
          body += chunk.toString()
          if (body.includes('event: task.ended')) {
            clearTimeout(timer)
            res.destroy()
            resolve({ body })
          }
        })
        res.on('end', () => resolve({ body }))
        res.on('error', () => resolve({ body }))
      })
      req.on('error', () => resolve({ body }))
      req.end()
    })

    expect(capture.body).not.toMatch(/"text":"1"/)
    expect(capture.body).not.toMatch(/"text":"2"/)
    expect(capture.body).toMatch(/"text":"3"/)
    expect(capture.body).toMatch(/event: task\.ended/)
  })
})