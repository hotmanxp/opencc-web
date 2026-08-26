import { z } from 'zod/v4'
import { DISPOSE_GRACE_MS_DEFAULT, MAX_TIMER_DELAY_MS } from '../../subprocess/timeouts.js'

/**
 * Deployment-owned configuration for the codex subagent provider.
 *
 * Sourced from `~/.zai/settings.json` (project- or user-level). The shape
 * is intentionally small: only what the provider actually reads. Anything
 * else (login state, `CODEX_HOME`, model selection, base URL, sandbox,
 * approval policy, session persistence) is the native Codex configuration's
 * job and is documented separately in the spec under "Codex provider".
 */
export const codexConfigSchema = z.object({
  /** Master switch — when false, the provider still registers but never mounts a tool. */
  enabled: z.boolean().default(false),
  /** Command for the binary on PATH (or absolute). Defaults to 'codex'. */
  command: z.string().min(1).default('codex'),
  /** Argv tail after `command`. Defaults to ['app-server', '--stdio']. */
  args: z.array(z.string().min(1)).default(['app-server', '--stdio']),
  /** Explicit env overlay layered on top of the seam's scrubbed parent env. */
  env: z.record(z.string(), z.string()).default({}),
  /**
   * Grace (ms) for the SIGTERM → SIGKILL escalation. Must be a positive
   * finite integer ≤ the shared `MAX_TIMER_DELAY_MS`. Default matches
   * `disposeGraceMs` in deepseek-harness's `dsh-subagent-codex`.
   */
  disposeGraceMs: z
    .number()
    .int()
    .positive()
    .max(MAX_TIMER_DELAY_MS)
    .default(DISPOSE_GRACE_MS_DEFAULT),
})

export type CodexConfig = z.infer<typeof codexConfigSchema>

/**
 * Parse and validate a deployment config. Throws `ZodError` on a malformed
 * payload — callers should surface this as a startup misconfiguration,
 * not a per-call failure, because no provider can recover from `codex`
 * command being unset at startup time.
 */
export function parseCodexConfig(input: unknown): CodexConfig {
  return codexConfigSchema.parse(input)
}

/**
 * Same as {@link parseCodexConfig} but returns a partial result on
 * validation failures (the caller typically wants the "safe defaults"
 * behavior). When `input` is `undefined`, returns the schema defaults —
 * matching the "feature off by default" intent of `enabled: false`.
 */
export function safeParseCodexConfig(input: unknown): CodexConfig {
  const parsed = codexConfigSchema.safeParse(input)
  if (parsed.success) return parsed.data
  return codexConfigSchema.parse({})
}
