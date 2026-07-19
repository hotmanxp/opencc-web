// @ts-nocheck -- opencc-internals Tool.ts is itself @ts-nocheck; we re-export.

import type { z } from 'zod'

export type {
  Tool,
  Tools,
  ToolResult,
  ToolResultBlockParam,
  ToolUseBlockParam,
  ValidationResult,
  ToolPermissionContext,
  ToolUseContext,
} from '../opencc-internals/Tool.js'

export {
  buildTool,
  TOOL_DEFAULTS,
} from '../opencc-internals/Tool.js'

/**
 * Back-compat alias for existing zai tool bodies. The opencc-internals
 * canonical name is `ToolUseContext`; the runtime bridge populates all
 * fields so this alias is type-only.
 */
export type ToolContext = import('../opencc-internals/Tool.js').ToolUseContext

/**
 * Legacy minimal Tool shape used by zai's hand-rolled tools (Bash, Agent,
 * File*, Glob, Grep, AskUserQuestion, ListMcpResources, ReadMcpResource).
 * `legacyAdapter.ts` upgrades each instance to the opencc Tool shape at
 * the registry boundary.
 *
 * Existing tool bodies don't need to be rewritten — they continue to
 * implement this minimal contract and return `{output, isError}`.
 */
export type LegacyToolContext = {
  cwd: string
  env: Record<string, string>
  abortSignal: AbortSignal
  dataDir: string
  canUseTool: (toolName: string, input: unknown) => Promise<{
    behavior: 'allow'
    behavior?: 'allow' | 'deny' | 'ask'
    reason?: string
  }>
  emitEvent: (event: { type: string; [key: string]: unknown }) => void
  state: { [key: string]: unknown }
  awaitAskUserQuestion: (req: unknown) => Promise<{
    answers: Record<string, string>
    annotations?: Record<string, { notes?: string; preview?: string }>
  }>
  __runtimeConfig?: any
  __defaultModel?: string
  __maxTurns?: number
  parentSessionId?: string
}

export type LegacyTool<
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  Input extends z.ZodTypeAny = any,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  Output = any,
> = {
  name: string
  description: string
  inputSchema: any
  call(input: any, ctx: LegacyToolContext): Promise<{ output: Output; isError?: boolean }>
  isConcurrencySafe?: (input: any) => boolean
  isReadOnly?: (input: any) => boolean
  isDestructive?: (input: any) => boolean

  // ---------------------------------------------------------------------------
  // Optional opencc-style methods (对标 opencc `Tool` interface).
  //
  // 只为新工具(BashTool)实现, 老工具 (FileEdit/FileRead/Agent/Glob 等) 都不需要。
  // legacyAdapter 把这些字段透传给 opencc `Tool` 同名字段; 缺省时由 adapter 默认值填充。
  // ---------------------------------------------------------------------------

  /** Opencc `Tool.prompt` — 完整的工具说明。 */
  prompt?: () => Promise<string> | string

  /** Opencc `Tool.validateInput` — schema 校验通过后的语义校验。 */
  validateInput?: (input: any, ctx: LegacyToolContext) => Promise<{ result: true } | { result: false; message: string; errorCode: number }>

  /** Opencc `Tool.checkPermissions` — 在 validateInput 之后调用。 */
  checkPermissions?: (input: any, ctx: LegacyToolContext) => Promise<
    | { behavior: 'allow'; updatedInput?: any }
    | { behavior: 'deny'; message: string; updatedInput?: any }
    | { behavior: 'ask'; message?: string; updatedInput?: any }
  >

  /** Opencc `Tool.preparePermissionMatcher` — 为 hook `if` 条件编译闭包。 */
  preparePermissionMatcher?: (input: any) => Promise<(pattern: string) => boolean>

  /**
   * Opencc `Tool.inputsEquivalent` — decide whether two invocations of this
   * tool would produce equivalent side effects. Used by the runtime to
   * coalesce redundant tool_use calls inside the same turn. Optional;
   * adapters default to `false` (never equivalent) when absent.
   */
  inputsEquivalent?: (input1: any, input2: any) => boolean

  /** Opencc `Tool.description` — 异步获取简短描述。 */
  asyncDescription?: (input: any) => Promise<string>

  /** Opencc `Tool.isSearchOrReadCommand` — 用于 UI collapse。 */
  isSearchOrReadCommand?: (input: any) => { isSearch: boolean; isRead: boolean; isList?: boolean }

  /** Opencc `Tool.mapToolResultToToolResultBlockParam` — 工具 result → API block。 */
  mapToolResultToToolResultBlockParam?: (output: any, toolUseId: string) => {
    tool_use_id: string
    type: 'tool_result'
    content: string | unknown[]
    is_error?: boolean
  }

  /** Opencc `Tool.toAutoClassifierInput` — auto-mode 安全分类器的紧凑输入。 */
  toAutoClassifierInput?: (input: any) => unknown

  /** Opencc `Tool.userFacingName` — UI 显示名。 */
  userFacingName?: (input: any) => string

  /** Opencc `Tool.getToolUseSummary` — 紧凑视图摘要。 */
  getToolUseSummary?: (input: any) => string | null

  /** Opencc `Tool.getActivityDescription` — spinner 显示。 */
  getActivityDescription?: (input: any) => string | null

  /**
   * zai extension: resolve isolation strategy for this call. Default
   * implementation may return 'none'. AgentTool uses this to gate the
   * ZAI_ENABLE_AGENT_WORKTREE_ISOLATION env flag and emit a warning when
   * isolation is requested without backing infrastructure.
   */
  resolveIsolation?: (input: any) => 'worktree' | 'none' | string

  /** Opencc `Tool.maxResultSizeChars` — 超过此大小落盘。 */
  maxResultSizeChars?: number

  /**
   * Opencc `Tool.aliases` — 工具的别名列表(向后兼容重命名)。
   * 对标 opencc 上游 `TaskOutputTool.aliases = ['AgentOutputTool', 'BashOutputTool']`
   * 与 `TaskStopTool.aliases = ['KillShell']` 的别名机制。
   * `legacyAdapter.wrapAsOpenccTool` 透传到 opencc Tool,`findToolByName`
   * 按 primary name + aliases 命中。
   */
  aliases?: string[]
}

// Re-export runtime-side types that previously lived in this file. These
// are still consumed by canUseTool.ts, runtime/index.ts, and tests.
export type CanUseToolResult =
  | { behavior: 'allow' }
  | { behavior: 'deny'; reason: string }
  | { behavior: 'ask'; reason?: string }

export type AskUserAnswers = {
  answers: Record<string, string>
  annotations?: Record<string, { preview?: string; notes?: string }>
}

export type AskUserRequest = {
  questions: unknown
  metadata?: { source?: string }
}