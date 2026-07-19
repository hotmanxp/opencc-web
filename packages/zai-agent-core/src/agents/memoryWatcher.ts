import { watchFile, unwatchFile, statSync } from 'fs'
import { join } from 'path'
import { clearMemoryCache } from './memoryLoader.js'

/**
 * Watches AGENTS.md, AGENTS.local.md, and .claude/rules in a cwd
 * for mtime changes. On change, calls clearMemoryCache() so the next
 * loadMemoryForPrompt() re-reads from disk.
 *
 * 1s poll interval matches vendored GitFileWatcher. Bun's fs.watchFile
 * is the same Node API; no extra dep needed.
 *
 * Singleton per process: only one watcher at a time. stop() before start()
 * is safe; re-start replaces.
 */

const WATCH_INTERVAL_MS = 1000

interface WatchEntry {
  path: string
  prevMtimeMs: number
}

let watchedFiles: WatchEntry[] = []
let onChangeCallback: ((path: string) => void) | null = null

function watcherCallback(path: string): (curr: { mtime?: Date }) => void {
  return (curr) => {
    if (!curr.mtime) return
    const entry = watchedFiles.find((w) => w.path === path)
    if (!entry) return
    if (entry.prevMtimeMs === curr.mtimeMs) return
    entry.prevMtimeMs = curr.mtimeMs
    clearMemoryCache()
    if (onChangeCallback) onChangeCallback(path)
  }
}

function watchOne(path: string): void {
  watchFile(path, { interval: WATCH_INTERVAL_MS }, watcherCallback(path) as any)
  let mtimeMs = 0
  try {
    mtimeMs = statSync(path).mtimeMs
  } catch {
    // file doesn't exist yet — that's fine, we'll pick up mtime on first write
  }
  watchedFiles.push({ path, prevMtimeMs: mtimeMs })
}

function unwatchAll(): void {
  for (const e of watchedFiles) unwatchFile(e.path)
  watchedFiles = []
}

export interface MemoryWatcherHandle {
  stop(): void
}

export function startMemoryWatcher(opts: {
  cwd: string
  onChange?: (path: string) => void
}): MemoryWatcherHandle {
  unwatchAll()
  onChangeCallback = opts.onChange ?? null
  // Phase 3 minimal: watch the 3 most common paths. Future: enumerate
  // .claude/rules/**/*.md via dynamic import of vendored isMemoryFilePath.
  const candidates = [
    join(opts.cwd, 'AGENTS.md'),
    join(opts.cwd, 'AGENTS.local.md'),
    join(opts.cwd, '.claude', 'AGENTS.md'),
  ]
  for (const p of candidates) watchOne(p)
  return {
    stop() {
      unwatchAll()
      onChangeCallback = null
    },
  }
}

export function stopMemoryWatcher(): void {
  unwatchAll()
  onChangeCallback = null
}
