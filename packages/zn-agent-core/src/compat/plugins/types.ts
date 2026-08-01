/**
 * Plugin runtime type contracts.
 *
 * Public surface of the plugin runtime: `PluginManifest`, `PluginSnapshot`,
 * `PluginLoadError`, `HookExecutor`, `PluginHook`, `PluginRuntime`,
 * `PluginRuntimeConfig`, and the supporting enum-like unions
 * (`PluginComponent`, `PluginSourceName`).
 *
 * Consumers (`DefaultPluginRuntime`, `HookRunner`, `createDefaultHookExecutor`,
 * `resolveOpenccConfigDir`, the manifest reader, the path resolver) type
 * against these symbols so the snapshot/cache/hook pipeline stays consistent
 * across opencc vendor and zai-native plugin sources.
 */

import type { LoadedSkill } from '../runtime/skills-types.js'
import type { McpServerSpec } from '../mcp/types.js'

/**
 * Structural shape for an agent loaded from a plugin manifest. The
 * real `AgentDefinition` in opencc-src/tools/AgentTool/loadAgentsDir.ts
 * is a wide union of `{ agentType, whenToUse, tools, getSystemPrompt, ... }`
 * but this file only stores it as opaque JSON in the plugin runtime
 * snapshot — call sites read `name`/`description` and pass to
 * downstream tooling, which we'll fully type once the runtime loader
 * lands in compat/runtime (see notes on the inline `AgentDefinition`
 * alias below).
 */
export type AgentDefinition = {
  agentType: string
  whenToUse: string
  [key: string]: unknown
}

export type PluginSourceName = 'opencc' | 'zai'

export type PluginComponent = 'skills' | 'commands' | 'agents' | 'mcp' | 'hooks'

export type PluginManifest = {
  name: string
  version?: string
  description?: string
  commands?: unknown
  agents?: unknown
  skills?: unknown
  mcpServers?: unknown
  hooks?: unknown
  [key: string]: unknown
}

/**
 * Canonical merge key is `manifest.name`. OpenCC's original marketplace ID
 * (e.g. `plugin@marketplace`) remains in `sourceRef` for `enabledPlugins`
 * lookup and diagnostics — ZAI and OpenCC plugins may not share a
 * marketplace name.
 */
export type PluginCandidate = {
  id: string
  name: string
  source: PluginSourceName
  sourceRef: string
  root: string
  manifest: PluginManifest
}

export type LoadedPlugin = PluginCandidate & { enabled: true }

export type PluginHook = {
  event: string
  matcher?: string
  command: string
  pluginId: string
  pluginRoot: string
  timeoutMs?: number
}

export type PluginLoadError = {
  code: string
  message: string
  source?: PluginSourceName
  pluginId?: string
  component?: PluginComponent
  path?: string
  detail?: unknown
}

export type PluginCandidateResult = {
  candidates: PluginCandidate[]
  errors: PluginLoadError[]
}

export type HookExecutor = (request: {
  command: string
  event: string
  pluginId: string
  pluginRoot: string
  input: unknown
  signal: AbortSignal
}) => Promise<{
  blocked?: boolean
  output?: unknown
  error?: string
}>

export type PluginRuntimeConfig = {
  enabled?: boolean
  opencc?: { configDir?: string; enabled?: boolean }
  zai?: {
    pluginsDir?: string
    settingsPath?: string
    enabled?: boolean
    enabledPlugins?: Record<string, boolean>
  }
  hookExecutor?: HookExecutor
}

/**
 * Snapshot returned by `PluginRuntime.load()`. Merged into the runtime
 * alongside disk-loaded skills/agents/MCP servers.
 *
 * `pluginMcpServerNames` tracks MCP server names that came from plugins
 * so the runtime can disconnect only plugin-owned servers on session end
 * without touching user-configured servers.
 */
export type PluginSnapshot = {
  plugins: LoadedPlugin[]
  skills: LoadedSkill[]
  agents: AgentDefinition[]
  mcpServers: McpServerSpec[]
  pluginMcpServerNames: string[]
  hooks: PluginHook[]
  errors: PluginLoadError[]
}

export function emptyPluginSnapshot(): PluginSnapshot {
  return {
    plugins: [],
    skills: [],
    agents: [],
    mcpServers: [],
    pluginMcpServerNames: [],
    hooks: [],
    errors: [],
  }
}

export interface PluginRuntime {
  load(input: { cwd: string; signal?: AbortSignal }): Promise<PluginSnapshot>
  clearCache(): void
}