import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest'

/**
 * Regression test for the broken error surfacing path in openccQueryBridge.
 *
 * Scenario (verified by user):
 *   1. LLM emits a tool_use for "Bash" with `input = {}` (empty).
 *   2. vendor's `buildOpenccQueryParams` (opencc-src) throws at the
 *      matching `content_block_stop` / `message_stop`.
 *   3. The throw escapes the for-await stream loop and lands in the
 *      bridge's outer `try { ... } catch (err) { yield toRuntimeErrorEvent(...) }`
 *      (openccQueryBridge.ts:404).
 *   4. Pre-fix: the bridge only yielded `runtime.error` — the orphan
 *      `Bash` tool_use (already pushed via the stream_event
 *      `content_block_start`) stayed "calling" forever in the UI and
 *      no `runtime.tool_result` was emitted, leaving the tool card
 *      dangling and the user with no visible error in the chat.
 *   5. Post-fix: the bridge additionally emits a synthetic
 *      `runtime.tool_result` (isError: true) for each orphan tool_use,
 *      and a `runtime.done`, BEFORE the `runtime.error` — so the UI
 *      closes the Bash card AND shows the error message.
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

  it('emits runtime.tool_result (isError: true) + runtime.done for orphan Bash tool_use when vendor throws', async () => {
    // Simulate the stream vendor yields when it decides to throw at
    // content_block_stop on a tool_use with empty input:
    //   message_start → content_block_start(tool_use Bash) → content_block_delta → content_block_stop
    //   → THROW inside `deps.callModel`/buildOpenccQueryParams
    // The throw must be visible to the bridge's outer try/catch.
    const toolUseId = 'toolu_bash_orphan_1'
    const errorText = '[buildOpenccQueryParams] tool_use "Bash" emitted empty input — refusing to execute.'

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
      // The vendor throws before message_stop — simulate that by
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
    expect(String(toolResult.output ?? '')).toMatch(/empty input/i)

    const errorEvents = captured.filter((event) => event.type === 'runtime.error')
    expect(errorEvents.length).toBeGreaterThanOrEqual(1)
    const errorEvent = errorEvents[0] as any
    const errorMessage = String(
      errorEvent.message ?? errorEvent.error?.message ?? '',
    )
    expect(errorMessage).toMatch(/empty input/i)

    const doneEvents = captured.filter((event) => event.type === 'runtime.done')
    expect(doneEvents.length).toBeGreaterThanOrEqual(1)
  })

  it('emits runtime.tool_result (isError: true) + runtime.error when vendor yields an assistant error message with the empty-input text', async () => {
    // Alternate failure mode: vendor doesn't throw — it yields a
    // synthetic assistant message containing the empty-input error
    // text and stop_reason:'error'. The bridge's stream loop sees
    // this assistant message, but translateRuntimeEvents on the
    // consumer side currently has no visible-event mapping for it.
    // Bridge must detect this and emit synthetic closure events.
    const toolUseId = 'toolu_bash_orphan_2'
    const errorText =
      '[buildOpenccQueryParams] tool_use "Bash" emitted empty input — refusing to execute.'

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
    expect(String(toolResult.output ?? '')).toMatch(/empty input/i)

    const errorEvents = captured.filter((event) => event.type === 'runtime.error')
    expect(errorEvents.length).toBeGreaterThanOrEqual(1)

    const doneEvents = captured.filter((event) => event.type === 'runtime.done')
    expect(doneEvents.length).toBeGreaterThanOrEqual(1)
  })
})
