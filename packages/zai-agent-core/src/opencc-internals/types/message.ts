// @ts-nocheck
/**
 * Message types for the CLI.
 * This file contains the core message types used throughout the application.
 */

// UUID template literal type. Matches the canonical 8-4-4-4-12 hex format produced
// by `crypto.randomUUID()` and accepted by upstream normalize helpers. Kept as a
// template literal so derived UUIDs (e.g. `deriveUUID(parent, index)`) stay
// structurally compatible with raw crypto UUIDs.
export type UUID = `${string}-${string}-${string}-${string}-${string}`

// Content block types
export type TextBlock = {
  type: 'text'
  text: string
}

export type ToolUseBlock = {
  type: 'tool_use'
  id: string
  name: string
  input: unknown
}

export type ToolResultBlock = {
  type: 'tool_result'
  tool_use_id: string
  content: string | ContentBlock[]
  is_error?: boolean
}

export type ImageBlock = {
  type: 'image'
  source: {
    type: 'base64' | 'url'
    media_type: string
    data: string
  }
}

export type ThinkingBlock = {
  type: 'thinking'
  thinking: string
}

export type RedactedThinkingBlock = {
  type: 'redacted_thinking'
  thinking: string
}

export type ContentBlock = TextBlock | ToolUseBlock | ToolResultBlock | ImageBlock | ThinkingBlock | RedactedThinkingBlock

// Message origin type
export type MessageOrigin = {
  kind: 'human' | 'tool' | 'assistant' | 'server' | string
  server?: string
}

// Message type used in conversation transcript handling
export interface Message {
  uuid: string
  parentUuid?: string
  type: 'user' | 'assistant' | 'system' | 'function' | 'placeholder' | 'attachment' | 'progress' | 'tombstone' | 'request_start' | 'stream_event' | 'tool_summary' | 'hook_result' | 'system_local_command' | 'text' | 'summary' | 'result'
  content: string
  timestamp: number | string
  isMeta?: boolean
  toolUseResult?: boolean
  isCompactSummary?: boolean
  isVirtual?: boolean
  origin?: MessageOrigin
  requestId?: string
  error?: unknown
  isApiErrorMessage?: boolean
  advisorModel?: string
  message?: {
    content: string | ContentBlock[]
    role?: string
    id?: string
    context_management?: unknown
    model?: string
    created_at?: number
  }
  subtype?: string
  attachment?: {
    type: string
    name?: string
    mimeType?: string
    toolUseID?: string
  }
  toolUseID?: string
  data?: unknown
  hookId?: string
  outcome?: 'success' | 'blocking' | 'non_blocking_error' | 'cancelled'
  serverName?: string
  enabled?: boolean
  callbackUrl?: string
  loginWithClaudeAi?: boolean
  task_id?: string
  description?: string
  persist?: boolean
  question?: string
  hook_name?: string
  hooks?: unknown
  agents?: unknown
  systemPrompt?: string
  appendSystemPrompt?: string
  jsonSchema?: unknown
  matchers?: unknown
  canRewind?: boolean
  filesChanged?: string[]
  insertions?: number
  deletions?: number
  files?: string[]
  imagePasteIds?: string[]
  mcpMeta?: unknown
  isVisibleInTranscriptOnly?: boolean
  sourceToolUseID?: string
  permissionMode?: string
  summarizeMetadata?: unknown
}

// Progress message for tool execution
export interface ProgressMessage {
  type: 'progress'
  toolUseId: string
  progress: number
  content?: string
  data?: unknown
}

// Attachment message for file uploads
export interface AttachmentMessage {
  type: 'attachment'
  id: string
  name: string
  mimeType: string
  content: string
}

// System message for internal events
export interface SystemMessage {
  type: 'system'
  content: string
  subtype?: string
  toolUseID?: string
  level?: string
  preventedContinuation?: boolean
  commands?: string[]
  url?: string
  upgradeNudge?: string
  durationMs?: number
  budgetTokens?: number
  budgetLimit?: number
  budgetNudges?: number
  messageCount?: number
  ttftMs?: number
  otps?: number
  hookDurationMs?: number
  turnDurationMs?: number
  toolDurationMs?: number
  classifierDurationMs?: number
  toolCount?: number
  hookCount?: number
  classifierCount?: number
  configWriteCount?: number
  trigger?: string
  preTokens?: number
  logicalParentUuid?: string
  compactMetadata?: unknown
  microcompactMetadata?: unknown
  hookInfos?: unknown[]
  hookErrors?: string[]
  stopReason?: string
  hasOutput?: boolean
  hookLabel?: string
  totalDurationMs?: number
  writtenPaths?: string[]
  isP50?: boolean
  cause?: unknown
  retryInMs?: number
  retryAttempt?: number
  maxRetries?: number
}

