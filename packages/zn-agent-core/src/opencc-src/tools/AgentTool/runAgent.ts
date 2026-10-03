// @ts-nocheck
import { AGENT_INSTRUCTIONS_FILE } from '../../constants/product.js'
import type { UUID } from 'crypto'
import { randomUUID } from 'crypto'
import uniqBy from 'lodash-es/uniqBy.js'
import { logForDebugging } from 'src/utils/debug.js'
import { getProjectRoot, getSessionId } from '../../bootstrap/state.js'
import { getCommand, getSkillToolCommands, hasCommand } from '../../commands.js'
import {
  DEFAULT_AGENT_PROMPT,
  enhanceSystemPromptWithEnvDetails,
} from '../../constants/prompts.js'
import type { QuerySource } from '../../constants/querySource.js'
import { getSystemContext, getUserContext } from '../../context.js'
import type { CanUseToolFn } from '../../hooks/useCanUseTool.js'
import { query } from '../../query.js'
import type { Terminal } from '../../query/transitions.js'
import { getFeatureValue_CACHED_MAY_BE_STALE } from '../../services/analytics/growthbook.js'
import { getDumpPromptsPath } from '../../services/api/dumpPrompts.js'
import { cleanupAgentTracking } from '../../services/api/promptCacheBreakDetection.js'
import {
  connectToServer,
  fetchToolsForClient,
} from '../../services/mcp/client.js'
import { getMcpConfigByName } from '../../services/mcp/config.js'
import type {
  MCPServerConnection,
  ScopedMcpServerConfig,
} from '../../services/mcp/types.js'
import type { Tool, Tools, ToolUseContext } from '../../Tool.js'
import { killShellTasksForAgent } from '../../tasks/LocalShellTask/killShellTasks.js'
import type { Command } from '../../types/command.js'
import type { AgentId } from '../../types/ids.js'
import type {
  AssistantMessage,
  Message,
  ProgressMessage,
  RequestStartEvent,
  StreamEvent,
  SystemCompactBoundaryMessage,
  TombstoneMessage,
  ToolUseSummaryMessage,
  UserMessage,
} from '../../types/message.js'
import { createAttachmentMessage } from '../../utils/attachments.js'
import { AbortError } from '../../utils/errors.js'
import { getDisplayPath } from '../../utils/file.js'
import {
  cloneFileStateCache,
  createFileStateCacheWithSizeLimit,
  READ_FILE_STATE_CACHE_SIZE,
} from '../../utils/fileStateCache.js'
import {
  type CacheSafeParams,
  createSubagentContext,
} from '../../utils/forkedAgent.js'
import { registerFrontmatterHooks } from '../../utils/hooks/registerFrontmatterHooks.js'
import { clearSessionHooks } from '../../utils/hooks/sessionHooks.js'
import { executeSubagentStartHooks } from '../../utils/hooks.js'
import { createUserMessage } from '../../utils/messages.js'
import { getAgentModel } from '../../utils/model/agent.js'
import { isModelAllowed } from '../../utils/model/modelAllowlist.js'
import { resolveAgentRunModelRouting, shouldEnforceModelAllowlist } from '../../services/api/agentRouting.js'
import { getInitialSettings } from '../../utils/settings/settings.js'
import type { ModelAlias } from '../../utils/model/aliases.js'
import {
  withUltracodePrompt,
  withUltracodeReminder,
} from '../../utils/ultracodePrompt.js'
import {
  clearAgentTranscriptSubdir,
  recordSidechainTranscript,
  setAgentTranscriptSubdir,
  writeAgentMetadata,
  readAgentMetadata,
  type AgentMetadata,
} from '../../utils/sessionStorage.js'
import {
  isRestrictedToPluginOnly,
  isSourceAdminTrusted,
} from '../../utils/settings/pluginOnlyPolicy.js'
import {
  asSystemPrompt,
  type SystemPrompt,
} from '../../utils/systemPromptType.js'
import {
  isPerfettoTracingEnabled,
  registerAgent as registerPerfettoAgent,
  unregisterAgent as unregisterPerfettoAgent,
} from '../../utils/telemetry/perfettoTracing.js'
import type { ContentReplacementState } from '../../utils/toolResultStorage.js'
import { createAgentId } from '../../utils/uuid.js'
import { resolveAgentTools } from './agentToolUtils.js'
import { type AgentDefinition, isBuiltInAgent } from './loadAgentsDir.js'

/**
 * Initialize agent-specific MCP servers
 * Agents can define their own MCP servers in their frontmatter that are additive
 * to the parent's MCP clients. These servers are connected when the agent starts
 * and cleaned up when the agent finishes.
 *
 * @param agentDefinition The agent definition with optional mcpServers
 * @param parentClients MCP clients inherited from parent context
 * @returns Merged clients (parent + agent-specific), agent MCP tools, and cleanup function
 */
