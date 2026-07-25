import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import express from 'express'
import request from 'supertest'
import bashReplRouter from './bashRepl.js'
import replHistoryRouter from './replHistory.js'
import { __resetReplRegistryForTest } from '../services/repl/ReplRegistry.js'
import {
  ReplHistoryService,
  __resetReplHistoryServiceForTest,
} from '../services/repl/ReplHistoryService.js'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

function makeApp(opts: { history?: ReplHistoryService } = {}): express.Express {
  const app = express()
  app.use(express.json())
  app.locals.instanceContext = { cwd: '/tmp', cwdName: 'tmp' }
  if (opts.history) {
    app.locals.replHistoryService = opts.history
  }
  app.use('/api', bashReplRouter)
  app.use('/api', replHistoryRouter)
  return app
}

describe('bashRepl routes — exec / abort', () => {
  let app: express.Express
  let tmpDir: string
  let history: ReplHistoryService

  beforeEach(() => {
    __resetReplRegistryForTest()
    __resetReplHistoryServiceForTest()
    tmpDir = mkdtempSync(join(tmpdir(), 'zai-bashrepl-e2e-'))
    history = new ReplHistoryService({ historyPath: join(tmpDir, 'history.jsonl') })
    app = makeApp({ history })
  })

  afterEach(() => {
    __resetReplRegistryForTest()
    __resetReplHistoryServiceForTest()
    rmSync(tmpDir, { recursive: true, force: true })
  })

  it('POST exec 启动 child，返回 200 + execId', async () => {
    const res = await request(app)
      .post('/api/bash/repl/sess-1/exec')
      .send({ command: 'echo hello-repl' })
    expect(res.status).toBe(200)
    expect(res.body.ok).toBe(true)
    expect(res.body.execId).toMatch(/^e-/)
    await new Promise((r) => setTimeout(r, 200))
  })

  it('POST exec 409 当 busy=true', async () => {
    await request(app).post('/api/bash/repl/sess-1/exec').send({ command: 'node -e "setTimeout(()=>{}, 30000)"' })
    const res = await request(app).post('/api/bash/repl/sess-1/exec').send({ command: 'echo second' })
    expect(res.status).toBe(409)
    expect(res.body.ok).toBe(false)
    expect(res.body.busy).toBe(true)
    expect(res.body.currentExecId).toMatch(/^e-/)
  })

  it('POST abort 触发 child 退出', async () => {
    await request(app).post('/api/bash/repl/sess-1/exec').send({ command: 'node -e "setTimeout(()=>{}, 30000)"' })
    const res = await request(app).post('/api/bash/repl/sess-1/abort').send({})
    expect(res.status).toBe(200)
    expect(res.body.ok).toBe(true)
  })

  it('POST abort 409 当无 child 在跑', async () => {
    const res = await request(app).post('/api/bash/repl/sess-1/abort').send({})
    expect(res.status).toBe(409)
  })

  // Brief originally asserted status 500 here, but Node's spawn('sh', ['-c', ...])
  // succeeds even when the inner command does not exist — `sh` returns exit 127
  // and the route completes with 200. Same resolution as Task 3 ReplSession tests.
  it('POST exec unknown command 仍返回 200，sh 退出 127 后 busy 释放', async () => {
    const res = await request(app)
      .post('/api/bash/repl/sess-1/exec')
      .send({ command: 'this-command-does-not-exist-xyz-12345' })
    expect(res.status).toBe(200)
    expect(res.body.ok).toBe(true)
    expect(res.body.execId).toMatch(/^e-/)
    // 等 child 跑完 (`sh -c ...; exit 127`) → busy=false
    await new Promise((r) => setTimeout(r, 500))
    const abortRes = await request(app).post('/api/bash/repl/sess-1/abort').send({})
    expect(abortRes.status).toBe(409) // 无 child 在跑 → abort 409
  })
})

// -----------------------------------------------------------------------------
// Task 6 端到端集成测试 — bashRepl + replHistory 联合验证
// -----------------------------------------------------------------------------

