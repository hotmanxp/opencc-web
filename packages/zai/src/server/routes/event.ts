import { Router, type IRouter, type Request, type Response } from 'express'
import type { ServerEvent } from '../../shared/events.js'
import { eventBus } from '../services/eventBus.js'
import { writeSse, SSE_HEADERS } from '../services/sse.js'

const router: IRouter = Router()
const HEARTBEAT_MS = 15_000

// 从 query / header 里拿 wantedSid. query 优先 (EventSource URL 友好:
// EventSource 自带重连时浏览器会重发 ?sid=xxx; header 是 fetch 兼容路径).
// 两个都缺 → 维持旧行为 (全量转发, 给非 Agent 页面比如 /system /install 等用).
function readWantedSid(req: Request): string | null {
  const q = req.query.sid
  if (typeof q === 'string' && q.length > 0) return q
  const h = req.headers['x-session-id']
  if (typeof h === 'string' && h.length > 0) return h
  return null
}

router.get('/event', (req: Request, res: Response) => {
  const lastEventId = req.headers['last-event-id'] as string | undefined
  const wantedSid = readWantedSid(req)

  for (const [k, v] of Object.entries(SSE_HEADERS)) res.setHeader(k, v)
  res.flushHeaders()

  // 1. 注册 subscriber (必须在 emit 前注册, 否则 emit 时没人接收)
  //    wantedSid 非空 → subscribeScoped, 自动按 sid filter;
  //    wantedSid 为空 → 走老路径, 全量转发 (兼容非 Agent 页面).
  const unsubscribe = wantedSid
    ? eventBus.subscribeScoped(wantedSid, (event) =>
        writeSse(res, event as unknown as Parameters<typeof writeSse>[1]),
      )
    : eventBus.subscribe((event) =>
        writeSse(res, event as unknown as Parameters<typeof writeSse>[1]),
      )

  // 2. 重连补发 (必须在 emit 前执行, 避免 server.connected 被 replay 切片包含)
  //    有 sid → 走 per-sid 切片; 无 sid → 走全局历史 (旧行为).
  if (wantedSid) {
    for (const ev of eventBus.getHistoryAfterForSid(lastEventId, wantedSid)) {
      writeSse(res, ev as unknown as Parameters<typeof writeSse>[1])
    }
  } else {
    for (const ev of eventBus.getHistoryAfter(lastEventId)) {
      writeSse(res, ev as unknown as Parameters<typeof writeSse>[1])
    }
  }

  // 3. 立即发 server.connected (最后发, 这样它只进入 live subscriber, 不在 replay 切片中)
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