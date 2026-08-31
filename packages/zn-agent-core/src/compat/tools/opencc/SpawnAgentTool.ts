import { z as z4 } from 'zod/v4'
import { wrapAsOpenccTool } from '../../runtime/openccToolWrap.js'
import {
  getSubagentRegistry,
  type SubagentResult,
} from '../../subagents/registry.js'
import { formatSubagentProviderSection } from '../../subagents/promptSection.js'
import { spawnCliAgent, type CliAgentSpawn } from '../../subagents/cliAgent/spawn.js'
import { publishSpawnToBackground } from '../../subagents/cliAgent/publish.js'

/**
 * SpawnAgent — OPENCC 原生 tool,承载 claude-code / dsh 两个 CLI subagent。
 *
 * 接口参考 vendor `AgentTool`(`opencc-src/tools/AgentTool/AgentTool.tsx`):
 * `description` / `prompt` / `subagent_type` / `model` / `cwd` /
 * `run_in_background` / `name` / `team_name`。与 vendor AgentTool 并存:
 * AgentTool 继续服务内置 agent,`subagent_type: 'claude-code' | 'dsh'`
 * 由本工具路由到 `compat/subagents` registry 的对应 provider。
 *
 * call 内部:
 *   - `subagent_type` → `getSubagentRegistry().getProvider(...)`,缺失抛
 *     PROVIDER_NOT_FOUND(错误信息含注册列表,对齐 registry.startProvider);
 *   - 调 `spawnCliAgent` 拿可寻址身份(agent_id/task_id)+ run 句柄;
 *   - `run_in_background: true` → `publishSpawnToBackground` fire-and-forget,
 *     立即返回 `{ status: 'async_launched', task_id, ... }`;
 *   - 同步 → 等待 `run.result` settle 后返回
 *     `{ status: 'completed', text, stopReason, ... }`。
 *
 * description 动态合成:base + `formatSubagentProviderSection(registry)`,
 * 已注册的 provider(claude-code/dsh)对模型可见。
 *
 * 不用 `makeTool`:它把 `description` 钉成静态 string,而 SpawnAgent 需要
 * 动态注入 provider 列表(每次 description()/prompt() 调用时
 * `getSubagentRegistry()` 可能已变 — zai 在 initAgentRuntime 才注册)。
 */
const SpawnAgentInputV4 = z4.object({
  /** Model-facing short label (3-5 words). */
  description: z4.string(),
  /** The task text the CLI subagent receives. */
  prompt: z4.string(),
  /**
   * Which provider to spawn. Only registry-registered CLI agents
   * (`claude-code` / `dsh`) route here; the description lists what's live.
   */
  subagent_type: z4.string().describe(
    'Which CLI subagent provider to spawn. Use a registered external subagent provider (see the provider list in the tool description) — `claude-code` / `dsh`.',
  ),
  /** Optional model override; providers may ignore. */
  model: z4.string().optional(),
  /** Absolute cwd override; falls back to the parent session cwd. */
  cwd: z4
    .string()
    .describe('Absolute path to run the agent in. Defaults to the parent session cwd.')
    .optional(),
  /** Run in the background and return immediately with a task_id. */
  run_in_background: z4.boolean().optional(),
  /** Optional addressable name (mirrors AgentTool `name`). */
  name: z4.string().optional(),
  /** Optional team name — makes agent_id `name@team` (mirrors AgentTool `team_name`). */
  team_name: z4.string().optional(),
})

type SpawnAgentInput = z4.infer<typeof SpawnAgentInputV4>

const SpawnAgentBaseDescription =
  'Spawn a CLI subagent to delegate a standalone task to an external agent engine ' +
  '(claude-code CLI or dsh / DeepSeek Harness SDK runtime). Each runs as an ' +
  'independent process in its own context and inherits no parent conversation. ' +
  'Choose the engine via `subagent_type`; give it a complete, self-contained prompt ' +
  'because it cannot see this conversation. Use `run_in_background: true` to return ' +
  'a task_id immediately and be notified on completion.'

function buildDescription(): string {
  const section = formatSubagentProviderSection(getSubagentRegistry())
  return (
    SpawnAgentBaseDescription +
    (section
      ? '\n\n' + section
      : '\n\n(no external subagent providers are registered at this time)')
  )
}

/** Manual tool object — function description + zod/v4 inputSchema + call. */
export const spawnAgentTool = {
  name: 'SpawnAgent',
  description: buildDescription,
  inputSchema: SpawnAgentInputV4,
  async call(args: unknown, ctx: unknown): Promise<unknown> {
    const parsed = SpawnAgentInputV4.safeParse(args)
    if (!parsed.success) {
      return {
        output: `[error] invalid input for SpawnAgent: ${parsed.error.issues
          .map((i) => `${i.path.join('.')}: ${i.message}`)
          .join('; ')}`,
      }
    }
    return executeSpawn(parsed.data, ctx)
  },
}

