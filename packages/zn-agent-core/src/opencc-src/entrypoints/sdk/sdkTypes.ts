// @ts-nocheck
// Stub type definitions for SDK exports declared in src/entrypoints/sdk.d.ts
// but not yet present in source code. The runtime implementations live in
// src/utils/sessionPersistence.ts (deleteSession) and the consumer code
// references them via the index.ts re-export. These types let the SDK API
// surface match sdk.d.ts so validate-externals drift check passes.

import type { SdkMcpToolDefinition } from './runtimeTypes.ts'

export type QueryOptions = {
  cwd: string
  additionalDirectories?: string[]
  model?: string
  sessionId?: string
  /** Fork the session before resuming (requires sessionId). */
  fork?: boolean
  /** Alias for fork. When true, resumed session forks to a new session ID. */
  forkSession?: boolean
  /** Resume the most recent session for this cwd (no sessionId needed). */
  continue?: boolean
  resume?: string
  /** When resuming, resume messages up to and including this message UUID. */
  resumeSessionAt?: string
  permissionMode?: string
  abortController?: AbortController
  executable?: string
  allowDangerouslySkipPermissions?: boolean
  disallowedTools?: string[]
  hooks?: Record<string, unknown[]>
}

export type SdkMcpStdioConfig = {
  type?: 'stdio'
  command: string
  args?: string[]
  env?: Record<string, string>
}

export type SdkMcpSSEConfig = {
  type: 'sse'
  url: string
  headers?: Record<string, string>
}

export type SdkMcpHttpConfig = {
  type: 'http'
  url: string
  headers?: Record<string, string>
}

export type SdkMcpSdkConfig = {
  type: 'sdk'
  name: string
  /** In-process tool definitions created via the tool() helper. */
  tools?: SdkMcpToolDefinition[]
}

export type SdkMcpServerConfig =
  | SdkMcpStdioConfig
  | SdkMcpSSEConfig
  | SdkMcpHttpConfig
  | SdkMcpSdkConfig

/**
 * Scoped MCP server config with session scope.
 * Returned by createSdkMcpServer() for use with mcpServers option.
 */
export type SdkScopedMcpServerConfig = SdkMcpServerConfig & {
  /** When true, the SDK process owns the lifecycle of this MCP server. */
  scope?: 'session'
}