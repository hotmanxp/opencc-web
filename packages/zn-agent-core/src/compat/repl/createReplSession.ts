// @ts-nocheck
/**
 * zai patch (2026-08-30, plan P0): createReplSession skeleton.
 * Imperative REPL session loop. Replaces print.ts instantiation path.
 * Spec: docs/superpowers/specs/2026-08-30-inproc-repl-extract-design.md §3-§6.
 *
 * P0 scope:
 *   - Wire setupCommandQueue + setupScheduledTasks + setupProactive + setupQueryGuard
 *   - submit / enqueue / interrupt / endSession / on / dispose / getState
 *   - ALS-wrapped turn path via runWithSdkContext + runWithSessionId
 *   - vendor `query()` for-await loop with `querySource: 'server-repl'`
 *   - translateSdkToRuntime wires SDKMessage → ReplEvent stream
 *   - LIFO teardown order in dispose
 */

import { randomUUID } from 'crypto'
import { runWithSdkContext } from '../../opencc-src/bootstrap/state.js'
import { runWithSessionId } from '../../compat/runWithSessionId.js'
import { setupCommandQueue } from './setup/setupCommandQueue.js'
import { setupScheduledTasks } from './setup/setupCronScheduler.js'
import { setupProactive } from './setup/setupProactive.js'
import { setupQueryGuard } from './setup/setupQueryGuard.js'
// zai patch (2026-08-30, plan P0): vendor query() integration (Task 8).
import { query } from '../../opencc-src/query.js'
// zai patch (2026-08-30, plan P0): SDK message → runtime event adapter (Task 8).
import { translateSdkToRuntime } from '../../compat/runtime/sdkEventAdapter.js'
// zai patch (2026-08-30, plan P0): use vendor's user message factory so
// the constructed UserMessage conforms to vendor's `Message` type
// (top-level `content: string` + nested `message.content`).
import { createUserMessage } from '../../opencc-src/utils/messages.js'
import type {
  ReplSession,
  ReplSessionOptions,
  ReplSessionState,
  ReplSessionLifecycleEvent,
  ReplEvent,
  ContentBlock,
} from './types.js'

