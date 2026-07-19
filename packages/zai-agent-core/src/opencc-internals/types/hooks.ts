// @ts-nocheck
// biome-ignore-all assist/source/organizeImports: internal-only import markers must not be reordered
import { z } from 'zod/v4'
import { lazySchema } from '../utils/lazySchema.js'
import {
  type HookEvent,
  HOOK_EVENTS,
  type PermissionUpdate,
  type HookJSONOutput as SDKHookJSONOutput,
} from 'src/entrypoints/agentSdkTypes.js'

// Re-export SDK types
export type { HookJSONOutput as SDKHookJSONOutput } from 'src/entrypoints/agentSdkTypes.js'
export { HOOK_EVENTS } from 'src/entrypoints/agentSdkTypes.js'
export type { HookEvent, PermissionUpdate } from 'src/entrypoints/agentSdkTypes.js'
// HookInput is the generic SDK type - used for callback signatures
export type HookInput = {
  [key: string]: unknown
}

// Sync hook response (non-async)
export type SyncHookJSONOutput = {
  continue?: boolean
  suppressOutput?: boolean
  stopReason?: string
  decision?: 'approve' | 'block'
  reason?: string
  systemMessage?: string
  hookSpecificOutput?: HookSpecificOutput
  async?: false
}

// Async hook response
export type AsyncHookJSONOutput = {
  async: true
  asyncTimeout?: number
}

// Hook specific output union type based on the Zod schema
export type HookSpecificOutput =
  | { hookEventName: 'PreToolUse'; permissionDecision?: 'allow' | 'deny' | 'ask'; permissionDecisionReason?: string; updatedInput?: Record<string, unknown>; additionalContext?: string }
  | { hookEventName: 'UserPromptSubmit'; additionalContext?: string }
  | { hookEventName: 'SessionStart'; additionalContext?: string; initialUserMessage?: string; watchPaths?: string[] }
  | { hookEventName: 'Setup'; additionalContext?: string }
  | { hookEventName: 'SubagentStart'; additionalContext?: string }
  | { hookEventName: 'PostToolUse'; additionalContext?: string; updatedMCPToolOutput?: unknown }
  | { hookEventName: 'PostToolUseFailure'; additionalContext?: string }
  | { hookEventName: 'PermissionDenied'; retry?: boolean }
  | { hookEventName: 'Notification'; additionalContext?: string }
  | { hookEventName: 'PermissionRequest'; decision?: { behavior: 'allow'; updatedInput?: Record<string, unknown>; updatedPermissions?: unknown[] } | { behavior: 'deny'; message?: string; interrupt?: boolean } }
  | { hookEventName: 'Elicitation'; action?: 'accept' | 'decline' | 'cancel'; content?: Record<string, unknown> }
  | { hookEventName: 'ElicitationResult'; action?: 'accept' | 'decline' | 'cancel'; content?: Record<string, unknown> }
  | { hookEventName: 'CwdChanged'; watchPaths?: string[] }
  | { hookEventName: 'FileChanged'; watchPaths?: string[] }
  | { hookEventName: 'WorktreeCreate'; worktreePath: string }

// Combined hook JSON output type
export type CombinedHookJSONOutput = SyncHookJSONOutput | AsyncHookJSONOutput

// HookJSONOutput type - use our proper type instead of SDK's generic { [key: string]: unknown }
export type HookJSONOutput = CombinedHookJSONOutput
import type { Message } from 'src/types/message.js'
import type { PermissionResult } from 'src/utils/permissions/PermissionResult.js'
import { permissionBehaviorSchema } from 'src/utils/permissions/PermissionRule.js'
import { permissionUpdateSchema } from 'src/utils/permissions/PermissionUpdateSchema.js'
import type { AppState } from '../state/AppState.js'
import type { AttributionState } from '../utils/commitAttribution.js'

export function isHookEvent(value: string): value is HookEvent {
  return HOOK_EVENTS.includes(value as HookEvent)
}

// Prompt elicitation protocol types. The `prompt` key acts as discriminator
// (mirroring the {async:true} pattern), with the id as its value.
export const promptRequestSchema = lazySchema(() =>
  z.object({
    prompt: z.string(), // request id
    message: z.string(),
    options: z.array(
      z.object({
        key: z.string(),
        label: z.string(),
        description: z.string().optional(),
      }),
    ),
  }),
)

