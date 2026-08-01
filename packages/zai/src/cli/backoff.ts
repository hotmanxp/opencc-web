export const MAX_RESTART_ATTEMPTS = 3
export const READY_TIMEOUT_MS = 30_000

const BASE_MS = 1000
const CAP_MS = 4000

export function nextBackoffMs(attempt: number): number {
  if (attempt < 1) return BASE_MS
  return Math.min(BASE_MS * 2 ** (attempt - 1), CAP_MS)
}
