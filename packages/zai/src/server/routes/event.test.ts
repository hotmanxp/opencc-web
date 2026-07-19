import { describe, expect, test } from 'vitest'
import express from 'express'
import request from 'supertest'
import eventRouter from './event.js'
import { eventBus } from '../services/eventBus.js'

function makeApp() {
  const app = express()
  app.use('/api', eventRouter)
  return app
}

type SseCapture = { headers: Record<string, string>; body: string }

interface CaptureOptions {
  lastEventId?: string
  /** Passed as ?sid=xxx (also via X-Session-Id header). */
  sid?: string
  /** Called once headers arrive; use to schedule emits before destroy. */
  onReady?: (helpers: { wait: () => Promise<void> }) => void
  /** Predicate that decides when to destroy the stream and resolve. */
  until?: (body: string) => boolean
  timeoutMs?: number
}

// Open SSE connection, disable supertest's buffering (SSE never ends naturally),
// and consume the response stream directly. Resolves once `until(body)` returns
// true, or after timeoutMs as a safety net.
function captureSse(app: express.Express, options: CaptureOptions = {}): Promise<SseCapture> {
  return new Promise((resolve) => {
    let body = ''
    let headers: Record<string, string> = {}
    let settled = false
    const finish = () => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolve({ headers, body })
    }
    const timer = setTimeout(finish, options.timeoutMs ?? 500)

    const req = request(app).get('/api/event').buffer(false)
    if (options.lastEventId) req.set('Last-Event-ID', options.lastEventId)
    if (options.sid) req.query({ sid: options.sid })

    req.on('response', (res) => {
      headers = res.headers as Record<string, string>
      const check = () => {
        if (options.until?.(body)) res.destroy()
      }
      res.on('data', (chunk: Buffer) => {
        body += chunk.toString()
        check()
      })
      res.on('end', () => finish())
      res.on('error', () => finish())
      // onReady runs after the response stream is set up. Use to schedule
      // emits or other side effects that should land before resolution.
      options.onReady?.({
        wait: () => new Promise((r) => setTimeout(r, 20)),
      })
    })

    req.on('error', () => finish())
    req.end()
  })
}

