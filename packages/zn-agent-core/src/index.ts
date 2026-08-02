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
export { enableOpenccConfigs } from './compat/openccInit.js'
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

// Plugin runtime (Batch 2c)
export * from './compat/plugins/index.js'

// DefaultAgentRuntime (Batch 2d) — removed in Task 6. The new server
// runtime (`@zn-ai/zn-agent-core/opencc-server`) replaces the
// `DefaultAgentRuntime` path entirely; callers migrated in
// commit da4c50e5 (Task 5). The `AgentRuntime` interface itself
// is preserved for back-compat re-export.
// (no more exports here)

// TranscriptStore (compat) — removed in Task 6. The new server
// runtime's `sessionFacade` owns session/transcript; the compat
// helpers in `transcript/persistence.ts` keep a structural
// `TranscriptStore` interface so the pre-existing zai test imports
// (broken path, 5/189 baseline) still compile.
//
// Re-export a no-op stub class for zai callers (route handlers,
// test mocks) that still instantiate `new TranscriptStore(dataDir)`.
export { TranscriptStore } from './compat/runtime/legacyTranscriptStore.js'

// Data directory helpers
export { resolveDataDir } from './compat/data/dataDir.js'
export type { DataDirConfig } from './compat/data/dataDir.js'

// Skills runtime (Batch 3a)
export * from './compat/runtime/skills-index.js'

// Default tool registry (Phase 4): buildDefaultTools() returns the chat-path
// tool set (Bash/Read/Edit/Write/AskUserQuestion/Skill) with stub call()
// implementations; tool execution lands in Phase 5.
export { buildDefaultTools, compatToolsToModelCallerTools } from './compat/tools/index.js'

// Compact session (Batch 3b)
export { compactSession } from './compat/runtime/compactService.js'
export type { CompactSessionOptions, CompactSessionResult } from './compat/runtime/compactService.js'

// Memory helpers (already in compat/memory/loader.js; re-export for main entry)
export { clearMemoryCache, loadMemoryForPrompt } from './compat/memory/loader.js'
export type { MemoryFile, MemoryType } from './compat/memory/loader.js'
