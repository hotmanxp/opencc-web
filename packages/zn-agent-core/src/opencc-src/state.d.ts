/**
 * Stub .d.ts for `state/*` — zai uses its own Zustand store; opencc's
 * React-coupled AppState is stripped. Vendored .ts files that did
 * `import type { AppState } from 'src/state/AppState.js'` resolve here.
 *
 * `AppState` was opencc's central Zustand store holding the UI state of
 * the Ink REPL: tool progress, notification queue, foreground task
 * registry, etc. zai has its own server-side state (cwd tracking, task
 * list, etc.) so this type is referenced only as a TypeScript type and
 * never instantiated.
 *
 * When you need a runtime AppState from opencc's perspective (e.g.
 * BashTool writing tool progress), pass a noop or omit — the JSX/UI
 * rendering paths are skipped in Phase 2.
 */

// Placeholder type — actually unused at runtime, but opencc's Tool.ts
// requires `setAppState(f: (prev: AppState) => AppState): void`.
// In Phase 5, we'll provide a runtime shim that returns a frozen object.
export type AppState = {
  // Sentinel — zai never reads these fields, but the type exists for
  // opencc tool implementations that capture AppState in closures.
  readonly [key: string]: never
}

// Default empty state — used when callers don't supply a real AppState.
export const initialAppState: AppState = Object.freeze({}) as AppState

// Re-export everything else from real paths so type-only imports still
// resolve cleanly.
// (Notification type re-exports kept commented — zai's opencc vendor
// doesn't import it; if needed later, see `notifications.ts`.)
// export type { Notification } from './types/notifications.js'