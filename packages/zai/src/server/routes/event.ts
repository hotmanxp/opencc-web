import { Router, type IRouter, type Request, type Response } from 'express'
import type { ServerEvent } from '../../shared/events.js'
import { eventBus } from '../services/eventBus.js'

const router: IRouter = Router()
const HEARTBEAT_MS = 15_000

router.get('/event', (req: Request, res: Response) => {
  const lastEventId = req.headers['last-event-id'] as string | undefined

  res.setHeader('Content-Type', 'text/event-stream')
  res.setHeader('Cache-Control', 'no-cache, no-transform')
  res.setHeader('Connection', 'keep-alive')
  res.setHeader('X-Accel-Buffering', 'no')
  res.flushHeaders()

  // 1. 立即发 server.connected
  eventBus.emit({ type: 'server.connected', sessionId: null })

  // 2. 重连补发
  for (const ev of eventBus.getHistoryAfter(lastEventId)) writeSse(res, ev)

  // 3. 注册为新 subscriber
  const unsubscribe = eventBus.subscribe((event) => writeSse(res, event))

  // 4. 心跳
  const heartbeat = setInterval(() => {
    res.write(': heartbeat\n\n')
  }, HEARTBEAT_MS)

  req.on('close', () => {
    clearInterval(heartbeat)
    unsubscribe()
    res.end()
  })
})

function writeSse(res: Response, event: ServerEvent) {
  res.write(`id: ${event.eventId}\n`)
  res.write(`event: ${event.type}\n`)
  res.write(`data: ${JSON.stringify(event)}\n\n`)
}

export default router