async function executeSpawn(
  args: SpawnAgentInput,
  ctx: unknown,
): Promise<unknown> {
  const {
    description,
    prompt,
    subagent_type,
    model,
    cwd,
    run_in_background,
    name,
    team_name,
  } = args

  const registry = getSubagentRegistry()
  const provider = registry.getProvider(subagent_type)
  if (!provider) {
    const message =
      `SpawnAgent: no subagent provider named '${subagent_type}'. ` +
      `Registered: ${registry.list().join(', ') || '∅'} — route via ` +
      `subagent_type: 'claude-code' | 'dsh' (or whichever are registered).`
    throw new Error(message)
  }

  const spawn = await spawnCliAgent({
    name,
    agentType: subagent_type as 'claude-code' | 'dsh',
    prompt,
    description,
    teamName: team_name,
    cwd,
    model,
    signal: (ctx as { abortSignal?: AbortSignal }).abortSignal,
  })

  if (run_in_background === true) {
    // Publish to the background task surface (SSE dock) and return
    // immediately — the run continues; caller polls/controls via task_id.
    void publishSpawnToBackground(spawn, {
      parentSessionId: readZaiCurrentSessionIdBridge(),
    })
    return {
      output: formatAsyncLaunched(spawn),
      status: 'async_launched' as const,
      agentId: spawn.task_id,
      task_id: spawn.task_id,
      agent_id: spawn.agent_id,
      description,
      prompt,
    }
  }

  // Sync path: attach the mirror surface, then wait for settle.
  void publishSpawnToBackground(spawn, {
    parentSessionId: readZaiCurrentSessionIdBridge(),
  })
  const result = await spawn.run.result
  return {
    output: formatCompleted(spawn, result),
    status: 'completed' as const,
    agentId: spawn.task_id,
    agentType: spawn.agent_type,
    prompt,
    text: result.stopReason === 'completed' ? result.text : '',
    stopReason: result.stopReason,
    ...(result.errorMessage !== undefined ? { errorMessage: result.errorMessage } : {}),
  }
}

/**
 * Build the opencc ctx → zai ToolCallCtx transform. Mirrors SkillTool.ts
 * (SkillBridgeContext): inject sessionId + abortSignal. `abortSignal` maps
 * to the caller's AbortSignal so cancelling the parent query cancels the
 * spawned CLI agent (via spawnCliAgent → SubagentRequest.signal).
 */
function buildSpawnTransformCtx() {
  return (openccCtx: unknown) => {
    const o = openccCtx as {
      sessionId?: string
      abortController?: { signal?: AbortSignal }
    }
    return {
      ...o,
      sessionId: o?.sessionId,
      abortSignal: o?.abortController?.signal,
    }
  }
}

/** Read the parent session id via the zai globalThis bridge (best-effort). */
function readZaiCurrentSessionIdBridge(): string | undefined {
  const v = (globalThis as { __zaiCurrentSessionId?: string | null }).__zaiCurrentSessionId
  return typeof v === 'string' && v.length > 0 ? v : undefined
}

function formatAsyncLaunched(spawn: CliAgentSpawn): string {
  return [
    `Spawned ${spawn.agent_type} subagent in the background.`,
    `agent_id: ${spawn.agent_id}`,
    `task_id: ${spawn.task_id}`,
    `name: ${spawn.name}`,
  ].join('\n')
}

function formatCompleted(spawn: CliAgentSpawn, result: SubagentResult): string {
  const lines = [
    `${spawn.agent_type} subagent completed (${result.stopReason}).`,
    `agent_id: ${spawn.agent_id}`,
  ]
  if (result.stopReason === 'completed' && result.text) {
    lines.push('', result.text)
  } else if (result.errorMessage) {
    lines.push('', `error: ${result.errorMessage}`)
  }
  return lines.join('\n')
}

/**
 * Wrap SpawnAgent as an opencc-compatible Tool so vendor's `query()` can
 * call it. Registered in `getOpenccBuiltinTools()` (compat/tools/opencc/
 * builtin.ts) alongside AskUserQuestion / Skill wrappers. Reads the
 * registry + session bridge at CALL time (globalThis), so the cached
 * wrapper stays correct across concurrent sessions.
 */
export function wrapSpawnAgentToolAsOpencc(): unknown {
  return wrapAsOpenccTool(spawnAgentTool as never, {
    transformCtx: buildSpawnTransformCtx(),
  })
}