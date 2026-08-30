// packages/zn-agent-core/src/compat/repl/setup/setupSkillsChange.ts
// @ts-nocheck
/**
 * zai patch (2026-08-30, plan P1): L1 hook adapter — setupSkillsChange.
 * chokidar watch on skill directory; emits callback on file change.
 * Mirrors useSkillsChange semantics.
 *
 * zai patch (2026-08-30, plan P3, Task 4): switched from Node's native
 * `fs.watch` to chokidar to fix 12-path verification failure Path 9.
 * Native fs.watch on macOS does NOT reliably report filenames for new
 * files added to a watched directory — chokidar does. Also debounce
 * rapid bursts so a single onSkillsChanged call coalesces a batch of
 * simultaneous file events into one callback (matching vendor
 * skillChangeDetector.scheduleReload behavior).
 */

import chokidar, { type FSWatcher } from 'chokidar'
import { join } from 'path'

type SetupSkillsChangeOpts = {
  cwd: string
  onSkillsChanged: (changedFiles: string[]) => void
}

// Debounce window — collapse multiple chokidar events from a single
// user action (e.g. git pull that rewrites many files) into one
// notification. 200ms is short enough that the 3s verification budget
// is unaffected, long enough that one writeFile doesn't fire twice.
const DEBOUNCE_MS = 200

export function setupSkillsChange(opts: SetupSkillsChangeOpts) {
  let watcher: FSWatcher | null = null
  let disposed = false
  let pendingTimer: ReturnType<typeof setTimeout> | null = null
  let pendingFiles: string[] = []
  const skillsDir = join(opts.cwd, '.agents', 'skills')

  const flushPending = (): void => {
    if (disposed) return
    pendingTimer = null
    if (pendingFiles.length === 0) return
    const files = pendingFiles.slice()
    pendingFiles = []
    opts.onSkillsChanged(files)
  }

  try {
    watcher = chokidar.watch(skillsDir, {
      persistent: true,
      ignoreInitial: true,
      // Match vendor skillChangeDetector.ts depth: 2 (skill-name/SKILL.md).
      depth: 2,
      // Ignore permission errors so a stale skills dir doesn't crash.
      ignorePermissionErrors: true,
      // Bound chokidar's polling interval so 'add' events fire promptly.
      // Default is platform-dependent (often 100ms+ on macOS when fsevents
      // isn't bound, which vitest's Node runner may not set up).
      interval: 100,
      binaryInterval: 100,
    })

    const onEvent = (filePath: string): void => {
      if (disposed) return
      // chokidar returns absolute path on some platforms, basename on
      // others; normalize to basename so the consumer sees a stable shape.
      const basename = filePath.split(/[/\\]/).pop() ?? filePath
      if (!pendingFiles.includes(basename)) pendingFiles.push(basename)
      if (pendingTimer) clearTimeout(pendingTimer)
      pendingTimer = setTimeout(flushPending, DEBOUNCE_MS)
    }

    watcher.on('add', onEvent)
    watcher.on('change', onEvent)
    watcher.on('unlink', onEvent)
    watcher.on('error', () => {
      /* tolerate dir not existing or transient errors */
    })
  } catch {
    // chokidar.watch may throw if the path is unreachable; that's fine,
    // setup is a no-op and triggerRefresh still works.
  }

  return {
    async triggerRefresh() {
      if (disposed) return
      opts.onSkillsChanged([])
    },
    teardown() {
      if (disposed) return
      disposed = true
      if (pendingTimer) {
        clearTimeout(pendingTimer)
        pendingTimer = null
      }
      pendingFiles = []
      if (watcher) {
        const w = watcher
        watcher = null
        w.close().catch(() => {
          /* tolerate */
        })
      }
    },
  }
}