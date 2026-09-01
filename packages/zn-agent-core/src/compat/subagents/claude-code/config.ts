import { z } from 'zod/v4'
import {
  CLAUDE_OUTPUT_FORMAT,
  CLAUDE_PERMISSION_MODE,
  type ClaudeOutputFormat,
  type ClaudePermissionMode,
} from './wire.js'
import {
  DISPOSE_GRACE_MS_DEFAULT,
  MAX_TIMER_DELAY_MS,
} from '../../subprocess/timeouts.js'

/**
 * Deployment-owned configuration for the Claude Code subagent provider.
 *
 * Mirrors the codex provider's config schema (zod-validated; documented
 * in `docs/superpowers/specs/2026-08-21-zai-subagent-codex-provider-design.md`).
 * `command` here is the explicit CLI binary path — usually a plain
 * `opencc` is fine, but staging may pin to a specific build.
 */
export const claudeCodeConfigSchema = z.object({
  /** Master switch. */
  enabled: z.boolean().default(false),
  /** Binary on PATH. Defaults to `opencc` (the canonical CLI). */
  command: z.string().min(1).default('opencc'),
  /** Args tail after `command`. Default = `['--print', '--output-format', 'stream-json']`. */
  args: z
    .array(z.string().min(1))
    .default(['--print', '--output-format', 'stream-json']),
  /** Output format selection. Default matches the bridge's per-event mirror. */
  outputFormat: z
    .enum([
      CLAUDE_OUTPUT_FORMAT.json,
      CLAUDE_OUTPUT_FORMAT.streamJson,
      CLAUDE_OUTPUT_FORMAT.text,
    ])
    .default(CLAUDE_OUTPUT_FORMAT.streamJson),
  /**
   * Permission mode. dsh 0.1.2-alpha.2 advertises five modes
   * (`dontAsk/acceptEdits/auto/plan/bypassPermissions`, default `dontAsk`);
   * zai defaults to `bypassPermissions` because the AgentTool bridge has no
   * UI to answer asks (unattended policy rationale unchanged).
   */
  permissionMode: z
    .enum([
      CLAUDE_PERMISSION_MODE.dontAsk,
      CLAUDE_PERMISSION_MODE.acceptEdits,
      CLAUDE_PERMISSION_MODE.auto,
      CLAUDE_PERMISSION_MODE.plan,
      CLAUDE_PERMISSION_MODE.bypassPermissions,
      CLAUDE_PERMISSION_MODE.default,
    ])
    .default(CLAUDE_PERMISSION_MODE.bypassPermissions),
  /**
   * Fixed native Claude model (dsh `Config.model` parity — optional with no
   * default). When set it is the child default; per-call `request.model`
   * still wins.
   */
  model: z.string().min(1).optional(),
  /** Explicit env overlay; the seam scrubs credential-shaped vars. */
  env: z.record(z.string(), z.string()).default({}),
  /** Tree-kill escalation grace, in ms. */
  disposeGraceMs: z
    .number()
    .int()
    .positive()
    .max(MAX_TIMER_DELAY_MS)
    .default(DISPOSE_GRACE_MS_DEFAULT),
})

export type ClaudeCodeConfig = z.infer<typeof claudeCodeConfigSchema>

export function parseClaudeCodeConfig(input: unknown): ClaudeCodeConfig {
  return claudeCodeConfigSchema.parse(input)
}

export function safeParseClaudeCodeConfig(input: unknown): ClaudeCodeConfig {
  const parsed = claudeCodeConfigSchema.safeParse(input)
  if (parsed.success) return parsed.data
  return claudeCodeConfigSchema.parse({})
}

// Re-export enum value types so callers don't need to import `./wire.js`
// alongside this file.
export type { ClaudeOutputFormat, ClaudePermissionMode }
