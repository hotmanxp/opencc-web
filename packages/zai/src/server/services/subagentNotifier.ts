import type { BackgroundTask } from '@zn-ai/zai-agent-core'
import { getRuntime, getCurrentSessionId, setCurrentSessionId } from './agentRuntime.js'
import { resolveModel } from '../lib/resolveModel.js'
import { eventBus } from './eventBus.js'
import { translateRuntimeEvents } from '../routes/agent.js'

/**
 * SubagentNotifier:把 BackgroundRuntime 子 agent 的完成事件回流到父 session。
 *
 * 为什么需要这个模块:
 *   AgentTool 默认走 BackgroundRuntime.dispatch() 异步派发,父 LLM 当场拿到
 *   <subagent_dispatched> 工具结果就 yield runtime.done 退出 queryEngine 循环,
 *   此后父 session 的 SSE 已经关闭,OpenCC 那套 "command queue + inbox drain"
 *   zai 又没有(`opencc-internals/utils/daemon/inboxSection.js` 缺失)。
 *
 * 简化方案:zai 端在 onTaskStateChange 触发时,fire-and-forget 用同一个 parentSessionId
 * 调 getRuntime().run({transcriptId, prompt: <task-notification>}),给父 session
 * 开新一轮 turn。这与 routes/agent.ts 的 POST /api/agent/prompt fire-and-forget
 * 流程同源,改 1 个新文件 + 几行 wiring 就能闭环。
 *
 * 通知格式参考 upstream opencc
 * (`opencc/src/tasks/LocalAgentTask/LocalAgentTask.tsx:253-258`):
 *   <task-notification>
 *   <task-id>...</task-id>
 *   <output-file>...</output-file>
 *   <status>completed|failed|cancelled</status>
 *   <summary>Agent "X" completed</summary>
 *   <result>final message</result>
 *   </task-notification>
 */
export interface SubagentNotifierOptions {
  /** 测试钩子:替换为 mock runtime。 */
  getRuntime?: typeof getRuntime
}

let notifier: SubagentNotifier | null = null

export class SubagentNotifier {
  private readonly getRuntimeFn: typeof getRuntime

  constructor(opts: SubagentNotifierOptions = {}) {
    this.getRuntimeFn = opts.getRuntime ?? getRuntime
  }

  /**
   * onTaskStateChange 钩子。仅在任务进入 terminal 且携带 parentSessionId
   * 时触发,fire-and-forget 往父 session 注入 <task-notification> 并启动新一轮
   * turn。异常仅 console.warn,不让后台回调把 server 弄崩。
   */
  async handle(task: BackgroundTask): Promise<void> {
    if (
      task.status !== 'completed' &&
      task.status !== 'failed' &&
      task.status !== 'cancelled'
    ) {
      return
    }
    const parentSessionId = task.parentSessionId
    if (!parentSessionId) return
    if (parentSessionId === 'sess-unknown') return // 兜底:无父 session 的占位 ID

    try {
      await this.inject(task)
    } catch (err) {
      console.warn('[SubagentNotifier] inject failed:', err)
    }
  }

