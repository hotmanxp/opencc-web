// @ts-nocheck
/**
 * zai patch (2026-08-30, plan P0): createReplSession type surface.
 * See docs/superpowers/specs/2026-08-30-inproc-repl-extract-design.md §3.
 */

export type ContentBlock =
  | { type: 'text'; text: string }
  | { type: 'image'; source: unknown }
  | { type: 'tool_use'; id: string; name: string; input: unknown }
  | { type: 'tool_result'; tool_use_id: string; content: unknown; is_error?: boolean }

export type PermissionMode =
  | 'bypassPermissions'
  | 'default'
  | 'plan'
  | 'acceptEdits'

export type UserMessage = {
  type: 'user'
  content: ContentBlock[]
  uuid: string
  sessionId: string
}

export type InterruptRequest = {
  type: 'interrupt'
  reason?: string
}

export type EnqueueRequest = {
  type: 'enqueue'
  content: ContentBlock[]
  priority: 'now' | 'next' | 'later'
  uuid: string
}

export type ReplSessionInput = UserMessage | InterruptRequest | EnqueueRequest

export type ReplEventType =
  | 'turnStart'
  | 'turnEnd'
  | 'sessionStart'
  | 'sessionEnd'
  | 'sessionCrash'
  | 'notification'
  // zai patch (2026-08-30, plan P0, Task 8): vendor query() now yields
  // translated RuntimeEvents (message_start / content_block_* /
  // tool_use:done / message_delta / message_stop). These are emitted
  // through hooks.onEvent with type 'runtime' and the full
  // RuntimeEvent payload.
  | 'runtime'

export type ReplEvent = {
  type: ReplEventType
  payload?: unknown
  sessionId: string
  turnIndex: number
  timestamp: number
}

export type HookTrace = {
  type: 'PreToolUse' | 'PostToolUse' | 'UserPromptSubmit' | 'SessionStart' | 'SessionEnd'
  payload: unknown
  sessionId: string
}

export type ReplSessionOptions = {
  sessionId: string
  cwd: string
  mainAgent?: string
  model?: string
  permissionMode?: PermissionMode
  input: AsyncIterable<ReplSessionInput>
  hooks: {
    onEvent: (ev: ReplEvent) => void
    onHook?: (hook: HookTrace) => void
  }
  canUseTool?: (
    toolName: string,
    input: unknown,
    ctx: unknown,
  ) => Promise<unknown>
  getAppState?: () => unknown
  setAppState?: (fn: (prev: unknown) => unknown) => void
  mcpClients?: unknown[]
  bootstrap?: unknown
}

export type ReplSessionLifecycleEvent =
  | 'turnStart'
  | 'turnEnd'
  | 'sessionStart'
  | 'sessionEnd'
  | 'abort'

export type ReplSessionState = {
  sessionId: string
  turnIndex: number
  isRunning: boolean
  isDisposed: boolean
  // zai patch (2026-08-30, plan P2, Task 4): p2Wired marker. Always
  // `true` on sessions constructed via createReplSession since P2 —
  // signals to zai web that L2 hook adapters + L3 notification bus
  // are wired and their teardown handles are registered on dispose().
  // Hosts inspect this before subscribing to 'custom' notification
  // kinds via the bus (vs legacy per-hook subscription paths).
  p2Wired?: boolean
}

export type ReplSession = {
  submit(content: ContentBlock[]): Promise<void>
  enqueue(
    content: ContentBlock[],
    priority: 'now' | 'next' | 'later',
  ): Promise<void>
  interrupt(reason?: string): Promise<void>
  endSession(reason?: string): Promise<void>
  on(
    event: ReplSessionLifecycleEvent,
    cb: (payload?: unknown) => void,
  ): () => void
  dispose(): Promise<void>
  getState(): ReplSessionState
}
