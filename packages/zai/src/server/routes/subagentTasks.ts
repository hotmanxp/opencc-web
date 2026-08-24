/**
 * dsh-019: dsh-mode subagent 任务 HTTP 端点。
 *
 * 与 bashTasks.ts 对称(参考其路由形态) — list / get / kill 三个端点,
 * 供 UI 单独的 Subagents tab 直接 fetch(无需走 subagent_control 工具
 * round-trip)。
 *
 * 实现走 kernel.getSeam('subagent') — 与 zai compat `subagent_control` 工具共用
 * 同一份 dsh-bridge subagent API,语义一致。
 *
 * 端点(对齐 bash-tasks 命名):
 *   GET    /api/subagent-tasks         列出 subagent 任务(可按 sessionId 过滤)
 *   GET    /api/subagent-tasks/:id     取单个任务详情
 *   POST   /api/subagent-tasks/:id/interrupt  中止运行中的任务
 *   POST   /api/subagent-tasks/:id/send-message  给运行中的子 agent 投消息
 *   POST   /api/subagent-tasks/:id/continuable   启动一个 continuable 子代理
 */

import { Router, type Request, type Response } from 'express'
import { getKernelAdapter } from '../services/agentRuntime.js'
import { MissingVendorSeamError } from '../services/kernel/seamRegistry.js'
import type { SubagentControlSeam } from '@zn-ai/dsh-bridge'

const router = Router()

/**
 * Phase 3 P0-A: 子 agent 工具调用历史。
 */
interface ToolCallEntryView {
  callId: string
  toolName: string
  input: unknown
  output?: unknown
  status: 'running' | 'done' | 'error'
  ts: number
  durationMs?: number
  error?: { name: string; code: string }
}

/**
 * Phase 2: 完整 DshTaskState 类型(从 dsh-bridge DshTaskState 镜像,
 * 用于 /:id 详情端点返回 startedAt/finishedAt/result/error/prompt 等)。
 */
interface DshTaskFull {
  taskId: string
  sessionId: string
  parentSessionId?: string
  status: 'running' | 'done' | 'failed' | 'cancelled'
  prompt: string
  startedAt: number
  finishedAt?: number
  result?: unknown
  error?: string
  toolCalls?: ToolCallEntryView[]
}

/**
 * 获取 subagent seam,不存在(opencc 模式)时返回 503。
 */
function getSeam(res: Response): SubagentControlSeam | null {
  try {
    const adapter = getKernelAdapter()
    if (!adapter.getSeam) {
      res.status(503).json({
        error: 'dsh_subagent_unavailable',
        message: 'dsh 模式 subagent API 未初始化 — 可能在 opencc 模式访问',
      })
      return null
    }
    return adapter.getSeam<SubagentControlSeam>('subagent')
  } catch (err) {
    if (err instanceof MissingVendorSeamError) {
      res.status(503).json({
        error: 'dsh_subagent_unavailable',
        message: err.message,
      })
    } else {
      res.status(500).json({
        error: 'seam_error',
        message: err instanceof Error ? err.message : String(err),
      })
    }
    return null
  }
}

/**
 * GET /api/subagent-tasks
 *   ?sessionId=xxx     过滤 parent session
 *   ?allSessions=true  跨 session 列(忽略 sessionId)— Phase 3 P0-B
 *   返回 { tasks: [{ id, status, description, parentSessionId? }] }
 */
