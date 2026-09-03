/**
 * SpawnAgent unified surface — a single entry to run one CLI agent
 * (`opencc` | `dsh` | `opencode`) end-to-end.
 *
 * Rationale (handoff 2026-08-31, task #5): claude-code and dsh providers
 * each implement their own `start<X>Run(request, ctx, spec)` + private
 * `createPendingRun`. `spawnCliAgent` is the shared carrier that gives a
 * spawned CLI agent the same *addressable shape* a vendor teammate has
 * (`agent_id`/`task_id`/`name`/`team_name` + tmux placeholders), backed by
 * the registry's {@link SubagentRun}. The AgentTool spawn branch (vendor)
 * and the future zai-native AgentTool wrapper route here; the providers stay
 * protocol owners (argv + pump/bootstrap).
 */

import {
  SubagentError,
  getSubagentRegistry,
  type SubagentRequest,
  type SubagentContext,
  type SubagentRun,
} from '../registry.js'
import {
  defaultCliRunId,
  formatAgentId,
  generateTaskId,
  sanitizeAgentName,
} from './ids.js'

/** CLI agents this carrier can spawn. */
export type CliAgentKind = 'opencc' | 'dsh' | 'opencode'

export interface CliAgentSpawnArgs {
  /** Addressable name; defaults to `agentType` when omitted. */
  name?: string
  agentType: CliAgentKind
  prompt: string
  /** Model-facing short description; falls back to `name ?? agentType`. */
  description?: string
  /** Vendor-aligned `team_name`; when set, agent_id becomes `name@team`. */
  teamName?: string
  /** Absolute cwd override; falls back to the parent session cwd. */
  cwd?: string
  /** Model override; providers may ignore. */
  model?: string
  /** Caller cancellation. Aborting triggers the run's cancel path. */
  signal?: AbortSignal
  /** Extra env overlay for the child process. */
  env?: Readonly<Record<string, string>>
  /** Reserved (vendor `plan_mode_required`); carriers may gate on it later. */
  planModeRequired?: boolean
}

/**
 * Addressable spawn result — mirrors the vendor `SpawnOutput` shape so the
 * future AgentTool wrapper and downstream consumers can treat a CLI-agent
 * spawn like a teammate spawn.
 */
export interface CliAgentSpawn {
  status: 'spawned'
  /** `name@team` when teamName set; otherwise `<name>-<rand8>`. */
  agent_id: string
  /** Vendor-shaped task id (prefix `t`); the shared key for SSE / mirror. */
  task_id: string
  name: string
  team_name?: string
  model?: string
  /** Model-facing short description (attribution / log only). */
  description: string
  /** The task text the child agent receives (attribution / mirror). */
  prompt: string
  agent_type: CliAgentKind
  /** In-process placeholders, matching vendor `handleSpawnInProcess`. */
  tmux_session_name: 'in-process'
  tmux_window_name: 'in-process'
  tmux_pane_id: 'in-process'
  is_splitpane: false
  /** The live run handle; `run.id` shadows the provider id with `task_id`. */
  run: SubagentRun
}

/**
 * Spawn one CLI agent through the provider registered under `agentType`.
 *
 * The provider's `start` returns immediately (spawn + pump begin on a
 * microtask), matching vendor `spawnTeammate` semantics: this function
 * resolves once the identity + run handle are in hand, before any turn work
 * completes. Throws {@link SubagentError} when the provider isn't registered.
 */
export async function spawnCliAgent(
  args: CliAgentSpawnArgs,
): Promise<CliAgentSpawn> {
  const { agentType, prompt, cwd, model, signal, env } = args
  const agentName = sanitizeAgentName(args.name ?? agentType)
  const description = args.description ?? args.name ?? agentType
  const teamName = args.teamName

  const provider = getSubagentRegistry().getProvider(agentType)
  if (!provider) {
    throw new SubagentError(
      'PROVIDER_NOT_FOUND',
      `subagent registry has no provider named '${agentType}' (registered: ${getSubagentRegistry().list().join(', ') || '∅'})`,
    )
  }

  const req: SubagentRequest = {
    description,
    prompt,
    cwd,
    model,
    signal,
    env,
  }
  const ctx: SubagentContext = { parentCwd: cwd }
  const run: SubagentRun = await provider.start(req, ctx)

  // Vendor-aligned task id is the canonical key for this spawn; shadow the
  // provider's internal run id so mirror*/SSE/notifier all use one id.
  // NOTE: providers never index by `run.id` internally (verified across
  // claude-code / dsh / codex run.ts) — the override is safe. If a provider
  // ever needs its own id, pass it explicitly via the request instead.
  const task_id = generateTaskId('in_process_teammate')
  const carriedRun: SubagentRun = { ...run, id: task_id }

  return {
    status: 'spawned',
    agent_id: teamName ? formatAgentId(agentName, teamName) : defaultCliRunId(agentName),
    task_id,
    name: agentName,
    ...(teamName ? { team_name: teamName } : {}),
    ...(model !== undefined ? { model } : {}),
    description,
    prompt,
    agent_type: agentType,
    tmux_session_name: 'in-process',
    tmux_window_name: 'in-process',
    tmux_pane_id: 'in-process',
    is_splitpane: false,
    run: carriedRun,
  }
}