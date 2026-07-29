/**
 * Synchronous state machine for the query lifecycle, compatible with
 * React's `useSyncExternalStore`.
 *
 * Three states:
 *   idle        -> no query, safe to dequeue and process
 *   dispatching -> an item was dequeued, async chain hasn't reached onQuery yet
 *   running     -> onQuery called tryStart(), query is executing
 *
 * Transitions:
 *   idle -> dispatching  (reserve)
 *   dispatching -> running  (tryStart)
 *   idle -> running  (tryStart, for direct user submissions)
 *   running -> idle  (end / forceEnd / timeout)
 *   dispatching -> idle  (cancelReservation, when processQueueIfReady fails)
 *
 * `isActive` returns true for both dispatching and running, preventing
 * re-entry from the queue processor during the async gap.
 *
 * Timeout:
 *   The guard uses an idle timeout for stuck work, bounded leases for active
 *   local/API work, and a hard maximum query lifetime that always wins.
 *
 * Lifecycle:
 *   tryStart() with metadata returns a QueryGuardStart carrying a
 *   QueryLifecycleContext. The current context is exposed via `activeContext`
 *   and the most recently completed one via `lastContext` (which also carries
 *   a `terminalReason` / `abortReason` set by `end()` or `forceEnd()`).
 *
 * Usage with React:
 *   const queryGuard = useRef(new QueryGuard()).current
 *   const isQueryActive = useSyncExternalStore(
 *     queryGuard.subscribe,
 *     queryGuard.getSnapshot,
 *   )
 */
import { createSignal } from './signal.ts'
import type {
  QueryActiveOperationSnapshot,
  QueryGuardMetadata,
  QueryGuardStart,
  QueryGuardTimeoutInfo,
  QueryGuardTimeoutReason,
  QueryLifecycleContext,
  QueryTerminalReason,
} from './queryLifecycle.ts'

export const DEFAULT_QUERY_IDLE_TIMEOUT_MS = 5 * 60 * 1000 // 5 minutes
export const DEFAULT_QUERY_HARD_MAX_MS = 30 * 60 * 1000 // 30 minutes
export const DEFAULT_TOOL_LEASE_GRACE_MS = 5_000

/**
 * Input for a bounded unit of active work.
 *
 * `owner` identifies the subsystem taking the lease, `id` identifies the
 * specific operation, `timeoutMs` is measured from lease acquisition, and
 * `hardCapMs` is an optional lease-local upper bound that is still capped by
 * the current query's remaining hard-maximum budget.
 */
export type QueryGuardLeaseInput = {
  /** Subsystem taking the lease, used for diagnostics and unique lease ids. */
  owner: 'api' | 'tool' | 'bash' | 'subagent' | string
  /** Stable operation id, for example a tool-use id. */
  id: string
  /** Lease timeout measured from acquisition time. */
  timeoutMs?: number
  /** Optional lease-local hard cap, also bounded by the query hard max. */
  hardCapMs?: number
  /** Human-readable description for diagnostics. */
  description?: string
}

/**
 * Handle returned for an active lease. Call `release()` exactly once when the
 * bounded work finishes; stale or repeated releases are ignored.
 */
export type QueryGuardLease = {
  readonly id: string
  /** Release this lease if it still belongs to the current generation. */
  release(): void
}

/**
 * Lifecycle hook fired when a query terminates (via `end()` or `forceEnd()`)
 * with its terminal reason and (optionally) an abort reason. The hook runs
 * AFTER the lifecycle context has been moved into `lastContext`.
 *
 * For the watchdog-driven force-end path (idle / hard_max / lease_expired),
 * use `setTimeoutHandler` instead — it fires BEFORE `forceEnd()` so callers
 * can abort in-flight work while the timed-out generation is still current.
 */
export type QueryLifecycleHook = (
  generation: number,
  terminalReason: QueryTerminalReason,
  abortReason?: string,
  context?: QueryLifecycleContext,
) => void

// Substrate signature (from #1686): `(generation, reason) => void`.
// Preserved unchanged for backwards compatibility — do NOT change. New callers
// should prefer `setLifecycleHook` for terminal-reason context or migrate to
// `setTimeoutHandler`'s `QueryGuardTimeoutInfo` payload (see upstream #1682).
type QueryTimeoutHandler = (
  generation: number,
  reason: QueryGuardTimeoutReason,
) => void

