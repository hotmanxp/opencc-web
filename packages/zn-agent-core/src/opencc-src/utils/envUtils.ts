import memoize from 'lodash-es/memoize.js'
import { existsSync } from 'fs'
import { homedir } from 'os'
import { join } from 'path'

export function resolveClaudeConfigHomeDir(options?: {
  configDirEnv?: string
  homeDir?: string
  openClaudeExists?: boolean
  legacyClaudeExists?: boolean
}): string {
  if (options?.configDirEnv) {
    return options.configDirEnv.normalize('NFC')
  }

  const homeDir = options?.homeDir ?? homedir()
  const openClaudeDir = join(homeDir, '.claude')
  const legacyClaudeDir = join(homeDir, '.claude')
  const openClaudeExists =
    options?.openClaudeExists ?? existsSync(openClaudeDir)
  const legacyClaudeExists =
    options?.legacyClaudeExists ?? existsSync(legacyClaudeDir)

  // Preserve existing user config/install state until we ship an explicit
  // migration. New installs (neither path exists) use ~/.claude.
  if (!openClaudeExists && legacyClaudeExists) {
    return legacyClaudeDir.normalize('NFC')
  }

  return openClaudeDir.normalize('NFC')
}

/**
 * Resolves the override env value for the config home directory.
 * `OPENCC_CONFIG_DIR` is preferred — `CLAUDE_CONFIG_DIR` is the legacy
 * Anthropic name kept working for backward compatibility. When both are
 * set and disagree, `OPENCC_CONFIG_DIR` wins and we warn once so the user
 * can clean up. Exported for tests.
 */
let warnedAboutConflictingConfigDirEnvs = false

export function resolveConfigDirEnv(options?: {
  openccConfigDir?: string
  legacyConfigDir?: string
  warn?: (message: string) => void
}): string | undefined {
  const open = options?.openccConfigDir
  const legacy = options?.legacyConfigDir
  if (open && legacy && open !== legacy && !warnedAboutConflictingConfigDirEnvs) {
    const message = `Both OPENCC_CONFIG_DIR and CLAUDE_CONFIG_DIR are set to different values. Using OPENCC_CONFIG_DIR=${open}; ignoring CLAUDE_CONFIG_DIR=${legacy}.`
    if (options?.warn) {
      warnedAboutConflictingConfigDirEnvs = true
      options.warn(message)
    }
  }
  return open || legacy || undefined
}

/**
 * Test-only escape hatch — resets the once-per-process conflict warning so
 * unit tests can re-trigger it.
 */
export function __resetConfigDirEnvWarningForTesting(): void {
  warnedAboutConflictingConfigDirEnvs = false
}

let claudeConfigHomeDirOverride: string | undefined

export function setClaudeConfigHomeDirForTesting(
  configDir: string | undefined,
): void {
  claudeConfigHomeDirOverride = configDir?.normalize('NFC')
}

export function getClaudeConfigHomeDirOverrideForTesting(): string | undefined {
  return claudeConfigHomeDirOverride
}

// Memoized: 150+ callers, many on hot paths. Keyed off both override env
// vars so tests that change either get a fresh value without explicit
// cache.clear.
export const getClaudeConfigHomeDir = memoize(
  (): string => resolveClaudeConfigHomeDir({
    configDirEnv: resolveConfigDirEnv({
      openccConfigDir: process.env.OPENCC_CONFIG_DIR,
      legacyConfigDir: process.env.CLAUDE_CONFIG_DIR,
      warn: message => {
        // eslint-disable-next-line no-console
        console.warn(`[opencc] ${message}`)
      },
    }),
  }),
  () =>
    `${process.env.OPENCC_CONFIG_DIR ?? ''}\0${process.env.CLAUDE_CONFIG_DIR ?? ''}`,
)

export function getTeamsDir(): string {
  return join(getClaudeConfigHomeDir(), 'teams')
}

export function getProjectsDir(): string {
  return join(getClaudeConfigHomeDir(), 'projects')
}

