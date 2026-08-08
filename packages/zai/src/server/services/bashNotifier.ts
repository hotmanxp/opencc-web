import type { BashTaskInfo } from '@zn-ai/zn-agent-core/bashTracker'
import {
  getRuntime,
  getCurrentSessionId,
  setCurrentSessionId,
  hasActiveQuery,
} from './agentRuntime.js'
import { resolveModel } from '../lib/resolveModel.js'
import { eventBus } from './eventBus.js'
import { translateRuntimeEvents } from '../routes/agent.js'

/**
 * BashNotifier:后台 Bash 任务完成时,按 opencc 原生机制触发父 session 一轮 query。
 *
 * opencc 机制:
 *   LocalShellTask 完成时,enqueueShellNotification 已把 <task-notification>
 *   塞进 bundle 内 commandQueue(priority 'next')。opencc 的 QueryEngine 在
 *   每轮 turn 开始前执行 mid-turn drain(query.ts:2644 getCommandsByMaxPriority),
 *   把 queue 里的通知作为 attachment 注入 LLM。zai 的 runtime.query() 走的就是
 *   这套 QueryEngine,所以**只要父 session 有一轮活跃 query,drain 就会生效**——
 *   后台 Bash 的通知天然送达 LLM。
 *
 * 为什么需要这个模块:
 *   zai 是 headless,没有 REPL 那套 idle-subscriber(enqueue → signal → 自动
 *   drain + run)。一旦后台 Bash 完成时父 session **没有活跃 turn**(用户没对话、
 *   父 turn 已结束),就没有 query 去 drain,opencc 已 enqueue 的通知永远躺在
 *   commandQueue 里,LLM 收不到——这正是 HRMSV3-ZN-WEBSITE#668 观察到的现象。
 *
 * 本模块补的正是"idle 时自动开一轮 query"这一环:bash_task.changed 进入
 * terminal 时,fire-and-forget 用 BashTaskInfo.sessionId 触发一轮
 * runtime.query()。占位 prompt 标记为 isMeta(UI 隐藏、仅是引导),真正内容由
 * QueryEngine 首轮 mid-turn drain 从 bundle 内 commandQueue 注入——通知文本
 * 完全由 opencc 生成,不在这里手拼。
 *
 * 双发安全:QueryEngine 的 mid-turn drain 在消费后 removeFromQueue,同一通知
 * 只会被 drain 一次。若父 turn 恰好活跃、opencc 已先 drain 掉通知,这里再触发
 * 的 query 遇到空 queue 也就只发占位引导,不重复注入通知。
 */
export interface BashNotifierOptions {
  /** 测试钩子:替换为 mock runtime。 */
  getRuntime?: typeof getRuntime
}

/** 占位 prompt:本身只是引导,内容由 QueryEngine drain 注入。isMeta 隐藏 UI。 */
export const BASH_NOTIFY_PLACEHOLDER =
  'A background task completed. Review the task notification for this turn and continue.'

let notifier: BashNotifier | null = null

export class BashNotifier {
  private readonly getRuntimeFn: typeof getRuntime

  constructor(opts: BashNotifierOptions = {}) {
    this.getRuntimeFn = opts.getRuntime ?? getRuntime
  }

  /**
   * bash_task.changed 回调。仅在任务进入 terminal 且携带有效 sessionId
   * 时触发,fire-and-forget 往父 session 开一轮 query 让 QueryEngine drain。
   * 异常仅 console.warn,不让后台回调把 server 弄崩。
   */
  async handle(e: { sessionId: string; task: BashTaskInfo }): Promise<void> {
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
    // 另起 query。通知已 enqueue 到 commandQueue,由 QueryEngine 的
    // mid-turn drain 注入给模型(对齐 opencc `if (running) return` 语义);
    // 只有主线 idle(没有活跃 query 去 drain)时才补一轮 query。防止通知
    // query 与主线并行、各自执行工具造成请求叠加。
    if (hasActiveQuery(sessionId)) return

    try {
      await this.inject(sessionId)
    } catch (err) {
      console.warn('[BashNotifier] inject failed:', err)
    }
  }

  private async inject(sessionId: string): Promise<void> {
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
      // sessionId = BashTaskInfo.sessionId 走 OpenCC vendor 续传路径。占位
      // prompt 标记 isMeta,内容由 QueryEngine 首轮 mid-turn drain 从 bundle
      // 内 commandQueue 注入 opencc 原生 <task-notification>。
      const events = runtime.query({
        prompt: BASH_NOTIFY_PLACEHOLDER,
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