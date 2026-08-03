import type { OpenccContentBlockParam } from './serverTypes.js'

export type OpenccRuntimeOptions = {
  dataDir: string
  runtimeId?: string
  defaultCwd?: string
  defaultModel?: string
  /**
   * Whether to attempt MCP server connections during headless
   * bootstrap. Defaults to `false` (zai-server's path) so the
   * server's HTTP listener binds even if the user's `~/.claude.json`
   * lists MCP servers that block the connect call. Set `true` to
   * register MCP tools up-front; the QueryEngine's per-query MCP
   * refresh path is what actually wires them into the tool registry.
   */
  connectMcp?: boolean
  /**
   * Experimental: treat sessions as an interactive OpenCC CLI
   * (`STATE.isInteractive = true`). Mirrors `zai --cli`; forwarded to
   * `createHeadlessContext` as `isInteractive`. Defaults to `false`
   * (headless server invariant).
   */
  interactive?: boolean
}

export type OpenccQueryInput = {
  sessionId: string
  /** Plain text prompt, or content-block array for multimodal input (see serverTypes.ts). */
  prompt: string | OpenccContentBlockParam[]
  cwd?: string
  model?: string
  abortSignal?: AbortSignal
  /**
   * Optional per-query permission mode override. When absent the runtime
   * keeps whatever mode the headless context was created with (zai-server:
   * bypassPermissions). When present, the mode is applied to the shared
   * AppState before the query runs — the canonical path for surfacing a
   * session's plan mode to the vendor permission pipeline (so
   * ExitPlanMode's `ask` flows through the web confirm UI).
   */
  permissionMode?: 'default' | 'acceptEdits' | 'bypassPermissions' | 'dontAsk' | 'plan'
}

export type OpenccServerEvent = {
  eventId: string
  sessionId: string
  ts: number
  turnIndex: number
  type: string
  [key: string]: unknown
}

/**
 * Session metadata returned by `getSession` / `listSessions`. The
 * canonical shape lives in `serverTypes.ts` as `OpenccTranscriptMeta`
 * (the Task 1 server public surface); the impl returns it cast as
 * `unknown` and the cast is documented in `createOpenccRuntime-impl.ts`.
 *
 * This module does NOT re-export the type so the public d.ts stays
 * self-contained (verify-server-types-self-contained enforces no
 * cross-module imports in the server surface). Callers should
 * import `OpenccTranscriptMeta` from the main `opencc-server`
 * subpath re-export below.
 */
export type OpenccSessionMeta = {
  // Placeholder — see comment above. The impl returns the full
  // OpenccTranscriptMeta shape; this alias exists so the public
  // d.ts declares a return type without dragging in the server's
  // canonical definition (which lives in serverTypes.ts, a sibling
  // file in the same emit — same trick Task 1 used for
  // OpenccTranscriptMeta / OpenccTranscriptFile).
  version: 1 | 2
  transcriptId: string
  cwd: string
  model: string
  createdAt: number
  updatedAt: number
  messageCount: number
  title?: string
  tags?: string[]
  parentSessionId?: string
  subagentType?: string
  permissionMode?: 'default' | 'acceptEdits' | 'bypassPermissions' | 'plan'
}

// Re-export the canonical OpenccRuntime from serverTypes.ts (Task 1
// contract). The 8-method shape that Task 4 added (`query` +
// `shutdown` on top of Task 1's 6 methods) is the canonical one in
// serverTypes.ts; we re-export it here so the public surface stays
// self-contained (verify-server-types-self-contained allows sibling
// imports within dist/opencc-src/server/).
export type { OpenccRuntime } from './serverTypes.js'

export type CreateOpenccRuntimeOptions = OpenccRuntimeOptions & {
  modelCaller?: (request: unknown) => AsyncIterable<unknown>
  query?: (params: unknown) => AsyncIterable<unknown>
  /**
   * Optional override for the model-calling dependency forwarded to
   * `defaultQuery(params)`. Pass a zai-style
   * `createAnthropicModelCaller()` factory to route the headless server
   * through the user's actual provider profile (Anthropic / OpenAI-compat
   * / etc.) instead of the vendor default `queryModelWithStreaming` (which
   * reads `ANTHROPIC_API_KEY` from the zai-server process env and has no
   * awareness of `~/.claude.json` provider profiles). The factory
   * signature matches `vendor queryModelWithStreaming` so the vendor
   * `for await` loop yields the same event stream without translation.
   */
  callModel?: (
    req: import('../services/api/claude.js').queryModelWithStreaming extends (
      a: infer R,
    ) => unknown
      ? R
      : never,
  ) => AsyncIterable<unknown>
}

export const createOpenccRuntime = async (options: CreateOpenccRuntimeOptions): Promise<OpenccRuntime> => {
  const mod = await import('./createOpenccRuntime-impl.js')
  return mod.createOpenccRuntimeImpl(options)
}