type QueryGuardOptions = {
  idleTimeoutMs?: number
  hardMaxQueryMs?: number
  toolLeaseGraceMs?: number
}

type LeaseRecord = {
  leaseId: string
  owner: string
  id: string
  generation: number
  startedAt: number
  deadlineAt: number
  description?: string
}

const EMPTY_ACTIVE_OPERATIONS: QueryActiveOperationSnapshot = {
  apiCalls: [],
  toolUses: [],
}

function positiveOrDefault(value: number | undefined, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0
    ? value
    : fallback
}

function terminalReasonForTimeout(
  reason: QueryGuardTimeoutReason,
): QueryTerminalReason {
  return reason === 'hard_max'
    ? 'hard-max-query-timeout'
    : 'query-timeout'
}

export class QueryGuard {
  private _status: 'idle' | 'dispatching' | 'running' = 'idle'
  private _generation = 0
  private _changed = createSignal()
  private _timeoutId: ReturnType<typeof setTimeout> | null = null
  private _timeoutHandler: QueryTimeoutHandler | null = null
  private _lifecycleHook: QueryLifecycleHook | null = null
  private _queryStartedAt = 0
  private _lastActivityAt = 0
  private _suspendCount = 0
  private _suspendedAt = 0
  private _totalSuspendedMs = 0
  private _leaseCounter = 0
  private _activeLeases = new Map<string, LeaseRecord>()
  private _context: QueryLifecycleContext | null = null
  private _lastContext: QueryLifecycleContext | null = null
  private _getActiveOperations: (() => QueryActiveOperationSnapshot) | null =
    null
  private readonly _idleTimeoutMs: number
  private readonly _hardMaxQueryMs: number
  private readonly _toolLeaseGraceMs: number

  constructor(options: QueryGuardOptions = {}) {
    this._idleTimeoutMs = positiveOrDefault(
      options.idleTimeoutMs,
      DEFAULT_QUERY_IDLE_TIMEOUT_MS,
    )
    this._hardMaxQueryMs = positiveOrDefault(
      options.hardMaxQueryMs,
      DEFAULT_QUERY_HARD_MAX_MS,
    )
    this._toolLeaseGraceMs = Math.max(
      0,
      positiveOrDefault(options.toolLeaseGraceMs, DEFAULT_TOOL_LEASE_GRACE_MS),
    )
  }

  /**
   * Reserve the guard for queue processing. Transitions idle -> dispatching.
   * Returns false if not idle (another query or dispatch in progress).
   */
  reserve(): boolean {
    if (this._status !== 'idle') return false
    this._status = 'dispatching'
    this._notify()
    return true
  }

  /**
   * Cancel a reservation when processQueueIfReady had nothing to process.
   * Transitions dispatching -> idle.
   */
  cancelReservation(): void {
    if (this._status !== 'dispatching') return
    this._status = 'idle'
    this._notify()
  }

  /**
   * Start a query. Returns the generation number on success,
   * or null if a query is already running (concurrent guard).
   * Accepts transitions from both idle (direct user submit)
   * and dispatching (queue processor path).
   *
   * Overloads:
   *   tryStart(): number | null
   *     - legacy / queue processor path; returns just the generation.
   *   tryStart(metadata): QueryGuardStart | null
   *     - caller knows the lifecycle identity up front; guard stamps
   *       it onto the active context so downstream timeout / abort paths
   *       can include `queryId` / `querySource` / `parentQueryId`.
   */
  tryStart(): number | null
  tryStart(metadata: QueryGuardMetadata): QueryGuardStart | null
  tryStart(metadata?: QueryGuardMetadata): number | QueryGuardStart | null {
    if (this._status === 'running') return null
    this._status = 'running'
    ++this._generation
    this._activeLeases.clear()
    this._suspendCount = 0
    this._suspendedAt = 0
    this._totalSuspendedMs = 0
    this._lastContext = null
    this._queryStartedAt = Date.now()
    this._lastActivityAt = this._queryStartedAt
    this._context = this._createContext(metadata)
    this._getActiveOperations = metadata?.getActiveOperations ?? null
    this._startTimeout()
    this._notify()
    if (metadata) {
      return {
        generation: this._generation,
        context: this._context,
      }
    }
    return this._generation
  }

