// @ts-nocheck
import type { Tool, AskUserAnswers } from '../tools/Tool.js'
import type { McpServerSpec } from '../mcp/types.js'
import type { MCPClientPool } from '../mcp/MCPClientPool.js'

// UserMessage is shape-only; kept inline to avoid pulling from the opencc-internals
// mirror (which would re-couple this file to Bun-only OpenCC source).
export type UserMessage = {
  role: 'user'
  content: string | Array<{ type: string; [key: string]: unknown }>
}

export type SystemPrompt = string | Array<{ type: string; [key: string]: unknown }>

export type SandboxConfig = {
  executor: 'child_process'
  workdir: string
  commandAllowlist?: RegExp[] | null
  commandDenylist?: RegExp[]
  maxMemoryMb?: number
  maxCpuMs?: number
  networkEgress?: 'allow' | 'block'
  envAllowlist?: string[]
}

export type ModelCaller = (req: {
  model: string
  systemPrompt: string | Array<{ type: string; [key: string]: unknown }>
  messages: Array<{ role: 'user' | 'assistant'; content: unknown }>
  tools: Tool[]
  signal: AbortSignal
}) => AsyncGenerator<{
  type: 'message_start' | 'content_block_start' | 'content_block_delta' | 'content_block_stop' | 'message_delta' | 'message_stop' | 'error'
  [key: string]: unknown
}>

export type AskRegistryLike = {
  register: (toolUseId: string, sessionId: string, abortSignal: AbortSignal) => Promise<AskUserAnswers>
}

export type RuntimeConfig = {
  dataDir: string
  defaultModel?: string
  defaultPermissions?: Record<string, unknown>
  mcpServers?: McpServerSpec[]
  /** MCP client pool; if set + mcpServers set, queryEngine boots servers each turn. */
  mcpClientPool?: MCPClientPool
  /** Auto-load MCP-exposed skill:// resources. Default: 'auto'. 'off' skips. */
  mcpSkillLoading?: 'auto' | 'off'
  /**
   * @deprecated Use `skillsDirs` (path whitelist) instead. Retained for
   *   type-level back-compat only; not read by zai-agent-core.
   */
  enabledSkills?: string[]
  /** Skill directory path whitelist. Empty/undefined = no skills loaded. */
  skillsDirs?: string[]
  /** Register SkillTool when skills.length > 0. Default: true when skillsDirs is set. */
  enableSkillTool?: boolean

  modelCaller?: ModelCaller
  sandbox?: SandboxConfig
  defaultMaxTurns?: number

  /** AskUserQuestion 的等待表抽象, server 端实现. core 不依赖具体类. */
  askRegistry?: AskRegistryLike
}

export type QueryOptions = {
  prompt: string | UserMessage | UserMessage[]
  cwd: string
  resumeFromTranscriptId?: string
  model?: string
  systemPrompt?: SystemPrompt | string
  additionalTools?: Tool[]
  abortSignal?: AbortSignal
  maxTurns?: number
  enableAgentsMd?: boolean

  toolsOverride?: 'base' | 'base+subagent' | 'none'
  parentSessionId?: string
  subagentType?: string
  /** Per-request override of RuntimeConfig.skillsDirs. Higher priority than config. */
  skillsDirs?: string[]
}
