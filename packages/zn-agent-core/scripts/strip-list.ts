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
  'settingsSync/**',
  'remoteManagedSettings/**',
  'github/**',
  'mcpServerApproval.tsx',  // verify UI vs core
  'notifier.ts',
  'preventSleep.ts',
]