  private async inject(task: BackgroundTask): Promise<void> {
    const runtime = this.getRuntimeFn()
    const prompt = renderTaskNotificationMessage(task)

    // 保留并恢复 currentSessionId,避免后续 abortAgentSession 误把
    // 通知注入时用的 parentSessionId 标记为"当前活跃" (queryEngine.run
    // 内部不修改 currentSessionId,这里只为防御性: 如果后续别处
    // 依赖 currentSessionId,通知注入不应影响它).
    const previousSessionId = getCurrentSessionId()

    // 用父 cwd 解析 model,沿用 routes/agent.ts 的 fallback 习惯
    let resolvedModel: string
    try {
      // 父 session 的 cwd 一般就是 process.cwd(),fallback 到 builtin
      resolvedModel = resolveModel({ sessionModel: null, cwd: process.cwd() }).model
    } catch {
      resolvedModel = 'MiniMax-M3'
    }

    try {
      // transcriptId = parentSessionId 走 zai-agent-core 续传路径,
      // 把 <task-notification> 追加到父 transcript 末尾,触发新一轮 turn.
      // isMetaPrompt: true 标记这条 user prompt 为系统注入 — 对齐 OpenCC isMeta
      // 语义: LLM 仍能看到 <task-notification> 内容,transcript 也落盘,
      // 但前端 UI 层不渲染这个 user 气泡 (用户看到的还是后续 assistant 续写).
      const events = runtime.run({
        prompt,
        cwd: process.cwd(),
        transcriptId: task.parentSessionId!,
        model: resolvedModel,
        isMetaPrompt: true,
      })
      // ★ 关键修复 (HRMSV3-ZN-WEBSITE#668):把 queryEngine 的 runtime 事件
      // 经 translateRuntimeEvents 翻译成 ServerEvent 形态并 emit 到 eventBus,
      // 让前端 SSE 渠道拿到 assistant 续写的 token / thinking / tool_call /
      // done 等事件,UI 会随之更新。之前的实现只消费 stream 不 emit
      // eventBus,导致 transcript 写进去了但前端永远卡在"派发后等通知"
      // 状态(看起来 LLM 没继续输出)。
      const sessionId = task.parentSessionId!
      const translated = translateRuntimeEvents(
        events as AsyncIterable<Record<string, unknown>>,
        sessionId,
      )
      try {
        for await (const ev of translated) {
          eventBus.emit(ev)
          // translateRuntimeEvents 已经会在 model message_stop 时自然结束。
          // 再多一层防御:遇到 runtime.{done,aborted,error} 也立即 break,
          // 避免意外阻塞 promise resolve。
          const t = (ev as { type?: string }).type
          if (t === 'runtime.done' || t === 'runtime.aborted' || t === 'runtime.error') break
        }
      } catch (streamErr) {
        // stream 迭代异常不应阻止 background 状态变化被记录
        console.warn('[SubagentNotifier] stream iteration failed:', streamErr)
      }
    } finally {
      // 恢复 currentSessionId(我们没有主动 set 过,但保险起见)
      if (previousSessionId !== null) {
        setCurrentSessionId(previousSessionId)
      }
    }
  }
}

/**
 * 构造 <task-notification> 风格 user message 文本。
 * 字段含义对齐 upstream `LocalAgentTask.tsx:253-258`。
 */
export function renderTaskNotificationMessage(task: BackgroundTask): string {
  const statusText = task.status
  const summary =
    task.status === 'completed'
      ? `Sub-agent "${task.description ?? task.id}" completed`
      : task.status === 'failed'
        ? `Sub-agent "${task.description ?? task.id}" failed: ${task.error?.message ?? 'unknown error'}`
        : `Sub-agent "${task.description ?? task.id}" was cancelled`

  // failed 时把 error 信息放在 result 字段里,让模型看到诊断细节
  const resultSection =
    task.status === 'completed' && task.resultText
      ? `\n<result>${escapeXml(task.resultText)}</result>`
      : task.status === 'failed' && task.error
        ? `\n<result>${escapeXml(`[error: ${task.error.message ?? 'unknown'} (${task.error.category ?? 'internal'})]`)}</result>`
        : task.status === 'cancelled'
          ? `\n<result>${escapeXml('[cancelled by user]')}</result>`
          : ''

  return (
    `<task-notification>\n` +
    `<task-id>${escapeXml(task.id)}</task-id>\n` +
    (task.agentType ? `<agent-type>${escapeXml(task.agentType)}</agent-type>\n` : '') +
    (task.description ? `<description>${escapeXml(task.description)}</description>\n` : '') +
    `<status>${statusText}</status>\n` +
    `<summary>${escapeXml(summary)}</summary>` +
    resultSection +
    `\n</task-notification>`
  )
}

function escapeXml(s: string): string {
  // 防注入:破坏 < > & 让 LLM 看不到伪造标签
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}

/** Initialize the singleton. Idempotent. */
export function initSubagentNotifier(opts: SubagentNotifierOptions = {}): SubagentNotifier {
  if (notifier) return notifier
  notifier = new SubagentNotifier(opts)
  return notifier
}

export function getSubagentNotifier(): SubagentNotifier {
  if (!notifier) {
    throw new Error('SubagentNotifier not initialized; call initSubagentNotifier() first')
  }
  return notifier
}

/** Test seam: replace or clear the singleton. */
export function __setSubagentNotifier(n: SubagentNotifier | null): void {
  notifier = n
}
