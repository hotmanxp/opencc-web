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
 *   - Synthetic turnStart + turnEnd emit (vendor query() integration lands in Task 8)
 *   - No cron fire / proactive tick routing wired beyond what setupXxx already provides
 *   - LIFO teardown order in dispose
 */

import { randomUUID } from 'crypto'
import { runWithSdkContext } from '../../opencc-src/bootstrap/state.js'
import { runWithSessionId } from '../../compat/runWithSessionId.js'
import { setupCommandQueue } from './setup/setupCommandQueue.js'
import { setupScheduledTasks } from './setup/setupCronScheduler.js'
import { setupProactive } from './setup/setupProactive.js'
import { setupQueryGuard } from './setup/setupQueryGuard.js'
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
            // P0: vendor query() integration lands in Task 8. For now,
            // emit synthetic turnEnd so the smoke tests verify the
            // event lifecycle end-to-end.
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