router.get('/subagent-tasks', async (req: Request, res: Response) => {
  const seam = getSeam(res)
  if (!seam) return

  const sessionId = req.query.sessionId as string | undefined
  const allSessions = req.query.allSessions === 'true' || req.query.allSessions === '1'
  try {
    // 2026-08-24 blocker-fix: seam.list 可能因为 state.prompt 缺失的废
    // 文件触发 TypeError 在 adapter stateToSummary 处抛错;虽然
    // dsh-bridge listDshTasks 已加 shape 过滤,但为了双保险 + 单条 get
    // 路径(GET /api/subagent-tasks/:id 也可能命中同样废文件),把 list
    // 内部的 TypeError 也吞掉。
    let tasks: Awaited<ReturnType<typeof seam.list>>
    try {
      tasks = await (allSessions
        ? seam.list(undefined)
        : seam.list(sessionId || undefined))
    } catch (innerErr) {
      // 单条废文件导致整个 list 失败 → 返回空 list 而非 500,UI 走空态。
      console.warn('[subagentTasks] seam.list rejected:', innerErr)
      return res.json({ tasks: [], warning: 'list_partial_failure' })
    }

    // Phase 3 P0-B: allSessions=true 时,每条带 parentSessionId 字段供 UI 分组。
    // 用 seam.get 补全(只在 allSessions 时做 N+1 读)。
    if (allSessions) {
      const enriched = await Promise.all(
        tasks.map(async (t) => {
          try {
            const full = await seam.get(t.taskId)
            return {
              taskId: t.taskId,
              sessionId: t.sessionId,
              status: t.status,
              description: t.description,
              startedAt: t.startedAt,
              ...(full?.parentSessionId ? { parentSessionId: full.parentSessionId } : {}),
            }
          } catch {
            return t
          }
        }),
      )
      return res.json({ tasks: enriched })
    }
    return res.json({ tasks })
  } catch (err) {
    return res.status(500).json({
      error: 'list_failed',
      message: err instanceof Error ? err.message : String(err),
    })
  }
})

/**
 * GET /api/subagent-tasks/:id
 *   dsh-019 Phase 2: 用 seam.getDetail 读完整 DshTaskState(带
 *   startedAt/finishedAt/result/error/prompt + 2026-08-24 Blocker E
 *   拼入 blocks / toolCalls),找不到时返回 404。
 */
router.get('/subagent-tasks/:id', async (req: Request, res: Response) => {
  const seam = getSeam(res)
  if (!seam) return

  const id = req.params.id
  try {
    // 2026-08-24 Blocker E: seam.getDetail 是 seam.get 的超集 — 同样在
    // 废 snapshot 文件处可能抛 TypeError;加 try/catch 降级到 404 而非 500,
    // 避免单条废文件炸掉整个端点。
    let full: Awaited<ReturnType<typeof seam.getDetail>>
    try {
      full = await seam.getDetail(id)
    } catch (innerErr) {
      console.warn('[subagentTasks] seam.getDetail rejected:', innerErr)
      return res.status(404).json({ error: 'subagent_task_unreadable' })
    }
    if (!full) return res.status(404).json({ error: 'subagent_task_not_found' })
    return res.json(full)
  } catch (err) {
    return res.status(500).json({
      error: 'get_failed',
      message: err instanceof Error ? err.message : String(err),
    })
  }
})

/**
 * POST /api/subagent-tasks/:id/interrupt
 *   调 seam.cancel — 调 dsh Agent.cancel + 写盘 mark cancelled
 *   已结束的任务(cancelled/done/failed)返回 409。
 */
router.post('/subagent-tasks/:id/interrupt', async (req: Request, res: Response) => {
  const seam = getSeam(res)
  if (!seam) return

  const id = req.params.id
  try {
    // 先检查状态 — 2026-08-24 blocker-fix: seam.list() 可能因废 snapshot
    // 文件 TypeError,这里加 try/catch 降级到 404(找不到任务)。
    let all: Awaited<ReturnType<typeof seam.list>>
    try {
      all = await seam.list()
    } catch (innerErr) {
      console.warn('[subagentTasks] seam.list rejected:', innerErr)
      return res.status(404).json({ error: 'subagent_task_unreadable' })
    }
    const found = all.find((t) => t.taskId === id)
    if (!found) return res.status(404).json({ error: 'subagent_task_not_found' })
    if (found.status !== 'running') {
      return res.status(409).json({
        error: `cannot_interrupt_${found.status}`,
        message: `subagent 任务已 ${found.status}, 无法中断`,
      })
    }
    const result = await seam.cancel(id)
    if (!result.ok) {
      return res.status(500).json({ error: 'interrupt_failed' })
    }
    return res.json({ ok: true, taskId: id })
  } catch (err) {
    return res.status(500).json({
      error: 'interrupt_failed',
      message: err instanceof Error ? err.message : String(err),
    })
  }
})

