// @ts-nocheck
import { randomUUID } from 'node:crypto'
import { createHeadlessContextImpl } from './createHeadlessContext-impl.js'
import { createSessionFacadeImpl } from './sessionFacade-impl.js'
import { runWithSdkContext, getSessionId, getOriginalCwd } from '../bootstrap/state.js'
import { wrapTaskAwareSetState } from '../../compat/runtime/agentTaskBridge.js'
import { translateSdkToRuntime, type SdkEventMeta } from '../../compat/runtime/sdkEventAdapter.js'
import { QueryEngine } from '../QueryEngine.js'
// zai patch (sess-1787121363115-0zq3bo8a): engines miss 分支需要从磁盘
// JSONL 反序列化历史 messages 灌回 QueryEngine.mutableMessages,让模型能看到
// 历史对话 — vendor CLI 走 REPL.resume(),headless runtime 必须自己接。
// 复用 vendor 现成的 deserializeMessages:自带 filterUnresolvedToolUses /
// orphaned thinking 清理 / 末尾 assistant sentinel 注入。
import { deserializeMessages } from '../utils/conversationRecovery.js'
import type { Message } from '../types/message.js'
import { createAbortController } from '../utils/abortController.js'
import { FileStateCache } from '../utils/fileStateCache.js'
import { transitionPermissionMode } from '../utils/permissions/permissionSetup.js'
import { assembleToolPool } from '../tools.js'
import { mergeAndFilterTools } from '../utils/toolPool.js'
import { getMcpToolsCommandsAndResources } from '../services/mcp/client.js'
import { getAllMcpConfigs } from '../services/mcp/config.js'
import { assemblePluginList } from './pluginListAssembly.js'
import {
  installPluginOp,
  uninstallPluginOp,
  setPluginEnabledOp,
  updatePluginOp,
} from '../services/plugins/pluginOperations.js'
import { loadAllPlugins } from '../utils/plugins/pluginLoader.js'
import { getPluginCommands, getPluginSkills } from '../utils/plugins/loadPluginCommands.js'
import { getAgentDefinitionsWithOverrides } from '../tools/AgentTool/loadAgentsDir.js'
import { refreshActivePlugins } from '../utils/plugins/refresh.js'
import { loadInstalledPluginsV2, hasPendingUpdates, getPendingUpdatesDetails } from '../utils/plugins/installedPluginsManager.js'
import { getMarketplace, getDeclaredMarketplaces, loadKnownMarketplacesConfig, addMarketplaceSource, saveMarketplaceToSettings, clearMarketplacesCache } from '../utils/plugins/marketplaceManager.js'
import { getMarketplaceSourceDisplay } from '../utils/plugins/marketplaceHelpers.js'
import { parseMarketplaceInput } from '../utils/plugins/parseMarketplaceInput.js'
import { parsePluginIdentifier } from '../utils/plugins/pluginIdentifier.js'
import { clearAllCaches } from '../utils/plugins/cacheUtils.js'
import { getUserConfigJson } from '../utils/userConfigJson.js'
import type { OpenccSessionMeta } from './createOpenccRuntime.js'
import type { OpenccPluginApi, OpenccPluginComponentCounts, OpenccPluginListResult, OpenccPluginActionResult, OpenccMarketplacePluginDto, OpenccMarketplaceDto, OpenccMarketplaceActionResult } from './serverTypes.js'

