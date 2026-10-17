import {
  SubagentRegistry,
  NO_START_CAPABILITIES,
  type SubagentCapabilities,
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
 * start-time capabilities (`NO_START_CAPABILITIES` — dsh 0.1.2-alpha.2
 * alignment: the five flags stay false, matching dsh's own claude-code
 * provider, `subagent-claude-code/src/index.ts:73-75`).
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
 *
 * ── zai patch (2026-10-17) ──────────────────────────────────────────
 * 本 provider 原先注册名是 `'opencc'`、默认 `command` 也是 `'opencc'` ——
 * 目录叫 claude-code,跑的却是 opencc 二进制。二者不能并存:
 * `SubagentRegistry.registerProvider` 对重名直接 throw(`PROVIDER_ALREADY_
 * REGISTERED`),所以无法既当 claude provider 又保留 opencc。
 *
 * 现在按二进制真正拆开:
 *   - 本类 → `name: 'claude'`,默认 command `claude`(按配置开关注册)
 *   - `../opencc/` → `name: 'opencc'`,默认 command `opencc`(无条件注册)
 * wire 协议不变 —— opencc CLI 与 Claude Code CLI 同协议
 * (`--print --output-format stream-json`),所以两边共用同一套解析。
 */
export class ClaudeCodeProvider implements SubagentProvider {
  readonly name = 'claude'
  readonly description =
    "Delegate a one-shot task to a fresh Claude Code CLI session (independent process; no parent context). Use when you want a separate Claude context with the CLI's native tools for a standalone task."
  readonly inheritsParentContext = false
  readonly capabilities: SubagentCapabilities = NO_START_CAPABILITIES

  constructor(private readonly config: ClaudeCodeConfig) {}

  start(req: SubagentRequest, ctx: SubagentContext): Promise<SubagentRun> {
    return startClaudeCodeRun(req, ctx, {
      disposeGraceMs: this.config.disposeGraceMs,
      command: this.config.command,
      args: this.config.args,
      outputFormat: this.config.outputFormat,
      permissionMode: this.config.permissionMode,
      // dsh parity: config.model is the deployment default; request.model
      // (per-call) wins.
      model: req.model ?? this.config.model,
      env: this.config.env,
    })
  }
}

/**
 * Register the claude provider under the registry's `'claude'` name.
 *
 * Config-gated (2026-10-17): spawning a real `claude` child requires an
 * operator-installed Claude Code CLI and its own login, so `apply` is a
 * no-op unless `config.enabled === true` — same policy as `dsh` / `opencode`.
 * Previously this registered unconditionally, which was fine while it
 * pointed at `opencc` (the default binary); now that it means the actual
 * Claude CLI, an ungated registration would advertise a provider that
 * cannot run on machines without Claude Code installed.
 *
 * Returns the unregister disposer when it registers, `undefined` when it
 * does not (so callers can conditionally track it).
 */
export function apply(registry: SubagentRegistry, config?: unknown): (() => void) | undefined {
  if (config === undefined) return undefined
  const resolved: ClaudeCodeConfig = parseClaudeCodeConfig(config)
  if (!resolved.enabled) return undefined
  return registry.registerProvider(new ClaudeCodeProvider(resolved))
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
  claudeResultFailureCategory,
  claudeFailureDiagnostic,
  type ClaudeResultFrame,
  type ResolvedClaudeAnswer,
} from './result.js'
export { failClaudeCode } from './invariant.js'
