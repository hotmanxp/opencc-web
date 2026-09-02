import { beforeAll, afterAll, describe, expect, it, vi } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import express from 'express'
import supertest from 'supertest'
import superTasksRouter from '../../../src/server/routes/superTasks.js'
import { __resetForTests, setTaskFactoryState, getTaskFactoryState } from '../../../src/server/services/taskFactoryBridge.js'
import { __setBackgroundRuntime } from '../../../src/server/services/backgroundRuntime.js'
import { eventBus } from '../../../src/server/services/eventBus.js'
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

  it('返回四栏 bucket 含 verifying(2026-09-02 新增)', async () => {
    const s = await createPoolTask({ title: 'ver-bucket' })
    const core = await import('@zn-ai/zn-agent-core')
    await core.moveTask(s.id, 'queue-tasks', 'processing-tasks')
    await core.moveTask(s.id, 'processing-tasks', 'verifying-tasks')
    const res = await supertest(app).get('/api/super-tasks')
    expect(res.status).toBe(200)
    expect(Array.isArray(res.body.buckets.verifying)).toBe(true)
    expect(res.body.buckets.verifying.find((t: { id: string }) => t.id === s.id)).toBeTruthy()
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

  it('verifying 桶任务 pause 拒绝 400(2026-09-02 验证闭环保护)', async () => {
    const s = await createPoolTask({ title: 'pause-ver' })
    const core = await import('@zn-ai/zn-agent-core')
    await core.moveTask(s.id, 'queue-tasks', 'processing-tasks')
    await core.moveTask(s.id, 'processing-tasks', 'verifying-tasks')
    const cancelSpy = vi.fn().mockResolvedValue({ ok: true })
    __setBackgroundRuntime({
      get: async () => null,
      cancel: cancelSpy,
    } as unknown as Parameters<typeof __setBackgroundRuntime>[0])
    try {
      const res = await supertest(app).post(`/api/super-tasks/${s.id}/pause`)
      expect(res.status).toBe(400)
      expect(cancelSpy).not.toHaveBeenCalled()
    } finally {
      __setBackgroundRuntime(null)
    }
  })

  it('processing+paused 状态 pause 拒 400(2026-09-02 收紧到 processing+processing)', async () => {
    const s = await createPoolTask({ title: 'pause-paused' })
    const core = await import('@zn-ai/zn-agent-core')
    await core.moveTask(s.id, 'queue-tasks', 'processing-tasks')
    await core.markTaskStatus(s.id, 'processing-tasks', { status: 'paused' })
    const cancelSpy = vi.fn().mockResolvedValue({ ok: true })
    __setBackgroundRuntime({
      get: async () => null,
      cancel: cancelSpy,
    } as unknown as Parameters<typeof __setBackgroundRuntime>[0])
    try {
      const res = await supertest(app).post(`/api/super-tasks/${s.id}/pause`)
      expect(res.status).toBe(400)
      expect(cancelSpy).not.toHaveBeenCalled()
    } finally {
      __setBackgroundRuntime(null)
    }
  })
})

describe('POST /api/super-tasks/:id/accept (2026-09-02 加 verifying 桶)', () => {
  it('processing 桶任务可调用', async () => {
    const s = await createPoolTask({ title: 'accept-p' })
    const core = await import('@zn-ai/zn-agent-core')
    await core.moveTask(s.id, 'queue-tasks', 'processing-tasks')
    const res = await supertest(app).post(`/api/super-tasks/${s.id}/accept`)
    expect(res.status).toBe(200)
  })

  it('verifying 桶任务可调用(强制通过)', async () => {
    const s = await createPoolTask({ title: 'accept-v' })
    const core = await import('@zn-ai/zn-agent-core')
    await core.moveTask(s.id, 'queue-tasks', 'processing-tasks')
    await core.moveTask(s.id, 'processing-tasks', 'verifying-tasks')
    const res = await supertest(app).post(`/api/super-tasks/${s.id}/accept`)
    expect(res.status).toBe(200)
  })

  it('queue 桶任务拒 400', async () => {
    const s = await createPoolTask({ title: 'accept-q' })
    const res = await supertest(app).post(`/api/super-tasks/${s.id}/accept`)
    expect(res.status).toBe(400)
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

describe('POST /api/super-tasks/supervisor/reset (2026-09-02 重置主管)', () => {
  it('清空 supervisorSessionId + 同步关托管 + 广播 state.changed', async () => {
    // 先把 managed 打开 + sid 设成非空,验证 reset 把两者都重置
    await setTaskFactoryState({ managedEnabled: true, supervisorSessionId: 'sess-pre-reset' })
    const emitSpy = vi.spyOn(eventBus, 'emit')
    const res = await supertest(app).post('/api/super-tasks/supervisor/reset')
    expect(res.status).toBe(200)
    expect(res.body).toEqual({ ok: true })
    const s = await getTaskFactoryState()
    expect(s.supervisorSessionId).toBeNull()
    expect(s.managedEnabled).toBe(false)
    // 验证广播事件(其它 tab / 前端 SSE 同步依赖它)
    expect(emitSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'task_factory',
        action: 'state.changed',
        payload: expect.objectContaining({ supervisorSessionId: null, managedEnabled: false }),
      }),
    )
    emitSpy.mockRestore()
    // 复位 beforeAll 状态,不影响后续用例
    await setTaskFactoryState({ managedEnabled: false, supervisorSessionId: 'sess-sup' })
  })
})
