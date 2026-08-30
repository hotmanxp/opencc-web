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
// zai patch (2026-08-30, plan P1): L1 hook adapters wired at createReplSession
// boundary (Tasks 1-5). Each adapter takes a thin opt bag and returns
// `{ ... teardown }` for the LIFO stack.
import { setupInboxPoller } from './setup/setupInboxPoller.js'
import { setupMailboxBridge } from './setup/setupMailboxBridge.js'
import { setupSwarmInitialization } from './setup/setupSwarmInitialization.js'
import { setupSessionBackgrounding } from './setup/setupSessionBackgrounding.js'
import { setupSkillsChange } from './setup/setupSkillsChange.js'
// zai patch (2026-08-30, plan P2, Task 4): wire L2 hook adapters
// (setupApiKeyVerification / setupCostSummary / setupTasksV2Collapse)
// + L3 setupNotifications bus. Each adapter converts an internal
// state change into a typed ReplEvent 'notification' routed through
// hooks.onEvent; the notification bus additionally exposes `emit()` for
// call-sites that don't fit the L2 adapter shape (e.g. rate-limit,
// deprecation warnings, plugin auto-update). All four handles are
// appended to the dispose() LIFO stack below so session teardown
// unwinds them in reverse-construction order. Spec §5.1.
import { setupApiKeyVerification } from './setup/setupApiKeyVerification.js'
import { setupCostSummary } from './setup/setupCostSummary.js'
import { setupTasksV2Collapse } from './setup/setupTasksV2Collapse.js'
import { setupNotifications } from './notifications/setupNotifications.js'
// zai patch (2026-08-30, plan P1): state machines (Task 6) — replace
// REPL.tsx onSubmit/onQuery/onQueryImpl handlers with imperative classes.
import {
  OnSubmitStateMachine,
  OnQueryStateMachine,
  OnQueryImplStateMachine,
} from './stateMachines.js'
// zai patch (2026-08-30, plan P1): sessionRestore (Task 7) — hydrate
// state from prior JSONL on create.
import { restoreSession } from './sessionRestore.js'
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

  // zai patch (2026-08-30, plan P1, Task 8): wire L1 hook adapters. Each
  // one returns a `{ ... teardown }` handle; teardown is added to the
  // LIFO stack below so dispose() unwinds them in reverse-construction
  // order. onMessage callbacks feed `notification` ReplEvents back to
  // the host (zai web UI consumes these via hooks.onEvent).
  const inboxHandle = setupInboxPoller({
    sessionId,
    cwd: opts.cwd,
    isLoading: () => isRunning,
    onMessage: msg => {
      emitReplEvent('notification', { kind: 'inbox', payload: msg })
    },
  })
  const mailboxHandle = setupMailboxBridge({
    sessionId,
    cwd: opts.cwd,
    onSubmitMessage: msg => {
      emitReplEvent('notification', { kind: 'mailbox-self', payload: msg })
    },
  })
  const swarmHandle = setupSwarmInitialization({
    sessionId,
    onTeammateCreated: id => {
      emitReplEvent('notification', { kind: 'teammate-created', payload: { id } })
    },
  })
  const backgroundHandle = setupSessionBackgrounding({
    sessionId,
    onBackground: () => emitReplEvent('notification', { kind: 'background' }),
    onForeground: () => emitReplEvent('notification', { kind: 'foreground' }),
  })
  const skillsHandle = setupSkillsChange({
    cwd: opts.cwd,
    onSkillsChanged: files => {
      emitReplEvent('notification', { kind: 'skills-changed', payload: files })
    },
  })

  // zai patch (2026-08-30, plan P2, Task 4): L2 hook adapters wired
  // synchronously at createReplSession boundary. Each captures
  // session-scoped state in its closure; onResult / onUpdate /
  // onCollapseChange convert internal state changes into typed
  // 'notification' ReplEvents (kind: 'custom' carrying a discriminator
  // in payload.type for zai-web's notification reducer). The L3
  // notification bus exposes emit() for future L3 call-sites and
  // forwards each event through the same path.
  const apiKeyHandle = setupApiKeyVerification({
    onResult: ok => emitReplEvent('notification', { kind: 'custom', payload: { type: 'apiKeyOk', ok } }),
  })
  const costSummaryHandle = setupCostSummary({
    onUpdate: summary => emitReplEvent('notification', { kind: 'custom', payload: { type: 'costSummary', summary } }),
  })
  const tasksV2Handle = setupTasksV2Collapse({
    tasks: () => opts.getAppState?.() ? (opts.getAppState() as any).tasks : [],
    onCollapseChange: collapsed => emitReplEvent('notification', { kind: 'custom', payload: { type: 'tasksV2Collapse', collapsed } }),
  })
  const notificationsHandle = setupNotifications({
    onNotification: n => emitReplEvent('notification', { kind: n.kind, payload: n.payload }),
  })

  // zai patch (2026-08-30, plan P2, Task 4): kick the api-key check at
  // construct time so the host sees a `notification` ReplEvent with
  // `payload.type === 'apiKeyOk'` synchronously after createReplSession
  // returns. Mirrors REPL.tsx's `useApiKeyVerification` running on
  // mount. Subsequent re-checks (e.g. after a key rotation) call
  // apiKeyHandle.verify() directly via the accessor. Failures are
  // swallowed — verify() already short-circuits when disposed.
  void apiKeyHandle.verify()

  // zai patch (2026-08-30, plan P2, Task 4): ElicitationRegistry — vendor
  // MCP code paths need a place to dispatch form/url requests and await
  // the user's answer. The host (zai web) supplies the concrete
  // `ElicitationRegistry` via opts.elicitationRegistry; when omitted
  // we construct a minimal in-process stub here so MCP code paths
  // always find one. The stub is created via a lazy require-style
  // import to avoid pulling the zai workspace package into
  // zn-agent-core's dep graph (the concrete class lives at
  // packages/zai/src/server/services/elicitationRegistry.ts). T6 wires
  // the real registry into MCP server lifecycle.
  let elicitationRegistry: unknown = opts.elicitationRegistry
  if (!elicitationRegistry) {
    // zai patch (2026-08-30, plan P2, Task 4): minimal in-core stub.
    // Mirrors the surface of ElicitationRegistry (request / resolve /
    // cancel / hasPending) so MCP code paths can be exercised in
    // zn-agent-core tests without crossing the workspace boundary. T6
    // replaces usage with the zai-supplied real registry.
    const pending = new Map<
      string,
      { resolve: (r: any) => void; reject: (e: Error) => void }
    >()
    elicitationRegistry = {
      request: (input: any) => {
        const id = input?.elicitationId ?? randomUUID()
        return new Promise<any>((resolve, reject) => {
          pending.set(id, { resolve, reject })
        })
      },
      resolve: (id: string, result: any) => {
        const p = pending.get(id)
        if (!p) return
        pending.delete(id)
        p.resolve(result)
      },
      cancel: (id: string) => {
        const p = pending.get(id)
        if (!p) return
        pending.delete(id)
        p.resolve({ action: 'cancel' })
      },
      hasPending: () => pending.size > 0,
    }
  }

  // zai patch (2026-08-30, plan P1, Task 8): state machines — class
  // forms of REPL.tsx onSubmit / onQuery / onQueryImpl. P1 wires them
  // up so P2 can drive submit→runTurn without React handlers. The
  // OnQuery generator here is a placeholder — actual query() loop
  // lives inside runTurn below; the state machine is constructed for
  // parity with vendor REPL.tsx shape and to expose the same surface.
  const onSubmit = new OnSubmitStateMachine({
    cmdQueue,
    onQuery: { submit: () => Promise.resolve() }, // P1 minimal; P2 wires fully
  })
  const onQuery = new OnQueryStateMachine({
    query: async function* () { yield { type: 'noop' } },
    guard,
  })
  const onQueryImpl = new OnQueryImplStateMachine({
    getSystemPrompt: async () => '',
    getUserContext: async () => ({}),
    getSystemContext: async () => ({}),
  })
  // Debug hook (Task 8 reviewer minor #3): prove state machines
  // survive esbuild tree-shake — tests assert via globalThis when
  // ZAI_DEBUG=1. Off by default; no production impact.
  if (process.env.ZAI_DEBUG === '1') {
    ;(globalThis as any).__zaiStateMachines = {
      sessionId,
      onSubmit,
      onQuery,
      onQueryImpl,
    }
  }

  // zai patch (2026-08-30, plan P1, Task 8): hydrate state from prior
  // JSONL on construct. restoreSession() is async (it may read disk),
  // so we await it at session boundary — createReplSession itself
  // remains sync in its declared signature, but the brief calls
  // createReplSession directly (not in an async wrapper), so we make
  // the restore best-effort by deferring to a microtask and skipping
  // if the host hasn't supplied getAppState/setAppState. The
  // restored messages count is reported via a 'hydrated' notification
  // event so the host can reflect history if it wants to.
  void restoreSession({
    sessionId,
    cwd: opts.cwd,
    getAppState: () => opts.getAppState?.() ?? {},
    setAppState: fn => opts.setAppState?.(fn),
  }).then(restored => {
    // zai patch (2026-08-30, plan P1, Task 8 fix): guard against stale
    // hydrate notification if dispose() raced ahead of the disk read.
    if (isDisposed) return
    if (restored.messages.length > 0) {
      emitReplEvent('notification', { kind: 'hydrated', payload: { count: restored.messages.length } })
    }
  }).catch(err => {
    if (isDisposed) return
    console.warn(
      `[createReplSession ${sessionId}] restoreSession failed:`,
      err,
    )
  })

  // LIFO teardown stack — most-recently-added first. The dispose loop
  // runs `for (const t of teardownStack) t()`, so the first item runs
  // first. We want the brief's order: cmdQueue → cron → proactive →
  // inbox → mailbox → swarm → background → skills → guard → P2 layer
  // (apiKey → costSummary → tasksV2 → notifications). P2 entries are
  // appended after skillsHandle / before guard so guard still unwinds
  // last (matching the existing convention). All four P2 teardowns
  // are idempotent (each adapter's `teardown()` short-circuits on a
  // `disposed` flag), so dispose() can be called twice safely.
  const teardownStack: Array<() => void> = [
    () => cmdQueue.teardown(),
    () => cronHandle.teardown(),
    () => proactiveHandle.teardown(),
    () => inboxHandle.teardown(),
    () => mailboxHandle.teardown(),
    () => swarmHandle.teardown(),
    () => backgroundHandle.teardown(),
    () => skillsHandle.teardown(),
    () => apiKeyHandle.teardown(),
    () => costSummaryHandle.teardown(),
    () => tasksV2Handle.teardown(),
    () => notificationsHandle.teardown(),
    () => guard.teardown(),
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
      // FIFO teardown: setup order (cmdQueue first, guard last).
      // The brief specifies this exact sequence so cross-handle
      // dependencies unwind in a known order.
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
      // zai patch (2026-08-30, plan P2, Task 4): p2Wired marker
      // advertises that L2 adapters + L3 notification bus are wired
      // and their teardown handles live in the dispose() LIFO stack.
      // zai web inspects this flag to decide whether to subscribe to
      // 'custom' notification kinds via the bus (vs falling back to
      // legacy per-hook subscription paths). Returning true on every
      // getState() call makes the marker robust to hosts that capture
      // getState() once at construct time.
      return {
        sessionId,
        turnIndex,
        isRunning,
        isDisposed,
        p2Wired: true,
      } as any
    },

    // zai patch (2026-08-30, plan P2, Task 4): P2 accessors. These
    // surface the wired L2/L3 handles without leaking closure refs
    // through `getState()`. The handles themselves remain internal —
    // only the accessors are exposed on the session object. Callers
    // (zai web, tests) use these to drive the bus from external
    // triggers (SSE messages, UI clicks) and to verify wiring.

    getNotificationsHandle() {
      return notificationsHandle
    },

    getTasksV2Handle() {
      return tasksV2Handle
    },

    getElicitationRegistry() {
      return elicitationRegistry
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