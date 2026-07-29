// @zn-ai/zn-agent-core compat shim — port of zai-agent-core runtime/types.ts.
//
// Verbatim port with two categories of adjustment:
//   1. The `Tool` type re-uses the cross-package shape from
//      `compat/runtime/modelCaller.ts` (already widened to
//      `description: string | Function` for opencc SDK compatibility).
//   2. Cross-batch symbols (AskUserAnswers, McpServerSpec, MCPClientPool,
//      PluginRuntime, PluginRuntimeConfig) are declared as forward-reference
//      placeholders here; their real implementations land in Batch 2/3
//      (mcp/types.ts, mcp/MCPClientPool.ts, plugins/types.ts). Until those
//      land, this file's TypeScript surface is sufficient — QueryOptions,
//      RuntimeConfig, etc. compile against the structural placeholders.
//
// `permissionMode.ts` is a compat-local re-export of `permissions.ts` so the
// original `import type { PermissionMode } from './permissionMode.js'` works
// without rewrites.

import type { Tool } from './modelCaller.js'
import type { PermissionMode } from '../permissionMode.js'
import type { McpServerSpec } from '../mcp/types.js'
import type { MCPClientPool } from '../mcp/MCPClientPool.js'
import type { PluginRuntime, PluginRuntimeConfig } from '../plugins/types.js'

// Re-export Tool so callers can `import type { Tool } from './types.js'`.
export type { Tool }

// Forward references — to be replaced with real imports when Batch 2/3 lands.
export type AskUserAnswers = Record<string, unknown>

// `PluginRuntime` / `PluginRuntimeConfig` come from the real compat
// plugins shim (Batch 2c). Re-exported here so callers can still
// import them from this module.
export type { PluginRuntime, PluginRuntimeConfig }

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
  systemPrompt: string | string[] | Array<{ type: string; [key: string]: unknown }>
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

/**
 * The shape RequestApprove's runtime needs from a server-side approve
 * registry. Mirrors AskRegistryLike but for the approve/reject decision
 * payload. The host server is responsible for resolving promises when the
 * user submits a decision via the HTTP API.
 */
export type ApproveRegistryLike = {
  register: (
    toolUseId: string,
    sessionId: string,
    filePath: string,
    abortSignal: AbortSignal,
  ) => Promise<{
    decision: 'approved' | 'rejected'
    comment?: string
  }>
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

  /** RequestApprove 的 pending-decision 表抽象, server 端实现. */
  approveRegistry?: ApproveRegistryLike

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

  /** Plugin runtime config (sources, enablement, hook executor). */
  plugins?: PluginRuntimeConfig
  /** Plugin runtime implementation. Bootstrapped by the host if set. */
  pluginRuntime?: PluginRuntime

  /**
   * Loop-resilience runtime tunables (spec E + spec C). Narrow + structural
   * so unit tests can pass partial shapes — matches the shape used by
   * `runtime/summary/stepCounter.ts` (`RuntimeConfigSlice`).
   */
  runtime?: {
    /** Per-session agent step limit. Read by `getAgentStepLimit({ config })`. */
    agentStepLimit?: number
    /** Max continuation nudges before bailing. Read by `injectContinuationNudge`. */
    continuationNudgeMax?: number
    /** Feature toggle for continuation nudges. Read by `injectContinuationNudge`. */
    continuationNudgeEnabled?: boolean
    /** Allow other loop-resilience keys without forcing them into the type. */
    [key: string]: unknown
  }

  /**
   * Phase 1.b — config block read by `compat/runtime/openccAdapter.ts` (the
   * direct modelCaller path that bypasses the broken opencc vendor copy).
   * zai-server wires mcp/skills/sandbox/modelCaller into this block. Kept
   * off the top-level RuntimeConfig shape so other consumers don't see it.
   */
  openccConfig?: OpenccAdapterConfig
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
  tools?: Tool[]
  sessionId?: string
  systemPrompt?: string | string[]
  additionalTools?: Tool[]
  abortSignal?: AbortSignal
  maxTurns?: number
  enableAgentsMd?: boolean

  toolsOverride?: 'base' | 'base+subagent' | 'none'
  /**
   * 工具黑名单。resolveToolPool 在构造完工具池后,移除 name 出现在此列表里的工具。
   * 由 AgentTool / DefaultBackgroundRuntime 在派发 sub-agent 时填充
   * `['Agent']`,防止 sub-agent 递归派发 sub-agent
   * (复刻 OpenCC sub-agents 文档中的 disallowedTools 语义)。
   */
  disallowedTools?: string[]
  parentSessionId?: string
  subagentType?: string
  /** Per-request override of RuntimeConfig.skillsDirs. Higher priority than config. */
  skillsDirs?: string[]
  /** Override the permission mode for this query. Higher priority than transcript meta. */
  permissionMode?: PermissionMode
  /**
   * 把 `prompt` 标成 isMeta (对齐 OpenCC 语义). true 时该 user 消息仍会:
   *   1) 进入模型上下文 (LLM 可见)
   *   2) 落盘到 transcript.json (持久化)
   * 但前端 UI 层不渲染 (loadTranscriptMessages / SSE 渲染层都过滤).
   *
   * 用于 SubagentNotifier 注入的 `<task-notification>` 这类"系统提示但不让
   * 用户看见原始 XML"场景。缺省 false (普通用户输入,正常显示).
   */
  isMetaPrompt?: boolean
  /**
   * Per-query override of the agent step limit (spec E §2.1). Has highest
   * priority over `config.runtime.agentStepLimit` and `ZAI_AGENT_STEP_LIMIT`.
   * Wired into `getAgentStepLimit({ userOptIn })` by queryLoop.
   */
  agentStepLimit?: number
}

