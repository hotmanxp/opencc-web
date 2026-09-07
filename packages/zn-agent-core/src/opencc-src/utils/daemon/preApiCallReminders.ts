/**
 * Pre-API-call reminder provider registry — zai patch (2026-09-06).
 *
 * Mirrors the opencc-vendor bg-daemon inbox pattern (`inboxSection.ts`):
 * the vendor `query.ts` loop calls `buildInboxSystemReminder()` before each
 * API call to drain new bg-daemon messages and prepend them as a
 * `<system-reminder>` block. This module exposes the same extension point
 * to zai-server: external code can register provider callbacks that the
 * vendor loop will invoke once per API call (mid multi-turn agent loop),
 * concatenated with the bg-daemon reminder, then prepended to the user
 * message stream.
 *
 * zai-server uses this to drain its per-session `SessionInbox.nextStep`
 * lane on every API call (subagent completions, task-factory notices, user
 * steer messages) — see `packages/zai/src/server/services/inboxReminder.ts`.
 *
 * Module-level registry (not on `toolUseContext`) so providers are installed
 * once at startup and survive every query invocation. Mirrors
 * `postSamplingHooks.ts` pattern.
 */
import { logError } from '../log.js'
import { toError } from '../errors.js'

export type ExtraReminderProvider = (
  sessionId: string,
) => Promise<string | null> | string | null

const providers: ExtraReminderProvider[] = []

/**
 * Register a callback that returns a `<system-reminder>` block (or null)
 * for the given session. Invoked once per API call inside the vendor
 * query loop, after the built-in bg-daemon drain. Multiple providers are
 * concatenated with `\n\n` between them; if all return null, no
 * reminder block is added.
 */
export function registerExtraReminderProvider(fn: ExtraReminderProvider): void {
  providers.push(fn)
}

/**
 * Drop all registered providers. Test seam — production code never calls.
 */
export function clearExtraReminderProviders(): void {
  providers.length = 0
}

/**
 * Run every registered provider and concatenate non-null results.
 * Errors are logged but do not fail the reminder — a single broken
 * provider must not block the API call.
 */
export async function runExtraReminderProviders(
  sessionId: string,
): Promise<string | null> {
  const parts: string[] = []
  for (const fn of providers) {
    try {
      const out = await fn(sessionId)
      if (out) parts.push(out)
    } catch (err) {
      logError(toError(err))
    }
  }
  if (parts.length === 0) return null
  return parts.join('\n\n')
}
