// @ts-nocheck
import { randomUUID } from 'node:crypto'
import { createHeadlessContextImpl } from './createHeadlessContext-impl.js'
import { createSessionFacadeImpl } from './sessionFacade-impl.js'
import { runWithSdkContext, getSessionId } from '../bootstrap/state.js'
import { wrapTaskAwareSetState } from '../../compat/runtime/agentTaskBridge.js'
import { QueryEngine } from '../QueryEngine.js'
import { createAbortController } from '../utils/abortController.js'
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

  // Single shared AbortController for the runtime's lifetime — used as
  // the QueryEngine's initial abortController. Note this is *not* the
  // one we hand to defaultQuery per query call: AbortController is
  // single-use, so once ESC aborts a query the controller's signal stays
  // aborted forever and the next defaultQuery() would short-circuit at
  // query.ts:1660, causing QueryEngine to emit an `error_during_execution`
  // result with is_error:true (surfaced to the UI as
  // "vendor defaultQuery reported an error (internal)"). Per-query
  // controllers are created in `runtime.query(input)` below — see
  // `currentQueryAbortController`.
  const initialAbortController = new AbortController()
  let closed = false
  let turnIndex = 0
  // Tracks the AbortController currently in use by the in-flight query,
  // if any. `runtime.abort()` and `runtime.shutdown()` target this so
  // they don't accidentally trip the next query's fresh controller.
  // (zai patch) per-session query AbortController 由 queryAbortControllers map
  // 管理, 不再用单值 currentQueryAbortController (并发下无法精确命中 session)。

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

  // zai patch (并发多会话): vendor QueryEngine 是单会话设计——`mutableMessages`
  // 是实例级共享状态,跨 submitMessage 调用保留(支撑续传历史),但 zai server
  // 的 runtime 是单例,旧会话 queryLoop 未结束(fire-and-forget)就新建会话并发
  // query 时,两个 query 共享同一 engine 的 mutableMessages,消息互相污染
  // (A 的 user/tool_result 被 B 的 turn 写入 B 的 transcript)。
  //
  // 修复: 每 session 一个独立 QueryEngine。同 session 复用 engine 使
  // mutableMessages 跨 query 保留(续传历史不丢,与旧行为一致);不同 session
  // 互不共享 mutableMessages,并发隔离。
  const createEngine = () =>
    new QueryEngine({
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
      abortController: initialAbortController,
      query: customQuery,
    })
  const engines = new Map<string, QueryEngine>()
  // sessionId → 该 session 当前 in-flight query 的 AbortController。
  // 旧实现只 track 单个 currentQueryAbortController,并发下 abort 无法精确
  // 命中目标 session;per-session 后按 sessionId 查表。
  const queryAbortControllers = new Map<string, AbortController>()

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
      // zai patch: per-query fresh AbortController. The shared
      // initialAbortController we seeded QueryEngine with is now
      // permanently aborted (one-shot); defaultQuery checks
      // toolUseContext.abortController.signal.aborted at query.ts:1660
      // and would short-circuit on every subsequent query, with
      // QueryEngine emitting an error_during_execution result whose
      // is_error:true surfaces to the UI as "vendor defaultQuery
      // reported an error (internal)". Mirror vendor print.ts:2282's
      // per-turn `abortController = createAbortController()` by
      // building a fresh one here and replacing QueryEngine's internal
      // reference for this query only.
      const queryAbortController = createAbortController()
      if (input.abortSignal) {
        if (input.abortSignal.aborted) queryAbortController.abort(input.abortSignal.reason)
        else input.abortSignal.addEventListener('abort', () => queryAbortController.abort(input.abortSignal.reason), { once: true })
      }
      // zai patch (并发多会话): 每 session 独立 engine, mutableMessages 不
      // 跨 session 共享。同 session 复用 engine 保留续传历史。
      let engine = engines.get(input.sessionId)
      if (!engine) {
        engine = createEngine()
        engines.set(input.sessionId, engine)
      }
      engine.replaceAbortController(queryAbortController)
      queryAbortControllers.set(input.sessionId, queryAbortController)
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
        // zai patch: per-query model override. Without this, every query
        // uses the initial default model — the `model` field in options
        // passed to `engine.submitMessage()` is silently ignored because
        // `submitMessage`'s signature only accepts `{ uuid, isMeta }`.
        // `engine.setModel()` sets `this.config.userSpecifiedModel`, which
        // `submitMessage` reads to compute `initialMainLoopModel` and passes
        // it into `toolUseContext.options.mainLoopModel`. However,
        // `defaultQuery` (query.ts:1088-1091) resolves the effective model
        // from `appState.mainLoopModelForSession ?? appState.mainLoopModel`,
        // both of which are null in the headless runtime — so it falls back
        // to `getDefaultMainLoopModelSetting()` regardless of the user's
        // selection. Setting `appState.mainLoopModel` here bridges the gap.
        if (input.model) {
          engine.setModel(input.model)
          ctx.appState.setState(prev => ({ ...prev, mainLoopModel: input.model }))
        }
        // Delegate to vendor's full `defaultQuery` agent loop. The
        // engine's deps.callModel defaults to vendor's
        // `queryModelWithStreaming`, which yields the vendor
        // Message shape (`{type: 'assistant' | 'user' | 'result' |
        // ...}`) — that is the shape `defaultQuery`'s tool loop
        // (streamingToolExecutor) consumes.
        const stream = engine.submitMessage(input.prompt, { uuid: input.sessionId })
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
        // zai patch: 本 query 结束, 释放该 session 的 abort controller。
        // engine 保留在 engines map 中——同 session 续传复用 mutableMessages。
        if (typeof input.sessionId === 'string') {
          queryAbortControllers.delete(input.sessionId)
        }
      }
    },
    async abort(sessionId, reason) {
      // zai patch: 按 sessionId 精确 abort 目标 session 的 in-flight query。
      // 旧实现只 abort 单值 currentQueryAbortController(最后启动的 query),
      // 并发下无法命中正确 session。不传 sessionId 时兜底 abort 全部。
      if (typeof sessionId === 'string' && sessionId) {
        const c = queryAbortControllers.get(sessionId)
        if (c && !c.signal.aborted) c.abort(reason)
        return
      }
      for (const c of queryAbortControllers.values()) {
        if (!c.signal.aborted) c.abort(reason)
      }
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
    removeSession(sessionId) {
      // zai patch: 删除 session 时释放其 engine(含 mutableMessages)与
      // abort controller, 防止 map 无限增长。
      engines.delete(sessionId)
      queryAbortControllers.delete(sessionId)
      return sessions.removeSession(sessionId)
    },
    async shutdown() {
      if (closed) return
      closed = true
      // Abort every in-flight query. We don't touch
      // initialAbortController (already done in QueryEngine) — that
      // single-use controller is unreferenced now and will be GC'd
      // when the runtime closure is torn down.
      for (const c of queryAbortControllers.values()) {
        if (!c.signal.aborted) c.abort()
      }
      queryAbortControllers.clear()
      engines.clear()
    },
  }
}
