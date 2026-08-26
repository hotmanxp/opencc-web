import process from 'node:process'

/**
 * Env vars unconditionally stripped from any subprocess spawned via this seam.
 *
 * `utils/subprocessEnv.ts` already has the same intent but gates the strip on
 * `CLAUDE_CODE_SUBPROCESS_ENV_SCRUB` — gated behavior is right for Bash tool /
 * MCP stdio servers / shell snapshots, where the parent may want ambient
 * passthrough on a developer machine. The codex provider is different:
 *
 *   1. The provider's process tree gets credentials only via explicit `env`
 *      overlay from the deployment config — see `codex/config.ts`. Anything
 *      that arrives via ambient `process.env` is at best unused, at worst a
 *      exfiltration path the runner didn't ask for.
 *   2. Unconditional scrub is what deepseek-harness's `dsh-subprocess` does;
 *      matching that surface keeps the two providers symmetric for ops staff.
 *   3. We do not gate on env vars that the runner could unset before calling
 *      us; the parent process is zai, not an untrusted extension point.
 *
 * The list intentionally mirrors `utils/subprocessEnv.ts:GHA_SUBPROCESS_SCRUB`
 * (so reviewers can audit credentials the codebase already considers
 * sensitive) plus the OpenAI / Codex family's secret-shaped ambient vars.
 * When either list grows, both grow in the same PR.
 */
const CHILD_ENV_STRIP = [
  // Anthropic auth — claude re-reads these per-request; subprocesses don't need them
  'ANTHROPIC_API_KEY',
  'CLAUDE_CODE_OAUTH_TOKEN',
  'ANTHROPIC_AUTH_TOKEN',
  'ANTHROPIC_FOUNDRY_API_KEY',
  'ANTHROPIC_CUSTOM_HEADERS',

  // OTLP exporter headers — Authorization=Bearer tokens for monitoring backends
  'OTEL_EXPORTER_OTLP_HEADERS',
  'OTEL_EXPORTER_OTLP_LOGS_HEADERS',
  'OTEL_EXPORTER_OTLP_METRICS_HEADERS',
  'OTEL_EXPORTER_OTLP_TRACES_HEADERS',

  // Cloud provider creds — same pattern (lazy SDK reads)
  'AWS_SECRET_ACCESS_KEY',
  'AWS_SESSION_TOKEN',
  'AWS_BEARER_TOKEN_BEDROCK',
  'GOOGLE_APPLICATION_CREDENTIALS',
  'AZURE_CLIENT_SECRET',
  'AZURE_CLIENT_CERTIFICATE_PATH',

  // GitHub Actions OIDC / artifact / cache tokens — risk tokens are
  // job-scoped; leaking them via a long-lived child is a supply-chain pivot
  'ACTIONS_ID_TOKEN_REQUEST_TOKEN',
  'ACTIONS_ID_TOKEN_REQUEST_URL',
  'ACTIONS_RUNTIME_TOKEN',
  'ACTIONS_RUNTIME_URL',

  // claude-code-action duplicates — JSON-shaped secret bundles
  'ALL_INPUTS',
  'OVERRIDE_GITHUB_TOKEN',
  'DEFAULT_WORKFLOW_TOKEN',
  'SSH_SIGNING_KEY',

  // OpenAI / Codex / Azure OpenAI family — added by this seam
  'OPENAI_API_KEY',
  'OPENAI_ORG_ID',
  'OPENAI_ADMIN_API_KEY',
  'CODEX_API_KEY',
  'AZURE_OPENAI_API_KEY',
  'AZURE_OPENAI_ENDPOINT',
] as const

const STRIP_SET: ReadonlySet<string> = new Set(CHILD_ENV_STRIP)

/**
 * Compose the env passed to a subprocess spawned via this seam.
 *
 * Contract:
 *   - Starts from `process.env`, **dropping every entry in {@link CHILD_ENV_STRIP}**
 *     unconditionally. A strip list this small is cheap to re-derive and
 *     avoids the `CLAUDE_CODE_SUBPROCESS_ENV_SCRUB` gate (see env.ts header).
 *   - Layers `overlay` on top. Late wins; an entry in both `process.env` and
 *     `overlay` becomes `overlay[k]`. The point: a deployment can set
 *     `OPENAI_API_KEY` for codex via config even though the parent doesn't
 *     carry it ambient.
 *   - Returns a fresh `NodeJS.ProcessEnv`; callers may mutate freely without
 *     affecting the parent.
 *   - `PATH`, `HOME`, `LANG`, `TMPDIR`, `NODE_*` and friends pass through
 *     unfiltered — the OS itself needs them to bootstrap the child.
 */
export function getChildEnv(
  overlay: Readonly<Record<string, string>> = {},
): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {}
  for (const [k, v] of Object.entries(process.env)) {
    if (v === undefined) continue
    if (STRIP_SET.has(k)) continue
    env[k] = v
  }
  for (const [k, v] of Object.entries(overlay)) {
    env[k] = v
  }
  return env
}

/**
 * The sensitive-entry names this seam strips. Exported so tests (and ops
 * dashboards) can assert what's being scrubbed without re-listing the names.
 */
export const STRIPPED_ENV_VARS: ReadonlySet<string> = STRIP_SET
