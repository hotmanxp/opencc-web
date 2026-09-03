import { beforeAll, afterAll, describe, expect, it, vi } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import { existsSync } from 'node:fs'
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
let dataDir: string
let app: express.Express
beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), 'tf-routes-'))
  // ZAI_DATA_DIR 隔离 factory-settings.json —— GET 内 sweep 读取阈值,固定为默认 48h
  dataDir = await mkdtemp(join(tmpdir(), 'tf-routes-data-'))
  process.env.ZAI_DATA_DIR = dataDir
  process.env.ZAI_TASK_FACTORY_DIR = dir
  __resetForTests()
  await setTaskFactoryState({ managedEnabled: false, supervisorSessionId: 'sess-sup' })
  app = express()
  app.use(express.json())
  app.use('/api', superTasksRouter)
})
afterAll(async () => {
  delete process.env.ZAI_DATA_DIR
  delete process.env.ZAI_TASK_FACTORY_DIR
  await rm(dir, { recursive: true, force: true })
  await rm(dataDir, { recursive: true, force: true })
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

describe('GET /api/super-tasks since-hash 短路(2026-09-03 快照缓存)', () => {
  it('缺省不带 since → modified:true 全量且旧字段齐全(向后兼容)', async () => {
    await createPoolTask({ title: 'hash-full' })
    const res = await supertest(app).get('/api/super-tasks')
    expect(res.status).toBe(200)
    expect(res.body.modified).toBe(true)
    expect(typeof res.body.hash).toBe('string')
    expect(res.body.hash.split('|')).toHaveLength(3) // fingerprint|managed|sid
    // 向后兼容:旧字段不得移除
    expect(res.body.buckets).toBeTruthy()
    expect(res.body.buckets.queue).toBeInstanceOf(Array)
    expect(typeof res.body.managed).toBe('boolean')
    expect('supervisorSessionId' in res.body).toBe(true)
  })

  it('since 命中 → modified:false 且不含 buckets/managed/supervisorSessionId', async () => {
    const a = await supertest(app).get('/api/super-tasks')
    const hash = a.body.hash as string
    expect(a.body.modified).toBe(true)
    const res = await supertest(app).get(`/api/super-tasks?since=${encodeURIComponent(hash)}`)
    expect(res.status).toBe(200)
    expect(res.body.modified).toBe(false)
    expect(res.body.hash).toBe(hash)
    expect(res.body.buckets).toBeUndefined()
    expect(res.body.managed).toBeUndefined()
    expect(res.body.supervisorSessionId).toBeUndefined()
  })

  it('任务变化后旧 since 失效 → 重算返回新 hash', async () => {
    const a = await supertest(app).get('/api/super-tasks')
    await createPoolTask({ title: 'hash-stale' })
    const res = await supertest(app).get(`/api/super-tasks?since=${encodeURIComponent(a.body.hash as string)}`)
    expect(res.body.modified).toBe(true)
    expect(res.body.hash).not.toBe(a.body.hash)
    expect(res.body.buckets).toBeTruthy()
  })

  it('managed/supervisorSessionId 变化也参与 hash(仅 state 变、文件未动)', async () => {
    const prev = await getTaskFactoryState()
    try {
      const a = await supertest(app).get('/api/super-tasks')
      await setTaskFactoryState({ managedEnabled: true })
      const b = await supertest(app).get('/api/super-tasks')
      expect(b.body.modified).toBe(true)
      expect(b.body.hash).not.toBe(a.body.hash)
      expect(b.body.hash).toContain('|true|')
      // 带新 since 再查 → 短路
      const c = await supertest(app).get(`/api/super-tasks?since=${encodeURIComponent(b.body.hash as string)}`)
      expect(c.body.modified).toBe(false)
    } finally {
      await setTaskFactoryState({ managedEnabled: prev.managedEnabled, supervisorSessionId: prev.supervisorSessionId })
    }
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

describe('GET /api/super-tasks/:id/intake-check (2026-09-03 文档强校验)', () => {
  it('刚创建的任务 → ok:false 且三份 intake 文档全部列出', async () => {
    const s = await createPoolTask({ title: 'gate-route' })
    const res = await supertest(app).get(`/api/super-tasks/${s.id}/intake-check`)
    expect(res.status).toBe(200)
    expect(res.body.ok).toBe(false)
    expect([...res.body.missing].sort()).toEqual(['docs/brainstorm.md', 'docs/plan.md', 'docs/spec.md'])
  })

  it('文档齐备的任务 → ok:true missing 空', async () => {
    const s = await createPoolTask({
      title: 'gate-route-ok',
      spec: '# 需求规格\n\n验收:导出 CSV 文件包含表头与数据行,编码 UTF-8 带 BOM 兼容 Excel。',
      plan: '# 执行计划\n\n实现导出函数并覆盖空数据与正常数据两个测试用例,完成后跑全量单测。',
    })
    const { writeFile } = await import('node:fs/promises')
    await writeFile(join(dir, 'queue-tasks', s.id, 'docs', 'brainstorm.md'), '# 纪要\n\n用户确认编码 UTF-8 带 BOM,优先级 P2,无依赖任务。', 'utf-8')
    const res = await supertest(app).get(`/api/super-tasks/${s.id}/intake-check`)
    expect(res.status).toBe(200)
    expect(res.body).toEqual({ ok: true, missing: [] })
  })

  it('任务不存在 → 404', async () => {
    const res = await supertest(app).get('/api/super-tasks/tf-nonexist/intake-check')
    expect(res.status).toBe(404)
  })
})

describe('GET /api/super-tasks 过期终态自动归档(2026-09-03 tf-xrlcxuoi)', () => {
  async function moveToFinished(id: string): Promise<void> {
    const core = await import('@zn-ai/zn-agent-core')
    await core.moveTask(id, 'queue-tasks', 'processing-tasks')
    await core.moveTask(id, 'processing-tasks', 'verifying-tasks')
    await core.moveTask(id, 'verifying-tasks', 'finished-tasks')
  }

  it('completedAt 超阈值(默认 48h)的 done 任务:GET 后移入 history-tasks,列表不再包含', async () => {
    const s = await createPoolTask({ title: 'archive-old' })
    await moveToFinished(s.id)
    const core = await import('@zn-ai/zn-agent-core')
    const old = new Date(Date.now() - 100 * 3_600_000).toISOString()
    await core.markTaskStatus(s.id, 'finished-tasks', { completedAt: old })

    const res = await supertest(app).get('/api/super-tasks')
    expect(res.status).toBe(200)
    const finished = res.body.buckets.finished as Array<{ id: string }>
    expect(finished.find((t) => t.id === s.id)).toBeUndefined()
    expect(existsSync(join(dir, 'history-tasks', s.id, 'task.yaml'))).toBe(true)
    expect(existsSync(join(dir, 'finished-tasks', s.id))).toBe(false)
  })

  it('completedAt 阈值内的终态任务不受影响', async () => {
    const s = await createPoolTask({ title: 'archive-recent' })
    await moveToFinished(s.id)
    const core = await import('@zn-ai/zn-agent-core')
    await core.markTaskStatus(s.id, 'finished-tasks', { completedAt: new Date().toISOString() })

    const res = await supertest(app).get('/api/super-tasks')
    expect(res.status).toBe(200)
    const finished = res.body.buckets.finished as Array<{ id: string }>
    expect(finished.find((t) => t.id === s.id)).toBeTruthy()
    expect(existsSync(join(dir, 'history-tasks', s.id))).toBe(false)
  })
})
