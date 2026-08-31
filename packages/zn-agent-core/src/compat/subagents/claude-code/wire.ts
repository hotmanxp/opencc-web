/**
 * Anthropic Claude Code CLI vocabulary.
 *
 * The Claude Code product uses a richer protocol than Codex's — there's no
 * fixed JSON-RPC surface to mirror. Instead the CLI exposes a `--print`
 * (one-shot non-interactive) entrypoint with a few output formats:
 *
 *   `--output-format json`        Single JSON object on stdout:
 *                                 { type: "result", result, ... }
 *                                 Easiest to parse for unattended delegation.
 *
 *   `--output-format stream-json` Line-delimited JSON events (matches the
 *                                 per-message stream format the SDK uses).
 *                                 Useful when the bridge layer wants
 *                                 per-message SSE updates.
 *                                 **Requires `--verbose`** — the CLI rejects
 *                                 `--output-format=stream-json` without it,
 *                                 which would surface as "produced no
 *                                 assistant messages before settling". The
 *                                 provider adds `--verbose` automatically
 *                                 in {@link run.ts:claudeSpawnArgv}.
 *
 *   `--output-format text`       Plain text on stdout (the default).
 *
 * The provider here defaults to `stream-json` because the bridge mirrors
 * the same per-event loop as codex — every assistant / tool_use / tool_result
 * line maps to a `SubagentEvent`. `json` is offered as a tier-2 fallback
 * when the deployment wants a single-frame answer with no streaming.
 *
 * Permission model:
 *   - `--permission-mode bypassPermissions` runs unattended with no
 *     permission asks. The unattended policy is the same shape as codex:
 *     no UI is offered, hooks cannot pause for human input.
 *   - `--permission-mode plan` requires the model to plan before executing
 *     tools. Default for unattended is `bypassPermissions` since we
 *     explicitly have no UI.
 */

export const CLAUDE_OUTPUT_FORMAT = {
  json: 'json',
  streamJson: 'stream-json',
  text: 'text',
} as const

export type ClaudeOutputFormat =
  (typeof CLAUDE_OUTPUT_FORMAT)[keyof typeof CLAUDE_OUTPUT_FORMAT]

export const CLAUDE_PERMISSION_MODE = {
  // dsh 0.1.2-alpha.2 alignment (`subagent-claude-code/src/run.ts:44-53`):
  // dontAsk / auto are the newer unattended-friendly modes; `default` is
  // kept as a zai legacy value.
  dontAsk: 'dontAsk',
  acceptEdits: 'acceptEdits',
  auto: 'auto',
  plan: 'plan',
  bypassPermissions: 'bypassPermissions',
  default: 'default',
} as const

export type ClaudePermissionMode =
  (typeof CLAUDE_PERMISSION_MODE)[keyof typeof CLAUDE_PERMISSION_MODE]

/** Final-shape emitted by `--output-format json`. Single frame on stdout. */
export interface ClaudeJsonResult {
  type: 'result'
  /** Final assistant message text — the product analog of Codex's `phase: "final_answer"`. */
  result: string
  /** Total input + output tokens. Optional — the CLI may emit this. */
  usage?: {
    input_tokens?: number
    output_tokens?: number
  }
  /** Set when the run finished without producing a `result`. */
  is_error?: boolean
  /** Truncated subject when errors land. */
  error?: string
}

/** Per-line shape emitted by `--output-format stream-json`. */
export interface ClaudeStreamEvent {
  type: 'assistant' | 'user' | 'tool_use' | 'tool_result' | 'system' | 'result'
  /** Pretty raw content; the `run.ts` layer projects to a SubagentEvent. */
  [k: string]: unknown
}

/** Args shape for spawning `claude --print`. */
export interface ClaudeSpawnArgs {
  /** Required: the prompt text. */
  prompt: string
  /** Absolute cwd for the child. */
  cwd: string
  /** Stream-json for event-by-event SubagentEvent; json for single-frame. */
  outputFormat: ClaudeOutputFormat
  /** Permission mode; default `bypassPermissions` for unattended runs. */
  permissionMode: ClaudePermissionMode
  /** Optional model id override. */
  model?: string
  /** Optional extra args passed through verbatim (callers may not need). */
  extraArgs?: readonly string[]
}
