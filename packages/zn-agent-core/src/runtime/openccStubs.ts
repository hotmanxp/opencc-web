/**
 * Shared helper for opencc-runtime stubs.
 *
 * `src/runtime/index.ts` re-exports a handful of symbols that used to be
 * re-exported from `opencc-src/`. Because opencc source is Bun-native and
 * not compiled by this package, the policy is:
 *
 *   - Symbols that have a tiny, behavior-equivalent runtime implementation
 *     (`registerProcessOutputErrorHandlers` is just EPIPE handlers on
 *     stdout/stderr) are inlined here so callers work unchanged.
 *   - Symbols that are *the* runtime entry point (`query`, `QueryEngine`,
 *     `RequestApproveTool.call`) are kept as throwing stubs so callers that
 *     reach for them directly get a clear "use DefaultAgentRuntime.run()
 *     instead" message rather than a confusing missing-module error.
 *
 * Build-time consumers (zod types, type-only imports) are unaffected because
 * TypeScript erases function bodies in d.ts.
 */

export function throwNotWired(name: string): never {
  throw new Error(
    `[zn-agent-core] '${name}' is not wired in this build. ` +
      `Use DefaultAgentRuntime.run() (from '@zn-ai/zn-agent-core') instead. ` +
      `See AGENTS.md 'Compat shim' notes for the opencc adapter wiring plan.`,
  )
}

// ---------------------------------------------------------------------------
// `registerProcessOutputErrorHandlers` — EPIPE-safe stdout/stderr wiring.
// Verbatim port of opencc-src/utils/process.ts (no opencc dependencies).
// ---------------------------------------------------------------------------

function handleEPIPE(
  stream: NodeJS.WriteStream,
): (err: NodeJS.ErrnoException) => void {
  return (err: NodeJS.ErrnoException) => {
    if (err.code === 'EPIPE') {
      stream.destroy()
    }
  }
}

/**
 * Prevents memory leak when pipe is broken (e.g., `zai dev | head -1`).
 * zai's CLI calls this once at startup (see packages/zai/src/cli/index.ts).
 */
export function registerProcessOutputErrorHandlersImpl(): void {
  if (typeof process === 'undefined') return
  process.stdout.on('error', handleEPIPE(process.stdout))
  process.stderr.on('error', handleEPIPE(process.stderr))
}
