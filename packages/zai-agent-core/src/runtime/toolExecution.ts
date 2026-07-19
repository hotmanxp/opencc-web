// @ts-nocheck -- runtime bridges between opencc-internals Tool shape (used by
// queryEngine) and zai's legacy events/types. opencc-internals/Tool.ts is itself
// @ts-nocheck and references types from places that don't exist in zai-agent-core
// (zustand, React render hooks, etc.), so we coerce at the boundary.

import type { Tool, ToolContext, ToolResult } from '../tools/Tool.js'
import type { RuntimeEvent } from './events.js'
import type { AskRegistryLike } from './types.js'
import type { TranscriptStore } from '../transcript/store.js'
import {
  appendToolResult,
  appendToolUse,
} from '../transcript/persistence.js'
import { ASK_USER_QUESTION_TOOL_NAME } from '../tools/AskUserQuestionTool/prompt.js'

type ToolUseBlock = { id: string; name: string; input: unknown }

type EventMeta = {
  sessionId: string
  turnIndex: number
  nextEventId: () => string
  /**
   * TranscriptStore passed in from queryEngine so each completed tool call
   * can persist its v2 tool_use + tool_result messages (Task 6).
   * Optional so existing test fixtures that don't care about persistence
   * keep working without plumbing a store.
   */
  store?: TranscriptStore
  /**
   * cwd of the active session, threaded into v2 tool_use + tool_result
   * messages so every persisted message carries the real cwd (not '').
   * Optional so existing fixtures that don't care about persistence
   * keep working without plumbing cwd.
   */
  cwd?: string
  /**
   * parentUuid chain anchor: the uuid of the immediately-prior persisted
   * message in the transcript (typically the assistant message that
   * contained this turn's tool_use blocks). Threaded through to
   * appendToolUse so tool_use's parentUuid === assistant's uuid, and
   * tool_result's parentUuid === tool_use's uuid. Optional — defaults to
   * null when not provided (test fixtures, ad-hoc callers).
   */
  parentUuid?: string | null
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

    const hookRunner = (ctx.state as any).__pluginHookRunner as import('../plugins/HookRunner.js').HookRunner | undefined
    if (hookRunner) {
      const pre = await hookRunner.run('PreToolUse', {
        toolName: block.name,
        input: parsed.data,
        sessionId: meta.sessionId,
      }, ctx.abortSignal)
      if (pre.blocked) {
        const reason = pre.outputs.map(output => String(output ?? '')).filter(Boolean).join('\n') || 'blocked by plugin hook'
        results[index] = { toolUseId: block.id, content: reason, isError: true }
        yield buildEvent('tool_use:denied', { toolUseId: block.id, reason })
        continue
      }
    }

    yield buildEvent('tool_use:start', {
      toolUseId: block.id,
      name: block.name,
      input: parsed.data,
    })
    for (const sub of drainSubQueue()) yield sub

    // Task 6: persist the tool_use block immediately after input is fully resolved.
    // The returned uuid is the parentUuid for the matching tool_result below,
    // matching the convention used by queryEngine-resume.test.ts (tool_result's
    // parentUuid === tool_use's uuid).
    //
    // Failure to persist must not abort tool execution — appendToolUse swallows
    // IO errors internally (logs to ZAI_DEBUG=1). If store isn't plumbed (test
    // fixtures, ad-hoc callers), skip persistence — events still flow through the
    // SSE path so the UI keeps working.
    const toolUseUuid = meta.store
      ? await appendToolUse(
          meta.store,
          meta.sessionId,
          { id: block.id, name: block.name, input: parsed.data },
          meta.turnIndex,
          meta.parentUuid ?? null,
          meta.cwd ?? '',
        )
      : undefined

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
      // Opencc-internals Tool.call signature: (args, context, canUseTool, parentMessage, onProgress?).
      // Legacy tools (wrapped by legacyAdapter.ts) only consume (args, context). The bridge
      // passes the zai canUseTool + a synthetic parentMessage (built below). zai's runtime
      // doesn't use parentMessage / onProgress, so they're no-ops here.
      const canUseToolFn = ctx.canUseTool
        ? async (_name: string, input: unknown) => ctx.canUseTool(tool.name, input)
        : undefined
      const out = await tool.call(parsed.data, bridgedCtx, canUseToolFn, {} as any)
      // tool 完成时, 先 flush 工具内部投递的事件 (e.g. subagent:done) 再 yield 主 done
      for (const sub of drainSubQueue()) yield sub
      // Opencc returns {data, isError, ...}. LegacyAdapter puts `output` into `data`,
      // so `out.data` is the unified result content.
      const outData = (out as any).data ?? (out as any).output
      const outIsError = (out as any).isError ?? false
      yield buildEvent('tool_use:done', { toolUseId: block.id, output: outData })
      const content = typeof outData === 'string'
        ? outData
        : JSON.stringify(outData)
      results[index] = {
        toolUseId: block.id,
        content,
        isError: outIsError,
      }
      // Persist tool_result BEFORE PostToolUse hook runs so that a throwing
      // hook can never leave the transcript with an orphan tool_use. Previously
      // appendToolResult was the last call in each branch, so any exception
      // from `hookRunner.run(...)` skipped persistence and produced dangling
      // parentUuid chains (Anthropic 2013 on resume). appendToolResult itself
      // swallows IO errors internally, so moving it earlier is safe.
      if (meta.store) {
        const trUuid = await appendToolResult(
          meta.store,
          meta.sessionId,
          { tool_use_id: block.id, content, is_error: outIsError },
          meta.turnIndex,
          toolUseUuid ?? null,
          meta.cwd ?? '',
        )
        if (trUuid) (ctx.state as Record<string, unknown>).__lastPersistedUuid = trUuid
      }
      // PostToolUse hook is best-effort: a failing hook must not abort the
      // tool result or the surrounding turn.
      if (hookRunner) {
        try {
          await hookRunner.run(outIsError ? 'PostToolUseFailure' : 'PostToolUse', {
            toolName: block.name,
            input: parsed.data,
            output: outData,
            sessionId: meta.sessionId,
          }, ctx.abortSignal)
        } catch (hookErr) {
          if (process.env.ZAI_DEBUG === '1')
            console.error('[toolExecution] PostToolUse hook threw', hookErr)
        }
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      for (const sub of drainSubQueue()) yield sub
      yield buildEvent('tool_use:error', { toolUseId: block.id, error: msg })
      const errorContent = `error: ${msg}`
      results[index] = {
        toolUseId: block.id,
        content: errorContent,
        isError: true,
      }
      // Persist error tool_result BEFORE PostToolUseFailure hook — same
      // rationale as the success branch. The model sees a balanced
      // tool_use/tool_result pair on resume regardless of hook behavior.
      if (meta.store) {
        const trUuid = await appendToolResult(
          meta.store,
          meta.sessionId,
          { tool_use_id: block.id, content: errorContent, is_error: true },
          meta.turnIndex,
          toolUseUuid ?? null,
          meta.cwd ?? '',
        )
        if (trUuid) (ctx.state as Record<string, unknown>).__lastPersistedUuid = trUuid
      }
      if (hookRunner) {
        try {
          await hookRunner.run('PostToolUseFailure', {
            toolName: block.name,
            input: parsed.data,
            error: msg,
            sessionId: meta.sessionId,
          }, ctx.abortSignal)
        } catch (hookErr) {
          if (process.env.ZAI_DEBUG === '1')
            console.error('[toolExecution] PostToolUseFailure hook threw', hookErr)
        }
      }
    }
  }

  // ---- 3. 收尾 flush (防御性: 还有没排出去的 sub 事件) ----
  for (const sub of drainSubQueue()) yield sub
}