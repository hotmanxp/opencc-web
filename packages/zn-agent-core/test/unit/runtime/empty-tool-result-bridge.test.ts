import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest'

/**
 * Regression tests for the bridge's orphan-tool_use closure paths.
 *
 * Two paths exist:
 *   1. Vendor throws mid-stream (e.g. an internal SDK failure
 *      unhandled by vendor) → bridge's outer try/catch closes the
 *      orphan tool_use blocks via __zaiEventBus.
 *   2. Vendor yields an assistant message with stop_reason='error'
 *      → bridge's stream loop detects the stop reason and closes
 *      the orphan tool_use blocks.
 *
 * In both cases the bridge must:
 *   - Emit a `runtime.tool_result` (isError: true) for each orphan
 *     tool_use (so the UI doesn't leave Bash/Read cards stuck in
 *     "calling..." forever).
 *   - Emit a matching `runtime.error` and `runtime.done` so the SSE
 *     consumer closes the turn cleanly.
 *
 * Originally these paths were wired in to handle a specific
 * "emitted empty input" throw from buildOpenccQueryParams. That
 * throw has since been removed (empty tool_use inputs are now
 * normalised to {} and handed to vendor's zod validation, which
 * surfaces a recoverable <tool_use_error>InputValidationError the
 * LLM can retry against). The defensive paths remain useful for
 * other unhandled errors and assistant-error stop reasons, so the
 * tests now exercise them with generic error triggers.
 */
