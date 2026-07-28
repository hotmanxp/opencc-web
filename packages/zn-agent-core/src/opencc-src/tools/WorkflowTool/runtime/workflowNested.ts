// src/tools/WorkflowTool/runtime/workflowNested.ts

const MAX_NESTING_DEPTH = 1

export type WorkflowDef = { name: string; script: string }
export type ResolveWorkflow = (name: string) => Promise<WorkflowDef | null>
export type RunScript = (script: string, args: unknown) => Promise<unknown>

export type NestedRunnerOpts = {
  resolveWorkflow: ResolveWorkflow
  runScript: RunScript
  nestingDepth: number
}

/**
 * Create a `workflow(name, args)` function bound to a parent runner.
 * Enforces upstream's "one level of nesting only" rule by tracking
 * nestingDepth — if a child workflow script tries to call workflow()
 * again, the nested runner is constructed with depth=1 and the
 * guard rejects it.
 */
export function createNestedWorkflowRunner(opts: NestedRunnerOpts) {
  return async function workflow(
    nameOrRef: string | { scriptPath: string },
    args?: unknown,
  ): Promise<unknown> {
    if (opts.nestingDepth >= MAX_NESTING_DEPTH) {
      throw new Error(
        'workflow() cannot be called from within a child workflow — ' +
        'nesting is limited to one level. Inline the inner script or call its agents directly.',
      )
    }

    let def: WorkflowDef | null
    if (typeof nameOrRef === 'string') {
      def = await opts.resolveWorkflow(nameOrRef)
      if (!def) {
        throw new Error(
          `workflow('${nameOrRef}'): no workflow with that name. ` +
          `Available: (registry not enumerable in this scope)`,
        )
      }
    } else if (nameOrRef && typeof nameOrRef === 'object' && 'scriptPath' in nameOrRef) {
      const { readFileSync } = await import('node:fs')
      try {
        const script = readFileSync(nameOrRef.scriptPath, 'utf-8')
        def = { name: '<inline>', script }
      } catch (e) {
        throw new Error(`workflow({scriptPath:'${nameOrRef.scriptPath}'}): ${e instanceof Error ? e.message : String(e)}`)
      }
    } else {
      throw new TypeError('workflow() expects a workflow name (string) or {scriptPath: string}')
    }

    return opts.runScript(def.script, args)
  }
}