// User message
export interface UserMessage {
  type: 'user'
  content: string
  message: {
    content: string | ContentBlock[]
    role?: 'user' | string
    context_management?: unknown
  }
  origin?: MessageOrigin
  uuid?: string
  timestamp?: string
  isMeta?: boolean
  isVisibleInTranscriptOnly?: boolean
  isVirtual?: boolean
  isCompactSummary?: boolean
  // Marks messages that summarize a collapsed transcript segment. Used by
  // normalize helpers to fold multi-block messages into single-block form.
  isCollapseSummary?: boolean
  summarizeMetadata?: unknown
  toolUseResult?: unknown
  /** Internal marker for synthetic tool_result messages created by agent step limits. */
  isAgentStepLimitToolResult?: boolean
  mcpMeta?: unknown
  // Widen to (number | string)[] for normalize compatibility: imagePasteIds may
  // be string-backed (existing UI) or number-backed (new normalize path), or a
  // mixed list. Use the element-union form so per-block derivation can stamp a
  // single value of either type without further casts.
  imagePasteIds?: (number | string)[]
  sourceToolAssistantUUID?: string
  sourceToolUseID?: string
  permissionMode?: string
}

// Assistant message
export interface AssistantMessage {
  type: 'assistant'
  content: string
  message: {
    content: string | ContentBlock[]
    role?: string
    id?: string
    context_management?: unknown
    model?: string
    stop_reason?: string
    stop_sequence?: string
  }
  uuid?: string
  timestamp?: string
  toolUses?: unknown[]
  apiError?: unknown
  error?: unknown
  errorDetails?: string
  requestId?: string
  isApiErrorMessage?: boolean
  advisorModel?: string
  isVirtual?: boolean
  isMeta?: boolean
}

// System local command message
export interface SystemLocalCommandMessage {
  type: 'system_local_command'
  command: string
}

// SDK Message types (stub definitions for type compatibility)
export type SDKMessage = Message
export type SDKAssistantMessage = AssistantMessage
export type SDKUserMessage = UserMessage
export type SDKUserMessageReplay = UserMessage
export type SDKResultMessage = {
  type: 'result'
  content: string
}
export type SDKPostTurnSummaryMessage = {
  type: 'summary'
  content: string
}
export type SDKStreamlinedTextMessage = {
  type: 'text'
  content: string
}
export type SDKStreamlinedToolUseSummaryMessage = {
  type: 'tool_summary'
  toolUseId: string
  content: string
}

// Normalized message content - shared by user and assistant messages
export type NormalizedMessageContent = {
  content: string | ContentBlock[]
  role?: string
  context_management?: unknown
  created_at?: number
}

export type NormalizedUserMessage = {
  type: 'user'
  uuid: string
  timestamp: number
  content: string
  message: NormalizedMessageContent
  origin?: MessageOrigin
  attachment?: RenderableAttachment
  imagePasteIds?: (number | string)[]
  mcpMeta?: unknown
  isVisibleInTranscriptOnly?: boolean
  sourceToolUseID?: string
  permissionMode?: string
  summarizeMetadata?: unknown
}

export type NormalizedAssistantMessage = {
  type: 'assistant'
  uuid: string
  timestamp: number
  content: string
  message: NormalizedMessageContent
  toolUses?: unknown[]
  attachment?: RenderableAttachment
  requestId?: string
  error?: unknown
  isApiErrorMessage?: boolean
  advisorModel?: string
  isMeta?: boolean
  isVirtual?: boolean
}

export type NormalizedMessage = NormalizedUserMessage | NormalizedAssistantMessage

// Attachment with additional fields used in transcript rendering
export type RenderableAttachment = {
  type: string
  name?: string
  mimeType?: string
  memories?: Array<{ content: string }>
  prompt?: string | Array<{ type: 'text'; text: string }>
  commandMode?: string
  isMeta?: boolean
}

// RenderableMessage is a union of all message types that can be rendered in the UI
export type RenderableMessage =
  | NormalizedUserMessage
  | NormalizedAssistantMessage
  | ProgressMessage
  | SystemMessage
  | AttachmentMessage
  | SystemLocalCommandMessage
  | (Message & { attachment?: RenderableAttachment })

// System message level
export type SystemMessageLevel = 'info' | 'warning' | 'error'

// Stop hook info
export type StopHookInfo = {
  hookName: string
  durationMs?: number
  output?: string
  error?: string
}

// System message subtypes
export type SystemInformationalMessage = SystemMessage & {
  level: SystemMessageLevel
  toolUseID?: string
  preventContinuation?: boolean
}

export type SystemPermissionRetryMessage = SystemMessage & {
  commands: string[]
  level: SystemMessageLevel
}

