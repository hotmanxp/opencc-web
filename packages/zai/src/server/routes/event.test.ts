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
    // Schedule the emit from inside onReady so we know the route has already
    // registered its subscriber on eventBus.
    const { body } = await captureSse(app, {
      until: (b) => b.includes('"message":"late"'),
      timeoutMs: 300,
      onReady: ({ wait }) => {
        // Defer emit so the route handler's `eventBus.subscribe(...)` runs first.
        wait().then(() => eventBus.emit({ type: 'server.error', message: 'late' }))
      },
    })
    expect(body).toMatch(/event: server\.error/)
    expect(body).toMatch(/data: .*"message":"late"/)
  })

  test('replay when Last-Event-ID is provided and found', async () => {
    let live1Id: string | undefined
    const unsub = eventBus.subscribe((e) => {
      if (e.type === 'server.error' && 'message' in e && e.message === 'live1') {
        live1Id = e.eventId
      }
    })
    eventBus.emit({ type: 'server.error', message: 'history1' })
    eventBus.emit({ type: 'server.error', message: 'live1' })
    unsub()

    if (!live1Id) throw new Error('expected live1Id')
    const app = makeApp()
    const { body } = await captureSse(app, {
      lastEventId: live1Id,
      until: (b) => b.includes('event: server.connected') && b.includes('\n\n'),
      timeoutMs: 200,
    })

    // history1 is before live1's eventId, so not replayed
    expect(body).not.toMatch(/"message":"history1"/)
    expect(body).not.toMatch(/"message":"live1"/)
    // server.connected is always emitted
    expect(body).toMatch(/event: server\.connected/)
  })
})