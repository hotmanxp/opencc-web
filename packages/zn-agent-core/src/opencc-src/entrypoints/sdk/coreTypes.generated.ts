// AUTO-GENERATED — do not edit manually.
// Regenerate with: bun scripts/generate-sdk-types.ts
//
// Generated from Zod schemas in coreSchemas.ts
export type SDKUsage = {
  inputTokens: number
  outputTokens: number
  cacheReadInputTokens: number
  cacheCreationInputTokens: number
  webSearchRequests: number
  costUSD: number
  contextWindow: number
  maxOutputTokens: number
}

export type SDKUsage2 = ({
  type: "adaptive"
  }) | ({
  type: "enabled"
  budgetTokens?: number
  }) | ({
  type: "disabled"
})

export type SDKUsage3 = {
  type?: "stdio"
  command: string
  args?: string[]
  env?: Record<string, string>
}

export type SDKUsage4 = SDKUsage3 | ({
  type: "sse"
  url: string
  headers?: Record<string, string>
  }) | ({
  type: "http"
  url: string
  headers?: Record<string, string>
  }) | ({
  type: "sdk"
  name: string
})

export type SDKUsage5 = {
  readOnly?: boolean
  destructive?: boolean
  openWorld?: boolean
}

export type SDKUsage6 = {
  name: string
  status: "connected" | "failed" | "needs-auth" | "pending" | "disabled"
  serverInfo?: {
  name: string
  version: string
  }
  error?: string
  config?: SDKUsage4 | ({
  type: "claudeai-proxy"
  url: string
  id: string
  })
  scope?: string
  tools?: {
  name: string
  description?: string
  annotations?: SDKUsage5
  }[]
  capabilities?: {
  experimental?: Record<string, unknown>
  }
}

export type SDKUsage7 = {
  type: "addRules"
  rules: {
  toolName: string
  ruleContent?: string
  }[]
  behavior: "allow" | "deny" | "ask"
  destination: "userSettings" | "projectSettings" | "localSettings" | "session" | "cliArg"
}

export type SDKUsage8 = {
  type: "replaceRules"
  rules: {
  toolName: string
  ruleContent?: string
  }[]
  behavior: "allow" | "deny" | "ask"
  destination: "userSettings" | "projectSettings" | "localSettings" | "session" | "cliArg"
}

export type SDKUsage9 = {
  type: "removeRules"
  rules: {
  toolName: string
  ruleContent?: string
  }[]
  behavior: "allow" | "deny" | "ask"
  destination: "userSettings" | "projectSettings" | "localSettings" | "session" | "cliArg"
}

export type SDKUsage10 = {
  type: "setMode"
  mode: "default" | "acceptEdits" | "bypassPermissions" | "plan" | "dontAsk"
  destination: "userSettings" | "projectSettings" | "localSettings" | "session" | "cliArg"
}

export type SDKUsage11 = {
  type: "addDirectories"
  directories: string[]
  destination: "userSettings" | "projectSettings" | "localSettings" | "session" | "cliArg"
}

export type SDKUsage12 = {
  type: "removeDirectories"
  directories: string[]
  destination: "userSettings" | "projectSettings" | "localSettings" | "session" | "cliArg"
}

export type SDKUsage13 = {
  behavior: "allow"
  updatedInput?: Record<string, unknown>
  updatedPermissions?: (SDKUsage7 | SDKUsage8 | SDKUsage9 | SDKUsage10 | SDKUsage11 | SDKUsage12)[]
  toolUseID?: string
  decisionClassification?: "user_temporary" | "user_permanent" | "user_reject"
}

export type SDKUsage14 = {
  behavior: "deny"
  message: string
  interrupt?: boolean
  toolUseID?: string
  decisionClassification?: "user_temporary" | "user_permanent" | "user_reject"
}

export type SDKUsage15 = {
  session_id: string
  transcript_path: string
  cwd: string
  permission_mode?: string
  agent_id?: string
  agent_type?: string
}

export type SDKUsage16 = {
  hook_event_name: "PreToolUse"
  tool_name: string
  tool_input: unknown
  tool_use_id: string
}

export type SDKUsage17 = {
  hook_event_name: "PostToolUse"
  tool_name: string
  tool_input: unknown
  tool_response: unknown
  tool_use_id: string
}

export type SDKUsage18 = {
  hook_event_name: "PostToolUseFailure"
  tool_name: string
  tool_input: unknown
  tool_use_id: string
  error: string
  is_interrupt?: boolean
}

export type SDKUsage19 = {
  hook_event_name: "PermissionDenied"
  tool_name: string
  tool_input: unknown
  tool_use_id: string
  reason: string
}

export type SDKUsage20 = {
  hook_event_name: "Notification"
  message: string
  title?: string
  notification_type: string
}

