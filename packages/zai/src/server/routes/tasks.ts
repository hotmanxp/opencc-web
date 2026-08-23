import { Router, type IRouter, type Request, type Response } from 'express'
import { z } from 'zod'
import type { BackgroundRuntime, TaskEvent } from '@zn-ai/zn-agent-core'
import { tryGetBackgroundRuntime } from '../services/backgroundRuntime.js'
import { getKernelAdapter } from '../services/agentRuntime.js'
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
  const r = tryGetBackgroundRuntime()
  if (!r) throw new Error('Background runtime not initialized')
  return r
}

/**
 * B7 (dsh-009): dsh 模式下 `initBackgroundRuntime` 主动跳过 — 子任务走
 * dsh-bridge 自实现 store,不依赖 vendor `DefaultBackgroundRuntime`。这导致
 * `runtime()` 抛错是**设计预期**而非真异常,前端 TaskDrawer / TaskDock 因此
 * 抛 500 + console.warn(用户体感"页面挂")。统一在 handler 入口短路,
 * 返回 503 + 明确错误码 `{ error: 'background_runtime_unavailable', kernel }`,
 * 让前端可以识别并显示降级 UI 而不是空白抽屉。
 */
function unavailableOnDsh(res: Response): boolean {
  if (tryGetBackgroundRuntime()) return false
  let kernel = 'unknown'
  try {
    const adapter = getKernelAdapter()
    kernel = (adapter as { kernel?: string } | null)?.kernel ?? 'opencc'
  } catch {
    kernel = 'unknown'
  }
  res.status(503).json({
    error: 'background_runtime_unavailable',
    message:
      'opencc vendor BackgroundRuntime 在当前内核下未启用(子任务走 dsh-bridge 自实现路径)',
    kernel,
  })
  return true
}

// POST /api/tasks — dispatch 后台任务
router.post('/tasks', async (req: Request, res: Response) => {
  if (unavailableOnDsh(res)) return
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
  if (unavailableOnDsh(res)) return
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
  if (unavailableOnDsh(res)) return
  const task = await runtime().get(req.params.id)
  if (!task) return res.status(404).json({ error: 'task_not_found' })
  return res.json(task)
})

// DELETE /api/tasks/:id — 取消任务
router.delete('/tasks/:id', async (req: Request, res: Response) => {
  if (unavailableOnDsh(res)) return
  const result = await runtime().cancel(req.params.id, 'user cancelled')
  return res.json(result)
})

// GET /api/tasks/:id/events — SSE 流,支持 Last-Event-ID 续读
router.get('/tasks/:id/events', async (req: Request, res: Response) => {
  // dsh 模式短路:不进入 SSE 流,直接 JSON 503。前端 fetch 看到 !res.ok
  // → throw,TaskDrawer catch 后走降级 UI,不再 console.warn + 空白抽屉。
  if (unavailableOnDsh(res)) return
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
    try {
      res.write(': heartbeat\n\n')
    } catch {
      clearInterval(heartbeat)
    }
  }, HEARTBEAT_MS)

  try {
    let lastSeq = fromSeq
    for await (const ev of runtime().events(id, fromSeq, ac.signal)) {
      // ★ 关键修复 (HRMSV3-ZN-WEBSITE#668):把 ev.seq 显式作为 SSE `id:`
      // line 的值（用于 Last-Event-ID 续读），payload JSON 内保留 SDK
      // 字符串 eventId 作为业务字段。之前的写法依赖 ...spread 让
      // eventId 同时填 SSE id line 和 JSON,结果 id line 拿到的是
      // "evt-tool-1" 这种非数字,前端 parseFrame 用 Number() 强转
      // → NaN → 整个 frame 被丢弃 → TaskDrawer 永远 events.length === 0,
      // 工具调用卡片出不来（截图中 "事件: 0"、"等待事件..."）。
      const seq = ev.seq
      writeSse(res, {
        seq,
        type: ev.type,
        ...evToWire({ ...ev, seq }),
      })
      lastSeq = ev.seq
    }
    // 任务结束:发 task.ended 哨兵 (lastSeq+1 作为新 id)
    const final = await runtime().get(id)
    if (final) {
      writeSse(res, {
        seq: lastSeq + 1,
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