async function initializeAgentMcpServers(
  agentDefinition: AgentDefinition,
  parentClients: MCPServerConnection[],
  onMcpServersBlocked?: (info: unknown) => void,
): Promise<{
  clients: MCPServerConnection[]
  tools: Tools
  cleanup: () => Promise<void>
}> {
  // If no agent-specific servers defined, return parent clients as-is
  if (!agentDefinition.mcpServers?.length) {
    return {
      clients: parentClients,
      tools: [],
      cleanup: async () => {},
    }
  }

  // When MCP is locked to plugin-only, skip frontmatter MCP servers for
  // USER-CONTROLLED agents only. Plugin, built-in, and policySettings agents
  // are admin-trusted — their frontmatter MCP is part of the admin-approved
  // surface. Blocking them (as the first cut did) breaks plugin agents that
  // legitimately need MCP, contradicting "plugin-provided always loads."
  const agentIsAdminTrusted = isSourceAdminTrusted(agentDefinition.source)
  if (isRestrictedToPluginOnly('mcp') && !agentIsAdminTrusted) {
    logForDebugging(
      `[Agent: ${agentDefinition.agentType}] Skipping MCP servers: strictPluginOnlyCustomization locks MCP to plugin-only (agent source: ${agentDefinition.source})`,
    )
    // (G) Fire telemetry for dropped MCP servers. opencc does not currently
    // expose mcpServerPolicy enforcement here, but when an external policy
    // gate drops servers, surface the event for callers (e.g. Workflow UI).
    onMcpServersBlocked?.({
      agentType: agentDefinition.agentType,
      reason: 'plugin-only-policy',
      requestedServers: agentDefinition.mcpServers ?? [],
    })
    return {
      clients: parentClients,
      tools: [],
      cleanup: async () => {},
    }
  }

  const agentClients: MCPServerConnection[] = []
  // Track which clients were newly created (inline definitions) vs. shared from parent
  // Only newly created clients should be cleaned up when the agent finishes
  const newlyCreatedClients: MCPServerConnection[] = []
  const agentTools: Tool[] = []

  for (const spec of agentDefinition.mcpServers) {
    let config: ScopedMcpServerConfig | null = null
    let name: string
    let isNewlyCreated = false

    if (typeof spec === 'string') {
      // Reference by name - look up in existing MCP configs
      // This uses the memoized connectToServer, so we may get a shared client
      name = spec
      config = getMcpConfigByName(spec)
      if (!config) {
        logForDebugging(
          `[Agent: ${agentDefinition.agentType}] MCP server not found: ${spec}`,
          { level: 'warn' },
        )
        continue
      }
    } else {
      // Inline definition as { [name]: config }
      // These are agent-specific servers that should be cleaned up
      const entries = Object.entries(spec)
      if (entries.length !== 1) {
        logForDebugging(
          `[Agent: ${agentDefinition.agentType}] Invalid MCP server spec: expected exactly one key`,
          { level: 'warn' },
        )
        continue
      }
      const [serverName, serverConfig] = entries[0]!
      name = serverName
      config = {
        ...serverConfig,
        scope: 'dynamic' as const,
      } as ScopedMcpServerConfig
      isNewlyCreated = true
    }

    // Connect to the server
    const client = await connectToServer(name, config)
    agentClients.push(client)
    if (isNewlyCreated) {
      newlyCreatedClients.push(client)
    }

    // Fetch tools if connected
    if (client.type === 'connected') {
      const tools = await fetchToolsForClient(client)
      agentTools.push(...tools)
      logForDebugging(
        `[Agent: ${agentDefinition.agentType}] Connected to MCP server '${name}' with ${tools.length} tools`,
      )
    } else {
      logForDebugging(
        `[Agent: ${agentDefinition.agentType}] Failed to connect to MCP server '${name}': ${client.type}`,
        { level: 'warn' },
      )
    }
  }

  // Create cleanup function for agent-specific servers
  // Only clean up newly created clients (inline definitions), not shared/referenced ones
  // Shared clients (referenced by string name) are memoized and used by the parent context
  const cleanup = async () => {
    for (const client of newlyCreatedClients) {
      if (client.type === 'connected') {
        try {
          await client.cleanup()
        } catch (error) {
          logForDebugging(
            `[Agent: ${agentDefinition.agentType}] Error cleaning up MCP server '${client.name}': ${error}`,
            { level: 'warn' },
          )
        }
      }
    }
  }

  // Return merged clients (parent + agent-specific) and agent tools
  return {
    clients: [...parentClients, ...agentClients],
    tools: agentTools,
    cleanup,
  }
}

type QueryMessage =
  | StreamEvent
  | RequestStartEvent
  | Message
  | ToolUseSummaryMessage
  | TombstoneMessage

/**
 * Type guard to check if a message from query() is a recordable Message type.
 * Matches the types we want to record: assistant, user, progress, or system compact_boundary.
 */
function isRecordableMessage(
  msg: QueryMessage,
): msg is
  | AssistantMessage
  | UserMessage
  | ProgressMessage
  | SystemCompactBoundaryMessage {
  return (
    msg.type === 'assistant' ||
    msg.type === 'user' ||
    msg.type === 'progress' ||
    (msg.type === 'system' &&
      'subtype' in msg &&
      msg.subtype === 'compact_boundary')
  )
}

