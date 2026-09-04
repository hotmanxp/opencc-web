import {
  SubagentRegistry,
  NO_START_CAPABILITIES,
  type SubagentCapabilities,
  type SubagentProvider,
  type SubagentRequest,
  type SubagentContext,
  type SubagentRun,
} from '../registry.js'
import { parseOpencodeConfig, type OpencodeConfig } from './config.js'
import { startOpencodeRun } from './run.js'

/**
 * Fixed opencode CLI subagent provider.
 *
 * Every accepted run spawns a fresh `opencode run --format json` one-shot
 * child in the delegating session's cwd; stdout is a newline-delimited JSON
 * event stream mapped onto SubagentEvents. The provider inherits NO parent
 * conversation history (`inheritsParentContext = false`).
 *
 * Capabilities are the all-false {@link NO_START_CAPABILITIES} shape: the
 * child is a single one-shot turn with no agent-route options, no live
 * steering, no send_message multi-round continuation (session follow-up is
 * out of scope for v1).
 *
 * opencode installation, model/provider routing, credentials and login are
 * native opencode concerns, NOT touched here — zai only spawns the CLI and
 * parses its stream.
 */
export class OpencodeProvider implements SubagentProvider {
  readonly name = 'opencode'
  readonly description =
    "Delegate a one-shot task to a fresh opencode CLI session (independent process; no parent context). Use when you want a separate opencode context with the CLI's native tools for a standalone task."
  readonly inheritsParentContext = false
  readonly capabilities: SubagentCapabilities = NO_START_CAPABILITIES

  constructor(private readonly config: OpencodeConfig) {}

  start(req: SubagentRequest, ctx: SubagentContext): Promise<SubagentRun> {
    return startOpencodeRun(req, ctx, {
      disposeGraceMs: this.config.disposeGraceMs,
      command: this.config.command,
      args: this.config.args,
      env: this.config.env,
      // dsh parity: config.model is the deployment default; request.model
      // (per-call) wins.
      model: req.model ?? this.config.model,
    })
  }
}

/**
 * Register the opencode provider under the registry's `'opencode'` name.
 *
 * Config-gated like `dsh`: spawning a real opencode child requires an
 * operator-installed `opencode` CLI and its own credentials, so `apply` is a
 * no-op unless `config.enabled === true`. zai's `initAgentRuntime` reads
 * `subagents.opencode` from settings and calls this only for enabled configs;
 * `config === undefined` (no settings) is also a no-op. Returns the unregister
 * disposer when it registers, `undefined` when it does not.
 */
export function apply(
  registry: SubagentRegistry,
  config?: unknown,
): (() => void) | undefined {
  if (config === undefined) return undefined
  const resolved: OpencodeConfig = parseOpencodeConfig(config)
  if (!resolved.enabled) return undefined
  return registry.registerProvider(new OpencodeProvider(resolved))
}

export {
  opencodeConfigSchema,
  parseOpencodeConfig,
  safeParseOpencodeConfig,
  type OpencodeConfig,
} from './config.js'
export {
  startOpencodeRun,
  opencodeSpawnArgv,
  normalizeOpencodeModelArg,
  type OpencodeRunSpec,
} from './run.js'
export {
  OPENCODE_FORMAT,
  OPENCODE_FRAME,
  type OpencodeFrame,
  type OpencodeFrameType,
  type OpencodeFinishReason,
  type OpencodeSpawnArgs,
} from './wire.js'
export {
  resolveOpencodeAnswer,
  opencodeFrameToEvents,
  opencodeLineToEvents,
  collectOpencodeAnswerParts,
  lastStepFinishPart,
  type OpencodeTerminal,
  type ResolvedOpencodeAnswer,
} from './result.js'
export { failOpencode, opencodeFailureDiagnostic } from './invariant.js'