export type SDKUsage21 = {
  hook_event_name: "SessionStart"
  source: "startup" | "resume" | "clear" | "compact"
  agent_type?: string
  model?: string
}

export type SDKUsage22 = {
  hook_event_name: "SessionEnd"
  reason: "clear" | "resume" | "logout" | "prompt_input_exit" | "other" | "bypass_permissions_disabled"
}

export type SDKUsage23 = {
  hook_event_name: "Stop"
  stop_hook_active: boolean
  last_assistant_message?: string
}

export type SDKUsage24 = {
  hook_event_name: "StopFailure"
  error: "authentication_failed" | "billing_error" | "rate_limit" | "invalid_request" | "server_error" | "unknown" | "max_output_tokens"
  error_details?: string
  last_assistant_message?: string
}

export type SDKUsage25 = SDKUsage15 & {
  hook_event_name: "SubagentStart"
  agent_id: string
  agent_type: string
}

export type SDKUsage26 = {
  hook_event_name: "SubagentStop"
  stop_hook_active: boolean
  agent_id: string
  agent_transcript_path: string
  agent_type: string
  last_assistant_message?: string
}

export type SDKUsage27 = {
  hook_event_name: "PreCompact"
  trigger: "manual" | "auto"
  custom_instructions: string | null
}

export type SDKUsage28 = {
  hook_event_name: "PostCompact"
  trigger: "manual" | "auto"
  compact_summary: string
}

export type SDKUsage29 = {
  hook_event_name: "PermissionRequest"
  tool_name: string
  tool_input: unknown
  permission_suggestions?: (SDKUsage7 | SDKUsage8 | SDKUsage9 | SDKUsage10 | SDKUsage11 | SDKUsage12)[]
}

export type SDKUsage30 = {
  hook_event_name: "TeammateIdle"
  teammate_name: string
  team_name: string
}

export type SDKUsage31 = {
  hook_event_name: "TaskCreated"
  task_id: string
  task_subject: string
  task_description?: string
  teammate_name?: string
  team_name?: string
}

export type SDKUsage32 = {
  hook_event_name: "TaskCompleted"
  task_id: string
  task_subject: string
  task_description?: string
  teammate_name?: string
  team_name?: string
}

export type SDKUsage33 = {
  hook_event_name: "Elicitation"
  mcp_server_name: string
  message: string
  mode?: "form" | "url"
  url?: string
  elicitation_id?: string
  requested_schema?: Record<string, unknown>
}

export type SDKUsage34 = {
  hook_event_name: "ElicitationResult"
  mcp_server_name: string
  elicitation_id?: string
  mode?: "form" | "url"
  action: "accept" | "decline" | "cancel"
  content?: Record<string, unknown>
}

export type SDKUsage35 = {
  hook_event_name: "ConfigChange"
  source: "user_settings" | "project_settings" | "local_settings" | "policy_settings" | "skills"
  file_path?: string
}

export type SDKUsage36 = {
  hook_event_name: "InstructionsLoaded"
  file_path: string
  memory_type: "User" | "Project" | "Local" | "Managed"
  load_reason: "session_start" | "nested_traversal" | "path_glob_match" | "include" | "compact"
  globs?: string[]
  trigger_file_path?: string
  parent_file_path?: string
}

export type SDKUsage37 = SDKUsage15 & {
  hook_event_name: "CwdChanged"
  old_cwd: string
  new_cwd: string
}

export type SDKUsage38 = {
  hook_event_name: "FileChanged"
  file_path: string
  event: "change" | "add" | "unlink"
}

export type SDKUsage39 = (SDKUsage15 & SDKUsage16) | (SDKUsage15 & SDKUsage17) | (SDKUsage15 & SDKUsage18) | (SDKUsage15 & SDKUsage19) | (SDKUsage15 & SDKUsage20) | (SDKUsage15 & {
  hook_event_name: "UserPromptSubmit"
  prompt: string
  }) | (SDKUsage15 & SDKUsage21) | (SDKUsage15 & SDKUsage22) | (SDKUsage15 & SDKUsage23) | (SDKUsage15 & SDKUsage24) | SDKUsage25 | (SDKUsage15 & SDKUsage26) | (SDKUsage15 & SDKUsage27) | (SDKUsage15 & SDKUsage28) | (SDKUsage15 & SDKUsage29) | (SDKUsage15 & {
  hook_event_name: "Setup"
  trigger: "init" | "maintenance"
  }) | (SDKUsage15 & SDKUsage30) | (SDKUsage15 & SDKUsage31) | (SDKUsage15 & SDKUsage32) | (SDKUsage15 & SDKUsage33) | (SDKUsage15 & SDKUsage34) | (SDKUsage15 & SDKUsage35) | (SDKUsage15 & SDKUsage36) | (SDKUsage15 & {
  hook_event_name: "WorktreeCreate"
  name: string
  }) | (SDKUsage15 & {
  hook_event_name: "WorktreeRemove"
  worktree_path: string
}) | SDKUsage37 | (SDKUsage15 & SDKUsage38)

