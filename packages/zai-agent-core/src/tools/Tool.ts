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