export type SystemBridgeStatusMessage = SystemMessage & {
  url: string
  upgradeNudge?: string
}

export type SystemScheduledTaskFireMessage = SystemMessage & {
  level: SystemMessageLevel
}

export type SystemStopHookSummaryMessage = SystemMessage & {
  hookCount: number
  hookInfos: StopHookInfo[]
  hookErrors: string[]
  preventedContinuation: boolean
  stopReason?: string
  hasOutput: boolean
  level: SystemMessageLevel
  toolUseID?: string
  hookLabel?: string
  totalDurationMs?: number
}

export type SystemTurnDurationMessage = SystemMessage & {
  durationMs: number
  budgetTokens?: number
  budgetLimit?: number
  budgetNudges?: number
  messageCount?: number
}

export type SystemAwaySummaryMessage = SystemMessage & {
  level: SystemMessageLevel
}

export type SystemMemorySavedMessage = SystemMessage & {
  writtenPaths: string[]
}

export type SystemAgentsKilledMessage = SystemMessage & {
  level: SystemMessageLevel
}

export type SystemApiMetricsMessage = SystemMessage & {
  ttftMs: number
  otps: number
  isP50?: boolean
  hookDurationMs?: number
  turnDurationMs?: number
  toolDurationMs?: number
  classifierDurationMs?: number
  toolCount?: number
  hookCount?: number
  classifierCount?: number
  configWriteCount?: number
}

export type SystemCompactBoundaryMessage = SystemMessage & {
  trigger: 'manual' | 'auto'
  preTokens: number
  logicalParentUuid?: string
  compactMetadata?: {
    trigger: string
    preTokens: number
    userContext?: string
    messagesSummarized: number
  }
}

export type SystemMicrocompactBoundaryMessage = SystemMessage & {
  microcompactMetadata: {
    trigger: 'auto'
    preTokens: number
    tokensSaved: number
    compactedToolIds: string[]
    clearedAttachmentUUIDs: string[]
  }
}

export type SystemThinkingMessage = SystemMessage & {
  level: SystemMessageLevel
}

export type SystemAPIErrorMessage = SystemMessage & {
  level: 'error'
  cause?: Error
  error: {
    type: string
    message: string
    status?: number
  }
  retryInMs: number
  retryAttempt: number
  maxRetries: number
}

// Tombstone message for hidden content
export type TombstoneMessage = {
  type: 'tombstone'
  id: string
}

// Tool use summary message
export type ToolUseSummaryMessage = {
  type: 'tool_summary'
  toolUseId: string
  content: string
}

// Request start event
export type RequestStartEvent = {
  type: 'request_start'
  requestId: string
}

// Stream event for API responses
export type StreamEvent = {
  type: 'stream_event'
  event: string
  data: unknown
}

// Hook result message
export type HookResultMessage = {
  type: 'hook_result'
  hookId: string
  outcome: 'success' | 'blocking' | 'non_blocking_error' | 'cancelled'
  content?: string
}

// Partial compact direction
export type PartialCompactDirection = {
  type: 'compact'
  preCompactMessageUuid: string
  postCompactMessageUuid: string
}

// Collapsible message - union of all message types that can be collapsed
export type CollapsibleMessage =
  | NormalizedAssistantMessage
  | { type: 'grouped_tool_use'; messages: NormalizedAssistantMessage[]; displayMessage: NormalizedAssistantMessage }
  | CollapsedReadSearchGroup

// Grouped tool use message
export type GroupedToolUseMessage = {
  type: 'grouped_tool_use'
  messages: NormalizedAssistantMessage[]
  displayMessage: NormalizedAssistantMessage
  uuid: string
  timestamp: number
}

// Collapsed read/search group message
export type CollapsedReadSearchGroup = {
  type: 'collapsed_read_search'
  searchCount: number
  readCount: number
  listCount: number
  replCount: number
  memorySearchCount: number
  memoryReadCount: number
  memoryWriteCount: number
  readFilePaths: string[]
  searchArgs: string[]
  latestDisplayHint?: string
  messages: NormalizedAssistantMessage[]
  displayMessage: NormalizedAssistantMessage
  uuid: string
  timestamp: number
  teamMemorySearchCount?: number
  teamMemoryReadCount?: number
  teamMemoryWriteCount?: number
  mcpCallCount?: number
  mcpServerNames?: string[]
  bashCount?: number
  gitOpBashCount?: number
  commits?: Array<{
    sha: string
    message: string
    timestamp: number
  }>
  pushes?: Array<{
    ref: string
    sha: string
    forced: boolean
  }>
  hookInfos?: Array<{
    command: string
    durationMs?: number
  }>
  hookCount?: number
  hookTotalMs?: number
  relevantMemories?: Array<{
    path: string
    content: string
  }>
}