export type SDKUsage40 = {
  hookEventName: "PreToolUse"
  permissionDecision?: "allow" | "deny" | "ask"
  permissionDecisionReason?: string
  updatedInput?: Record<string, unknown>
  additionalContext?: string
}

export type SDKUsage41 = {
  hookEventName: "SessionStart"
  additionalContext?: string
  initialUserMessage?: string
  watchPaths?: string[]
}

export type SDKUsage42 = {
  hookEventName: "PostToolUse"
  additionalContext?: string
  updatedMCPToolOutput?: unknown
}

export type SDKUsage43 = {
  behavior: "allow"
  updatedInput?: Record<string, unknown>
  updatedPermissions?: (SDKUsage7 | SDKUsage8 | SDKUsage9 | SDKUsage10 | SDKUsage11 | SDKUsage12)[]
}

export type SDKUsage44 = SDKUsage43 | ({
  behavior: "deny"
  message?: string
  interrupt?: boolean
})

export type SDKUsage45 = {
  hookEventName: "Elicitation"
  action?: "accept" | "decline" | "cancel"
  content?: Record<string, unknown>
}

export type SDKUsage46 = {
  hookEventName: "ElicitationResult"
  action?: "accept" | "decline" | "cancel"
  content?: Record<string, unknown>
}

export type SDKUsage47 = SDKUsage40 | ({
  hookEventName: "UserPromptSubmit"
  additionalContext?: string
  }) | SDKUsage41 | ({
  hookEventName: "Setup"
  additionalContext?: string
  }) | ({
  hookEventName: "SubagentStart"
  additionalContext?: string
  }) | SDKUsage42 | ({
  hookEventName: "PostToolUseFailure"
  additionalContext?: string
  }) | ({
  hookEventName: "PermissionDenied"
  retry?: boolean
  }) | ({
  hookEventName: "Notification"
  additionalContext?: string
  }) | ({
  hookEventName: "PermissionRequest"
  decision: SDKUsage44
  }) | SDKUsage45 | SDKUsage46 | ({
  hookEventName: "CwdChanged"
  watchPaths?: string[]
  }) | ({
  hookEventName: "FileChanged"
  watchPaths?: string[]
  }) | ({
  hookEventName: "WorktreeCreate"
  worktreePath: string
})

export type SDKUsage48 = {
  continue?: boolean
  suppressOutput?: boolean
  stopReason?: string
  decision?: "approve" | "block"
  systemMessage?: string
  reason?: string
  hookSpecificOutput?: SDKUsage47
}

export type SDKUsage49 = {
  prompt: string
  message: string
  options: {
  key: string
  label: string
  description?: string
  }[]
}

export type SDKUsage50 = {
  value: string
  displayName: string
  description: string
  supportsEffort?: boolean
  supportedEffortLevels?: ("low" | "medium" | "high" | "max")[]
  supportsAdaptiveThinking?: boolean
  supportsFastMode?: boolean
  supportsAutoMode?: boolean
}

export type SDKUsage51 = {
  email?: string
  organization?: string
  subscriptionType?: string
  tokenSource?: string
  apiKeySource?: string
  apiProvider?: "firstParty" | "bedrock" | "vertex" | "foundry" | "openai" | "gemini" | "github" | "codex" | "nvidia-nim" | "minimax" | "mistral" | "xai" | "xiaomi-mimo"
}

export type SDKUsage52 = {
  description: string
  tools?: string[]
  disallowedTools?: string[]
  prompt: string
  model?: string
  mcpServers?: (string | Record<string, SDKUsage4>)[]
  criticalSystemReminder_EXPERIMENTAL?: string
  skills?: string[]
  initialPrompt?: string
  maxTurns?: number
  background?: boolean
  memory?: "user" | "project" | "local"
  effort?: "low" | "medium" | "high" | "max" | number
  permissionMode?: "default" | "acceptEdits" | "bypassPermissions" | "plan" | "dontAsk"
}

export type SDKUsage53 = {
  canRewind: boolean
  error?: string
  filesChanged?: string[]
  insertions?: number
  deletions?: number
}

export type SDKUsage54 = {
  type: "user"
  message: Record<string, unknown> & { role: "user", content: string | Array<unknown> }
  parent_tool_use_id: string | null
  isSynthetic?: boolean
  tool_use_result?: unknown
  priority?: "now" | "next" | "later"
  timestamp?: string
  uuid?: string
  session_id?: string
}

export type SDKUsage55 = {
  type: "user"
  message: Record<string, unknown> & { role: "user", content: string | Array<unknown> }
  parent_tool_use_id: string | null
  isSynthetic?: boolean
  tool_use_result?: unknown
  priority?: "now" | "next" | "later"
  timestamp?: string
  uuid: string
  session_id: string
  isReplay: true
}

