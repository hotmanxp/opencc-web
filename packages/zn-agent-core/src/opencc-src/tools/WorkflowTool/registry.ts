// src/tools/WorkflowTool/registry.ts
import { existsSync, readdirSync, statSync } from 'fs'
import { join } from 'path'
import { pathToFileURL } from 'url'
import chokidar, { type FSWatcher } from 'chokidar'
import type { PluginLike } from './pluginWorkflowLoader.js'
import type { Workflow } from './types.js'

export type RegistryOpts = {
  projectDir: string
  userDir: string
  /**
   * Plan12 Task 5: optional plugin list. When provided, `list()` and
   * `get()` will also include workflows loaded from each plugin's
   * `workflowsPath` directory and `workflowsPaths[]` array (see
   * `loadPluginWorkflows`). Optional so existing callers that don't
   * use plugins can keep passing just `{ projectDir, userDir }`.
   */
  plugins?: PluginLike[]
}

/**
 * Discovers and tracks workflows available to the WorkflowTool.
 *
 * Resolution order (later wins on name conflict):
 *   1. Bundled workflows (registered programmatically via `registerBundled`)
 *   2. User workflows from `<userDir>/.claude/workflows/*.js`
 *   3. Project workflows from `<projectDir>/.claude/workflows/*.js`
 *
 * Discovery is cold-scan-once: the project + user dirs are scanned the
 * first time `list()`/`get()` is called (or when `reload()` is forced
 * explicitly). Bundled workflows registered via `registerBundled()` do
 * NOT count as a scan — they're always visible. The first-scan guard
 * (`_diskScanned`) prevents re-scanning the disk on every lookup, which
 * would be O(disk IO) per `WorkflowTool.call()` invocation.
 */
export class WorkflowRegistry {
  // Bundled workflows are kept in a separate map so `reload()` (which
  // clears the disk-scanned workflows) doesn't evict them. Bundled
  // workflows are registered at construction time and never change.
  private bundledWorkflows = new Map<string, Workflow>()
  private diskWorkflows = new Map<string, Workflow>()
  private _diskScanned = false
  private watchers: FSWatcher[] = []
  private debounceTimer: ReturnType<typeof setTimeout> | null = null

  constructor(private readonly opts: RegistryOpts) {}

  /** Cold scan: re-read all .js files in project + user dirs. Resets
   *  the `_diskScanned` guard so the next `list()`/`get()` triggers
   *  another scan. Bundled workflows are preserved. */
  async reload(): Promise<void> {
    this.diskWorkflows.clear()
    this._diskScanned = false
    for (const wf of await this.scanDir(join(this.opts.userDir, '.zai', 'workflows'), 'user')) {
      this.diskWorkflows.set(wf.name, wf)
    }
    for (const wf of await this.scanDir(join(this.opts.projectDir, '.zai', 'workflows'), 'project')) {
      this.diskWorkflows.set(wf.name, wf)
    }
    this._diskScanned = true
  }

  /** Add a bundled workflow (e.g. /deep-research). Bundled workflows
   *  bypass the disk-scan guard — they're always visible regardless of
   *  whether the disk has been scanned. */
  registerBundled(workflow: Workflow): void {
    this.bundledWorkflows.set(workflow.name, workflow)
  }

  /** Combined view: bundled first (so the lookup below finds them on
   *  the first cold-scan), then disk-scanned. Project > user resolution
   *  is preserved (later wins), so disk wins on name collision. */
  private merged(): Map<string, Workflow> {
    const out = new Map<string, Workflow>()
    for (const [k, v] of this.bundledWorkflows) out.set(k, v)
    for (const [k, v] of this.diskWorkflows) out.set(k, v)
    return out
  }

