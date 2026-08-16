// @zn-ai/zn-agent-core
export const VERSION = '0.1.0'
export * from './compat/permissions.js'
export * from './compat/permissionMode.js'
export * from './compat/commands/index.js'
export * from './compat/commands/handoffFs.js'
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
// runtime (opencc-src/server's createOpenccRuntime, exposed via the
// main entry through bundle-entry.ts) replaces the `DefaultAgentRuntime`
// path entirely; callers migrated in commit da4c50e5 (Task 5). The
// `AgentRuntime` interface itself is preserved for back-compat re-export.
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

// zai patch (2026-08-09): vendor queryModelWithStreaming 的 types stub。
//
// 运行时 esbuild bundle (`dist/opencc-core.mjs`) 把 vendor 的
// queryModelWithStreaming / asSystemPrompt 编入 bundle 并通过 re-export
// 暴露(zai/src/server/services/commands/builtin/compact.ts 直接 import,
// 拿 runtime 值)。types 不走 dist/opencc-src/** — 主 tsconfig.json 把
// src/opencc-src 排除(vendor 有未修的 ts 错误),让 src/index.ts 引用
// ./opencc-src/** 会触发 TS6307 错误(transitive file 不在项目文件列表)。
//
// 这里 declare-only 的签名是 zai 端 compact 调用所需的最小契约:
//   - messages: vendor 的 Message[]
//   - systemPrompt: branded readonly string[] (用 asSystemPrompt 构造)
//   - thinkingConfig / tools / signal / options: 调 vendor 的标准参数
//
// runtime 调用的是 esbuild bundle 里的真实实现,types 只是给 zai tsc 看的
// 契约表面,签名不匹配处 zai 端用 `as` cast 即可。
export type Message = {
  type: string
  content: string
  message?: { content: string | unknown[]; role?: string }
  uuid?: string
  parentUuid?: string | null
  timestamp?: string | number
}

export type SystemPrompt = readonly string[] & { readonly __brand: 'SystemPrompt' }

export function asSystemPrompt(value: readonly string[]): SystemPrompt {
  return value as SystemPrompt
}

export declare function queryModelWithStreaming(args: {
  messages: Message[]
  systemPrompt: SystemPrompt
  thinkingConfig: { type: 'disabled' | 'enabled'; budgetTokens?: number }
  tools: unknown[]
  signal: AbortSignal
  options: {
    model: string
    querySource: string
    isNonInteractiveSession: boolean
    hasAppendSystemPrompt: boolean
    agents: unknown[]
    mcpTools: unknown[]
    getToolPermissionContext: () => Promise<unknown>
    [key: string]: unknown
  }
}): AsyncIterable<unknown>