export type SDKUsage56 = {
  status: "allowed" | "allowed_warning" | "rejected"
  resetsAt?: number
  rateLimitType?: "five_hour" | "seven_day" | "seven_day_opus" | "seven_day_sonnet" | "overage"
  utilization?: number
  overageStatus?: "allowed" | "allowed_warning" | "rejected"
  overageResetsAt?: number
  overageDisabledReason?: "overage_not_provisioned" | "org_level_disabled" | "org_level_disabled_until" | "out_of_credits" | "seat_tier_level_disabled" | "member_level_disabled" | "seat_tier_zero_credit_limit" | "group_zero_credit_limit" | "member_zero_credit_limit" | "org_service_level_disabled" | "org_service_zero_credit_limit" | "no_limits_configured" | "unknown"
  isUsingOverage?: boolean
  surpassedThreshold?: number
}

export type SDKUsage57 = {
  type: "assistant"
  message: Record<string, unknown> & { role: "assistant", content: Array<unknown> }
  parent_tool_use_id: string | null
  error?: "authentication_failed" | "billing_error" | "rate_limit" | "invalid_request" | "server_error" | "unknown" | "max_output_tokens"
  uuid: string
  session_id: string
}

export type SDKUsage58 = {
  type: "rate_limit_event"
  rate_limit_info: SDKUsage56
  uuid: string
  session_id: string
}

export type SDKUsage59 = {
  type: "streamlined_text"
  text: string
  session_id: string
  uuid: string
}

export type SDKUsage60 = {
  type: "streamlined_tool_use_summary"
  tool_summary: string
  session_id: string
  uuid: string
}

export type SDKUsage61 = {
  tool_name: string
  tool_use_id: string
  tool_input: Record<string, unknown>
}

export type SDKUsage62 = {
  type: "result"
  subtype: "success"
  duration_ms: number
  duration_api_ms: number
  is_error: boolean
  num_turns: number
  result: string
  stop_reason: string | null
  total_cost_usd: number
  usage: { input_tokens: number; output_tokens: number; cache_creation_input_tokens: number; cache_read_input_tokens: number; cache_creation?: { ephemeral_1h_input_tokens?: number; ephemeral_5m_input_tokens?: number }; server_tool_use?: { web_search_requests?: number; web_fetch_requests?: number }; service_tier?: string; [key: string]: unknown }
  modelUsage: Record<string, SDKUsage>
  permission_denials: SDKUsage61[]
  structured_output?: unknown
  fast_mode_state?: "off" | "cooldown" | "on"
  uuid: string
  session_id: string
}

export type SDKUsage63 = {
  type: "result"
  subtype: "error_during_execution" | "error_max_turns" | "error_max_budget_usd" | "error_max_structured_output_retries"
  duration_ms: number
  duration_api_ms: number
  is_error: boolean
  num_turns: number
  stop_reason: string | null
  total_cost_usd: number
  usage: { input_tokens: number; output_tokens: number; cache_creation_input_tokens: number; cache_read_input_tokens: number; cache_creation?: { ephemeral_1h_input_tokens?: number; ephemeral_5m_input_tokens?: number }; server_tool_use?: { web_search_requests?: number; web_fetch_requests?: number }; service_tier?: string; [key: string]: unknown }
  modelUsage: Record<string, SDKUsage>
  permission_denials: SDKUsage61[]
  errors: string[]
  fast_mode_state?: "off" | "cooldown" | "on"
  uuid: string
  session_id: string
}

export type SDKUsage64 = {
  type: "system"
  subtype: "init"
  agents?: string[]
  apiKeySource: "user" | "project" | "org" | "temporary" | "oauth" | "none"
  betas?: string[]
  claude_code_version: string
  cwd: string
  tools: string[]
  mcp_servers: {
  name: string
  status: string
  }[]
  model: string
  permissionMode: "default" | "acceptEdits" | "bypassPermissions" | "plan" | "dontAsk"
  slash_commands: string[]
  output_style: string
  skills: string[]
  plugins: {
  name: string
  path: string
  source?: string
  }[]
  fast_mode_state?: "off" | "cooldown" | "on"
  uuid: string
  session_id: string
}

export type SDKUsage65 = {
  type: "stream_event"
  event: Record<string, unknown>
  parent_tool_use_id: string | null
  uuid: string
  session_id: string
}

export type SDKUsage66 = {
  head_uuid: string
  anchor_uuid: string
  tail_uuid: string
}

export type SDKUsage67 = {
  trigger: "manual" | "auto"
  pre_tokens: number
  preserved_segment?: SDKUsage66
}

export type SDKUsage68 = {
  type: "system"
  subtype: "compact_boundary"
  compact_metadata: SDKUsage67
  uuid: string
  session_id: string
}