export function getUserAgentsDir(): string {
  const homeDir = homedir()
  return join(homeDir, '.agents')
}

/**
 * Check if NODE_OPTIONS contains a specific flag.
 * Splits on whitespace and checks for exact match to avoid false positives.
 */
export function hasNodeOption(flag: string): boolean {
  const nodeOptions = process.env.NODE_OPTIONS
  if (!nodeOptions) {
    return false
  }
  return nodeOptions.split(/\s+/).includes(flag)
}

export function isEnvTruthy(envVar: string | boolean | undefined): boolean {
  if (!envVar) return false
  if (typeof envVar === 'boolean') return envVar
  const normalizedValue = envVar.toLowerCase().trim()
  return ['1', 'true', 'yes', 'on'].includes(normalizedValue)
}

/**
 * Runtime feature flag — checked at execution time via environment variable.
 * Unlike build-time feature() from bun:bundle, these can be toggled without rebuilding.
 * Env var format: CLAUDE_CODE_<FLAG_NAME>=0 to disable, any truthy value to enable.
 * Features not in DEFAULT_TRUE_LIST return false when env var is not set.
 * Features in DEFAULT_TRUE_LIST return true when env var is not set.
 */
const DEFAULT_TRUE_RUNTIME_FEATURES: readonly string[] = ['MCP_SKILLS', 'HISTORY_SNIP']

export function runtimeFeature(name: string): boolean {
  if (DEFAULT_TRUE_RUNTIME_FEATURES.includes(name)) {
    // Default-true feature: enabled unless explicitly disabled
    const envVar = process.env[`CLAUDE_CODE_${name}`]
    if (envVar === undefined) return true
    return isEnvTruthy(envVar)
  }
  return isEnvTruthy(process.env[`CLAUDE_CODE_${name}`])
}

export function isEnvDefinedFalsy(
  envVar: string | boolean | undefined,
): boolean {
  if (envVar === undefined) return false
  if (typeof envVar === 'boolean') return !envVar
  if (!envVar) return false
  const normalizedValue = envVar.toLowerCase().trim()
  return ['0', 'false', 'no', 'off'].includes(normalizedValue)
}

/**
 * --bare / CLAUDE_CODE_SIMPLE — skip hooks, LSP, plugin sync, skill dir-walk,
 * attribution, background prefetches, and ALL keychain/credential reads.
 * Auth is strictly ANTHROPIC_API_KEY env or apiKeyHelper from --settings.
 * Explicit CLI flags (--plugin-dir, --add-dir, --mcp-config) still honored.
 * ~30 gates across the codebase.
 *
 * Checks argv directly (in addition to the env var) because several gates
 * run before main.tsx's action handler sets CLAUDE_CODE_SIMPLE=1 from --bare
 * — notably startKeychainPrefetch() at main.tsx top-level.
 */
export function isBareMode(): boolean {
  return (
    isEnvTruthy(process.env.CLAUDE_CODE_SIMPLE) ||
    process.argv.includes('--bare')
  )
}

/**
 * Parses an array of environment variable strings into a key-value object
 * @param envVars Array of strings in KEY=VALUE format
 * @returns Object with key-value pairs
 */
export function parseEnvVars(
  rawEnvArgs: string[] | undefined,
): Record<string, string> {
  const parsedEnv: Record<string, string> = {}

  // Parse individual env vars
  if (rawEnvArgs) {
    for (const envStr of rawEnvArgs) {
      const [key, ...valueParts] = envStr.split('=')
      if (!key || valueParts.length === 0) {
        throw new Error(
          `Invalid environment variable format: ${envStr}, environment variables should be added as: -e KEY1=value1 -e KEY2=value2`,
        )
      }
      parsedEnv[key] = valueParts.join('=')
    }
  }
  return parsedEnv
}

/**
 * Get the AWS region with fallback to default
 * Matches the Anthropic Bedrock SDK's region behavior
 */
