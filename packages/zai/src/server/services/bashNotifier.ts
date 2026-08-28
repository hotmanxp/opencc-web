import type { BashTaskInfo } from '@zn-ai/zn-agent-core'
import {
  getRuntime,
  getCoreRuntime,
  getCurrentSessionId,
  setCurrentSessionId,
  hasActiveQuery,
} from './agentRuntime.js'
import type { CoreRuntime } from '../../shared/settings.js'
import { resolveModel } from '../lib/resolveModel.js'
import { eventBus } from './eventBus.js'
import { translateRuntimeEvents } from '../routes/agent.js'

/**
 * BashNotifier:后台 Bash 任务完成时,给父 session 开一轮 query 让 LLM 感知。
 *
 * 为什么需要这个模块:
 *   zai 是 headless,没有 REPL 那套 idle-subscriber(enqueue → signal → 自动
 *   drain + run)。后台 Bash 完成时若父 session **没有活跃 turn**(用户没对话、
 *   父 turn 已结束),就没有 query 去处理任务完成通知,LLM 收不到——这正是
 *   HRMSV3-ZN-WEBSITE#668 观察到的现象。
 *
 * zai patch (2026-08-09): **不再依赖 vendor commandQueue drain**。
 *   背景(2026-08-09 的状态):LocalShellTask 被 esbuild 打包进
 *   `dist/opencc-core.mjs`(bundle 私有,见 compat/bashTracker.ts:389 的注释),
 *   它的 enqueueShellNotification 把 <task-notification> 写进 **bundle 内**的
 *   messageQueueManager commandQueue;而当时 runtime.query() 走
 *   `@zn-ai/zn-agent-core/opencc-server`(原 subpath,`dist/opencc-src/server/*.js`,
 *   与 bundle 是独立 module 实例),QueryEngine 的 mid-turn drain(query.ts:2644)
 *   读的是 **dist 的** commandQueue。两个 commandQueue 是不同 module 实例,
 *   通知永远 drain 不到 —— "通知作为系统消息插入"的假设完全失效(请求风暴
 *   根因:agent 收不到 dev 失败通知 → 盲目反复重启 dev → 每轮 1 次 API 调用
 *   雪崩,会话 sess-1786243017001 现场 78 次/分钟)。
 *   2026-08-16:opencc-server subpath 已废除,运行时统一主入口 = 单一 bundle
 *   实例,模块状态分裂问题不存在了。但本模块仍按 zai patch 的设计:不依赖
 *   vendor drain,直接用 BashTaskInfo 自己构造 <task-notification> 作为 prompt。
 *
 *   修复:这里用 BashTaskInfo 自己构造 <task-notification> 文本直接作为 prompt
 *   发给模型(与 SubagentNotifier 同构),不再依赖 vendor drain。running 守卫
 *   (hasActiveQuery)保留:主线活跃时通知**暂存**,主线结束由
 *   flushPendingBashNotifications 补发 —— 通知 query 不与主线并行、通知 query
 *   之间也互斥,杜绝并行 query 请求叠加。
 */
export interface BashNotifierOptions {
  /** 测试钩子:替换为 mock runtime。 */
  getRuntime?: typeof getRuntime
  /** 测试钩子:替换运行时读取(默认 getCoreRuntime)。 */
  getCore?: () => CoreRuntime
}

let notifier: BashNotifier | null = null

// zai patch (2026-08-09): 父 session 主线活跃时暂存的后台 Bash 完成通知。
// 后台任务完成时若主线 query 正在跑,直接 inject 会与主线并行(通知 query
// 加载完整父上下文,模型可能续跑主任务 → 重复执行 → 请求叠加)。主线结束
// (agent.ts runQueryLoop finally)由 flushPendingBashNotifications 补发,
// 保证通知 query 不与主线并行、互相之间也不并行。
const pendingNotifications = new Map<string, BashTaskInfo[]>()

