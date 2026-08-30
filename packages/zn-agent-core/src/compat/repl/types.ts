// @ts-nocheck
/**
 * zai patch (2026-08-30, plan P0): createReplSession type surface.
 * See docs/superpowers/specs/2026-08-30-inproc-repl-extract-design.md §3.
 *
 * P3-T0: extends ReplSessionOptions with `commands? / tools? /
 * mcpClients? / readFileState?` so the host (zai web) can override the
 * vendor fallbacks used to populate ToolUseContext. Without these,
 * vendor query() sees an empty options.tools and the LLM never emits
 * tool_use blocks.
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
  // zai patch (2026-08-30, plan P3, Task 0): ToolUseContext population
  // inputs. Host (zai web) can override these to wire its own command
  // registry / tool registry / MCP clients / FileStateCache; when
  // omitted, createReplSession falls back to vendor getTools() /
  // getCommands() / empty array / new FileStateCache() defaults so the
  // query() call always sees a non-empty ToolUseContext.options.
  commands?: unknown[]
  tools?: unknown
  readFileState?: unknown
  // zai patch (2026-08-30, plan P3, Task 0): agents list fed into
  // ToolUseContext.options.agentDefinitions.activeAgents. Falls back
  // to [] when host doesn't supply one.
  agents?: unknown[]
  // zai patch (2026-08-30, plan P2, Task 4): optional ElicitationRegistry
  // supplied by the host (zai web). Typed as `unknown` to avoid pulling
  // the zai workspace package into zn-agent-core — consumers in T6 cast
  // it back to the concrete class. When omitted, createReplSession
  // exposes its own via getElicitationRegistry() so MCP code paths can
  // still find one. Spec §2.3.
  elicitationRegistry?: unknown
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
  // zai patch (2026-08-30, plan P2, Task 4): P2 accessors — let the
  // host (zai web) reach the wired L2/L3 handles without coupling to
  // the internal closure. Each accessor returns the handle returned by
  // the corresponding setupXxx() call so consumers can drive it
  // (e.g. setupNotificationsHandle.emit('rateLimit', ...) from the
  // SSE handler, or setupTasksV2Handle.toggle() from a UI click).
  // Accessors are also used by tests to assert wiring without going
  // through the hooks.onEvent channel.
  getNotificationsHandle?(): {
    emit: (kind: string, payload?: unknown) => void
    subscribe: (cb: (n: unknown) => void) => () => void
    teardown: () => void
  }
  getTasksV2Handle?(): {
    toggle: () => void
    isCollapsed: () => boolean
    setCollapsed: (v: boolean) => void
    teardown: () => void
  }
  getApiKeyHandle?(): {
    verify: () => Promise<boolean>
    teardown: () => void
  }
  getCostSummaryHandle?(): {
    refresh: () => Promise<void>
    teardown: () => void
  }
  getElicitationRegistry?(): unknown
  // zai patch (2026-08-30, plan P3, Task 0): test seam for emitting
  // synthetic ReplEvents. ONLY exposed when NODE_ENV === 'test' (see
  // createReplSession.ts). Tests use this to inject runtime.tool_call /
  // runtime.tool_result / runtime.delta / runtime.thinking events
  // without depending on a real vendor query() chain. Production code
  // paths must NOT call this.
  __test_emitReplEvent?(typeOrEvent: string | ReplEvent, payload?: unknown): void
  // zai patch (2026-08-30, plan P3, Task 3): hydrate contract — returns
  // the restoreSession result once the on-construct JSONL hydration
  // completes. Hosts that need to read restored state (zai web
  // routes/agent.ts session restore path) await this before responding.
  // Resolves to { messages: [], hydrated: false } if the session was
  // constructed without an in-flight restore (e.g. dispose() raced
  // ahead). Spec §4.3.
  whenHydrated(): Promise<{
    messages: any[]
    hydrated: boolean
    [k: string]: unknown
  }>
}
