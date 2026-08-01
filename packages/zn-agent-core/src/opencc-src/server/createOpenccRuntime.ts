export type OpenccRuntimeOptions = {
  dataDir: string
  runtimeId?: string
  defaultCwd?: string
  defaultModel?: string
}

export type OpenccQueryInput = {
  sessionId: string
  prompt: string
  cwd?: string
  model?: string
  abortSignal?: AbortSignal
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
}

export const createOpenccRuntime = async (options: CreateOpenccRuntimeOptions): Promise<OpenccRuntime> => {
  const mod = await import('./createOpenccRuntime-impl.js')
  return mod.createOpenccRuntimeImpl(options)
}
