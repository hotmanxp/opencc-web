import type { z } from 'zod'
import type { RuntimeConfig } from '../runtime/types.js'

export type ToolResult = {
  toolUseId: string
  content: unknown
  isError: boolean
}

export type CanUseToolResult =
  | { behavior: 'allow' }
  | { behavior: 'deny'; reason: string }
  | { behavior: 'ask'; reason?: string }

// AskUserQuestionTool 用: 调用方在 ask 模式下挂起等待用户回答.
export type AskUserAnswers = {
  answers: Record<string, string>
  annotations?: Record<string, { preview?: string; notes?: string }>
}

// ToolContext → tool.call 内部调 ctx.awaitAskUserQuestion(input) 触发 ask_pending.
export type AskUserRequest = {
  questions: unknown  // zod-validated Question[]; core 不关心内部结构
  metadata?: { source?: string }
}

export type ToolContext = {
  cwd: string
  env: Record<string, string>
  abortSignal: AbortSignal
  dataDir: string
  canUseTool: (toolName: string, input: unknown) => Promise<CanUseToolResult>
  emitEvent: (event: { type: string; [key: string]: unknown }) => void
  state: { [key: string]: unknown }
  awaitAskUserQuestion: (req: AskUserRequest) => Promise<AskUserAnswers>

  /** 注入, 供 sub-agent tool 调子 queryEngine 用 (escape hatch) */
  __runtimeConfig?: RuntimeConfig
  __defaultModel?: string
  __maxTurns?: number
  parentSessionId?: string
}

// Use `any` as the default Input so concrete schemas like z.ZodObject<...>
// satisfy the bare Tool without TS variance errors. Callers who need the
// specific Input type use the generic (e.g. Tool<typeof BashInputSchema>);
// the default only applies when Tool is referenced bare (e.g. Tool[] in a
// tool registry).
export type Tool<Input extends z.ZodTypeAny = any, Output = unknown> = {
  name: string
  description: string
  inputSchema: Input
  call(input: z.infer<Input>, ctx: ToolContext): Promise<{ output: Output; isError?: boolean }>
  isConcurrencySafe?: (input: z.infer<Input>) => boolean
  isReadOnly?: (input: z.infer<Input>) => boolean
  isDestructive?: (input: z.infer<Input>) => boolean
}

