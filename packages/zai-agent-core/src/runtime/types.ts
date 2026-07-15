// @ts-nocheck
import type { Tool, AskUserAnswers } from '../tools/Tool.js'
import type { McpServerSpec } from '../mcp/types.js'
import type { MCPClientPool } from '../mcp/MCPClientPool.js'
import type { PermissionMode } from './permissionMode.js'

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
  /**
   * Override the user-global agents directory (default: `~/.zai/agents`).
   * Pass an explicit path to redirect user-global agent loading, or `''`
   * to disable it entirely (used by tests and sandboxed environments).
   */
  userAgentsDir?: string
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

  /** Default permission mode for new sessions. Falls back to 'default'. */
  defaultPermissionMode?: PermissionMode

  /** AskUserQuestion 的等待表抽象, server 端实现. core 不依赖具体类. */
  askRegistry?: AskRegistryLike

  /**
   * Post-boot snapshot of connected MCP servers, used to inject
   * `instructions` into the system prompt (see `mcp/mcpInstructions.ts`).
   * The queryEngine populates this from `mcpClientPool` after `connectAll`.
   * Optional because the runtime may be created before MCP boot completes.
   */
  mcpClients?: Array<{
    name: string
    type: string
    status?: string
    instructions?: string
  }>
}

export type QueryOptions = {
  prompt: string | UserMessage | UserMessage[]
  cwd: string
  /**
   * 指定 transcript ID (新建或续传都用这个 ID).
   * - 若文件存在: 视为续传, 加载历史消息
   * - 若文件不存在: 视为新建, runtime 启动后写 transcript 到这个 ID
   * 不传则 runtime 生成 'sess-${randomUUID()}'.
   *
   * 与 resumeFromTranscriptId 的区别: 后者隐含"文件必须存在",
   * store.read 会抛 ENOENT.
   */
  transcriptId?: string
  /** @deprecated 用 transcriptId 代替. 文件不存在时会抛 ENOENT. */
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
  /** Override the permission mode for this query. Higher priority than transcript meta. */
  permissionMode?: PermissionMode
}
