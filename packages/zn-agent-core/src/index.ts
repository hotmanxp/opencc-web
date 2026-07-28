// @zn-ai/zn-agent-core
export const VERSION = '0.1.0'
export * from './compat/permissions.js'
export * from './compat/permissionMode.js'
export * from './compat/commands/index.js'
export {
  setDefaultSandboxManager,
  getDefaultSandboxManager,
} from './compat/sandboxManager.js'
export { RequestApproveTool } from './compat/requestApproveTool/RequestApproveTool.js'
export { REQUEST_APPROVE_TOOL_NAME } from './compat/requestApproveTool/prompt.js'
export type { RequestApproveInput, RequestApproveOutput } from './compat/requestApproveTool/schema.js'
// Runtime types (Batch 1: pure types/constants)
export type {
  AskRegistryLike,
  ApproveRegistryLike,
  ModelCaller,
  QueryOptions,
  RuntimeConfig,
  SandboxConfig,
  SystemPrompt,
  Tool,
  UserMessage,
  PluginRuntime,
  PluginRuntimeConfig,
} from './compat/runtime/types.js'
export type { AskUserAnswers } from './compat/runtime/types.js'

// Runtime event contract (Batch 2a)
export type {
  ErrorCategory,
  RuntimeEvent,
  RuntimeErrorEvent,
  RuntimeDoneEvent,
  RuntimeAbortedEvent,
} from './compat/runtime/events.js'

// Background runtime (Batch 2a: persistence + scheduler compat shims)
export * from './compat/background/index.js'

// MCP client pool + related (Batch 2b)
export * from './compat/mcp/index.js'
