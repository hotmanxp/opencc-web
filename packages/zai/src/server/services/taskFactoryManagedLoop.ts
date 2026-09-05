/**
 * taskFactoryManagedLoop — AI 托管循环（zai 顶层实例常驻）。
 *
 * 每 tick（默认 5s）:
 *  - managed 开关关 → 直接返回（全手工模式）。
 *  - 队列非空 且 processing 桶数量 < factory-settings.maxParallelTasks →
 *    注入一条 dispatch 指令（2026-09-01 用户更正:不做
 *    「无 processing 才派发」的单任务串行门闩 — 队列非空即派发,
 *    由任务调度器按队列顺序一次派发多个任务，任务间并行。2026-09-03 tf-pnsl5m5e:
 *    并行数受 factory-settings.json maxParallelTasks 服务端强约束）。
 *  - 某 processing 任务带 executorTaskId 且 executor 已是终态
 *    (completed/failed/cancelled/killed) → 注入 accept 验收指令。
 *    executor 不可解析（未知/尚不存在）一律视为未终态,避免幽灵验收。
 *  - (tf-8rvychr0) processing / verifying 任务的 executor / verifier 子任务
 *    BackgroundTask.eventCount 在 stagnantThresholdMs 内未增长 → 注入一条
 *    `<task-alert action="stagnant">`,内容是最近 5 条 TaskEvent 的 JSON
 *    摘要。同任务 stagnantCooldownMs 冷却期内不重复告警。事件源是
 *    BackgroundRuntime 的 TaskEvent 流,不是 process.md。
 *
 * 用 signature 去重（queue/processing 的快照与上次相同则跳过注入），
 * 防止任务调度器会话被重复指令刷屏。每次只注入 actions[0]（dispatch 优先），
 * 任务调度器空闲唤醒后可自行按队列继续取任务。
 *
 * 只由顶层实例启动（server/index.ts 按 ZAI_INSTANCE_ID 判断）；
 * 受管子实例（执行器）不跑。测试用 intervalMs 参数 + stop* 清理。
 */
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { taskFactoryListTasks as listTasks } from '@zn-ai/zn-agent-core'
import { getBackgroundRuntime } from './backgroundRuntime.js'
import { getFactorySettings } from './factorySettings.js'
import {
  getTaskFactoryStateSync,
  injectSupervisorCommand,
  QUICK_VERIFIER_HINT,
} from './taskFactoryBridge.js'

/**
 * 项目类型(zai patch 2026-09-05, tf-flofuz1q 三阶段职责固化)。detectProjectType
 * 通过锁文件 / 清单文件识别仓库存量技术栈 — 用于 supervisor 派单时给出软
 * 「install command 建议」(executor 仍需看 plan 字段决定是否跑)。
 *  - 'node-pnpm':pnpm workspace(锁文件 pnpm-lock.yaml)
 *  - 'node-npm' :npm / yarn(锁文件 package-lock.json 或 yarn.lock)
 *  - 'python'   :pyproject.toml / requirements.txt / setup.py / Pipfile
 *  - 'go'       :go.mod
 *  - 'rust'     :Cargo.toml
 *  - 'unknown'  :以上都不是(不强行推测;verifier 不会因 unknown 跳检查)
 *
 * 注:此识别是「软建议」依据 — 不硬编码到 supervisor prompt。supervisor 在
 * 派单 plan 里可选填 project_specific_verify_cmd(参见 mainAgents-taskFactory
 * §5 Stage 1)。
 */
export type ProjectType = 'node-pnpm' | 'node-npm' | 'python' | 'go' | 'rust' | 'unknown'

const PYTHON_MARKERS = ['pyproject.toml', 'requirements.txt', 'setup.py', 'Pipfile'] as const

/**
 * 检测 cwd 目录的项目类型。检测顺序:pnpm > npm > python(任一标记文件) > go >
 * rust > unknown。函数纯同步,只读锁文件 / 清单文件的存在性,不解析内容。
 */
export function detectProjectType(cwd: string): ProjectType {
  if (!cwd) return 'unknown'
  if (existsSync(join(cwd, 'pnpm-lock.yaml'))) return 'node-pnpm'
  if (existsSync(join(cwd, 'package-lock.json'))) return 'node-npm'
  if (PYTHON_MARKERS.some((m) => existsSync(join(cwd, m)))) return 'python'
  if (existsSync(join(cwd, 'go.mod'))) return 'go'
  if (existsSync(join(cwd, 'Cargo.toml'))) return 'rust'
  return 'unknown'
}

/**
 * 给定项目类型,返回「软建议」的 install 命令(不强制 executor 执行)。
 *  - node-pnpm:`pnpm install --prefer-offline`(offline 优先,撞网失败再 online,
 *    节省 CI 反复拉包时间)。
 *  - node-npm :`npm ci`(锁定版本,比 install 严格)。
 *  - python/go/rust:返回 null —— 这些语言不需要 supervisor 派单时拉依赖(
 *    各自的标准工具链自带缓存,或 verifier 跑测试时才装)。
 *  - unknown :null —— 没识别出来就不建议。
 *
 * 调用方(supervisor)把返回值作为软建议写入 executor prompt(若有需要);executor
 * 仍按 plan 字段判定是否真跑,不在 supervisor prompt 里硬塞命令。
 */
