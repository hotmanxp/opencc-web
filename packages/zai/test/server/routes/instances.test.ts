import express from 'express'
import request from 'supertest'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { rm } from 'node:fs/promises'
import { existsSync, mkdirSync } from 'node:fs'

const DATA_DIR = '/tmp/zai-test-instances-route'

async function bootstrap(extra?: { spawn?: (...args: never[]) => unknown; readFile?: () => Promise<{ definitions: Array<{ id: string; name: string; cwd: string; createdAt: string; lan?: boolean; startPort?: number | null }>; statuses: Record<string, unknown> }> }) {
  process.env.ZAI_DATA_DIR = DATA_DIR
  if (!existsSync(DATA_DIR)) mkdirSync(DATA_DIR, { recursive: true })
  const { initInstanceSupervisor } = await import('../../../src/server/services/instanceSupervisor.js')
  const { default: router } = await import('../../../src/server/routes/instances.js')
  const { EventEmitter } = await import('node:events')
  // Default spawn returns an EventEmitter + emits a fake IPC `ready` on
  // the next microtask. The supervisor's `child.on('message')` listener
  // (instanceSupervisor.ts:166-178) drives `starting → running` only when
  // it sees `{type:'ready',...}`. Without emitting it the entry stays in
  // `starting` forever (heartbeat only times out *running* instances) and
  // downstream assertions like "expect body.port === 9201" would fail.
  // mirror FakeChild in services/instanceSupervisor.test.ts to keep the
  // two test fixtures consistent. Tests that need to assert spawn
  // behaviour should pass `extra.spawn`.
  const defaultSpawn = () => {
    const ee = new EventEmitter()
    ;(ee as unknown as { pid: number }).pid = 99999
    queueMicrotask(() => {
      ee.emit('message', { type: 'ready', pid: 99999, port: 9201 })
    })
    return ee as unknown as never
  }
  initInstanceSupervisor({
    cwd: '/tmp/current',
    dataDir: DATA_DIR,
    deps: { spawn: (extra?.spawn as never) ?? defaultSpawn,
            probePort: async () => 9201,
            // Default `assertPortAvailable` is a no-op so tests that
            // don't care about port pinning don't have to seed one.
            assertPortAvailable: async () => undefined,
            writeFile: async () => undefined,
            readFile: (extra?.readFile as never) ?? (async () => ({ definitions: [], statuses: {} })),
            emit: () => undefined,
            now: () => Date.now(),
            sleep: async () => undefined },
  })
  const app = express()
  app.use(express.json())
  app.use('/api', router)
  return { app }
}

