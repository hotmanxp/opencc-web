import { Router, type IRouter, type Request, type Response } from 'express'
import { bashBackgroundTracker } from '@zn-ai/zai-agent-core/bashTracker'

const router: IRouter = Router()

// GET /api/bash-tasks — 列出所有后台 Bash 任务
router.get('/bash-tasks', async (req: Request, res: Response) => {
  const sessionId = req.query.sessionId as string | undefined
  const limit = req.query.limit ? Number(req.query.limit) : undefined
  const tasks = bashBackgroundTracker.list({
    sessionId: sessionId || undefined,
    limit: limit && limit > 0 ? limit : undefined,
  })
  return res.json({ tasks })
})

// GET /api/bash-tasks/:id — 获取单个 Bash 任务详情
router.get('/bash-tasks/:id', async (req: Request, res: Response) => {
  const task = bashBackgroundTracker.get(req.params.id)
  if (!task) return res.status(404).json({ error: 'bash_task_not_found' })
  return res.json(task)
})

// POST /api/bash-tasks/:id/kill — 结束运行中的 Bash 任务
// 先发 SIGTERM, 1s 兜底 SIGKILL. 对已完成 / 不存在的任务返回 404 或 409.
router.post('/bash-tasks/:id/kill', async (req: Request, res: Response) => {
  const task = bashBackgroundTracker.get(req.params.id)
  if (!task) return res.status(404).json({ error: 'bash_task_not_found' })
  if (task.status !== 'running') {
    return res.status(409).json({
      error: `cannot_kill_${task.status}`,
      message: `任务已 ${task.status}, 无法终止`,
    })
  }
  const result = bashBackgroundTracker.kill(req.params.id)
  if (!result || !result.ok) {
    return res.status(500).json({ error: 'kill_failed', message: '向子进程发送终止信号失败' })
  }
  return res.json({ ok: true, signal: result.signal, task: bashBackgroundTracker.get(req.params.id) })
})

export default router