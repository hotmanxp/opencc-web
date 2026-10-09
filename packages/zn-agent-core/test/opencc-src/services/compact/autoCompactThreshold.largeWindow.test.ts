/**
 * Regression for the auto-compact threshold on large-window models.
 *
 * The defect: `getAutoCompactThreshold` applied `window - 13k buffer`
 * uniformly, assuming windows small enough that the buffer is meaningful. zai
 * runs 1M-window third-party models (MiniMax-M3 / M3.1-Flash-Preview,
 * zhiniao-glm-5.1), where that yields a ~987k threshold — unreachable in
 * practice. Both microcompact paths are stubbed off in external builds
 * (`cachedMicrocompact.ts`: `isCachedMicrocompactEnabled` and
 * `isModelSupportedForCacheEditing` both `return false`) and the legacy path is
 * deleted, so 60%→98% of the window was unmanaged.
 *
 * Reproduced in sess-1791423013771-u8o0uxod: a 1M-window session ran to 534k
 * with no compaction, 54.7% of which was Write tool input (each file stored
 * twice — once in `tool_use.input`, once in `tool_result`).
 *
 * The policy lives in the `autoCompactThreshold.ts` leaf because
 * `autoCompact.ts` transitively imports `utils/attachments.ts`, whose
 * `require()` graph vite-node cannot resolve.
 */
import { describe, expect, it } from 'vitest'
import {
  AUTOCOMPACT_BUFFER_TOKENS,
  LARGE_CONTEXT_AUTOCOMPACT_PCT,
  LARGE_CONTEXT_WINDOW_MIN,
  computeAutoCompactThreshold,
} from '../../../../src/opencc-src/services/compact/autoCompactThreshold.js'

// Effective window of a 1M model after the 20k summary-output reservation.
const ONE_MILLION_EFFECTIVE = 980_000
// The token count the failing session reached without compacting.
const SESSION_PEAK_TOKENS = 534_000

describe('computeAutoCompactThreshold', () => {
  it('compacts large-window models at 60% of the effective window', () => {
    expect(ONE_MILLION_EFFECTIVE).toBeGreaterThan(LARGE_CONTEXT_WINDOW_MIN)
    const threshold = computeAutoCompactThreshold(ONE_MILLION_EFFECTIVE)

    expect(threshold).toBe(
      Math.floor(ONE_MILLION_EFFECTIVE * LARGE_CONTEXT_AUTOCOMPACT_PCT),
    )
    // The old window-minus-buffer value left 967k — 433k of headroom past the
    // failing session's peak, so nothing ever fired.
    const oldThreshold = ONE_MILLION_EFFECTIVE - AUTOCOMPACT_BUFFER_TOKENS
    expect(oldThreshold - SESSION_PEAK_TOKENS).toBeGreaterThan(400_000)
    // 60% still lands above that peak: it cuts the unmanaged band from
    // ~60%→98% down to ~60%→100%, but does not by itself cover 534k. A
    // session would need >588k to trip it. See the summary — lowering the
    // percentage further is the lever if that band matters.
    expect(threshold).toBe(588_000)
    expect(threshold).toBeGreaterThan(SESSION_PEAK_TOKENS)
  })

  it('leaves small and medium windows on window-minus-buffer', () => {
    for (const window of [16_000, 128_000, 262_144, LARGE_CONTEXT_WINDOW_MIN]) {
      expect(computeAutoCompactThreshold(window)).toBe(
        window - AUTOCOMPACT_BUFFER_TOKENS,
      )
    }
  })

  it('never exceeds the buffer-adjusted cap', () => {
    // A session-scoped window override must only be able to tighten the
    // threshold, never loosen it past window-minus-buffer.
    for (const window of [16_000, 200_000, 980_000, 2_000_000]) {
      expect(computeAutoCompactThreshold(window)).toBeLessThanOrEqual(
        window - AUTOCOMPACT_BUFFER_TOKENS,
      )
    }
  })

  it('env override wins over the percentage branch and only tightens', () => {
    expect(computeAutoCompactThreshold(ONE_MILLION_EFFECTIVE, '30')).toBe(
      Math.floor(ONE_MILLION_EFFECTIVE * 0.3),
    )
    // Out-of-range values are ignored, falling through to normal policy.
    for (const bad of ['0', '101', 'abc', '']) {
      expect(computeAutoCompactThreshold(ONE_MILLION_EFFECTIVE, bad)).toBe(
        computeAutoCompactThreshold(ONE_MILLION_EFFECTIVE),
      )
    }
  })
})