  /**
   * End a query. Returns true if this generation is still current
   * (meaning the caller should perform cleanup). Returns false if a
   * newer query has started (stale finally block from a cancelled query).
   *
   * The optional `terminalReason` and `abortReason` are stamped onto the
   * completed lifecycle context (exposed via `lastContext`) and forwarded to
   * the registered `setLifecycleHook`. Defaults are backwards-compatible
   * (`'ok'`, no abort reason).
   */
  end(
    generation: number,
    terminalReason: QueryTerminalReason = 'ok',
    abortReason?: string,
  ): boolean {
    if (this._generation !== generation) return false
    if (this._status !== 'running') return false
    this._clearTimeout()
    this._activeLeases.clear()
    this._suspendCount = 0
    this._suspendedAt = 0
    this._totalSuspendedMs = 0
    this._completeContext(terminalReason, abortReason)
    this._status = 'idle'
    this._getActiveOperations = null
    this._notify()
    try {
      this._lifecycleHook?.(
        generation,
        terminalReason,
        abortReason,
        this._lastContext ?? undefined,
      )
    } catch (error) {
      console.error('[QueryGuard] Lifecycle hook failed', error)
    }
    return true
  }

  /**
   * Force-end the current query regardless of generation.
   * Used by onCancel where any running query should be terminated.
   * Increments generation so stale finally blocks from the cancelled
   * query's promise rejection will see a mismatch and skip cleanup.
   *
   * The optional `terminalReason` and `abortReason` default to
   * `'unknown'` / no abort reason, preserving the substrate's
   * zero-arg overload for callers that do not yet speak lifecycle.
   */
  forceEnd(
    terminalReason: QueryTerminalReason = 'unknown',
    abortReason?: string,
  ): void {
    if (this._status === 'idle') return
    this._clearTimeout()
    this._activeLeases.clear()
    this._suspendCount = 0
    this._suspendedAt = 0
    this._totalSuspendedMs = 0
    this._completeContext(terminalReason, abortReason)
    this._status = 'idle'
    ++this._generation
    this._getActiveOperations = null
    this._notify()
    try {
      this._lifecycleHook?.(
        this._generation,
        terminalReason,
        abortReason,
        this._lastContext ?? undefined,
      )
    } catch (error) {
      console.error('[QueryGuard] Lifecycle hook failed', error)
    }
  }

  /**
   * Record forward progress for the current query. Stale generation-scoped
   * events are ignored so a cancelled query cannot extend a newer turn. Call
   * this when API chunks, tool progress, or other observable work arrives.
   */
  registerActivity(reason: string, generation?: number): void {
    void reason
    if (this._status !== 'running') return
    if (generation !== undefined && generation !== this._generation) return
    this._lastActivityAt = Date.now()
    this._scheduleTimeout()
  }

  /**
   * Allow bounded active work to outlive the idle timeout without converting
   * QueryGuard into an inactivity-only watchdog. Pass the generation when the
   * lease is acquired from async callbacks so stale work cannot protect a newer
   * query. Without an explicit generation, the current generation is used.
   */
  acquireLease(
    input: QueryGuardLeaseInput,
    generation = this._generation,
  ): QueryGuardLease {
    if (this._status !== 'running' || generation !== this._generation) {
      return {
        id: '',
        release() {},
      }
    }

    const now = Date.now()
    const leaseTimeoutMs =
      typeof input.timeoutMs === 'number' &&
      Number.isFinite(input.timeoutMs) &&
      input.timeoutMs > 0
        ? input.timeoutMs
        : undefined
    const leaseHardCapMs =
      typeof input.hardCapMs === 'number' &&
      Number.isFinite(input.hardCapMs) &&
      input.hardCapMs > 0
        ? input.hardCapMs
        : this._hardMaxQueryMs
    const queryHardDeadlineAt = this._getHardMaxDeadlineAt(now)
    const queryRemainingMs = Math.max(0, queryHardDeadlineAt - now)
    const effectiveHardCapMs = Math.min(leaseHardCapMs, queryRemainingMs)
    const leaseDeadlineAt =
      leaseTimeoutMs === undefined
        ? now + effectiveHardCapMs
        : Math.min(
            now + leaseTimeoutMs + this._toolLeaseGraceMs,
            now + effectiveHardCapMs,
          )
    const leaseId = `${generation}:${input.owner}:${input.id}:${++this._leaseCounter}`
    this._activeLeases.set(leaseId, {
      leaseId,
      owner: input.owner,
      id: input.id,
      generation,
      startedAt: now,
      deadlineAt: leaseDeadlineAt,
      description: input.description,
    })
    this._lastActivityAt = now
    this._scheduleTimeout()

    return {
      id: leaseId,
      release: () => this.releaseLease(leaseId, generation),
    }
  }

