import { z } from 'zod/v4'
import { DSH_DEFAULT_PROFILE } from './wire.js'
import {
  DISPOSE_GRACE_MS_DEFAULT,
  MAX_TIMER_DELAY_MS,
} from '../../subprocess/timeouts.js'

/**
 * Deployment-owned configuration for the DeepSeek Harness (dsh) subagent
 * provider. Field names and defaults mirror dsh's own
 * `@deepseek-ai/dsh-subagent-dsh-sdk` Config
 * (`subagent-dsh-sdk/src/index.ts:34-93`) and the SDK client's launch
 * options (`sdk/client/src/launch.ts:128-157`), adapted to zai's
 * CLI-command style (same shape as the codex provider's config).
 */
export const dshConfigSchema = z.object({
  /** Master switch — zai only registers the provider when `enabled: true`. */
  enabled: z.boolean().default(false),
  /**
   * dsh executable. dsh's SDK client resolves `@deepseek-ai/dsh`'s bin
   * itself; zai keeps this operator-owned (PATH name or absolute path),
   * matching the claude-code/codex `command` convention.
   */
  command: z.string().min(1).default('dsh'),
  /**
   * Base args inserted before `--profile` (launcher indirection, e.g.
   * `command: node, args: ['/path/to/dsh']`). Default empty — same shape as
   * the claude-code / codex `args` field.
   */
  args: z.array(z.string().min(1)).default([]),
  /** Cordis profile to launch (dsh default: 'sdk' — the JSON-RPC runtime). */
  profile: z.string().min(1).default(DSH_DEFAULT_PROFILE),
  /** Profile patches appended as repeated `--patch <path>` args. */
  patches: z.array(z.string().min(1)).default([]),
  /** DSH_HOME for the child. dsh requires an absolute path (`index.ts:187`). */
  dshHome: z.string().min(1).refine((v) => v.startsWith('/'), {
    message: 'dsh: `dshHome` must be an absolute path',
  }).optional(),
  /** Default child LLM provider route. */
  provider: z.string().min(1).default('deepseek-official'),
  /** Default child model route. */
  model: z.string().min(1).default('deepseek-v4-flash'),
  /** Optional adapter-owned reasoning effort. */
  reasoningEffort: z.string().min(1).optional(),
  /** Optional positive output cap. */
  maxTokens: z.number().int().positive().optional(),
  /** Explicit env overlay; the seam scrubs credential-shaped vars. */
  env: z.record(z.string(), z.string()).default({}),
  /** Bound for the child to answer `initialize` (dsh DEFAULT_INITIALIZE_TIMEOUT_MS). */
  initializeTimeoutMs: z
    .number()
    .int()
    .positive()
    .max(MAX_TIMER_DELAY_MS)
    .default(10_000),
  /** Optional per-request timeout for later wire calls (`session/prompt`). */
  requestTimeoutMs: z
    .number()
    .int()
    .positive()
    .max(MAX_TIMER_DELAY_MS)
    .optional(),
  /** Bound for the best-effort `shutdown` request before the kill ladder. */
  shutdownTimeoutMs: z
    .number()
    .int()
    .positive()
    .max(MAX_TIMER_DELAY_MS)
    .default(1_000),
  /** SIGTERM → SIGKILL escalation grace for the child tree. */
  disposeGraceMs: z
    .number()
    .int()
    .positive()
    .max(MAX_TIMER_DELAY_MS)
    .default(DISPOSE_GRACE_MS_DEFAULT),
})

export type DshConfig = z.infer<typeof dshConfigSchema>

export function parseDshConfig(input: unknown): DshConfig {
  return dshConfigSchema.parse(input)
}

export function safeParseDshConfig(input: unknown): DshConfig {
  const parsed = dshConfigSchema.safeParse(input)
  if (parsed.success) return parsed.data
  return dshConfigSchema.parse({})
}
