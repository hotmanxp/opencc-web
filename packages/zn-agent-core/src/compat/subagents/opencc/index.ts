import {
  SubagentRegistry,
  NO_START_CAPABILITIES,
  type SubagentCapabilities,
  type SubagentProvider,
  type SubagentRequest,
  type SubagentContext,
  type SubagentRun,
} from '../registry.js'
// 必须走 `zod/v4`:claude-code/config.ts 用的是 v4 的 zod,从 v3 拿 z 来
// .extend() 会因内部 `_zod` 结构不同而类型不兼容。
import { z } from 'zod/v4'
import { safeParseClaudeCodeConfig, claudeCodeConfigSchema, type ClaudeCodeConfig } from '../claude-code/config.js'
import { startClaudeCodeRun } from '../claude-code/run.js'

/**
 * OpenCC CLI subagent provider — the `name: 'opencc'` half of the
 * Claude-protocol family.
 *
 * ── zai patch (2026-10-17) ──────────────────────────────────────────
 * 本 provider 是从 `../claude-code/` 拆出来的。原先那个目录名叫
 * claude-code,注册名却是 `'opencc'`、默认 command 也是 `'opencc'` ——
 * 它一直 spawn 的是 opencc 二进制。于是有两个问题:
 *   1. 无法启用真正的 Claude Code CLI —— 那需要另一个注册名,而
 *      `SubagentRegistry.registerProvider` 对重名直接 throw;
 *   2. 「目录名 / 注册名 / 实际二进制」三者不一致,读代码时极易误解。
 * 现在按二进制拆开:本目录 → `opencc`,`../claude-code/` → `claude`。
 *
 * **wire 协议不重写**:opencc CLI 与 Claude Code CLI 同协议
 * (`--print --output-format stream-json`),故直接复用 claude-code 那套
 * `run.ts` / `wire.ts` / `result.ts`。只有 command 默认值不同。
 *
 * 与 claude provider 的注册策略不同(见 `apply`):opencc 是 zai 的一等
 * CLI,默认二进制随 zai 一起装,故**无条件注册**;claude 需要用户自行安装
 * Claude Code 并登录,故按 `enabled` 开关。
 */
export class OpenccProvider implements SubagentProvider {
  readonly name = 'opencc'
  readonly description =
    "Delegate a one-shot task to a fresh OpenCC CLI session (independent process; no parent context). Use when you want a separate OpenCC context with the CLI's native tools for a standalone task."
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
 * opencc provider 的配置:与 claude 共用 `ClaudeCodeConfig` 形状(同协议),
 * 只把默认 `command` 覆写成 `opencc`。其余字段默认值由 claude 的 schema
 * 提供 —— 那是这套协议唯一的权威定义,复制一份 schema 会让两边漂移。
 */
export const openccConfigSchema = claudeCodeConfigSchema.extend({
  enabled: z.boolean().default(true),
  command: z.string().min(1).default('opencc'),
})

export function parseOpenccConfig(config: unknown): ClaudeCodeConfig {
  return openccConfigSchema.parse(config)
}

export function safeParseOpenccConfig(config: unknown): ClaudeCodeConfig {
  return openccConfigSchema.parse(config)
}

/**
 * Register the opencc provider under the registry's `'opencc'` name.
 *
 * Unconditional (2026-10-17): the opencc CLI ships with zai, so there is no
 * "is it installed / is it logged in" question to ask — the provider is
 * always available. `config` (from `settings.json` `subagents.opencc`) only
 * *overrides* defaults; it can no longer switch the provider off, because
 * doing so would silently remove the subagent the model has been told
 * exists. Pass `undefined` for pure defaults.
 *
 * Idempotency note: the registry rejects duplicate-name registration, so
 * calling this twice for the same registry throws. `initAgentRuntime` is
 * the single call site.
 */
export function apply(registry: SubagentRegistry, config?: unknown): (() => void) | undefined {
  const resolved: ClaudeCodeConfig =
    config === undefined ? safeParseOpenccConfig({}) : parseOpenccConfig(config)
  return registry.registerProvider(new OpenccProvider(resolved))
}

export {
  claudeCodeConfigSchema,
  parseClaudeCodeConfig,
  safeParseClaudeCodeConfig,
  type ClaudeCodeConfig,
} from '../claude-code/config.js'
export { startClaudeCodeRun, claudeSpawnArgv } from '../claude-code/run.js'
export {
  CLAUDE_OUTPUT_FORMAT,
  CLAUDE_PERMISSION_MODE,
  type ClaudeOutputFormat,
  type ClaudePermissionMode,
  type ClaudeSpawnArgs,
} from '../claude-code/wire.js'
export {
  resolveFinalAnswer,
  stopReasonFromClaudeResult,
  claudeResultFailureCategory,
  claudeFailureDiagnostic,
  type ClaudeResultFrame,
  type ResolvedClaudeAnswer,
} from '../claude-code/result.js'
export { failClaudeCode } from '../claude-code/invariant.js'