export type SDKUsage69 = {
  type: "system"
  subtype: "status"
  status: "compacting" | null
  permissionMode?: "default" | "acceptEdits" | "bypassPermissions" | "plan" | "dontAsk"
  uuid: string
  session_id: string
}

export type SDKUsage70 = {
  type: "system"
  subtype: "post_turn_summary"
  summarizes_uuid: string
  status_category: "blocked" | "waiting" | "completed" | "review_ready" | "failed"
  status_detail: string
  is_noteworthy: boolean
  title: string
  description: string
  recent_action: string
  needs_action: string
  artifact_urls: string[]
  uuid: string
  session_id: string
}

export type SDKUsage71 = {
  type: "system"
  subtype: "api_retry"
  attempt: number
  max_retries: number
  retry_delay_ms: number
  error_status: number | null
  error: "authentication_failed" | "billing_error" | "rate_limit" | "invalid_request" | "server_error" | "unknown" | "max_output_tokens"
  uuid: string
  session_id: string
}

export type SDKUsage72 = {
  type: "system"
  subtype: "local_command_output"
  content: string
  uuid: string
  session_id: string
}

export type SDKUsage73 = {
  type: "system"
  subtype: "hook_started"
  hook_id: string
  hook_name: string
  hook_event: string
  uuid: string
  session_id: string
}

export type SDKUsage74 = {
  type: "system"
  subtype: "hook_progress"
  hook_id: string
  hook_name: string
  hook_event: string
  stdout: string
  stderr: string
  output: string
  uuid: string
  session_id: string
}

export type SDKUsage75 = {
  type: "system"
  subtype: "hook_response"
  hook_id: string
  hook_name: string
  hook_event: string
  output: string
  stdout: string
  stderr: string
  exit_code?: number
  outcome: "success" | "error" | "cancelled"
  uuid: string
  session_id: string
}

export type SDKUsage76 = {
  type: "tool_progress"
  tool_use_id: string
  tool_name: string
  parent_tool_use_id: string | null
  elapsed_time_seconds: number
  task_id?: string
  uuid: string
  session_id: string
}

export type SDKUsage77 = {
  type: "auth_status"
  isAuthenticating: boolean
  output: string[]
  error?: string
  uuid: string
  session_id: string
}

export type SDKUsage78 = {
  type: "system"
  subtype: "files_persisted"
  files: {
  filename: string
  file_id: string
  }[]
  failed: {
  filename: string
  error: string
  }[]
  processed_at: string
  uuid: string
  session_id: string
}

export type SDKUsage79 = {
  type: "system"
  subtype: "task_notification"
  task_id: string
  tool_use_id?: string
  status: "completed" | "failed" | "stopped"
  output_file: string
  summary: string
  usage?: {
  total_tokens: number
  tool_uses: number
  duration_ms: number
  }
  uuid: string
  session_id: string
}

export type SDKUsage80 = {
  type: "system"
  subtype: "task_started"
  task_id: string
  tool_use_id?: string
  description: string
  task_type?: string
  workflow_name?: string
  prompt?: string
  uuid: string
  session_id: string
}

export type SDKUsage81 = {
  type: "system"
  subtype: "task_progress"
  task_id: string
  tool_use_id?: string
  description: string
  usage: {
  total_tokens: number
  tool_uses: number
  duration_ms: number
  }
  last_tool_name?: string
  summary?: string
  uuid: string
  session_id: string
}

export type SDKUsage82 = {
  type: "system"
  subtype: "session_state_changed"
  state: "idle" | "running" | "requires_action"
  uuid: string
  session_id: string
}

export type SDKUsage83 = {
  type: "system"
  subtype: "heartbeat"
  timestamp: string
  elapsed_ms: number
  since_last_activity_ms: number
  state: "starting" | "running" | "requires_action" | "idle" | "shutting_down"
  phase: "startup" | "loading_session" | "connecting_mcp" | "draining_commands" | "in_turn" | "waiting_for_permission" | "waiting_for_agents" | "flushing" | "shutting_down"
  heartbeat_index: number
  pending_permission_requests: number
  background_tasks: Record<string, number>
  uuid: string
  session_id: string
}

export type SDKUsage84 = {
  type: "tool_use_summary"
  summary: string
  preceding_tool_use_ids: string[]
  uuid: string
  session_id: string
}

export type SDKUsage85 = {
  type: "system"
  subtype: "elicitation_complete"
  mcp_server_name: string
  elicitation_id: string
  uuid: string
  session_id: string
}

export type SDKUsage86 = {
  type: "prompt_suggestion"
  suggestion: string
  uuid: string
  session_id: string
}

export type SDKUsage87 = {
  sessionId: string
  summary: string
  lastModified: number
  fileSize?: number
  customTitle?: string
  firstPrompt?: string
  gitBranch?: string
  cwd?: string
  tag?: string
  createdAt?: number
}

