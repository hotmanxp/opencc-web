export type ErrorCategory =
  | 'llm_provider'
  | 'tool_execution'
  | 'permission_denied'
  | 'transcript_io'
  | 'context_window'
  | 'compaction_failure'
  | 'mcp_server'
  | 'skill_load'
  | 'internal'
  | 'aborted'

export type RuntimeEvent = {
  eventId: string
  sessionId: string
  ts: number
  turnIndex: number
  type: string
  [key: string]: unknown
}

export type RuntimeErrorEvent = RuntimeEvent & {
  type: 'runtime.error'
  error: {
    category: ErrorCategory
    message: string
    detail?: unknown
    recoverable: boolean
    code?: string
  }
}

export type RuntimeDoneEvent = RuntimeEvent & {
  type: 'runtime.done'
}

export type RuntimeAbortedEvent = RuntimeEvent & {
  type: 'runtime.aborted'
  reason?: string
}
