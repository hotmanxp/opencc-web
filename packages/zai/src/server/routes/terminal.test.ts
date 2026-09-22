import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import express from 'express'
import http from 'node:http'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import request from 'supertest'
import { TERMINAL_LIMITS, type TerminalFrame } from '../../shared/terminal.js'
import { TerminalUnavailableError, ptyAvailability } from '../services/terminal/PtySession.js'
import { TerminalService } from '../services/terminal/TerminalService.js'
import terminalRouter from './terminal.js'

/**
 * /api/terminal/* 路由：REST 部分走 supertest，SSE 部分必须用裸 http
 * （supertest 会等响应结束，而 SSE 永不结束）。
 */

const available = ptyAvailability().available

function makeApp(service: TerminalService | { create: () => never }): express.Express {
  const app = express()
  app.use(express.json())
  app.locals.instanceContext = { cwd: tmpdir(), cwdName: 'tmp' }
  app.locals.terminalService = service
  app.use('/api', terminalRouter)
  return app
}

/** 从 SSE 流里按序收帧的小客户端；测试用它断言帧顺序与内容。 */
class SseReader {
  readonly frames: TerminalFrame[] = []
  private readonly req: http.ClientRequest
  private buffer = ''

  constructor(port: number, path: string) {
    this.req = http.get({ host: '127.0.0.1', port, path }, (res) => {
      res.setEncoding('utf8')
      res.on('data', (chunk: string) => {
        this.buffer += chunk
        for (;;) {
          const end = this.buffer.indexOf('\n\n')
          if (end < 0) break
          const block = this.buffer.slice(0, end)
          this.buffer = this.buffer.slice(end + 2)
          const line = block.split('\n').find((l) => l.startsWith('data: '))
          if (!line) continue
          this.frames.push(JSON.parse(line.slice('data: '.length)) as TerminalFrame)
        }
      })
      res.on('error', () => undefined)
    })
    this.req.on('error', () => undefined)
  }

  /** 轮询等某一帧满足条件。 */
  async waitFor(predicate: (frames: TerminalFrame[]) => boolean, timeoutMs = 10_000): Promise<void> {
    const deadline = Date.now() + timeoutMs
    while (Date.now() < deadline) {
      if (predicate(this.frames)) return
      await new Promise((resolve) => setTimeout(resolve, 25))
    }
    throw new Error(`timed out; frames=${JSON.stringify(this.frames).slice(0, 400)}`)
  }

  close(): void {
    this.req.destroy()
  }
}

