import express from 'express'
import request from 'supertest'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { rm } from 'node:fs/promises'
import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

const DATA_DIR = '/tmp/zai-test-supervisor-wiring'

afterEach(async () => {
  delete process.env.ZAI_DATA_DIR
  delete process.env.ZAI_INSTANCE_ID
  delete process.env.ZAI_SUPERVISOR_PID
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
    // B7 (dsh-009): Phase 5.1 working tree 把 resolveAgentKernel 默认翻成 'dsh';
    // 此测试依赖 initAgentRuntime → getRuntime() 的 opencc 路径(backgroundRuntime
    // 注入),显式 pin opencc kernel 保证与未提交 Phase 5.1 状态兼容。
    const cwd = '/tmp/current'
    const projectZai = join(cwd, '.zai')
    if (!existsSync(projectZai)) mkdirSync(projectZai, { recursive: true })
    writeFileSync(
      join(projectZai, 'settings.json'),
      JSON.stringify({ agent: { kernel: 'opencc' } }, null, 2),
      'utf-8',
    )
    const { createApp } = await import('../../src/server/index.js')
    const app = await createApp({
      token: 'test',
      cwd,
      cwdName: 'current',
      host: '127.0.0.1',
      sdk: false,
      forceInitInstanceSupervisor: true,
    })
    const res = await request(app).get('/api/instances')
    expect(res.status).toBe(200)
    expect(res.body.instances).toHaveLength(1)
    expect(res.body.instances[0].isCurrent).toBe(true)
    expect(res.body.instances[0].port).toBe(9201)
  }, 60_000)
})
