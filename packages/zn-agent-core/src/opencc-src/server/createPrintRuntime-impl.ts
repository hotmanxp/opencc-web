// @ts-nocheck
/**
 * createPrintRuntime — impl (P1 of the in-process print multi-session plan)
 * docs/superpowers/plans/2026-08-27-inprocess-print-multi-session-runtime.md
 *
 * One "REPL-equivalent" instance per sessionId, each driving the vendor
 * cli/print.ts loop in-process through startHeadlessPrintSession (P0).
 * Satisfies OpenccRuntimeV2: the frozen 8-method contract plus
 * enqueue / interrupt / getSessionState.
 *
 * Isolation model:
 *   - per instance: own headless context (createHeadlessContextImpl →
 *     own AppState store / tools pool / permission state), own NDJSON
 *     output pump, own turnIndex; the P0 ALS (printSessionRuntime +
 *     compat runWithSessionId + bootstrap runWithSdkContext) carries
 *     identity through the async chain.
 *   - instance creation is SERIALIZED (runExclusive): createHeadlessContextImpl
 *     touches process-global bootstrap STATE during build; same args every
 *     time so convergence is safe, but concurrent bootstraps could interleave
 *     plugin-cache resets — serialize until the vendor context factory is
 *     reentrant.
 *
 * P1 scope notes (deferred by design):
 *   - control_request{can_use_tool} from the loop is answered with an error
 *     response (bypassPermissions default means it never fires; the real
 *     permission bridge lands in P3, plan §5).
 *   - non-turn async output (cron/proactive fires with no active query) is
 *     dropped at turn start (drain); eventBus fan-out is P3.
 *   - idle TTL eviction is P2; only maxSessions LRU (idle-only) here.
 */
import { randomUUID } from 'node:crypto'
import { createHeadlessContextImpl } from './createHeadlessContext-impl.js'
import { createSessionFacadeImpl } from './sessionFacade-impl.js'
import { startHeadlessPrintSession } from './headlessPrintSession.js'
import { translateSdkToRuntime } from '../../compat/runtime/sdkEventAdapter.js'
import { transitionPermissionMode } from '../utils/permissions/permissionSetup.js'
import { getCurrentSessionId } from '../../compat/runWithSessionId.js'
import {
  createCronScheduler,
  type CronScheduler,
} from '../utils/cronScheduler.js'
import { processSessionStartHooks } from '../utils/sessionStart.js'
import { logForDebugging } from '../utils/debug.js'
import { updateHooksConfigSnapshot } from '../utils/hooks/hooksConfigSnapshot.js'
import type {
  AskBridgeFn,
  ElicitationBridgeFn,
  PermissionBridgeFn,
} from './createPrintRuntime.js'

/** Vendor control_request shape — kept narrow here; the consumer only reads
 *  the fields it actually routes on (subtype / tool_name / etc.). */
type ControlRequestMsg = {
  type: 'control_request'
  request_id: string
  request: {
    subtype: string
    tool_name?: string
    input?: Record<string, unknown>
    tool_use_id?: string
    permission_suggestions?: unknown
    // elicitation-only
    mcp_server_name?: string
    message?: string
    mode?: 'form' | 'url'
    url?: string
    elicitation_id?: string
    requested_schema?: Record<string, unknown>
  }
}

