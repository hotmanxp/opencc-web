// @ts-nocheck — vendor ToolUseContext 的形状由 vendor 定义,主 tsconfig
// 排除了 src/opencc-src,这里只能 `as any` 桥接(与 createReplSession 一致)。

/**
 * zai-server 侧的 `ToolUseContext` 构造器。
 *
 * 为什么要有这个模块:`createReplSession` 每次 REPL turn 都会构造一份
 * `toolUseContext` 喂给 vendor `query()`;手动 `/compact` 接线(P2)要把
 * vendor `compactConversation` 也接进来,它要的是同一个形状。复制一份必然
 * 漂移 —— 而这份 context 里的防御默认值是踩坑换来的(见下方 getAppState
 * 注释:早期不补 `toolPermissionContext` 哨兵时,第一个纯文本 prompt 就崩在
 * `Cannot read properties of undefined (reading 'mode')`)。故抽成共用函数。
 *
 * 首次落地:createReplSession.ts P3-T0(2026-08-30)。手动 /compact 复用:
 * plan P1-1(2026-10-08)。
 *
 * 与 vendor REPL 的差异:zai 是 Web 无 TTY,所以
 * `setStreamMode` / `setSDKStatus` / `setResponseLength` / `setToolJSX` 这类
 * 终端 Ink UI 状态控制全部是 no-op 或不提供。vendor compact.ts 用到其中
 * 三个,均为 optional 调用(`context.setResponseLength?.(...)`),不提供即
 * no-op —— 实测见 plan §2.2 的成员用量表。
 */

/** 懒加载的 vendor 工具/命令/文件态上下文。测试下为 null 以跳过重型 import 链。 */
export type VendorToolContext = {
  getTools: (permissionContext: unknown) => unknown
  getCommands: (cwd: string) => Promise<unknown>
  createFileStateCacheWithSizeLimit: (n: number) => unknown
  createAbortController: () => AbortController
}

export type BuildReplToolUseContextOptions = {
  /** host 注入的实际生产态,优先于 vendor fallback。 */
  tools?: unknown
  commands?: unknown
  mcpClients?: unknown
  readFileState?: unknown
  agents?: unknown
  cwd: string
  model: string
  sessionId: string
  vendorCtx: VendorToolContext | null
  /** `vendorCtx.getCommands(cwd)` 的 await 结果;host 未提供 commands 时用。 */
  resolvedCommands?: unknown
  getAppState?: () => unknown
  setAppState?: (fn: (prev: unknown) => unknown) => void
}

/**
 * 构造 zai-server 用的 `toolUseContext`。
 *
 * 上下文见 `BuildReplToolUseContextOptions`;调用方负责决定是否加载
 * `vendorCtx`(createReplSession 按 NODE_ENV 与 host 覆盖情况决定,见该文件
 * useVendorFallbacks 判定)。
 */