/** 补发某 session 暂存的后台 Bash 完成通知。主线 query 结束(agent.ts finally)时调用。 */
export function flushPendingBashNotifications(sessionId: string): void {
  const tasks = pendingNotifications.get(sessionId)
  if (!tasks || tasks.length === 0) return
  pendingNotifications.delete(sessionId)
  // 主线已结束(idle),重新走 handle —— running 守卫放行,注入通知。
  for (const task of tasks) {
    void (notifier?.handle({ sessionId, task }) ?? Promise.resolve()).catch((err) =>
      console.warn('[BashNotifier] flush failed:', err),
    )
  }
}

/** 测试 seam:清空暂存队列。 */
export function __resetBashNotifierPendingForTests(): void {
  pendingNotifications.clear()
}

/**
 * 构造 <task-notification> 风格 user message 文本(基于 BashTaskInfo)。
 * summary 对齐 LocalShellTask.enqueueShellNotification 的措辞,并追加
 * "只确认结果、不续跑主任务"的引导 —— 通知 query 加载完整父上下文,不加
 * 引导的话模型会把通知误当成"继续干主任务"的信号(请求风暴的放大器)。
 */
export function renderBashNotificationMessage(task: BashTaskInfo): string {
  const status = task.status
  const exitCode = task.exitCode
  let summary: string
  switch (status) {
    case 'completed':
      summary = `Background command "${task.description}" completed${exitCode !== undefined ? ` (exit code ${exitCode})` : ''}`
      break
    case 'failed':
      summary = `Background command "${task.description}" failed${exitCode !== undefined ? ` with exit code ${exitCode}` : ''}`
      break
    case 'killed':
      summary = `Background command "${task.description}" was stopped`
      break
    default:
      summary = `Background command "${task.description}" ${status}`
  }
  const guidance =
    'This is a system notification about a background command. Acknowledge the result briefly; do not resume, restart, or continue the main task unless the result clearly requires it.'
  return (
    `<task-notification>\n` +
    `<task-id>${escapeXml(task.taskId)}</task-id>\n` +
    `<status>${status}</status>\n` +
    `<summary>${escapeXml(summary)}</summary>\n` +
    `</task-notification>\n\n` +
    guidance
  )
}

function escapeXml(s: string): string {
  // 防注入:破坏 < > & 让 LLM 看不到伪造标签
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}

export class BashNotifier {
  private readonly getRuntimeFn: typeof getRuntime
  private readonly getCoreFn: () => CoreRuntime

  constructor(opts: BashNotifierOptions = {}) {
    this.getRuntimeFn = opts.getRuntime ?? getRuntime
    this.getCoreFn = opts.getCore ?? getCoreRuntime
  }