  /**
   * Release a lease by id. Stale generation releases and repeated releases are
   * ignored, so old async cleanup cannot affect a newer query.
   */
  releaseLease(leaseId: string, generation = this._generation): void {
    const lease = this._activeLeases.get(leaseId)
    if (!lease || lease.generation !== generation) return
    this._activeLeases.delete(leaseId)
    this._scheduleTimeout()
  }

  /**
   * Suspend idle and hard-max timeouts while the query is blocked on a human
   * decision. Lease deadlines still run because they bound active program work.
   * Reference-counted so concurrent or nested interactions are safe.
   *
   * Pass the generation when suspending from an async callback so a stale
   * interaction cannot pause a newer query. Returns a resume function; call it
   * exactly once (a good fit for a `finally` block). Repeated or stale-
   * generation resume calls are ignored.
   */
  beginUserInteraction(generation = this._generation): () => void {
    if (this._status !== 'running' || generation !== this._generation) {
      return () => {}
    }
    if (this._suspendCount === 0) {
      this._suspendedAt = Date.now()
    }
    this._suspendCount++
    this._scheduleTimeout()

    let resumed = false
    return () => {
      if (resumed) return
      resumed = true
      // A superseded query already reset the counter; ignore stale resumes.
      if (generation !== this._generation) return
      if (this._suspendCount === 0) return
      this._suspendCount--
      if (this._suspendCount === 0) {
        this._resumeAfterInteraction()
      }
    }
  }

  /**
   * Restart idle/hard-max accounting after the last concurrent human interaction
   * ends. Lease deadlines are not shifted; they bound active program work even
   * while the prompt is open.
   */
  private _resumeAfterInteraction(): void {
    if (this._status !== 'running') return
    const now = Date.now()
    const suspendedStartedAt = this._suspendedAt
    const suspendedMs = Math.max(0, now - suspendedStartedAt)
    this._suspendedAt = 0
    this._totalSuspendedMs += suspendedMs
    this._lastActivityAt = now
    this._scheduleTimeout()
  }

  /**
   * Is the guard active (dispatching or running)?
   * Always synchronous - not subject to React state batching delays.
   */
  get isActive(): boolean {
    return this._status !== 'idle'
  }

  get generation(): number {
    return this._generation
  }

  /**
   * Currently active lifecycle context (or `null` if idle). A defensive copy
   * is returned so callers cannot mutate the guard's internal state.
   */
  get activeContext(): QueryLifecycleContext | null {
    return this._context ? { ...this._context } : null
  }

  /**
   * Most recently completed lifecycle context (or `null` before the first
   * start). Carries the `terminalReason` / `abortReason` set by the
   * `end()` / `forceEnd()` call that closed the query. A defensive copy
   * is returned.
   */
  get lastContext(): QueryLifecycleContext | null {
    return this._lastContext ? { ...this._lastContext } : null
  }

  // --
  // useSyncExternalStore interface

  /** Subscribe to state changes. Stable reference - safe as useEffect dep. */
  subscribe = this._changed.subscribe

  /** Snapshot for useSyncExternalStore. Returns `isActive`. */
  getSnapshot = (): boolean => {
    return this._status !== 'idle'
  }

