// @ts-nocheck
/**
 * zai patch (2026-08-08-30, plan P0): L2 state machine — QueryGuardState.
 * Wraps vendor QueryGuard class as standalone (no React) for createReplSession.
 * Same generation-token semantics; usable from imperative code.
 *
 * Key deviation from brief:
 * - vendor `isActive` is a getter property, not a method.
 * - vendor `end(generation, terminalReason?, abortReason?)` takes terminalReason
 *   as 2nd arg (defaults to 'ok').
 * - vendor `QueryGuardOptions` is the options type name.
 * - vendor `tryStart()` has overloads: tryStart() → number | null,
 *   tryStart(metadata) → QueryGuardStart | null.
 */

import {
  QueryGuard,
  type QueryGuardOptions,
} from '../../../opencc-src/utils/QueryGuard.js'

export class QueryGuardState {
  private guard: QueryGuard

  constructor(opts?: QueryGuardOptions) {
    this.guard = new QueryGuard(opts)
  }

  /**
   * Start a query. Returns the generation number on success,
   * or null if a query is already running.
   */
  tryStart(): number | null {
    return this.guard.tryStart()
  }

  /**
   * End a query. Returns true if this generation is still current
   * (caller should perform cleanup). Returns false if a newer query
   * has started (stale finally block).
   */
  end(generation: number): boolean {
    return this.guard.end(generation)
  }

  /**
   * Is the guard active (dispatching or running)?
   * Synchronous getter property.
   */
  get isActive(): boolean {
    return this.guard.isActive
  }

  /**
   * Returns a snapshot of currently active operations.
   */
  getActiveOperation(): ReturnType<QueryGuard['getActiveOperations']> {
    return this.guard.getActiveOperations()
  }
}

export function setupQueryGuard(
  opts?: QueryGuardOptions,
): {
  state: QueryGuardState
  teardown(): void
} {
  const state = new QueryGuardState(opts)
  return {
    state,
    teardown() {
      // No native teardown needed; QueryGuard is stateless after construction.
      // Method exists for symmetry with other setupXxx adapters.
    },
  }
}