export type SDKUsage88 = {
  type: "permission_request"
  request_id: string
  tool_name: string
  tool_use_id: string
  input: Record<string, unknown>
  uuid: string
  session_id: string
}


export type ModelUsage = SDKUsage

export type OutputFormatType = "json_schema"

export type BaseOutputFormat = {
  type: "json_schema"
}

export type JsonSchemaOutputFormat = {
  type: "json_schema"
  schema: Record<string, unknown>
}

export type OutputFormat = {
  type: "json_schema"
  schema: Record<string, unknown>
}

export type ApiKeySource = "user" | "project" | "org" | "temporary" | "oauth" | "none"

/** Config scope for settings. */
export type ConfigScope = "local" | "user" | "project"

export type SdkBeta = "context-1m-2025-08-07"

/** OpenCC decides when and how much to think (Opus 4.6+). */
export type ThinkingAdaptive = {
  type: "adaptive"
}

/** Fixed thinking token budget (older models) */
export type ThinkingEnabled = {
  type: "enabled"
  budgetTokens?: number
}

/** No extended thinking */
export type ThinkingDisabled = {
  type: "disabled"
}

/** Controls OpenCC's thinking/reasoning behavior. When set, takes precedence over the deprecated maxThinkingTokens. */
export type ThinkingConfig = SDKUsage2

export type McpStdioServerConfig = SDKUsage3

export type McpSSEServerConfig = {
  type: "sse"
  url: string
  headers?: Record<string, string>
}

export type McpHttpServerConfig = {
  type: "http"
  url: string
  headers?: Record<string, string>
}

export type McpSdkServerConfig = {
  type: "sdk"
  name: string
}

export type McpServerConfigForProcessTransport = SDKUsage4

export type McpClaudeAIProxyServerConfig = {
  type: "claudeai-proxy"
  url: string
  id: string
}

export type McpServerStatusConfig = SDKUsage4 | ({
  type: "claudeai-proxy"
  url: string
  id: string
})

/** Status information for an MCP server connection. */
export type McpServerStatus = SDKUsage6

/** Result of a setMcpServers operation. */
export type McpSetServersResult = {
  added: string[]
  removed: string[]
  errors: Record<string, string>
}

export type PermissionUpdateDestination = "userSettings" | "projectSettings" | "localSettings" | "session" | "cliArg"

export type PermissionBehavior = "allow" | "deny" | "ask"

export type PermissionRuleValue = {
  toolName: string
  ruleContent?: string
}

export type PermissionUpdate = SDKUsage7 | SDKUsage8 | SDKUsage9 | SDKUsage10 | SDKUsage11 | SDKUsage12

/** Classification of this permission decision for telemetry. SDK hosts that prompt users (desktop apps, IDEs) should set this to reflect what actually happened: user_temporary for allow-once, user_permanent for always-allow (both the click and later cache hits), user_reject for deny. If unset, the CLI infers conservatively (temporary for allow, reject for deny). The vocabulary matches tool_decision OTel events (monitoring-usage docs). */
export type PermissionDecisionClassification = "user_temporary" | "user_permanent" | "user_reject"

export type PermissionResult = SDKUsage13 | SDKUsage14

/** Permission mode for controlling how tool executions are handled. 'default' - Standard behavior, prompts for dangerous operations. 'acceptEdits' - Auto-accept file edit operations. 'bypassPermissions' - Bypass all permission checks (requires allowDangerouslySkipPermissions). 'plan' - Planning mode, no actual tool execution. 'dontAsk' - Don't prompt for permissions, deny if not pre-approved. */
export type PermissionMode = "default" | "acceptEdits" | "bypassPermissions" | "plan" | "dontAsk"

export type HookEvent = "PreToolUse" | "PostToolUse" | "PostToolUseFailure" | "Notification" | "UserPromptSubmit" | "SessionStart" | "SessionEnd" | "Stop" | "StopFailure" | "SubagentStart" | "SubagentStop" | "PreCompact" | "PostCompact" | "PermissionRequest" | "PermissionDenied" | "Setup" | "TeammateIdle" | "TaskCreated" | "TaskCompleted" | "Elicitation" | "ElicitationResult" | "ConfigChange" | "WorktreeCreate" | "WorktreeRemove" | "InstructionsLoaded" | "CwdChanged" | "FileChanged"

export type BaseHookInput = SDKUsage15

export type PreToolUseHookInput = SDKUsage15 & SDKUsage16

export type PostToolUseHookInput = SDKUsage15 & SDKUsage17

export type PostToolUseFailureHookInput = SDKUsage15 & SDKUsage18

export type PermissionDeniedHookInput = SDKUsage15 & SDKUsage19

export type NotificationHookInput = SDKUsage15 & SDKUsage20

export type UserPromptSubmitHookInput = SDKUsage15 & {
  hook_event_name: "UserPromptSubmit"
  prompt: string
}

