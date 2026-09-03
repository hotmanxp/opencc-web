import { z } from 'zod/v4'
import {
  DISPOSE_GRACE_MS_DEFAULT,
  MAX_TIMER_DELAY_MS,
} from '../../subprocess/timeouts.js'

/**
 * Deployment-owned configuration for the opencode subagent provider.
 *
 * Mirrors the claude-code / dsh config schemas (zod-validated). `command` is
 * the opencode binary (PATH name or absolute path); `args` is the argv head
 * inserted before the model flag and the positional prompt. The provider
 * always requests JSON output, so the default args pin `run --format json`.
 *
 * opencode installation, model/provider routing, credentials, and login are
 * native opencode concerns, NOT touched here — zai only spawns the CLI and
 * parses its stream.
 */
export const opencodeConfigSchema = z.object({
  /** Master switch — zai only registers the provider when `enabled: true`. */
  enabled: z.boolean().default(false),
  /** Binary on PATH. Defaults to `opencode` (the canonical CLI). */
  command: z.string().min(1).default('opencode'),
  /**
   * Args head before the model flag + positional prompt. Default runs the
   * headless one-shot JSON loop.
   */
  args: z.array(z.string().min(1)).default(['run', '--format', 'json']),
  /**
   * Fixed model (`provider/model`). dsh parity: this is the deployment
   * default; a per-call `request.model` still wins. Omitted → CLI default.
   */
  model: z.string().min(1).optional(),
  /** Explicit env overlay; the seam scrubs credential-shaped vars. */
  env: z.record(z.string(), z.string()).default({}),
  /** SIGTERM → SIGKILL escalation grace for the child tree, in ms. */
  disposeGraceMs: z
    .number()
    .int()
    .positive()
    .max(MAX_TIMER_DELAY_MS)
    .default(DISPOSE_GRACE_MS_DEFAULT),
})

export type OpencodeConfig = z.infer<typeof opencodeConfigSchema>

export function parseOpencodeConfig(input: unknown): OpencodeConfig {
  return opencodeConfigSchema.parse(input)
}

export function safeParseOpencodeConfig(input: unknown): OpencodeConfig {
  const parsed = opencodeConfigSchema.safeParse(input)
  if (parsed.success) return parsed.data
  return opencodeConfigSchema.parse({})
}
