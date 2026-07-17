import type { LoadedSkill } from '../runtime/skills/types.js'
import type { AgentDefinition } from '../tools/AgentTool/loadAgentsDir.js'
import type { McpServerSpec } from '../mcp/types.js'

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