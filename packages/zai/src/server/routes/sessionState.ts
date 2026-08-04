import { Router, type IRouter, type Request, type Response } from 'express'
import { CwdStore } from '@zn-ai/zn-agent-core/runtime'
import { getTaskListStore } from '@zn-ai/zn-agent-core/taskListStore'
import { bashBackgroundTracker } from '@zn-ai/zn-agent-core/bashTracker'
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
      .then((tasks) => {
        if (tasks.length > 0) return tasks.map(trimV2Task)
        // Fallback: read from vendor's task storage (~/.zai/tasks/<sid>/<id>.json)
        // when the compat TaskListStore file (~/.zai/tasks/<sid>.json) is empty.
        // This happens when tasks were created by the vendor's TaskCreate tool
        // (opencc-src) and the page hasn't received SSE v2_task.changed yet.
        return loadVendorV2Tasks(sid)
      })
      .catch((err: unknown) => {
        console.warn('[sessionState] v2 failed', err)
        return loadVendorV2Tasks(sid)
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

/**
 * Fallback: load tasks from the vendor's task storage (~/.zai/tasks/<sid>/<id>.json).
 * The vendor's TaskCreate/Update tools store tasks as individual JSON files per task,
 * while the compat TaskListStore uses a single JSON file per session. When the page
 * refreshes, the compat store may be empty but the vendor store has the data.
 *
 * Dynamically imports the opencc-core bundle to call the vendor's listTasks().
 */
async function loadVendorV2Tasks(sid: string): Promise<V2TaskItemWire[]> {
  try {
    // @ts-expect-error — opencc-core.mjs has no d.ts, but IS available at runtime
    const bundle = (await import('@zn-ai/zn-agent-core/opencc-core')) as {
      listTasks?: (taskListId: string) => Promise<Array<{
        id: string; subject: string; description?: string; activeForm?: string;
        status: string; blocks?: string[]; blockedBy?: string[]; owner?: string
      }>>
    }
    if (typeof bundle.listTasks !== 'function') return []
    const vendorTasks = await bundle.listTasks(sid)
    return vendorTasks.map((t) => ({
      id: t.id,
      subject: t.subject,
      description: t.description,
      activeForm: t.activeForm,
      status: t.status,
      blocks: t.blocks ?? [],
      blockedBy: t.blockedBy ?? [],
      owner: t.owner,
      updatedAt: Date.now(),
    }))
  } catch (err) {
    console.warn('[sessionState] vendor v2 task fallback failed', err)
    return []
  }
}
