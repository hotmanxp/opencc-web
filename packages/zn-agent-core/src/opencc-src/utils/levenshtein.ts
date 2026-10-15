/**
 * Levenshtein distance with the Damerau transposition case.
 *
 * Ported from upstream's `X8` (bundle.js). The transposition branch is the
 * whole point: skill names are short and typo-prone in exactly the adjacent-
 * swap way ("reviw" -> "review"), which plain Levenshtein scores as 2 and
 * would reject at maxEditDistance 1.
 */
export function levenshtein(a: string, b: string): number {
  if (a === b) return 0
  const m = a.length
  const n = b.length
  // Two-row DP would be smaller, but the transposition case reads a row back
  // two, so keep the full matrix like upstream does.
  const d: number[][] = Array.from({ length: m + 1 }, (_, i) =>
    Array.from({ length: n + 1 }, (_, j) => (i === 0 ? j : j === 0 ? i : 0)),
  )
  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1
      d[i]![j] = Math.min(d[i - 1]![j]! + 1, d[i]![j - 1]! + 1, d[i - 1]![j - 1]! + cost)
      if (
        i > 1 &&
        j > 1 &&
        a[i - 1] === b[j - 2] &&
        a[i - 2] === b[j - 1]
      ) {
        d[i]![j] = Math.min(d[i]![j]!, d[i - 2]![j - 2]! + 1)
      }
    }
  }
  return d[m]![n]!
}

/**
 * Closest name (or alias) to `target` within `maxEditDistance`, or undefined.
 *
 * Ported from upstream's `IZ`. Deliberately NOT Fuse.js: Fuse scores are
 * relative to the corpus, so an absolute `maxEditDistance` bound does not
 * survive — a one-character typo against a large corpus scores well while a
 * same-distance typo against a tiny corpus does not.
 */
export function findClosestName(
  target: string,
  candidates: { name: string; aliases?: string[] }[],
  maxEditDistance = 1,
): string | undefined {
  let best: string | undefined
  let bestDistance = maxEditDistance + 1
  for (const candidate of candidates) {
    for (const name of [candidate.name, ...(candidate.aliases ?? [])]) {
      // Cheap reject first: a string differing by more than N in length can
      // never be within N edits.
      if (Math.abs(name.length - target.length) > maxEditDistance) continue
      const distance = levenshtein(target, name)
      if (distance < bestDistance) {
        bestDistance = distance
        best = name
      }
    }
  }
  return best
}
