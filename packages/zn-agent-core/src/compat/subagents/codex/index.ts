import {
  SubagentRegistry,
  NO_START_CAPABILITIES,
  type SubagentCapabilities,
  type SubagentProvider,
  type SubagentRequest,
  type SubagentContext,
  type SubagentRun,
} from '../registry.js'
import { parseCodexConfig, type CodexConfig } from './config.js'
import { startCodexRun } from './run.js'
import { CODEX_PROTOCOL_VERSION } from './invariant.js'

/**
 * Fixed Codex subagent provider.
 *
 * Every accepted run starts a fresh `codex app-server --stdio` process in
 * the delegating session's cwd and publishes only after an ephemeral
 * thread exists. The provider inherits NO parent conversation history
 * (`inheritsParentContext = false`) and advertises no optional start-time
 * capabilities (`NO_START_CAPABILITIES` — the dsh 5-flag shape, all false)
 * — child tools, persona, depth policy, and structured output are not
 * configurable here.
 *
 * Product selection and background execution are *not* model arguments;
 * routing to this provider happens by name in `AgentTool(subagent_type)`,
 * and the run is foreground-only by design (matches deepseek-harness's
 * `dsh-subagent-codex` shape). Wiring for SSE timeline parity lives in
 * `tools/AgentTool/subagentProviderBridge.ts`.
 *
 * Installation, login, `CODEX_HOME`, model selection, base URL, sandbox,
 * approval policy, and product-session settings are native Codex
 * concerns and are NOT touched here.
 */
export class CodexProvider implements SubagentProvider {
  readonly name = 'codex'
  readonly description =
    "Delegate a one-shot task to a fresh Codex CLI session (independent process; no parent context). Use when you want Codex as the engine for a standalone research or implementation task."
  readonly inheritsParentContext = false
  readonly capabilities: SubagentCapabilities = NO_START_CAPABILITIES

  constructor(private readonly config: CodexConfig) {}

  start(req: SubagentRequest, ctx: SubagentContext): Promise<SubagentRun> {
    return startCodexRun(req, ctx, {
      disposeGraceMs: this.config.disposeGraceMs,
      command: this.config.command,
      args: this.config.args,
      env: this.config.env,
    })
  }

  /** Provider-internal protocol version pin; surfaced for ops / debug only. */
  readonly protocolVersion: string = CODEX_PROTOCOL_VERSION
}

/**
 * Default provider config used when callers invoke `apply` without explicit
 * settings — i.e. the feature is disabled by default.
 */
const DEFAULT_CONFIG: CodexConfig = parseCodexConfig({})

/**
 * Register the codex provider under the registry's `'codex'` name.
 *
 * Idempotent: the registry itself rejects duplicate-name registration. Pass
 * a partial config and let the schema's defaults fill in the rest; pass
 * `undefined` to use the all-defaults (feature-off) config.
 */
export function apply(registry: SubagentRegistry, config?: unknown): void {
  const resolved: CodexConfig = config === undefined ? DEFAULT_CONFIG : parseCodexConfig(config)
  registry.registerProvider(new CodexProvider(resolved))
}

export { codexConfigSchema, parseCodexConfig, safeParseCodexConfig, type CodexConfig } from './config.js'
export { startCodexRun, codexAppServerArgv } from './run.js'
export { CODEX_PROTOCOL_VERSION, MAX_AGENT_MESSAGE_BYTES, failCodex } from './invariant.js'
export { resolveFinalAnswer, stopReasonFromTurnTerminal } from './result.js'
export { pickApprovalDecision, registerApprovalHandlers } from './approvals.js'
export type {
  InitializeParams,
  InitializeResult,
  ThreadStartParams,
  ThreadStartResult,
  TurnStartParams,
  TurnStartResult,
  TurnInterruptParams,
  TurnCompletedParams,
  TurnStatus,
  AgentMessageParams,
  ApprovalDecision,
  ApprovalRequestParams,
  ApprovalResponseResult,
  UserInputResponseResult,
  ElicitationResponseResult,
} from './wire.js'