export function createReplSession(opts: ReplSessionOptions): ReplSession {
  const sessionId = opts.sessionId
  let turnIndex = 0
  let isRunning = false
  let isDisposed = false
  const lifecycleSubs = new Map<
    ReplSessionLifecycleEvent,
    Set<(p?: unknown) => void>
  >()

  function emitLifecycle(
    event: ReplSessionLifecycleEvent,
    payload?: unknown,
  ): void {
    const set = lifecycleSubs.get(event)
    if (!set) return
    for (const cb of set) {
      try {
        cb(payload)
      } catch (err) {
        // Subscriber errors must not break the session.
        console.warn(
          `[createReplSession ${sessionId}] lifecycle ${event} subscriber threw:`,
          err,
        )
      }
    }
  }

  function emitReplEvent(type: ReplEvent['type'], payload?: unknown): ReplEvent {
    const ev: ReplEvent = {
      type,
      payload,
      sessionId,
      turnIndex,
      timestamp: Date.now(),
    }
    try {
      opts.hooks.onEvent(ev)
    } catch (err) {
      console.warn(
        `[createReplSession ${sessionId}] onEvent threw:`,
        err,
      )
    }
    return ev
  }

  // Setup adapters — all share session lifetime.
  const cmdQueue = setupCommandQueue()
  const cronHandle = setupScheduledTasks({
    sessionId,
    getAppState: () => opts.getAppState?.() ?? {},
    isLoading: () => isRunning,
  })
  const proactiveHandle = setupProactive({
    sessionId,
    isLoading: () => isRunning,
    queuedCommandsLength: () => cmdQueue.peek().length,
  })
  const guard = setupQueryGuard()

  // LIFO teardown stack — most-recently-created first.
  const teardownStack: Array<() => void> = [
    () => guard.teardown(),
    () => proactiveHandle.teardown(),
    () => cronHandle.teardown(),
    () => cmdQueue.teardown(),
  ]

  async function runTurn(content: ContentBlock[]): Promise<void> {
    if (isDisposed) {
      throw new Error(`createReplSession ${sessionId}: disposed`)
    }
    const gen = guard.state.tryStart()
    if (gen === null) {
      // Concurrent call — enqueue instead of running nested.
      cmdQueue.enqueue({
        value: JSON.stringify(content),
        mode: 'prompt',
        priority: 'next',
        uuid: randomUUID(),
        sessionId,
      })
      return
    }
    isRunning = true
    turnIndex += 1
    const thisTurnIndex = turnIndex

    emitLifecycle('turnStart', { content, turnIndex: thisTurnIndex })
    emitReplEvent('turnStart', { content, turnIndex: thisTurnIndex })

    try {
      await runWithSdkContext(
        {
          // SessionId type is branded; the string we hold is opaque here.
          sessionId: sessionId as any,
          sessionProjectDir: null,
          cwd: opts.cwd,
          originalCwd: opts.cwd,
        },
        () =>
          runWithSessionId(sessionId, async () => {
            // zai patch (2026-08-30, plan P0, Task 8): real vendor
            // query() for-await loop. Each SDKMessage is unwrapped by
            // translateSdkToRuntime into 0..N RuntimeEvents that we
            // re-emit through hooks.onEvent as ReplEvent (preserving
            // turnIndex so consumers can correlate). The
            // `querySource: 'server-repl'` literal lets vendor distinguish
            // an in-process server session from `repl_main_thread`
            // (terminal REPL) and `sdk` (CLI child process).
            //
            // P0 minimal params — full ToolUseContext population lands in
            // P1 once a real REPL-style AppState is plumbed through
            // zai web. For now an empty object satisfies the type, and
            // tests verify the call shape (querySource) via mock.
            const adapterMeta = {
              sessionId,
              turnIndex: thisTurnIndex,
              eventCounter: 0,
              toolNameByUseId: new Map<string, string>(),
              streamedBlockIndices: new Set<number>(),
            }
            // Build a single-user-message transcript: one user turn with
            // the submitted content blocks. P0 doesn't manage the
            // multi-turn transcript across submit() calls (that's
            // vendor's job inside query()); each submit() here is a
            // independent query() invocation in P0.
            const messages = [
              createUserMessage({
                content: content.map(toVendorContentBlock) as any,
                uuid: randomUUID(),
              }),
            ]
            for await (const sdkMsg of query({
              messages: messages as any,
              systemPrompt: [] as any,
              userContext: {},
              systemContext: {},
              canUseTool: opts.canUseTool ?? (async () => ({ behavior: 'allow' as const })),
              toolUseContext: {} as any,
              querySource: 'server-repl',
            })) {
              for (const runtimeEv of translateSdkToRuntime(sdkMsg, adapterMeta)) {
                emitReplEvent('runtime', runtimeEv)
              }
              adapterMeta.eventCounter += 1
            }
            emitLifecycle('turnEnd', { turnIndex: thisTurnIndex })
            emitReplEvent('turnEnd', { turnIndex: thisTurnIndex })
          }),
      )
    } catch (err) {
      emitReplEvent('sessionCrash', { error: String(err) })
      throw err
    } finally {
      isRunning = false
      guard.state.end(gen)
    }
  }

  return {
    async submit(content: ContentBlock[]): Promise<void> {
      if (isDisposed) {
        throw new Error(`createReplSession ${sessionId}: disposed`)
      }
      await runTurn(content)
    },

    async enqueue(
      content: ContentBlock[],
      priority: 'now' | 'next' | 'later',
    ): Promise<void> {
      if (isDisposed) {
        throw new Error(`createReplSession ${sessionId}: disposed`)
      }
      cmdQueue.enqueue({
        value: JSON.stringify(content),
        mode: 'prompt',
        priority,
        uuid: randomUUID(),
        sessionId,
      })
    },

    async interrupt(reason?: string): Promise<void> {
      // P0: just record intent; P1 wires to vendor control_request{interrupt}.
      if (isDisposed) return
      emitLifecycle('abort', { reason })
    },

    async endSession(reason?: string): Promise<void> {
      if (isDisposed) return
      emitLifecycle('sessionEnd', { reason })
    },

    on(
      event: ReplSessionLifecycleEvent,
      cb: (payload?: unknown) => void,
    ): () => void {
      let set = lifecycleSubs.get(event)
      if (!set) {
        set = new Set()
        lifecycleSubs.set(event, set)
      }
      set.add(cb)
      return () => {
        set!.delete(cb)
      }
    },

    async dispose(): Promise<void> {
      if (isDisposed) return
      isDisposed = true
      // LIFO teardown: reverse construction order so any cross-handle
      // dependencies unwind correctly.
      for (const teardown of teardownStack) {
        try {
          teardown()
        } catch (err) {
          console.warn(
            `[createReplSession ${sessionId}] teardown threw:`,
            err,
          )
        }
      }
      emitLifecycle('sessionEnd', { reason: 'dispose' })
    },

    getState(): ReplSessionState {
      return {
        sessionId,
        turnIndex,
        isRunning,
        isDisposed,
      }
    },
  }
}

/**
 * zai patch (2026-08-30, plan P0, Task 8): convert our ContentBlock shape
 * to vendor's opencc Message content block shape. P0 supports text only;
 * image / tool_use / tool_result passthrough as-is so future callsites
 * don't get silently dropped. Vendor will reject unknown shapes, but
 * keeping the field names aligned keeps P1 migration trivial.
 */
function toVendorContentBlock(
  block: ContentBlock,
): unknown {
  switch (block.type) {
    case 'text':
      return { type: 'text', text: block.text }
    case 'image':
      return { type: 'image', source: block.source }
    case 'tool_use':
      return {
        type: 'tool_use',
        id: block.id,
        name: block.name,
        input: block.input,
      }
    case 'tool_result':
      return {
        type: 'tool_result',
        tool_use_id: block.tool_use_id,
        content: block.content,
        is_error: block.is_error,
      }
    default: {
      const _exhaustive: never = block
      return _exhaustive
    }
  }
}