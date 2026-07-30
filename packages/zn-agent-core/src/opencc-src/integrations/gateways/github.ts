import { defineGateway } from '../define.js'

/**
 * GitHub Copilot has a special native-Claude path for Claude models.
 * When the model string contains "claude-", the runtime routes through
 * the native Anthropic path instead of the OpenAI shim to enable prompt
 * caching. This exception is handled in openaiShim.ts and providers.ts
 * and must be preserved during migration.
 *
 * @see src/utils/model/providers.ts — isGithubNativeAnthropicMode()
 * @see src/services/api/openaiShim.ts — getGithubEndpointType()
 *
 * ## Premium Request Optimization
 *
 * GitHub Copilot tracks "Premium Requests" per billing cycle, with the exact
 * quota set by the user's Copilot plan (not a property of this runtime).
 * Each HTTP request to api.githubcopilot.com counts toward this quota.
 * OpenCC's sub-agent architecture can consume multiple Premium Requests
 * per chat interaction (one per agent per turn), rapidly depleting the quota.
 *
 * By default, when CLAUDE_CODE_USE_GITHUB=1 is active, OpenCC limits
 * sub-agents to synchronous in-process execution (max 1 concurrent) to mitigate
 * Premium Request consumption (mitigates #678). Configure these env vars to tune behaviour:
 *
 *   GITHUB_COPILOT_MAX_SUBAGENTS=0          Disable sub-agents entirely (most conservative)
 *   GITHUB_COPILOT_MAX_SUBAGENTS=1          One sub-agent at a time (default when unset)
 *   GITHUB_COPILOT_ALLOW_SUBAGENTS=1        Re-enable background/parallel sub-agents
 *   GITHUB_COPILOT_FORCE_SYNC_SUBAGENTS=1   Force all sub-agents to run synchronously
 *   GITHUB_COPILOT_OPTIMIZATION_DISABLED=1  Turn off all Copilot optimizations
 *
 * @see src/utils/copilotOptimization.ts
 */
export default defineGateway({
  id: 'github',
  label: 'GitHub Copilot',
  vendorId: 'openai',
  category: 'hosted',
  defaultBaseUrl: 'https://api.githubcopilot.com',
  supportsModelRouting: true,
  setup: {
    requiresAuth: true,
    authMode: 'token',
    credentialEnvVars: ['GITHUB_TOKEN', 'GH_TOKEN'],
  },
  transportConfig: {
    kind: 'openai-compatible',
    openaiShim: {
      supportsAuthHeaders: true,
      maxTokensField: 'max_tokens',
    },
  },
  validation: {
    kind: 'github-token',
    routing: {
      enablementEnvVar: 'CLAUDE_CODE_USE_GITHUB',
      skipWhenUseOpenAI: true,
    },
    missingCredentialMessage:
      'GitHub Copilot authentication required.\nRun /onboard-github in the CLI to sign in with your GitHub account.\nThis will store your OAuth token securely and enable Copilot models.',
    expiredCredentialMessage:
      'GitHub Copilot token has expired.\nRun /onboard-github to sign in again and get a fresh token.',
    invalidCredentialMessage:
      'GitHub Copilot token is invalid or corrupted.\nRun /onboard-github to sign in again with your GitHub account.',
  },
  catalog: {
    source: 'static',
    models: [
      { id: 'github-claude-sonnet', apiName: 'claude-sonnet-4-6', label: 'Claude Sonnet (GitHub)', modelDescriptorId: 'claude-sonnet-4-6' },
      { id: 'github-gpt-4o', apiName: 'gpt-4o', label: 'GPT-4o (GitHub)', modelDescriptorId: 'gpt-4o' },
    ],
  },
  usage: { supported: false },
})
