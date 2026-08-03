import express from 'express'
import request from 'supertest'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { rm } from 'node:fs/promises'
import { existsSync, mkdirSync } from 'node:fs'

const DATA_DIR = '/tmp/zai-test-supervisor-wiring'

afterEach(async () => {
  delete process.env.ZAI_DATA_DIR
  vi.resetModules()
  try { await rm(DATA_DIR, { recursive: true, force: true }) } catch { /* best-effort tmp cleanup */ }
})

describe('instance supervisor wiring inside createApp', () => {
  it('GET /api/instances responds 200 with current row after createApp', async () => {
    // createApp awaits initAgentRuntime — cold start of the agent runtime
    // takes ~20-30s in CI; the 5s vitest default would time out.
    process.env.ZAI_DATA_DIR = DATA_DIR
    process.env.ZAI_PORT = '9201'
    if (!existsSync(DATA_DIR)) mkdirSync(DATA_DIR, { recursive: true })
    const { createApp } = await import('../../src/server/index.js')
    const app = await createApp({
      token: 'test',
      cwd: '/tmp/current',
      cwdName: 'current',
      host: '127.0.0.1',
      sdk: false,
    })
    const res = await request(app).get('/api/instances')
    expect(res.status).toBe(200)
    expect(res.body.instances).toHaveLength(1)
    expect(res.body.instances[0].isCurrent).toBe(true)
    expect(res.body.instances[0].port).toBe(9201)
  }, 60_000)
})
