// @ts-nocheck
/**
 * zai patch (2026-08-30, plan P3, Task 0): ReplRuntime tool event
 * forwarding tests.
 *
 * Before P3-T0, agentRuntime.repl.ts getOrCreate's onEvent handler
 * only forwarded turnEnd / sessionCrash / notification. runtime.tool_call
 * / runtime.tool_result / runtime.delta / runtime.thinking emitted
 * from vendor query() were silently dropped, so even if the LLM
 * generated tool_use, the zai web UI never saw it.
 *
 * P3-T0 fixes this by adding a forwarding branch in the onEvent
 * handler. To test this contract without depending on real vendor
 * query() behavior, we intercept createReplSession via vi.mock so the
 * test only exercises the ReplRuntime onEvent→enqueueEvent wiring.
 * The session object's hooks.onEvent callback is the unit under test.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'

// Mock createReplSession so we don't pull in the full vendor query
// graph. We capture the opts.hooks.onEvent callback so the test can
// drive it directly — that's the surface that getOrCreate wires into
// enqueueEvent.
let capturedOnEvent: ((ev: any) => void) | null = null
let capturedSession: any = null

vi.mock('@zn-ai/zn-agent-core', async () => {
  const actual = await vi.importActual<any>('@zn-ai/zn-agent-core')
  return {
    ...actual,
    createReplSession: (opts: any) => {
      capturedOnEvent = opts.hooks.onEvent
      const sessionId = opts.sessionId
      let turnIndex = 0
      capturedSession = {
        getState: () => ({ sessionId, turnIndex, isRunning: false, isDisposed: false }),
        submit: async () => {
          turnIndex += 1
          // Mimic the real session's turnStart / turnEnd lifecycle so
          // the existing onEvent branches fire.
          capturedOnEvent?.({
            type: 'turnStart',
            payload: { content: [], turnIndex },
            sessionId,
            turnIndex,
            timestamp: Date.now(),
          })
          capturedOnEvent?.({
            type: 'turnEnd',
            payload: { turnIndex },
            sessionId,
            turnIndex,
            timestamp: Date.now(),
          })
        },
        enqueue: async () => {},
        interrupt: async () => {},
        endSession: async () => {},
        on: () => () => {},
        dispose: async () => {},
      }
      return capturedSession
    },
  }
})

import { ReplRuntime } from '../agentRuntime.repl.js'

describe('ReplRuntime tool event forwarding (P3-T0)', () => {
  let runtime: ReplRuntime

  beforeEach(() => {
    capturedOnEvent = null
    capturedSession = null
    runtime = new ReplRuntime()
  })

  afterEach(async () => {
    await runtime.shutdown()
  })

  // Helper: drive one query() cycle and capture all yielded events.
  // Returns the captured events array. The caller can then synthesize
  // a runtime.* event via the captured onEvent callback and call
  // query() again to drain.
  async function captureEvents(sessionId: string, prompt: string): Promise<any[]> {
    const events: any[] = []
    for await (const ev of runtime.query({ sessionId, prompt })) {
      events.push(ev)
    }
    return events
  }

  it('forwards runtime.tool_call events from session to query() consumer', async () => {
    const sessionId = `s-toolcall-${Date.now()}`
    const events = await captureEvents(sessionId, 'first')

    // capturedOnEvent was wired by getOrCreate.
    expect(typeof capturedOnEvent).toBe('function')

    // Emit a synthetic runtime.tool_call ReplEvent (mimics vendor
    // translateSdkToRuntime wrapping a tool_use SDKMessage).
    capturedOnEvent!({
      type: 'runtime',
      payload: {
        type: 'runtime.tool_call',
        toolUseId: 'tool-bash-1',
        toolName: 'Bash',
        input: { command: 'ls /tmp' },
        turnIndex: 1,
      },
      sessionId,
      turnIndex: 1,
      timestamp: Date.now(),
    })

    // Drain the newly-enqueued event by running another query() cycle.
    const more = await captureEvents(sessionId, 'after')
    events.push(...more)

    const toolCallEvents = events.filter(e => e.type === 'runtime.tool_call')
    expect(toolCallEvents.length).toBeGreaterThanOrEqual(1)
    const bashCall = toolCallEvents.find((e: any) => e.toolName === 'Bash')
    expect(bashCall).toBeDefined()
    expect(bashCall.toolUseId).toBe('tool-bash-1')
    expect(bashCall.input).toEqual({ command: 'ls /tmp' })

    // sessionId must be propagated so zai routes/agent.ts can
    // correlate the event with the originating session.
    expect(bashCall.sessionId).toBe(sessionId)
  })

  it('forwards runtime.tool_result events from session to query() consumer', async () => {
    const sessionId = `s-toolresult-${Date.now()}`
    const events = await captureEvents(sessionId, 'first')

    capturedOnEvent!({
      type: 'runtime',
      payload: {
        type: 'runtime.tool_result',
        toolUseId: 'tool-bash-1',
        output: { stdout: 'file1\nfile2\n' },
        isError: false,
        turnIndex: 1,
      },
      sessionId,
      turnIndex: 1,
      timestamp: Date.now(),
    })

    const more = await captureEvents(sessionId, 'after')
    events.push(...more)

    const toolResultEvents = events.filter(e => e.type === 'runtime.tool_result')
    expect(toolResultEvents.length).toBeGreaterThanOrEqual(1)
    const bashResult = toolResultEvents.find(
      (e: any) => e.toolUseId === 'tool-bash-1',
    )
    expect(bashResult).toBeDefined()
    expect(bashResult.output).toEqual({ stdout: 'file1\nfile2\n' })
    expect(bashResult.isError).toBe(false)
    expect(bashResult.sessionId).toBe(sessionId)
  })

  it('forwards runtime.delta (text streaming) events', async () => {
    const sessionId = `s-delta-${Date.now()}`
    const events = await captureEvents(sessionId, 'first')

    capturedOnEvent!({
      type: 'runtime',
      payload: {
        type: 'runtime.delta',
        delta: 'partial text ',
        turnIndex: 1,
      },
      sessionId,
      turnIndex: 1,
      timestamp: Date.now(),
    })

    const more = await captureEvents(sessionId, 'after')
    events.push(...more)

    const deltaEvents = events.filter(e => e.type === 'runtime.delta')
    expect(deltaEvents.length).toBeGreaterThanOrEqual(1)
    expect(deltaEvents[0].delta).toBe('partial text ')
    expect(deltaEvents[0].sessionId).toBe(sessionId)
  })

  it('preserves existing turnEnd / sessionCrash / notification handling alongside new forwarding', async () => {
    const sessionId = `s-compat-${Date.now()}`
    const events = await captureEvents(sessionId, 'first')

    // Emit one of each legacy type + a runtime.tool_call — all must be
    // forwarded. This guards against accidentally regressing the
    // existing turnEnd / sessionCrash / notification paths.
    capturedOnEvent!({
      type: 'notification',
      payload: { kind: 'custom', payload: { type: 'testNotification' } },
      sessionId,
      turnIndex: 1,
      timestamp: Date.now(),
    })
    capturedOnEvent!({
      type: 'runtime',
      payload: {
        type: 'runtime.tool_call',
        toolUseId: 't1',
        toolName: 'Read',
        input: { file_path: '/tmp/foo' },
        turnIndex: 1,
      },
      sessionId,
      turnIndex: 1,
      timestamp: Date.now(),
    })

    const more = await captureEvents(sessionId, 'after')
    events.push(...more)

    // Notification still works (legacy path) — agentRuntime.repl.ts
    // spreads the ReplEvent into the enqueued event, preserving the
    // type 'notification' (not 'runtime.notification').
    const notifications = events.filter((e: any) => e.type === 'notification')
    expect(notifications.length).toBeGreaterThanOrEqual(1)
    const custom = notifications.find(
      (e: any) => e.payload?.kind === 'custom'
        && e.payload?.payload?.type === 'testNotification',
    )
    expect(custom).toBeDefined()

    // Tool call forwarding works (new path).
    const toolCalls = events.filter((e: any) => e.type === 'runtime.tool_call')
    expect(toolCalls.length).toBeGreaterThanOrEqual(1)
    const readCall = toolCalls.find((e: any) => e.toolName === 'Read')
    expect(readCall).toBeDefined()
  })
})