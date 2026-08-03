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

async function bootstrap() {
  process.env.ZAI_DATA_DIR = DATA_DIR
  if (!existsSync(DATA_DIR)) mkdirSync(DATA_DIR, { recursive: true })
  const { initInstanceSupervisor } = await import('../../../src/server/services/instanceSupervisor.js')
  const { default: router } = await import('../../../src/server/routes/instances.js')
  const doNotCall = (() => { throw new Error('spawn should not be called in this test') }) as unknown as () => never
  initInstanceSupervisor({
    cwd: '/tmp/current',
    dataDir: DATA_DIR,
    deps: { spawn: doNotCall,
            probePort: async () => 9201,
            writeFile: async () => undefined,
            readFile: async () => ({ definitions: [], statuses: {} }),
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
})