describe('routes/instances', () => {
  // routes/instances.ts 的 `ensureNotInstanceChild` 看到 ZAI_INSTANCE_ID
  // 会直接 404。vitest 进程可能继承 shell env — 必须在每个测试前清理,
  // 保证路由的"非子实例"逻辑走通。
  beforeEach(() => {
    delete process.env.ZAI_INSTANCE_ID
    delete process.env.ZAI_SUPERVISOR_PID
  })

  afterEach(async () => {
    delete process.env.ZAI_DATA_DIR
    delete process.env.ZAI_INSTANCE_ID
    delete process.env.ZAI_SUPERVISOR_PID
    vi.resetModules()
    try { await rm(DATA_DIR, { recursive: true, force: true }) } catch { /* best-effort tmp cleanup */ }
  })

  it('GET /api/instances returns the current instance row', async () => {
    const { app } = await bootstrap()
    const res = await request(app).get('/api/instances')
    expect(res.status).toBe(200)
    expect(res.body.instances).toHaveLength(1)
    expect(res.body.instances[0].isCurrent).toBe(true)
  })

  it('POST /api/instances rejects missing fields with 400', async () => {
    const { app } = await bootstrap()
    const res = await request(app).post('/api/instances').send({})
    expect(res.status).toBe(400)
  })

  it('POST /api/instances rejects unknown cwd with 400', async () => {
    const { app } = await bootstrap()
    const res = await request(app)
      .post('/api/instances')
      .send({ name: 'demo', cwd: '/this/path/does/not/exist/zzz' })
    expect(res.status).toBe(400)
    expect(res.body.error).toMatch(/cwd/)
  })

  it('operations on current instance return 400', async () => {
    const { app } = await bootstrap()
    const res = await request(app).post('/api/instances/__current__/start')
    expect(res.status).toBe(400)
    expect(res.body.error).toMatch(/current/)
  })

  it('GET /api/instances/:id returns 404 for unknown', async () => {
    const { app } = await bootstrap()
    const res = await request(app).get('/api/instances/inst_missing')
    expect(res.status).toBe(404)
  })

  it('POST /api/instances accepts lan=true and persists it on the snapshot', async () => {
    const { app } = await bootstrap()
    const res = await request(app)
      .post('/api/instances')
      .send({ name: 'demo', cwd: '/tmp', lan: true })
    expect(res.status).toBe(201)
    expect(res.body.instance.lan).toBe(true)
  })

  it('POST /api/instances rejects non-boolean lan with 400', async () => {
    const { app } = await bootstrap()
    const res = await request(app)
      .post('/api/instances')
      .send({ name: 'demo', cwd: '/tmp', lan: 'yes' })
    expect(res.status).toBe(400)
    expect(res.body.error).toMatch(/lan/)
  })

  it('PATCH /api/instances/:id toggles lan and returns the updated snapshot', async () => {
    // Seed an instance via the readFile path so PATCH has something
    // to operate on without going through POST (which auto-starts).
    const { app } = await bootstrap({
      readFile: async () => ({
        definitions: [{ id: 'inst_seed', name: 'seed', cwd: '/tmp/x', createdAt: '2026-08-04T00:00:00.000Z' }],
        statuses: {},
      }),
    })
    const patch = await request(app)
      .patch('/api/instances/inst_seed')
      .send({ lan: true })
    expect(patch.status).toBe(200)
    expect(patch.body.instance.lan).toBe(true)

    // Toggling back also works.
    const patchOff = await request(app)
      .patch('/api/instances/inst_seed')
      .send({ lan: false })
    expect(patchOff.status).toBe(200)
    expect(patchOff.body.instance.lan).toBe(false)
  })

  it('PATCH /api/instances/:id returns 404 for unknown id', async () => {
    const { app } = await bootstrap()
    const res = await request(app)
      .patch('/api/instances/inst_missing')
      .send({ lan: true })
    expect(res.status).toBe(404)
  })

  it('POST /api/instances/:id/start rejects non-boolean lan with 400', async () => {
    const { app } = await bootstrap()
    // Create a real instance (POST), then exercise the start route's
    // body validation. We only assert on the 400 case for a bad body —
    // the spawn itself succeeds in test mode (defaultSpawn emits a
    // fake `ready` IPC), so the underlying start is no longer the
    // focus of this test.
    await request(app).post('/api/instances').send({ name: 'demo', cwd: '/tmp/x' })
    const bad = await request(app)
      .post('/api/instances/inst_does_not_matter/start')
      .send({ lan: 'maybe' })
    expect(bad.status).toBe(400)
    expect(bad.body.error).toMatch(/lan/)
  })

  // ───────── port 配置相关 ─────────
  // POST 创建:接受数字,持久化到定义;拒绝 null / 字符串 / 越界 / 浮点。
  it('POST /api/instances accepts port and persists it on the definition', async () => {
    const { app } = await bootstrap()
    const res = await request(app)
      .post('/api/instances')
      .send({ name: 'demo', cwd: '/tmp', port: 9500 })
    expect(res.status).toBe(201)
    expect(res.body.instance.startPort).toBe(9500)
  })

  it('POST /api/instances omits port (defaults to auto) when absent', async () => {
    const { app } = await bootstrap()
    const res = await request(app)
      .post('/api/instances')
      .send({ name: 'demo', cwd: '/tmp' })
    expect(res.status).toBe(201)
    // `undefined` lands as no field on the JSON snapshot — the form
    // caller treats the absence as "auto", matching the pre-pin UX.
    expect(res.body.instance.startPort).toBeUndefined()
  })

  it('POST /api/instances rejects port=null with 400 (no pin to clear on creation)', async () => {
    const { app } = await bootstrap()
    const res = await request(app)
      .post('/api/instances')
      .send({ name: 'demo', cwd: '/tmp', port: null })
    expect(res.status).toBe(400)
    expect(res.body.error).toMatch(/port/)
  })

  // ---- kernel 字段 ----
  // POST 接受合法 kernel 值('opencc' | 'dsh')并持久化;缺省 = 继承全局;
  // 拒绝 null(无旧值可清)、非法字符串。
  it('POST /api/instances accepts kernel=dsh and persists it on the snapshot', async () => {
    const { app } = await bootstrap()
    const res = await request(app)
      .post('/api/instances')
      .send({ name: 'demo', cwd: '/tmp', kernel: 'dsh' })
    expect(res.status).toBe(201)
    expect(res.body.instance.kernel).toBe('dsh')
  })

  it('POST /api/instances accepts kernel=opencc and persists it', async () => {
    const { app } = await bootstrap()
    const res = await request(app)
      .post('/api/instances')
      .send({ name: 'demo', cwd: '/tmp', kernel: 'opencc' })
    expect(res.status).toBe(201)
    expect(res.body.instance.kernel).toBe('opencc')
  })

  it('POST /api/instances omits kernel (defaults to inherit) when absent', async () => {
    const { app } = await bootstrap()
    const res = await request(app)
      .post('/api/instances')
      .send({ name: 'demo', cwd: '/tmp' })
    expect(res.status).toBe(201)
    expect(res.body.instance.kernel).toBeUndefined()
  })

  it('POST /api/instances rejects kernel=null with 400 (no pin to clear on creation)', async () => {
    const { app } = await bootstrap()
    const res = await request(app)
      .post('/api/instances')
      .send({ name: 'demo', cwd: '/tmp', kernel: null })
    expect(res.status).toBe(400)
    expect(res.body.error).toMatch(/kernel/)
  })

  it('POST /api/instances rejects kernel=bogus with 400', async () => {
    const { app } = await bootstrap()
    const res = await request(app)
      .post('/api/instances')
      .send({ name: 'demo', cwd: '/tmp', kernel: 'bogus' })
    expect(res.status).toBe(400)
    expect(res.body.error).toMatch(/kernel/)
  })

  // PATCH 切换 kernel:合法值持久化;null 清回继承;缺省 no-op;
  // 非法值 400。empty body 不再因 kernel 字段误判为 no-op。
  it('PATCH /api/instances/:id sets kernel=dsh', async () => {
    const { app } = await bootstrap()
    const created = await request(app).post('/api/instances').send({ name: 'demo', cwd: '/tmp' })
    const id = created.body.instance.id
    const res = await request(app).patch(`/api/instances/${id}`).send({ kernel: 'dsh' })
    expect(res.status).toBe(200)
    expect(res.body.instance.kernel).toBe('dsh')
  })

  it('PATCH /api/instances/:id with kernel=null clears back to inherit', async () => {
    const { app } = await bootstrap()
    const created = await request(app).post('/api/instances').send({ name: 'demo', cwd: '/tmp', kernel: 'dsh' })
    const id = created.body.instance.id
    expect(created.body.instance.kernel).toBe('dsh')
    const res = await request(app).patch(`/api/instances/${id}`).send({ kernel: null })
    expect(res.status).toBe(200)
    expect(res.body.instance.kernel).toBeUndefined()
  })

  it('PATCH /api/instances/:id with kernel absent is a no-op (lan still patchable)', async () => {
    const { app } = await bootstrap()
    const created = await request(app).post('/api/instances').send({ name: 'demo', cwd: '/tmp' })
    const id = created.body.instance.id
    const res = await request(app).patch(`/api/instances/${id}`).send({ lan: true })
    expect(res.status).toBe(200)
    expect(res.body.instance.lan).toBe(true)
  })

  it('PATCH /api/instances/:id rejects kernel=bogus with 400', async () => {
    const { app } = await bootstrap()
    const created = await request(app).post('/api/instances').send({ name: 'demo', cwd: '/tmp' })
    const id = created.body.instance.id
    const res = await request(app).patch(`/api/instances/${id}`).send({ kernel: 'bogus' })
    expect(res.status).toBe(400)
    expect(res.body.error).toMatch(/kernel/)
  })

  // /start per-call 覆盖语义镜像 port:undefined → 用持久化值,合法值透传
  it('POST /api/instances/:id/start accepts kernel per-call override', async () => {
    const { app } = await bootstrap()
    const created = await request(app).post('/api/instances').send({ name: 'demo', cwd: '/tmp' })
    const id = created.body.instance.id
    const res = await request(app).post(`/api/instances/${id}/start`).send({ kernel: 'dsh' })
    expect(res.status).toBe(200)
    // per-call override 不写持久化 def — 该字段保持缺省
    expect(res.body.instance.kernel).toBeUndefined()
  })

  it('POST /api/instances/:id/start rejects kernel=bogus with 400', async () => {
    const { app } = await bootstrap()
    const created = await request(app).post('/api/instances').send({ name: 'demo', cwd: '/tmp' })
    const id = created.body.instance.id
    const res = await request(app).post(`/api/instances/${id}/start`).send({ kernel: 'bogus' })
    expect(res.status).toBe(400)
  })

  it.each([
    ['non-integer string', '9201'],
    ['out-of-range high', 99999],
    ['out-of-range low', 0],
    ['negative integer', -1],
    ['float', 9201.5],
    ['boolean', true],
  ])('POST /api/instances rejects invalid port (%s) with 400', async (_label, port) => {
    const { app } = await bootstrap()
    const res = await request(app)
      .post('/api/instances')
      .send({ name: 'demo', cwd: '/tmp', port })
    expect(res.status).toBe(400)
    expect(res.body.error).toMatch(/port/)
  })

  // PATCH:接受 number 设值,接受 null 清除,拒绝无效值。
  it('PATCH /api/instances/:id sets port', async () => {
    const { app } = await bootstrap({
      readFile: async () => ({
        definitions: [{ id: 'inst_seed', name: 'seed', cwd: '/tmp/x', createdAt: '2026-08-04T00:00:00.000Z' }],
        statuses: {},
      }),
    })
    const patch = await request(app)
      .patch('/api/instances/inst_seed')
      .send({ port: 9600 })
    expect(patch.status).toBe(200)
    expect(patch.body.instance.startPort).toBe(9600)
  })

  it('PATCH /api/instances/:id with port=null clears the pin back to auto', async () => {
    const { app } = await bootstrap({
      readFile: async () => ({
        definitions: [{ id: 'inst_seed', name: 'seed', cwd: '/tmp/x', createdAt: '2026-08-04T00:00:00.000Z', startPort: 9600 }],
        statuses: {},
      }),
    })
    const patch = await request(app)
      .patch('/api/instances/inst_seed')
      .send({ port: null })
    expect(patch.status).toBe(200)
    // Cleared pin → `null` on the snapshot (round-trips through the
    // supervisor's tri-state contract). The UI renders this as "auto".
    expect(patch.body.instance.startPort).toBeNull()
  })

  it('PATCH /api/instances/:id with absent port is a no-op', async () => {
    const { app } = await bootstrap({
      readFile: async () => ({
        definitions: [{ id: 'inst_seed', name: 'seed', cwd: '/tmp/x', createdAt: '2026-08-04T00:00:00.000Z', startPort: 9600 }],
        statuses: {},
      }),
    })
    // Send an empty body — the supervisor's `updateInstance` throws
    // INVALID_STATE when no patchable keys are supplied. That's the
    // existing pre-pin behaviour and we want to preserve it: a typo
    // shouldn't silently rewrite a definition.
    const patch = await request(app)
      .patch('/api/instances/inst_seed')
      .send({})
    expect(patch.status).toBe(400)
    // Pre-existing pin untouched — verify via a follow-up PATCH.
    const followUp = await request(app)
      .patch('/api/instances/inst_seed')
      .send({ lan: false })
    expect(followUp.status).toBe(200)
    expect(followUp.body.instance.startPort).toBe(9600)
  })

  it('PATCH /api/instances/:id rejects invalid port with 400', async () => {
    const { app } = await bootstrap({
      readFile: async () => ({
        definitions: [{ id: 'inst_seed', name: 'seed', cwd: '/tmp/x', createdAt: '2026-08-04T00:00:00.000Z' }],
        statuses: {},
      }),
    })
    const res = await request(app)
      .patch('/api/instances/inst_seed')
      .send({ port: 'nope' })
    expect(res.status).toBe(400)
    expect(res.body.error).toMatch(/port/)
  })

  // /start 接受 port 覆盖;不传则走持久化值。
  it('POST /api/instances/:id/start accepts port override', async () => {
    const { app } = await bootstrap()
    // Create a real instance (POST), then call /start on its id.
    // defaultSpawn emits a fake `ready` IPC with port 9201 regardless
    // of the override, so we only assert on 200 here — the supervisor
    // unit test covers the actual --port arg wiring.
    const create = await request(app)
      .post('/api/instances')
      .send({ name: 'demo', cwd: '/tmp', port: 9500 })
    expect(create.status).toBe(201)
    const id = create.body.instance.id as string
    // Stop first so /start has something to act on (createInstance
    // already auto-spawned; supervisor's doStart is a no-op when
    // state is `starting`/`running`, so we need to get back to
    // stopped via /stop).
    await request(app).post(`/api/instances/${id}/stop`).send({})
    const start = await request(app)
      .post(`/api/instances/${id}/start`)
      .send({ port: 9700 })
    expect(start.status).toBe(200)
  })

  it('POST /api/instances/:id/start rejects invalid port with 400', async () => {
    const { app } = await bootstrap()
    const res = await request(app)
      .post('/api/instances/inst_does_not_matter/start')
      .send({ port: 99999 })
    expect(res.status).toBe(400)
    expect(res.body.error).toMatch(/port/)
  })
})
