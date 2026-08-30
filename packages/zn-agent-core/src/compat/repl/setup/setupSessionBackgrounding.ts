// packages/zn-agent-core/src/compat/repl/setup/setupSessionBackgrounding.ts
// @ts-nocheck
/**
 * zai patch (2026-08-30, plan P1): L1 hook adapter — setupSessionBackgrounding.
 * Tracks session background/foreground transitions; emits callbacks.
 * Mirrors useSessionBackgrounding semantics.
 */

type SetupSessionBackgroundingOpts = {
  sessionId: string
  onBackground: () => void
  onForeground: () => void
}

export function setupSessionBackgrounding(opts: SetupSessionBackgroundingOpts) {
  let disposed = false
  let isBackground = false

  return {
    background() {
      if (disposed || isBackground) return
      isBackground = true
      try { opts.onBackground() } catch (err) { console.warn(err) }
    },
    foreground() {
      if (disposed || !isBackground) return
      isBackground = false
      try { opts.onForeground() } catch (err) { console.warn(err) }
    },
    isBackground: () => isBackground,
    teardown() {
      if (disposed) return
      disposed = true
    },
  }
}