export function getAWSRegion(): string {
  return process.env.AWS_REGION || process.env.AWS_DEFAULT_REGION || 'us-east-1'
}

/**
 * Get the default Vertex AI region
 */
export function getDefaultVertexRegion(): string {
  return process.env.CLOUD_ML_REGION || 'us-east5'
}

/**
 * Check if bash commands should maintain project working directory (reset to original after each command)
 * @returns true if CLAUDE_BASH_MAINTAIN_PROJECT_WORKING_DIR is set to a truthy value
 */
export function shouldMaintainProjectWorkingDir(): boolean {
  return isEnvTruthy(process.env.CLAUDE_BASH_MAINTAIN_PROJECT_WORKING_DIR)
}

/**
 * Check if running on Homespace (ant-internal cloud environment)
 */
export function isRunningOnHomespace(): boolean {
  return (
    process.env.USER_TYPE === 'ant' &&
    isEnvTruthy(process.env.COO_RUNNING_ON_HOMESPACE)
  )
}

/**
 * Conservative check for whether OpenCC is running inside a protected
 * (privileged or ASL3+) COO namespace or cluster.
 *
 * Conservative means: when signals are ambiguous, assume protected. We would
 * rather over-report protected usage than miss it. Unprotected environments
 * are homespace, namespaces on the open allowlist, and no k8s/COO signals
 * at all (laptop/local dev).
 *
 * Used for telemetry to measure auto-mode usage in sensitive environments.
 */
export function isInProtectedNamespace(): boolean {
  // USER_TYPE is build-time --define'd; in external builds this block is
  // DCE'd so the require() and namespace allowlist never appear in the bundle.
  if (process.env.USER_TYPE === 'ant') {
    /* eslint-disable @typescript-eslint/no-require-imports */
    return (
      require('./protectedNamespace.js') as typeof import('./protectedNamespace.js')
      // @ts-ignore - missing argument
    ).isProtectedNamespace()
    /* eslint-enable @typescript-eslint/no-require-imports */
  }
  return false
}

// @[MODEL LAUNCH]: Add a Vertex region override env var for the new model.
/**
 * Model prefix → env var for Vertex region overrides.
 * Order matters: more specific prefixes must come before less specific ones
 * (e.g., 'claude-opus-4-1' before 'claude-opus-4').
 */
const VERTEX_REGION_OVERRIDES: ReadonlyArray<[string, string]> = [
  ['claude-haiku-4-5', 'VERTEX_REGION_CLAUDE_HAIKU_4_5'],
  ['claude-3-5-haiku', 'VERTEX_REGION_CLAUDE_3_5_HAIKU'],
  ['claude-3-5-sonnet', 'VERTEX_REGION_CLAUDE_3_5_SONNET'],
  ['claude-3-7-sonnet', 'VERTEX_REGION_CLAUDE_3_7_SONNET'],
  ['claude-opus-4-1', 'VERTEX_REGION_CLAUDE_4_1_OPUS'],
  ['claude-opus-4', 'VERTEX_REGION_CLAUDE_4_0_OPUS'],
  ['claude-sonnet-4-6', 'VERTEX_REGION_CLAUDE_4_6_SONNET'],
  ['claude-sonnet-4-5', 'VERTEX_REGION_CLAUDE_4_5_SONNET'],
  ['claude-sonnet-4', 'VERTEX_REGION_CLAUDE_4_0_SONNET'],
]

/**
 * Get the Vertex AI region for a specific model.
 * Different models may be available in different regions.
 */
export function getVertexRegionForModel(
  model: string | undefined,
): string | undefined {
  if (model) {
    const match = VERTEX_REGION_OVERRIDES.find(([prefix]) =>
      model.startsWith(prefix),
    )
    if (match) {
      return process.env[match[1]] || getDefaultVertexRegion()
    }
  }
  return getDefaultVertexRegion()
}

