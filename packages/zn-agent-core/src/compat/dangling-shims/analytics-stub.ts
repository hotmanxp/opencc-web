/**
 * Stub for `src/services/analytics/index.js` (and any other analytics
 * submodule path).
 *
 * opencc's `services/analytics/` directory is a barrel of analytics
 * emitters — `logEvent`, `track`, `GrowthbookExperimentEvent`, etc.
 * The vendored snapshot at `src/opencc-src/services/analytics/` is
 * missing the `index.ts` barrel (and several sibling files), but
 * opencc's transitive imports still reference them.
 *
 * For the bridge path, we don't need real analytics — telemetry is
 * a post-hoc concern. We just need every exported name to be a
 * callable (or constructable) no-op so `import { ... } from
 * 'src/services/analytics/index.js'` resolves and zai's runtime
 * doesn't crash.
 *
 * Wired via vitest.config.ts + bun-protocol.mjs aliases targeting
 * any `src/services/analytics/...` and `../services/analytics/...`
 * import path. The actual `services/analytics/*` files in the
 * vendored snapshot are dead code for the bridge.
 */

export function logEvent(_event: string, _props?: unknown): void {
  // noop
}

export function logEventWithDuration(
  _event: string,
  _props?: unknown,
): { end: (extra?: unknown) => void } {
  return { end: () => {} }
}

export class GrowthbookExperimentEvent {
  // empty — analytics consumers only check `instanceof` for telemetry
  // classification; we never want to fire a real event from zai.
  constructor(..._args: unknown[]) {}
}

export class ClaudeCodeInternalEvent {
  constructor(..._args: unknown[]) {}
}

export function trackEvent(_event: string, _props?: unknown): void {
  // noop
}

export function datadogLog(_event: string, _props?: unknown): void {
  // noop
}

export function setupAnalytics(_config: unknown): void {
  // noop
}

// Some callers destructure config / options — give them a default shape.
export const analyticsConfig = {
  enabled: false,
  endpoint: '',
  sampleRate: 0,
}

export default {
  logEvent,
  logEventWithDuration,
  GrowthbookExperimentEvent,
  ClaudeCodeInternalEvent,
  trackEvent,
  datadogLog,
  setupAnalytics,
  analyticsConfig,
}