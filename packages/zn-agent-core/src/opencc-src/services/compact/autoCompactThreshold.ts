// Leaf module — no imports on purpose.
//
// `autoCompact.ts` transitively pulls in `utils/attachments.ts` and
// `tools.ts`, whose `require()`-based lazy graph vite-node cannot resolve, so
// the threshold policy is not directly unit-testable. Extracted here (mirroring
// how `test/opencc-src/tools/fileReadInternalCache.test.ts` drives the
// `FileReadTool/constants.ts` leaf) so the policy can be driven directly.
//
// zai patch (2026-10-08): 大窗口模型的比例阈值。回归背景 sess-1791423013771-u8o0uxod。

export const AUTOCOMPACT_BUFFER_TOKENS = 13_000

/** Models above this effective window compact on a percentage, not window-minus-buffer. */
export const LARGE_CONTEXT_WINDOW_MIN = 512_000
export const LARGE_CONTEXT_AUTOCOMPACT_PCT = 0.6

/**
 * Resolve the token count at which auto-compaction should fire.
 *
 * Upstream applies `window - buffer` to every model, which assumes windows are
 * small enough that the buffer is meaningful. zai routinely runs 1M-window
 * third-party models (MiniMax-M3 / M3.1-Flash-Preview, zhiniao-glm-5.1), where
 * that yields a ~987k threshold that is effectively unreachable — and both
 * microcompact paths are stubbed off in external builds, leaving 60%→98% of the
 * window completely unmanaged. Hence the percentage branch.
 *
 * @param effectiveContextWindow already net of the summary output reservation
 * @param envPercent CLAUDE_AUTOCOMPACT_PCT_OVERRIDE; wins over the percentage
 *   branch and can only tighten, never loosen
 */
export function computeAutoCompactThreshold(
  effectiveContextWindow: number,
  envPercent?: string,
): number {
  const autocompactThreshold =
    effectiveContextWindow - AUTOCOMPACT_BUFFER_TOKENS

  // Override for easier testing of autocompact
  if (envPercent) {
    const parsed = parseFloat(envPercent)
    if (!isNaN(parsed) && parsed > 0 && parsed <= 100) {
      const percentageThreshold = Math.floor(
        effectiveContextWindow * (parsed / 100),
      )
      return Math.min(percentageThreshold, autocompactThreshold)
    }
  }

  if (effectiveContextWindow > LARGE_CONTEXT_WINDOW_MIN) {
    const percentageThreshold = Math.floor(
      effectiveContextWindow * LARGE_CONTEXT_AUTOCOMPACT_PCT,
    )
    return Math.min(percentageThreshold, autocompactThreshold)
  }

  return autocompactThreshold
}
