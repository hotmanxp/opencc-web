// @ts-nocheck

/**
 * Format a context-window token count for display after the model name.
 *
 * - 1_000_000 → '1M'
 * - 1_500_000 → '1.5M'
 * - 2_048_576 → '2M'
 * - 204_000   → '204K'
 * - 128_000   → '128K'
 */
export function formatContextWindow(tokens: number): string {
  const k = Math.floor(tokens / 1000)
  if (k >= 1000) {
    const m = k / 1000
    const rounded = Math.round(m)
    // If the value is within 0.1 of an integer million, show as integer.
    // Matches the spec: 1_500_000 → "1.5M" (delta 0.5, kept),
    //                    2_048_576 → "2M"   (delta 0.048, snapped).
    if (Math.abs(m - rounded) < 0.1) {
      return `${rounded}M`
    }
    return `${m.toFixed(1)}M`
  }
  return `${k}K`
}
