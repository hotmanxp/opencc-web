// src/tools/WorkflowTool/pluginWorkflowLoader.ts
import * as fs from 'fs/promises'
import * as path from 'path'
import { parseMetaFromScript } from './parseMetaFromScript.js'
import type { Workflow } from './types.js'

const SCRIPT_BYTE_LIMIT = 52_428_800 // 50 MB; matches upstream

export type PluginLike = {
  name: string
  source: string
  manifest: unknown
  workflowsPath?: string
  workflowsPaths?: string[]
  enabled?: boolean
}

/**
 * Port of upstream claude-code 2.1.170's `loadPluginWorkflows()`.
 * Reads each enabled plugin's `workflowsPath` directory + `workflowsPaths[]`
 * custom file paths, parses their `export const meta = {...}` (using the
 * Plan7 acorn parser), and returns the union of all valid workflows.
 *
 * Result is cached per-call. `clearPluginWorkflowsCache()` re-loads on
 * the next call.
 */
let cache: { plugins: PluginLike[]; result: Workflow[] } | null = null

export async function loadPluginWorkflows(
  plugins: PluginLike[],
): Promise<Workflow[]> {
  if (cache && cache.plugins === plugins) return cache.result
  const out: Workflow[] = []
  for (const plugin of plugins) {
    if (plugin.enabled === false) continue
    const dirs = plugin.workflowsPath ? [plugin.workflowsPath] : []
    const files = plugin.workflowsPaths ?? []
    for (const dir of dirs) {
      try {
        const stat = await fs.stat(dir)
        if (stat.isDirectory()) {
          const entries = await fs.readdir(dir)
          for (const entry of entries) {
            if (entry.endsWith('.js')) {
              const wf = await loadOne(path.join(dir, entry), plugin)
              if (wf) out.push(wf)
            }
          }
        } else if (dir.endsWith('.js')) {
          const wf = await loadOne(dir, plugin)
          if (wf) out.push(wf)
        }
      } catch (e) {
        // upstream: log warn and continue
        console.warn(`[pluginWorkflows] Failed to load ${dir}:`, e)
      }
    }
    for (const file of files) {
      const wf = await loadOne(file, plugin)
      if (wf) out.push(wf)
    }
  }
  cache = { plugins, result: out }
  return out
}

async function loadOne(
  file: string,
  plugin: PluginLike,
): Promise<Workflow | null> {
  try {
    const script = await fs.readFile(file, 'utf-8')
    if (script.length > SCRIPT_BYTE_LIMIT) return null
    const parseResult = parseMetaFromScript(script)
    if (!parseResult.ok) {
      console.warn(`[pluginWorkflows] ${file}: ${parseResult.error}`)
      return null
    }
    return {
      source: 'plugin',
      name: `${plugin.name}:${parseResult.value.meta.name}`,
      description: parseResult.value.meta.description,
      path: file,
      run: async () => '',
    }
  } catch (e) {
    console.warn(`[pluginWorkflows] Failed to load ${file}:`, e)
    return null
  }
}

export function clearPluginWorkflowsCache(): void {
  cache = null
}