  /** List all known workflows, sorted by name. Triggers the first
   *  cold-scan if it hasn't run yet. */
  async list(): Promise<Workflow[]> {
    if (!this._diskScanned) await this.reload()
    const out = this.merged()
    // Plan12 Task 5: layer in plugin-loaded workflows. Plugins are
    // queried async, so we await here. Plugin names use
    // `<plugin>:<workflow>` (set by loadPluginWorkflows) so they
    // can't collide with bundled/project/user names — the .set()
    // below will simply overwrite a same-named entry (last wins),
    // which matches the existing precedence order.
    if (this.opts.plugins && this.opts.plugins.length > 0) {
      const { loadPluginWorkflows } = await import('./pluginWorkflowLoader.js')
      const pluginWorkflows = await loadPluginWorkflows(this.opts.plugins)
      for (const wf of pluginWorkflows) out.set(wf.name, wf)
    }
    return [...out.values()].sort((a, b) => a.name.localeCompare(b.name))
  }

  /** Look up by name. Triggers the first cold-scan if it hasn't run yet. */
  async get(name: string): Promise<Workflow | undefined> {
    if (!this._diskScanned) await this.reload()
    return this.merged().get(name)
  }

  /**
   * Start watching project + user workflow directories for file changes.
   * Any add/change/unlink event triggers a debounced (100ms) `reload()`.
   * No-op if already watching.
   */
  startWatching(): void {
    if (this.watchers.length > 0) return  // already watching

    const dirs = [
      join(this.opts.projectDir, '.zai', 'workflows'),
      join(this.opts.userDir, '.zai', 'workflows'),
    ]
    for (const dir of dirs) {
      let stat
      try {
        stat = statSync(dir)
      } catch {
        continue
      }
      if (!stat.isDirectory()) continue
      const w = chokidar.watch(dir, {
        ignored: /(^|[\\/])\../,
        persistent: true,
        ignoreInitial: true,
        // macOS fsevents sometimes drops the `add` event for files
        // written in quick succession (e.g. test fixtures or editor
        // save bursts). awaitWriteFinish waits for the file size to
        // stabilize before firing the event, eliminating the race.
        awaitWriteFinish: { stabilityThreshold: 50, pollInterval: 25 },
      })
      w.on('add', () => this.scheduleReload())
      w.on('change', () => this.scheduleReload())
      w.on('unlink', () => this.scheduleReload())
      this.watchers.push(w)
    }
  }

  /** Stop all watchers and clear any pending debounced reload. */
  stopWatching(): void {
    for (const w of this.watchers) w.close()
    this.watchers = []
    if (this.debounceTimer) {
      clearTimeout(this.debounceTimer)
      this.debounceTimer = null
    }
  }

  /** Debounce rapid file events: only call reload() after 100ms of quiet. */
  private scheduleReload(): void {
    if (this.debounceTimer) clearTimeout(this.debounceTimer)
    this.debounceTimer = setTimeout(() => {
      this.reload().catch(e => console.error('[workflow] Reload failed:', e))
    }, 100)
  }

  private async scanDir(dir: string, source: 'project' | 'user'): Promise<Workflow[]> {
    const out: Workflow[] = []
    if (!existsSync(dir)) return out
    let stat
    try {
      stat = statSync(dir)
    } catch {
      return out
    }
    if (!stat.isDirectory()) return out
    const entries = readdirSync(dir).filter(f => f.endsWith('.js'))
    for (const file of entries) {
      const fullPath = join(dir, file)
      let run: ((args: string[]) => Promise<string>) | null = null
      try {
        const mod = await import(/* @vite-ignore */ pathToFileURL(fullPath).href)
        run = (mod.default ?? mod.workflow) as
          | ((args: string[]) => Promise<string>)
          | null
      } catch {
        // import() failed (e.g. bare top-level await, no exports). The
        // script body is still valid for the WorkflowTool worker — it
        // reads the source via readFileSync(workflow.path) and the
        // `run` function on the Workflow is never actually called.
        // Fall through with run = null and use a stub below.
        run = null
      }
      out.push({
        name: file.replace(/\.js$/, ''),
        source,
        path: fullPath,
        // The runtime reads the script source from `path` and runs it
        // in a Worker thread. The `run` field is required by the
        // Workflow type but never invoked — see bundled/deepResearch.ts
        // for the same pattern (run: async () => '').
        run: run ?? (async () => ''),
      })
    }
    return out
  }
}
