// src/tools/WorkflowTool/bundled/index.ts
import { deepResearch, deepResearchSource } from './deepResearch.ts'
import type { WorkflowRegistry } from '../registry.ts'
import type { Workflow } from '../types.ts'

const bundledSourceRegistry = new Map<string, string>()

/**
 * Register all bundled workflows (currently: /deep-research) with the
 * WorkflowRegistry. Called once at startup.
 */
export function initBundledWorkflows(registry: WorkflowRegistry): void {
  const deepResearchWorkflow: Workflow = {
    ...deepResearch,
    run: async (_args: string[]) => '',  // real source loaded via getBundledSource
  }
  registry.registerBundled(deepResearchWorkflow)
  bundledSourceRegistry.set('deep-research', deepResearchSource)
}

/** Get the source of a bundled workflow by name, for the Worker to compile. */
export function getBundledSource(name: string): string | undefined {
  return bundledSourceRegistry.get(name)
}