/**
 * POST /api/subagent-tasks/:id/send-message
 *   dsh-019 Phase 2: 给运行中的子 agent 投消息(调 seam.sendMessage)。
 *   已结束的任务返回 409;消息太长(>8K 字符)返回 400。
 */
router.post('/subagent-tasks/:id/send-message', async (req: Request, res: Response) => {
  const seam = getSeam(res)
  if (!seam) return

  const id = req.params.id
  const body = (req.body ?? {}) as { message?: string }
  const message = typeof body.message === 'string' ? body.message : ''
  const messageLen = message.length
  if (messageLen === 0) {
    return res.status(400).json({ error: 'empty_message', message: 'message 不能为空' })
  }
  if (messageLen > 8000) {
    return res.status(400).json({
      error: 'message_too_long',
      message: `message 超过 8000 字符 (实际 ${messageLen})`,
    })
  }
  try {
    // 先检查状态 — 2026-08-24 blocker-fix: seam.list() 防御,同 interrupt 路径。
    let all: Awaited<ReturnType<typeof seam.list>>
    try {
      all = await seam.list()
    } catch (innerErr) {
      console.warn('[subagentTasks] seam.list rejected:', innerErr)
      return res.status(404).json({ error: 'subagent_task_unreadable' })
    }
    const found = all.find((t) => t.taskId === id)
    if (!found) return res.status(404).json({ error: 'subagent_task_not_found' })
    if (found.status !== 'running') {
      return res.status(409).json({
        error: `cannot_message_${found.status}`,
        message: `subagent 任务已 ${found.status}, 无法投消息`,
      })
    }
    const result = await seam.sendMessage(id, message)
    if (!result.ok) {
      return res.status(500).json({
        error: 'send_message_failed',
        message: 'unknown',
      })
    }
    return res.json({ ok: true, taskId: id, messageLen })
  } catch (err) {
    return res.status(500).json({
      error: 'send_message_failed',
      message: err instanceof Error ? err.message : String(err),
    })
  }
})

/**
 * POST /api/subagent-tasks/:id/continuable
 *   启动一个 continuable 子代理(持久多轮会话)。
 *   body: { prompt: string, childId?: string, messageId?: string }
 *   返回 { childId, messageId }
 */
router.post('/subagent-tasks/:id/continuable', async (req: Request, res: Response) => {
  const seam = getSeam(res)
  if (!seam) return

  const parentSessionId = req.params.id
  const { prompt, childId, messageId } = req.body as { prompt?: string; childId?: string; messageId?: string }
  if (!prompt) {
    return res.status(400).json({ error: 'prompt_required' })
  }
  try {
    // startContinuable is on the adapter but not in the SubagentControlSeam interface.
    // Cast to any to access it, or use a type assertion.
    const result = await (seam as unknown as {
      startContinuable(opts: {
        parentSessionId: string
        prompt: string
        childId?: string
        messageId?: string
      }): Promise<{ childId: string; messageId: string }>
    }).startContinuable({
      parentSessionId,
      prompt,
      ...(childId !== undefined ? { childId } : {}),
      ...(messageId !== undefined ? { messageId } : {}),
    })
    return res.json(result)
  } catch (err) {
    if (err instanceof MissingVendorSeamError) {
      return res.status(503).json({ error: 'dsh_subagent_unavailable', message: err.message })
    }
    return res.status(500).json({ error: 'continuable_failed', message: err instanceof Error ? err.message : String(err) })
  }
})

export default router