export type SessionStartHookInput = SDKUsage15 & SDKUsage21

export type SessionEndHookInput = SDKUsage15 & SDKUsage22

export type StopHookInput = SDKUsage15 & SDKUsage23

export type StopFailureHookInput = SDKUsage15 & SDKUsage24

export type SubagentStartHookInput = SDKUsage25

export type SubagentStopHookInput = SDKUsage15 & SDKUsage26

export type PreCompactHookInput = SDKUsage15 & SDKUsage27

export type PostCompactHookInput = SDKUsage15 & SDKUsage28

export type PermissionRequestHookInput = SDKUsage15 & SDKUsage29

export type SetupHookInput = SDKUsage15 & {
  hook_event_name: "Setup"
  trigger: "init" | "maintenance"
}

export type TeammateIdleHookInput = SDKUsage15 & SDKUsage30

export type TaskCreatedHookInput = SDKUsage15 & SDKUsage31

export type TaskCompletedHookInput = SDKUsage15 & SDKUsage32

/** Hook input for the Elicitation event. Fired when an MCP server requests user input. Hooks can auto-respond (accept/decline) instead of showing the dialog. */
export type ElicitationHookInput = SDKUsage15 & SDKUsage33

/** Hook input for the ElicitationResult event. Fired after the user responds to an MCP elicitation. Hooks can observe or override the response before it is sent to the server. */
export type ElicitationResultHookInput = SDKUsage15 & SDKUsage34

export type ConfigChangeHookInput = SDKUsage15 & SDKUsage35

export type InstructionsLoadedHookInput = SDKUsage15 & SDKUsage36

export type WorktreeCreateHookInput = SDKUsage15 & {
  hook_event_name: "WorktreeCreate"
  name: string
}

export type WorktreeRemoveHookInput = SDKUsage15 & {
  hook_event_name: "WorktreeRemove"
  worktree_path: string
}

export type CwdChangedHookInput = SDKUsage37

export type FileChangedHookInput = SDKUsage15 & SDKUsage38

export type HookInput = SDKUsage39

export type AsyncHookJSONOutput = {
  async: true
  asyncTimeout?: number
}

export type PreToolUseHookSpecificOutput = SDKUsage40

export type UserPromptSubmitHookSpecificOutput = {
  hookEventName: "UserPromptSubmit"
  additionalContext?: string
}

export type SessionStartHookSpecificOutput = SDKUsage41

export type SetupHookSpecificOutput = {
  hookEventName: "Setup"
  additionalContext?: string
}

export type SubagentStartHookSpecificOutput = {
  hookEventName: "SubagentStart"
  additionalContext?: string
}

export type PostToolUseHookSpecificOutput = SDKUsage42

export type PostToolUseFailureHookSpecificOutput = {
  hookEventName: "PostToolUseFailure"
  additionalContext?: string
}

export type PermissionDeniedHookSpecificOutput = {
  hookEventName: "PermissionDenied"
  retry?: boolean
}

export type NotificationHookSpecificOutput = {
  hookEventName: "Notification"
  additionalContext?: string
}

export type PermissionRequestHookSpecificOutput = {
  hookEventName: "PermissionRequest"
  decision: SDKUsage44
}

export type CwdChangedHookSpecificOutput = {
  hookEventName: "CwdChanged"
  watchPaths?: string[]
}

export type FileChangedHookSpecificOutput = {
  hookEventName: "FileChanged"
  watchPaths?: string[]
}

/** Hook-specific output for the Elicitation event. Return this to programmatically accept or decline an MCP elicitation request. */
export type ElicitationHookSpecificOutput = SDKUsage45

/** Hook-specific output for the ElicitationResult event. Return this to override the action or content before the response is sent to the MCP server. */
export type ElicitationResultHookSpecificOutput = SDKUsage46

/** Hook-specific output for the WorktreeCreate event. Provides the absolute path to the created worktree directory. Command hooks print the path on stdout instead. */
export type WorktreeCreateHookSpecificOutput = {
  hookEventName: "WorktreeCreate"
  worktreePath: string
}

export type SyncHookJSONOutput = SDKUsage48

export type HookJSONOutput = ({
  async: true
  asyncTimeout?: number
}) | SDKUsage48

export type PromptRequestOption = {
  key: string
  label: string
  description?: string
}

export type PromptRequest = SDKUsage49

export type PromptResponse = {
  prompt_response: string
  selected: string
}

/** Information about an available skill (invoked via /command syntax). */
export type SlashCommand = {
  name: string
  description: string
  argumentHint: string
}

/** Information about an available subagent that can be invoked via the Task tool. */
export type AgentInfo = {
  name: string
  description: string
  model?: string
}

/** Information about an available model. */
export type ModelInfo = SDKUsage50

/** Information about the logged in user's account. */
export type AccountInfo = SDKUsage51