export async function* runAgent({
  agentDefinition,
  promptMessages,
  toolUseContext,
  canUseTool,
  isAsync,
  canShowPermissionPrompts,
  forkContextMessages,
  querySource,
  override,
  model,
  maxTurns,
  maxSteps,
  preserveToolUseResults,
  availableTools,
  allowedTools,
  onCacheSafeParams,
  contentReplacementState,
  useExactTools,
  worktreePath,
  cwd,
  description,
  transcriptSubdir,
  onQueryProgress,
  agentName,
  routingSubagentType,
  // --- new module 1551 params (all optional, additive) ---
  requestShape,
  requestNonInteractive,
  webFetchReadmissionAllowed,
  persistedToolResultFiles,
  stickyBetas,
  worktreeBranch,
  session,
  spawnMode,
  name,
  toolUseId,
  spawnedBySkill,
  spawnedByForkedSkill,
  forkOrigin,
  spawnedByWorkflowRunId,
  workflowPhase,
  onStreamTokenEstimate,
  onMcpServersBlocked,
  onModelRestricted,
  isTeammate,
  teammateContext,
  recordedUuids,
  extraMetadata,
  requiresStructuredOutput,
  handbackOptIn,
  handbackTool,
}: {
  agentDefinition: AgentDefinition
  promptMessages: Message[]
  toolUseContext: ToolUseContext
  canUseTool: CanUseToolFn
  isAsync: boolean
  /** Whether this agent can show permission prompts. Defaults to !isAsync.
   * Set to true for in-process teammates that run async but share the terminal. */
  canShowPermissionPrompts?: boolean
  forkContextMessages?: Message[]
  querySource: QuerySource
  override?: {
    userContext?: { [k: string]: string }
    systemContext?: { [k: string]: string }
    systemPrompt?: SystemPrompt
    abortController?: AbortController
    agentId?: AgentId
  }
  model?: ModelAlias
  maxTurns?: number
  maxSteps?: number
  /** Preserve toolUseResult on messages for subagents with viewable transcripts */
  preserveToolUseResults?: boolean
  /** Precomputed tool pool for the worker agent. Computed by the caller
   * (AgentTool.tsx) to avoid a circular dependency between runAgent and tools.ts.
   * Always contains the full tool pool assembled with the worker's own permission
   * mode, independent of the parent's tool restrictions. */
  availableTools: Tools
  /** Tool permission rules to add to the agent's session allow rules.
   * When provided, replaces ALL allow rules so the agent only has what's
   * explicitly listed (parent approvals don't leak through). */
  allowedTools?: string[]
  /** Optional callback invoked with CacheSafeParams after constructing the agent's
   * system prompt, context, and tools. Used by background summarization to fork
   * the agent's conversation for periodic progress summaries. */
  onCacheSafeParams?: (params: CacheSafeParams) => void
  /** Replacement state reconstructed from a resumed sidechain transcript so
   * the same tool results are re-replaced (prompt cache stability). When
   * omitted, createSubagentContext clones the parent's state. */
  contentReplacementState?: ContentReplacementState
  /** When true, use availableTools directly without filtering through
   * resolveAgentTools(). Also inherits the parent's thinkingConfig and
   * isNonInteractiveSession instead of overriding them. Used by the fork
   * subagent path to produce byte-identical API request prefixes for
   * prompt cache hits. */
  useExactTools?: boolean
  /** Worktree path if the agent was spawned with isolation: "worktree".
   * Persisted to metadata so resume can restore the correct cwd. */
  worktreePath?: string
  /** Explicit cwd override for the agent's working directory. Persisted for
   * resume even when a worktree exists, so multi-repo parent sessions can
   * fall back to the child-repo path after worktree cleanup. */
  cwd?: string
  /** Original task description from AgentTool input. Persisted to metadata
   * so a resumed agent's notification can show the original description. */
  description?: string
  /** Optional subdirectory under subagents/ to group this agent's transcript
   * with related ones (e.g. workflows/<runId> for workflow subagents). */
  transcriptSubdir?: string
  /** Optional callback fired on every message yielded by query() — including
   * stream_event deltas that runAgent otherwise drops. Use to detect liveness
   * during long single-block streams (e.g. thinking) where no assistant
   * message is yielded for >60s. */
  onQueryProgress?: () => void
  /** Agent name (team member name) for routing resolution */
  agentName?: string
  /** Routing key for per-agent provider resolution. In-process teammates build a
   *  synthetic agentDefinition whose agentType is the teammate's display name,
   *  which drops the original subagent_type that agentRouting is keyed on. Pass
   *  the original subagent_type here so the configured route still resolves. */
  routingSubagentType?: string
  // --- new module 1551 params (upstream module 1551 / 2.1.287) ---
  /** API request shape — defaults to `isAsync ? 'background' : 'foreground'`. */
  requestShape?: 'foreground' | 'background'
  /** Explicit `isNonInteractiveSession` hint for the request. */
  requestNonInteractive?: boolean
  /** Allows web fetch tool back in when normally gated. Passed through to
   * `resolveAgentTools`. opencc does not currently gate web fetch — kept
   * as a forward-compat pass-through. */
  webFetchReadmissionAllowed?: boolean
  /** List of file paths whose tool result content is persisted on the
   * agent context. opencc does not persist tool results; kept as a field
   * for parity — assigned to the subagent context when provided. */
  persistedToolResultFiles?: string[]
  /** Pre-resolved beta configuration for the request; bypasses auto-decide
   * inside runAgent. opencc does not have a beta-resolution ladder — kept
   * for parity, currently no-op until betas land. */
  stickyBetas?: unknown
  /** Branch the worktree was checked out at. Persisted to metadata for
   * resume / cleanup. */
  worktreeBranch?: string
  /** Explicit session override (default = parent's session). opencc does
   * not currently consume a session override inside runAgent — kept for
   * parity. */
  session?: unknown
  /** Permission mode override at spawn (vs. agent definition's
   * `permissionMode`). opencc does not have a separate `spawnMode` field;
   * kept for parity. */
  spawnMode?: unknown
  /** Agent name override for routing/UI; persisted in metadata. */
  name?: string
  /** The parent's tool-use ID this subagent was spawned from. Used by
   * progress forwarding to attach to `parentToolUseID`. */
  toolUseId?: string
  /** Name of the skill that triggered the spawn. */
  spawnedBySkill?: string
  /** Name of the forked-skill spawn chain (if applicable). */
  spawnedByForkedSkill?: string
  /** Origin marker on the query (`'tool' | 'skill' | ...`). */
  forkOrigin?: string
  /** Workflow run id linking the subagent to a workflow (workflow subagents). */
  spawnedByWorkflowRunId?: string
  /** Current phase the workflow is in when spawning this subagent.
   * Persisted to metadata. */
  workflowPhase?: string
  /** Token-rate callback fired during the stream so the UI spinner can
   * show live output. opencc does not currently wire this — kept as a
   * param. */
  onStreamTokenEstimate?: (
    e:
      | { type: 'tokens'; estimatedTokensDelta: number }
      | { type: 'response_start' },
  ) => void
  /** Telemetry callback for when MCP servers were dropped. opencc's
   * `initializeAgentMcpServers` does not currently report this — kept as
   * a param. */
  onMcpServersBlocked?: (info: unknown) => void
  /** Telemetry callback for when the requested model was restricted. */
  onModelRestricted?: (info: unknown) => void
  /** Hint that this is a teammate — changes model resolution and memory
   * caller. Defaults to false. */
  isTeammate?: boolean
  /** Forwarded into the subagent's tool use context (backgrounded /
   * foregrounded teammate shape). opencc does not currently forward
   * teammateContext into `createSubagentContext` — kept for parity. */
  teammateContext?: unknown
  /** Set of UUIDs the resume caller has already recorded — used to slice
   * messages for re-recording and avoid duplicates. */
  recordedUuids?: Set<UUID>
  /** Extra fields merged into persisted `AgentMetadata`. */
  extraMetadata?: Record<string, unknown>
  /** When true, the agent is required to emit a structured output via
   * the `StructuredOutput` tool. */
  requiresStructuredOutput?: boolean
  /** When true, this subagent may opt in to the hand-back contract with
   * its caller. opencc does not have a handback system — kept as a
   * param. */
  handbackOptIn?: boolean
  /** The hand-back tool to register when `handbackOptIn` is active.
   * opencc does not have a handback system — kept as a param. */
  handbackTool?: unknown
}): AsyncGenerator<Message, void> {
  // Track subagent usage for feature discovery

  const appState = toolUseContext.getAppState()
  const permissionMode = appState.toolPermissionContext.mode
  // Always-shared channel to the root AppState store. toolUseContext.setAppState
  // is a no-op when the *parent* is itself an async agent (nested async→async),
  // so session-scoped writes (hooks, bash tasks) must go through this instead.
  const rootSetAppState =
    toolUseContext.setAppStateForTasks ?? toolUseContext.setAppState

  const resolvedAgentModel = getAgentModel(
    agentDefinition.model,
    toolUseContext.options.mainLoopModel,
    model,
    permissionMode,
  )

  // Resolve per-agent provider routing from settings
  const settings = getInitialSettings()

  const { mainLoopModel: effectiveModel, providerOverride } =
    resolveAgentRunModelRouting({
      resolvedAgentModel,
      parentModel: toolUseContext.options.mainLoopModel,
      toolSpecifiedModel: model,
      agentName,
      subagentType: routingSubagentType ?? agentDefinition.agentType,
      agentDefinitionModel: agentDefinition.model,
      settings,
      permissionMode,
    })

  if (
    shouldEnforceModelAllowlist(
      resolvedAgentModel,
      effectiveModel,
      providerOverride !== undefined,
    ) &&
    !isModelAllowed(effectiveModel)
  ) {
    throw new Error(
      `Model '${effectiveModel}' is not available. Your organization restricts model selection.`,
    )
  }

  const agentId = override?.agentId ? override.agentId : createAgentId()

  // Route this agent's transcript into a grouping subdirectory if requested
  // (e.g. workflow subagents write to subagents/workflows/<runId>/).
  if (transcriptSubdir) {
    setAgentTranscriptSubdir(agentId, transcriptSubdir)
  }

  // Register agent in Perfetto trace for hierarchy visualization
  if (isPerfettoTracingEnabled()) {
    const parentId = toolUseContext.agentId ?? getSessionId()
    registerPerfettoAgent(agentId, agentDefinition.agentType, parentId)
  }

  // Log API calls path for subagents (internal-only)
  if (process.env.USER_TYPE === 'ant') {
    logForDebugging(
      `[Subagent ${agentDefinition.agentType}] API calls: ${getDisplayPath(getDumpPromptsPath(agentId))}`,
    )
  }

  // Handle message forking for context sharing
  // Filter out incomplete tool calls from parent messages to avoid API errors
  const contextMessages: Message[] = forkContextMessages
    ? filterIncompleteToolCalls(forkContextMessages)
    : []
  const initialMessages: Message[] = [...contextMessages, ...promptMessages]

  const agentReadFileState =
    forkContextMessages !== undefined
      ? cloneFileStateCache(toolUseContext.readFileState)
      : createFileStateCacheWithSizeLimit(READ_FILE_STATE_CACHE_SIZE)

  const [baseUserContext, baseSystemContext] = await Promise.all([
    override?.userContext ?? getUserContext(),
    override?.systemContext ?? getSystemContext(),
  ])

  // Read-only agents (Explore, Plan) don't act on commit/PR/lint rules from
  // AGENTS.md — the main agent has full context and interprets their output.
  // Dropping claudeMd here saves ~5-15 Gtok/week across 34M+ Explore spawns.
  // Explicit override.userContext from callers is preserved untouched.
  // Kill-switch defaults true; flip tengu_slim_subagent_claudemd=false to revert.
  const shouldOmitClaudeMd =
    agentDefinition.omitClaudeMd &&
    !override?.userContext &&
    getFeatureValue_CACHED_MAY_BE_STALE('tengu_slim_subagent_claudemd', true)
  const { claudeMd: _omittedClaudeMd, ...userContextNoClaudeMd } =
    baseUserContext
  const resolvedUserContext = shouldOmitClaudeMd
    ? userContextNoClaudeMd
    : baseUserContext

  // Explore/Plan are read-only search agents — the parent-session-start
  // gitStatus (up to 40KB, explicitly labeled stale) is dead weight. If they
  // need git info they run `git status` themselves and get fresh data.
  // Saves ~1-3 Gtok/week fleet-wide.
  const { gitStatus: _omittedGitStatus, ...systemContextNoGit } =
    baseSystemContext
  const resolvedSystemContext =
    agentDefinition.agentType === 'Explore' ||
    agentDefinition.agentType === 'Plan'
      ? systemContextNoGit
      : baseSystemContext

  // Override permission mode if agent defines one
  // However, don't override if parent is in bypassPermissions or acceptEdits mode - those should always take precedence
  // For async agents, also set shouldAvoidPermissionPrompts since they can't show UI
  const agentPermissionMode = agentDefinition.permissionMode
  const agentGetAppState = () => {
    const state = toolUseContext.getAppState()
    let toolPermissionContext = state.toolPermissionContext

    // Override permission mode if agent defines one (unless parent is bypassPermissions, acceptEdits, or auto)
    if (
      agentPermissionMode &&
      state.toolPermissionContext.mode !== 'bypassPermissions' &&
      state.toolPermissionContext.mode !== 'acceptEdits' &&
      !(
        state.toolPermissionContext.mode === 'auto'
      )
    ) {
      toolPermissionContext = {
        ...toolPermissionContext,
        mode: agentPermissionMode,
      }
    }

    // Set flag to auto-deny prompts for agents that can't show UI
    // Use explicit canShowPermissionPrompts if provided, otherwise:
    //   - bubble mode: always show prompts (bubbles to parent terminal)
    //   - default: !isAsync (sync agents show prompts, async agents don't)
    const shouldAvoidPrompts =
      canShowPermissionPrompts !== undefined
        ? !canShowPermissionPrompts
        : agentPermissionMode === 'bubble'
          ? false
          : isAsync
    if (shouldAvoidPrompts) {
      toolPermissionContext = {
        ...toolPermissionContext,
        shouldAvoidPermissionPrompts: true,
      }
    }

    // For background agents that can show prompts, await automated checks
    // (classifier, permission hooks) before showing the permission dialog.
    // Since these are background agents, waiting is fine — the user should
    // only be interrupted when automated checks can't resolve the permission.
    // This applies to bubble mode (always) and explicit canShowPermissionPrompts.
    if (isAsync && !shouldAvoidPrompts) {
      toolPermissionContext = {
        ...toolPermissionContext,
        awaitAutomatedChecksBeforeDialog: true,
      }
    }

    // Scope tool permissions: when allowedTools is provided, use them as session rules.
    // IMPORTANT: Preserve cliArg rules (from SDK's --allowedTools) since those are
    // explicit permissions from the SDK consumer that should apply to all agents.
    // Only clear session-level rules from the parent to prevent unintended leakage.
    if (allowedTools !== undefined) {
      toolPermissionContext = {
        ...toolPermissionContext,
        alwaysAllowRules: {
          // Preserve SDK-level permissions from --allowedTools
          cliArg: state.toolPermissionContext.alwaysAllowRules.cliArg,
          // Preserve parent mcpServerPolicy if present (forward-compat — opencc
          // doesn't read this today but upstream module 1551 threads it
          // through so resuming subagents keep MCP gating).
          ...(state.toolPermissionContext.alwaysAllowRules as {
            mcpServerPolicy?: unknown
          }).mcpServerPolicy
            ? {
                mcpServerPolicy: (state.toolPermissionContext.alwaysAllowRules as {
                  mcpServerPolicy?: unknown
                }).mcpServerPolicy,
              }
            : {},
          // Use the provided allowedTools as session-level permissions
          session: [...allowedTools],
        },
      }
    }

    // Override effort level if agent defines one
    const effortValue =
      agentDefinition.effort !== undefined
        ? agentDefinition.effort
        : state.effortValue

    const modelStateChanged =
      state.mainLoopModel !== effectiveModel ||
      state.mainLoopModelForSession !== effectiveModel

    if (
      toolPermissionContext === state.toolPermissionContext &&
      effortValue === state.effortValue &&
      !modelStateChanged
    ) {
      return state
    }
    return {
      ...state,
      mainLoopModel: effectiveModel,
      mainLoopModelForSession: effectiveModel,
      toolPermissionContext,
      effortValue,
    }
  }

  const resolvedTools = useExactTools
    ? availableTools
    : resolveAgentTools(agentDefinition, availableTools, isAsync).resolvedTools

  // (H) Zero-tool spawn refusal — match upstream's `Ft` guard. When
  // resolveAgentTools returned no tools AND the caller had tools to choose
  // from AND we are not in the resume path, refuse the spawn with the
  // upstream error message so behavior parity is preserved.
  if (
    !useExactTools &&
    resolvedTools.length === 0 &&
    availableTools.length > 0
  ) {
    throw new Error(
      `[Agent: ${agentDefinition.agentType}] subagent zero-tool spawn refused`,
    )
  }

  let additionalWorkingDirectories = Array.from(
    appState.toolPermissionContext.additionalWorkingDirectories.keys(),
  )

  // (C) Add worktree path to additionalWorkingDirectories when set so the
  // subagent's prompt / system reminder sees the worktree as in-scope. Skip
  // if already present (the parent may have added it explicitly).
  if (worktreePath && !additionalWorkingDirectories.includes(worktreePath)) {
    additionalWorkingDirectories = [...additionalWorkingDirectories, worktreePath]
  }

  const agentSystemPrompt = override?.systemPrompt
    ? asSystemPrompt(withUltracodeReminder(withUltracodePrompt(override.systemPrompt)))
    : asSystemPrompt(
        withUltracodeReminder(
          withUltracodePrompt(
            await getAgentSystemPrompt(
              agentDefinition,
              toolUseContext,
              effectiveModel,
              additionalWorkingDirectories,
              resolvedTools,
            ),
          ),
        ),
      )

  // Determine abortController:
  // - Override takes precedence
  // - Async agents get a new unlinked controller (runs independently)
  // - Sync agents share parent's controller
  const agentAbortController = override?.abortController
    ? override.abortController
    : isAsync
      ? new AbortController()
      : toolUseContext.abortController

  // Execute SubagentStart hooks and collect additional context
  const additionalContexts: string[] = []
  for await (const hookResult of executeSubagentStartHooks(
    agentId,
    agentDefinition.agentType,
    agentAbortController.signal,
  )) {
    if (
      hookResult.additionalContexts &&
      hookResult.additionalContexts.length > 0
    ) {
      additionalContexts.push(...hookResult.additionalContexts)
    }
  }

  // Add SubagentStart hook context as a user message (consistent with SessionStart/UserPromptSubmit)
  if (additionalContexts.length > 0) {
    const contextMessage = createAttachmentMessage({
      type: 'hook_additional_context',
      content: additionalContexts,
      hookName: 'SubagentStart',
      toolUseID: randomUUID(),
      hookEvent: 'SubagentStart',
    })
    initialMessages.push(contextMessage)
  }

  // Register agent's frontmatter hooks (scoped to agent lifecycle)
  // Pass isAgent=true to convert Stop hooks to SubagentStop (since subagents trigger SubagentStop)
  // Same admin-trusted gate for frontmatter hooks: under ["hooks"] alone
  // (skills/agents not locked), user agents still load — block their
  // frontmatter-hook REGISTRATION here where source is known, rather than
  // blanket-blocking all session hooks at execution time (which would
  // also kill plugin agents' hooks).
  const hooksAllowedForThisAgent =
    !isRestrictedToPluginOnly('hooks') ||
    isSourceAdminTrusted(agentDefinition.source)
  if (agentDefinition.hooks && hooksAllowedForThisAgent) {
    registerFrontmatterHooks(
      rootSetAppState,
      agentId,
      agentDefinition.hooks,
      `agent '${agentDefinition.agentType}'`,
      true, // isAgent - converts Stop to SubagentStop
    )
  }

  // Preload skills from agent frontmatter
  const skillsToPreload = agentDefinition.skills ?? []
  if (skillsToPreload.length > 0) {
    const allSkills = await getSkillToolCommands(getProjectRoot())

    // Filter valid skills and warn about missing ones
    const validSkills: Array<{
      skillName: string
      skill: (typeof allSkills)[0] & { type: 'prompt' }
    }> = []

    for (const skillName of skillsToPreload) {
      // Resolve the skill name, trying multiple strategies:
      // 1. Exact match (hasCommand checks name, userFacingName, aliases)
      // 2. Fully-qualified with agent's plugin prefix (e.g., "my-skill" → "plugin:my-skill")
      // 3. Suffix match on ":skillName" for plugin-namespaced skills
      const resolvedName = resolveSkillName(
        skillName,
        allSkills,
        agentDefinition,
      )
      if (!resolvedName) {
        logForDebugging(
          `[Agent: ${agentDefinition.agentType}] Warning: Skill '${skillName}' specified in frontmatter was not found`,
          { level: 'warn' },
        )
        continue
      }

      const skill = getCommand(resolvedName, allSkills)
      if (skill.type !== 'prompt') {
        logForDebugging(
          `[Agent: ${agentDefinition.agentType}] Warning: Skill '${skillName}' is not a prompt-based skill`,
          { level: 'warn' },
        )
        continue
      }
      validSkills.push({ skillName, skill })
    }

    // Load all skill contents concurrently and add to initial messages
    const { formatSkillLoadingMetadata } = await import(
      '../../utils/processUserInput/processSlashCommand.js'
    )
    const loaded = await Promise.all(
      validSkills.map(async ({ skillName, skill }) => ({
        skillName,
        skill,
        content: await skill.getPromptForCommand('', toolUseContext),
      })),
    )
    for (const { skillName, skill, content } of loaded) {
      logForDebugging(
        `[Agent: ${agentDefinition.agentType}] Preloaded skill '${skillName}'`,
      )

      // Add command-message metadata so the UI shows which skill is loading
      const metadata = formatSkillLoadingMetadata(
        skillName,
        skill.progressMessage,
      )

      initialMessages.push(
        createUserMessage({
          content: [{ type: 'text', text: metadata }, ...content],
          isMeta: true,
        }),
      )
    }
  }

  // Initialize agent-specific MCP servers (additive to parent's servers)
  const {
    clients: mergedMcpClients,
    tools: agentMcpTools,
    cleanup: mcpCleanup,
  } = await initializeAgentMcpServers(
    agentDefinition,
    toolUseContext.options.mcpClients,
  )

  // Merge agent MCP tools with resolved agent tools, deduplicating by name.
  // resolvedTools is already deduplicated (see resolveAgentTools), so skip
  // the spread + uniqBy overhead when there are no agent-specific MCP tools.
  const allTools =
    agentMcpTools.length > 0
      ? uniqBy([...resolvedTools, ...agentMcpTools], 'name')
      : resolvedTools

  // Build agent-specific options
  const agentOptions: ToolUseContext['options'] = {
    isNonInteractiveSession: useExactTools
      ? toolUseContext.options.isNonInteractiveSession
      : isAsync
        ? true
        : (toolUseContext.options.isNonInteractiveSession ?? false),
    appendSystemPrompt: toolUseContext.options.appendSystemPrompt,
    tools: allTools,
    commands: [],
    debug: toolUseContext.options.debug,
    verbose: toolUseContext.options.verbose,
    mainLoopModel: effectiveModel,
    providerOverride: providerOverride ?? undefined,
    // For fork children (useExactTools), inherit thinking config to match the
    // parent's API request prefix for prompt cache hits. For regular
    // sub-agents, disable thinking to control output token costs.
    thinkingConfig: useExactTools
      ? toolUseContext.options.thinkingConfig
      : { type: 'disabled' as const },
    mcpClients: mergedMcpClients,
    mcpResources: toolUseContext.options.mcpResources,
    agentDefinitions: toolUseContext.options.agentDefinitions,
    // Fork children (useExactTools path) need querySource on context.options
    // for the recursive-fork guard at AgentTool.tsx call() — it checks
    // options.querySource === 'agent:builtin:fork'. This survives autocompact
    // (which rewrites messages, not context.options). Without this, the guard
    // reads undefined and only the message-scan fallback fires — which
    // autocompact defeats by replacing the fork-boilerplate message.
    ...(useExactTools && { querySource }),
  }

  // Create subagent context using shared helper
  // - Sync agents share setAppState, setResponseLength, abortController with parent
  // - Async agents are fully isolated (but with explicit unlinked abortController)
  const agentToolUseContext = createSubagentContext(toolUseContext, {
    options: agentOptions,
    agentId,
    agentType: agentDefinition.agentType,
    isAsync,
    messages: initialMessages,
    readFileState: agentReadFileState,
    abortController: agentAbortController,
    getAppState: agentGetAppState,
    ...(!isAsync && toolUseContext.queryLifecycle
      ? { queryLifecycle: toolUseContext.queryLifecycle }
      : {}),
    // Sync agents share these callbacks with parent
    shareSetAppState: !isAsync,
    shareSetResponseLength: true, // Both sync and async contribute to response metrics
    criticalSystemReminder_EXPERIMENTAL:
      agentDefinition.criticalSystemReminder_EXPERIMENTAL,
    contentReplacementState,
  })

  // Preserve tool use results for subagents with viewable transcripts (in-process teammates)
  if (preserveToolUseResults) {
    agentToolUseContext.preserveToolUseResults = true
  }

  // (L) Propagate worktree path onto the subagent context so downstream
  // tools (e.g. Bash, Read) can resolve the correct cwd / git root. opencc
  // does not have a typed `agentWorktree` slot on ToolUseContext — write
  // defensively via a cast so future code can read it.
  if (worktreePath) {
    ;(agentToolUseContext as unknown as { agentWorktree?: string }).agentWorktree =
      worktreePath
  }

  // (L-equivalent) thread parentToolUseID + name onto the subagent context
  // so progress callbacks can attribute emissions back to the parent.
  if (toolUseId) {
    ;(agentToolUseContext as unknown as { parentToolUseID?: string }).parentToolUseID =
      toolUseId
  }
  if (name) {
    ;(agentToolUseContext as unknown as { name?: string }).name = name
  }
  if (persistedToolResultFiles) {
    ;(
      agentToolUseContext as unknown as {
        persistedToolResultFiles?: string[]
      }
    ).persistedToolResultFiles = persistedToolResultFiles
  }

  // Expose cache-safe params for background summarization (prompt cache sharing)
  if (onCacheSafeParams) {
    onCacheSafeParams({
      systemPrompt: agentSystemPrompt,
      userContext: resolvedUserContext,
      systemContext: resolvedSystemContext,
      toolUseContext: agentToolUseContext,
      forkContextMessages: initialMessages,
    })
  }

  // Record agentType and identity metadata so resume can route correctly.
  // This must be awaited before writing the initial transcript so that any
  // resume attempt reading the transcript is guaranteed to find the metadata.
  let metadataWritten = false
  try {
    await writeAgentMetadata(agentId, {
      agentType: agentDefinition.agentType,
      source: agentDefinition.source,
      ...(worktreePath && { worktreePath }),
      // Keep explicit cwd even when a worktree exists so resume can fall back
      // to the child repo if the worktree is later removed.
      ...(cwd && { cwd }),
      ...(description && { description }),
      ...(worktreeBranch && { worktreeBranch }),
      ...(name && { name }),
      ...(toolUseId && { toolUseId }),
      ...(spawnedBySkill && { spawnedBySkill }),
      ...(spawnedByForkedSkill && { spawnedByForkedSkill }),
      ...(forkOrigin && { forkOrigin }),
      ...(spawnedByWorkflowRunId && { spawnedByWorkflowRunId }),
      ...(workflowPhase && { workflowPhase }),
      ...(requestShape && { requestShape }),
      ...(typeof requestNonInteractive === 'boolean' && {
        requestNonInteractive,
      }),
      ...(extraMetadata ?? {}),
    })
    metadataWritten = true
  } catch (_err) {
    logForDebugging(`Failed to write agent metadata: ${_err}`)
  }

  // Record initial messages before the query loop starts.
  // Fire-and-forget — persistence failure shouldn't block the agent.
  // (E) Resume-slicing: when `recordedUuids` is provided (the resume call
  // site), slice initialMessages down to only the messages *after* the
  // last already-recorded UUID. Already-persisted messages are skipped
  // (both for the initial fire-and-forget record and for the inner loop).
  // We compute the slice once, before the initial record write, so that
  // `lastRecordedUuid` correctly anchors to the *last* message we
  // actually wrote.
  let messagesToRecord: Message[] = initialMessages
  if (recordedUuids && recordedUuids.size > 0) {
    // findLastIndex: scan backwards for the highest index whose uuid is in
    // the already-recorded set. Anything strictly after that is new.
    let lastRecordedIdx = -1
    for (let i = initialMessages.length - 1; i >= 0; i--) {
      const messageUuid = (initialMessages[i] as { uuid?: UUID }).uuid
      if (typeof messageUuid === 'string' && recordedUuids.has(messageUuid)) {
        lastRecordedIdx = i
        break
      }
    }
    if (lastRecordedIdx >= 0) {
      messagesToRecord = initialMessages.slice(lastRecordedIdx + 1)
    }
  }

  // Only write the transcript if identity metadata was successfully persisted,
  // ensuring we never leave a transcript that would resume without its restricted identity.
  if (metadataWritten) {
    if (messagesToRecord.length > 0) {
      void recordSidechainTranscript(messagesToRecord, agentId).catch(_err =>
        logForDebugging(`Failed to record sidechain transcript: ${_err}`),
      )
    }
  } else {
    logForDebugging('Skipping initial transcript write because identity metadata persistence failed')
  }
  // Track the last recorded message UUID for parent chain continuity.
  // When we sliced, anchor to the last message we *just wrote* (which may
  // be earlier than the original initialMessages tail). When we didn't
  // slice (no recordedUuids), preserve the previous behavior.
  let lastRecordedUuid: UUID | null =
    messagesToRecord.length > 0
      ? (messagesToRecord.at(-1)?.uuid as UUID | undefined) ?? null
      : initialMessages.at(-1)?.uuid ?? null

  try {
    let queryTerminal: Terminal | undefined
    const configuredMaxSteps =
      Number.isSafeInteger(maxSteps) && maxSteps! > 0 ? maxSteps : undefined
    const queryIterator = query({
      messages: initialMessages,
      systemPrompt: agentSystemPrompt,
      userContext: resolvedUserContext,
      systemContext: resolvedSystemContext,
      canUseTool,
      toolUseContext: agentToolUseContext,
      querySource,
      maxTurns: maxTurns ?? agentDefinition.maxTurns,
      agentStepLimit:
        configuredMaxSteps !== undefined
          ? {
              maxSteps: configuredMaxSteps,
              agentType: agentDefinition.agentType,
            }
          : undefined,
    })[Symbol.asyncIterator]()

    try {
      while (true) {
        const next = await queryIterator.next()
        if (next.done) {
          queryTerminal = next.value
          break
        }

        const message = next.value
        onQueryProgress?.()
        // Forward subagent API request starts to parent's metrics display
        // so TTFT/OTPS update during subagent execution.
        if (
          message.type === 'stream_event' &&
          message.event.type === 'message_start' &&
          message.ttftMs != null
        ) {
          toolUseContext.pushApiMetricsEntry?.(message.ttftMs)
          // (K) Fire response_start hook for live spinner ETA display
          if (onStreamTokenEstimate) {
            onStreamTokenEstimate({ type: 'response_start' })
          }
          continue
        }

        // (K) Token-rate forwarder — best-effort. Inspect the stream event
        // for usage / token_delta fields; opencc's shape may vary. We don't
        // have a stable contract yet, so emit a synthetic delta whenever a
        // stream_event yields a non-zero usage block. This is forward-compat
        // — when upstream lands a precise contract, replace this with the
        // exact delta computation.
        if (
          onStreamTokenEstimate &&
          message.type === 'stream_event' &&
          (message.event as { type?: string }).type === 'message_delta'
        ) {
          const ev = message.event as { usage?: { output_tokens?: number } }
          const delta =
            typeof ev.usage?.output_tokens === 'number'
              ? ev.usage.output_tokens
              : 1
          onStreamTokenEstimate({
            type: 'tokens',
            estimatedTokensDelta: delta,
          })
        }

        // Yield attachment messages (e.g., structured_output) without recording them
        if (message.type === 'attachment') {
          // Handle max turns reached signal from query.ts
          if (message.attachment.type === 'max_turns_reached') {
            logForDebugging(
              `[Agent: ${agentDefinition.agentType}] Reached max turns limit (${message.attachment.maxTurns})`,
            )
            break
          }
          yield message
          continue
        }

        if (isRecordableMessage(message)) {
          // (E) Resume continuation: skip re-recording messages whose uuid
          // is already in `recordedUuids` (the resume call site already
          // wrote them). Still update the chain anchor so newly-yielded
          // messages attach to the right parent.
          const alreadyRecorded =
            recordedUuids !== undefined &&
            recordedUuids.size > 0 &&
            typeof message.uuid === 'string' &&
            recordedUuids.has(message.uuid)

          // Record only the new message with correct parent (O(1) per message)
          // Only write if identity metadata was successfully persisted.
          if (metadataWritten && !alreadyRecorded) {
            await recordSidechainTranscript(
              [message],
              agentId,
              lastRecordedUuid,
            ).catch(err =>
              logForDebugging(`Failed to record sidechain transcript: ${err}`),
            )
          }
          if (message.type !== 'progress') {
            lastRecordedUuid = message.uuid
          }
          yield message
        }
      }
    } finally {
      if (queryTerminal === undefined) {
        await queryIterator.return?.(undefined as never)
      }
    }

    if (queryTerminal?.reason === 'agent_step_limit') {
      logForDebugging(
        `[Agent: ${agentDefinition.agentType}] Stopped after reaching maxSteps (${queryTerminal.stepsUsed}/${queryTerminal.maxSteps})`,
      )
    }

    if (agentAbortController.signal.aborted) {
      throw new AbortError()
    }

    // Run callback if provided (only built-in agents have callbacks)
    if (isBuiltInAgent(agentDefinition) && agentDefinition.callback) {
      agentDefinition.callback()
    }
  } finally {
    // Clean up agent-specific MCP servers (runs on normal completion, abort, or error)
    await mcpCleanup()
    // Clean up agent's session hooks
    if (agentDefinition.hooks) {
      clearSessionHooks(rootSetAppState, agentId)
    }
    // Clean up prompt cache tracking state for this agent
    if (true) {
      cleanupAgentTracking(agentId)
    }
    // Release cloned file state cache memory
    agentToolUseContext.readFileState.clear()
    // Release the cloned fork context messages
    initialMessages.length = 0
    // Release perfetto agent registry entry
    unregisterPerfettoAgent(agentId)
    // Release transcript subdir mapping
    clearAgentTranscriptSubdir(agentId)
    // Release this agent's todos entry. Without this, every subagent that
    // called TodoWrite leaves a key in AppState.todos forever (even after all
    // items complete, the value is [] but the key stays). Whale sessions
    // spawn hundreds of agents; each orphaned key is a small leak that adds up.
    rootSetAppState(prev => {
      if (!(agentId in prev.todos)) return prev
      const { [agentId]: _removed, ...todos } = prev.todos
      return { ...prev, todos }
    })
    // Kill any background bash tasks this agent spawned. Without this, a
    // `run_in_background` shell loop (e.g. test fixture fake-logs.sh) outlives
    // the agent as a PPID=1 zombie once the main session eventually exits.
    killShellTasksForAgent(agentId, toolUseContext.getAppState, rootSetAppState)
    /* eslint-disable @typescript-eslint/no-require-imports */
    const mcpMod =
      require('../../tasks/MonitorMcpTask/MonitorMcpTask.js') as typeof import('../../tasks/MonitorMcpTask/MonitorMcpTask.js')
    mcpMod.killMonitorMcpTasksForAgent(
      agentId,
      toolUseContext.getAppState,
      rootSetAppState,
    )
    /* eslint-enable @typescript-eslint/no-require-imports */
  }
}

