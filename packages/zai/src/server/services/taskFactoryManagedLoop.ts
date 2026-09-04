/**
 * taskFactoryManagedLoop — AI 托管循环（zai 顶层实例常驻）。
 *
 * 每 tick（默认 5s）:
 *  - managed 开关关 → 直接返回（全手工模式）。
 *  - 队列非空 且 processing 桶数量 < factory-settings.maxParallelTasks →
 *    注入一条 dispatch 指令（2026-09-01 用户更正:不做
 *    「无 processing 才派发」的单任务串行门闩 — 队列非空即派发,
 *    由主管按队列顺序一次派发多个任务，任务间并行。2026-09-03 tf-pnsl5m5e:
 *    并行数受 factory-settings.json maxParallelTasks 服务端强约束）。
 *  - 某 processing 任务带 executorTaskId 且 executor 已是终态
 *    (completed/failed/cancelled/killed) → 注入 accept 验收指令。
 *    executor 不可解析（未知/尚不存在）一律视为未终态,避免幽灵验收。
 *
 * 用 signature 去重（queue/processing 的快照与上次相同则跳过注入），
 * 防止主管会话被重复指令刷屏。每次只注入 actions[0]（dispatch 优先），
 * 主管空闲唤醒后可自行按队列继续取任务。
 *
 * 只由顶层实例启动（server/index.ts 按 ZAI_INSTANCE_ID 判断）；
 * 受管子实例（执行器）不跑。测试用 intervalMs 参数 + stop* 清理。
 */
import { taskFactoryListTasks as listTasks } from '@zn-ai/zn-agent-core'
import { getBackgroundRuntime } from './backgroundRuntime.js'
import { getFactorySettings } from './factorySettings.js'
import {
  getTaskFactoryStateSync,
  injectSupervisorCommand,
  QUICK_VERIFIER_HINT,
} from './taskFactoryBridge.js'

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
  const { queue, processing } = await listTasks()
  const signature = `q:${queue.map((t) => t.id).join(',')}|p:${processing.map((t) => `${t.id}:${t.status}`).join(',')}`
  const actions: string[] = []
  // 并行派发（2026-09-01 用户更正）：不在「无 processing 才派发」上做单任务串行约束，
  // 队列非空即注入派发指令，由主管按队列顺序一次派发多个任务。
  // 工厂设置并行上限（tf-pnsl5m5e）：processing 桶数量达到 maxParallelTasks 时
  // 跳过 dispatch 注入 —— 服务端强约束，防止主管超发；accept 指令不受限。
  if (queue.length > 0 && processing.length < settings.maxParallelTasks) actions.push('dispatch')
  const bg = getBackgroundRuntime()
  for (const t of processing) {
    const done = t.status === 'processing' && t.executorTaskId
      ? isTerminal(await bg.get(t.executorTaskId).catch(() => null))
      : false
    if (done) actions.push(`accept:${t.id}`)
  }
  if (actions.length === 0 || signature === lastSignature) return
  lastSignature = signature
  const first: string = actions[0]!
  if (first === 'dispatch') {
    // zai patch (2026-09-04, quick-intake):如果 queue 里含 quick 任务,在
    // dispatch 注入里追加 verifier light 提示段 —— 主管后续 spawn verifier
    // 时会读这段并走轻量验证(build + lint + 关键文件 diff 的 code review)。
    const hasQuick = queue.some((t) => t.mode === 'quick')
    const hint = hasQuick ? QUICK_VERIFIER_HINT : ''
    injectSupervisorCommand(`\n<task-command action="dispatch">The queue has tasks; dispatch them for execution in queue order (multiple at once is fine — tasks run in parallel).${hint ? ' NOTE: queue contains quick-mode tasks — their verifier rounds should follow the light path below.' : ''}</task-command>${hint}`)
  } else if (first.startsWith('accept:')) {
    const id = first.slice('accept:'.length)
    injectSupervisorCommand(`\n<task-command action="accept" id="${id}">The executor subagent has finished; please accept the task.</task-command>`)
  }
}