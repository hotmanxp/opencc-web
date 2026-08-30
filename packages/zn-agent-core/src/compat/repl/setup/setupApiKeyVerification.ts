// @ts-nocheck
/**
 * zai patch (2026-08-30, plan P2): L2 hook adapter — setupApiKeyVerification.
 * Imperative API key check; mirrors useApiKeyVerification.
 */

type SetupApiKeyVerificationOpts = { onResult: (ok: boolean) => void }

export function setupApiKeyVerification(opts: SetupApiKeyVerificationOpts) {
  let disposed = false
  return {
    async verify(): Promise<boolean> {
      // P2 minimal: assume env-based key present; P2.1 wires real check
      const ok = !!process.env.ANTHROPIC_API_KEY || !!process.env.OPENAI_API_KEY
      if (disposed) return ok
      try { opts.onResult(ok) } catch (e) { console.warn(e) }
      return ok
    },
    teardown() {
      if (disposed) return
      disposed = true
    },
  }
}