export function suggestInstallCommand(_cwd: string, projectType: ProjectType): string | null {
  switch (projectType) {
    case 'node-pnpm': return 'pnpm install --prefer-offline'
    case 'node-npm': return 'npm ci'
    default: return null
  }
}

let timer: ReturnType<typeof setInterval> | null = null
let lastSignature = ''

/** 启动 AI 托管循环。幂等：已运行时直接返回。测试可传紧凑 interval。 */
export function startTaskFactoryManagedLoop(intervalMs = 5000): void {
  if (timer) return
  timer = setInterval(() => { void tick() }, intervalMs)
}

/** 测试用 —— 停止循环并清空上次 signature。 */
export function stopTaskFactoryManagedLoopForTests(): void {
  if (timer) { clearInterval(timer); timer = null }
  lastSignature = ''
}

/**
 * stagnant tracker:key = `${taskId}:${role}` (role ∈ executor | verifier),
 * value 记录最近一次观察到的 BackgroundTask.eventCount、上次事件时间戳、上次
 * 告警时间戳。每次 tick 拿 BackgroundTask.eventCount 比较,增长则重置
 * lastEventAt;若 `Date.now() - lastEventAt > stagnantThresholdMs` 且冷却
 * 期内未告警则注入一次 `<task-alert action="stagnant">` 摘要。
 */
type StagnantTracker = {
  lastEventCount: number
  lastEventAt: number
  lastReportedAt: number
}
const stagnantTrackers = new Map<string, StagnantTracker>()

/** 测试用 —— 启动前清空 trackers,让单测从零状态开始。 */
export function __resetStagnantTrackersForTests(): void {
  stagnantTrackers.clear()
}

function isTerminal(task: { status?: string } | null | undefined): boolean {
  if (!task) return false
  return (
    task.status === 'completed' ||
    task.status === 'failed' ||
    task.status === 'cancelled' ||
    task.status === 'killed'
  )
}

async function tick(): Promise<void> {
  if (!getTaskFactoryStateSync().managedEnabled) return
  const settings = await getFactorySettings()
  const { queue, processing, verifying } = await listTasks()
  const signature = `q:${queue.map((t) => t.id).join(',')}|p:${processing.map((t) => `${t.id}:${t.status}`).join(',')}`
  const actions: string[] = []
  // 并行派发（2026-09-01 用户更正）：不在「无 processing 才派发」上做单任务串行约束，
  // 队列非空即注入派发指令，由任务调度器按队列顺序一次派发多个任务。
  // 工厂设置并行上限（tf-pnsl5m5e）：processing 桶数量达到 maxParallelTasks 时
  // 跳过 dispatch 注入 —— 服务端强约束，防止任务调度器超发；accept 指令不受限。
  if (queue.length > 0 && processing.length < settings.maxParallelTasks) actions.push('dispatch')
  // 测试间清 stub 后,getBackgroundRuntime() 可能 throw —— 整个 tick 早退,
  // 避免 fire-and-forget 的 checkStagnantTasks 在 stale 状态下 await bg.get 抛
  // unhandled rejection。生产环境 stub 不会被清,无影响。
  let bg: ReturnType<typeof getBackgroundRuntime>
  try { bg = getBackgroundRuntime() } catch { return }
  for (const t of processing) {
    const done = t.status === 'processing' && t.executorTaskId
      ? isTerminal(await bg.get(t.executorTaskId).catch(() => null))
      : false
    if (done) actions.push(`accept:${t.id}`)
  }
  if (actions.length > 0 && signature !== lastSignature) {
    lastSignature = signature
    const first: string = actions[0]!
    if (first === 'dispatch') {
      // zai patch (2026-09-04, quick-intake):如果 queue 里含 quick 任务,在
      // dispatch 注入里追加 verifier light 提示段 —— 任务调度器后续 spawn verifier
      // 时会读这段并走轻量验证(build + lint + 关键文件 diff 的 code review)。
      const hasQuick = queue.some((t) => t.mode === 'quick')
      const hint = hasQuick ? QUICK_VERIFIER_HINT : ''
      injectSupervisorCommand(`\n<task-command action="dispatch">The queue has tasks; dispatch them for execution in queue order (multiple at once is fine — tasks run in parallel).${hint ? ' NOTE: queue contains quick-mode tasks — their verifier rounds should follow the light path below.' : ''}</task-command>${hint}`)
    } else if (first.startsWith('accept:')) {
      const id = first.slice('accept:'.length)
      injectSupervisorCommand(`\n<task-command action="accept" id="${id}">The executor subagent has finished; please accept the task.</task-command>`)
    }
  }

  // ----- stagnant 监控 (tf-8rvychr0) -----
  // 与上面 actions/signatures 完全独立 —— dispatch/accept 不收影响,且不依赖
  // signature 变化:无论 queue/processing 是否有变化,只要 managed 开着就每 tick
  // 巡检 processing + verifying 子任务的 eventCount。仅看 processing + verifying
  // 桶,每任务取 executorTaskId/verifierTaskId,调 bg.get(taskId).eventCount
  // 比较上次记录的 count;增长则重置 lastEventAt,停滞超过 stagnantThresholdMs
  // 且 cooldown 已外 → 注入告警。bg.get 返回 null / 已终态 → 从 trackers
  // 移除并跳过。
  void checkStagnantTasks(bg, [...processing, ...verifying], settings.stagnantThresholdMs, settings.stagnantCooldownMs)
}