describe.skipIf(!available)('terminal routes', () => {
  let service: TerminalService
  let app: express.Express
  let shellPath: string

  beforeEach(() => {
    service = new TerminalService()
    app = makeApp(service)
    const shells = service.shells()
    shellPath = (shells.find((s) => s.name === 'bash') ?? shells[0]).path
  })

  afterEach(async () => {
    await service.disposeAll()
  })

  const create = (id: string, sessionId = 's1', extra: Record<string, unknown> = {}) => ({
    sessionId,
    id,
    cols: 80,
    rows: 24,
    shellPath,
    cwd: tmpdir(),
    ...extra,
  })

  it('GET /terminal/environment 返回 cwd 与上限', async () => {
    const res = await request(app).get('/api/terminal/environment').expect(200)
    expect(res.body.available).toBe(true)
    expect(res.body.maxTerminals).toBe(TERMINAL_LIMITS.maxTerminals)
    expect(res.body.maxCols).toBe(TERMINAL_LIMITS.maxCols)
  })

  it('GET /terminal/shells 返回已安装 shell', async () => {
    const res = await request(app).get('/api/terminal/shells').expect(200)
    expect(Array.isArray(res.body.shells)).toBe(true)
    expect(res.body.shells.length).toBeGreaterThan(0)
  })

  it('POST /terminal/create 建终端；非法 body → 400', async () => {
    const res = await request(app).post('/api/terminal/create').send(create('t-1')).expect(200)
    expect(res.body.id).toBe('t-1')
    expect(res.body.state).toBe('running')
    await request(app).post('/api/terminal/create').send({ sessionId: 's1', id: 'bad id!' }).expect(400)
    await request(app).post('/api/terminal/create').send({ ...create('t-2'), cols: 9999 }).expect(400)
  })

  it('GET /terminal/list 返回该会话的终端，刷新后可据此重建 tab', async () => {
    await request(app).post('/api/terminal/create').send(create('t-3')).expect(200)
    const res = await request(app).get('/api/terminal/list?sessionId=s1').expect(200)
    expect(res.body.terminals.map((t: { id: string }) => t.id)).toEqual(['t-3'])
    await request(app).get('/api/terminal/list').expect(400)
  })

  it('write / resize / rename 落到终端；未知 id → 404', async () => {
    await request(app).post('/api/terminal/create').send(create('t-4')).expect(200)
    await request(app).post('/api/terminal/t-4/write?sessionId=s1').send({ data: 'echo hi\r' }).expect(200)
    await request(app).post('/api/terminal/t-4/resize?sessionId=s1').send({ cols: 120, rows: 40 }).expect(200)
    await request(app).post('/api/terminal/t-4/rename?sessionId=s1').send({ title: '构建' }).expect(200)
    const info = service.list('s1')[0]
    expect([info.cols, info.rows, info.title]).toEqual([120, 40, '构建'])
    await request(app).post('/api/terminal/t-nope/write?sessionId=s1').send({ data: 'x' }).expect(404)
    await request(app).post('/api/terminal/t-4/write').send({ data: 'x' }).expect(400)
    await request(app).post('/api/terminal/t-4/rename?sessionId=s1').send({ title: '' }).expect(400)
  })

  it('close 关闭终端并拒绝同 id 复活；重复 close 成功', async () => {
    await request(app).post('/api/terminal/create').send(create('t-5')).expect(200)
    await request(app).post('/api/terminal/t-5/close?sessionId=s1').expect(200)
    await request(app).post('/api/terminal/t-5/close?sessionId=s1').expect(200)
    await request(app).post('/api/terminal/create').send(create('t-5')).expect(409)
  })

  it('over maxTerminals → 409', async () => {
    for (let i = 0; i < TERMINAL_LIMITS.maxTerminals; i++) {
      await request(app).post('/api/terminal/create').send(create(`t-many-${i}`)).expect(200)
    }
    const res = await request(app).post('/api/terminal/create').send(create('t-over')).expect(409)
    expect(res.body.error).toContain('最多')
  })

  it('node-pty 不可用时 create → 503（带安装提示）', async () => {
    const unavailable = {
      create: () => {
        throw new TerminalUnavailableError('node-pty 未能加载')
      },
    }
    const res = await request(makeApp(unavailable)).post('/api/terminal/create').send(create('t-503')).expect(503)
    expect(res.body.hint).toContain('pnpm install')
  })

  it('SSE 首帧是 snapshot，之后推 output；断开不杀终端', async () => {
    await request(app).post('/api/terminal/create').send(create('t-sse')).expect(200)
    const server = app.listen(0)
    const port = (server.address() as AddressInfo).port
    const reader = new SseReader(port, '/api/terminal/t-sse/events?sessionId=s1')
    try {
      await reader.waitFor((frames) => frames.length > 0)
      expect(reader.frames[0].type).toBe('snapshot')

      await request(app).post('/api/terminal/t-sse/write?sessionId=s1').send({ data: 'echo SSE-ZAI\r' }).expect(200)
      await reader.waitFor((frames) =>
        frames.some((f) => f.type === 'output' && f.data.includes('SSE-ZAI')),
      )

      reader.close()
      await new Promise((resolve) => setTimeout(resolve, 100))
      // 断开只解绑 follower：终端仍是 running。
      expect(service.list('s1')[0].state).toBe('running')
    } finally {
      reader.close()
      server.close()
    }
  })

  it('SSE 缺 sessionId → 400；未知终端 → 404', async () => {
    await request(app).get('/api/terminal/t-x/events').expect(400)
    await request(app).get('/api/terminal/t-x/events?sessionId=s1').expect(404)
  })
})