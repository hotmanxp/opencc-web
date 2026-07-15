import { Router, type IRouter, type Request, type Response } from 'express'
import { z } from 'zod'
import type { BackgroundRuntime, TaskEvent } from '@zn-ai/zai-agent-core'
import { getBackgroundRuntime } from '../services/backgroundRuntime.js'
import { writeSse, SSE_HEADERS } from '../services/sse.js'

const router: IRouter = Router()

const HEARTBEAT_MS = 15_000

const dispatchSchema = z.object({
  prompt: z.string().min(1, 'prompt 不能为空'),
  cwd: z.string().optional(),
  agent: z.string().optional(),
  model: z.string().optional(),
  metadata: z.record(z.string(), z.unknown()).optional(),
})

const listQuerySchema = z.object({
  status: z
    .enum(['queued', 'running', 'completed', 'failed', 'cancelled'])
    .optional(),
  limit: z.coerce.number().int().min(1).max(500).optional(),
})

function runtime(): BackgroundRuntime {
  return getBackgroundRuntime()
}

// POST /api/tasks — dispatch 后台任务
router.post('/tasks', async (req: Request, res: Response) => {
  const parsed = dispatchSchema.safeParse(req.body)
  if (!parsed.success) {
    return res.status(400).json({
      error: `invalid body: ${parsed.error.issues.map((i) => i.message).join('; ')}`,
    })
  }
  const task = await runtime().dispatch(parsed.data)
  return res.status(201).json({ taskId: task.id, status: task.status })
})

// GET /api/tasks — 列表,支持 ?status=&limit=
router.get('/tasks', async (req: Request, res: Response) => {
  const parsed = listQuerySchema.safeParse(req.query)
  if (!parsed.success) {
    return res.status(400).json({
      error: `invalid query: ${parsed.error.issues.map((i) => i.message).join('; ')}`,
    })
  }
  const tasks = await runtime().list(parsed.data)
  return res.json({ tasks })
})

// GET /api/tasks/:id — 任务详情
router.get('/tasks/:id', async (req: Request, res: Response) => {
  const task = await runtime().get(req.params.id)
  if (!task) return res.status(404).json({ error: 'task_not_found' })
  return res.json(task)
})

// DELETE /api/tasks/:id — 取消任务
router.delete('/tasks/:id', async (req: Request, res: Response) => {
  const result = await runtime().cancel(req.params.id, 'user cancelled')
  return res.json(result)
})

// GET /api/tasks/:id/events — SSE 流,支持 Last-Event-ID 续读
router.get('/tasks/:id/events', async (req: Request, res: Response) => {
  const id = req.params.id
  const lastEventId = req.headers['last-event-id'] as string | undefined
  const fromSeq = lastEventId ? Number(lastEventId) : 0

  const task = await runtime().get(id)
  if (!task) return res.status(404).json({ error: 'task_not_found' })

  for (const [k, v] of Object.entries(SSE_HEADERS)) res.setHeader(k, v)
  res.flushHeaders()

  const ac = new AbortController()
  req.on('close', () => ac.abort())

  const heartbeat = setInterval(() => {
    res.write(': heartbeat\n\n')
  }, HEARTBEAT_MS)

  try {
    let lastSeq = fromSeq
    for await (const ev of runtime().events(id, fromSeq, ac.signal)) {
      writeSse(res, { eventId: ev.seq, type: ev.type, ...evToWire(ev) })
      lastSeq = ev.seq
    }
    // 任务结束:发 task.ended 哨兵
    const final = await runtime().get(id)
    if (final) {
      writeSse(res, {
        eventId: lastSeq + 1,
        type: 'task.ended',
        taskId: id,
        status: final.status,
        error: final.error,
        resultText: final.resultText,
      })
    }
  } catch (err) {
    if (!(err instanceof Error) || err.name !== 'AbortError') {
      console.error('[tasks/events] stream error:', err)
    }
  } finally {
    clearInterval(heartbeat)
    res.end()
  }
})

function evToWire(ev: TaskEvent): Record<string, unknown> {
  return {
    seq: ev.seq,
    ts: ev.ts,
    eventId: ev.eventId,
    type: ev.type,
    data: ev.data,
  }
}

export default router