describe('GET /api/event', () => {
  // eventBus 是 Node 进程级单例, 各 test 共享. 用一次性 marker (含
  // Date.now() + random) 防止前面 test 残留的事件误命中下面的 until 谓词.
  test('responds with text/event-stream and writes server.connected', async () => {
    const app = makeApp()
    const { headers, body } = await captureSse(app, {
      until: (b) => b.includes('event: server.connected') && b.includes('\n\n'),
      timeoutMs: 200,
    })
    expect(headers['content-type']).toMatch(/text\/event-stream/)
    expect(body).toMatch(/event: server\.connected/)
    expect(body).toMatch(/data: /)
    expect(body).toMatch(/id: /)
  })

  test('delivers live emit to subscriber', async () => {
    const app = makeApp()
    const marker = `live-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
    const { body } = await captureSse(app, {
      until: (b) => b.includes(`"message":"${marker}"`),
      timeoutMs: 300,
      onReady: ({ wait }) => {
        // Defer emit so the route handler's `eventBus.subscribe(...)` runs first.
        wait().then(() => eventBus.emit({ type: 'server.error', message: marker }))
      },
    })
    expect(body).toMatch(/event: server\.error/)
    expect(body).toMatch(new RegExp(`data: .*"message":"${marker}"`))
  })

  test('replay when Last-Event-ID is provided and found', async () => {
    const tag = `rpl-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
    let live1Id: string | undefined
    const unsub = eventBus.subscribe((e) => {
      if (e.type === 'server.error' && 'message' in e && (e as any).message === `${tag}-live1`) {
        live1Id = e.eventId
      }
    })
    eventBus.emit({ type: 'server.error', message: `${tag}-history1` })
    eventBus.emit({ type: 'server.error', message: `${tag}-live1` })
    unsub()

    if (!live1Id) throw new Error('expected live1Id')
    const app = makeApp()
    const { body } = await captureSse(app, {
      lastEventId: live1Id,
      until: (b) => b.includes('event: server.connected') && b.includes('\n\n'),
      timeoutMs: 200,
    })

    // history1 / live1 都在 lastEventId 之前, 不应被重放
    expect(body).not.toMatch(new RegExp(`"message":"${tag}-history1"`))
    expect(body).not.toMatch(new RegExp(`"message":"${tag}-live1"`))
    // server.connected is always emitted
    expect(body).toMatch(/event: server\.connected/)
  })

  // ========== Per-sid isolation (regression: 两个 tab 互串消息) ==========

  test('带 ?sid=A 时, 只收 sid=A 的 runtime.* 事件', async () => {
    const markerA = `sA-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
    const markerB = `sB-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
    const app = makeApp()
    const { body } = await captureSse(app, {
      sid: 'A',
      until: (b) => b.includes(markerA),
      timeoutMs: 400,
      onReady: ({ wait }) => {
        // 先发 B 的 (不应当收到), 再发 A 的 (应当收到)
        wait().then(() => {
          eventBus.emit({ type: 'runtime.delta', sessionId: 'B', turnIndex: 0, delta: markerB } as any)
          eventBus.emit({ type: 'runtime.delta', sessionId: 'A', turnIndex: 0, delta: markerA } as any)
        })
      },
    })
    expect(body).toMatch(new RegExp(`data: .*"delta":"${markerA}"`))
    expect(body).not.toMatch(new RegExp(`"delta":"${markerB}"`))
  })

  test('带 ?sid=A 时, 全局事件 (server.error) 仍然照收', async () => {
    const marker = `glb-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
    const app = makeApp()
    const { body } = await captureSse(app, {
      sid: 'A',
      until: (b) => b.includes(marker),
      timeoutMs: 400,
      onReady: ({ wait }) => {
        wait().then(() => {
          eventBus.emit({ type: 'server.error', message: marker })
        })
      },
    })
    expect(body).toMatch(new RegExp(`data: .*"message":"${marker}"`))
  })

  test('带 ?sid=A 时, 其它 sid 的 job.* / prompt.ask 也不穿透', async () => {
    const askMarker = `ask-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
    const jobId = `j-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
    const app = makeApp()
    const { body } = await captureSse(app, {
      sid: 'A',
      until: (b) => b.includes('event: server.connected'),
      timeoutMs: 300,
      onReady: ({ wait }) => {
        wait().then(() => {
          eventBus.emit({ type: 'job.started', jobId, kind: 'agent_task', sessionId: 'B' } as any)
          eventBus.emit({ type: 'prompt.ask', sessionId: 'B', toolUseId: 't1', questions: [{ question: askMarker, header: 'h', options: [] }] } as any)
        })
      },
    })
    expect(body).not.toMatch(new RegExp(`"question":"${askMarker}"`))
    expect(body).not.toMatch(new RegExp(`"jobId":"${jobId}"`))
  })

  test('不带 sid (旧路径) 维持全量转发', async () => {
    const marker = `unsid-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
    const app = makeApp()
    const { body } = await captureSse(app, {
      until: (b) => b.includes(marker),
      timeoutMs: 400,
      onReady: ({ wait }) => {
        wait().then(() => {
          eventBus.emit({ type: 'runtime.delta', sessionId: 'X', turnIndex: 0, delta: marker } as any)
        })
      },
    })
    expect(body).toMatch(new RegExp(`data: .*"delta":"${marker}"`))
  })

  test('带 sid 的 replay 只补该 sid 的历史 (Last-Event-ID)', async () => {
    const sid = `rpl-sid-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
    let tailId: string | undefined
    const unsub = eventBus.subscribe((e) => {
      if (e.type === 'runtime.delta' && 'sessionId' in e && (e as any).sessionId === sid && (e as any).delta === `${sid}-tail`) {
        tailId = e.eventId
      }
    })
    eventBus.emit({ type: 'runtime.delta', sessionId: sid, turnIndex: 0, delta: `${sid}-middle` } as any)
    eventBus.emit({ type: 'runtime.delta', sessionId: sid, turnIndex: 0, delta: `${sid}-tail` } as any)
    unsub()
    if (!tailId) throw new Error('expected tailId')

    const app = makeApp()
    const { body } = await captureSse(app, {
      sid,
      lastEventId: tailId, // 续读: 不应重发 middle/tail
      until: (b) => b.includes('event: server.connected'),
      timeoutMs: 200,
    })
    expect(body).not.toMatch(new RegExp(`"delta":"${sid}-middle"`))
    expect(body).not.toMatch(new RegExp(`"delta":"${sid}-tail"`))
    expect(body).toMatch(/event: server\.connected/)
  })

  test('带 sid 重连 replay, 没找到 lastEventId → 补全该 sid 历史', async () => {
    const sid = `rpl-full-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
    eventBus.emit({ type: 'runtime.delta', sessionId: sid, turnIndex: 0, delta: `${sid}-first` } as any)
    eventBus.emit({ type: 'runtime.delta', sessionId: sid, turnIndex: 0, delta: `${sid}-second` } as any)

    const app = makeApp()
    const { body } = await captureSse(app, {
      sid,
      lastEventId: 'evt_does_not_exist', // 找不到 → 补该 sid 全量
      until: (b) => b.includes('event: server.connected'),
      timeoutMs: 200,
    })
    expect(body).toMatch(new RegExp(`"delta":"${sid}-first"`))
    expect(body).toMatch(new RegExp(`"delta":"${sid}-second"`))
  })
})