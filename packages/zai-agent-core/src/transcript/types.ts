import type { PermissionMode } from '../runtime/permissionMode.js'

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
