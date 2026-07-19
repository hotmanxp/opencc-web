import { Router, type IRouter, type Request, type Response } from 'express'
import type { ServerEvent } from '../../shared/events.js'
import { eventBus, ServerEventBus } from '../services/eventBus.js'
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

// 从 query 读 topics (csv). 缺省 / 空 = 订阅全量.
function readWantedTopics(req: Request): string[] {
  const q = req.query.topics
  if (typeof q !== 'string' || q.length === 0) return []
  return q.split(',').map((s) => s.trim()).filter(Boolean)
}

router.get('/event', (req: Request, res: Response) => {
  const lastEventId = req.headers['last-event-id'] as string | undefined
  const wantedSid = readWantedSid(req)
  const wantedTopics = readWantedTopics(req)

  for (const [k, v] of Object.entries(SSE_HEADERS)) res.setHeader(k, v)
  res.flushHeaders()

  // 1. 注册 subscriber (必须在 emit 前注册, 否则 emit 时没人接收).
  //    4 分支:
  //    - 有 topics + 有 sid → subscribeTopics(sid, topics, ...)
  //    - 有 topics + 无 sid → subscribeTopics(null, topics, ...)
  //    - 无 topics + 有 sid → subscribeScoped (旧行为)
  //    - 无 topics + 无 sid → subscribe (旧行为, 兼容非 Agent 页面)
  const writeEvent = (event: ServerEvent) =>
    writeSse(res, event as unknown as Parameters<typeof writeSse>[1])

  let unsubscribe: () => void
  if (wantedTopics.length > 0) {
    unsubscribe = eventBus.subscribeTopics(wantedSid, wantedTopics, writeEvent)
  } else if (wantedSid) {
    unsubscribe = eventBus.subscribeScoped(wantedSid, writeEvent)
  } else {
    unsubscribe = eventBus.subscribe(writeEvent)
  }

  // 2. 重连补发 (必须在 emit 前执行, 避免 server.connected 被 replay 切片包含).
  //    topics 同样 apply 到 replay:
  //    - 有 topics + 有 sid → getHistoryAfterForSidWithTopics
  //    - 有 topics + 无 sid → getHistoryAfter + topicMatches 过滤
  //    - 无 topics + 有 sid → getHistoryAfterForSid (旧行为)
  //    - 无 topics + 无 sid → getHistoryAfter (旧行为)
  if (wantedSid && wantedTopics.length > 0) {
    for (const ev of eventBus.getHistoryAfterForSidWithTopics(lastEventId, wantedSid, wantedTopics)) {
      writeSse(res, ev as unknown as Parameters<typeof writeSse>[1])
    }
  } else if (wantedSid) {
    for (const ev of eventBus.getHistoryAfterForSid(lastEventId, wantedSid)) {
      writeSse(res, ev as unknown as Parameters<typeof writeSse>[1])
    }
  } else if (wantedTopics.length > 0) {
    const hist = eventBus.getHistoryAfter(lastEventId)
    for (const ev of hist) {
      if (ServerEventBus.topicMatches(ev.type, wantedTopics)) {
        writeSse(res, ev as unknown as Parameters<typeof writeSse>[1])
      }
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