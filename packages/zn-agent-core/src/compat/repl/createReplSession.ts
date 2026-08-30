// @ts-nocheck
/**
 * zai patch (2026-08-30, plan P0): createReplSession stub.
 * Real implementation lands in Task 7. Stub here so the barrel resolves.
 */

import type { ReplSession, ReplSessionOptions } from './types.js'

export function createReplSession(_opts: ReplSessionOptions): ReplSession {
  throw new Error('createReplSession: not yet implemented (plan P0 Task 7)')
}
