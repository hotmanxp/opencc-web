/**
 * superTasks 路由 — zai 任务工厂的 REST 端点。
 *
 * - GET /api/super-tasks          四栏 bucket(queue/processing/verifying/finished) + 当前 state
 * - GET /api/super-tasks/:id      单任务详情(index + spec + plan + process)
 * - DELETE /api/super-tasks       删除任务(processing/paused/verifying → 409)
 * - POST /api/super-tasks/managed 切换 managed 开关(持久化到 state.json)
 * - POST /api/super-tasks/supervisor 上报主管会话 id(持久化到 state.json)
 * - POST /api/super-tasks/:id/start  手工启动 = 注入 dispatch
 * - POST /api/super-tasks/:id/pause  kill 执行子任务 + 冻结(留 processing,status=paused) + 注入通知(仅 processing+processing)
 * - POST /api/super-tasks/:id/resume  = 注入 resume
 * - POST /api/super-tasks/:id/accept  人工验收 = 注入 accept(processing)/forced-accept(verifying);主管调 SuperTasksMarkDone
 * - POST /api/super-tasks/inject  通用注入入口(白名单 action, 可附 id)
 *
 * 业务侧路由(start/pause/resume/accept)承担确定性副作用(kill executor /
 * 状态落盘)后统一走 injectSupervisorCommand 送达主管会话;inject 端点保持
 * 通用的「仅注入指令」语义供前端面板/测试使用。
 */

import { Router, type IRouter } from 'express'
import {
  taskFactoryListTasks as listTasks, getTaskSummary, getTaskDetails, deleteTasks,
  moveTask, markTaskStatus,
} from '@zn-ai/zn-agent-core'
import {
  getTaskFactoryState,
  setTaskFactoryState,
  injectSupervisorCommand,
} from '../services/taskFactoryBridge.js'
import { getBackgroundRuntime } from '../services/backgroundRuntime.js'

const router: IRouter = Router()
const ALLOWED_ACTIONS = ['dispatch', 'resume', 'accept', 'pause'] as const
type InjectAction = (typeof ALLOWED_ACTIONS)[number]

router.get('/super-tasks', async (_req, res) => {
  const [buckets, state] = await Promise.all([listTasks(), getTaskFactoryState()])
  res.json({ buckets, managed: state.managedEnabled, supervisorSessionId: state.supervisorSessionId })
})

router.get('/super-tasks/:id', async (req, res) => {
  const d = await getTaskDetails(req.params.id)
  if (!d) return res.status(404).json({ error: `task ${req.params.id} not found` })
  res.json({ task: d })
})

router.delete('/super-tasks', async (req, res) => {
  const { ids } = (req.body ?? {}) as { ids?: unknown }
  if (!Array.isArray(ids) || ids.length === 0 || ids.some((x) => typeof x !== 'string')) {
    return res.status(400).json({ error: 'ids: 非空字符串数组必填' })
  }
  try {
    await deleteTasks(ids as string[])
    res.json({ ok: true })
  } catch (err) {
    const msg = (err as Error).message
    res.status(msg.includes('processing') ? 409 : 404).json({ error: msg })
  }
})

router.post('/super-tasks/managed', async (req, res) => {
  const { enabled } = (req.body ?? {}) as { enabled?: unknown }
  if (typeof enabled !== 'boolean') return res.status(400).json({ error: 'enabled: boolean 必填' })
  await setTaskFactoryState({ managedEnabled: enabled })
  res.json({ ok: true })
})

/**
 * POST /api/super-tasks/supervisor — 上报主管会话 id(2026-09-02)。
 * 前端 /super-tasks 引导(沿用/新建主管会话)后调它把真实 sessionId 落到
 * state.json,托管循环 injectSupervisorCommand 与手工 start/pause 等注入
 * 才始终打在用户可见的主管会话上。
 */
router.post('/super-tasks/supervisor', async (req, res) => {
  const { sessionId } = (req.body ?? {}) as { sessionId?: unknown }
  if (typeof sessionId !== 'string' || sessionId.trim() === '') {
    return res.status(400).json({ error: 'sessionId: 非空字符串必填' })
  }
  await setTaskFactoryState({ supervisorSessionId: sessionId.trim() })
  res.json({ ok: true })
})

/**
 * POST /api/super-tasks/supervisor/reset — 清空主管会话 id + 同步关托管(2026-09-02)。
 *
 * 语义:让前端 SuperTasks 重置按钮触发全新 mount 引导。前端调用成功后
 * 应调 window.location.reload(),浏览器刷新后:
 *   - /super-tasks mount 看到 server sid 为 null,走新建分支
 *   - createAgentSession({ mainAgent: 'task-factory' }) 创建新空 session
 *   - setSupervisorSession(newSid) 把新 sid 落回 state.json
 *
 * 旧 session transcript 保留在 ~/.zai/tasks/<oldSid>.json,与新主管不再关联;
 * managed 同步关掉,避免新主管被 5s 托管循环立即注入 dispatch 指令。
 * injectSupervisorCommand 在 sid 为空/null 时有 console.warn 护栏,
 * 这里把 supervisorSessionId 置 null 是有意为之,不是 bug。
 */
router.post('/super-tasks/supervisor/reset', async (_req, res) => {
  await setTaskFactoryState({
    supervisorSessionId: null,
    managedEnabled: false,
  })
  res.json({ ok: true })
})