export async function createPrintRuntimeImpl(options) {
  const cwd = options.defaultCwd ?? process.cwd()
  const sessions = await createSessionFacadeImpl({
    cwd,
    dataDir: options.dataDir,
  })
  const instances = new Map()
  let closed = false

  /**
   * zai patch (2026-08-28): cheap transcript probe used by `createInstance`
   * to decide whether vendor resume is safe. Vendor's `getLastSessionLog`
   * returns null whenever the file has zero `user`/`assistant` entries
   * (it walks `loadSessionFile(...).messages.size`), and a null result
   * triggers the vendor "No conversation found" emit + gracefulShutdown
   * that dumps a stale `result: error_during_execution` line into our
   * stdout pipe — which the query generator then breaks on. A freshly
   * created zai session is exactly that state: `POST /api/agent/sessions`
   * wrote only metadata + a single user message, no assistant reply yet.
   * Cheap heuristic: scan the JSONL for any `assistant`-type line. Empty
   * / unreadable file → treat as "no history" (safe default — vendor
   * will start a new session instead of erroring out).
   */
  async function sessionHasAssistantMessage(
    sid: string,
    _sessionCwd: string,
  ): Promise<boolean> {
    try {
      const raw = await sessions.readTranscript(sid)
      for (const line of raw.split('\n')) {
        const trimmed = line.trim()
        if (!trimmed) continue
        try {
          const parsed = JSON.parse(trimmed) as { type?: unknown }
          if (parsed.type === 'assistant') return true
        } catch {
          // ignore malformed lines
        }
      }
      return false
    } catch {
      return false
    }
  }
  // P3 (plan §7 path A, hook snapshot): zai-server path doesn't go through
  // vendor's `setup.ts:166` captureHooksConfigSnapshot, so we lazy-init
  // here. First `createInstance` triggers `updateHooksConfigSnapshot()`
  // (which reads `~/.zai/settings.json` + cwd `.zai/settings.json` merged
  // settings, captures the hooks tree, and resets the session cache).
  // Subsequent processSessionStartHooks calls reuse the captured snapshot.
  let hooksSnapshotCaptured = false

  // Serialize per-instance headless-context bootstraps (see header note).
  let bootstrapChain = Promise.resolve()
  function runExclusive(fn) {
    const result = bootstrapChain.then(fn, fn)
    bootstrapChain = result.then(
      () => {},
      () => {},
    )
    return result
  }

  // Buffered NDJSON line pump (push outside, pull inside query turns).
  function createLinePump() {
    const buffer = []
    let waiter = null
    return {
      push(line) {
        if (waiter) {
          const w = waiter
          waiter = null
          w(line)
        } else {
          buffer.push(line)
        }
      },
      next() {
        if (buffer.length > 0) return Promise.resolve(buffer.shift())
        return new Promise(resolve => {
          waiter = resolve
        })
      },
      /** Drop buffered pre-turn lines (stale output from earlier turns). */
      drain() {
        buffer.length = 0
      },
    }
  }

  function controlResponseError(requestId, error) {
    return {
      type: 'control_response',
      response: { subtype: 'error', request_id: requestId, error },
    }
  }

  function controlResponseSuccess(requestId, payload) {
    return {
      type: 'control_response',
      response: {
        subtype: 'success',
        request_id: requestId,
        response: payload,
      },
    }
  }

  // P3 (plan §5): three-way control_request routing. All branches fall back
  // to a deny/cancel error response when the matching bridge is absent so
  // vendor never hangs waiting on the SDK host.
  async function handleControlRequest(rec, msg) {
    const subtype = msg?.request?.subtype
    const requestId = msg?.request_id
    if (typeof requestId !== 'string') return
    const sessionId = getCurrentSessionId() ?? rec.sessionId
    if (subtype === 'can_use_tool') {
      const toolName = msg.request.tool_name
      const toolInput = msg.request.input ?? {}
      const toolUseId =
        msg.request.tool_use_id ?? `${rec.sessionId}:${requestId}`
      if (toolName === 'AskUserQuestion' && options.askBridge) {
        try {
          const result = await options.askBridge({
            sessionId,
            toolUseId,
            requestId,
            input: {
              questions: toolInput.questions,
              metadata: toolInput.metadata,
            },
          })
          rec.session.writeLine(
            controlResponseSuccess(requestId, {
              behavior: 'allow',
              updatedInput: { answers: result.answers },
            }),
          )
        } catch (err) {
          rec.session.writeLine(
            controlResponseError(
              requestId,
              `askBridge threw: ${String(err)}`,
            ),
          )
        }
        return
      }
      if (options.permissionBridge) {
        try {
          const result = await options.permissionBridge({
            sessionId,
            toolUseId,
            requestId,
            toolName: toolName ?? '<unknown>',
            input: toolInput,
            permissionSuggestions: msg.request.permission_suggestions,
          })
          rec.session.writeLine(
            controlResponseSuccess(requestId, {
              behavior: result.behavior,
              ...(result.message ? { message: result.message } : {}),
              ...(result.updatedInput
                ? { updatedInput: result.updatedInput }
                : {}),
            }),
          )
        } catch (err) {
          rec.session.writeLine(
            controlResponseError(
              requestId,
              `permissionBridge threw: ${String(err)}`,
            ),
          )
        }
        return
      }
      // No bridge — refuse so vendor doesn't hang. Use deny for AskUserQuestion
      // (matches vendor semantics) and the synthetic SANDBOX_* / unknown tool
      // names too.
      rec.session.writeLine(
        controlResponseError(
          requestId,
          `inproc print runtime: no permissionBridge for tool '${toolName ?? '<unknown>'}'`,
        ),
      )
      return
    }
    if (subtype === 'elicitation') {
      if (options.elicitationBridge) {
        try {
          const result = await options.elicitationBridge({
            sessionId,
            requestId,
            mcpServerName: msg.request.mcp_server_name ?? '',
            message: msg.request.message ?? '',
            mode: msg.request.mode === 'url' ? 'url' : 'form',
            ...(msg.request.url ? { url: msg.request.url } : {}),
            ...(msg.request.elicitation_id
              ? { elicitationId: msg.request.elicitation_id }
              : {}),
            ...(msg.request.requested_schema
              ? { requestedSchema: msg.request.requested_schema }
              : {}),
          })
          const payload = {
            action: result.action,
            ...(result.content ? { content: result.content } : {}),
          }
          rec.session.writeLine(controlResponseSuccess(requestId, payload))
        } catch (err) {
          rec.session.writeLine(
            controlResponseError(
              requestId,
              `elicitationBridge threw: ${String(err)}`,
            ),
          )
        }
        return
      }
      // No bridge — cancel so MCP server doesn't block.
      rec.session.writeLine(
        controlResponseSuccess(requestId, { action: 'cancel' }),
      )
      return
    }
    // P4+ — set_permission_mode / interrupt / end_session handled directly by
    // vendor structuredIO. Any other subtype is unknown to the runtime; send
    // an error so the caller doesn't hang.
    rec.session.writeLine(
      controlResponseError(
        requestId,
        `Unsupported control request subtype: ${subtype}`,
      ),
    )
  }

  async function createInstance(sessionId, input = {}) {
    // P2 observability: per-instance bootstrap is the dominant cold-query
    // latency (createHeadlessContext full build); log it so zai-side p95
    // investigations can separate bootstrap from model time.
    const t0 = Date.now()
    const rec = {
      sessionId,
      ctx: null,
      session: null,
      lines: createLinePump(),
      turnIndex: 0,
      turnActive: false,
      lastActivity: Date.now(),
    }
    const ctx = await runExclusive(() =>
      createHeadlessContextImpl({
        cwd,
        dataDir: options.dataDir,
        runtimeId: `${options.runtimeId ?? 'zai-print'}:${sessionId}`,
        connectMcp: options.connectMcp ?? false,
        isInteractive: options.interactive ?? true,
        permissionMode:
          input.permissionMode ?? options.permissionMode ?? 'bypassPermissions',
        // zai patch (2026-08-29, plan §A): forward per-instance option so
        // the headless context can lock bypass availability. Default false.
        dangerouslySkipPermissions: options.dangerouslySkipPermissions,
        // zai patch (2026-08-29, plan §3.7.2): forward per-instance sessionId
        // so headless context can dispatch tools / mcp slot through
        // AgentRegistry (Task 7). zai-server is expected to have
        // registryAgent(sessionId, agentId) called before this point.
        sessionId,
      }),
    )
    rec.ctx = ctx
    if (options.defaultModel) {
      ctx.appState.setState(prev => ({ ...prev, mainLoopModel: options.defaultModel }))
    }
    const state = ctx.appState.getState()
    // Hydrate existing transcripts via the vendor resume chain (P0
    // advantage: file history / worktree / attribution / mode all restore).
    //
    // zai patch (2026-08-28): only pass `resume` when the session actually
    // has assistant messages. The zai-side `POST /api/agent/sessions` writes
    // a metadata-only transcript (session-meta + custom-title + mode +
    // queue-operation); the user prompt is then persisted via
    // `appendUserMessageV2` BEFORE runtime.query() starts. But vendor's
    // `loadSessionFile` counts only `user`/`assistant` entries — pure
    // metadata + a single orphan user message yields `messages.size === 0`,
    // which makes `getLastSessionLog` return null and triggers the vendor
    // "No conversation found" branch that emits an
    // `error_during_execution` NDJSON line + `gracefulShutdownSync(1)`.
    //
    // That stray `result` line lands in the in-process stdout pipe BEFORE
    // the new query's `system init`/`stream_event`/`assistant` lines and
    // the query generator's `if (msg?.type === 'result') break` exits the
    // loop on the very first read — every subsequent runtime.started /
    // runtime.delta / runtime.tool_call is dropped, the UI sees only a
    // premature runtime.done, status flips back to idle, and after refresh
    // the reply shows up because vendor's own transcript writer already
    // flushed the assistant turn. Resume-only-when-real-history keeps the
    // initial empty-session path on the new-session code path where
    // `runHeadless` issues a clean SessionStart instead of a load error.
    let existing = null
    let hasConversationHistory = false
    try {
      existing = await sessions.get(sessionId, { cwd })
      hasConversationHistory = await sessionHasAssistantMessage(sessionId, cwd)
    } catch {
      existing = null
      hasConversationHistory = false
    }
    // Plan §6 P3 / §7 path A: zai server path didn't fire SessionStart
    // hooks before — createPrintRuntime now bridges the vendor `print.ts:5309`
    // semantics for the in-process headless loop. Fired exactly once per
    // instance (`rec.sessionStartHooksPromise` is consumed by the first
    // query's `print.ts:5429` join). User `~/.zai/settings.json`/`hooks.SessionStart`
    // config is read directly by vendor hook machinery — zai does not
    // shadow it. The fire is `await`ed so a hook that emits `initialUserMessage`
    // (vendor pattern) can land in the first turn; failures are non-fatal.
    //
    // zai patch: zai-server doesn't go through `setup.ts:166` (which calls
    // captureHooksConfigSnapshot during CLI bootstrap), so the hook snapshot
    // would otherwise be empty. We refresh on first createInstance and
    // rely on vendor's settings file watcher for subsequent updates; the
    // SessionStart hook fires after refresh.
    let sessionStartHooksPromise: ReturnType<typeof processSessionStartHooks> | null = null
    try {
      // One-time snapshot refresh (cost is read-and-cache). vendor's
      // updateHooksConfigSnapshot already resets the session cache.
      if (!hooksSnapshotCaptured) {
        hooksSnapshotCaptured = true
        updateHooksConfigSnapshot()
      }
      sessionStartHooksPromise = processSessionStartHooks('startup', {
        sessionId,
        agentType: input.mainAgent,
        model: options.defaultModel,
      })
      // Eagerly await — vendor's runHeadless awaits the same promise in
      // loadConversationForResume so that any initialUserMessage hook
      // output lands in the first turn's messages.
      await sessionStartHooksPromise
    } catch (err) {
      logForDebugging(
        `[createPrintRuntime] SessionStart hook threw: ${String(err)}`,
        { level: 'error' },
      )
    }
    const session = startHeadlessPrintSession({
      sessionId,
      cwd,
      onOutputLine: line => rec.lines.push(line),
      getAppState: () => ctx.appState.getState(),
      setAppState: ctx.appState.setState,
      commands: ctx.mcp?.commands ?? [],
      tools: ctx.tools,
      sdkMcpConfigs: {},
      agents: state.agentDefinitions?.activeAgents ?? [],
      options: {
        continue: undefined,
        resume: hasConversationHistory ? sessionId : undefined,
        resumeSessionAt: undefined,
        verbose: true,
        outputFormat: 'stream-json',
        jsonSchema: undefined,
        permissionPromptToolName: undefined,
        allowedTools: undefined,
        thinkingConfig: undefined,
        maxTurns: undefined,
        maxBudgetUsd: undefined,
        taskBudget: undefined,
        systemPrompt: undefined,
        appendSystemPrompt: undefined,
        userSpecifiedModel: options.defaultModel,
        fallbackModel: undefined,
        teleport: null,
        sdkUrl: undefined,
        replayUserMessages: true,
        includePartialMessages: true,
        forkSession: false,
        rewindFiles: undefined,
        enableAuthStatus: false,
        agent: input.mainAgent,
        workload: undefined,
        heartbeatIntervalMs: undefined,
        sessionStartHooksPromise: sessionStartHooksPromise ?? undefined,
      },
      // Test seam (contract tests); undefined in production.
      runHeadlessImpl: options.runHeadlessImpl,
      onSessionEnd: () => {
        instances.delete(sessionId)
      },
    })
    rec.session = session
    instances.set(sessionId, rec)
    console.log(
      `[createPrintRuntime] instance ready ${sessionId} (bootstrap ${Date.now() - t0}ms, live=${instances.size})`,
    )
    enforceMaxSessions()
    return rec
  }

  async function getOrCreate(sessionId, input) {
    if (closed) throw new Error('createPrintRuntime: runtime is shut down')
    const rec = instances.get(sessionId)
    if (rec) {
      rec.lastActivity = Date.now()
      return rec
    }
    return createInstance(sessionId, input)
  }

  function enforceMaxSessions() {
    const max = options.maxSessions ?? 0
    if (!max || instances.size <= max) return
    // Evict oldest lastActivity instances that are NOT mid-turn and have no
    // active background tasks (plan §9.3: running tasks pin the instance).
    const evictable = Array.from(instances.values())
      .filter(r => !r.turnActive && !r.session.isDone() && !hasActiveTasks(r))
      .sort((a, b) => a.lastActivity - b.lastActivity)
    while (instances.size > max && evictable.length > 0) {
      const victim = evictable.shift()
      evictInstance(victim, `maxSessions=${max} reached`)
    }
  }

  /**
   * P2 (plan §4-c / §9.3): instances with running/pending/queued tasks
   * (background bash children, async agents) must NOT be TTL/LRU-evicted —
   * dispose would cascade-kill them, contradicting the "eviction is
   * user-invisible" guarantee.
   */
  function hasActiveTasks(rec) {
    const tasks = rec.ctx?.appState?.getState?.()?.tasks ?? {}
    for (const t of Object.values(tasks)) {
      const status = t?.status
      if (status === 'running' || status === 'pending' || status === 'queued') {
        return true
      }
    }
    return false
  }

  function evictInstance(rec, reason) {
    instances.delete(rec.sessionId)
    void rec.session.dispose().catch(err => {
      console.warn(
        `[createPrintRuntime] dispose(${rec.sessionId}) after "${reason}" threw: ${String(err)}`,
      )
    })
    console.log(
      `[createPrintRuntime] evicted instance ${rec.sessionId} (${reason}); next query re-hydrates via vendor resume`,
    )
  }

  /**
   * P2 idle-TTL sweeper (plan §4-c). unref'd 60s-interval timer — never
   * keeps the event loop alive; at most one trivial wake per minute (§9.5).
   * Evicts instances idle past `idleTtlMin` (default 30; 0 disables) that
   * are not mid-turn and have no active background tasks. Next query
   * re-creates them through the vendor resume chain (transcript is on disk).
   */
  const idleTtlMs = (options.idleTtlMin ?? 30) * 60_000
  function sweepIdleInstances(now = Date.now()) {
    if (!idleTtlMs) return 0
    let evicted = 0
    for (const rec of Array.from(instances.values())) {
      if (rec.turnActive || rec.session.isDone()) continue
      if (hasActiveTasks(rec)) continue
      if (now - rec.lastActivity < idleTtlMs) continue
      evictInstance(rec, `idle TTL ${Math.round(idleTtlMs / 60000)}m exceeded`)
      evicted++
    }
    return evicted
  }
  let sweepTimer = null
  if (idleTtlMs) {
    sweepTimer = setInterval(sweepIdleInstances, 60_000)
    sweepTimer.unref?.()
  }

  function applyPermissionMode(rec, mode) {
    // Mirror the lightweight track's per-query mode transition
    // (createOpenccRuntime-impl.ts:525-549), on the OWN instance store.
    rec.ctx.appState.setState(prev => {
      const current = prev.toolPermissionContext?.mode
      if (current === mode) return prev
      const next = transitionPermissionMode(
        current,
        mode,
        prev.toolPermissionContext,
      )
      return { ...prev, toolPermissionContext: { ...next, mode } }
    })
  }

  // P3 (plan §4 / §6 P3): process-wide single cronScheduler. Each instance's
  // per-vendor scheduler is suppressed (ctx.disableCron = true; see
  // headlessPrintSession.ts). This scheduler polls `.zai/scheduled_tasks.json`
  // once per check-tick for the whole server, and routes fires to the right
  // sessionId via the ALS-resolved sessionId in the receiving instance.
  //
  // CronTask has no `sessionId` field (the vendor file-backed scheduler is
  // cwd-level, not session-level). Without an explicit route, we dispatch
  // to the most-recently-active sessionId the runtime knows about — the
  // closest match to "the user is here right now" the server can derive
  // without per-task metadata. No live instance → drop + log (matches plan
  // §4-c "实例不在则丢弃记日志" branch).
  let cronScheduler: CronScheduler | null = null
  cronScheduler = createCronScheduler({
    onFire: prompt => {
      // Find the most-recently-active live instance.
      const live = Array.from(instances.values())
        .filter(r => !r.session.isDone())
        .sort((a, b) => b.lastActivity - a.lastActivity)[0]
      if (!live) {
        console.log(
          `[createPrintRuntime] cron fire: no live instance — dropped: "${prompt.slice(0, 80)}"`,
        )
        return
      }
      live.lastActivity = Date.now()
      live.session.sendUserMessage(prompt, {
        uuid: randomUUID(),
        priority: 'later',
        isMeta: true,
      })
    },
    isLoading: () => {
      // Any active turn in any instance blocks cron fire (parity with
      // vendor's run() mutex). Vendor cron would have enqueued + run()-kicked
      // either way; we just hold off so the prompt doesn't fire mid-turn.
      for (const r of instances.values()) {
        if (r.turnActive) return true
      }
      return false
    },
    // Live jitter config lookup so ops can tune without restart; falls back
    // to vendor DEFAULT_CRON_JITTER_CONFIG inside cronScheduler.
    isKilled: () => false,
  })
  cronScheduler.start()

  return {
    async *query(input) {
      const rec = await getOrCreate(input.sessionId, input)
      rec.lastActivity = Date.now()
      if (input.permissionMode) applyPermissionMode(rec, input.permissionMode)
      if (input.model) {
        rec.ctx.appState.setState(prev => ({ ...prev, mainLoopModel: input.model }))
      }
      const turnIndex = ++rec.turnIndex
      rec.turnActive = true
      const adapterMeta = {
        sessionId: input.sessionId,
        turnIndex,
        eventCounter: 0,
        toolNameByUseId: new Map(),
        streamedBlockIndices: new Set(),
      }
      // Lightweight-track parity: per-query bridge ctx merge (compat
      // AskUserQuestion wrapper prefers ALS sessionId in this track; the
      // merge keeps the __zaiBridgeCtx fallback + zai consumers consistent).
      const prevBridge = globalThis.__zaiBridgeCtx
      globalThis.__zaiBridgeCtx = {
        ...(prevBridge ?? {}),
        sessionId: input.sessionId,
      }
      const onExternalAbort = () => {
        try {
          rec.session.sendInterrupt()
        } catch {}
      }
      if (input.abortSignal) {
        if (input.abortSignal.aborted) onExternalAbort()
        else
          input.abortSignal.addEventListener('abort', onExternalAbort, {
            once: true,
          })
      }
      try {
        // Drop stale pre-turn lines (non-turn async output from earlier).
        rec.lines.drain()
        rec.session.sendUserMessage(input.prompt, {
          uuid: randomUUID(),
          ...(input.isMeta ? { isMeta: true } : {}),
        })
        while (true) {
          const lineOrDone = await Promise.race([
            rec.lines.next(),
            rec.session.done.then(() => null),
          ])
          if (lineOrDone === null) {
            // Instance loop ended mid-turn (crash/dispose) — end the turn.
            break
          }
          let msg
          try {
            msg = JSON.parse(lineOrDone)
          } catch {
            continue
          }
          if (msg?.type === 'control_request') {
            // P3 (plan §5): three-way routing for vendor control_requests.
            // All bridges are ALS-resolved by sessionId so concurrent
            // in-process sessions never cross-fire (P0.5 contract).
            // Without a matching bridge we still write a deny/cancel
            // response so vendor never hangs waiting on the SDK host.
            await handleControlRequest(rec, msg)
            continue
          }
          for (const ev of translateSdkToRuntime(msg, adapterMeta)) {
            yield ev
          }
          adapterMeta.eventCounter++
          if (msg?.type === 'result') break
        }
      } finally {
        rec.turnActive = false
        if (input.abortSignal)
          input.abortSignal.removeEventListener('abort', onExternalAbort)
        if (prevBridge === undefined) delete globalThis.__zaiBridgeCtx
        else globalThis.__zaiBridgeCtx = prevBridge
      }
    },

    async abort(sessionId) {
      // interrupt semantics (vendor control_request{interrupt}): aborts the
      // in-flight turn; the instance stays alive (matches spawn track abort).
      instances.get(sessionId)?.session.sendInterrupt()
    },

    async enqueue(input) {
      // Steering: inject into the live instance's command queue without
      // opening a new query generator. priority:'now' preempts the in-flight
      // turn via the vendor's own getCommandsByMaxPriority('now') abort path
      // (print.ts inbound: `priority: message.priority`).
      const rec = await getOrCreate(input.sessionId, {})
      rec.lastActivity = Date.now()
      rec.session.sendUserMessage(input.prompt, {
        uuid: randomUUID(),
        priority: input.priority ?? 'next',
        ...(input.isMeta ? { isMeta: true } : {}),
      })
    },

    async interrupt(sessionId) {
      instances.get(sessionId)?.session.sendInterrupt()
    },

    async getSessionState(sessionId) {
      const rec = instances.get(sessionId)
      if (!rec) return null
      return rec.ctx.appState.getState()
    },

    async getSession(sessionId) {
      const info = await sessions.get(sessionId, { cwd })
      return info
    },

    async listSessions(opts) {
      return sessions.list({ cwd: opts?.cwd ?? cwd })
    },

    readTranscript(sessionId) {
      return sessions.readTranscript(sessionId)
    },

    async patchSession(sessionId, patch) {
      await sessions.patchSession(sessionId, patch)
    },

    async removeSession(sessionId) {
      const rec = instances.get(sessionId)
      if (rec) {
        instances.delete(sessionId)
        await rec.session.dispose()
      }
      await sessions.removeSession(sessionId)
    },

    async shutdown() {
      closed = true
      if (sweepTimer) {
        clearInterval(sweepTimer)
        sweepTimer = null
      }
      if (cronScheduler) {
        cronScheduler.stop()
        cronScheduler = null
      }
      const disposes = Array.from(instances.values()).map(rec =>
        rec.session.dispose().catch(() => {}),
      )
      instances.clear()
      await Promise.all(disposes)
    },

    /**
     * P2 test/debug seam: run the idle-TTL sweep deterministically with an
     * explicit clock. Not part of OpenccRuntimeV2; safe to no-op post-shutdown
     * (map is empty).
     */
    __sweepIdleForTests(now) {
      return sweepIdleInstances(now ?? Date.now())
    },

    plugins: createPluginStub(),
  }
}

/**
 * P1 plugin stub — same contract shape as the spawn track's
 * SessionHostRuntimeAdapter stub; the full plugin API delegates to the
 * zai-side PluginRuntime in P3+ (routes/plugins.ts must not 500).
 */
function createPluginStub() {
  const UNSUPPORTED =
    'inproc print runtime: plugin API 未接入(P3+,zai PluginRuntime 承接)'
  const warn = (...a) => console.warn('[createPrintRuntime] plugins:', ...a)
  return {
    async listInstalled() {
      warn(UNSUPPORTED)
      return { plugins: [], errors: [] }
    },
    async listAvailable() {
      warn(UNSUPPORTED)
      return []
    },
    async setEnabled() {
      return { success: false, message: UNSUPPORTED }
    },
    async install() {
      return { success: false, message: UNSUPPORTED }
    },
    async uninstall() {
      return { success: false, message: UNSUPPORTED }
    },
    async update() {
      return { success: false, message: UNSUPPORTED }
    },
    async reload() {
      return { success: true, message: UNSUPPORTED }
    },
    async listMarketplaces() {
      warn(UNSUPPORTED)
      return []
    },
    async addMarketplace() {
      return { success: false, message: UNSUPPORTED }
    },
  }
}