export type AgentMcpServerSpec = string | Record<string, SDKUsage4>

/** Definition for a custom subagent that can be invoked via the Agent tool. */
export type AgentDefinition = SDKUsage52

/** Source for loading filesystem-based settings. 'user' - Global user settings (~/.zai/settings.json). 'project' - Project settings (.zai/settings.json). 'local' - Local settings (.zai/settings.local.json). */
export type SettingSource = "user" | "project" | "local"

/** Configuration for loading a plugin. */
export type SdkPluginConfig = {
  type: "local"
  path: string
}

/** Result of a rewindFiles operation. */
export type RewindFilesResult = SDKUsage53

export type SDKAssistantMessageError = "authentication_failed" | "billing_error" | "rate_limit" | "invalid_request" | "server_error" | "unknown" | "max_output_tokens"

export type SDKStatus = "compacting" | null

export type SDKUserMessage = SDKUsage54

export type SDKUserMessageReplay = SDKUsage55

/** Rate limit information for claude.ai subscription users. */
export type SDKRateLimitInfo = SDKUsage56

export type SDKAssistantMessage = SDKUsage57

/** Rate limit event emitted when rate limit info changes. */
export type SDKRateLimitEvent = SDKUsage58

/** @internal Streamlined text message - replaces SDKAssistantMessage in streamlined output. Text content preserved, thinking and tool_use blocks removed. */
export type SDKStreamlinedTextMessage = SDKUsage59

/** @internal Streamlined tool use summary - replaces tool_use blocks in streamlined output with a cumulative summary string. */
export type SDKStreamlinedToolUseSummaryMessage = SDKUsage60

export type SDKPermissionDenial = SDKUsage61

export type SDKResultSuccess = SDKUsage62

export type SDKResultError = SDKUsage63

export type SDKResultMessage = SDKUsage62 | SDKUsage63

export type SDKSystemMessage = SDKUsage64

export type SDKPartialAssistantMessage = SDKUsage65

export type SDKCompactBoundaryMessage = SDKUsage68

export type SDKStatusMessage = SDKUsage69

/** @internal Background post-turn summary emitted after each assistant turn. summarizes_uuid points to the assistant message this summarizes. */
export type SDKPostTurnSummaryMessage = SDKUsage70

/** Emitted when an API request fails with a retryable error and will be retried after a delay. error_status is null for connection errors (e.g. timeouts) that had no HTTP response. */
export type SDKAPIRetryMessage = SDKUsage71

/** Output from a local slash command (e.g. /voice, /cost). Displayed as assistant-style text in the transcript. */
export type SDKLocalCommandOutputMessage = SDKUsage72

export type SDKHookStartedMessage = SDKUsage73

export type SDKHookProgressMessage = SDKUsage74

export type SDKHookResponseMessage = SDKUsage75

export type SDKToolProgressMessage = SDKUsage76

export type SDKAuthStatusMessage = SDKUsage77

export type SDKFilesPersistedEvent = SDKUsage78

export type SDKTaskNotificationMessage = SDKUsage79

export type SDKTaskStartedMessage = SDKUsage80

export type SDKTaskProgressMessage = SDKUsage81

/** Mirrors notifySessionStateChanged. 'idle' fires after heldBackResult flushes and the bg-agent do-while exits — authoritative turn-over signal. */
export type SDKSessionStateChangedMessage = SDKUsage82

/** Opt-in headless liveness signal emitted while --print output is quiet. */
export type SDKHeartbeatMessage = SDKUsage83

export type SDKToolUseSummaryMessage = SDKUsage84

/** Emitted when an MCP server confirms that a URL-mode elicitation is complete. */
export type SDKElicitationCompleteMessage = SDKUsage85

/** Predicted next user prompt, emitted after each turn when promptSuggestions is enabled. */
export type SDKPromptSuggestionMessage = SDKUsage86

/** Session metadata returned by listSessions and getSessionInfo. */
export type SDKSessionInfo = SDKUsage87

export type SDKMessage = SDKUsage57 | SDKUsage54 | SDKUsage55 | SDKUsage62 | SDKUsage63 | SDKUsage64 | SDKUsage65 | SDKUsage68 | SDKUsage69 | SDKUsage71 | SDKUsage72 | SDKUsage73 | SDKUsage74 | SDKUsage75 | SDKUsage76 | SDKUsage77 | SDKUsage79 | SDKUsage80 | SDKUsage81 | SDKUsage82 | SDKUsage83 | SDKUsage78 | SDKUsage84 | SDKUsage58 | SDKUsage85 | SDKUsage86 | SDKUsage88

/** Fast mode state: off, in cooldown after rate limit, or actively enabled. */
export type FastModeState = "off" | "cooldown" | "on"

export type ExitReason = "clear" | "resume" | "logout" | "prompt_input_exit" | "other" | "bypass_permissions_disabled"
