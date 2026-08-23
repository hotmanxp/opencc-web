import { Router, type IRouter, type Request, type Response } from 'express'
import {
  CwdStore,
  getTaskListStore,
  bashBackgroundTracker,
} from '@zn-ai/zn-agent-core'
import { getBackgroundRuntime } from '../services/backgroundRuntime.js'
import { getKernelAdapter } from '../services/agentRuntime.js'
import { getDshHandleForTranscript } from '../services/kernel/factories/dsh.js'
import { snapshotDshTodo } from '@zn-ai/dsh-bridge'

/**
 * B7 (dsh-009): dsh 模式 `initBackgroundRuntime` 主动跳过 — 子任务走
 * dsh-bridge 自实现,不依赖 vendor `DefaultBackgroundRuntime`。这导致
 * `getBackgroundRuntime()` 抛 'Background runtime not initialized' 是
 * **设计预期**而非真错,production stdout 不该被此噪音污染。opencc 模式
 * 与 adapter 不可用(默认)则保持原 warn 行为。模块级 lazy 探测一次 —
 * 不每请求拉 getKernelAdapter,避免重复 throw + 影响延迟。
 */
let dshModeSilenced: boolean | null = null
function shouldSilenceAgentFailure(): boolean {
  if (dshModeSilenced !== null) return dshModeSilenced
  try {
    const adapter = getKernelAdapter()
    dshModeSilenced =
      adapter != null && (adapter as { kernel?: string }).kernel !== 'opencc'
  } catch {
    dshModeSilenced = false
  }
  return dshModeSilenced
}

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

  // v2 tasks 分支:按 kernel 分发
  //   - dsh kernel:从 dsh `ctx.sessionProjections.snapshot(session)` 读 `todos`
  //     投影值(whole-list snapshot,Phase 5P5 起由 dsh-tool-todo 上游维护),
  //     把 TodoItem[] 转成 V2TaskItemWire[]。opencc 路径完全不走。
  //   - opencc / 未初始化:走 compat TaskListStore + vendor fallback(原行为)。
  const isDshKernel = (() => {
    try {
      return getKernelAdapter()?.kernel === 'dsh'
    } catch {
      return false
    }
  })()

  const v2Promise: Promise<V2TaskItemWire[]> = isDshKernel
    ? Promise.resolve()
        .then(() => loadDshV2Tasks(sid))
        .catch((err: unknown) => {
          console.warn('[sessionState] dsh v2 snapshot failed', err)
          return loadVendorV2Tasks(sid)
        })
    : getTaskListStore()
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
        })

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

    v2Promise,

    Promise.resolve()
      .then(() => bashBackgroundTracker.list({ sessionId: sid }))
      .catch((err: unknown) => {
        console.warn('[sessionState] bash failed', err)
        return []
      }),

    // B7 (dsh-009): dsh 模式 initBackgroundRuntime 主动跳过(DefaultBackgroundRuntime
    // 走 vendor OpenccRuntime.query,在 dsh 侧自实现子任务),getBackgroundRuntime() throw。
    // 用 Promise.resolve().then() 把同步 throw 包成 reject,与同段其它 catch 风格一致。
    Promise.resolve()
      .then(() => getBackgroundRuntime().list())
      .then((all) => all.filter((t) => t.parentSessionId === sid))
      .catch((err: unknown) => {
        // B7 设计预期 → 静默;否则保留 warn 让运维看见真异常
        if (shouldSilenceAgentFailure()) return []
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
    const bundle = (await import('@zn-ai/zn-agent-core')) as {
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

/**
 * Phase 5P5 适配:dsh 模式从 `ctx.sessionProjections.snapshot(session)` 读
 * `todos` 投影值(whole-list snapshot,由上游 dsh-tool-todo 维护)。
 *
 * - ctx 还没装载(handle.shutdown / 早期 init)/ snapshotDshTodo 内部 null
 *   (没 first todo/write)→ 返回空数组,前端 TodoZone 过滤 length===0
 *   不渲染,与 opencc 模式空 list 行为对齐。
 * - TodoItem.content 作 id(subject 也是 content,与 opencc 模式 subject 字段
 *   对齐 — TodoZone / TodoDropdown 都读 t.subject)。
 *
 * 失败(罕见,例如 dsh-side ctx 已 dispose)→ 回退到 loadVendorV2Tasks,与
 * opencc 路径最终 fallback 一致,避免空 list 造成 UI 异常。
 */
async function loadDshV2Tasks(sid: string): Promise<V2TaskItemWire[]> {
  const ctx = getDshHandleForTranscript()
  if (!ctx) return []
  const todos = snapshotDshTodo(ctx, sid)
  if (!todos) return []
  const now = Date.now()
  return todos.map((t) => ({
    id: t.content,
    subject: t.content,
    status: t.status,
    blocks: [],
    blockedBy: [],
    updatedAt: now,
  }))
}
