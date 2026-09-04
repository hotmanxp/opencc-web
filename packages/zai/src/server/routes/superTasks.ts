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
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { existsSync, statSync } from 'node:fs'
import {
  getTasksSnapshot, getTaskSummary, getTaskDetails, deleteTasks,
  moveTask, markTaskStatus, checkTaskIntakeDocs, getSubagentRegistry,
} from '@zn-ai/zn-agent-core'
import {
  getTaskFactoryState,
  setTaskFactoryState,
  injectSupervisorCommand,
  buildTaskCommand,
} from '../services/taskFactoryBridge.js'
import { getBackgroundRuntime } from '../services/backgroundRuntime.js'
import {
  FactorySettingsValidationError,
  factorySettingsPatchSchema,
  getFactorySettings,
  setFactorySettings,
} from '../services/factorySettings.js'
import { sweepArchiveFinishedTasks } from '../services/historyArchive.js'
import { readZaiSettings, updateZaiSettings } from '../services/zaiSettingsStore.js'

const execFileAsync = promisify(execFile)

const router: IRouter = Router()
const ALLOWED_ACTIONS = ['dispatch', 'resume', 'accept', 'pause'] as const
type InjectAction = (typeof ALLOWED_ACTIONS)[number]

/** spawnAgent provider 白名单(注册/探测端点共用;向导架构可扩展)。 */
const SPAWN_AGENT_NAMES = ['opencc', 'dsh', 'opencode'] as const

/** `which <cmd>` 探测全局命令。失败/未找到 → found=false。 */
async function whichProbe(cmd: string): Promise<{ found: boolean; path: string | null }> {
  try {
    const { stdout } = await execFileAsync('which', [cmd])
    const p = (stdout.trim().split('\n')[0] ?? '').trim()
    return { found: p.length > 0, path: p || null }
  } catch {
    return { found: false, path: null }
  }
}

/** 目录存在性徽标(路径空/不存在/非目录 → false)。 */
function isDirectory(p: string): boolean {
  if (!p) return false
  try {
    return existsSync(p) && statSync(p).isDirectory()
  } catch {
    return false
  }
}

/**
 * GET /super-tasks — 列表 + since-hash 短路(2026-09-03 性能优化)。
 * hash = fingerprint|managed|supervisorSessionId,覆盖整个 DTO:四桶变化(core
 * 快照缓存指纹)或托管开关/主管会话 id 变化都会使 hash 变化。请求带
 * `?since=<hash>` 且命中 → 返回 `{ modified:false, hash }` 极小响应(不含
 * buckets/managed/supervisorSessionId),前端据此跳过重渲染。不带 since 的
 * 旧调用方拿到 modified:true + 原有全部字段,向后兼容。
 */
router.get('/super-tasks', async (req, res) => {
  // 返回列表前先扫一次过期终态归档(finished-tasks → history-tasks,tf-xrlcxuoi)。
  // sweep 内部 try/catch + in-flight 去重,永不抛出;此处 catch 为双保险,
  // 绝不阻塞/拖垮 3s 轮询。
  await sweepArchiveFinishedTasks().catch(() => {})
  const [{ fingerprint, buckets }, state] = await Promise.all([getTasksSnapshot(), getTaskFactoryState()])
  const hash = `${fingerprint}|${String(state.managedEnabled)}|${String(state.supervisorSessionId)}`
  const since = typeof req.query.since === 'string' ? req.query.since : undefined
  if (since !== undefined && since === hash) {
    return res.json({ modified: false, hash })
  }
  res.json({
    modified: true,
    hash,
    buckets,
    managed: state.managedEnabled,
    supervisorSessionId: state.supervisorSessionId,
  })
})

// ─── 工厂设置(~/.zai/factory-settings.json)────────────────────────────
// 注意:这些静态段路由必须注册在 /super-tasks/:id 之前,否则 `settings` /
// `spawn-agents` 会被 :id 吞掉。

/**
 * GET /api/super-tasks/settings — 当前工厂配置(含默认值合并)+ 目录存在性
 * 徽标(docsDirExists / repoRootExists 为派生字段,不进 PUT schema)。
 */
router.get('/super-tasks/settings', async (_req, res) => {
  const s = await getFactorySettings()
  res.json({
    ...s,
    docsDirExists: isDirectory(s.docsDir),
    repoRootExists: isDirectory(s.repoRoot),
  })
})

/**
 * PUT /api/super-tasks/settings — partial patch + zod 校验(含 maxParallelTasks
 * 2–8),非法值 400。成功返回合并后的完整配置。
 */