/**
 * Filters out assistant messages with incomplete tool calls (tool uses without results).
 * This prevents API errors when sending messages with orphaned tool calls.
 */
export function filterIncompleteToolCalls(messages: Message[]): Message[] {
  // Build a set of tool use IDs that have results
  const toolUseIdsWithResults = new Set<string>()

  for (const message of messages) {
    if (message?.type === 'user') {
      const userMessage = message as UserMessage
      const content = userMessage.message.content
      if (Array.isArray(content)) {
        for (const block of content) {
          if (block.type === 'tool_result' && block.tool_use_id) {
            toolUseIdsWithResults.add(block.tool_use_id)
          }
        }
      }
    }
  }

  // Filter out assistant messages that contain tool calls without results
  return messages.filter(message => {
    if (message?.type === 'assistant') {
      const assistantMessage = message as AssistantMessage
      const content = assistantMessage.message.content
      if (Array.isArray(content)) {
        // Check if this assistant message has any tool uses without results
        const hasIncompleteToolCall = content.some(
          block =>
            block.type === 'tool_use' &&
            block.id &&
            !toolUseIdsWithResults.has(block.id),
        )
        // Exclude messages with incomplete tool calls
        return !hasIncompleteToolCall
      }
    }
    // Keep all non-assistant messages and assistant messages without tool calls
    return true
  })
}