/**
 * POST /api/super-tasks/inject — 向主管会话注入指令。
 * action 白名单 dispatch/resume/accept/pause;可附 task id(存在性校验),
 * 标题中的 `<` 替换为全角 `＜` 防止被解析为 XML 起始标签。
 */
router.post('/super-tasks/inject', async (req, res) => {
  const { action, id } = (req.body ?? {}) as { action?: unknown; id?: unknown }
  if (typeof action !== 'string' || !(ALLOWED_ACTIONS as readonly string[]).includes(action)) {
    return res.status(400).json({ error: `action: ${ALLOWED_ACTIONS.join('/')} 之一必填` })
  }
  const typedAction = action as InjectAction
  const task = id ? await getTaskSummary(id as string) : null
  if (id && !task) return res.status(404).json({ error: `task ${id} not found` })
  const body = id
    ? `\n<task-command action="${typedAction}" id="${id}" title="${(task!.title ?? '').replace(/</g, '＜')}">Handle task ${id} per the command: ${typedAction}</task-command>`
    : `\n<task-command action="${typedAction}">Handle per the command: ${typedAction}</task-command>`
  injectSupervisorCommand(body)
  res.json({ ok: true })
})

/**
 * POST /api/super-tasks/:id/start — 手工启动：校验在队列后注入 dispatch 指令，
 * 由主管按任务 cwd 委派执行子 Agent（优先 SpawnAgent）。
 */
router.post('/super-tasks/:id/start', async (req, res) => {
  const t = await getTaskSummary(req.params.id)
  if (!t || t.bucket !== 'queue-tasks') return res.status(400).json({ error: `task ${req.params.id} 不在队列` })
  injectSupervisorCommand(`\n<task-command action="dispatch" id="${t.id}" title="${(t.title ?? '').replace(/</g, '＜')}">Dispatch task ${t.id} for execution.</task-command>`)
  res.json({ ok: true })
})

/**
 * POST /api/super-tasks/:id/pause — 暂停：kill 执行子任务（保留其会话），
 * 任务冻结（task.yaml status=paused，目录仍留 processing-tasks），注入通知。
 *
 * 仅 processing 桶 + status=processing 允许暂停：verifying 桶中验证 subagent 正在跑,
 * 暂停会破坏验证闭环, 直接 400 拒绝(用户应改用 verifying 桶的强制 accept 走归档)。
 */
router.post('/super-tasks/:id/pause', async (req, res) => {
  const t = await getTaskSummary(req.params.id)
  if (!t || t.bucket !== 'processing-tasks' || t.status !== 'processing') {
    return res.status(400).json({ error: `task ${req.params.id} 不在执行中(processing+processing)` })
  }
  const bg = getBackgroundRuntime()
  if (t.executorTaskId) {
    try { await bg.cancel(t.executorTaskId) } catch { /* 已终态/不存在则静默 */ }
  }
  try {
    await markTaskStatus(t.id, 'processing-tasks', { status: 'paused', executorTaskId: null })
  } catch (err) {
    // executor 已 kill 但状态写入失败——显式 500，避免 UI 把「未暂停」误判为已暂停
    return res.status(500).json({ error: (err as Error).message })
  }
  injectSupervisorCommand(`\n<task-command action="pause" id="${t.id}">Task paused (executor subagent has been killed). Reply to resume when needed.</task-command>`)
  res.json({ ok: true })
})

/**
 * POST /api/super-tasks/:id/resume — 继续：注入 resume 指令，
 * 主管 resume 原执行会话或重新委派。
 */
router.post('/super-tasks/:id/resume', async (req, res) => {
  const t = await getTaskSummary(req.params.id)
  if (!t || t.bucket !== 'processing-tasks') return res.status(400).json({ error: `task ${req.params.id} 不在执行中` })
  injectSupervisorCommand(`\n<task-command action="resume" id="${t.id}" title="${(t.title ?? '').replace(/</g, '＜')}">Continue executing the task (resume the original executor session or re-delegate).</task-command>`)
  res.json({ ok: true })
})

/**
 * POST /api/super-tasks/:id/accept — 人工验收入口：注入 accept 指令，
 * 主管验收任务成果并调 SuperTasksMarkDone 归档到 finished-tasks。
 *
 * 接受 processing 与 verifying 两桶触发:
 * - processing → 标准路径(主管可能刚收到 executor 完成通知, 准备调 Verify;
 *   或者直接人工覆盖走归档)。
 * - verifying → 「强制通过」语义,跳过 verifier 直接 MarkDone。
 * queue/finished/不存在 → 400 拒绝。
 */
router.post('/super-tasks/:id/accept', async (req, res) => {
  const t = await getTaskSummary(req.params.id)
  if (!t || (t.bucket !== 'processing-tasks' && t.bucket !== 'verifying-tasks')) {
    return res.status(400).json({ error: `task ${req.params.id} 不在执行中或验证中(processing/verifying)` })
  }
  const action = t.bucket === 'verifying-tasks' ? 'forced-accept' : 'accept'
  injectSupervisorCommand(`\n<task-command action="${action}" id="${t.id}">${t.bucket === 'verifying-tasks' ? 'Forced accept: skip verifier and call SuperTasksMarkDone.' : 'Accept the task deliverables and call SuperTasksMarkDone.'}</task-command>`)
  res.json({ ok: true })
})

export default router
