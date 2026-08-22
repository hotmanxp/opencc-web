/**
 * dsh-019: dsh-mode subagent 任务 HTTP 端点。
 *
 * 与 bashTasks.ts 对称(参考其路由形态) — list / get / kill 三个端点,
 * 供 UI 单独的 Subagents tab 直接 fetch(无需走 subagent_control 工具
 * round-trip)。
 *
 * 实现走 globalThis.__zaiDshSubagentControl 桥(zai dsh factory 在
 * initDshRuntime 时注入) — 与 zai compat `subagent_control` 工具共用
 * 同一份 dsh-bridge subagent API,语义一致。
 *
 * 端点(对齐 bash-tasks 命名):
 *   GET    /api/subagent-tasks         列出 subagent 任务(可按 sessionId 过滤)
 *   GET    /api/subagent-tasks/:id     取单个任务详情
 *   POST   /api/subagent-tasks/:id/interrupt  中止运行中的任务
 *
 * Phase 1 only list/interrupt 端点(最常用);send_message 端点 UI 暂未消费,
 * 留到 Phase 2(可在 dialog 里给 LLM 续传 prompt)。
 */

import { Router, type IRouter, type Request, type Response } from 'express'

const router: IRouter = Router()

/**
 * dsh-bridge 通过 globalThis 暴露的 3 件套。
 * zai dsh factory 注入(见 factories/dsh.ts);opencc 模式不存在。
 */
interface DshSubagentControlBridge {
  list: (parentSessionId?: string) => Promise<Array<{
    id: string
    status: string
    description?: string
  }>>
  cancel: (taskId: string) => Promise<{ ok: boolean }>
  sendMessage: (taskId: string, prompt: string) => Promise<{ ok: boolean; error?: string }>
}

/**
 * dsh-019 Phase 2: 完整 DshTaskState 类型(从 dsh-bridge DshTaskState 镜像,
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
}

interface DshSubagentDetailBridge {
  /** 读 ~/.zai/tasks-dsh/<sid>.json — 返回完整 DshTaskState */
  readTask: (taskId: string) => Promise<DshTaskFull | null>
}

function tryGetDshBridge(): DshSubagentControlBridge | null {
  const fromGlobal = (globalThis as {
    __zaiDshSubagentControl?: DshSubagentControlBridge
  }).__zaiDshSubagentControl
  return fromGlobal ?? null
}

function notInitialized(res: Response): boolean {
  const bridge = tryGetDshBridge()
  if (!bridge) {
    res.status(503).json({
      error: 'dsh_subagent_unavailable',
      message: 'dsh 模式 subagent API 未初始化 — 可能在 opencc 模式访问',
    })
    return true
  }
  return false
}

function tryGetDshDetailBridge(): DshSubagentDetailBridge | null {
  const fromGlobal = (globalThis as {
    __zaiDshSubagentDetail?: DshSubagentDetailBridge
  }).__zaiDshSubagentDetail
  return fromGlobal ?? null
}

/**
 * GET /api/subagent-tasks
 *   ?sessionId=xxx  过滤 parent session
 *   返回 { tasks: [{ id, status, description, prompt? }] }
 */
router.get('/subagent-tasks', async (req: Request, res: Response) => {
  if (notInitialized(res)) return
  const bridge = tryGetDshBridge()!
  const sessionId = req.query.sessionId as string | undefined
  try {
    const tasks = await bridge.list(sessionId || undefined)
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
 *   dsh-019 Phase 2: 优先用 dsh-bridge 完整 DshTaskState(读
 *   ~/.zai/tasks-dsh/<taskId>.json,带 startedAt/finishedAt/result/error/prompt)，
 *   fallback 到 list 简略对象(只 id/status/description)。
 */
router.get('/subagent-tasks/:id', async (req: Request, res: Response) => {
  if (notInitialized(res)) return
  const id = req.params.id
  // 1. 优先读完整 DshTaskState
  const detailBridge = tryGetDshDetailBridge()
  if (detailBridge) {
    try {
      const full = await detailBridge.readTask(id)
      if (full) return res.json(full)
      // 找不到时 fallback 到 list(可能 id 拼写错误 / 子 agent 写盘前)
    } catch (err) {
      console.warn('[subagentTasks] readTask failed, falling back to list:', err)
    }
  }
  // 2. fallback: list 然后 filter(只 id/status/description 字段)
  const bridge = tryGetDshBridge()!
  try {
    const tasks = await bridge.list()
    const found = tasks.find((t) => t.id === id)
    if (!found) return res.status(404).json({ error: 'subagent_task_not_found' })
    return res.json(found)
  } catch (err) {
    return res.status(500).json({
      error: 'get_failed',
      message: err instanceof Error ? err.message : String(err),
    })
  }
})

/**
 * POST /api/subagent-tasks/:id/interrupt
 *   调 dsh-bridge.interruptDshSubagent — 调 dsh Agent.cancel + 写盘 mark cancelled
 *   已结束的任务(cancelled/done/failed)返回 409。
 */
router.post('/subagent-tasks/:id/interrupt', async (req: Request, res: Response) => {
  if (notInitialized(res)) return
  const bridge = tryGetDshBridge()!
  const id = req.params.id
  try {
    // 先检查状态
    const all = await bridge.list()
    const found = all.find((t) => t.id === id)
    if (!found) return res.status(404).json({ error: 'subagent_task_not_found' })
    if (found.status !== 'running') {
      return res.status(409).json({
        error: `cannot_interrupt_${found.status}`,
        message: `subagent 任务已 ${found.status}, 无法中断`,
      })
    }
    const result = await bridge.cancel(id)
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
 *   dsh-019 Phase 2: 给运行中的子 agent 投消息(走 dsh-bridge.sendMessageToDshSubagent,
 *   调 ctx.agents.get(sid).followup(createUserMessage))。
 *   已结束的任务返回 409;消息太长(>8K 字符)返回 400。
 */
router.post('/subagent-tasks/:id/send-message', async (req: Request, res: Response) => {
  if (notInitialized(res)) return
  const bridge = tryGetDshBridge()!
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
    // 先检查状态
    const all = await bridge.list()
    const found = all.find((t) => t.id === id)
    if (!found) return res.status(404).json({ error: 'subagent_task_not_found' })
    if (found.status !== 'running') {
      return res.status(409).json({
        error: `cannot_message_${found.status}`,
        message: `subagent 任务已 ${found.status}, 无法投消息`,
      })
    }
    const result = await bridge.sendMessage(id, message)
    if (!result.ok) {
      return res.status(500).json({
        error: 'send_message_failed',
        message: result.error ?? 'unknown',
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

export default router
