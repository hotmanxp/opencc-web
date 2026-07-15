import { Router, type IRouter, type Request, type Response } from 'express'
import type { ServerEvent } from '../../shared/events.js'
import { eventBus } from '../services/eventBus.js'
import { writeSse, SSE_HEADERS } from '../services/sse.js'

const router: IRouter = Router()
const HEARTBEAT_MS = 15_000

router.get('/event', (req: Request, res: Response) => {
  const lastEventId = req.headers['last-event-id'] as string | undefined

  for (const [k, v] of Object.entries(SSE_HEADERS)) res.setHeader(k, v)
  res.flushHeaders()

  // 1. 注册 subscriber（必须在 emit 前注册，否则 emit 时没人接收）
  const unsubscribe = eventBus.subscribe((event) => writeSse(res, event as unknown as Parameters<typeof writeSse>[1]))

  // 2. 重连补发（必须在 emit 前执行，避免 server.connected 被 replay 切片包含）
  for (const ev of eventBus.getHistoryAfter(lastEventId)) writeSse(res, ev as unknown as Parameters<typeof writeSse>[1])

  // 3. 立即发 server.connected（最后发，这样它只进入 live subscriber，不在 replay 切片中）
  eventBus.emit({ type: 'server.connected', sessionId: null })

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

export default router
