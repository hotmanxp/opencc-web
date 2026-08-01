// @ts-nocheck
import { randomUUID } from 'node:crypto'
import { createHeadlessContextImpl } from './createHeadlessContext-impl.js'
import { createSessionFacadeImpl } from './sessionFacade-impl.js'
import { QueryEngine } from '../QueryEngine.js'
import { FileStateCache } from '../utils/fileStateCache.js'

export async function createOpenccRuntimeImpl(options) {
  const cwd = options.defaultCwd ?? process.cwd()
  const ctx = await createHeadlessContextImpl({
    cwd,
    dataDir: options.dataDir,
    runtimeId: options.runtimeId ?? randomUUID(),
  })
  const sessions = await createSessionFacadeImpl({ cwd, dataDir: options.dataDir })
  const abortController = new AbortController()
  let closed = false
  let turnIndex = 0

  const customQuery = options.query
    ? async params => options.query(params)
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
      const stream = engine.submitMessage(input.prompt, { uuid: input.sessionId, model: input.model })
      for await (const value of stream) {
        yield eventFor(input.sessionId, value)
      }
    },
    async abort() {
      if (!abortController.signal.aborted) abortController.abort()
    },
    getSession(sessionId) { return sessions.get(sessionId) },
    listSessions(opts) { return sessions.list(opts) },
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
