import type { Tool, ToolContext, ToolResult } from '../tools/Tool.js'
import type { RuntimeEvent } from './events.js'
import type { AskRegistryLike } from './types.js'
import { ASK_USER_QUESTION_TOOL_NAME } from '../tools/AskUserQuestionTool/prompt.js'

type ToolUseBlock = { id: string; name: string; input: unknown }

type EventMeta = {
  sessionId: string
  turnIndex: number
  nextEventId: () => string
}

/**
 * 串行 yield 每个工具的事件:
 *   - tool_use:start { toolUseId, name, input }
 *   - tool_use:ask_pending { toolUseId, questions, metadata? }  // AskUserQuestion 等待用户
 *   - tool_use:done  { toolUseId, output }    // 成功
 *   - tool_use:error { toolUseId, error }     // 抛错
 *   - tool_use:invalid { toolUseId, error }   // schema 解析失败
 *   - tool_use:denied  { toolUseId, reason }  // permission 拒绝 / ask 模式
 *
 * 同时把 tools 通过 ctx.emitEvent() 投递的 subagent:* / 其它事件
 * (例如 AgentTool 转发的 subSession 流) 透传给上层, 顺序与发生时间一致.
 *
 * 行为兼容旧约定:
 *   - 写 ctx.state.__lastToolResults = results, queryEngine 用它把结果回填给 LLM
 *   - tools 仍收到原始 ctx (而不是包装过的) — emitEvent 通过内部队列 bridge
 *   - askRegistry 可选, 用于支持 AskUserQuestion 的等待用户回答语义
 */
