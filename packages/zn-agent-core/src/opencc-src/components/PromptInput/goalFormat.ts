/**
 * Format a token count for compact display: 0→"0", 800→"800", 1500→"1.5k",
 * 12400→"12k", 1_500_000→"1.5M". Trims trailing ".0" so "1.0k" renders as "1k".
 *
 * Exported as a standalone helper (instead of inline in PromptInputFooter)
 * so it can be unit-tested without spinning up the Ink renderer.
 */
export function formatTokenCount(n: number): string {
  if (n < 1000) return String(n)
  if (n < 1_000_000) {
    const s = (n / 1000).toFixed(1)
    return s.endsWith('.0') ? s.slice(0, -2) + 'k' : s + 'k'
  }
  const s = (n / 1_000_000).toFixed(1)
  return s.endsWith('.0') ? s.slice(0, -2) + 'M' : s + 'M'
}

/**
 * Format a goal-loop duration for the footer status pill. Below 60s renders
 * as "Ns" (e.g. "45s"); at or above 60s switches to "Xm Ys" (e.g. "35m 45s")
 * so the pill width stays predictable as a goal runs past the one-minute mark.
 * Negative input clamps to "0s" — the call sites always pass
 * `Math.max(0, …)`, but defensive here keeps the helper safe in isolation.
 */
export function formatGoalDuration(sec: number): string {
  const s = Math.max(0, Math.floor(sec))
  if (s < 60) return `${s}s`
  const m = Math.floor(s / 60)
  const r = s % 60
  return `${m}m ${r}s`
}