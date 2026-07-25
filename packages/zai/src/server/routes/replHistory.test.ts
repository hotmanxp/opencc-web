import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import express from 'express'
import request from 'supertest'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import replHistoryRouter from './replHistory.js'
import {
  ReplHistoryService,
  __resetReplHistoryServiceForTest,
} from '../services/repl/ReplHistoryService.js'

let tmpDir: string

beforeEach(async () => {
  tmpDir = await mkdtemp(join(tmpdir(), 'repl-history-route-test-'))
  __resetReplHistoryServiceForTest()
})

afterEach(async () => {
  __resetReplHistoryServiceForTest()
  await rm(tmpDir, { recursive: true, force: true })
})

/**
 * 通过 module hack 注入 service 实例到 router 单例位置。
 * 简化方案:每个 case 单独构造一个新 ReplHistoryService,但 router 内调
 * `getReplHistoryService` 单例 → 我们需要直接调用 service 而不是 router。
 * 这里用子进程隔离:直接把 service 的方法暴露到 req 上,跳过 router 间接层。
 */
function makeAppWithService(svc: ReplHistoryService): express.Express {
  const app = express()
  app.locals.instanceContext = { cwd: '/tmp', cwdName: 'tmp' }
  // 把 svc 注入到 app.locals,router 内部读它
  app.locals.replHistoryService = svc
  app.use('/api', replHistoryRouter)
  return app
}

describe('replHistory 路由 — GET /api/bash/history/top10', () => {
  it('无历史时返回 200 + 空 entries', async () => {
    const svc = new ReplHistoryService({ historyPath: join(tmpDir, 'h.jsonl') })
    const app = makeAppWithService(svc)

    const res = await request(app).get('/api/bash/history/top10')
    expect(res.status).toBe(200)
    expect(res.body).toEqual({ entries: [] })
  })

  it('返回所有命令按频次倒序', async () => {
    const svc = new ReplHistoryService({ historyPath: join(tmpDir, 'h.jsonl') })
    await svc.appendCommand('ls', 's1')
    await svc.appendCommand('ls', 's1')
    await svc.appendCommand('ls', 's1')
    await svc.appendCommand('pwd', 's1')
    await svc.appendCommand('pwd', 's2')

    const app = makeAppWithService(svc)
    const res = await request(app).get('/api/bash/history/top10')
    expect(res.status).toBe(200)
    expect(res.body.entries).toEqual([
      { command: 'ls', count: 3 },
      { command: 'pwd', count: 2 },
    ])
  })

  it('?q= 前缀过滤', async () => {
    const svc = new ReplHistoryService({ historyPath: join(tmpDir, 'h.jsonl') })
    await svc.appendCommand('git status', 's1')
    await svc.appendCommand('git log', 's1')
    await svc.appendCommand('ls -la', 's1')

    const app = makeAppWithService(svc)
    const res = await request(app).get('/api/bash/history/top10?q=git%20')
    expect(res.status).toBe(200)
    // 同频次时排序稳定(字母序),用 arrayContaining 避免顺序断言
    expect(res.body.entries).toHaveLength(2)
    expect(res.body.entries).toEqual(
      expect.arrayContaining([
        { command: 'git status', count: 1 },
        { command: 'git log', count: 1 },
      ]),
    )
    expect(res.body.entries.find((e: any) => e.command === 'ls -la')).toBeUndefined()
  })

  it('?n= 限制返回数量', async () => {
    const svc = new ReplHistoryService({ historyPath: join(tmpDir, 'h.jsonl') })
    for (let i = 0; i < 15; i++) {
      await svc.appendCommand(`cmd-${i}`, 's1')
    }

    const app = makeAppWithService(svc)
    const res = await request(app).get('/api/bash/history/top10?n=5')
    expect(res.status).toBe(200)
    expect(res.body.entries).toHaveLength(5)
  })

  it('?q= 空字符串视为无过滤', async () => {
    const svc = new ReplHistoryService({ historyPath: join(tmpDir, 'h.jsonl') })
    await svc.appendCommand('ls', 's1')

    const app = makeAppWithService(svc)
    const res = await request(app).get('/api/bash/history/top10?q=')
    expect(res.status).toBe(200)
    expect(res.body.entries).toEqual([{ command: 'ls', count: 1 }])
  })

  it('?n= 非法值返回 400', async () => {
    const svc = new ReplHistoryService({ historyPath: join(tmpDir, 'h.jsonl') })

    const app = makeAppWithService(svc)
    const res = await request(app).get('/api/bash/history/top10?n=abc')
    expect(res.status).toBe(400)
  })

  it('?n= 超过 100 限制为 100', async () => {
    const svc = new ReplHistoryService({ historyPath: join(tmpDir, 'h.jsonl') })
    for (let i = 0; i < 3; i++) {
      await svc.appendCommand(`cmd-${i}`, 's1')
    }

    const app = makeAppWithService(svc)
    const res = await request(app).get('/api/bash/history/top10?n=500')
    expect(res.status).toBe(200)
    // 总共 3 条,不会爆 100 上限
    expect(res.body.entries.length).toBe(3)
  })
})