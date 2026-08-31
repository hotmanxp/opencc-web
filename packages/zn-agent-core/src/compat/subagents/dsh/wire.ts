/**
 * DeepSeek Harness (dsh) SDK runtime wire vocabulary.
 *
 * zai's `dsh` provider talks to a `dsh --profile sdk` child over newline
 * delimited JSON-RPC 2.0 on stdio — the same contract as dsh's own
 * `@deepseek-ai/dsh-sdk-client` (see deepseek-harness
 * `packages/sdk/client/src/{launch,client,api}.ts` and
 * `packages/sdk/server/src/server.ts:135-257`):
 *
 *   Requests (client → server):
 *     initialize      { cwd, provider, model, reasoningEffort?, maxTokens? }
 *                     → { serverInfo: { name, version } }
 *     session/prompt  { sessionId, contentBlocks: [{type:'text',text}] }
 *                     → { messageId }
 *     shutdown        {} → {}
 *
 *   Notifications (server → client):
 *     session.event   { sessionId, event: SessionEvent }
 *     session.status  { sessionId, status }        — run ends at 'idle'
 *     subagent.started  { parentSessionId, childSessionId }
 *     subagent.finished { provider, agentId, parentSessionId, childSessionId,
 *                         status, stopReason, lastAssistantMessage? }
 *
 * Relevant `SessionEvent` types (dsh `AssistantOutputFold`,
 * `subagent/src/assistant-output.ts:32-39`):
 *   - `assistant/message`: `data.message.content` — ContentBlock[]
 *   - `assistant/chunk`:   `data.chunk.type === 'text-delta'`, `.text`
 *   - `turn/end`:          `data.reason` — TurnEndReason
 */

/** The canonical SDK profile: dsh's `resolveDshLaunch` default. */
export const DSH_DEFAULT_PROFILE = 'sdk'

/** Wire method names. */
export const DSH_SDK_METHODS = {
  initialize: 'initialize',
  sessionPrompt: 'session/prompt',
  shutdown: 'shutdown',
} as const

/** Notification method names. */
export const DSH_SDK_NOTIFICATIONS = {
  sessionEvent: 'session.event',
  sessionStatus: 'session.status',
  subagentStarted: 'subagent.started',
  subagentFinished: 'subagent.finished',
} as const

export type TurnEndReasonKind =
  | 'completed'
  | 'max-tokens'
  | 'aborted'
  | 'blocked'
  | 'error'
  | 'interrupted'

/** `turn/end` data.reason (dsh TurnEndReason, projected to what zai maps). */
export interface DshTurnEndReason {
  kind: TurnEndReasonKind | string
  reason?: { kind?: string } & Record<string, unknown>
}

/** One session event frame as transported by `session.event`. */
export interface DshSessionEventFrame {
  type: string
  data?: Record<string, unknown>
  [k: string]: unknown
}

export interface DshInitializeParams {
  cwd: string
  provider: string
  model: string
  reasoningEffort?: string
  maxTokens?: number
}

export interface DshInitializeResult {
  serverInfo: { name: string; version: string }
}

export interface DshSessionPromptParams {
  sessionId: string
  contentBlocks: Array<{ type: 'text'; text: string }>
}

export interface DshSessionPromptResult {
  messageId: string
}