export async function createOpenccRuntimeImpl(options) {
  const cwd = options.defaultCwd ?? process.cwd()
  const ctx = await createHeadlessContextImpl({
    cwd,
    dataDir: options.dataDir,
    runtimeId: options.runtimeId ?? randomUUID(),
    // zai-server: skip MCP bootstrap so the headless runtime comes
    // up even if the user's `~/.zai.json` lists MCP servers that
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
  //
  // zai patch (2026-08-20): 主 Agent tools 槽不再在此全局应用 —— 改为
  // per-engine 应用(createEngine 按会话恢复的 agent 包一个闭包),否则
  // 不同会话各自恢复的 agent 会互相污染工具池。
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
    void (async () => {
      // zai patch (2026-08-20): 主 Agent mcp 插槽 —— 连接前应用。origin
      // 为 vendor 解析的全 scope server 配置表(name → config),槽函数
      // 增删/改写后传入连接器。MCP 连接是启动时一次性,槽切换需重启生效。
      let mcpConfigs = undefined
      if (options.mainAgent?.mcp) {
        const all = await getAllMcpConfigs()
        mcpConfigs = await options.mainAgent.mcp(all.servers)
      }
      await getMcpToolsCommandsAndResources(
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
        mcpConfigs,
      )
    })().catch(err => {
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
  // zai patch (2026-08-20): 按会话恢复主 Agent。`name` 来自该会话
  // transcript meta(首次 query 由 zai-server 恢复后经 input.mainAgent 传入);
  // 查不到(新会话/未知名)回退到全局 options.mainAgent。
  const resolveSessionMainAgent = (name?: string) => {
    if (name) {
      const found = (options.mainAgents ?? []).find(a => a.name === name)
      if (found) return found
    }
    return options.mainAgent
  }

  // 同时承担两个 patch 职责:
  // 1) sess-1787121363115-0zq3bo8a hydration — server restart 后 model 看不到
  //    历史,新建 engine 必须从磁盘 JSONL 反序列化历史 messages 灌回
  //    mutableMessages(vendor QueryEngine.mutableMessages 默认 = [],zai server
  //    没走 vendor CLI 的 --resume / REPL.resume(),必须手动做 vendor 风格的
  //    hydration)。
  // 2) 2026-08-20 主 Agent 插槽 — `mainAgentName` 决定该会话 engine 的
  //    systemPrompt / 工具池槽,来自会话 transcript meta,未知名回退到全局
  //    options.mainAgent。
  const createEngine = (initialMessages?: Message[], mainAgentName?: string) => {
    const agent = resolveSessionMainAgent(mainAgentName)
    // per-engine 工具池:在 base(内置 + MCP + 权限过滤)上应用该会话
    // agent 的 tools 槽。agent 无槽(如 default)→ 原样返回 base。
    const engineComputeTools = () =>
      agent?.tools ? agent.tools(computeTools()) : computeTools()
    return new QueryEngine({
      cwd,
      tools: engineComputeTools(),
      commands: ctx.mcp.commands,
      mcpClients: ctx.mcp.clients,
      // zai patch (2026-08-09): includePartialMessages:true 让 vendor 把每条
      // SDK 流事件包成 stream_event envelope 透传出来 —— 否则 query.ts:847
      // 会吞掉所有 envelope,只 yield batched 的 assistant Message,导致
      // zai-server 上层 translateRuntimeEvents 只能按 content_block 整块
      // yield runtime.delta,失去 token-by-token 流式。sdkEventAdapter
      // (compat/runtime/sdkEventAdapter.ts) 已实现 streamedBlockIndices
      // dedup,避免 assistant Message 路径重发已 stream 过的 block。
      includePartialMessages: true,
      refreshTools: engineComputeTools,
      // zai patch (2026-08-20): 主 Agent systemPrompt 插槽 —— engine 创建
      // 时固定,按会话恢复(该会话当时选的 agent)。
      systemPromptSlot: agent?.systemPrompt,
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
      // QueryEngine 接受 initialMessages 写入 mutableMessages
      // (QueryEngine.ts:212: this.mutableMessages = config.initialMessages ?? [])。
      // 上游 vendor CLI 走 REPL 的 useState(initialMessages) 同款路径。
      ...(initialMessages && initialMessages.length > 0
        ? { initialMessages }
        : {}),
    })
  }
  const engines = new Map<string, QueryEngine>()
  // sessionId → 该 session 当前 in-flight query 的 AbortController。
  // 旧实现只 track 单个 currentQueryAbortController,并发下 abort 无法精确
  // 命中目标 session;per-session 后按 sessionId 查表。
  const queryAbortControllers = new Map<string, AbortController>()

  async function buildComponentCounts(): Promise<Map<string, OpenccPluginComponentCounts>> {
    const counts = new Map<string, OpenccPluginComponentCounts>()
    const [cmds, skills, agents] = await Promise.all([
      getPluginCommands(),
      getPluginSkills(),
      getAgentDefinitionsWithOverrides(getOriginalCwd()),
    ])
    // 1) per-plugin commands/skills counts
    // Command.name is "pluginName:namespace:commandName" (loadPluginCommands.ts:83-84, 97-98)
    for (const c of cmds) {
      if (c.source !== 'plugin') continue
      const pluginName = c.name.split(':')[0]
      const e = counts.get(pluginName) ?? { commands: 0, agents: 0, skills: 0, hooks: 0, mcpServers: 0 }
      e.commands += 1
      counts.set(pluginName, e)
    }
    // Skill.name is "pluginName:namespace:skillName" — same encoding
    for (const s of skills) {
      if (s.source !== 'plugin') continue
      const pluginName = s.name.split(':')[0]
      const e = counts.get(pluginName) ?? { commands: 0, agents: 0, skills: 0, hooks: 0, mcpServers: 0 }
      e.skills += 1
      counts.set(pluginName, e)
    }
    // 2) agents: PluginAgentDefinition has pluginName as a top-level field (loadAgentsDir.ts:155)
    for (const a of agents.allAgents ?? []) {
      if (a.source !== 'plugin' || !('pluginName' in a) || !a.pluginName) continue
      const e = counts.get(a.pluginName) ?? { commands: 0, agents: 0, skills: 0, hooks: 0, mcpServers: 0 }
      e.agents += 1
      counts.set(a.pluginName, e)
    }
    return counts
  }

  async function buildList(): Promise<OpenccPluginListResult> {
    const [loadResult, v2, counts] = await Promise.all([
      loadAllPlugins(),
      loadInstalledPluginsV2(),
      buildComponentCounts(),
    ])
    // 3) hooks + mcpServers from the loaded plugins (cheap, no extra I/O)
    for (const p of [...loadResult.enabled, ...loadResult.disabled]) {
      const e = counts.get(p.name) ?? { commands: 0, agents: 0, skills: 0, hooks: 0, mcpServers: 0 }
      e.hooks = Object.keys(p.hooksConfig ?? {}).length
      e.mcpServers = Object.keys(p.mcpServers ?? {}).length
      counts.set(p.name, e)
    }
    // 4) hasUpdate via pending updates registry
    const pendingMap = new Map<string, boolean>()
    if (hasPendingUpdates()) {
      for (const u of getPendingUpdatesDetails()) {
        pendingMap.set(u.id, true)
      }
    }
    // Plugin enable/disable state is stored in the unified user config JSON
    // (~/.zai.json, fallback ~/.zai.json) — not the vendor settings
    // cascade. See utils/userConfigJson.ts for the read/write contract.
    const userConfig = getUserConfigJson()
    const enabled = userConfig.enabledPlugins as Record<string, boolean> | undefined
    return assemblePluginList(loadResult, v2, enabled, counts, (id) => pendingMap.get(id) === true)
  }

  async function reloadActive(): Promise<OpenccPluginActionResult['reload']> {
    try {
      const r = await refreshActivePlugins(ctx.appState.setState)
      return {
        plugins: r.enabled_count,
        commands: r.command_count,
        agents: r.agent_count,
        hooks: r.hook_count,
        mcpServers: r.mcp_count,
        errors: r.error_count,
      }
    } catch (e) {
      return undefined
    }
  }

  async function buildAvailable(): Promise<OpenccMarketplacePluginDto[]> {
    const installed = await buildList()
    const installedIds = new Set(installed.plugins.map((p) => p.id))
    const declared = getDeclaredMarketplaces()
    const out: OpenccMarketplacePluginDto[] = []
    for (const [marketplaceName, decl] of Object.entries(declared)) {
      const mp = await getMarketplace(marketplaceName).catch(() => null)
      if (!mp) continue
      for (const entry of mp.plugins ?? []) {
        const id = `${entry.name}@${marketplaceName}`
        if (installedIds.has(id)) continue
        out.push({
          id,
          name: entry.name,
          description: entry.description,
          version: entry.version,
          author: typeof entry.author === 'string' ? entry.author : entry.author?.name,
          marketplace: marketplaceName,
          category: entry.category,
          tags: entry.tags,
          installed: false,
          homepage: entry.homepage,
        })
      }
    }
    return out
  }

  /**
   * The "市场来源" list. Reads known_marketplaces.json (the state layer) rather
   * than getDeclaredMarketplaces() (the settings intent layer) so that a
   * marketplace materialized on disk still shows up if the settings write is
   * lagging. `pluginCount` is left undefined when the cache can't be read —
   * that's a degraded row, not a zero-plugin marketplace.
   *
   * For installedCount we parse the `id` (`plugin@marketplace`) — the
   * `OpenccPluginDto.marketplace` field is set to `LoadedPlugin.repository`,
   * which for marketplace-loaded plugins is the entry's local source path
   * (e.g. `./plugins/superpowers`), NOT the marketplace name.
   */
  async function buildMarketplaces(): Promise<OpenccMarketplaceDto[]> {
    const config = await loadKnownMarketplacesConfig()
    const installed = await buildList()
    const installedCount = new Map<string, number>()
    for (const p of installed.plugins) {
      const { marketplace } = parsePluginIdentifier(p.id)
      if (!marketplace) continue
      installedCount.set(marketplace, (installedCount.get(marketplace) ?? 0) + 1)
    }
    const out: OpenccMarketplaceDto[] = []
    for (const [name, entry] of Object.entries(config)) {
      const mp = await getMarketplace(name).catch(() => null)
      out.push({
        name,
        source: getMarketplaceSourceDisplay(entry.source),
        sourceType: entry.source?.source ?? 'unknown',
        lastUpdated: entry.lastUpdated,
        pluginCount: mp ? (mp.plugins?.length ?? 0) : undefined,
        installedCount: installedCount.get(name) ?? 0,
      })
    }
    out.sort((a, b) => a.name.localeCompare(b.name))
    return out
  }

  const plugins: OpenccPluginApi = {
    async listInstalled() {
      return buildList()
    },

    async listAvailable(): Promise<OpenccMarketplacePluginDto[]> {
      return buildAvailable()
    },

    async setEnabled(id, enabled) {
      // Auto-detect the scope where the plugin lives rather than forcing
      // 'user'. The UI displays the merged state across scopes, but a
      // hardcoded user-scope write produced false "already disabled"
      // errors whenever the plugin was enabled at project/local scope but
      // absent from user-scope settings — the merged state was enabled
      // while user-scope saw undefined. Letting setPluginEnabledOp resolve
      // the most specific scope (local > project > user) keeps the toggle
      // aligned with the visible state and matches the CLI's /plugin
      // command behavior (ManagePlugins.tsx:1180,1194).
      const op = await setPluginEnabledOp(id, enabled)
      if (!op.success) return { success: false, message: op.message }
      const reload = await reloadActive()
      if (reload === undefined) {
        return { success: true, message: op.message, reloadFailed: true, state: await buildList() }
      }
      return { success: true, message: op.message, reload, state: await buildList() }
    },

    async install(id) {
      const op = await installPluginOp(id, 'user')
      if (!op.success) return { success: false, message: op.message }
      const reload = await reloadActive()
      if (reload === undefined) {
        return { success: true, message: op.message, reloadFailed: true, state: await buildList() }
      }
      return { success: true, message: op.message, reload, state: await buildList() }
    },

    async uninstall(id) {
      const op = await uninstallPluginOp(id, 'user', true)
      if (!op.success) return { success: false, message: op.message }
      const reload = await reloadActive()
      if (reload === undefined) {
        return { success: true, message: op.message, reloadFailed: true, state: await buildList() }
      }
      return { success: true, message: op.message, reload, state: await buildList() }
    },

    async update(id) {
      const op = await updatePluginOp(id, 'user')
      if (!op.success) {
        return { success: false, message: op.message }
      }
      const reload = await reloadActive()
      if (reload === undefined) {
        return { success: true, message: op.message, reloadFailed: true, state: await buildList() }
      }
      return { success: true, message: op.message, reload, state: await buildList() }
    },

    async reload() {
      const reload = await reloadActive()
      if (reload === undefined) return { success: false, message: 'Hot reload failed' }
      return { success: true, message: 'Reloaded', reload, state: await buildList() }
    },

    async listMarketplaces(): Promise<OpenccMarketplaceDto[]> {
      return buildMarketplaces()
    },

    /**
     * Mirrors the CLI's `marketplaceAddHandler`: parse → materialize on disk →
     * declare in user settings. Both writes are required — `addMarketplaceSource`
     * only touches known_marketplaces.json (state), while `listAvailable` reads
     * `getDeclaredMarketplaces()` (settings intent). Skipping
     * `saveMarketplaceToSettings` would add a marketplace whose plugins never
     * appear in the 市场 tab.
     */
    async addMarketplace(source: string): Promise<OpenccMarketplaceActionResult> {
      const raw = (source ?? '').trim()
      if (!raw) return { success: false, message: '请填写市场地址' }

      let parsed
      try {
        parsed = await parseMarketplaceInput(raw)
      } catch (e) {
        return { success: false, message: `解析市场地址失败: ${e instanceof Error ? e.message : String(e)}` }
      }
      if (!parsed) {
        return {
          success: false,
          message: '无法识别的市场地址格式。可用形式: owner/repo、https://... 或本地路径 ./path',
        }
      }
      if ('error' in parsed) {
        return { success: false, message: parsed.error }
      }

      try {
        const { name, alreadyMaterialized, resolvedSource } = await addMarketplaceSource(parsed)
        // Declare the intent at user scope so getDeclaredMarketplaces() sees it.
        saveMarketplaceToSettings(name, { source: resolvedSource }, 'userSettings')
        // getMarketplace is memoized and clearAllCaches() does not touch that
        // memo — without this the freshly added marketplace reads as missing.
        clearMarketplacesCache()
        clearAllCaches()
        return {
          success: true,
          name,
          message: alreadyMaterialized
            ? `市场 '${name}' 已存在于本地，已重新登记`
            : `已添加市场: ${name}`,
          marketplaces: await buildMarketplaces(),
          available: await buildAvailable(),
        }
      } catch (e) {
        return { success: false, message: e instanceof Error ? e.message : String(e) }
      }
    },
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
      //
      // zai patch (sess-1787121363115-0zq3bo8a, server restart 后 model 看不到历史):
      // engines miss (新进程首查 + 新会话) 必须从磁盘 JSONL 反序列化历史灌
      // 回 mutableMessages。复用 vendor 的 deserializeMessages(自带 orphan
      // tool_use / thinking 清理 + 末尾 assistant sentinel 注入)。
      // sessionFacade.readTranscript 返回的 JSONL 字符串就是 vendor
      // recordTranscript 写出的 TranscriptMessage 形态(看 compat/transcript/
      // persistence.ts baseFields + appendUserMessageV2 msg 形态,字段对齐
      // vendor types/logs.ts SerializedMessage),直接 JSON.parse 即可。
      let engine = engines.get(input.sessionId)
      if (!engine) {
let initialMessages: Message[] | undefined
        try {
          const jsonl = await sessions.readTranscript(input.sessionId)
          if (jsonl.trim().length > 0) {
            const entries: Message[] = []
            for (const line of jsonl.split('\n')) {
              const t = line.trim()
              if (!t) continue
              try {
                const e = JSON.parse(t)
                // 仅 transcript 形态参与 chain — 对齐 vendor 的
                // isTranscriptMessage(entry) (sessionStorage.ts:149):
                // user / assistant / attachment / system。其它条目
                // (session-meta / custom-title / file-history-snapshot /
                // attribution-snapshot / worktree-state 等) 是 metadata,
                // 不能喂给 vendor Message[] — 否则 deserializeMessages
                // 内部 filterUnresolvedToolUses 会因 type 不在 union 抛错。
                if (
                  e &&
                  typeof e === 'object' &&
                  'type' in e &&
                  ((e as { type: unknown }).type === 'user' ||
                    (e as { type: unknown }).type === 'assistant' ||
                    (e as { type: unknown }).type === 'attachment' ||
                    (e as { type: unknown }).type === 'system')
                ) {
                  entries.push(e as Message)
                }
              } catch {
                // 跳过损坏行 — 旧 session 可能因各种原因有半行写入
              }
            }
            if (entries.length > 0) {
              initialMessages = deserializeMessages(entries)
            }
          }
        } catch (err) {
          // 新会话 / 文件不存在 / 读失败 → 当作全新对话
          if (process.env.ZAI_DEBUG === '1') {
            console.warn(
              `[openccRuntime] resume hydration failed for ${input.sessionId}:`,
              err,
            )
          }
        }
        // zai patch (2026-08-20): 会话首次 query 时按恢复的 mainAgent
        // 构建 engine —— systemPrompt / tools 槽固定为该会话当时选的 agent。
        engine = createEngine(initialMessages, input.mainAgent)
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
        const stream = engine.submitMessage(input.prompt, {
          // zai patch (2026-08-09): 不用 sessionId 当 user 消息 uuid。
          // 该 uuid 会成为本条 prompt 的 user 文本消息 uuid;若固定为
          // sessionId,同会话第 2 轮起 uuid 重复,recordTranscript 的
          // messageSet dedup 会跳过写入 → 用户消息永不落盘,UI 刷新后
          // 只剩 assistant 回复,表现为"会话错位"。每条 user 消息必须
          // 唯一,用随机 UUID。
          uuid: randomUUID(),
          // zai patch: 透传 isMeta — 后台任务完成触发的占位 query 用 meta
          // prompt(UI 隐藏),真正内容由 QueryEngine 首轮 drain 注入。
          ...(input.isMeta ? { isMeta: true } : {}),
          // zai patch: per-query provider override. zai resolves the model
          // → provider profile on the call site and threads the openai-
          // compatible baseURL/apiKey/model through QueryEngine.submitMessage
          // → processUserInputContext.options.providerOverride → vendor
          // query.ts:1312 → queryModel → getAnthropicClient(providerOverride)
          // → createOpenAIShimClient (openai-shim). Without this,
          // zhiniao-* models would be POSTed to ANTHROPIC_BASE_URL and
          // return `Model not found`.
          ...(input.providerOverride ? { providerOverride: input.providerOverride } : {}),
          // zai patch: per-query provider id (from transcript.meta.providerId).
          // Mirrors the providerOverride plumbing above, but is read by the
          // anthropic-side modelCaller (zai's createAnthropicModelCaller)
          // instead of the openai-shim. Lets findProfileForModel route a
          // model to the exact provider the user picked when several
          // provider profiles share the same model name.
          ...(input.providerId ? { providerId: input.providerId } : {}),
        })
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
        // zai patch (2026-08-10): 接线 sdkEventAdapter。vendor
        // submitMessage() 产出 SDK Message(assistant / user / stream_event /
        // result),translateSdkToRuntime 把它们翻译成 Anthropic primitives
        // (message_start / content_block_* / message_stop),供下游
        // translateRuntimeEvents 消费。97ab9d1 删除了 translateRuntimeEvents
        // 里对 assistant / user Message 的直接处理并依赖这里接线 ——
        // 之前未接线导致 vendor 原始流全被 default 丢弃,只剩 result →
        // runtime.done,模型回复文本丢失(Web 收不到消息)。adapter 同时处理
        // stream_event 实时流与 assistant 终端消息,并用 streamedBlockIndices
        // 去重避免同一 block 双发。
        const adapterMeta = {
          sessionId: input.sessionId,
          turnIndex,
          eventCounter: 0,
          toolNameByUseId: new Map<string, string>(),
          streamedBlockIndices: new Set<number>(),
        }
        while (true) {
          const step = sdkCtx
            ? await runWithSdkContext(sdkCtx, () => stream.next())
            : await stream.next()
          if (step.done) break
          for (const ev of translateSdkToRuntime(step.value, adapterMeta)) {
            yield ev as any
          }
          // adapter 用 meta.eventCounter 前缀生成 eventId(evt-N / evt-N.M),
          // 每条 vendor 消息内部用 seq 区分,跨消息需递增(单次 makeEvent 不
          // 自动递增 eventCounter)。
          adapterMeta.eventCounter++
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
      // zai patch (并发多会话): 删除 session 前先 abort 该 session 仍在跑的
      // query。否则该 query 还在 for-await loop 里持有 engine 引用(包括
      // mutableMessages),直到 for-await 自然退出才被 GC。短时间不会
      // 泄漏,但高 churn 场景(用户频繁移除会话)下内存涨幅可观。
      // 跳过已 aborted 的 controller — abort 监听者抛 AbortError,再次
      // abort 会让监听者代码路径抛 `signal already aborted` 类型错误,
      // 这里 c.abort(reason) 自带 idempotent 即可,但加一道防止误用。
      const c = queryAbortControllers.get(sessionId)
      if (c && !c.signal.aborted) c.abort('session removed')
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
    plugins,
  }
}