  /**
   * Register a callback invoked when the guard auto force-ends a query
   * because of timeout / hard-max / lease expiry. Returns a cleanup
   * function so callers can detach the handler. The handler receives
   * both the timed-out generation and the reason so callers can
   * distinguish idle from lease expiry.
   *
   * (Substrate #1686 API, preserved verbatim.)
   */
  setTimeoutHandler(handler: QueryTimeoutHandler): () => void {
    this._timeoutHandler = handler
    return () => {
      if (this._timeoutHandler === handler) {
        this._timeoutHandler = null
      }
    }
  }

  /**
   * Register a hook fired when a query ends via `end()` or `forceEnd()`.
   * The hook receives the generation that just terminated, the
   * `terminalReason` it carried, and the completed lifecycle context
   * (now also available via `lastContext`). Returns a cleanup function.
   *
   * Distinct from `setTimeoutHandler`:
   *   - `setTimeoutHandler` fires BEFORE `forceEnd()` (watchdog path),
   *     so it can abort in-flight work while the timed-out generation
   *     is still current. Fires only on idle / hard_max / lease_expired.
   *   - `setLifecycleHook` fires AFTER `_completeContext` has moved
   *     the lifecycle record into `lastContext`, on EVERY termination
   *     path (normal `end`, force-end, watchdog, external cancel).
   *
   * Errors thrown by the hook are caught and logged; they never propagate
   * into `end()` or `forceEnd()` callers.
   */
  setLifecycleHook(hook: QueryLifecycleHook): () => void {
    this._lifecycleHook = hook
    return () => {
      if (this._lifecycleHook === hook) {
        this._lifecycleHook = null
      }
    }
  }

  /**
   * Optional operation snapshot accessor plumbed through by callers that
   * track active API/tool work. Returns an empty snapshot when no
   * accessor is registered. Used by `lastContext` and the timeout info
   * payload so downstream logging sees in-flight operations.
   */
  getActiveOperations(): QueryActiveOperationSnapshot {
    return this._snapshotActiveOperations()
  }

  private _notify(): void {
    this._changed.emit()
  }

  private _createContext(
    metadata: QueryGuardMetadata | undefined,
  ): QueryLifecycleContext {
    return {
      queryId: metadata?.queryId ?? `generation-${this._generation}`,
      queryGeneration: this._generation,
      querySource: metadata?.querySource ?? 'unknown',
      ...(metadata?.parentQueryId && { parentQueryId: metadata.parentQueryId }),
      ...(metadata?.subagentId && { subagentId: metadata.subagentId }),
      startedAt: metadata?.startedAt ?? Date.now(),
    }
  }

  private _completeContext(
    terminalReason: QueryTerminalReason,
    abortReason?: string,
  ): void {
    if (!this._context) return
    const completed = {
      ...this._context,
      terminalReason,
      ...(abortReason !== undefined && { abortReason }),
    }
    this._context = null
    this._lastContext = completed
  }

  private _activeContextWithTerminalReason(
    terminalReason: QueryTerminalReason,
    abortReason?: string,
  ): QueryLifecycleContext {
    const context = this._context ?? this._createContext(undefined)
    return {
      ...context,
      terminalReason,
      ...(abortReason !== undefined && { abortReason }),
    }
  }

  private _snapshotActiveOperations(): QueryActiveOperationSnapshot {
    if (!this._getActiveOperations) return EMPTY_ACTIVE_OPERATIONS
    try {
      return this._getActiveOperations()
    } catch (error) {
      console.error('[QueryGuard] Active operation snapshot failed', error)
      return EMPTY_ACTIVE_OPERATIONS
    }
  }

  /**
   * Build the timeout-info payload handed to `setTimeoutHandler` so the
   * watchdog callback sees the same context the lifecycle hook will
   * eventually record via `lastContext`. Kept separate from `_handleTimeout`
   * to keep the watchdog readable.
   */
  private _buildTimeoutInfo(
    reason: QueryGuardTimeoutReason,
    now: number,
  ): QueryGuardTimeoutInfo {
    const terminalReason = terminalReasonForTimeout(reason)
    const context = this._activeContextWithTerminalReason(
      terminalReason,
      reason,
    )
    return {
      generation: this._generation,
      reason,
      timeoutMs: this._getTimeoutMsForReason(reason, now),
      elapsedMs: now - context.startedAt,
      context,
      activeOperations: this._snapshotActiveOperations(),
    }
  }