  /**
   * bash_task.changed 回调。仅在任务进入 terminal 且携带有效 sessionId
   * 时触发,fire-and-forget 往父 session 开一轮 query 注入通知。
   * 异常仅 console.warn,不让后台回调把 server 弄崩。
   */
  async handle(e: { sessionId: string; task: BashTaskInfo }): Promise<void> {
    // zai patch (2026-08-28): inproc-print 运行时下**不注入**——后台 Bash 的
    // <task-notification> 由 vendor print 环原生 drain 投递
    // (LocalShellTask.enqueueShellNotification → bundle commandQueue →
    // print.ts drainCommandQueue mode 'task-notification')。inproc 与
    // default 不同:环与队列在同一 bundle 同一 module 实例,drain 可达,server 再
    // query 一份就是重复注入(同一事件双份 user 消息进 transcript)。
    // UI 侧 bash_task.changed SSE 不经这里,照常推送。
    if (this.getCoreFn() === 'inproc') return
    const task = e.task
    if (task.status !== 'completed' && task.status !== 'failed' && task.status !== 'killed') {
      return
    }
    // zai patch (2026-08-09): 只对真后台任务通知 LLM。前台命令(运行 ≥2s
    // 触发 registerForeground 的前台任务)完成时也会 emit bash_task.changed,
    // 但它们的执行结果已经直接回到工具循环,不该再触发通知 query —— 对齐
    // opencc 语义:只有 isBackgrounded 任务才 enqueueShellNotification。
    // 会话 sess-1786201578807 现场:每个 ≥2s 的前台命令完成都触发一个并行
    // runtime.query(),30 个并行循环共享"提交代码"上下文各自重跑 → 请求风暴。
    if (!task.isBackgrounded) return
    const sessionId = e.sessionId
    if (!sessionId || sessionId === 'sess-unknown') return // 兜底:无父 session 的占位 ID

    // zai patch (2026-08-09): running 守卫 —— 主 session 有活跃 query 时不
    // 另起 query,通知暂存,主线结束后由 flushPendingBashNotifications 补发。
    // 通知 query 自身不注册 sessionController,若主线活跃时仍走 inject,
    // 多个通知会同时通过守卫 → 多个通知 query 并行、各自加载完整父上下文
    // 续跑主任务 → 请求叠加。暂存保证通知 query 之间也互斥。
    if (hasActiveQuery(sessionId)) {
      const list = pendingNotifications.get(sessionId) ?? []
      list.push(task)
      pendingNotifications.set(sessionId, list)
      return
    }

    try {
      await this.inject(sessionId, task)
    } catch (err) {
      console.warn('[BashNotifier] inject failed:', err)
    }
  }

  private async inject(sessionId: string, task: BashTaskInfo): Promise<void> {
    const runtime = this.getRuntimeFn()

    // 保留并恢复 currentSessionId,避免通知注入影响后续状态(与 SubagentNotifier 一致)。
    const previousSessionId = getCurrentSessionId()

    let resolvedModel: string
    try {
      resolvedModel = resolveModel({ sessionModel: null, cwd: process.cwd() }).model
    } catch {
      resolvedModel = 'MiniMax-M3'
    }

    try {
      // 用 BashTaskInfo 构造 <task-notification> 直接作为 prompt。不再用占位
      // prompt 依赖 vendor commandQueue drain —— 见文件头注释:通知 enqueue 在
      // bundle 的 commandQueue,runtime.query() 的 QueryEngine 读 dist 的队列,
      // drain 永远取不到(请求风暴根因)。isMeta 保持 UI 隐藏(通知是系统注入,
      // 不该显示成用户消息)。
      const events = runtime.query({
        prompt: renderBashNotificationMessage(task),
        cwd: process.cwd(),
        sessionId,
        model: resolvedModel,
        isMeta: true,
      })
      // 把 queryEngine 的 runtime 事件翻译成 ServerEvent 并 emit 到 eventBus,
      // 让前端 SSE 渠道拿到 assistant 续写的 token / done 等事件。
      const translated = translateRuntimeEvents(
        events as AsyncIterable<Record<string, unknown>>,
        sessionId,
      )
      try {
        for await (const ev of translated) {
          eventBus.emit(ev)
          const t = (ev as { type?: string }).type
          if (t === 'runtime.done' || t === 'runtime.aborted' || t === 'runtime.error') break
        }
      } catch (streamErr) {
        console.warn('[BashNotifier] stream iteration failed:', streamErr)
      }
    } finally {
      if (previousSessionId !== null) {
        setCurrentSessionId(previousSessionId)
      }
    }
  }
}

/** Initialize the singleton. Idempotent. */
export function initBashNotifier(opts: BashNotifierOptions = {}): BashNotifier {
  if (notifier) return notifier
  notifier = new BashNotifier(opts)
  return notifier
}

export function getBashNotifier(): BashNotifier {
  if (!notifier) {
    throw new Error('BashNotifier not initialized; call initBashNotifier() first')
  }
  return notifier
}

/** Test seam: replace or clear the singleton. */
export function __setBashNotifier(n: BashNotifier | null): void {
  notifier = n
}