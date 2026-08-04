import express from 'express'
import request from 'supertest'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { rm } from 'node:fs/promises'
import { existsSync, mkdirSync } from 'node:fs'

const DATA_DIR = '/tmp/zai-test-instances-route'

afterEach(async () => {
  delete process.env.ZAI_DATA_DIR
  vi.resetModules()
  try { await rm(DATA_DIR, { recursive: true, force: true }) } catch { /* best-effort tmp cleanup */ }
})

async function bootstrap(extra?: { spawn?: (...args: never[]) => unknown; readFile?: () => Promise<{ definitions: Array<{ id: string; name: string; cwd: string; createdAt: string; lan?: boolean }>; statuses: Record<string, unknown> }> }) {
  process.env.ZAI_DATA_DIR = DATA_DIR
  if (!existsSync(DATA_DIR)) mkdirSync(DATA_DIR, { recursive: true })
  const { initInstanceSupervisor } = await import('../../../src/server/services/instanceSupervisor.js')
  const { default: router } = await import('../../../src/server/routes/instances.js')
  const { EventEmitter } = await import('node:events')
  // Default spawn returns a no-op EventEmitter so `createInstance`'s
  // auto-start succeeds without setting up a full fake child. Tests
  // that need to assert spawn behaviour should pass a custom `spawn`.
  const defaultSpawn = () => {
    const ee = new EventEmitter()
    ;(ee as unknown as { pid: number }).pid = 99999
    return ee as unknown as never
  }
  initInstanceSupervisor({
    cwd: '/tmp/current',
    dataDir: DATA_DIR,
    deps: { spawn: (extra?.spawn as never) ?? defaultSpawn,
            probePort: async () => 9201,
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
    // body validation. The start itself fails (default spawn returns
    // a fake child that never emits `ready`, supervisor will time
    // out), but we only assert on the 400 case for a bad body.
    await request(app).post('/api/instances').send({ name: 'demo', cwd: '/tmp/x' })
    const bad = await request(app)
      .post('/api/instances/inst_does_not_matter/start')
      .send({ lan: 'maybe' })
    expect(bad.status).toBe(400)
    expect(bad.body.error).toMatch(/lan/)
  })
})