async function getAgentSystemPrompt(
  agentDefinition: AgentDefinition,
  toolUseContext: Pick<ToolUseContext, 'options'>,
  effectiveModel: string,
  additionalWorkingDirectories: string[],
  resolvedTools: readonly Tool[],
): Promise<string[]> {
  const enabledToolNames = new Set(resolvedTools.map(t => t.name))
  try {
    const agentPrompt = agentDefinition.getSystemPrompt({ toolUseContext })
    const prompts = [agentPrompt]

    return await enhanceSystemPromptWithEnvDetails(
      prompts,
      effectiveModel,
      additionalWorkingDirectories,
      enabledToolNames,
    )
  } catch (_error) {
    return enhanceSystemPromptWithEnvDetails(
      [DEFAULT_AGENT_PROMPT],
      effectiveModel,
      additionalWorkingDirectories,
      enabledToolNames,
    )
  }
}

/**
 * Resolve a skill name from agent frontmatter to a registered command name.
 *
 * Plugin skills are registered with namespaced names (e.g., "my-plugin:my-skill")
 * but agents reference them with bare names (e.g., "my-skill"). This function
 * tries multiple resolution strategies:
 *
 * 1. Exact match via hasCommand (name, userFacingName, aliases)
 * 2. Prefix with agent's plugin name (e.g., "my-skill" → "my-plugin:my-skill")
 * 3. Suffix match — find any command whose name ends with ":skillName"
 */
