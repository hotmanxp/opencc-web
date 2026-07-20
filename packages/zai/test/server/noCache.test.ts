import { describe, it, expect } from 'vitest'
import express from 'express'
import request from 'supertest'
import { noCacheForApi, NO_CACHE } from '../../src/server/middleware/noCache.js'
import { SSE_HEADERS } from '../../src/server/services/sse.js'

function buildTestApp(): express.Express {
  const app = express()
  app.set('etag', false)
  app.use('/api', noCacheForApi)

  app.get('/api/ping', (_req, res) => {
    res.json({ ok: true })
  })

  app.get('/api/stream', (_req, res) => {
    for (const [k, v] of Object.entries(SSE_HEADERS)) res.setHeader(k, v as string)
    res.end()
  })

  return app
}

describe('noCacheForApi middleware', () => {
  it('attaches Cache-Control: no-store, no-cache, must-revalidate on plain JSON responses', async () => {
    const res = await request(buildTestApp()).get('/api/ping')
    expect(res.status).toBe(200)
    expect(res.headers['cache-control']).toBe(NO_CACHE)
  })

  it('emits Pragma: no-cache + Expires: 0 for legacy browser/proxy fallbacks', async () => {
    const res = await request(buildTestApp()).get('/api/ping')
    expect(res.headers['pragma']).toBe('no-cache')
    expect(res.headers['expires']).toBe('0')
  })

  it('does not include an ETag header (paired with app.set("etag", false))', async () => {
    const res = await request(buildTestApp()).get('/api/ping')
    expect(res.headers['etag']).toBeUndefined()
  })

  it('does NOT overwrite a Cache-Control header the route already set', async () => {
    const res = await request(buildTestApp()).get('/api/stream')
    expect(res.status).toBe(200)
    expect(res.headers['cache-control']).toBe('no-cache, no-transform')
  })

  it('prevents conditional 304 on repeat requests (regression: GET /api/agent/settings)', async () => {
    const app = buildTestApp()
    const first = await request(app).get('/api/ping')
    const second = await request(app)
      .get('/api/ping')
      .set('If-None-Match', first.headers['etag'] ?? '"should-not-exist"')
    expect(first.status).toBe(200)
    expect(second.status).toBe(200)
  })
})