export function buildReplToolUseContext(
  opts: BuildReplToolUseContextOptions,
): any {
  const {
    tools: hostTools,
    commands: hostCommands,
    mcpClients: hostMcpClients,
    readFileState: hostReadFileState,
    agents: hostAgents,
    vendorCtx,
    // `getCommands` 是 async(vendor 侧读磁盘),调用方 await 后传入成品。
    resolvedCommands,
  } = opts

  // Vendor getTools needs a ToolPermissionContext; we don't have a real one
  // in server-repl mode, so use the empty default. assembleToolPool expects
  // (permissionContext, mcpTools); passing getEmptyToolPermissionContext means
  // permission-mode rules won't filter any tools (which is the right default
  // — host-supplied tools already passed host-side filtering).
  const fallbackTools =
    hostTools ??
    (vendorCtx
      ? vendorCtx.getTools({
          mode: 'acceptEdits',
          additionalWorkingDirectories: new Map(),
          alwaysAllowRules: {},
          alwaysDenyRules: {},
          alwaysAskRules: {},
          isBypassPermissionsModeAvailable: false,
        })
      : // 无 vendor 上下文且 host 也没给时必须给**数组**。
        //
        // zai patch (2026-10-08, 真机验证发现): 原来这里退化成 `{}`,而
        // vendor `getSystemPrompt` 内部第一件事就是
        // `new Set(tools.map(m => m.name))` —— 对象没有 .map,直接抛
        // `TypeError: e.map is not a function`。单测测不到(都 mock 掉了),
        // 真机跑 /compact 才暴露。
        //
        // 压缩摘要不需要任何工具(vendor 的 compact 请求 tools: []),空数组
        // 是语义正确且安全的取值。
        [])

  // zai patch (2026-10-08, 真机验证发现): 无 vendor 上下文时必须给 **Map**。
  //
  // vendor compactConversation 内部对 `context.readFileState` 做
  // `Object.fromEntries(readFileState.entries())`(bundle 里压缩为
  // `krt(t.readFileState)`)来汇总本次压缩碰过的文件。普通对象没有
  // `.entries()`,真机跑 /compact 抛 `TypeError: e.entries is not a
  // function`。单测测不到 —— 那两个文件都把 vendor 链 mock 掉了。
  //
  // 压缩摘要不读文件,空 Map 是语义正确且安全的取值。
  const fallbackReadFileState =
    hostReadFileState ??
    (vendorCtx ? vendorCtx.createFileStateCacheWithSizeLimit(100) : new Map())

  return {
    options: {
      commands: hostCommands ?? resolvedCommands ?? [],
      debug: false,
      mainLoopModel: opts.model ?? 'claude-sonnet-4-5',
      tools: fallbackTools,
      verbose: false,
      thinkingConfig: { type: 'adaptive' as const },
      mcpClients: hostMcpClients ?? [],
      // Record 而非 Map —— vendor 侧按 `Object.values(mcpResources)` 消费
      // (opencc-src/hooks/unifiedSuggestions.ts:137),与 Tool.ts:193 的声明一致。
      mcpResources: {},
      isNonInteractiveSession: true,
      agentDefinitions: {
        activeAgents: hostAgents ?? [],
        allAgents: [] as unknown[],
      },
      customSystemPrompt: undefined,
      appendSystemPrompt: undefined,
      querySource: 'server-repl' as const,
    },
    // zai patch (2026-09-07, plan P0-1.5, worktree-dsh): 独立 sessionId 字段,
    // 不复用 agentId,配合 query.ts:2672-2673 mid-turn drain filter 走独立
    // sessionId 路由,规避 vendor 内部 30+ 处 toolUseContext.agentId 副作用
    // (BashTool preventCwdChanges / attachments plan 路径 / PermissionContext /
    // SDK 输出)。
    sessionId: opts.sessionId,
    agentId: undefined,
    abortController: vendorCtx
      ? vendorCtx.createAbortController()
      : new AbortController(),
    readFileState: fallbackReadFileState,
    // zai patch (2026-08-30, plan P3-T0 fix): vendor getTools() and most tool
    // implementations dereference
    // `appState.toolPermissionContext.{mode, additionalWorkingDirectories,
    // prePlanMode}` synchronously during query(). The zai web host typically
    // passes a minimal getAppState (just enough for the message store), so
    // without defensive defaults the very first plain-text prompt crashes
    // with "Cannot read properties of undefined (reading 'mode')". Mirror the
    // shape queryContext.ts:107-160 builds, with safe sentinels.
    // zai patch (2026-08-30, plan P3-T0 fix): vendor 在压缩/查询链路上会
    // 直接解构 appState 的多个字段,缺一个就抛。The zai web host typically
    // passes a minimal getAppState, so 这里逐字段补安全哨兵。
    //
    // 2026-10-08 真机验证补记:原实现是
    // `if (host.toolPermissionContext) return host` —— 只要 host 带了
    // toolPermissionContext 就**整体早退**,其余字段不补。vendor 压缩链实际
    // 读取这四个键(全链 grep 得到):
    //   appState.toolPermissionContext — getTools / 权限判定
    //   appState.tasks                — Sus() 里 Object.values(appState.tasks)
    //                                    收集 task_status 附件,缺则
    //                                    "Cannot convert undefined or null to object"
    //   appState.todos                — 待办附件
    //   appState.mcp                  — MCP 状态
    // 改成逐字段 `?? 哨兵`,不再早退 —— host 有哪个用哪个,缺的补上。
    getAppState: () => {
      const host = (opts.getAppState?.() ?? {}) as Record<string, unknown>
      return {
        ...host,
        toolPermissionContext: host.toolPermissionContext ?? {
          mode: 'default',
          additionalWorkingDirectories: new Map<string, string>(),
          prePlanMode: 'default',
        },
        tasks: host.tasks ?? {},
        todos: host.todos ?? {},
        mcp: host.mcp ?? {},
      } as any
    },
    setAppState: (fn: (prev: unknown) => unknown) => {
      opts.setAppState?.(fn)
    },
    setInProgressToolUseIDs: () => {},
    setResponseLength: () => {},
    updateFileHistoryState: () => {},
    updateAttributionState: () => {},
    messages: [] as any[],
  }
}
