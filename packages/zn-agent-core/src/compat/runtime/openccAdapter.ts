/**
 * runOpenccQuery — Node/tsx-compatible main loop, replaces opencc's query()
 * invocation. Does NOT require Bun runtime — the only Bun-only code in
 * the opencc vendor copy lives in `src/opencc-src/**` (bun:bundle / bun:feature
 * imports), and this adapter bypasses opencc-src entirely. The runtime
 * path is: openccAdapter → zai's own modelCaller (Anthropic SDK) → tools
 * from compat/tools/index.ts.
 *
 * Bun vs Node:
 *   - Node/tsx  ✅ works (this is the default — package.json dev script).
 *   - Bun       ✅ also works (slightly faster startup), but eats more RAM.
 *   The only constraint is: don't `import` anything from `opencc-src/`
 *   on the runtime path — those files use `bun:bundle` / `bun:feature`
 *   and break under Node. This adapter doesn't, and zai server shouldn't.
 *
 * Phase 1.b (option C) — the opencc vendor copy in `src/opencc-src/` is
 * structurally broken under direct Node import (the .js → .ts extension
 * fallback doesn't work for absolute paths, and 200+ of the imported
 * files are @ts-nocheck'd UI/utility code that the zai build doesn't need).
 * Rather than chase the full spec's 10-file rewrite (~700 LOC plus
 * rebuilding opencc's runtime), this adapter:
 *
 *   1. Calls zai's own `createAnthropicModelCaller()` (already wired at
 *      packages/zai/src/server/services/agentRuntime.ts) via the
 *      `modelCaller` slot of DefaultAgentRuntime's config.
 *   2. Streams the raw Anthropic SDK events, attaching zai meta fields
 *      (eventId / sessionId / ts / turnIndex), producing RuntimeEvents.
 *   3. Detects `tool_use` blocks at end of stream, executes them via
 *      `tool.call(input)` (real Bash/Read/Edit/Write/AskUserQuestion
 *      executors live in compat/tools/index.ts), and feeds `tool_result`
 *      blocks back to the model until no more tool_use is emitted (or
 *      max iterations hit).
 */

import { toRuntimeErrorEvent, toAbortedEvent } from './streamAdapter.js'
import type { QueryOptions, OpenccAdapterConfig, Tool } from './types.js'
import type { RuntimeEvent } from './events.js'

type ModelCaller = NonNullable<OpenccAdapterConfig['modelCaller']>

// Anthropic content-block shapes we accumulate per stream.
type AccumulatedTextBlock = { type: 'text'; text: string }
type AccumulatedThinkingBlock = { type: 'thinking'; thinking: string }
type AccumulatedToolUseBlock = {
  type: 'tool_use'
  id: string
  name: string
  input: Record<string, unknown>
}
type AccumulatedBlock =
  | AccumulatedTextBlock
  | AccumulatedThinkingBlock
  | AccumulatedToolUseBlock

type AccumulatedMessage = {
  blocks: AccumulatedBlock[]
  stopReason: string | null
}

/** Hard cap on tool_use ↔ tool_result iterations to prevent infinite loops. */
const MAX_TOOL_ITERATIONS = 10

