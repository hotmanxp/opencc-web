// packages/zn-agent-core/src/compat/repl/setup/setupSkillsChange.ts
// @ts-nocheck
/**
 * zai patch (2026-08-30, plan P1): L1 hook adapter — setupSkillsChange.
 * chokidar watch on skill directory; emits callback on file change.
 * Mirrors useSkillsChange semantics.
 */

import { watch, type FSWatcher } from 'fs'
import { join } from 'path'

type SetupSkillsChangeOpts = {
  cwd: string
  onSkillsChanged: (changedFiles: string[]) => void
}

export function setupSkillsChange(opts: SetupSkillsChangeOpts) {
  let watcher: FSWatcher | null = null
  let disposed = false
  const skillsDir = join(opts.cwd, '.zai', 'skills')

  try {
    watcher = watch(skillsDir, { recursive: false }, (event, filename) => {
      if (disposed) return
      if (filename) opts.onSkillsChanged([filename])
    })
    watcher.on('error', () => { /* tolerate dir not existing */ })
  } catch {
    // Skills dir may not exist; that's fine, just no-op.
  }

  return {
    async triggerRefresh() {
      if (disposed) return
      opts.onSkillsChanged([])
    },
    teardown() {
      if (disposed) return
      disposed = true
      if (watcher) {
        try { watcher.close() } catch { /* tolerate */ }
        watcher = null
      }
    },
  }
}