export type PromptRequest = z.infer<ReturnType<typeof promptRequestSchema>>

export type PromptResponse = {
  prompt_response: string // request id
  selected: string
}

// Sync hook response schema
export const syncHookResponseSchema = lazySchema(() =>
  z.object({
    continue: z
      .boolean()
      .describe('Whether OpenCC should continue after hook (default: true)')
      .optional(),
    suppressOutput: z
      .boolean()
      .describe('Hide stdout from transcript (default: false)')
      .optional(),
    stopReason: z
      .string()
      .describe('Message shown when continue is false')
      .optional(),
    decision: z.enum(['approve', 'block']).optional(),
    reason: z.string().describe('Explanation for the decision').optional(),
    systemMessage: z
      .string()
      .describe('Warning message shown to the user')
      .optional(),
    hookSpecificOutput: z
      .union([
        z.object({
          hookEventName: z.literal('PreToolUse'),
          permissionDecision: permissionBehaviorSchema().optional(),
          permissionDecisionReason: z.string().optional(),
          updatedInput: z.record(z.string(), z.unknown()).optional(),
          additionalContext: z.string().optional(),
        }),
        z.object({
          hookEventName: z.literal('UserPromptSubmit'),
          additionalContext: z.string().optional(),
        }),
        z.object({
          hookEventName: z.literal('SessionStart'),
          additionalContext: z.string().optional(),
          initialUserMessage: z.string().optional(),
          watchPaths: z
            .array(z.string())
            .describe('Absolute paths to watch for FileChanged hooks')
            .optional(),
        }),
        z.object({
          hookEventName: z.literal('Setup'),
          additionalContext: z.string().optional(),
        }),
        z.object({
          hookEventName: z.literal('SubagentStart'),
          additionalContext: z.string().optional(),
        }),
        z.object({
          hookEventName: z.literal('PostToolUse'),
          additionalContext: z.string().optional(),
          updatedMCPToolOutput: z
            .unknown()
            .describe('Updates the output for MCP tools')
            .optional(),
        }),
        z.object({
          hookEventName: z.literal('PostToolUseFailure'),
          additionalContext: z.string().optional(),
        }),
        z.object({
          hookEventName: z.literal('PermissionDenied'),
          retry: z.boolean().optional(),
        }),
        z.object({
          hookEventName: z.literal('Notification'),
          additionalContext: z.string().optional(),
        }),
        z.object({
          hookEventName: z.literal('PermissionRequest'),
          decision: z.union([
            z.object({
              behavior: z.literal('allow'),
              updatedInput: z.record(z.string(), z.unknown()).optional(),
              updatedPermissions: z.array(permissionUpdateSchema()).optional(),
            }),
            z.object({
              behavior: z.literal('deny'),
              message: z.string().optional(),
              interrupt: z.boolean().optional(),
            }),
          ]),
        }),
        z.object({
          hookEventName: z.literal('Elicitation'),
          action: z.enum(['accept', 'decline', 'cancel']).optional(),
          content: z.record(z.string(), z.unknown()).optional(),
        }),
        z.object({
          hookEventName: z.literal('ElicitationResult'),
          action: z.enum(['accept', 'decline', 'cancel']).optional(),
          content: z.record(z.string(), z.unknown()).optional(),
        }),
        z.object({
          hookEventName: z.literal('CwdChanged'),
          watchPaths: z
            .array(z.string())
            .describe('Absolute paths to watch for FileChanged hooks')
            .optional(),
        }),
        z.object({
          hookEventName: z.literal('FileChanged'),
          watchPaths: z
            .array(z.string())
            .describe('Absolute paths to watch for FileChanged hooks')
            .optional(),
        }),
        z.object({
          hookEventName: z.literal('WorktreeCreate'),
          worktreePath: z.string(),
        }),
      ])
      .optional(),
  }),
)

// Zod schema for hook JSON output validation
export const hookJSONOutputSchema = lazySchema(() => {
  // Async hook response schema
  const asyncHookResponseSchema = z.object({
    async: z.literal(true),
    asyncTimeout: z.number().optional(),
  })
  return z.union([asyncHookResponseSchema, syncHookResponseSchema()])
})

// Infer the TypeScript type from the schema
type SchemaHookJSONOutput = z.infer<ReturnType<typeof hookJSONOutputSchema>>

