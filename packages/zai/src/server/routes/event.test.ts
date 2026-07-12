import { afterEach, describe, expect, test, vi } from 'vitest'
import express from 'express'
import request from 'supertest'
import eventRouter from './event.js'
import { eventBus } from '../services/eventBus.js'

function makeApp() {
  const app = express()
  app.use('/api', eventRouter)
  return app
}

describe('GET /api/event', () => {
  afterEach(() => {
    vi.useRealTimers()
  })

  test('responds with text/event-stream and writes server.connected', (done) => {
    const app = makeApp()
    request(app)
      .get('/api/event')
      .end((err, res) => {
        if (err) return done(err)
        expect(res.headers['content-type']).toMatch(/text\/event-stream/)
        expect(res.text).toMatch(/event: server\.connected/)
        expect(res.text).toMatch(/data: /)
        expect(res.text).toMatch(/id: /)
        done()
      })
  })

  test('delivers live emit to subscriber', (done) => {
    const app = makeApp()
    request(app)
      .get('/api/event')
      .end((err, res) => {
        if (err) return done(err)
        eventBus.emit({ type: 'server.error', message: 'late' })
        expect(res.text).toMatch(/event: server\.error/)
        expect(res.text).toMatch(/data: .*"message":"late"/)
        done()
      })
  })

  test('replay when Last-Event-ID is provided and found', (done) => {
    // Capture eventIds
    let live1Id: string | undefined
    const unsub = eventBus.subscribe((e) => {
      if (e.type === 'server.error' && 'message' in e && e.message === 'live1') {
        live1Id = e.eventId
      }
    })
    eventBus.emit({ type: 'server.error', message: 'history1' })
    eventBus.emit({ type: 'server.error', message: 'live1' })
    unsub()

    const app = makeApp()
    request(app)
      .get('/api/event')
      .set('Last-Event-ID', live1Id)
      .end((err, res) => {
        if (err) return done(err)
        // history1 is before live1's eventId, so not replayed
        expect(res.text).not.toMatch(/"message":"history1"/)
        expect(res.text).not.toMatch(/"message":"live1"/)
        // server.connected is always emitted
        expect(res.text).toMatch(/event: server\.connected/)
        done()
      })
  })
})