async function collectRecentEvents(
  bg: ReturnType<typeof getBackgroundRuntime>,
  taskId: string,
  eventCount: number,
): Promise<unknown[]> {
  // 拉最近 5 条 TaskEvent 摘要:从 max(0, eventCount - 5) 开始订阅,事件流
  // 会先回放历史(seq > fromSeq)再等待新增;任务已终态时流立即关闭,所以
  // 拿到的事件最多 ~5 条(已达成完成);在线任务不会关闭流,这里仅取首个
  // batch(用 break)就退出,避免长期挂着等新事件拖垮 tick。
  const fromSeq = Math.max(0, eventCount - 5)
  const collected: unknown[] = []
  try {
    for await (const ev of bg.events(taskId, fromSeq)) {
      collected.push({
        seq: ev.seq,
        eventId: ev.eventId,
        ts: ev.ts,
        type: ev.type,
        data: ev.data,
      })
      if (collected.length >= 5) break
    }
  } catch {
    // bg.events 在 task 不存在 / store 抛错时可能抛 —— 静默吞掉,告警内容
    // 退化为空数组,不影响 stagnant 触发本身。
  }
  return collected
}

async function checkStagnantTasks(
  bg: ReturnType<typeof getBackgroundRuntime>,
  candidates: Array<{
    id: string
    title?: string | null
    executorTaskId?: string | null
    verifierTaskId?: string | null
  }>,
  thresholdMs: number,
  cooldownMs: number,
): Promise<void> {
  const now = Date.now()
  // 收集本轮还在跟踪的 key,轮末剔除已消失/已终态的 —— 避免 trackers 长期
  // 累积老任务。
  const liveKeys = new Set<string>()
  for (const t of candidates) {
    const checks: Array<{ role: 'executor' | 'verifier'; taskId: string | null | undefined }> = [
      { role: 'executor', taskId: t.executorTaskId },
      { role: 'verifier', taskId: t.verifierTaskId },
    ]
    for (const c of checks) {
      if (!c.taskId) continue
      const key = `${t.id}:${c.role}`
      liveKeys.add(key)
      const bgTask = await bg.get(c.taskId).catch(() => null)
      if (!bgTask) {
        // 后台任务不存在(可能未派发 / 已清理) → 移除 tracker 避免误判
        stagnantTrackers.delete(key)
        continue
      }
      if (isTerminal(bgTask)) {
        // 已终态 → 从 trackers 移除,下次自然不会触发告警
        stagnantTrackers.delete(key)
        continue
      }
      const evCount = bgTask.eventCount ?? 0
      const tracker = stagnantTrackers.get(key)
      if (!tracker) {
        // 首次见到该子任务 → 初始化,lastEventAt = now 不立即告警(等待下一 tick
        // 才有可比基线)。
        stagnantTrackers.set(key, {
          lastEventCount: evCount,
          lastEventAt: now,
          lastReportedAt: 0,
        })
        continue
      }
      if (evCount !== tracker.lastEventCount) {
        tracker.lastEventCount = evCount
        tracker.lastEventAt = now
        continue
      }
      // eventCount 未变 → 检查停滞时长 + 冷却期
      if (now - tracker.lastEventAt <= thresholdMs) continue
      if (now - tracker.lastReportedAt <= cooldownMs) continue
      const events = await collectRecentEvents(bg, c.taskId, evCount)
      const stagnantMinutes = Math.round((now - tracker.lastEventAt) / 60_000)
      const safeTitle = (t.title ?? '').replace(/</g, '＜')
      const alertText =
        `\n<task-alert action="stagnant" id="${t.id}" role="${c.role}" sub-task-id="${c.taskId}">` +
        `Task ${t.id} (${safeTitle}) sub-task(${c.role}=${c.taskId}) stagnant for ${stagnantMinutes}m. ` +
        `Last event count: ${evCount}. Recent ${events.length} TaskEvents: ` +
        `${JSON.stringify(events)}</task-alert>`
      injectSupervisorCommand(alertText)
      tracker.lastReportedAt = now
    }
  }
  // 清理已经不在候选集的 key(任务被移到 finished / 移除 executorTaskId)。
  for (const k of [...stagnantTrackers.keys()]) {
    if (!liveKeys.has(k)) stagnantTrackers.delete(k)
  }
}