// Type guard function to check if response is sync
export function isSyncHookJSONOutput(
  json: HookJSONOutput,
): json is SyncHookJSONOutput {
  return !('async' in json && json.async === true)
}

// Type guard function to check if response is async
export function isAsyncHookJSONOutput(
  json: HookJSONOutput,
): json is AsyncHookJSONOutput {
  return 'async' in json && json.async === true
}

/** Context passed to callback hooks for state access */
export type HookCallbackContext = {
  getAppState: () => AppState
  updateAttributionState: (
    updater: (prev: AttributionState) => AttributionState,
  ) => void
}

/** Hook that is a callback. */
export type HookCallback = {
  type: 'callback'
  callback: (
    input: HookInput,
    toolUseID: string | null,
    abort: AbortSignal | undefined,
    /** Hook index for SessionStart hooks to compute CLAUDE_ENV_FILE path */
    hookIndex?: number,
    /** Optional context for accessing app state */
    context?: HookCallbackContext,
  ) => Promise<HookJSONOutput>
  /** Timeout in seconds for this hook */
  timeout?: number
  /** Internal hooks (e.g. session file access analytics) are excluded from tengu_run_hook metrics */
  internal?: boolean
}

export type HookCallbackMatcher = {
  matcher?: string
  hooks: HookCallback[]
  pluginName?: string
}

export type HookProgress = {
  type: 'hook_progress'
  hookEvent: HookEvent
  hookName: string
  command: string
  promptText?: string
  statusMessage?: string
}

export type HookBlockingError = {
  blockingError: string
  command: string
}

export type PermissionRequestResult =
  | {
      behavior: 'allow'
      updatedInput?: Record<string, unknown>
      updatedPermissions?: PermissionUpdate[]
    }
  | {
      behavior: 'deny'
      message?: string
      interrupt?: boolean
    }

export type HookResult = {
  message?: Message
  systemMessage?: Message
  blockingError?: HookBlockingError
  outcome: 'success' | 'blocking' | 'non_blocking_error' | 'cancelled'
  preventContinuation?: boolean
  stopReason?: string
  permissionBehavior?: 'ask' | 'deny' | 'allow' | 'passthrough'
  hookPermissionDecisionReason?: string
  additionalContext?: string
  initialUserMessage?: string
  updatedInput?: Record<string, unknown>
  updatedMCPToolOutput?: unknown
  permissionRequestResult?: PermissionRequestResult
  retry?: boolean
}

export type AggregatedHookResult = {
  message?: Message
  blockingErrors?: HookBlockingError[]
  preventContinuation?: boolean
  stopReason?: string
  hookPermissionDecisionReason?: string
  permissionBehavior?: PermissionResult['behavior']
  additionalContexts?: string[]
  initialUserMessage?: string
  updatedInput?: Record<string, unknown>
  updatedMCPToolOutput?: unknown
  permissionRequestResult?: PermissionRequestResult
  retry?: boolean
}

// Base hook input with common properties
interface BaseHookInput {
  hook_event_name: string
  session_id?: string
  timestamp?: number
}

// PreToolUse hook input
export type PreToolUseHookInput = BaseHookInput & {
  hook_event_name: 'PreToolUse'
  tool_name: string
  tool_input: unknown
  tool_use_id: string
}

// PostToolUse hook input
export type PostToolUseHookInput = BaseHookInput & {
  hook_event_name: 'PostToolUse'
  tool_name: string
  tool_input: unknown
  tool_output: unknown
  tool_use_id: string
}

// PostToolUseFailure hook input
export type PostToolUseFailureHookInput = BaseHookInput & {
  hook_event_name: 'PostToolUseFailure'
  tool_name: string
  tool_input: unknown
  error: string
  tool_use_id: string
}

// Notification hook input
export type NotificationHookInput = BaseHookInput & {
  hook_event_name: 'Notification'
  message: string
}

// UserPromptSubmit hook input
export type UserPromptSubmitHookInput = BaseHookInput & {
  hook_event_name: 'UserPromptSubmit'
  prompt: string
}

// SessionStart hook input
export type SessionStartHookInput = BaseHookInput & {
  hook_event_name: 'SessionStart'
  initial_prompt?: string
}

// SessionEnd hook input
export type SessionEndHookInput = BaseHookInput & {
  hook_event_name: 'SessionEnd'
  reason: string
}

// Stop hook input
export type StopHookInput = BaseHookInput & {
  hook_event_name: 'Stop'
  stop_reason: string
}

