/**
 * out-of-band tool_result 队列 —— vendor `runtime.tool_result` 事件是
 * 串在 queryLoop for-await 通路里同步 emit 的(translateRuntimeEvents →
 * routes/agent.ts 处理 → appendToolResult 落 transcript)。本模块为
 * 非 queryLoop 通路提供等价入站通道: 外部 inbox 消息可调 queueResult,
 * 把 tool_use result 同步进 transcript + 通过 eventBus 发 SSE, 让前端
 * UI 收到 `runtime.tool_result` 事件。
 *
 * 不引入 vendor 改动的边界: 仅暴露 queueResult(sessionId, toolUseId,
 * output, isError) 一个函数, 由 inboxMessageHandler 的 __zaiInboxBridge.
 * queueToolResult 字段调用。
 */
import { getTranscriptStore } from './agentRuntime.js'
import { eventBus } from './eventBus.js'
import { appendToolResult } from '@zn-ai/zn-agent-core'
import type { ServerEventInput } from './eventBus.js'

/**
 * 把一条 tool_result 投递到对应 session:
 *   1. appendToolResult 落 transcript(对齐 runtime.tool_result 通路)
 *   2. eventBus emit runtime.tool_result 让前端 SSE 收到
 *
 * turnIndex 取当前 turn 的全局 counter(0 fallback —— out-of-band 投递
 * 通常发生在 queryLoop 外, transcript 自己按 tool_use_id 找到对应 turn)。
 *
 * toolName/input 缺省用占位串 —— out-of-band 投递通常没带原始 tool 调用
 * 上下文, 前端 ToolCallBlock upsert 找不到 start 条目会 silently drop,
 * 但 SSE 通路保留事件流用于测试 / 调试观察。
 */
export function queueResult(
  sessionId: string,
  toolUseId: string,
  output: unknown,
  isError: boolean,
): void {
  if (!sessionId || !toolUseId) return
  const store = getTranscriptStore()
  // turnIndex = 0 fallback; out-of-band tool_result 不一定有明确 turn。
  // transcript 自身按 tool_use_id 关联, 不依赖 turnIndex。
  void appendToolResult(
    store,
    sessionId,
    {
      tool_use_id: toolUseId,
      content: typeof output === 'string' ? output : JSON.stringify(output ?? ''),
      is_error: isError === true,
    },
    0,
    null,
    process.cwd(),
  ).catch((err) => {
    console.warn('[toolExecution.queueResult] appendToolResult failed:', err)
  })

  const ev: ServerEventInput = {
    type: 'runtime.tool_result',
    sessionId,
    toolUseId,
    toolName: '',
    input: null,
    output: output ?? '',
    isError: isError === true,
    turnIndex: 0,
  } as unknown as ServerEventInput
  eventBus.emit(ev)
}