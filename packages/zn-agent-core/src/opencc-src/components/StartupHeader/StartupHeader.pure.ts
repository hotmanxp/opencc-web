// @ts-nocheck
import { homedir } from 'os'

/**
 * Replace the user's home directory prefix with `~`.
 * Returns the path unchanged if it is not under home, is relative,
 * is empty, or the home directory cannot be determined.
 */
export function expandTilde(path: string): string {
  if (!path) return path
  let home: string
  try {
    home = homedir()
  } catch {
    return path
  }
  if (!home) return path
  if (path === home) return '~'
  if (path.startsWith(home + '/')) {
    return '~' + path.slice(home.length)
  }
  return path
}

/**
 * Truncate a path to fit `maxWidth` columns, keeping the first and last
 * segments and eliding the middle. Returns the path unchanged if it
 * already fits or if maxWidth is below the 10-char truncation threshold.
 */
export function truncatePath(path: string, maxWidth: number): string {
  if (maxWidth < 10) return path
  if (path.length <= maxWidth) return path
  const parts = path.split('/')
  if (parts.length <= 2) {
    return path.slice(0, maxWidth)
  }
  const first = parts[0] === '' ? '/' + (parts[1] ?? '') : parts[0]
  const last = parts[parts.length - 1]
  const candidate = `${first}/.../${last}`
  if (candidate.length <= maxWidth) return candidate
  return candidate.slice(0, maxWidth)
}