// ---------------------------------------------------------------------------
// OpenCC Dynamic Workflows — env var helpers
// ---------------------------------------------------------------------------
// Runtime knobs for the WorkflowTool. Mirrored in settings.workflows.* so
// users can pin them in .claude/settings.json instead of exporting env vars.
// Either source opts in (truthy env var OR settings.workflows.enabled === true).

/**
 * Whether OpenCC dynamic workflows are disabled.
 *
 * Workflows default to DISABLED — users opt in explicitly via either:
 * - OPENCC_ENABLE_WORKFLOWS is a truthy env var (1/true/yes/on)
 * - settings.workflows?.enabled === true
 *
 * Returns true when NEITHER opt-in source is present. This is the inverse
 * of the legacy "disable" kill switch (OPENCC_DISABLE_WORKFLOWS / settings
 * .disableWorkflows), which has been removed; see the 2026-06-27
 * opt-in-by-default migration.
 */
export function isWorkflowsDisabled(): boolean {
  if (isEnvTruthy(process.env.OPENCC_ENABLE_WORKFLOWS)) {
    return false
  }
  try {
    // Lazy require: breaks the envUtils ↔ settings circular import.
    // envUtils.ts and settings.ts mutually import each other at module top
    // level; touching settings.ts from a static import here would put
    // getClaudeConfigHomeDir in TDZ whenever something deep in the tool
    // graph (e.g. AgentTool) calls into settings.ts during its own
    // evaluation. require() defers the binding until the function runs,
    // which is always after the module graph finishes loading.
    const { getInitialSettings } = require('./settings/settings.js') as typeof import('./settings/settings.js')
    const settings = getInitialSettings()
    if (settings.workflows?.enabled === true) {
      return false
    }
  } catch {
    // getInitialSettings can throw during early bootstrap (settings files
    // unreadable, JSON parse error, etc.). Default to "disabled" (the new
    // opt-in default) so a misconfigured bootstrap doesn't accidentally
    // turn on a feature the user didn't ask for.
  }
  return true
}

/**
 * Per-workflow execution timeout in milliseconds.
 *
 * Sources, in priority order:
 * 1. OPENCC_WORKFLOW_TIMEOUT_MS env var (positive integer)
 * 2. WORKFLOW_DEFAULTS.defaultTimeoutMs (30 minutes) — defined in
 *    src/tools/WorkflowTool/constants.ts.
 */
export function getWorkflowTimeoutMs(): number {
  const raw = process.env.OPENCC_WORKFLOW_TIMEOUT_MS
  const parsed = Number(raw)
  if (raw !== undefined && Number.isFinite(parsed) && parsed > 0) {
    return parsed
  }
  // Mirrors WORKFLOW_DEFAULTS.defaultTimeoutMs from WorkflowTool/constants.ts.
  // Duplicated to keep envUtils.ts free of a tool-layer import (would create
  // a settings ↔ tool cycle once the tool starts reading settings).
  return 30 * 60 * 1000
}

/**
 * Hard ceiling on total agents a single workflow may spawn.
 *
 * Sources, in priority order:
 * 1. OPENCC_WORKFLOW_MAX_AGENTS env var (positive integer)
 * 2. WORKFLOW_DEFAULTS.maxTotalAgents (1000) — defined in
 *    src/tools/WorkflowTool/constants.ts.
 */
export function getWorkflowMaxAgents(): number {
  const raw = process.env.OPENCC_WORKFLOW_MAX_AGENTS
  const parsed = Number(raw)
  if (raw !== undefined && Number.isFinite(parsed) && parsed > 0) {
    return parsed
  }
  // Mirrors WORKFLOW_DEFAULTS.maxTotalAgents — see getWorkflowTimeoutMs.
  return 1000
}

/**
 * Custom trigger keyword that activates a workflow from a user prompt.
 * Defaults to "ultracode" (the same default baked into the WorkflowTool).
 */
export function getWorkflowKeyword(): string {
  return process.env.OPENCC_WORKFLOW_KEYWORD || 'ultracode'
}