router.put('/super-tasks/settings', async (req, res) => {
  const parsed = factorySettingsPatchSchema.safeParse(req.body ?? {})
  if (!parsed.success) {
    return res.status(400).json({
      error: 'invalid factory settings',
      detail: parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`),
    })
  }
  try {
    const s = await setFactorySettings(parsed.data)
    res.json({
      ...s,
      docsDirExists: isDirectory(s.docsDir),
      repoRootExists: isDirectory(s.repoRoot),
    })
  } catch (err) {
    if (err instanceof FactorySettingsValidationError) {
      return res.status(400).json({ error: err.message, issues: err.issues })
    }
    return res.status(500).json({ error: (err as Error).message })
  }
})

/**
 * GET /api/super-tasks/spawn-agents — opencc / dsh / opencode 三个 spawnAgent
 * provider 的可用性快照:
 *  - commandFound/commandPath: `which <name>` 探测全局 CLI;
 *  - registered: ~/.zai/settings.json 是否已有 subagents.<name> 配置块;
 *  - active: 运行时 getSubagentRegistry().list() 是否包含(opencc/claude-code
 *    provider 无条件注册 → 通常 active=true;dsh / opencode 在 initAgentRuntime
 *    按配置注册 → 需 enabled 并重启后 active)。
 */
router.get('/super-tasks/spawn-agents', async (_req, res) => {
  let settings: Awaited<ReturnType<typeof readZaiSettings>> | null = null
  try {
    settings = await readZaiSettings()
  } catch {
    // settings 缓存未就绪时 registered 一律 false,不阻断端点
  }
  let activeNames: string[] = []
  try {
    activeNames = getSubagentRegistry().list()
  } catch {
    activeNames = []
  }
  const agents = []
  for (const name of SPAWN_AGENT_NAMES) {
    const { found, path } = await whichProbe(name)
    agents.push({
      name,
      commandFound: found,
      commandPath: path,
      registered: settings?.subagents?.[name] !== undefined,
      active: activeNames.includes(name),
    })
  }
  res.json({ agents })
})

/**
 * POST /api/super-tasks/spawn-agents/:name/register — 一键注册:merge 写
 * ~/.zai/settings.json 的 subagents.<name>(设置 enabled: true,保留该块
 * 其它键与 settings.json 其它键不动)。dsh / opencode provider 在 initAgentRuntime
 * 时才注册进 registry,故响应带 restartRequired: true 提示用户重启 zai 服务
 * 生效(系统不自动重启)。:name 白名单 opencc/dsh/opencode,其余 404。
 */
router.post('/super-tasks/spawn-agents/:name/register', async (req, res) => {
  const name = req.params.name
  if (!(SPAWN_AGENT_NAMES as readonly string[]).includes(name)) {
    return res.status(404).json({ error: `unknown spawn agent: ${name}` })
  }
  try {
    const settings = await readZaiSettings()
    const prev = settings.subagents ?? {}
    const block =
      typeof prev[name] === 'object' && prev[name] !== null
        ? (prev[name] as Record<string, unknown>)
        : {}
    await updateZaiSettings({
      subagents: { ...prev, [name]: { ...block, enabled: true } },
    })
    res.json({ ok: true, restartRequired: true })
  } catch (err) {
    res.status(500).json({ error: (err as Error).message })
  }
})

router.get('/super-tasks/:id', async (req, res) => {
  const d = await getTaskDetails(req.params.id)
  if (!d) return res.status(404).json({ error: `task ${req.params.id} not found` })
  res.json({ task: d })
})

/**
 * GET /super-tasks/:id/intake-check — intake 文档强校验(2026-09-03)。
 * 新建任务弹窗关闭前由前端调用:检查 docs/spec.md / docs/plan.md /
 * docs/brainstorm.md 是否已填实质内容,返回 { ok, missing }。
 * 缺失时前端拦截关闭并把清单回流给 task-intake 会话补全。
 */
router.get('/super-tasks/:id/intake-check', async (req, res) => {
  const check = await checkTaskIntakeDocs(req.params.id)
  if (!check) return res.status(404).json({ error: `task ${req.params.id} not found` })
  res.json(check)
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
  // zai patch (2026-09-04, quick-intake): quick 任务在 dispatch/accept 上自动
  // 附加 verifier light 提示段;full / 缺省保持原行为(零变化)。
  const body = task
    ? buildTaskCommand(typedAction, task, `Handle task ${id} per the command: ${typedAction}`)
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
  injectSupervisorCommand(buildTaskCommand('dispatch', t, `Dispatch task ${t.id} for execution.`))
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
  const msg = t.bucket === 'verifying-tasks'
    ? 'Forced accept: skip verifier and call SuperTasksMarkDone.'
    : 'Accept the task deliverables and call SuperTasksMarkDone.'
  injectSupervisorCommand(buildTaskCommand(action as 'forced-accept' | 'accept', t, msg))
  res.json({ ok: true })
})

export default router