describe('openccQueryBridge — orphan tool_use closure on error', () => {
  let originalEmit: unknown
  let originalBridgeCtx: unknown
  let emitMock: ReturnType<typeof vi.fn>
  let captured: Array<{ type: string; [k: string]: unknown }>

  beforeEach(() => {
    captured = []
    emitMock = vi.fn((event: { type: string; [k: string]: unknown }) => {
      captured.push(event)
    })
    originalEmit = (globalThis as any).__zaiEventBus
    originalBridgeCtx = (globalThis as any).__zaiBridgeCtx
    ;(globalThis as any).__zaiEventBus = { emit: emitMock }
  })

  afterEach(() => {
    if (originalEmit === undefined) {
      delete (globalThis as any).__zaiEventBus
    } else {
      ;(globalThis as any).__zaiEventBus = originalEmit
    }
    if (originalBridgeCtx === undefined) {
      delete (globalThis as any).__zaiBridgeCtx
    } else {
      ;(globalThis as any).__zaiBridgeCtx = originalBridgeCtx
    }
    vi.resetModules()
    vi.doUnmock('@zn-ai/zn-agent-core/opencc-core')
    vi.doUnmock('../../../src/compat/runtime/buildOpenccQueryParams.js')
    vi.doUnmock('../../../src/compat/tools/opencc/builtin.js')
  })

  it('emits runtime.tool_result (isError: true) + runtime.done for orphan Bash tool_use when vendor throws mid-stream', async () => {
    // Simulate the stream vendor yields when something escapes its
    // own error handling mid-stream (e.g. an unexpected internal
    // exception in a tool execution path):
    //   message_start → content_block_start(tool_use Bash) → content_block_delta → content_block_stop
    //   → THROW from the opencc stream
    // The bridge's outer try/catch must close any orphan tool_use
    // blocks via __zaiEventBus so the UI doesn't leave the Bash
    // card stuck in "calling..." and the error text reaches the user.
    const toolUseId = 'toolu_bash_orphan_1'
    const errorText = 'simulated upstream SDK internal failure'

    async function* fakeOpenccStream() {
      yield {
        type: 'stream_event',
        event: {
          type: 'message_start',
          message: { id: 'msg_orphan', model: 'm', role: 'assistant' },
        },
      }
      yield {
        type: 'stream_event',
        event: {
          type: 'content_block_start',
          index: 0,
          content_block: { type: 'tool_use', id: toolUseId, name: 'Bash' },
        },
      }
      yield {
        type: 'stream_event',
        event: {
          type: 'content_block_delta',
          index: 0,
          delta: { type: 'input_json_delta', partial_json: '{}' },
        },
      }
      yield {
        type: 'stream_event',
        event: { type: 'content_block_stop', index: 0 },
      }
      // Vendor throws before message_stop — simulate that by
      // throwing mid-stream:
      throw new Error(errorText)
    }

    vi.resetModules()
    // Stub the opencc-core bundle import to return our fake stream.
    // Also stub buildOpenccQueryParams so the test bypasses real
    // LLM-required validation (which would otherwise throw at
    // build time, before the stream loop runs, and miss the catch
    // branch we want to exercise).
    vi.doMock('@zn-ai/zn-agent-core/opencc-core', () => ({
      query: (_params: unknown) => fakeOpenccStream(),
    }))
    vi.doMock('../../../src/compat/runtime/buildOpenccQueryParams.js', () => ({
      buildOpenccQueryParams: async () => ({
        tools: [],
        toolUseContext: { options: { tools: [] } },
      }),
      renderToolDescriptions: async () => {},
    }))
    vi.doMock('../../../src/compat/tools/opencc/builtin.js', () => ({
      getOpenccBuiltinTools: async () => [],
    }))

    const bridge = await import(
      '../../../src/compat/runtime/openccQueryBridge.js'
    )

    const events: unknown[] = []
    for await (const ev of bridge.runViaOpenccQuery(
      {
        prompt: { role: 'user', content: 'Run: echo hello && date. Show output.' },
        cwd: '/tmp',
        model: 'm',
        tools: [],
        sessionId: 'sess-orphan',
        abortSignal: new AbortController().signal,
      } as any,
      {} as any,
    )) {
      events.push(ev)
    }

    if (events.length === 0 && captured.length === 0) {
      throw new Error(
        `bridge emitted nothing — opencc-core bundle likely not stubbed`,
      )
    }

    // The bridge's outer catch should have emitted a runtime.tool_result
    // for the orphan tool_use (via __zaiEventBus) and a runtime.error /
    // runtime.done (via the bus OR via the returned AsyncIterable).
    const toolResultEvents = captured.filter(
      (event) => event.type === 'runtime.tool_result',
    )
    expect(toolResultEvents).toHaveLength(1)
    const toolResult = toolResultEvents[0] as any
    expect(toolResult.toolUseId).toBe(toolUseId)
    expect(toolResult.toolName).toBe('Bash')
    expect(toolResult.isError).toBe(true)
    expect(String(toolResult.output ?? '')).toMatch(/simulated upstream SDK internal failure/i)

    const errorEvents = captured.filter((event) => event.type === 'runtime.error')
    expect(errorEvents.length).toBeGreaterThanOrEqual(1)
    const errorEvent = errorEvents[0] as any
    const errorMessage = String(
      errorEvent.message ?? errorEvent.error?.message ?? '',
    )
    expect(errorMessage).toMatch(/simulated upstream SDK internal failure/i)

    const doneEvents = captured.filter((event) => event.type === 'runtime.done')
    expect(doneEvents.length).toBeGreaterThanOrEqual(1)
  })

  it('emits runtime.tool_result (isError: true) + runtime.error when vendor yields an assistant error message (stop_reason=error)', async () => {
    // Alternate failure mode: vendor doesn't throw — it yields a
    // synthetic assistant message with stop_reason:'error'. The
    // bridge's stream loop sees this assistant message, but
    // translateRuntimeEvents on the consumer side currently has no
    // visible-event mapping for it. Bridge must detect this and
    // emit synthetic closure events.
    const toolUseId = 'toolu_bash_orphan_2'
    const errorText = 'simulated upstream assistant error'

    async function* fakeOpenccStream() {
      yield {
        type: 'stream_event',
        event: {
          type: 'message_start',
          message: { id: 'msg_x', model: 'm', role: 'assistant' },
        },
      }
      yield {
        type: 'stream_event',
        event: {
          type: 'content_block_start',
          index: 0,
          content_block: { type: 'tool_use', id: toolUseId, name: 'Bash' },
        },
      }
      yield {
        type: 'stream_event',
        event: { type: 'content_block_stop', index: 0 },
      }
      yield {
        type: 'stream_event',
        event: { type: 'message_stop' },
      }
      // Vendor yields a synthetic assistant error message.
      yield {
        type: 'assistant',
        message: {
          id: 'msg_err',
          model: 'm',
          content: [{ type: 'text', text: errorText }],
          stop_reason: 'error',
        },
      }
    }

    vi.resetModules()
    vi.doMock('@zn-ai/zn-agent-core/opencc-core', () => ({
      query: (_params: unknown) => fakeOpenccStream(),
    }))
    vi.doMock('../../../src/compat/runtime/buildOpenccQueryParams.js', () => ({
      buildOpenccQueryParams: async () => ({
        tools: [],
        toolUseContext: { options: { tools: [] } },
      }),
      renderToolDescriptions: async () => {},
    }))
    vi.doMock('../../../src/compat/tools/opencc/builtin.js', () => ({
      getOpenccBuiltinTools: async () => [],
    }))

    const bridge = await import(
      '../../../src/compat/runtime/openccQueryBridge.js'
    )

    const events: unknown[] = []
    for await (const ev of bridge.runViaOpenccQuery(
      {
        prompt: { role: 'user', content: 'Run: echo hello && date. Show output.' },
        cwd: '/tmp',
        model: 'm',
        tools: [],
        sessionId: 'sess-orphan-2',
        abortSignal: new AbortController().signal,
      } as any,
      {} as any,
    )) {
      events.push(ev)
    }

    const toolResultEvents = captured.filter(
      (event) => event.type === 'runtime.tool_result',
    )
    expect(toolResultEvents).toHaveLength(1)
    const toolResult = toolResultEvents[0] as any
    expect(toolResult.toolUseId).toBe(toolUseId)
    expect(toolResult.toolName).toBe('Bash')
    expect(toolResult.isError).toBe(true)
    expect(String(toolResult.output ?? '')).toMatch(/simulated upstream assistant error/i)

    const errorEvents = captured.filter((event) => event.type === 'runtime.error')
    expect(errorEvents.length).toBeGreaterThanOrEqual(1)

    const doneEvents = captured.filter((event) => event.type === 'runtime.done')
    expect(doneEvents.length).toBeGreaterThanOrEqual(1)
  })
})
