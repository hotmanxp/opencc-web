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
  sendMessage: (taskId: string, prompt: string) => Promise<{ ok: boolean }>
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
 *   注意:list 返回的是简略对象(只有 id/status/description);
 *   dsh-bridge 的 listDshSubagents 也只返回这 3 字段。Phase 1 不暴露
 *   prompt/startedAt 等详细字段,UI 用 description 即可;需要时扩展
 *   dsh-bridge.listDshSubagents 走 includeDetails 开关。
 */
router.get('/subagent-tasks/:id', async (req: Request, res: Response) => {
  if (notInitialized(res)) return
  const bridge = tryGetDshBridge()!
  const id = req.params.id
  try {
    // list 当前 session 然后 filter(id 唯一),避免再增加一个 get 接口
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

export default router