export async function* executeToolsStreaming(
  blocks: ToolUseBlock[],
  ctx: ToolContext,
  tools: Tool[],
  meta: EventMeta,
  askRegistry?: AskRegistryLike,
): AsyncGenerator<RuntimeEvent, void, void> {
  const results: ToolResult[] = new Array(blocks.length)
  ctx.state.__lastToolResults = results

  // 子事件队列: 收集 tool.call 内部 ctx.emitEvent() 投递的事件 (subagent:* 等).
  // 我们在每个 yield 间隙优先 drain 这个队列, 让子事件按发生时间穿插到 tool_use:* 主事件之间.
  const subQueue: RuntimeEvent[] = []
  const bridgedCtx: ToolContext = {
    ...ctx,
    emitEvent: (e) => {
      subQueue.push({
        ...e,
        eventId: meta.nextEventId(),
        sessionId: meta.sessionId,
        ts: Date.now(),
        turnIndex: meta.turnIndex,
      } as unknown as RuntimeEvent)
    },
    awaitAskUserQuestion: async () => {
      throw new Error('awaitAskUserQuestion called outside tool execution context')
    },
  }

  function* drainSubQueue(): Generator<RuntimeEvent> {
    while (subQueue.length > 0) {
      yield subQueue.shift() as RuntimeEvent
    }
  }

  function buildEvent(type: string, payload: Record<string, unknown>): RuntimeEvent {
    return {
      eventId: meta.nextEventId(),
      sessionId: meta.sessionId,
      ts: Date.now(),
      turnIndex: meta.turnIndex,
      type,
      ...payload,
    } as RuntimeEvent
  }

  // ---- 1. 权限判定 ----
  const permissionResults = await Promise.all(blocks.map(async b => {
    const tool = tools.find(t => t.name === b.name)
    if (!tool) return { behavior: 'deny' as const, reason: `unknown tool: ${b.name}` }
    return ctx.canUseTool(b.name, b.input)
  }))

  const executable: Array<{ index: number; block: ToolUseBlock; tool: Tool }> = []
  for (let i = 0; i < blocks.length; i++) {
    const b = blocks[i]!
    const pr = permissionResults[i]!
    const tool = tools.find(t => t.name === b.name)
    if (pr.behavior === 'deny') {
      results[i] = { toolUseId: b.id, content: `permission denied: ${pr.reason}`, isError: true }
      yield buildEvent('tool_use:denied', { toolUseId: b.id, reason: pr.reason })
    } else if (pr.behavior === 'ask') {
      results[i] = { toolUseId: b.id, content: 'permission ask-mode not supported', isError: true }
      yield buildEvent('tool_use:denied', { toolUseId: b.id, reason: 'ask-mode not yet supported' })
    } else if (!tool) {
      results[i] = { toolUseId: b.id, content: `unknown tool: ${b.name}`, isError: true }
    } else {
      executable.push({ index: i, block: b, tool })
    }
  }

  // ---- 2. 并发执行可执行工具, 串行 yield 各自事件 ----
  // 用 setImmediate 让 yield 的 micro-task 在同 tick 内的并行 tool 间合理交错
  for (const { index, block, tool } of executable) {
    const parsed = tool.inputSchema.safeParse(block.input)
    if (!parsed.success) {
      results[index] = {
        toolUseId: block.id,
        content: `invalid input: ${parsed.error.message}`,
        isError: true,
      }
      yield buildEvent('tool_use:invalid', { toolUseId: block.id, error: parsed.error.message })
      for (const sub of drainSubQueue()) yield sub
      continue
    }

    yield buildEvent('tool_use:start', {
      toolUseId: block.id,
      name: block.name,
      input: parsed.data,
    })
    for (const sub of drainSubQueue()) yield sub

    // AskUserQuestion: 在 tool.call 进入 await 之前直接 yield ask_pending.
    // 此前的实现把 ask_pending 塞进 ctx.emitEvent (queryEngine.makeToolContext
    // 里就是 no-op), 导致事件到不了 SSE → 前端 store.pendingAsk 永远 null →
    // QuestionCard 不渲染 → 用户没机会调 /api/agent/answer → registry.register
    // 永不 resolve → 5min HARD_TIMEOUT 兜底发 tool_use:error.
    // 修法: 提前在主 yield 流发事件, awaitAskUserQuestion 缩成单纯返回 registry 句柄,
    // 等用户提交时由 /api/agent/answer 把 answers 注入, register resolve, tool.call 续走.
    if (tool.name === ASK_USER_QUESTION_TOOL_NAME) {
      if (!askRegistry) {
        const msg = 'askRegistry not configured: cannot await AskUserQuestion answers'
        yield buildEvent('tool_use:error', { toolUseId: block.id, error: msg })
        results[index] = { toolUseId: block.id, content: `error: ${msg}`, isError: true }
        for (const sub of drainSubQueue()) yield sub
        continue
      }
      const askInput = parsed.data as { questions: unknown[]; metadata?: { source?: string } }
      yield buildEvent('tool_use:ask_pending', {
        toolUseId: block.id,
        questions: askInput.questions,
        ...(askInput.metadata ? { metadata: askInput.metadata } : {}),
      })
    }

    // 注入 ask hook (每次循环重置, 闭包捕获 block.id).
    // ask_pending 已在上面 yield; 这里只保留 registry 句柄, 等前端 /api/agent/answer 注入.
    bridgedCtx.awaitAskUserQuestion = async (_req) => {
      return askRegistry!.register(block.id, meta.sessionId, ctx.abortSignal)
    }

    try {
      const out = await tool.call(parsed.data, bridgedCtx)
      // tool 完成时, 先 flush 工具内部投递的事件 (e.g. subagent:done) 再 yield 主 done
      for (const sub of drainSubQueue()) yield sub
      yield buildEvent('tool_use:done', { toolUseId: block.id, output: out.output })
      // Anthropic SDK 对 tool_result.content 的约束是 string 或 typed content blocks,
      // 不能是裸对象. tools 比如 Bash 返回 string OK, 但 AskUserQuestionTool 输出
      // `{questions, answers, annotations}` (对象), queryEngine 直接把它塞进 content
      // 会被 SDK 拒绝 "invalid tool_result content (2013)". 这里统一 JSON.stringify
      // 非 string 的输出, Bash 路径走 typeof === 'string' 分支无额外成本.
      const content = typeof out.output === 'string'
        ? out.output
        : JSON.stringify(out.output)
      results[index] = {
        toolUseId: block.id,
        content,
        isError: out.isError ?? false,
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      for (const sub of drainSubQueue()) yield sub
      yield buildEvent('tool_use:error', { toolUseId: block.id, error: msg })
      results[index] = {
        toolUseId: block.id,
        content: `error: ${msg}`,
        isError: true,
      }
    }
  }

  // ---- 3. 收尾 flush (防御性: 还有没排出去的 sub 事件) ----
  for (const sub of drainSubQueue()) yield sub
}