/**
 * Configuration for the opencc adapter layer.
 * Pass into DefaultAgentRuntime config to enable opencc query() delegation.
 */
export interface OpenccAdapterConfig {
  /** MCP client pool — tools from connected MCP servers injected into query(). */
  mcpPool?: import('../mcp/MCPClientPool.js').MCPClientPool | undefined
  /** MCP server specs (name + transport config) consumed by opencc query(). */
  mcpServers?: import('../mcp/types.js').McpServerSpec[] | undefined
  /** Plugin runtime — hooks (PreToolUse, PostToolUse, etc.) attached to query lifecycle. */
  hookRunner?: import('../plugins/HookRunner.js').HookRunner | undefined
  /** Skills directories to load skill definitions from. */
  skillsDirs?: readonly string[] | undefined
  /** Sandbox config (executor, maxCpuMs, env allowlist). */
  sandbox?: import('./types.js').SandboxConfig | undefined
  /**
   * Model caller — invokes Anthropic (or another provider) and yields the
   * raw event stream. In Phase 1.b (compat/runtime/openccAdapter.ts) the
   * adapter calls this directly instead of going through opencc's
   * query(), so the opencc vendor copy never needs to load. zai-server
   * wires `createAnthropicModelCaller()` into this slot.
   */
  modelCaller?: import('./modelCaller.js').ModelCaller | undefined
  /**
   * Default tool list to expose to the model. Merged with `opts.tools`
   * at call-time by `runOpenccQuery` (opts wins on name collision).
   * Phase 4 wires `buildDefaultTools({ skillsDirs })` here so the model
   * sees Bash/Read/Edit/Write/AskUserQuestion/Skill; Phase 5 will hook
   * the tool execution loop on top.
   */
  tools?: import('./modelCaller.js').Tool[] | undefined

  /**
   * AskRegistry abstraction. AskUserQuestion 工具在 Phase 4c 之前是 stub
   * (直接返回 "[zai askRegistry stub] ..."); 接上 askRegistry 后, 工具
   * 会 yield `tool_use:ask_pending` 事件 (→ 前端 QuestionCard 弹出), 然后
   * await `register(toolUseId, sessionId, abortSignal)` 等用户答复. zai-server
   * 把 `AskRegistry` 实例直接挂到这里即可, 不需要 server 自己改。
   */
  askRegistry?: import('./types.js').AskRegistryLike | undefined
}
