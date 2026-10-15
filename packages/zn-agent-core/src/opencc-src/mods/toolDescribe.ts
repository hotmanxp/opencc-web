import type { AgentDefinition } from '../tools/AgentTool/loadAgentsDir.js'
import type { Tool, ToolPermissionContext, Tools } from '../Tool.js'
import {
  getToolDescribeAnswer,
  invalidateToolSchema,
  setToolDescribeAnswer,
} from '../utils/toolSchemaCache.js'
import { dispatchModEngineResult, hasModHandlersFor } from './dispatch.js'

/** Upstream `ToolDescribeResult` (d.ts:3465) — `{description, isDeferred?}`. */
export type ToolDescribeAnswer = {
  tool: string
  description: string
  isDeferred: boolean
}

/** What a hook may narrow on: upstream `ToolDescribeInput`, minus the answers. */
export type ToolDescribePayload = {
  tool: string
  description: string
  /**
   * Upstream's `Origin` (d.ts:10005), narrowed to what this host can honestly
   * say. It used to be `t.source ?? 'built-in'` — a field no tool carries, so
   * every tool reported the same string, including MCP ones. Upstream spells an
   * MCP tool's origin `mcp:<server>`; the server name lives on the MCP
   * connection here, not on the Tool, so that half is not answerable and the
   * kind is given instead of a fabricated name.
   */
  provider: { plugin: 'engine'; tier: 'core' } | { kind: 'mcp' }
  isDeferred: boolean
}

type PromptOptions = {
  getToolPermissionContext: () => Promise<ToolPermissionContext>
  agents: AgentDefinition[]
  allowedAgentTypes?: string[]
}

/**
 * Upstream `tool.describe` (d.ts:3462) — "Fires once per tool, when the engine
 * first renders the tool's schema in a session; `next(e)` resolves to
 * `{description, isDeferred?}`".
 *
 * Two answers, and the host has to place each one somewhere different:
 *
 *   `description` goes into the tool schema the model reads, which
 *   `toolToAPISchema` memoizes per session — so it is handed back here as a
 *   map and passed in, rather than written onto the tool: the text the model
 *   gets is `await tool.prompt(...)`, NOT `tool.description` (which most tools
 *   do not have), so mutating a field would reach nothing.
 *
 *   `isDeferred` moves a tool behind ToolSearch, which `claude.ts` decides
 *   BEFORE it filters and serializes tools — so it has to be answered here,
 *   which is why the dispatch lives here and not inside `toolToAPISchema`.
 *
 * The description is rendered at most once per session per tool and kept
 * alongside the chain's answer, so a hook that returns the same text every
 * request costs no re-render and — the reason the answer is remembered at all
 * — does not bust the schema cache. Upstream says the same about the cost:
 * "an unstable answer spends the model's prompt cache on every call".
 */
export async function resolveToolDescriptions(params: {
  tools: Tools
  promptOptions: PromptOptions
  isDeferredByHost: (name: string) => boolean
}): Promise<{
  deferred: Set<string>
  descriptions: Map<string, string>
}> {
  const deferred = new Set<string>()
  const descriptions = new Map<string, string>()
  if (!hasModHandlersFor('tool.describe')) return { deferred, descriptions }

  const { tools, promptOptions, isDeferredByHost } = params
  for (const tool of tools) {
    // Upstream gates per tool, not per session: `Jl("tool.describe", {tool:
    // e.name})` (bundle @10911854). Without this the loop below builds a
    // payload, awaits the tool's own `prompt()`, and dispatches for every tool
    // in the session — including for a mod whose matcher names one tool, which
    // is the expensive case the gate exists for.
    if (!hasModHandlersFor('tool.describe', { tool: tool.name })) continue

    const prior = getToolDescribeAnswer(tool.name)
    // The chain is shown the text the model would otherwise read, which is the
    // one already resolved for this session — not `tool.description`, which is
    // undefined for the built-in tools and so handed the hook an empty string
    // to "rewrite".
    const base =
      prior?.base ??
      (await tool.prompt({
        getToolPermissionContext: promptOptions.getToolPermissionContext,
        tools,
        agents: promptOptions.agents,
        allowedAgentTypes: promptOptions.allowedAgentTypes,
      }))

    const hostIsDeferred = isDeferredByHost(tool.name)
    const payload: ToolDescribePayload = {
      tool: tool.name,
      description: base,
      provider: tool.isMcp ? { kind: 'mcp' } : { plugin: 'engine', tier: 'core' },
      isDeferred: hostIsDeferred,
    }
    const answer = await dispatchModEngineResult<ToolDescribeAnswer>(
      'tool.describe',
      payload as unknown as Record<string, unknown>,
      e => ({
        tool: String(e.tool ?? tool.name),
        description: typeof e.description === 'string' ? e.description : base,
        isDeferred: e.isDeferred === true,
      }),
    )

    if (answer.description !== prior?.answer) {
      setToolDescribeAnswer(tool.name, { base, answer: answer.description })
      // The memoized schema still holds the previous text. Dropping just this
      // tool's entry — not the whole cache — is what makes the rewrite reach
      // the wire on this request instead of from the next session onwards.
      invalidateToolSchema(tool.name)
    }
    descriptions.set(tool.name, answer.description)
    if (answer.isDeferred) deferred.add(answer.tool)
  }
  return { deferred, descriptions }
}