export async function* runOpenccQuery(
  opts: QueryOptions,
  config: OpenccAdapterConfig,
): AsyncIterable<RuntimeEvent> {
  // sessionId 优先从 opts.sessionId 取, 兜底从 transcriptId 取 (老 zai
  // 端 routes/agent.ts 调 run() 时只用 transcriptId, 不设 sessionId, 导致
  // askRegistry.register(toolUseId, 'unknown', ...) 与 answer 路由用真实
  // sid 校验时撞 409 session_mismatch — 卡片不消失).
  const sessionId = opts.sessionId ?? opts.transcriptId ?? 'unknown'
  let eventCounter = 0
  const nextEventId = () => `evt-${++eventCounter}`

  // 1. Pre-aborted
  if (opts.abortSignal?.aborted) {
    yield toAbortedEvent({ sessionId, turnIndex: 0 }, String(opts.abortSignal.reason ?? 'aborted'))
    return
  }

  // 2. modelCaller must be wired by zai-server.
  const modelCaller = config.modelCaller as ModelCaller | undefined
  if (typeof modelCaller !== 'function') {
    yield toRuntimeErrorEvent(
      new Error(
        '[zn-agent-core] openccAdapter (Phase 1.b) requires modelCaller in OpenccAdapterConfig. ' +
          'zai-server must wire createAnthropicModelCaller() into the openccConfig block.',
      ),
      { sessionId, turnIndex: 0 },
    )
    return
  }

  // 3. Tool merge (config.tools ∪ opts.tools, opts wins by name).
  const configTools = config.tools ?? []
  const optsTools = opts.tools ?? []
  const toolsByName = new Map<string, Tool>()
  for (const t of configTools) toolsByName.set(t.name, t)
  for (const t of optsTools) toolsByName.set(t.name, t)
  const mergedTools = Array.from(toolsByName.values())

  // 4. Normalize prompt into the messages array the Anthropic SDK expects.
  let messages: Array<{ role: 'user' | 'assistant'; content: unknown }> =
    Array.isArray(opts.prompt)
      ? (opts.prompt as Array<{ role: 'user' | 'assistant'; content: unknown }>)
      : typeof opts.prompt === 'string'
        ? [{ role: 'user', content: opts.prompt }]
        : [opts.prompt as { role: 'user' | 'assistant'; content: unknown }]

  try {
    // 5. Main loop: stream model → execute tools → re-stream. Bounded by
    // MAX_TOOL_ITERATIONS so a runaway tool_use chain can't hang the SSE.
    for (let iteration = 0; iteration < MAX_TOOL_ITERATIONS; iteration++) {
      if (opts.abortSignal?.aborted) {
        yield toAbortedEvent({ sessionId, turnIndex: iteration }, String(opts.abortSignal.reason ?? 'aborted'))
        return
      }

      const accumulated: AccumulatedMessage = { blocks: [], stopReason: null }
      let sawMessageStop = false

      // Stream one model turn. We collect every upstream event into a
      // buffer *before* yielding to the SSE translator. Reason: when the
      // translator (translateRuntimeEvents) sees `message_stop` it does
      // `break` on its for-await, and the route handler stops pulling
      // from us. If we yielded each event live, our own for-await over
      // the upstream stream would stall at the yield, leaving
      // `accumulated.blocks` missing the trailing content_block_stop /
      // message_stop / message_delta events — and the tool_use blocks
      // would never be detected. Buffering solves this: we drain the
      // upstream completely, then yield each event downstream.
      const stream = (await modelCaller({
        model: opts.model ?? 'default',
        systemPrompt: opts.systemPrompt ?? [],
        messages,
        tools: mergedTools,
        signal: opts.abortSignal ?? new AbortController().signal,
      })) as AsyncIterable<Record<string, unknown>>

      const buffered: Array<{ raw: Record<string, unknown>; ev: RuntimeEvent }> = []
      try {
        for await (const rawEvent of stream) {
          if (opts.abortSignal?.aborted) {
            yield toAbortedEvent({ sessionId, turnIndex: iteration }, String(opts.abortSignal.reason ?? 'aborted'))
            return
          }
          const eventType = String((rawEvent as any).type ?? '')

          accumulateBlock(accumulated.blocks, rawEvent)

          if (eventType === 'message_delta') {
            accumulated.stopReason =
              String((rawEvent as any).delta?.stop_reason ?? accumulated.stopReason ?? '') ||
              accumulated.stopReason
          }
          if (eventType === 'message_stop') {
            sawMessageStop = true
          }

          buffered.push({
            raw: rawEvent,
            ev: {
              ...rawEvent,
              type: eventType,
              eventId: nextEventId(),
              sessionId,
              ts: Date.now(),
              turnIndex: iteration,
            } as RuntimeEvent,
          })
        }
        if (process.env.ZAI_DEBUG === '1') {
          console.error('[openccAdapter] drained upstream', {
            iteration,
            bufferedLen: buffered.length,
            types: buffered.map((b) => b.raw.type),
            blockCount: accumulated.blocks.length,
            sawMessageStop,
          })
        }
      } catch (err) {
        // Stream-level error mid-turn (e.g. network drop). Flush buffer,
        // then emit a runtime.error and stop the loop.
        for (const b of buffered) yield b.ev
        buffered.length = 0
        yield toRuntimeErrorEvent(err, { sessionId, turnIndex: iteration })
        return
      }

      // Upstream stream fully drained. Now yield buffered events, BUT skip
      // message_stop — the SSE translator (translateRuntimeEvents) breaks
      // its for-await on message_stop and closes its async generator.
// If we yielded message_stop mid-loop, the consumer would stop pulling
      // from us while we still need to feed tool_result blocks back to
      // the model in subsequent iterations. Defer message_stop until the
      // outer loop is fully done (we re-emit it after tool execution).
      let messageStopEv: RuntimeEvent | null = null
      for (const b of buffered) {
        if (b.raw.type === 'message_stop') {
          messageStopEv = b.ev
          continue
        }
        if (b.raw.type === 'error') {
          const err = (b.raw as any).error ?? b.raw
          yield toRuntimeErrorEvent(err, { sessionId, turnIndex: iteration })
          continue
        }
        yield b.ev
      }

      if (!sawMessageStop) {
        yield toRuntimeErrorEvent(
          new Error('response ended without message_stop'),
          { sessionId, turnIndex: iteration },
        )
      }

      const toolUseBlocks = accumulated.blocks.filter(
        (b): b is AccumulatedToolUseBlock => b.type === 'tool_use',
      )

      if (process.env.ZAI_DEBUG === '1') {
        console.error('[openccAdapter] turn end', {
          iteration,
          sawMessageStop,
          blockCount: accumulated.blocks.length,
          blockTypes: accumulated.blocks.map((b) => b.type),
          toolUseCount: toolUseBlocks.length,
        })
      }

      if (toolUseBlocks.length === 0) {
        // No tools to execute — emit the deferred message_stop (so the
        // translator can finish its for-await and the frontend status
        // flips back to idle), then return.
        if (messageStopEv) yield messageStopEv
        return
      }

      // 6. Execute each tool_use sequentially, in order. Build tool_result
      // blocks to feed back to the model. Errors become tool_result with
      // is_error:true so the model sees them as feedback, not crashes.
      const toolResultBlocks: Array<{
        type: 'tool_result'
        tool_use_id: string
        content: string
        is_error?: boolean
      }> = []
      for (const tb of toolUseBlocks) {
        // 字段名要对齐 opencc 上游 (toolExecution.ts) 与
        // zai server routes/agent.ts:translateRuntimeEvents() 的 translator —
        // 它们都从 ev.name / ev.id 取值, 而不是 ev.toolName / ev.toolUseId.
        // 之前写 toolName / toolUseId, translator 走 ?? "unknown" 兜底,
        // 前端 ToolCallBlock 永远显示 "unknown" 而非真实工具名 (Read/Bash/Edit…).
        yield {
          type: 'tool_use:start',
          sessionId,
          turnIndex: iteration,
          eventId: nextEventId(),
          ts: Date.now(),
          id: tb.id,
          name: tb.name,
          input: tb.input,
          // toolUseId / toolName 留为兼容副本 — 一些消费者可能仍按这两个名读。
          toolUseId: tb.id,
          toolName: tb.name,
        } as RuntimeEvent

        const tool = toolsByName.get(tb.name)
        if (!tool || typeof tool.call !== 'function') {
          toolResultBlocks.push({
            type: 'tool_result',
            tool_use_id: tb.id,
            content: `[zai] tool "${tb.name}" not registered; nothing to execute.`,
            is_error: true,
          })
          continue
        }
        // 工具通过 onYield 推入的事件必须实时 yield 给上游 — 不是等
        // tool.call resolve 之后再补. AskUserQuestion 是典型: 一进 call()
        // 就同步 ctx.onYield({type:'tool_use:ask_pending', ...}), 然后
        // await askRegistry.register(...) 阻塞等用户答复. 期间前端需要
        // 收到 prompt.ask → QuestionCard 立刻弹出. 如果等 tool.call
        // resolve 才 drain, 整段等待期间前端看不到 ask, 用户以为工具
        // 卡住, 按 ESC 取消后 tool.call 抛错 → catch 块 drain → 这才
        // 看到 ask (但已经 abort 了) — 错误体验.
        //
        // 模式: 后台跑 tool.call, 工具通过 onYield 把事件 push 到 queue
        // + 唤醒 drain waiter; 主循环反复 drain queue, 直到 tool 完成.
        const queue: Array<Record<string, unknown>> = []
        let drainWaiter: (() => void) | null = null
        const notifyDrain = () => {
          if (drainWaiter) {
            const w = drainWaiter
            drainWaiter = null
            w()
          }
        }
        const toolCtx = {
          cwd: opts.cwd,
          sessionId,
          toolUseId: tb.id,
          abortSignal: opts.abortSignal,
          askRegistry: config.askRegistry,
          onYield: (event: Record<string, unknown>) => {
            queue.push(event)
            notifyDrain()
          },
        }
        // 启动 tool.call (不 await — 我们边等边 drain)
        type ToolOutcome = { ok: true; value: unknown } | { ok: false; error: unknown }
        let outcome: ToolOutcome | null = null
        const toolPromise: Promise<unknown> = tool.call(tb.input, toolCtx)
        toolPromise.then(
          (v) => {
            outcome = { ok: true, value: v }
            notifyDrain()
          },
          (e) => {
            outcome = { ok: false, error: e }
            notifyDrain()
          },
        )
        // 主循环: 反复 drain queue, 工具未完就 await 唤醒信号
        const awaitDrain = () =>
          new Promise<void>((resolve) => {
            // 若已经有积压或工具已完, 立即 resolve — 不挂起 microtask
            if (queue.length > 0 || outcome) {
              resolve()
              return
            }
            drainWaiter = resolve
          })
        while (true) {
          while (queue.length > 0) {
            const ev = queue.shift() as Record<string, unknown>
            yield stampYieldedEvent(ev, { sessionId, turnIndex: iteration })
          }
          if (outcome) break
          await awaitDrain()
        }
        // 终态: 工具已 settle, 再 drain 一次 (兜底, 通常 queue 已空)
        while (queue.length > 0) {
          const ev = queue.shift() as Record<string, unknown>
          yield stampYieldedEvent(ev, { sessionId, turnIndex: iteration })
        }
        // `outcome` 在 while 循环里是 controlled — break 前已确认非 null.
        // 但 TS 看不到 break 后 outcome 必非 null, 用 as 收窄一下.
        const finalOutcome = outcome as ToolOutcome | null
        if (finalOutcome === null) {
          toolResultBlocks.push({
            type: 'tool_result',
            tool_use_id: tb.id,
            content: '[openccAdapter] tool.call did not produce an outcome (logic error)',
            is_error: true,
          })
        } else if (finalOutcome.ok) {
          const output = extractToolOutput(finalOutcome.value)
          toolResultBlocks.push({
            type: 'tool_result',
            tool_use_id: tb.id,
            content: output,
          })
          // Emit a `tool_use:done` event so the SSE translator in
          // zai's routes/agent.ts:219 can push a runtime.tool_result
          // to the frontend, closing the open ToolCallBlock. Without
          // this, the frontend stays stuck on "调用中..." forever even
          // though the LLM has already received the result via the
          // next-turn messages array. Use the same field shape as the
          // opencc vendor: { type, id, name, input, output, is_error }.
          yield {
            type: 'tool_use:done',
            sessionId,
            turnIndex: iteration,
            eventId: nextEventId(),
            ts: Date.now(),
            id: tb.id,
            name: tb.name,
            input: tb.input,
            toolUseId: tb.id,
            toolName: tb.name,
            output,
            is_error: false,
          } as RuntimeEvent
        } else {
          const err = finalOutcome.error
          const errMsg = err instanceof Error ? `${err.message}\n${err.stack ?? ''}` : String(err)
          toolResultBlocks.push({
            type: 'tool_result',
            tool_use_id: tb.id,
            content: errMsg,
            is_error: true,
          })
          // Mirror the success path: emit a tool_use:done so the frontend
          // gets a runtime.tool_result / runtime.error and closes the
          // ToolCallBlock instead of leaving it stuck in "调用中".
          yield {
            type: 'tool_use:error',
            sessionId,
            turnIndex: iteration,
            eventId: nextEventId(),
            ts: Date.now(),
            id: tb.id,
            name: tb.name,
            input: tb.input,
            toolUseId: tb.id,
            toolName: tb.name,
            output: errMsg,
            is_error: true,
            error: errMsg,
          } as RuntimeEvent
        }
      }

      // 7. Append the assistant message (preserving text + tool_use blocks)
      // and a user message containing the tool_result blocks. Anthropic
      // protocol requires tool_result to come in a user message immediately
      // after the assistant's tool_use blocks.
      messages = [
        ...messages,
        { role: 'assistant', content: blocksToAnthropicContent(accumulated.blocks) },
        { role: 'user', content: toolResultBlocks },
      ]
    }

    yield toRuntimeErrorEvent(
      new Error(`tool_use loop exceeded ${MAX_TOOL_ITERATIONS} iterations`),
      { sessionId, turnIndex: MAX_TOOL_ITERATIONS },
    )
  } catch (err) {
    yield toRuntimeErrorEvent(err, { sessionId, turnIndex: 0 })
  }
}