  /**
   * Start a watchdog timer. Stuck work aborts after the idle timeout, active
   * bounded work can continue while its lease is valid, and the hard maximum
   * aborts the query regardless of activity.
   */
  private _startTimeout(): void {
    this._scheduleTimeout()
  }

  private _scheduleTimeout(): void {
    this._clearTimeout()
    if (this._status !== 'running') return

    const now = Date.now()
    const reason = this._getTimeoutReason(now)
    if (reason) {
      this._timeoutId = setTimeout(() => this._handleTimeout(), 0)
      return
    }

    const nextDeadlineAt = this._getNextDeadlineAt(now)
    if (nextDeadlineAt === null) return
    this._timeoutId = setTimeout(
      () => this._handleTimeout(),
      Math.max(0, nextDeadlineAt - now),
    )
  }

  private _handleTimeout(): void {
    this._timeoutId = null
    if (this._status !== 'running') return

    const now = Date.now()
    const reason = this._getTimeoutReason(now)
    if (!reason) {
      this._scheduleTimeout()
      return
    }

    const terminalReason = terminalReasonForTimeout(reason)
    const timeoutInfo = this._buildTimeoutInfo(reason, now)

    console.error(
      `[QueryGuard] Query ${reason} timeout - force-ending to prevent infinite spinner`,
    )
    try {
      // Substrate preserved: substrate's `setTimeoutHandler` signature is
      // (generation, reason). Convert the rich timeout-info payload to that
      // pair so existing substrate callers (e.g. claude.ts watchdog) keep
      // working unchanged. Full payload still flows via `getActiveOperations`
      // and `lastContext`.
      this._timeoutHandler?.(timeoutInfo.generation, reason)
    } catch (error) {
      console.error('[QueryGuard] Timeout handler failed', error)
    } finally {
      this.forceEnd(terminalReason, reason)
    }
  }

  private _getCurrentSuspendedMs(now: number): number {
    return this._suspendCount > 0
      ? Math.max(0, now - this._suspendedAt)
      : 0
  }

  private _getHardMaxDeadlineAt(now: number): number {
    return (
      this._queryStartedAt +
      this._hardMaxQueryMs +
      this._totalSuspendedMs +
      this._getCurrentSuspendedMs(now)
    )
  }

  private _getTimeoutReason(now: number): QueryGuardTimeoutReason | null {
    const isSuspended = this._suspendCount > 0
    if (!isSuspended && now >= this._getHardMaxDeadlineAt(now)) {
      return 'hard_max'
    }

    let hasValidLease = false
    for (const lease of this._activeLeases.values()) {
      if (lease.deadlineAt <= now) {
        return 'lease_expired'
      }
      hasValidLease = true
    }

    if (
      !isSuspended &&
      !hasValidLease &&
      now >= this._lastActivityAt + this._idleTimeoutMs
    ) {
      return 'idle'
    }

    return null
  }

  private _getTimeoutMsForReason(
    reason: QueryGuardTimeoutReason,
    now: number,
  ): number {
    if (reason === 'hard_max') return this._hardMaxQueryMs
    if (reason === 'idle') return this._idleTimeoutMs

    const expiredLease = [...this._activeLeases.values()].find(
      lease => lease.deadlineAt <= now,
    )
    if (!expiredLease) return this._idleTimeoutMs
    return Math.max(0, expiredLease.deadlineAt - expiredLease.startedAt)
  }

  private _getNextDeadlineAt(now: number): number | null {
    if (this._status !== 'running') return null

    const isSuspended = this._suspendCount > 0
    const deadlines = isSuspended ? [] : [this._getHardMaxDeadlineAt(now)]
    const leaseDeadlines = [...this._activeLeases.values()]
      .map(lease => lease.deadlineAt)
      .filter(deadline => deadline > now)

    if (leaseDeadlines.length > 0) {
      deadlines.push(Math.min(...leaseDeadlines))
    } else if (!isSuspended) {
      deadlines.push(this._lastActivityAt + this._idleTimeoutMs)
    }

    if (deadlines.length === 0) return null
    return Math.min(...deadlines)
  }

  private _clearTimeout(): void {
    if (this._timeoutId !== null) {
      clearTimeout(this._timeoutId)
      this._timeoutId = null
    }
  }
}