function resolveSkillName(
  skillName: string,
  allSkills: Command[],
  agentDefinition: AgentDefinition,
): string | null {
  // 1. Direct match
  if (hasCommand(skillName, allSkills)) {
    return skillName
  }

  // 2. Try prefixing with the agent's plugin name
  // Plugin agents have agentType like "pluginName:agentName"
  const pluginPrefix = agentDefinition.agentType.split(':')[0]
  if (pluginPrefix) {
    const qualifiedName = `${pluginPrefix}:${skillName}`
    if (hasCommand(qualifiedName, allSkills)) {
      return qualifiedName
    }
  }

  // 3. Suffix match — find a skill whose name ends with ":skillName"
  const suffix = `:${skillName}`
  const match = allSkills.find(cmd => cmd.name.endsWith(suffix))
  if (match) {
    return match.name
  }

  return null
}

/**
 * Derive the API request shape + non-interactive flag for a subagent spawn.
 *
 * Pure helper ported from upstream module 1551 (`WLn`):
 *   - async spawns always go through as background + non-interactive
 *   - sync spawns preserve the caller's `isNonInteractiveSession` flag
 *
 * Used by `runAgent` to set `requestNonInteractive` on the request shape and
 * by callers / consumers that need a single source of truth.
 */
export function spawnRequestShape(
  isAsync: boolean,
  isNonInteractiveSession: boolean | undefined,
): { requestShape: 'foreground' | 'background'; requestNonInteractive: boolean } {
  return isAsync
    ? { requestShape: 'background', requestNonInteractive: true }
    : {
        requestShape: 'foreground',
        requestNonInteractive: isNonInteractiveSession ?? false,
      }
}