// StopFailure hook input
export type StopFailureHookInput = BaseHookInput & {
  hook_event_name: 'StopFailure'
  error: string
}

// SubagentStart hook input
export type SubagentStartHookInput = BaseHookInput & {
  hook_event_name: 'SubagentStart'
  agent_name: string
}

// SubagentStop hook input
export type SubagentStopHookInput = BaseHookInput & {
  hook_event_name: 'SubagentStop'
  agent_name: string
}

// PreCompact hook input
export type PreCompactHookInput = BaseHookInput & {
  hook_event_name: 'PreCompact'
}

// PostCompact hook input
export type PostCompactHookInput = BaseHookInput & {
  hook_event_name: 'PostCompact'
  tokens_saved: number
}

// PermissionRequest hook input
export type PermissionRequestHookInput = BaseHookInput & {
  hook_event_name: 'PermissionRequest'
  tool: string
  reason: string
}

// PermissionDenied hook input
export type PermissionDeniedHookInput = BaseHookInput & {
  hook_event_name: 'PermissionDenied'
  tool: string
  reason: string
}

// Setup hook input
export type SetupHookInput = BaseHookInput & {
  hook_event_name: 'Setup'
}

// TeammateIdle hook input
export type TeammateIdleHookInput = BaseHookInput & {
  hook_event_name: 'TeammateIdle'
  agent_name: string
}

// TaskCreated hook input
export type TaskCreatedHookInput = BaseHookInput & {
  hook_event_name: 'TaskCreated'
  task_id: string
  task_description: string
}

// TaskCompleted hook input
export type TaskCompletedHookInput = BaseHookInput & {
  hook_event_name: 'TaskCompleted'
  task_id: string
}

// ConfigChange hook input
export type ConfigChangeHookInput = BaseHookInput & {
  hook_event_name: 'ConfigChange'
  config_path: string
}

// WorktreeCreate hook input
export type WorktreeCreateHookInput = BaseHookInput & {
  hook_event_name: 'WorktreeCreate'
  worktree_path: string
}

// WorktreeRemove hook input
export type WorktreeRemoveHookInput = BaseHookInput & {
  hook_event_name: 'WorktreeRemove'
  worktree_path: string
}

// InstructionsLoaded hook input
export type InstructionsLoadedHookInput = BaseHookInput & {
  hook_event_name: 'InstructionsLoaded'
  instructions: string
}

// CwdChanged hook input
export type CwdChangedHookInput = BaseHookInput & {
  hook_event_name: 'CwdChanged'
  cwd: string
  previous_cwd: string
}

// FileChanged hook input
export type FileChangedHookInput = BaseHookInput & {
  hook_event_name: 'FileChanged'
  paths: string[]
}

// Elicitation hook input
export type ElicitationHookInput = BaseHookInput & {
  hook_event_name: 'Elicitation'
  prompt: string
  options: Array<{
    key: string
    label: string
    description?: string
  }>
}

// ElicitationResult hook input
export type ElicitationResultHookInput = BaseHookInput & {
  hook_event_name: 'ElicitationResult'
  selected_option: string
}

// Union of all hook input types
export type AnyHookInput =
  | PreToolUseHookInput
  | PostToolUseHookInput
  | PostToolUseFailureHookInput
  | NotificationHookInput
  | UserPromptSubmitHookInput
  | SessionStartHookInput
  | SessionEndHookInput
  | StopHookInput
  | StopFailureHookInput
  | SubagentStartHookInput
  | SubagentStopHookInput
  | PreCompactHookInput
  | PostCompactHookInput
  | PermissionRequestHookInput
  | PermissionDeniedHookInput
  | SetupHookInput
  | TeammateIdleHookInput
  | TaskCreatedHookInput
  | TaskCompletedHookInput
  | ConfigChangeHookInput
  | WorktreeCreateHookInput
  | WorktreeRemoveHookInput
  | InstructionsLoadedHookInput
  | CwdChangedHookInput
  | FileChangedHookInput
  | ElicitationHookInput
  | ElicitationResultHookInput

// Exit reason type
export const EXIT_REASONS = [
  'clear',
  'resume',
  'logout',
  'prompt_input_exit',
  'other',
  'bypass_permissions_disabled',
] as const

export type ExitReason = (typeof EXIT_REASONS)[number]