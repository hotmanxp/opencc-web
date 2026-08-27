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

export async function createPrintRuntimeImpl(options) {
  const cwd = options.defaultCwd ?? process.cwd()
  const sessions = await createSessionFacadeImpl({
    cwd,
    dataDir: options.dataDir,
  })
  const instances = new Map()
  let closed = false

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
      }),
    )
    rec.ctx = ctx
    if (options.defaultModel) {
      ctx.appState.setState(prev => ({ ...prev, mainLoopModel: options.defaultModel }))
    }
    const state = ctx.appState.getState()
    // Hydrate existing transcripts via the vendor resume chain (P0
    // advantage: file history / worktree / attribution / mode all restore).
    let existing = null
    try {
      existing = await sessions.get(sessionId, { cwd })
    } catch {
      existing = null
    }
    const session = startHeadlessPrintSession({
      sessionId,
      onOutputLine: line => rec.lines.push(line),
      getAppState: () => ctx.appState.getState(),
      setAppState: ctx.appState.setState,
      commands: ctx.mcp?.commands ?? [],
      tools: ctx.tools,
      sdkMcpConfigs: {},
      agents: state.agentDefinitions?.activeAgents ?? [],
      options: {
        continue: undefined,
        resume: existing ? sessionId : undefined,
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
            // P3 wires the permission/ask bridge (plan §5). Deny-with-error
            // so the vendor loop never hangs on it in P1.
            rec.session.writeLine(
              controlResponseError(
                msg.request_id,
                'inproc print runtime (P1): control_request bridge not wired yet',
              ),
            )
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
