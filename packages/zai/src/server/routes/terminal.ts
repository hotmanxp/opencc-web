import { Router, type IRouter } from 'express'
import {
  CreateTerminalSchema,
  RenameTerminalSchema,
  ResizeTerminalSchema,
  TerminalSessionQuerySchema,
  WriteTerminalSchema,
  type TerminalFrame,
} from '../../shared/terminal.js'
import type { SseEvent } from '../../shared/types.js'
import {
  TerminalClosedError,
  TerminalInputTooLargeError,
  TerminalNotFoundError,
  TerminalShellUnavailableError,
  TerminalUnavailableError,
} from '../services/terminal/PtySession.js'
import { getTerminalService, type TerminalService } from '../services/terminal/TerminalService.js'
import { createSseStream } from './stream.js'

/**
 * 用户侧持久 PTY 终端（分屏 Bash 面板）。
 * Spec: docs/superpowers/specs/2026-09-22-zai-pty-terminal-design.md
 *
 * REST + SSE（与 /api/bash/repl 同一套约定）：命令走 POST，输出走
 * `GET /terminal/:id/events` 的 SSE 流（首帧是整屏 snapshot）。
 */
const router: IRouter = Router()

/** 测试可注入 app.locals.terminalService；生产用单例。 */
function resolveService(req: any): TerminalService {
  return req.app?.locals?.terminalService ?? getTerminalService()
}

function defaultCwd(req: any): string {
  const ctx = req.app?.locals?.instanceContext
  return ctx?.cwd ?? process.cwd()
}

function sendError(res: any, err: unknown): void {
  if (err instanceof TerminalNotFoundError) {
    res.status(404).json({ error: err.message })
    return
  }
  if (err instanceof TerminalUnavailableError) {
    res.status(503).json({ error: err.message, hint: err.hint })
    return
  }
  if (err instanceof TerminalClosedError) {
    res.status(409).json({ error: err.message })
    return
  }
  if (err instanceof TerminalInputTooLargeError || err instanceof TerminalShellUnavailableError) {
    res.status(400).json({ error: err.message })
    return
  }
  res.status(500).json({ error: (err as Error)?.message ?? String(err) })
}

/** 能力与上限；node-pty 装不上时前端据此禁用面板。 */
router.get('/terminal/environment', (req, res) => {
  const cwd = typeof req.query.cwd === 'string' && req.query.cwd ? req.query.cwd : defaultCwd(req)
  res.json(resolveService(req).environment(cwd))
})

/** `+` 菜单用的已安装 shell 列表。 */
router.get('/terminal/shells', (req, res) => {
  res.json({ shells: resolveService(req).shells() })
})

/** 刷新后重建 tab：该会话保留的终端（含已退出的）。 */
router.get('/terminal/list', (req, res) => {
  const parsed = TerminalSessionQuerySchema.safeParse(req.query)
  if (!parsed.success) {
    res.status(400).json({ error: 'invalid query: need {sessionId}' })
    return
  }
  res.json({ terminals: resolveService(req).list(parsed.data.sessionId) })
})

router.post('/terminal/create', (req, res) => {
  const parsed = CreateTerminalSchema.safeParse(req.body)
  if (!parsed.success) {
    res.status(400).json({ error: 'invalid body: need {sessionId, id, cols, rows}' })
    return
  }
  try {
    res.json(resolveService(req).create(parsed.data))
  } catch (err) {
    sendError(res, err)
  }
})

router.post('/terminal/:id/write', (req, res) => {
  const parsed = WriteTerminalSchema.safeParse(req.body)
  const sessionId = typeof req.query.sessionId === 'string' ? req.query.sessionId : undefined
  if (!parsed.success || sessionId === undefined) {
    res.status(400).json({ error: 'invalid body: need {data} and ?sessionId=' })
    return
  }
  try {
    resolveService(req).write(sessionId, req.params.id, parsed.data.data)
    res.json({ ok: true })
  } catch (err) {
    sendError(res, err)
  }
})

router.post('/terminal/:id/resize', (req, res) => {
  const parsed = ResizeTerminalSchema.safeParse(req.body)
  const sessionId = typeof req.query.sessionId === 'string' ? req.query.sessionId : undefined
  if (!parsed.success || sessionId === undefined) {
    res.status(400).json({ error: 'invalid body: need {cols, rows} and ?sessionId=' })
    return
  }
  void resolveService(req)
    .resize(sessionId, req.params.id, parsed.data.cols, parsed.data.rows)
    .then(() => {
      res.json({ ok: true })
    })
    .catch((err: unknown) => {
      sendError(res, err)
    })
})

router.post('/terminal/:id/rename', (req, res) => {
  const parsed = RenameTerminalSchema.safeParse(req.body)
  const sessionId = typeof req.query.sessionId === 'string' ? req.query.sessionId : undefined
  if (!parsed.success || sessionId === undefined) {
    res.status(400).json({ error: 'invalid body: need {title} (1-120 chars) and ?sessionId=' })
    return
  }
  try {
    resolveService(req).rename(sessionId, req.params.id, parsed.data.title)
    res.json({ ok: true })
  } catch (err) {
    sendError(res, err)
  }
})

router.post('/terminal/:id/close', (req, res) => {
  const sessionId = typeof req.query.sessionId === 'string' ? req.query.sessionId : undefined
  if (sessionId === undefined) {
    res.status(400).json({ error: 'invalid query: need ?sessionId=' })
    return
  }
  void resolveService(req)
    .close(sessionId, req.params.id)
    .then(() => {
      res.json({ ok: true })
    })
    .catch((err: unknown) => {
      sendError(res, err)
    })
})

/**
 * 输出流：首帧 `snapshot`（整屏恢复），随后按序 `output` / `state`。
 * 断开本连接**不**杀终端（收起分屏/切 tab/刷新都还活着）。
 */
router.get('/terminal/:id/events', async (req, res) => {
  const parsed = TerminalSessionQuerySchema.safeParse(req.query)
  if (!parsed.success) {
    res.status(400).json({ error: 'invalid query: need {sessionId}' })
    return
  }
  const service = resolveService(req)
  let session
  try {
    session = service.get(parsed.data.sessionId, req.params.id)
  } catch (err) {
    sendError(res, err)
    return
  }

  const stream = createSseStream(res)
  // SseEvent 是 bash REPL 专用的窄联合；终端帧结构不同，这里只借用 SSE 写线格式。
  const send = (frame: TerminalFrame): void => {
    if (res.writableEnded) return
    stream.send(frame as unknown as SseEvent)
  }
  const heartbeat = setInterval(() => {
    if (!res.writableEnded) res.write(`: heartbeat ${Date.now()}\n\n`)
  }, 15_000)
  const controller = new AbortController()
  req.on('close', () => {
    clearInterval(heartbeat)
    controller.abort()
  })

  try {
    for await (const frame of session.follow(controller.signal)) {
      send(frame)
    }
  } catch (err) {
    // follower 消费过慢被主动断开：推一条 error 帧，前端提示重连（重连即拿到新快照）。
    send({ type: 'error', message: (err as Error)?.message ?? String(err) })
  } finally {
    clearInterval(heartbeat)
    if (!res.writableEnded) stream.end()
  }
})

export default router