/**
 * Merge a streamed Anthropic content_block_* event into `blocks[index]`,
 * creating the slot on first sight (content_block_start) and filling
 * partial JSON / text on subsequent deltas (content_block_delta).
 */
function accumulateBlock(blocks: AccumulatedBlock[], raw: Record<string, unknown>): void {
  const type = String(raw.type ?? '')
  if (type === 'content_block_start') {
    const idx = Number(raw.index ?? blocks.length)
    const cb = (raw.content_block ?? {}) as Record<string, unknown>
    const blockType = String(cb.type ?? '')
    if (blockType === 'text') {
      blocks[idx] = { type: 'text', text: '' }
    } else if (blockType === 'thinking') {
      blocks[idx] = { type: 'thinking', thinking: '' }
    } else if (blockType === 'tool_use') {
      blocks[idx] = {
        type: 'tool_use',
        id: String(cb.id ?? ''),
        name: String(cb.name ?? ''),
        input: typeof cb.input === 'object' && cb.input !== null ? (cb.input as Record<string, unknown>) : {},
      }
    }
    return
  }
  if (type === 'content_block_delta') {
    const idx = Number(raw.index ?? blocks.length - 1)
    const slot = blocks[idx]
    if (!slot) return
    const delta = (raw.delta ?? {}) as Record<string, unknown>
    const deltaType = String(delta.type ?? '')
    if (slot.type === 'text' && deltaType === 'text_delta') {
      slot.text += String(delta.text ?? '')
    } else if (slot.type === 'thinking' && deltaType === 'thinking_delta') {
      slot.thinking += String(delta.thinking ?? '')
    } else if (slot.type === 'tool_use' && deltaType === 'input_json_delta') {
      // Anthropic streams tool input as partial JSON; concatenate then
      // parse once at content_block_stop. Cheap because the total payload
      // is small (<10 KB for typical tool inputs).
      const partial = String(delta.partial_json ?? '')
      ;(slot as unknown as { _rawInput?: string })._rawInput =
        ((slot as unknown as { _rawInput?: string })._rawInput ?? '') + partial
    }
    return
  }
  if (type === 'content_block_stop') {
    const idx = Number(raw.index ?? blocks.length - 1)
    const slot = blocks[idx]
    if (!slot) return
    if (slot.type === 'tool_use') {
      const rawInput = (slot as unknown as { _rawInput?: string })._rawInput
      if (typeof rawInput === 'string' && rawInput.length > 0) {
        try {
          slot.input = JSON.parse(rawInput) as Record<string, unknown>
        } catch {
          // Leave input as empty object — model emitted invalid JSON.
          slot.input = {}
        }
      }
      delete (slot as unknown as { _rawInput?: string })._rawInput
    }
  }
}

