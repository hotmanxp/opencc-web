// SDK entry point - re-exports from agentSdkTypes
// All exports here must match src/entrypoints/sdk.d.ts (drift caught by
// scripts/validate-externals.ts).

// Runtime implementations from agentSdkTypes
export {
  createSdkMcpServer,
  forkSession,
  getSessionInfo,
  getSessionMessages,
  listSessions,
  query,
  queryAsync,
  renameSession,
  tagSession,
  tool,
  unstable_v2_createSession,
  unstable_v2_prompt,
  unstable_v2_resumeSession,
} from '../agentSdkTypes.js'

// Control protocol types
export type { SDKControlInitializeResponse } from './controlTypes.js'

// Core generated types
export type {
  AccountInfo,
  AgentInfo,
  ApiKeySource,
  FastModeState,
  McpServerStatus,
  ModelInfo,
  PermissionResult,
  RewindFilesResult,
  SDKMessage,
  SDKResultMessage,
  SDKSessionInfo,
  SDKUserMessage,
  SlashCommand,
} from './coreTypes.generated.js'

// Permission types
export type { PermissionResolveDecision } from './permissions.js'

// Runtime types
export type { Query, SDKSession, SDKSessionOptions, SdkMcpToolDefinition } from './runtimeTypes.js'

// Shared types
export type {
  ForkSessionOptions,
  ForkSessionResult,
  GetSessionInfoOptions,
  GetSessionMessagesOptions,
  ListSessionsOptions,
  QueryPermissionMode,
  SDKAgentLoadFailureMessage,
  SDKPermissionRequestMessage,
  SDKPermissionTimeoutMessage,
  SessionMessage,
  SessionMutationOptions,
} from './shared.js'

// Error classes
export {
  AbortError,
  ClaudeError,
  SDKAssistantMessageError,
  SDKAuthenticationError,
  SDKBillingError,
  SDKError,
  SDKInvalidRequestError,
  SDKMaxOutputTokensError,
  SDKRateLimitError,
  SDKServerError,
  sdkErrorFromType,
} from '../../utils/errors.js'

// Stub types declared in sdk.d.ts but not yet in source
export type {
  QueryOptions,
  SdkMcpStdioConfig,
  SdkMcpSSEConfig,
  SdkMcpHttpConfig,
  SdkMcpSdkConfig,
  SdkMcpServerConfig,
  SdkScopedMcpServerConfig,
} from './sdkTypes.js'

// Runtime deleteSession
export { deleteSession } from '../../utils/sessionPersistence.js'