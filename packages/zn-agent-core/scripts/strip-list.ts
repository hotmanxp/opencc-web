/**
 * UI strip list for copying opencc src/ → zn-agent-core src/.
 *
 * Anything matching these patterns is removed before copy. Anything not
 * matching is copied verbatim.
 */

export const STRIP_DIRS: string[] = [
  // TUI components & primitives
  'components',
  'ink',
  'screens',
  'buddy',
  'assistant',
  'vim',
  'voice',

  // CLI surface — zai uses its own slash command surface, not opencc's
  'cli',
  'commands',

  // UI state store (Zustand React-coupled) — KEPT for now: many opencc
  // files do `import type { AppState } from './state/AppState.js'`, and
  // composite: true makes tsc resolve type-only imports too. Will need a
  // shim/stub in Task 8+ before this can be safely stripped.
  // 'state',

  // Internalizing UI voice bridge
  'services/voice',
  'services/PromptSuggestion',
  'services/MagicDocs',
  'services/wiki',
  'services/extractMemories',
  'services/goal',
  'services/autoDream',
  'services/autoFix',
  'services/SessionMemory',
  'services/teamMemorySync',
  'services/AgentSummary',

  // TTS / voice / SSH / vim-specific
  'ssh',
  'grpc',
  'proto',
  'remote',
  'upstreamproxy',
  'integrations',
  'memdir',
  'outputStyles',
  'proactive',
  'keybindings',
  'moreright',
  'coordinator',
  'native-ts',
  'context',
  'bridge',

  // Computer Use (macOS desktop automation) — zai doesn't expose this
  'utils/computerUse',

  // opencc-specific update / install / housekeeping — zai has its own
  'utils/backgroundHousekeeping',
  'utils/installationInfo',
  'utils/doctorDiagnostic',
  'utils/updateStrategy',
  'utils/autoUpgrade',
  'utils/autoUpdaterRouting',
  'utils/handleAutoUpdate',
  'utils/cleanup',

  // opencc's session migrations and bundled tests — zai has its own
  'migrations',
  '__tests__',
  'test',

  // opencc-specific services that have no consumers in zai (verified by
  // grepping for imports — see Task 6 + Task 7 reports)
  'services/remoteManagedSettings',
  'services/settingsSync',
  'services/github',
]

export const STRIP_TOP_FILES: string[] = [
  // Top-level UI entry points
  'main.tsx',
  'setup.ts',
  'replLauncher.tsx',
  'interactiveHelpers.tsx',
  'dialogLaunchers.tsx',
  'history.ts',  // CLI history, not transcript
  'cli.tsx',     // if exists at top
  'ink.ts',      // top-level TUI re-export
  'commands.ts', // CLI command registry — depends on `commands/` which is stripped
  'services/mcpServerApproval.tsx',  // approval dialog UI
  'utils/exportRenderer.tsx',         // exports UI renderer
  'utils/statusNoticeDefinitions.tsx',// UI status notices
  'utils/claudeInChrome/toolRendering.tsx', // Chrome integration UI
  'utils/semver.ts',                  // optional — uses bun:semver / npm semver
  'utils/task/framework.ts',          // uses AppState UI
  'utils/plugins/performStartupChecks.tsx',
]

/**
 * Glob-style file path patterns to strip. Matched against the POSIX
 * forward-slash path relative to the opencc src root. Use `**` for any
 * number of path segments and `*` for any chars within a segment.
 *
 * Examples:
 *   `**`/UI.tsx           — all UI.tsx files in any subdir
 *   tools/`**`/UI.test.tsx — UI test files in tools/
 *   utils/ink/`**`        — strip the entire ink dir if it sneaks in
 */
export const STRIP_FILE_PATTERNS: string[] = [
  // Tool permission UI dialogs (zai has no permission UI)
  '**/UI.tsx',
  '**/UI.test.tsx',
  '**/UI.types.test.tsx',
  // Tool result message / result UI components
  'tools/BashTool/BashToolResultMessage.tsx',
  // Ink components
  '**/ink/**',
  // React-coupled tsx in services/ (MCP connection manager, security dialog)
  'services/mcp/MCPConnectionManager.tsx',
  'services/mcp/useManageMCPConnections.ts',
  'services/remoteManagedSettings/securityCheck.tsx',
  // NOTE: state/AppState.tsx is KEPT (not stripped) because many zai core
  // files (Task.ts, BashTool.tsx, etc.) and state/*.ts files do
  // `import type { AppState } from './state/AppState.js'`. Stripping it
  // would cascade-fail ~30 imports. The cost is ~34 TS6142 errors (JSX
  // not set) which are fixed in Task 8+ via tsconfig "jsx": "react-jsx".
]

/**
 * Hooks in opencc are mixed: most are React UI hooks (strip), some are
 * core logic (keep). Explicitly listed keepers.
 */
export const KEEP_HOOKS: string[] = [
  'useCanUseTool.tsx',
  'useMergedTools.ts',
  'useMergedClients.ts',
  'useQueueProcessor.ts',
  'useApiKeyVerification.ts',  // might be UI; verify
  'toolPermission/**',
]

export const KEEP_ENTRYPOINTS: string[] = [
  // SDK part of entrypoints — re-export to zai
  'sdk/**',
  'sdk.d.ts',
  'agentSdkTypes.ts',
  'init.ts',
  'sandboxTypes.ts',
]

export const KEEP_SERVICES: string[] = [
  'api/**',
  'mcp/**',
  'compact/**',
  'oauth/**',
  'tools/**',
  'toolUseSummary/**',
  'lsp/**',
  'claudeAiLimits.ts',
  'claudeAiLimitsHook.ts',
  'rateLimitMessages.ts',
  'tokenEstimation.ts',
  'diagnosticTracking.ts',
  'internalLogging.ts',
  'vcr.ts',
  'policyLimits/**',
  'mockRateLimits.ts',
  'rateLimitMocking.ts',
  'analytics/**',
  'notifier.ts',
  'preventSleep.ts',
]