/**
 * Forward a subagent's progress message into the parent's output sink
 * (used by the bg-progress forwarding path in AgentTool.tsx).
 *
 * Ported from upstream module 1551 (`cst`). opencc does not currently
 * expose an `outputSink` on `ToolUseContext.session` — when the sink is
 * missing, this is a defensive no-op. The throttle is built into the
 * sink itself in upstream, so we simply respect `forwardSubagentText`
 * and skip structured-output messages unless forwarding is enabled.
 *
 * @param toolUseContext Parent's tool use context (only `options` is read).
 * @param message        Message to forward (only used for progress shape).
 * @param isStructuredOutput  True if `message` is a structured_output message.
 */
export function writeSubagentProgressToOutputSink(
  toolUseContext: ToolUseContext,
  message: Message,
  isStructuredOutput?: boolean,
): void {
  // opencc does not have an outputSink abstraction on ToolUseContext.session.
  // Probe the upstream shape; if absent, return early.
  const sink = (toolUseContext as unknown as {
    session?: { outputSink?: { active?: { writeAfterInit?: (msg: unknown) => void } } }
  }).session?.outputSink?.active
  if (!sink?.writeAfterInit) return

  const forwardSubagentText: boolean =
    (toolUseContext.options as { forwardSubagentText?: boolean })
      .forwardSubagentText ?? false

  if (isStructuredOutput && !forwardSubagentText) return

  sink.writeAfterInit(message)
}