function blocksToAnthropicContent(blocks: AccumulatedBlock[]): unknown[] {
  return blocks
    .filter((b) => b.type === 'text' || b.type === 'tool_use')
    .map((b) => {
      if (b.type === 'text') return { type: 'text', text: b.text }
      return { type: 'tool_use', id: b.id, name: b.name, input: b.input }
    })
}

/**
 * 给工具通过 onYield 推上来的事件补 zai meta (eventId / sessionId /
 * ts / turnIndex). translateRuntimeEvents 看的就是这套字段, 缺一就
 * runtime.done / runtime.error 等事件类型判别会失配.
 */
function stampYieldedEvent(
  ev: Record<string, unknown>,
  meta: { sessionId: string; turnIndex: number },
): RuntimeEvent {
  return {
    ...ev,
    eventId: typeof ev.eventId === 'string' ? ev.eventId : `evt-tool-${++eventCounterForStamping}`,
    sessionId: typeof ev.sessionId === 'string' ? ev.sessionId : meta.sessionId,
    ts: typeof ev.ts === 'number' ? ev.ts : Date.now(),
    turnIndex: typeof ev.turnIndex === 'number' ? ev.turnIndex : meta.turnIndex,
  } as RuntimeEvent
}

// onYield 推的事件的 eventId 计数器 — 与 runOpenccQuery 主循环的
// eventCounter 完全独立 (那个走 nextEventId 闭包), 因为工具事件可能
// 在 yield 之后异步到达, 用单独的计数器更清晰.
let eventCounterForStamping = 0

/**
 * Extract the `output` string from a tool result. Our compat tools return
 * `{ output: string }`; opencc-style tools may return a content array or
 * a plain string. Normalize all to a string.
 */
function extractToolOutput(result: unknown): string {
  if (result == null) return ''
  if (typeof result === 'string') return result
  if (typeof result === 'object') {
    const r = result as { output?: unknown; content?: unknown }
    if (typeof r.output === 'string') return r.output
    if (Array.isArray(r.content)) {
      return r.content
        .map((c) => {
          if (typeof c === 'string') return c
          if (c && typeof c === 'object' && 'text' in c) return String((c as { text: unknown }).text ?? '')
          return JSON.stringify(c)
        })
        .join('\n')
    }
  }
  try {
    return JSON.stringify(result)
  } catch {
    return String(result)
  }
}