export type TranscriptFile = {
  version: 1
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

  // 新增
  parentSessionId?: string
  subagentType?: string
}
