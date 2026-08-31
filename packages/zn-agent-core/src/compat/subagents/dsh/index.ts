import {
  SubagentRegistry,
  NO_START_CAPABILITIES,
  type SubagentCapabilities,
  type SubagentProvider,
  type SubagentRequest,
  type SubagentContext,
  type SubagentRun,
} from '../registry.js'
import { parseDshConfig, type DshConfig } from './config.js'
import { startDshRun } from './run.js'

/**
 * Fixed DeepSeek Harness (dsh) subagent provider.
 *
 * Every accepted run spawns a fresh `dsh --profile sdk` JSON-RPC runtime
 * (the same protocol as dsh's own `@deepseek-ai/dsh-subagent-dsh-sdk`,
 * `subagent-dsh-sdk/src/{index,run}.ts`) in the delegating session's cwd.
 * The provider inherits NO parent conversation history
 * (`inheritsParentContext = false`).
 *
 * Capabilities follow the dsh shape: the out-of-process child cannot apply
 * host tool/persona/depth filters, so everything is false EXCEPT
 * `agentOptions` — dsh's `SDK_START_CAPABILITIES`
 * (`subagent-dsh-sdk/src/index.ts:110-113`): the child's provider/model
 * route is settable through the `initialize` handshake. `agentRouteDefaults`
 * advertises the configured default route (`index.ts:136-142`).
 *
 * dsh installation, credentials (child env, e.g. DEEPSEEK_API_KEY), profile
 * contents, and product settings are native dsh concerns, NOT touched here.
 */
export class DshProvider implements SubagentProvider {
  readonly name = 'dsh'
  readonly description =
    'Delegate a one-shot task to a fresh DeepSeek Harness (dsh) runtime session (independent process; no parent context). Use when you want the dsh agent loop and DeepSeek-native models as the engine for a standalone research or implementation task.'
  readonly inheritsParentContext = false
  readonly capabilities: SubagentCapabilities = Object.freeze({
    ...NO_START_CAPABILITIES,
    agentOptions: true,
  })
  readonly agentRouteDefaults: Readonly<{ provider: string; model: string }>

  constructor(private readonly config: DshConfig) {
    // Assigned in the ctor body: esbuild emits parameter-property
    // assignment AFTER field initializers, so `config.provider` cannot be
    // read in a field initializer.
    this.agentRouteDefaults = Object.freeze({
      provider: this.config.provider,
      model: this.config.model,
    })
  }

  start(req: SubagentRequest, ctx: SubagentContext): Promise<SubagentRun> {
    return startDshRun(req, ctx, {
      command: this.config.command,
      args: this.config.args,
      profile: this.config.profile,
      patches: this.config.patches,
      ...(this.config.dshHome !== undefined ? { dshHome: this.config.dshHome } : {}),
      provider: this.config.provider,
      model: this.config.model,
      ...(this.config.reasoningEffort !== undefined
        ? { reasoningEffort: this.config.reasoningEffort }
        : {}),
      ...(this.config.maxTokens !== undefined ? { maxTokens: this.config.maxTokens } : {}),
      env: this.config.env,
      initializeTimeoutMs: this.config.initializeTimeoutMs,
      ...(this.config.requestTimeoutMs !== undefined
        ? { requestTimeoutMs: this.config.requestTimeoutMs }
        : {}),
      shutdownTimeoutMs: this.config.shutdownTimeoutMs,
      disposeGraceMs: this.config.disposeGraceMs,
    })
  }
}

/**
 * Register the dsh provider under the registry's `'dsh'` name.
 *
 * Unlike claude-code (registered unconditionally for back-compat), the dsh
 * spawn path requires an operator-installed `dsh` CLI and credentials, so
 * `apply` is a no-op unless `config.enabled === true`. zai's
 * `initAgentRuntime` reads `subagents.dsh` from settings and calls this only
 * for enabled configs; `config === undefined` (no settings) is also a no-op.
 */
export function apply(registry: SubagentRegistry, config?: unknown): (() => void) | undefined {
  if (config === undefined) return undefined
  const resolved: DshConfig = parseDshConfig(config)
  if (!resolved.enabled) return undefined
  return registry.registerProvider(new DshProvider(resolved))
}

export {
  dshConfigSchema,
  parseDshConfig,
  safeParseDshConfig,
  type DshConfig,
} from './config.js'
export { startDshRun, dshSpawnArgv, dshChildOutcome, AssistantTextFold, type DshRunSpec } from './run.js'
export {
  DSH_DEFAULT_PROFILE,
  DSH_SDK_METHODS,
  DSH_SDK_NOTIFICATIONS,
  type DshSessionEventFrame,
  type DshTurnEndReason,
} from './wire.js'
export { failDsh, dshFailureDiagnostic } from './invariant.js'
