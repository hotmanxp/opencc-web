import {
  SubagentRegistry,
  type SubagentProvider,
  type SubagentRequest,
  type SubagentContext,
  type SubagentRun,
} from '../registry.js'
import {
  parseClaudeCodeConfig,
  safeParseClaudeCodeConfig,
  type ClaudeCodeConfig,
} from './config.js'
import { startClaudeCodeRun } from './run.js'

/**
 * Fixed Claude Code CLI subagent provider.
 *
 * Every accepted run spawns a fresh `claude --print` process in the
 * delegating session's cwd. The provider inherits NO parent conversation
 * history (`inheritsParentContext = false`) and advertises no optional
 * start-time capabilities (`noStartCapabilities = true`).
 *
 * Product selection and background execution are *not* model arguments;
 * routing to this provider happens by name in `AgentTool(subagent_type)`,
 * and the run is foreground-only by design. Per-call `request.env` is
 * layered on top of `config.env` (last write wins) before the seam scrubs
 * credential-shaped ambient vars.
 *
 * Installation, login, model selection, settings, permission semantics,
 * MCP servers, and session persistence are native Claude Code concerns
 * and are NOT touched here.
 */
export class ClaudeCodeProvider implements SubagentProvider {
  readonly name = 'claude-code'
  readonly description =
    "Delegate a one-shot task to a fresh Claude CLI session (independent process; no parent context). Use when you want a separate Claude context with the CLI's native tools for a standalone task."
  readonly inheritsParentContext = false
  readonly capabilities = { noStartCapabilities: true } as const

  constructor(private readonly config: ClaudeCodeConfig) {}

  start(req: SubagentRequest, ctx: SubagentContext): Promise<SubagentRun> {
    return startClaudeCodeRun(req, ctx, {
      disposeGraceMs: this.config.disposeGraceMs,
      command: this.config.command,
      args: this.config.args,
      outputFormat: this.config.outputFormat,
      permissionMode: this.config.permissionMode,
      env: this.config.env,
    })
  }
}

/** Default provider config used when `apply` is called without a config —
 * matches "feature off by default" via `enabled: false`.
 */
const DEFAULT_CONFIG: ClaudeCodeConfig = safeParseClaudeCodeConfig({})

/**
 * Register the claude-code provider under the registry's `'claude-code'` name.
 *
 * Idempotent: the registry itself rejects duplicate-name registration.
 */
export function apply(registry: SubagentRegistry, config?: unknown): void {
  const resolved: ClaudeCodeConfig =
    config === undefined ? DEFAULT_CONFIG : parseClaudeCodeConfig(config)
  registry.registerProvider(new ClaudeCodeProvider(resolved))
}

export {
  claudeCodeConfigSchema,
  parseClaudeCodeConfig,
  safeParseClaudeCodeConfig,
  type ClaudeCodeConfig,
} from './config.js'
export { startClaudeCodeRun, claudeSpawnArgv } from './run.js'
export {
  CLAUDE_OUTPUT_FORMAT,
  CLAUDE_PERMISSION_MODE,
  type ClaudeOutputFormat,
  type ClaudePermissionMode,
  type ClaudeSpawnArgs,
} from './wire.js'
export {
  resolveFinalAnswer,
  stopReasonFromClaudeResult,
} from './result.js'
export { failClaudeCode } from './invariant.js'
