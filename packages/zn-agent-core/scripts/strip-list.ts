/**
 * UI strip list for copying opencc src/ → zn-agent-core src/.
 *
 * Anything matching these patterns is removed before copy. Anything not
 * matching is copied verbatim.
 */

export const STRIP_DIRS: string[] = [
  // TUI components & primitives
  'src/components',
  'src/ink',
  'src/screens',
  'src/buddy',
  'src/assistant',
  'src/vim',
  'src/voice',

  // Internalizing UI voice bridge
  'src/services/voice',
  'src/services/PromptSuggestion',
  'src/services/MagicDocs',
  'src/services/wiki',
  'src/services/extractMemories',
  'src/services/goal',
  'src/services/autoDream',
  'src/services/autoFix',
  'src/services/SessionMemory',
  'src/services/teamMemorySync',
  'src/services/AgentSummary',

  // TTS / voice / SSH / vim-specific
  'src/ssh',
  'src/grpc',
  'src/proto',
  'src/remote',
  'src/upstreamproxy',
  'src/integrations',
  'src/memdir',
  'src/outputStyles',
  'src/proactive',
  'src/keybindings',
  'src/moreright',
  'src/coordinator',
  'src/native-ts',
  'src/context',
  'src/bridge',
]

export const STRIP_TOP_FILES: string[] = [
  // Top-level UI entry points
  'src/main.tsx',
  'src/setup.ts',
  'src/replLauncher.tsx',
  'src/interactiveHelpers.tsx',
  'src/dialogLaunchers.tsx',
  'src/history.ts',  // CLI history, not transcript
  'src/cli.tsx',     // if exists at top
]

/**
 * Hooks in opencc are mixed: most are React UI hooks (strip), some are
 * core logic (keep). Explicitly listed keepers.
 */
export const KEEP_HOOKS: string[] = [
  'src/hooks/useCanUseTool.tsx',
  'src/hooks/useMergedTools.ts',
  'src/hooks/useMergedClients.ts',
  'src/hooks/useQueueProcessor.ts',
  'src/hooks/useApiKeyVerification.ts',  // might be UI; verify
  'src/hooks/toolPermission/**',
]

export const KEEP_ENTRYPOINTS: string[] = [
  // SDK part of entrypoints — re-export to zai
  'src/entrypoints/sdk/**',
  'src/entrypoints/sdk.d.ts',
  'src/entrypoints/agentSdkTypes.ts',
  'src/entrypoints/init.ts',
  'src/entrypoints/sandboxTypes.ts',
]

export const KEEP_SERVICES: string[] = [
  'src/services/api/**',
  'src/services/mcp/**',
  'src/services/compact/**',
  'src/services/oauth/**',
  'src/services/tools/**',
  'src/services/toolUseSummary/**',
  'src/services/lsp/**',
  'src/services/claudeAiLimits.ts',
  'src/services/claudeAiLimitsHook.ts',
  'src/services/rateLimitMessages.ts',
  'src/services/tokenEstimation.ts',
  'src/services/diagnosticTracking.ts',
  'src/services/internalLogging.ts',
  'src/services/vcr.ts',
  'src/services/policyLimits/**',
  'src/services/mockRateLimits.ts',
  'src/services/rateLimitMocking.ts',
  'src/services/analytics/**',
  'src/services/settingsSync/**',
  'src/services/remoteManagedSettings/**',
  'src/services/github/**',
  'src/services/mcpServerApproval.tsx',  // verify UI vs core
  'src/services/notifier.ts',
  'src/services/preventSleep.ts',
]
