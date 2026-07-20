/**
 * 集成测试 — B. Streaming Tool Execution (createStreamingToolExecutor).
 *
 * Spec: docs/superpowers/specs/2026-07-19-zai-loop-resilience-b-streaming-tools-design.md
 * TDD: 9 个 case 对应 spec §3 行为 1-9 + spec §4 测试点。
 */
import { describe, test, expect } from 'vitest'
import { createStreamingToolExecutor } from '../../../../src/runtime/streaming/streamingToolExecutor.js'
import type {
  ParallelToolEvent,
  StreamingTool,
  StreamingToolResult,
  StreamingToolUse,
} from '../../../../src/runtime/streaming/types.js'

// Helpers ---------------------------------------------------------------

function makeTool(
  name: string,
  fn: (input: unknown) => Promise<{ content: string; isError?: boolean }>,
): StreamingTool {
  return {
    name,
    execute: async (input: unknown) => {
      const r = await fn(input)
      return {
        toolUseId: 'unused',
        content: r.content,
        isError: r.isError,
      }
    },
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

async function collectEvents(
  exec: ReturnType<typeof createStreamingToolExecutor>,
): Promise<ParallelToolEvent[]> {
  const out: ParallelToolEvent[] = []
  for await (const ev of exec.events()) out.push(ev)
  return out
}

// ------------------------------------------------------------------------

describe('integration: createStreamingToolExecutor (streaming tool execution)', () => {
  // ---- 1. submit + drain returns results in completion order ----

  test('submit + drain returns results in completion order', async () => {
    const ac = new AbortController()
    const tools = [
      makeTool('slow_a', async () => {
        await sleep(60)
        return { content: 'a' }
      }),
      makeTool('fast_b', async () => {
        await sleep(10)
        return { content: 'b' }
      }),
      makeTool('slow_c', async () => {
        await sleep(40)
        return { content: 'c' }
      }),
    ]
    const exec = createStreamingToolExecutor({
      tools,
      signal: ac.signal,
      sessionId: 'sess-1',
    })

    const blocks: StreamingToolUse[] = [
      { id: 'tu-1', name: 'slow_a', input: {} },
      { id: 'tu-2', name: 'fast_b', input: {} },
      { id: 'tu-3', name: 'slow_c', input: {} },
    ]
    for (const b of blocks) exec.submit(b)

    // Drain events in parallel; drain() collects results.
    const eventsPromise = collectEvents(exec)
    const results = await exec.drain()
    const events = await eventsPromise

    // Completion order should be fast_b (10ms) → slow_c (40ms) → slow_a (60ms),
    // NOT submit order.
    expect(results.map((r: StreamingToolResult) => r.toolUseId)).toEqual([
      'tu-2',
      'tu-3',
      'tu-1',
    ])
    expect(results.map((r) => r.toolName)).toEqual(['fast_b', 'slow_c', 'slow_a'])
    expect(results.map((r) => r.output)).toEqual(['b', 'c', 'a'])
    expect(results.every((r) => r.ok)).toBe(true)

    // Each submit should produce exactly one tool_call + one tool_result event.
    const calls = events.filter((e) => e.type === 'runtime.tool_call')
    const rets = events.filter((e) => e.type === 'runtime.tool_result')
    expect(calls).toHaveLength(3)
    expect(rets).toHaveLength(3)
    ac.abort()
  })

  // ---- 2. submit respects maxParallel (4 concurrent at most) ----

  test('submit respects maxParallel: at most N concurrent in-flight', async () => {
    const ac = new AbortController()
    let active = 0
    let peakActive = 0
    const totalSubmits = 12
    const tools: StreamingTool[] = [
      makeTool('counter', async () => {
        active++
        peakActive = Math.max(peakActive, active)
        await sleep(40)
        active--
        return { content: 'ok' }
      }),
    ]
    const exec = createStreamingToolExecutor({
      tools,
      maxParallel: 4,
      signal: ac.signal,
      sessionId: 'sess-2',
    })

    for (let i = 0; i < totalSubmits; i++) {
      exec.submit({ id: `tu-${i}`, name: 'counter', input: {} })
    }
    const eventsPromise = collectEvents(exec)
    const results = await exec.drain()
    await eventsPromise

    expect(results).toHaveLength(totalSubmits)
    // maxParallel is a hard ceiling. Allow ≤ maxParallel (some races may end
    // up a hair under due to microtask scheduling).
    expect(peakActive).toBeLessThanOrEqual(4)
    expect(peakActive).toBeGreaterThanOrEqual(2) // sanity: parallelism actually happened
    ac.abort()
  })

  // ---- 3. submit yields tool_call with parallel:true via event listener ----

  test('submit yields runtime.tool_call with parallel:true', async () => {
    const ac = new AbortController()
    const tools = [makeTool('echo', async (input) => ({ content: JSON.stringify(input) }))]
    const exec = createStreamingToolExecutor({
      tools,
      signal: ac.signal,
      sessionId: 'sess-3',
    })
    exec.submit({ id: 'tu-p', name: 'echo', input: { hello: 'world' } })
    const eventsPromise = collectEvents(exec)
    await exec.drain()
    const events = await eventsPromise

    const callEvent = events.find((e) => e.type === 'runtime.tool_call')
    expect(callEvent).toBeDefined()
    if (callEvent && callEvent.type === 'runtime.tool_call') {
      expect(callEvent.parallel).toBe(true)
      expect(callEvent.toolUseId).toBe('tu-p')
      expect(callEvent.toolName).toBe('echo')
      expect(callEvent.sessionId).toBe('sess-3')
      expect(callEvent.input).toEqual({ hello: 'world' })
    }
    ac.abort()
  })

  // ---- 4. submit yields tool_result after each tool completes ----

  test('submit yields runtime.tool_result immediately on each completion', async () => {
    const ac = new AbortController()
    const completionOrder: string[] = []
    const tools = [
      makeTool('a', async () => {
        await sleep(30)
        completionOrder.push('a')
        return { content: 'A' }
      }),
      makeTool('b', async () => {
        await sleep(5)
        completionOrder.push('b')
        return { content: 'B' }
      }),
    ]
    const exec = createStreamingToolExecutor({
      tools,
      signal: ac.signal,
      sessionId: 'sess-4',
    })

    exec.submit({ id: 'tu-a', name: 'a', input: {} })
    exec.submit({ id: 'tu-b', name: 'b', input: {} })

    const eventsPromise = collectEvents(exec)
    const results = await exec.drain()
    const events = await eventsPromise

    // tool_result events appear in completion order, interleaved with tool_call events.
    const resultEvents = events.filter((e) => e.type === 'runtime.tool_result')
    expect(resultEvents).toHaveLength(2)
    if (resultEvents[0] && resultEvents[0].type === 'runtime.tool_result') {
      expect(resultEvents[0].toolUseId).toBe('tu-b')
      expect(resultEvents[0].output).toBe('B')
      expect(resultEvents[0].ok).toBe(true)
    }
    if (resultEvents[1] && resultEvents[1].type === 'runtime.tool_result') {
      expect(resultEvents[1].toolUseId).toBe('tu-a')
      expect(resultEvents[1].output).toBe('A')
    }
    expect(results.map((r) => r.toolUseId)).toEqual(['tu-b', 'tu-a'])
    expect(completionOrder).toEqual(['b', 'a'])
    ac.abort()
  })

  // ---- 5. submit with non-existent tool → ok:false, output:'tool not found' ----

  test('submit with non-existent tool → ok:false, output:"tool not found"', async () => {
    const ac = new AbortController()
    const tools = [makeTool('known', async () => ({ content: 'k' }))]
    const exec = createStreamingToolExecutor({
      tools,
      signal: ac.signal,
      sessionId: 'sess-5',
    })
    exec.submit({ id: 'tu-missing', name: 'ghost', input: { x: 1 } })

    const eventsPromise = collectEvents(exec)
    const results = await exec.drain()
    const events = await eventsPromise

    expect(results).toHaveLength(1)
    expect(results[0]).toMatchObject({
      toolUseId: 'tu-missing',
      toolName: 'ghost',
      ok: false,
      output: 'tool not found',
    })

    // Should still have emitted a tool_call (UI needs to see "called") +
    // a tool_result.
    const callEv = events.find(
      (e) => e.type === 'runtime.tool_call' && e.toolUseId === 'tu-missing',
    )
    const resEv = events.find(
      (e) => e.type === 'runtime.tool_result' && e.toolUseId === 'tu-missing',
    )
    expect(callEv).toBeDefined()
    expect(resEv).toBeDefined()
    ac.abort()
  })

  // ---- 6. execute throws → drains with ok:false, output:<err.message>, stream continues ----

  test('execute throws → drains with ok:false, output:<err.message>; stream continues', async () => {
    const ac = new AbortController()
    const tools: StreamingTool[] = [
      makeTool('boom', async () => {
        throw new Error('synthetic tool failure')
      }),
      makeTool('ok', async () => ({ content: 'fine' })),
    ]
    const exec = createStreamingToolExecutor({
      tools,
      signal: ac.signal,
      sessionId: 'sess-6',
    })

    exec.submit({ id: 'tu-boom', name: 'boom', input: {} })
    exec.submit({ id: 'tu-ok', name: 'ok', input: {} })

    const eventsPromise = collectEvents(exec)
    const results = await exec.drain()
    const events = await eventsPromise

    expect(results).toHaveLength(2)
    const boomResult = results.find((r) => r.toolUseId === 'tu-boom')
    const okResult = results.find((r) => r.toolUseId === 'tu-ok')
    expect(boomResult).toBeDefined()
    expect(okResult).toBeDefined()
    if (boomResult) {
      expect(boomResult.ok).toBe(false)
      expect(boomResult.output).toBe('synthetic tool failure')
    }
    if (okResult) {
      expect(okResult.ok).toBe(true)
      expect(okResult.output).toBe('fine')
    }

    // No unhandled exception leaked: executor's promise itself never rejects
    // (verified by `await exec.drain()` not throwing).
    // Also assert both tool_result events were emitted.
    const resultEvents = events.filter((e) => e.type === 'runtime.tool_result')
    expect(resultEvents).toHaveLength(2)
    ac.abort()
  })

  // ---- 7. cancel() immediately resolves drain even with pending toolUses ----

  test('cancel() immediately resolves drain() even with pending toolUses', async () => {
    const ac = new AbortController()
    // Tool that takes a long time so cancel definitely has pending work to
    // drop.
    const tools = [
      makeTool('long', async () => {
        await sleep(500)
        return { content: 'too late' }
      }),
    ]
    const exec = createStreamingToolExecutor({
      tools,
      maxParallel: 2,
      signal: ac.signal,
      sessionId: 'sess-7',
    })

    // Submit 5 — with maxParallel=2, 3 will still be pending.
    for (let i = 0; i < 5; i++) {
      exec.submit({ id: `tu-${i}`, name: 'long', input: {} })
    }

    // Tiny delay so the executor has a chance to start at least one worker
    // (otherwise we'd be testing "drain on empty queue"). 10ms > 1 ms but
    // < 500ms (worker duration).
    await sleep(10)
    const drainStart = Date.now()
    exec.cancel()
    const results = await exec.drain()
    const drainMs = Date.now() - drainStart

    // Must resolve quickly (well under the 500ms worker duration).
    expect(drainMs).toBeLessThan(200)
    // At most maxParallel (2) results, since the rest were dropped from pending.
    expect(results.length).toBeLessThanOrEqual(2)
    ac.abort()
  })

  // ---- 8. AbortSignal abort → drain resolves with completed subset ----

  test('AbortSignal abort → drain resolves with completed subset', async () => {
    const ac = new AbortController()
    const tools = [
      makeTool('slow', async () => {
        // Long enough that the signal aborts mid-flight.
        await sleep(300)
        return { content: 'survived' }
      }),
    ]
    const exec = createStreamingToolExecutor({
      tools,
      maxParallel: 4,
      signal: ac.signal,
      sessionId: 'sess-8',
    })

    for (let i = 0; i < 6; i++) {
      exec.submit({ id: `tu-${i}`, name: 'slow', input: {} })
    }
    // Wait for the in-flight ones to start.
    await sleep(20)
    // Aborting mid-flight; in-flight workers continue to completion per
    // spec §3 #9, but new submits would be rejected. We then await drain
    // and check that the workers actually finished (subset is the full set
    // of in-flight jobs that started before abort).
    ac.abort()
    const results = await exec.drain()

    // No new submissions should have been accepted. The 4 in-flight (maxParallel)
    // should complete. Pending (2) are dropped.
    expect(results.length).toBeLessThanOrEqual(4)
    expect(results.every((r) => r.ok)).toBe(true)
    // After abort, any subsequent submit is a no-op:
    exec.submit({ id: 'tu-after-abort', name: 'slow', input: {} })
    const resultsAfter = await exec.drain()
    expect(resultsAfter).toHaveLength(results.length)
  })

  // ---- 9. full integration: 10 toolUses submitted in burst, all complete within reasonable time ----

  test('10 parallel toolUses complete in < 60% of serial time (spec §5 #4)', async () => {
    const ac = new AbortController()
    const PER_TOOL_MS = 100
    const N = 10
    const tools = [
      makeTool('work', async () => {
        await sleep(PER_TOOL_MS)
        return { content: 'done' }
      }),
    ]
    const exec = createStreamingToolExecutor({
      tools,
      maxParallel: 4, // spec default
      signal: ac.signal,
      sessionId: 'sess-9',
    })

    // Burst submit 10 tool_use blocks at once (mimics a long stream closing
    // multiple blocks back-to-back).
    for (let i = 0; i < N; i++) {
      exec.submit({ id: `tu-${i}`, name: 'work', input: { i } })
    }

    const eventsPromise = collectEvents(exec)
    const start = Date.now()
    const results = await exec.drain()
    const elapsed = Date.now() - start
    await eventsPromise

    expect(results).toHaveLength(N)
    expect(results.every((r) => r.ok)).toBe(true)

    // Serial baseline would be N * PER_TOOL_MS = 1000ms.
    // Spec §5 #4 demands parallel run < 60% of serial.
    const serial = N * PER_TOOL_MS
    const parallelBudget = Math.floor(serial * 0.6)
    expect(elapsed).toBeLessThan(parallelBudget)
    ac.abort()
  })
})
