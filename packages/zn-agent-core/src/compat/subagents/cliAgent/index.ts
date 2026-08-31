/**
 * cliAgent — SpawnAgent unified carrier for CLI subagents (claude-code/dsh).
 *
 * Not wired into the main `compat/subagents/index.ts` barrel yet: this is
 * the task-#5 carrier surface. The future AgentTool wrapper will re-export
 * `spawnCliAgent` from the main entry (and sync `SUBAGENT_INDEX_DTS` in
 * scripts/bundle-opencc.ts) when it starts routing `subagent_type` here.
 */

export {
  defaultCliRunId,
  formatAgentId,
  generateTaskId,
  parseAgentId,
  sanitizeAgentName,
} from './ids.js'
export { createCliRunShell, toMessage } from './runShell.js'
export type { CliRunShell, CliRunShellOptions } from './runShell.js'
export { spawnCliAgent } from './spawn.js'
export type { CliAgentKind, CliAgentSpawn, CliAgentSpawnArgs } from './spawn.js'
export { publishSpawnToBackground } from './publish.js'
export type { PublishMeta } from './publish.js'