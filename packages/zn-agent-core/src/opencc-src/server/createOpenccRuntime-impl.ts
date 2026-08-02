// @ts-nocheck
import { randomUUID } from 'node:crypto'
import { createHeadlessContextImpl } from './createHeadlessContext-impl.js'
import { createSessionFacadeImpl } from './sessionFacade-impl.js'
import { QueryEngine } from '../QueryEngine.js'
import { FileStateCache } from '../utils/fileStateCache.js'
import type { OpenccSessionMeta } from './createOpenccRuntime.js'
import { productionDeps } from '../query/deps.js'

export async function createOpenccRuntimeImpl(options) {
  const cwd = options.defaultCwd ?? process.cwd()
  const ctx = await createHeadlessContextImpl({
    cwd,
    dataDir: options.dataDir,
    runtimeId: options.runtimeId ?? randomUUID(),
    // zai-server: skip MCP bootstrap so the headless runtime comes
    // up even if the user's `~/.claude.json` lists MCP servers that
    // block the connect call. The QueryEngine's per-query MCP
    // refresh + the `/mcp` slash command reconnect on demand.
    connectMcp: options.connectMcp ?? false,
  })
  const sessions = await createSessionFacadeImpl({ cwd, dataDir: options.dataDir })
  const abortController = new AbortController()
  let closed = false
  let turnIndex = 0

  const customQuery = options.query
    ? async function* (params) {
        yield* options.query(params)
      }
    : undefined

  // Optional deps override: when zai provides its own `callModel`
  // (a wrapper around `createAnthropicModelCaller`), forward it as
  // `deps.callModel` so the headless runtime routes model calls through
  // the user's actual provider profile instead of the vendor default
  // `queryModelWithStreaming` (which reads `ANTHROPIC_API_KEY` from the
  // zai-server process env). The OTHER deps (microcompact, autocompact,
  // uuid) MUST come from `productionDeps()` — `defaultQuery` invokes
  // `deps.uuid()`, `deps.microcompact()`, `deps.autocompact()` directly
  // and would throw `TypeError: deps.X is not a function` if we passed
  // a partial object (this was the root cause of the original
  // `deps.uuid is not a function` crash; fix merges productionDeps with
  // the callModel override).
  const engineDeps = options.callModel
    ? {
        ...productionDeps(),
        callModel: async function* (req: any) {
          yield* options.callModel!(req)
        },
      }
    : undefined

  const engine = new QueryEngine({
    cwd,
    tools: ctx.tools,
    commands: ctx.mcp.commands,
    mcpClients: ctx.mcp.clients,
    agents: [],
    canUseTool: ctx.permission,
    getAppState: ctx.appState.getState,
    setAppState: ctx.appState.setState,
    readFileState: new FileStateCache(100, 25 * 1024 * 1024),
    abortController,
    query: customQuery,
    deps: engineDeps as any,
  })

  function eventFor(sessionId, value) {
    const source = value && typeof value === 'object' ? value : { value }
    return {
      ...source,
      type: source.type ?? source.message?.type ?? 'runtime.event',
      sessionId: source.sessionId ?? sessionId,
      eventId: source.eventId ?? source.uuid ?? randomUUID(),
      ts: source.ts ?? Date.now(),
      turnIndex: source.turnIndex ?? turnIndex,
    }
  }

  return {
    async *query(input) {
      if (closed) throw new Error('openccRuntime: shutdown')
      turnIndex += 1
      if (input.abortSignal) {
        if (input.abortSignal.aborted) abortController.abort(input.abortSignal.reason)
        else input.abortSignal.addEventListener('abort', () => abortController.abort(input.abortSignal.reason), { once: true })
      }
      // When zai provides a custom `callModel` (e.g. its raw
      // fetch-based `createAnthropicModelCaller`), bypass
      // `engine.submitMessage` entirely. The vendored
      // `defaultQuery → for await (const message of deps.callModel(...))`
      // collapses zai's raw SDK events
      // (`message_start` / `content_block_delta` / ...) into a
      // single `runtime.done` because its switch statement
      // expects the vendor `Message` shape (assistant with full
      // `message.content` populated), not raw streaming events.
      // Going directly through `options.callModel` keeps the
      // stream shape; `eventFor` wraps each event with our
      // sessionId + eventId + ts + turnIndex metadata; the zai
      // routes' `translateRuntimeEvents` already handles the
      // raw Anthropic event shape (message_start,
      // content_block_delta, etc).
      if (options.callModel) {
        const zaiStream = options.callModel({
          messages: [{ type: 'user', message: { role: 'user', content: input.prompt } }],
          systemPrompt: '',
          thinkingConfig: { type: 'disabled' },
          tools: [],
          signal: input.abortSignal,
          options: { model: input.model },
        } as any)
        for await (const value of zaiStream) {
          yield eventFor(input.sessionId, value)
        }
        return
      }
      const stream = engine.submitMessage(input.prompt, { uuid: input.sessionId, model: input.model })
      for await (const value of stream) {
        yield eventFor(input.sessionId, value)
      }
    },
    async abort() {
      if (!abortController.signal.aborted) abortController.abort()
    },
    async getSession(sessionId) {
      const info = await sessions.get(sessionId)
      return info as unknown as Promise<OpenccSessionMeta | null>
    },
    async listSessions(opts) {
      const list = await sessions.list(opts)
      return list as unknown as OpenccSessionMeta[]
    },
    readTranscript(sessionId) { return sessions.readTranscript(sessionId) },
    patchSession(sessionId, patch) { return sessions.patchSession(sessionId, patch) },
    removeSession(sessionId) { return sessions.removeSession(sessionId) },
    async shutdown() {
      if (closed) return
      closed = true
      if (!abortController.signal.aborted) abortController.abort()
    },
  }
}
