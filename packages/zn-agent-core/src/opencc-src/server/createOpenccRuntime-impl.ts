// @ts-nocheck
import { randomUUID } from 'node:crypto'
import { createHeadlessContextImpl } from './createHeadlessContext-impl.js'
import { createSessionFacadeImpl } from './sessionFacade-impl.js'
import { runWithSdkContext, getSessionId } from '../bootstrap/state.js'
import { wrapTaskAwareSetState } from '../../compat/runtime/agentTaskBridge.js'
import { QueryEngine } from '../QueryEngine.js'
import { FileStateCache } from '../utils/fileStateCache.js'
import { transitionPermissionMode } from '../utils/permissions/permissionSetup.js'
import { assembleToolPool } from '../tools.js'
import { mergeAndFilterTools } from '../utils/toolPool.js'
import { getMcpToolsCommandsAndResources } from '../services/mcp/client.js'
import type { OpenccSessionMeta } from './createOpenccRuntime.js'

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
    // Default interactive; SDK mode (`zai --sdk`) passes
    // `interactive: false` to flip STATE.isInteractive to non-interactive.
    isInteractive: options.interactive ?? true,
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

  // zai patch: MCP tools were never reaching the model-visible tool list.
  // Two independent gaps:
  //   1. `connectMcp: false` (zai-server's boot default) makes
  //      createHeadlessContextImpl skip getMcpToolsCommandsAndResources, so
  //      `appState.mcp.tools` stays empty — MCP servers (e.g. codegraph from
  //      .mcp.json) are never connected.
  //   2. QueryEngine's tool loop reads `config.tools` (built-ins only).
  //      query.ts "Refresh tools between turns" only runs when
  //      `options.refreshTools` is provided — the REPL wires it as
  //      `computeTools`, the headless runtime did not.
  //
  // Mirror the REPL's computeTools (REPL.tsx): assemble built-ins + MCP
  // tools from live appState, then merge/filter by permission mode. Used
  // both for the initial tool list and as `refreshTools` for mid-query
  // updates once MCP servers finish connecting.
  const computeTools = () => {
    const state = ctx.appState.getState()
    const permissionContext = state.toolPermissionContext
    const assembled = assembleToolPool(permissionContext, state.mcp?.tools ?? [])
    return mergeAndFilterTools(ctx.tools, assembled, permissionContext.mode)
  }

  // When MCP bootstrap was skipped, connect servers asynchronously so
  // startup stays fast (HTTP listener binds immediately) but MCP tools
  // still become available for the first query's later turns (and are
  // picked up by computeTools via appState.mcp.tools). Dedup by name.
  if (!ctx.config.connectMcp) {
    void getMcpToolsCommandsAndResources(
      ({ client, tools: mcpTools, commands: mcpCommands }) => {
        ctx.appState.setState(prev => {
          const mcp =
            prev.mcp ?? {
              clients: [],
              tools: [],
              commands: [],
              resources: {},
              pluginReconnectKey: 0,
            }
          const mcpToolNames = new Set(mcpTools.map(t => t.name))
          return {
            ...prev,
            mcp: {
              ...mcp,
              clients: [
                ...mcp.clients.filter(c => c.name !== client.name),
                client,
              ],
              tools: [
                ...mcp.tools.filter(t => !mcpToolNames.has(t.name)),
                ...mcpTools,
              ],
              commands: [
                ...mcp.commands.filter(
                  c => !mcpCommands.some(nc => nc.name === c.name),
                ),
                ...mcpCommands,
              ],
              pluginReconnectKey: (mcp.pluginReconnectKey ?? 0) + 1,
            },
          }
        })
      },
    ).catch(err => {
      console.warn('[openccRuntime] async MCP connect failed:', err)
    })
  }

  const engine = new QueryEngine({
    cwd,
    tools: computeTools(),
    commands: ctx.mcp.commands,
    mcpClients: ctx.mcp.clients,
    refreshTools: computeTools,
    // zai patch: read agents from AppState (populated by
    // createHeadlessContextImpl via getAgentDefinitionsWithOverrides).
    // QueryEngine constructs its own `options.agentDefinitions` from
    // this param (QueryEngine.ts:363, :519) and uses that for
    // AgentTool's lookup — an empty array here means any
    // `Agent(subagent_type: 'general-purpose', ...)` call throws
    // "Agent type 'general-purpose' not found. Available agents: ".
    agents: ctx.appState.getState().agentDefinitions.activeAgents,
    canUseTool: ctx.permission,
    getAppState: ctx.appState.getState,
    // zai patch: 包装 setAppState 把 LocalAgentTask 状态桥接为
    // `agent_task.changed` (compat/runtime/agentTaskBridge.ts),让前端
    // 后台任务 dock 能看到 AgentTool 派发的子代理执行。AgentTool 的
    // `setAppStateForTasks ?? setAppState` 两条路径都落到这里。
    // getSessionId() 在 query loop 的 runWithSdkContext 上下文内返回
    // 父 sessionId, dock 据此按 session 过滤任务。
    setAppState: wrapTaskAwareSetState(
      ctx.appState.setState as unknown as Parameters<typeof wrapTaskAwareSetState>[0],
      () => getSessionId() as string | null | undefined,
    ),
    readFileCache: new FileStateCache(100, 25 * 1024 * 1024),
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
      // zai patch: apply a per-query permission mode override (e.g. a
      // session switched to plan mode) onto the shared AppState before the
      // tool loop runs. `transitionPermissionMode` maintains prePlanMode /
      // auto-mode invariants the same way the TUI does. Without this, the
      // headless context stays at its bootstrap mode (bypassPermissions)
      // and ExitPlanMode's validateInput rejects the call ("not in plan
      // mode") before the confirm UI ever appears.
      if (input.permissionMode) {
        ctx.appState.setState(prev => {
          const current = prev.toolPermissionContext.mode
          if (current === input.permissionMode) return prev
          const next = transitionPermissionMode(
            current,
            input.permissionMode,
            prev.toolPermissionContext,
          )
          return {
            ...prev,
            toolPermissionContext: {
              ...next,
              mode: input.permissionMode,
            },
          }
        })
      }
      if (input.abortSignal) {
        if (input.abortSignal.aborted) abortController.abort(input.abortSignal.reason)
        else input.abortSignal.addEventListener('abort', () => abortController.abort(input.abortSignal.reason), { once: true })
      }
      // zai patch: per-query bridge ctx. The zai-native AskUserQuestion
      // wrapper (compat/tools/opencc/AskUserQuestionTool.ts) reads
      // globalThis.__zaiBridgeCtx at CALL time for sessionId /
      // askRegistry / onYield. The static parts (askRegistry / onYield)
      // are set once by zai-server's initAgentRuntime; sessionId varies
      // per query, so we merge it here and restore on exit so a stale
      // sessionId never leaks into a later query.
      const prevBridge = (globalThis as any).__zaiBridgeCtx
      ;(globalThis as any).__zaiBridgeCtx = {
        ...(prevBridge ?? {}),
        sessionId: input.sessionId,
      }
      try {
        // Delegate to vendor's full `defaultQuery` agent loop. The
        // engine's deps.callModel defaults to vendor's
        // `queryModelWithStreaming`, which yields the vendor
        // Message shape (`{type: 'assistant' | 'user' | 'result' |
        // ...}`) — that is the shape `defaultQuery`'s tool loop
        // (streamingToolExecutor) consumes.
        const stream = engine.submitMessage(input.prompt, { uuid: input.sessionId, model: input.model })
        // zai patch: 绑定 vendor SDK context, 让 vendor 的 getSessionId()
        // 在本 query 的异步链上返回 input.sessionId, 从而 transcript 文件
        // 以 `${input.sessionId}.jsonl` 命名写入
        // ${dataDir}/projects/<cwd>/ — 与读取端 (sessionFacade / compat
        // TranscriptStore) 使用同一个 id / 目录. 不绑定的话 vendor 回落到
        // 全局 STATE.sessionId (纯 UUID), 前端 URL 的 sid 对不上文件名,
        // 刷新页面后历史对话读不到.
        //
        // 注意: 不能用 `yield* engine.submitMessage(...)` 一次性包进
        // runWithSdkContext — AsyncLocalStorage 只向 fn 内创建的异步资源
        // 传播, 而 async generator 是惰性迭代, 首次 .next() 发生在外层
        // yield*, 已脱离 ALS context. 必须把每次 .next() 放进
        // runWithSdkContext 内驱动, 让 recordTranscript 等内部 await
        // 全程继承 context.
        const sdkCtx =
          typeof input.sessionId === 'string' && input.sessionId
            ? { sessionId: input.sessionId, sessionProjectDir: null, cwd, originalCwd: cwd }
            : null
        while (true) {
          const step = sdkCtx
            ? await runWithSdkContext(sdkCtx, () => stream.next())
            : await stream.next()
          if (step.done) break
          yield eventFor(input.sessionId, step.value)
        }
      } finally {
        if (prevBridge === undefined) delete (globalThis as any).__zaiBridgeCtx
        else (globalThis as any).__zaiBridgeCtx = prevBridge
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
