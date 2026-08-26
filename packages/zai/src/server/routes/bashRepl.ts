import { Router, type IRouter } from 'express'
import { z } from 'zod'
import { getReplRegistry } from '../services/repl/ReplRegistry.js'
import { getReplHistoryService } from '../services/repl/ReplHistoryService.js'
import { createSseStream } from './stream.js'
import type { ExecRequest } from '../../shared/repl.js'

const router: IRouter = Router()

const ExecSchema = z.object({
  command: z.string().min(1),
  cwd: z.string().optional(),
})

function defaultCwd(req: any): string {
  // instanceContext 来自 createApp — 通过 app.locals 注入。
  const ctx = req.app?.locals?.instanceContext
  return ctx?.cwd ?? process.cwd()
}

/**
 * 解析 historyService:测试可注入 app.locals.replHistoryService;生产用单例。
 * 与 replHistory.ts 的 resolveService 保持一致。
 */
function resolveHistoryService(req: any) {
  return req.app?.locals?.replHistoryService ?? getReplHistoryService()
}

router.post('/bash/repl/:sessionId/exec', async (req, res) => {
  const parsed = ExecSchema.safeParse(req.body)
  if (!parsed.success) {
    return res.status(400).json({ error: 'invalid body: need {command}' })
  }
  const { command, cwd } = parsed.data
  const sessionId = req.params.sessionId
  // wait 模式: ?wait=1 / ?wait=true。fire-and-forget(默认)立即返回 execId;
  // wait 模式 await child 完成后返回 code/signal/durationMs,MobileQuickDrawer 用。
  // 注意:SSE events 推送不受 wait 影响 — 走的是独立 event bus。
  const wait = req.body?.wait === true || req.query?.wait === '1' || req.query?.wait === 'true'
  const reg = getReplRegistry()
  const session = reg.get(sessionId, cwd ?? defaultCwd(req), {
    historyService: resolveHistoryService(req),
  })

  try {
    const { execId, startedAt, completion } = await session.exec(command, sessionId, cwd ? { cwd } : {})
    if (!wait) {
      return res.json({ ok: true, execId, startedAt })
    }
    // wait 模式:等 child 真实终态,补充 code/signal/finishedAt/durationMs 字段。
    // client 在这里长连接,直到 child 跑完(可能很慢,如 sleep 60)。
    const { code, signal, finishedAt, durationMs } = await completion
    return res.json({
      ok: true,
      execId,
      startedAt,
      finishedAt,
      code,
      signal,
      durationMs,
    })
  } catch (err: any) {
    if (err?.name === 'ReplBusyError') {
      return res.status(409).json({ ok: false, busy: true, currentExecId: err.currentExecId })
    }
    if (err?.name === 'ReplSpawnError') {
      return res.status(500).json({ error: err.message })
    }
    return res.status(500).json({ error: (err as Error).message })
  }
})

router.get('/bash/repl/:sessionId/events', (req, res) => {
  const sessionId = req.params.sessionId
  const reg = getReplRegistry()
  const session = reg.get(sessionId, defaultCwd(req))
  const stream = createSseStream(res)

  // 15s 心跳保活，防止代理 / 浏览器在静默期间断开 EventSource。
  const heartbeat = setInterval(() => {
    res.write(`: heartbeat ${Date.now()}\n\n`)
  }, 15_000)

  const handler = (ev: unknown) => {
    stream.send(ev as any)
  }
  session.on('event', handler)

  req.on('close', () => {
    clearInterval(heartbeat)
    session.off('event', handler)
    // 不调 stream.end() — res 已被 socket 关闭
  })
})

router.post('/bash/repl/:sessionId/abort', (req, res) => {
  const sessionId = req.params.sessionId
  const reg = getReplRegistry()
  const session = reg.get(sessionId, defaultCwd(req))
  if (!session.busy) {
    return res.status(409).json({ error: 'no command running' })
  }
  session.abort()
  return res.json({ ok: true })
})

export default router