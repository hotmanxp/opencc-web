// src/tools/WorkflowTool/singleton.ts
import { homedir } from 'os'
import { readFileSync } from 'fs'
import { WorkflowRegistry } from './registry.js'
import { initBundledWorkflows, getBundledSource } from './bundled/index.js'

const instances = new Map<string, WorkflowRegistry>()

/**
 * Lazily-initialized per-project WorkflowRegistry.
 *
 * Discovery is cold-scan (see WorkflowRegistry.reload()), so instantiating
 * the registry at startup is cheap — directories are only read on the
 * first .get()/.list() call. Bundled workflows (currently /deep-research)
 * are registered at construction time so they're always available even
 * before any disk scan runs.
 *
 * projectDir defaults to process.cwd() so workflows in the current project
 * take precedence over user-dir workflows (see registry.ts resolution order).
 * userDir defaults to homedir() — `~/.zai/workflows/*.js`.
 *
 * One registry per projectDir so two callers running in different project
 * directories (e.g. a sub-shell or a test that switches cwd) get isolated
 * workflow maps. Construct + bundled-register is cheap (one Map.set +
 * one shallow object spread per projectDir), so the per-cwd cache is
 * fine to grow during a long session.
 */
export function getWorkflowRegistry(
  projectDir?: string,
  userDir?: string,
): WorkflowRegistry {
  const dir = projectDir ?? process.cwd()
  const userDirKey = userDir ?? homedir()
  const existing = instances.get(dir)
  if (existing) return existing
  const instance = new WorkflowRegistry({
    projectDir: dir,
    userDir: userDirKey,
  })
  initBundledWorkflows(instance)
  instances.set(dir, instance)
  return instance
}

/**
 * Invalidate the per-cwd `WorkflowRegistry` instance cache. Port of
 * upstream `Jwq.invalidateWorkflowCache`.
 *
 * After calling this, the next `getWorkflowRegistry(cwd)` returns a
 * fresh instance (re-running `initBundledWorkflows` and the cold-scan
 * on the next `list()`/`get()`). Bundled workflows like `deep-research`
 * are re-registered automatically by the new instance's constructor
 * path, so this is sufficient to refresh both project + user + bundled
 * sources without separately clearing the process-static bundled
 * source map. Useful for:
 *   - plugin install/uninstall flows that need to re-read workflows
 *   - tests that mutate `.zai/workflows/*.js` between runs
 *   - hot-reload after a watcher detects a workflow file change
 */
export function invalidateWorkflowCache(): void {
  instances.clear()
}

/**
 * Resolve a child workflow ref (the wire shape from the wrapper's
 * `workflow(nameOrRef, args)` call) to the script source string.
 * Bundled workflows (e.g. `deep-research`) read from the in-process
 * `bundledSourceRegistry`; project + user workflows read from
 * `.zai/workflows/<name>.js`; `scriptPath` refs read the file
 * directly. Throws with a clear error if the name is unknown.
 *
 * Used by LocalWorkflowTask to wire `workflow()` calls to the actual
 * child script source before running the child inline.
 */
export async function resolveChildScript(
  ref:
    | { kind: 'name'; value: string }
    | { kind: 'scriptPath'; value: string },
): Promise<string> {
  if (ref.kind === 'name') {
    const bundled = getBundledSource(ref.value)
    if (bundled) return bundled
    const wf = await getWorkflowRegistry().get(ref.value)
    if (!wf) {
      throw new Error(
        `workflow('${ref.value}'): no workflow with that name. ` +
          `Use a bundled name (deep-research) or place a .js file in ` +
          `.zai/workflows/${ref.value}.js.`,
      )
    }
    return readFileSync(wf.path, 'utf-8')
  }
  // scriptPath: read the file directly. Trust the caller — they
  // explicitly opted in to a path. Path errors surface as exceptions
  // with ENOENT/EACCES messages.
  return readFileSync(ref.value, 'utf-8')
}