describe('bashRepl + replHistory 端到端 (Task 6)', () => {
  let app: express.Express
  let tmpDir: string
  let history: ReplHistoryService

  beforeEach(() => {
    __resetReplRegistryForTest()
    __resetReplHistoryServiceForTest()
    tmpDir = mkdtempSync(join(tmpdir(), 'zai-bashrepl-e2e-'))
    history = new ReplHistoryService({ historyPath: join(tmpDir, 'history.jsonl') })
    app = makeApp({ history })
  })

  afterEach(() => {
    __resetReplRegistryForTest()
    __resetReplHistoryServiceForTest()
    rmSync(tmpDir, { recursive: true, force: true })
  })

  it('exec 后 GET /api/bash/history/top10 包含该命令 (count=1)', async () => {
    const exec = await request(app)
      .post('/api/bash/repl/sess-1/exec')
      .send({ command: 'echo e2e-test-1' })
    expect(exec.status).toBe(200)
    // appendCommand 是 fire-and-forget,等微任务 flush
    await new Promise((r) => setTimeout(r, 50))
    const top = await request(app).get('/api/bash/history/top10')
    expect(top.status).toBe(200)
    expect(top.body.entries).toContainEqual({
      command: 'echo e2e-test-1',
      count: 1,
    })
  })

  it('同一命令执行多次 → count 累加', async () => {
    for (let i = 0; i < 3; i++) {
      const r = await request(app)
        .post('/api/bash/repl/sess-A/exec')
        .send({ command: 'echo repeat-cmd' })
      expect(r.status).toBe(200)
      await new Promise((r) => setTimeout(r, 30))
    }
    const top = await request(app).get('/api/bash/history/top10')
    const entry = top.body.entries.find(
      (e: { command: string }) => e.command === 'echo repeat-cmd',
    )
    expect(entry?.count).toBe(3)
  })

  it('不同 session 写同一 history 文件', async () => {
    await request(app).post('/api/bash/repl/sess-1/exec').send({ command: 'echo shared-x' })
    await request(app).post('/api/bash/repl/sess-2/exec').send({ command: 'echo shared-x' })
    await new Promise((r) => setTimeout(r, 50))
    const top = await request(app).get('/api/bash/history/top10')
    const entry = top.body.entries.find(
      (e: { command: string }) => e.command === 'echo shared-x',
    )
    expect(entry?.count).toBe(2)
  })

  it('blocklist 命中命令 (exec 仍成功) 不写入历史', async () => {
    const r = await request(app)
      .post('/api/bash/repl/sess-1/exec')
      .send({ command: 'export SECRET_TOKEN=abc' })
    expect(r.status).toBe(200)
    await new Promise((r) => setTimeout(r, 50))
    const top = await request(app).get('/api/bash/history/top10')
    expect(top.body.entries).toEqual([])
  })

  it('?q= prefix 过滤仅返回匹配命令', async () => {
    // 串行写入(每个 exec 等 append 落盘)再发起下一个 — 避免 fire-and-forget
    // 在 e2e 流程里和 cache invalidate 之间的时序竞争。
    for (const cmd of ['git status', 'git log', 'ls -la']) {
      const r = await request(app).post('/api/bash/repl/s1/exec').send({ command: cmd })
      expect(r.status).toBe(200)
      // 等 fire-and-forget appendCommand 完成
      await new Promise((res) => setTimeout(res, 80))
    }
    history.invalidateCache()
    // 第一次 GET (不带 q) → cache miss → 读文件,装 cache
    const all = await request(app).get('/api/bash/history/top10')
    expect(all.body.entries.map((e: { command: string }) => e.command))
      .toEqual(expect.arrayContaining(['git status', 'git log', 'ls -la']))
    // 第二次 GET (带 q=git) → cache hit,prefix 过滤
    const top = await request(app).get('/api/bash/history/top10?q=git')
    expect(top.status).toBe(200)
    const cmds = top.body.entries.map((e: { command: string }) => e.command)
    expect(cmds).toEqual(expect.arrayContaining(['git status', 'git log']))
    expect(cmds).not.toContain('ls -la')
  })
})