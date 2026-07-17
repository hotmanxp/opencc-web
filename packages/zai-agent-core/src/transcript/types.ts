import type { PermissionMode } from '../runtime/permissionMode.js'
import { z } from 'zod'

/**
 * Thrown by `deserializeFile` (and any other v1-aware reader) when the
 * persisted transcript is a legacy v1 file. v2 files serialize a different
 * shape (Anthropic-style `message.content` blocks with full v2 fields like
 * `cwd`/`userType`/`sessionId`); v1 files store the raw SDK record under
 * `raw.*`. The runtime only knows how to mount v2 files into the agent
 * UI today. A v1 file must be migrated (or the user must re-create the
 * session) — there is no automatic upgrade path because v1's raw shape
 * varies by SDK version.
 */
export class LegacyTranscriptError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'LegacyTranscriptError'
    // Preserve correct prototype chain across the super() call so
    // `err instanceof LegacyTranscriptError` works after the throw.
    Object.setPrototypeOf(this, LegacyTranscriptError.prototype)
  }
}

// v2 ContentBlock — Anthropic 风格的内容块数组元素.
// 同时兼容 v1 raw.content 数组形态 (text / image), 因为 v1 user message 的
// raw.content 也可以是 ContentBlock[].
export type ContentBlock =
  | { type: 'text'; text: string }
  | { type: 'thinking'; thinking: string }
  | { type: 'tool_use'; id: string; name: string; input: unknown }
  | {
      type: 'tool_result'
      tool_use_id: string
      content: unknown
      is_error?: boolean
    }
  | {
      type: 'image'
      source: { type: 'base64'; media_type: string; data: string }
    }

/**
 * Zod schema mirroring the `ContentBlock` union. Kept generous: extra
 * fields on any block variant pass through so callers can attach
 * provider-specific metadata (e.g., OpenAI's `index` field, or
 * `cache_control`) without re-shipping a bumped schema. The
 * `tool_use.input` field is left as `unknown` to match the TypeScript
 * type — runtime callers should validate input against the tool's own
 * input schema before invoking it.
 */
export const ContentBlockSchema = z
  .union([
    z
      .object({
        type: z.literal('text'),
        text: z.string(),
      })
      .passthrough(),
    z
      .object({
        type: z.literal('thinking'),
        thinking: z.string(),
      })
      .passthrough(),
    z
      .object({
        type: z.literal('tool_use'),
        id: z.string(),
        name: z.string(),
        input: z.unknown(),
      })
      .passthrough(),
    z
      .object({
        type: z.literal('tool_result'),
        tool_use_id: z.string(),
        content: z.unknown(),
        is_error: z.boolean().optional(),
      })
      .passthrough(),
    z
      .object({
        type: z.literal('image'),
        source: z.object({
          type: z.literal('base64'),
          media_type: z.string(),
          data: z.string(),
        }),
      })
      .passthrough(),
  ])

/**
 * Zod schema for an Anthropic-style message carried inside a v2 transcript
 * message. Mirrors the TypeScript `AnthropicMessage` shape: a role plus
 * either a plain string content or an array of v2 content blocks. Used
 * indirectly (via the `message` field on `TranscriptMessageSchema`) rather
 * than exported, but kept as a named binding so future schemas that need to
 * validate just the message body can reuse it without re-deriving the type.
 */
export const AnthropicMessageSchema = z
  .object({
    role: z.enum(['user', 'assistant']).optional(),
    content: z.union([z.string(), z.array(ContentBlockSchema)]),
  })
  .passthrough()

// v2 Anthropic SDK 消息 (供 serializeForAnthropic 喂给 LLM).
export type AnthropicMessage = {
  role: 'user' | 'assistant'
  content: string | ContentBlock[]
}

export type TranscriptFile = {
  version: 1 | 2
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
    permissionMode?: PermissionMode
  }
  messages: TranscriptMessage[]
}

// 兼容 v1 (raw.* 形态) 与 v2 (message: AnthropicMessage + ContentBlock[] 形态).
// v2 字段全部可选, 旧 message / store 调用方无需改动.
export type TranscriptMessage = {
  uuid: string
  parentUuid: string | null
  type: 'user' | 'assistant' | 'system' | 'tool_use' | 'tool_result' | 'attachment'
  timestamp: number
  raw: unknown
  runtime?: {
    turnIndex: number
    eventIdRange?: [string, string]
    costUsd?: number
  }
  // v2 字段 (persistence.ts / useAgentStore.loadTranscriptMessages 使用).
  version?: '1' | '2'
  message?: AnthropicMessage
  cwd?: string
  sessionId?: string
  userType?: string
  isSidechain?: boolean
}

export type TranscriptMeta = {
  /** Transcript schema version. v1 files are rejected by deserializeFile; v2 is the supported shape. */
  version: 1 | 2
  transcriptId: string
  cwd: string
  model: string
  createdAt: number
  updatedAt: number
  title?: string
  tags?: string[]
  messageCount: number
  parentSessionId?: string
  subagentType?: string
  permissionMode?: PermissionMode
}

/**
 * Zod schema for a v2 transcript message.
 *
 * The schema enforces the canonical v2 envelope:
 * - `version` is the literal `'2'` (v1 files go through `LegacyTranscriptError`,
 *   they are not silently upcast).
 * - `cwd`, `userType`, `sessionId` are required because v2 transcripts are
 *   always associated with a single working directory and a single userType
 *   (`zai` vs `external`); missing these indicates a v1 file shape leaking in.
 *
 * The `type` field is constrained to the v2 union — `'tool_use'` and
 * `'tool_result'` are valid v2 message types but NOT a v1-only message level;
 * v1 persisted tool_use under `raw.*` and the v2 reader must distinguish the
 * two paths. See `transcript/persistence.ts` for the persistence side of this
 * distinction.
 */
export const TranscriptMessageSchema = z
  .object({
    uuid: z.string(),
    parentUuid: z.string().nullable(),
    type: z.enum([
      'user',
      'assistant',
      'system',
      'tool_use',
      'tool_result',
      'attachment',
    ]),
    timestamp: z.number(),
    raw: z.unknown().optional(),
    runtime: z
      .object({
        turnIndex: z.number(),
        eventIdRange: z.tuple([z.string(), z.string()]).optional(),
        costUsd: z.number().optional(),
      })
      .optional(),
    version: z.literal('2'),
    message: AnthropicMessageSchema.optional(),
    cwd: z.string(),
    sessionId: z.string(),
    userType: z.string(),
    isSidechain: z.boolean(),
  })
  .passthrough()