/**
 * Mark a subagent's worktree as cleanly removed and persist updated metadata.
 *
 * Ported from upstream module 1551 (`Kbr`). Reads existing metadata, merges
 * the caller-supplied `spawnMetadata` plus any preserved fields, and writes
 * the result back with `worktreeCleanlyRemoved: true`. Also unregisters
 * the agent from the perfetto trace.
 *
 * @param agentId            The subagent whose worktree was removed.
 * @param removedWorktreePath The worktree path that was just removed.
 * @param spawnMetadata      Metadata to merge into the persisted record.
 */
export async function clearWorktreeFromAgentMetadata({
  agentId,
  removedWorktreePath,
  spawnMetadata,
}: {
  agentId: AgentId
  removedWorktreePath: string
  spawnMetadata: Partial<AgentMetadata>
}): Promise<void> {
  try {
    unregisterPerfettoAgent(agentId)
  } catch (err) {
    logForDebugging(`clearWorktreeFromAgentMetadata: unregister perfetto failed: ${err}`)
  }

  let existing: AgentMetadata | null = null
  try {
    existing = await readAgentMetadata(agentId)
  } catch (err) {
    logForDebugging(`clearWorktreeFromAgentMetadata: read failed: ${err}`)
  }

  // Compute fallback cwd: keep the original cwd if it differs from the
  // removed worktree path (multi-repo parent fallback).
  const fallbackCwd =
    existing?.cwd && existing.cwd !== removedWorktreePath ? existing.cwd : undefined

  const merged: Partial<AgentMetadata> = {
    ...spawnMetadata,
    ...(fallbackCwd !== undefined ? { cwd: fallbackCwd } : {}),
    ...(existing?.stoppedByUser ? { stoppedByUser: true } : {}),
    ...(existing?.parentAgentId ? { parentAgentId: existing.parentAgentId } : {}),
    ...(existing?.pluginSteered === true ? { pluginSteered: true } : {}),
    ...(existing?.requestShape === 'foreground' ||
    existing?.requestShape === 'background'
      ? { requestShape: existing.requestShape }
      : {}),
    ...(typeof existing?.requestNonInteractive === 'boolean'
      ? { requestNonInteractive: existing.requestNonInteractive }
      : {}),
    worktreeCleanlyRemoved: true,
  }

  try {
    await writeAgentMetadata(agentId, merged as AgentMetadata)
  } catch (err) {
    logForDebugging(`clearWorktreeFromAgentMetadata: write failed: ${err}`)
  }
}
