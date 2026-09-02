import { beforeAll, afterAll, describe, expect, it, vi } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import express from 'express'
import supertest from 'supertest'
import superTasksRouter from '../../../src/server/routes/superTasks.js'
import { __resetForTests, setTaskFactoryState, getTaskFactoryState } from '../../../src/server/services/taskFactoryBridge.js'
import { __setBackgroundRuntime } from '../../../src/server/services/backgroundRuntime.js'
import { createPoolTask } from '@zn-ai/zn-agent-core'

let dir: string
let app: express.Express
beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), 'tf-routes-'))
  process.env.ZAI_TASK_FACTORY_DIR = dir
  __resetForTests()
  await setTaskFactoryState({ managedEnabled: false, supervisorSessionId: 'sess-sup' })
  app = express()
  app.use(express.json())
  app.use('/api', superTasksRouter)
})
afterAll(async () => {
  delete process.env.ZAI_TASK_FACTORY_DIR
  await rm(dir, { recursive: true, force: true })
})

describe('GET /api/super-tasks', () => {
  it('返回三栏 bucket', async () => {
    await createPoolTask({ title: 'a' })
    const res = await supertest(app).get('/api/super-tasks')
    expect(res.status).toBe(200)
    expect(res.body.buckets.queue.length).toBeGreaterThan(0)
  })
})

describe('DELETE /api/super-tasks', () => {
  it('删除排队任务', async () => {
    const s = await createPoolTask({ title: 'del' })
    const res = await supertest(app).delete('/api/super-tasks').send({ ids: [s.id] })
    expect(res.status).toBe(200)
    const list = await supertest(app).get('/api/super-tasks')
    expect(list.body.buckets.queue.find((t: any) => t.id === s.id)).toBeUndefined()
  })
  it('processing 任务返回 409', async () => {
    const s = await createPoolTask({ title: 'keep' })
    await (await import('@zn-ai/zn-agent-core')).moveTask(s.id, 'queue-tasks', 'processing-tasks')
    const res = await supertest(app).delete('/api/super-tasks').send({ ids: [s.id] })
    expect(res.status).toBe(409)
  })
})

describe('POST /api/super-tasks/:id/pause', () => {
  it('kill 执行器 + 冻结 + 清 executorTaskId', async () => {
    const s = await createPoolTask({ title: 'pause-me' })
    const core = await import('@zn-ai/zn-agent-core')
    await core.moveTask(s.id, 'queue-tasks', 'processing-tasks')
    await core.markTaskStatus(s.id, 'processing-tasks', { status: 'processing', executorTaskId: 'exec-1' })
    const cancelSpy = vi.fn().mockResolvedValue({ ok: true })
    __setBackgroundRuntime({
      get: async () => null,
      cancel: cancelSpy,
    } as unknown as Parameters<typeof __setBackgroundRuntime>[0])

    const res = await supertest(app).post(`/api/super-tasks/${s.id}/pause`)
    expect(res.status).toBe(200)
    expect(cancelSpy).toHaveBeenCalledWith('exec-1')

    const list = await supertest(app).get('/api/super-tasks')
    const processing = list.body.buckets.processing as Array<{
      id: string
      status: string
      executorTaskId: string | null
    }>
    const t = processing.find((x) => x.id === s.id)
    expect(t?.status).toBe('paused')
    expect(t?.executorTaskId).toBeNull()

    __setBackgroundRuntime(null)
  })
})

describe('POST /api/super-tasks/managed', () => {
  it('切换开关并持久化到 state', async () => {
    const res = await supertest(app).post('/api/super-tasks/managed').send({ enabled: false })
    expect(res.status).toBe(200)
    // managed 路由只持久化 state + 广播事件（不 inject 主管）——断言真实落盘结果
    expect((await getTaskFactoryState()).managedEnabled).toBe(false)
  })
})

describe('POST /api/super-tasks/supervisor', () => {
  it('上报主管会话 id 并持久化到 state', async () => {
    const res = await supertest(app).post('/api/super-tasks/supervisor').send({ sessionId: ' sess-new-sup ' })
    expect(res.status).toBe(200)
    expect((await getTaskFactoryState()).supervisorSessionId).toBe('sess-new-sup')
    // 复位,避免影响后续用例(beforeAll 已跑,手动恢复)
    await setTaskFactoryState({ supervisorSessionId: 'sess-sup' })
  })
  it('缺失/空串 sessionId → 400', async () => {
    const r1 = await supertest(app).post('/api/super-tasks/supervisor').send({})
    expect(r1.status).toBe(400)
    const r2 = await supertest(app).post('/api/super-tasks/supervisor').send({ sessionId: '   ' })
    expect(r2.status).toBe(400)
  })
})
