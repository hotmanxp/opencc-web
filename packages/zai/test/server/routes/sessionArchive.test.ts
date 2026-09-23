import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import request from 'supertest'
import express from 'express'
import fs from 'node:fs'
import { mkdir, mkdtemp, rm, utimes, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Express } from 'express'

// sweep 内部 resolveDataDir() 读 ZAI_DATA_DIR → 隔离归档目录；
// 但 resolveArchiveKeepCount 走 readZaiSettings()，而 zaiSettingsPath() 是
// join(homedir(), '.zai', 'settings.json') —— homedir() 看 $HOME，
// **不看 ZAI_DATA_DIR**。所以 HOME 也必须隔离，否则测试会读到开发机真实的
// ~/.zai/settings.json 里的 archive.keepCount，结果不稳定。
let dataDir: string
let cwd: string
let app: Express

const DAY_MS = 24 * 60 * 60 * 1000

beforeEach(async () => {
  dataDir = await mkdtemp(join(tmpdir(), 'zai-archive-route-'))
  cwd = '/Users/foo/code/route-target'
  process.env.ZAI_DATA_DIR = dataDir
  process.env.HOME = dataDir
  vi.resetModules()
  const { __resetSessionArchiveForTests } = await import(
    '../../../src/server/services/sessionArchive.js'
  )
  __resetSessionArchiveForTests()
  const { default: sessionArchiveRouter } = await import(
    '../../../src/server/routes/sessionArchive.js'
  )
  app = express()
  app.use(express.json())
  app.locals.instanceContext = { cwd, cwdName: 'route-target' }
  app.use('/api', sessionArchiveRouter)
})

afterEach(async () => {
  delete process.env.ZAI_DATA_DIR
  delete process.env.HOME
  await rm(dataDir, { recursive: true, force: true })
})

async function seed(sessionId: string, daysAgo: number): Promise<void> {
  const dir = join(dataDir, 'projects', '-Users-foo-code-route-target')
  await mkdir(dir, { recursive: true })
  const f = join(dir, `${sessionId}.jsonl`)
  await writeFile(f, `${JSON.stringify({ type: 'user' })}\n`, 'utf-8')
  const t = new Date(Date.now() - daysAgo * DAY_MS)
  await utimes(f, t, t)
}

describe('POST /api/agent/sessions/archive', () => {
  it('归档本实例 cwd 的过期会话并回报结果', async () => {
    for (let i = 0; i < 20; i++) await seed(`sess-r${i}`, 1)
    await seed('sess-oldr0', 5)
    const res = await request(app).post('/api/agent/sessions/archive')
    expect(res.status).toBe(200)
    expect(res.body.archived).toEqual(['sess-oldr0'])
    expect(res.body.kept).toBe(20)
    expect(res.body.skipped).toBe(0)
    expect(
      fs.existsSync(
        join(dataDir, 'archive', 'projects', '-Users-foo-code-route-target', 'sess-oldr0.jsonl'),
      ),
    ).toBe(true)
  })

  it('没有可归档项 → 200 + archived: []（不是 5xx）', async () => {
    const res = await request(app).post('/api/agent/sessions/archive')
    expect(res.status).toBe(200)
    expect(res.body).toEqual({ archived: [], kept: 0, skipped: 0 })
  })
})
