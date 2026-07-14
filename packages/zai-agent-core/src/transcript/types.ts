import { z } from 'zod'

// ---- ContentBlock (对齐 OpenCC message.ts:45) ----
export const ContentBlockSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('text'), text: z.string() }),
  z.object({ type: z.literal('thinking'), thinking: z.string() }),
  z.object({
    type: z.literal('tool_use'),
    id: z.string(),
    name: z.string(),
    input: z.unknown(),
  }),
  z.object({
    type: z.literal('tool_result'),
    tool_use_id: z.string(),
    content: z.unknown(),
    is_error: z.boolean(),
  }),
])
export type ContentBlock = z.infer<typeof ContentBlockSchema>

// ---- SerializedMessage (对齐 OpenCC logs.ts:10) ----
export const SerializedMessageSchema = z.object({
  cwd: z.string(),
  userType: z.string(),
  sessionId: z.string(),
  timestamp: z.union([z.number(), z.string()]),
  version: z.string(),
  entrypoint: z.string().optional(),
  gitBranch: z.string().optional(),
  slug: z.string().optional(),
})
export type SerializedMessage = z.infer<typeof SerializedMessageSchema>

// ---- TranscriptMessage v2 ----
export const TranscriptMessageSchema = z.object({
  uuid: z.string(),
  parentUuid: z.string().nullable(),
  type: z.enum(['user', 'assistant', 'tool_use', 'tool_result', 'system', 'attachment']),
  timestamp: z.number(),
  message: z.object({
    content: z.union([z.string(), z.array(ContentBlockSchema)]),
    role: z.enum(['user', 'assistant']).optional(),
  }),
  cwd: z.string(),
  userType: z.string(),
  sessionId: z.string(),
  version: z.literal('2'),
  gitBranch: z.string().optional(),
  slug: z.string().optional(),
  isSidechain: z.boolean(),
  runtime: z
    .object({ turnIndex: z.number(), costUsd: z.number().optional() })
    .optional(),
})
export type TranscriptMessage = z.infer<typeof TranscriptMessageSchema>

// ---- TranscriptFile v2 ----
export type TranscriptFile = {
  version: 2
  transcriptId: string
  meta: {
    cwd: string
    model: string
    createdAt: number
    updatedAt: number
    title?: string
    tags?: string[]
    parentSessionId?: string
    subagentType?: string
  }
  messages: TranscriptMessage[]
}

// ---- TranscriptMeta (list 视图，版本透明) ----
export type TranscriptMeta = {
  transcriptId: string
  version: 1 | 2
  cwd: string
  model: string
  createdAt: number
  updatedAt: number
  title?: string
  tags?: string[]
  messageCount: number
  parentSessionId?: string
  subagentType?: string
}

// ---- Legacy marker ----
export class LegacyTranscriptError extends Error {
  override readonly name = 'LegacyTranscriptError'
  constructor(reason: string) {
    super(`Legacy transcript (v1) rejected: ${reason}`)
  }
}
