import { Router, type IRouter, type Request, type Response } from 'express'
import { CwdStore } from '@zn-ai/zai-agent-core/runtime'
import { getTaskListStore } from '@zn-ai/zai-agent-core/taskListStore'
import { bashBackgroundTracker } from '@zn-ai/zai-agent-core/bashTracker'
import { getBackgroundRuntime } from '../services/backgroundRuntime.js'

const router: IRouter = Router()

interface V2TaskItemWire {
  id: string
  subject: string
  description?: string
  activeForm?: string
  status: string
  blocks: string[]
  blockedBy: string[]
  owner?: string
  updatedAt: number
}

function trimV2Task(t: {
  id: string
  subject: string
  description?: string
  activeForm?: string
  status: string
  blocks: string[]
  blockedBy: string[]
  owner?: string
  updatedAt: number
}): V2TaskItemWire {
  return {
    id: t.id,
    subject: t.subject,
    description: t.description,
    activeForm: t.activeForm,
    status: t.status,
    blocks: t.blocks,
    blockedBy: t.blockedBy,
    owner: t.owner,
    updatedAt: t.updatedAt,
  }
}

/**
 * GET /api/agent/sessions/:id/state
 *
 * 返回 session 当前的 cold-start 快照 (cwd + v2 tasks + bash tasks + agent tasks),
 * 给前端 useAgentStore.hydrateSessionState(sid) 用,填补 SSE 第一条 *.changed 到达前
 * 的 UI 空窗。任一字段失败 → 静默降级 (null / []),不影响其它字段。
 *
 * SSE 仍是 source of truth — 这个端点只在首次打开/切换 session 时被调用一次,
 * 后续 SSE 推送的 state.* 事件会通过现有 reducer 覆盖写入 store。
 *
 * 详见 docs/superpowers/specs/2026-07-23-session-cold-state-design.md。
 */
router.get('/agent/sessions/:id/state', async (req: Request, res: Response) => {
  const sid = req.params.id

  const [cwdResult, v2Result, bashResult, agentResult] = await Promise.all([
    Promise.resolve()
      .then(() => {
        // CwdStore 不存 updatedAt, 用 Date.now() 占位 — 服务端重启后 cwd
        // 全清, 这个 updatedAt 只用于客户端去重/debug, 精度不重要。
        const cwd = CwdStore.has(sid) ? CwdStore.get(sid) : null
        return cwd ? { cwd, updatedAt: Date.now() } : null
      })
      .catch((err: unknown) => {
        console.warn('[sessionState] cwd failed', err)
        return null
      }),

    getTaskListStore()
      .list(sid)
      .then((tasks) => tasks.map(trimV2Task))
      .catch((err: unknown) => {
        console.warn('[sessionState] v2 failed', err)
        return [] as V2TaskItemWire[]
      }),

    Promise.resolve()
      .then(() => bashBackgroundTracker.list({ sessionId: sid }))
      .catch((err: unknown) => {
        console.warn('[sessionState] bash failed', err)
        return []
      }),

    getBackgroundRuntime()
      .list()
      .then((all) => all.filter((t) => t.parentSessionId === sid))
      .catch((err: unknown) => {
        console.warn('[sessionState] agent failed', err)
        return []
      }),
  ])

  res.json({
    cwd: cwdResult,
    v2Tasks: v2Result,
    bashTasks: bashResult,
    agentTasks: agentResult,
  })
})

export default router
