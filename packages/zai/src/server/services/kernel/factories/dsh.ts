/**
 * dsh 轨道工厂 — 真实长驻 adapter 实现（B1a T1.1 + B1b T1.6）。
 *
 * 取代 B0 桩：把 dsh-bridge 的 createDshRuntime 包成 KernelAdapter 全套接口。
 *
 * 关键实现：
 *   - run() 调 runOnce()，把 dsh SessionEvent 通过 translateSessionEvent → ServerEvent
 *   - abort() 调 agent.cancel() （B1b T1.6 验收点）
 *   - shutdown() 走 drain 顺序（B-1 尖峰定义）
 *   - listSessions 从 dsh-sessions/ 目录读（B3 T3.1 完整对齐）
 */

import type { ServerEvent } from '../../../../shared/events.js'
import type { ZaiSettings } from '../../../../shared/settings.js'
import {
  type KernelAdapter,
  type AgentSession,
  type SessionMeta,
  type TranscriptPatch,
  type TranscriptEntry,
  type AskRequest,
  type AskResponse,
  type ApproveRequest,
  type ApproveResponse,
  type StateChangeEvent,
  type QueuePayload,
  type KernelMetrics,
} from '../kernelAdapter.js'
import {
  installZaiGlobalBridges,
  trackZaiGlobalBridge,
  clearZaiGlobalBridges,
  ZAI_GLOBAL_BRIDGE_KEYS,
} from '../globalThisBridge.js'
import { DSH_KERNEL } from '../paths.js'
import {
  getBashBackgroundTracker,
  getCommandRegistry,
  getLastContextTokens,
  setLastContextUsage,
  stateChangeBus,
  type TaskItem,
} from '@zn-ai/zn-agent-core'
import {
  getAskRegistry,
  getApproveRegistry,
  getCurrentSessionId,
  setCurrentSessionId,
} from '../../agentRuntime.js'
import { loadMcpServers } from '../../mcpConfig.js'
import type { Context as DshContext } from '@zn-ai/dsh-bridge'

/** dsh Cordis ctx 本地别名 — 避免 import 实体与未来 Context 类型冲突。 */
type Context = DshContext

/**
 * DshTodoItem 形态(上游 dsh-tool-todo `TodoItem`) — `{content, status}`。
 * 这里直接透传到 zai stateChangeBus,不在 server 端映射成 V2TaskItem:
 * - 翻译路径(translate/sessionEvents.ts `todo/write` case)也产同形态 payload,
 *   两条通道 SSE 共享 zod schema(`shared/events.ts` `DshTodoItemSchema`),
 *   避免形态不一致导致 parse 失败被静默丢。
 * - 映射(id=content, subject=content, blocks=[], blockedBy=[], updatedAt=now)
 *   在 zai 客户端 reducer `useAgentStore.applyV2TaskChanged` action='snapshot'
 *   分支完成 — V2TaskItem schema 属于 zai/web 渲染层关注。
 */
interface DshTodoItemPayload {
  content: string
  status: string
}

/**
 * 上游 `dsh-tool-todo` TodoItem 形态 — `{content, status}`,无 id/blocks/
 * blockedBy/updatedAt 字段。**故意不映射成 V2TaskItem** — 映射在 zai 客户端
 * reducer (useAgentStore.applyV2TaskChanged action='snapshot' 分支) 完成,
 * 与 dsh-bridge translate 路径(`{content, status}[]` 透传)保持形态一致,
 * SSE payload zod schema 端到端用同一种 DshTodoItemSchema 验证。
 *
 * `null`(还没 first write 或 `turn/start` 重置)→ 返回空数组,前端 TodoZone
 * 过滤 length===0 不渲染。
 */

/**
 * 订阅 dsh `ctx.sessionProjections` 的 `todos` 投影,把每次变更 whole-list
 * 推给 zai `stateChangeBus.emit('v2_task.snapshot', { tasks, action: 'snapshot' })`。
 *
 * zai stateChangeBus → stateBridge.ts(已有 onV2TaskSnapshot)转发到
 * eventBus.emit → SSE 推前端 → useEventStream dispatch 'v2_task.snapshot' case
 * → useAgentStore.applyV2TaskSnapshot → TodoZone 实时刷新。
 *
 * **为何单独 type literal**:与 opencc-mode `v2_task.changed` (单 task 增量
 * upsert/delete) 是不同语义。共享同名 type literal 会被 zod
 * discriminatedUnion 拒绝(duplicate value),所以单独走 'v2_task.snapshot'。
 *
 * **为何不直接 emit 到 SSE 而走 stateChangeBus**:为与 opencc 自实现 TaskCreate/
 * Update 事件保持单一 sink,所有 v2_task 事件都在 stateBridge 统一转发 —
 * 后续若要加 SSR / metrics 收集,在 stateBridge 改一处即可。
 *
 * **fallback**:ctx.sessionProjections service 不存在(理论上不应该 — Phase 5P1-B
 * 已自动装载 dsh-session-projection,但冷启动 race 可能未注册完成)→ 返回
 * no-op disposer,主流程不阻断。
 */
function subscribeDshSessionProjections(
  ctx: Context,
): () => void {
  const projections = ctx.get('sessionProjections') as
    | {
        onChanged: (
          cb: (
            session: { id: { toString(): string } },
            key: string,
            value: unknown,
            seq: number,
          ) => void,
        ) => () => void
      }
    | undefined
  if (!projections) {
    console.warn(
      '[dsh-adapter] ctx.sessionProjections missing — todo 投影不监听,' +
        '前端 TodoZone 看不到 dsh-tool-todo 实时更新',
    )
    return () => undefined
  }
  return projections.onChanged((session, key, value, _seq) => {
    if (key !== 'todos') return
    // 透传 TodoItem[] (上游 schema: {content, status}),不在 server 端映射 —
    // 映射在客户端 reducer 完成,两条通道 (translate + sessionProjections)
    // 共享同一种 payload 形态,避免 zod schema mismatch 静默丢事件。
    //
    // Phase 5P5 收口:emitter 用单独的 'v2_task.snapshot' (与 opencc-mode
    // 单 task CRUD 的 'v2_task.changed' 互斥)。原版想塞进同 type literal
    // 但跨 action 联合,zod discriminatedUnion 抛 duplicate-discriminator
    // 把整个 SSE 通道打死。
    const tasks: Array<{ content: string; status: string }> =
      (value as Array<{ content: string; status: string }> | null) ?? []
    stateChangeBus.emit('v2_task.snapshot', {
      sessionId: session.id.toString(),
      tasks,
      action: 'snapshot',
    } as never)
  })
}

interface DshKernelConfig {
  cwd: string
  dataDir: string
  settings: ZaiSettings
}

/**
 * dsh 长驻 ctx 的 module-level singleton — 在 `createDshKernelAdapter`
 * 完成 `handle.start()` 后设置。zai 服务层 `agentRuntime.ts` 在
 * 初始化完成时拉这个 ctx 给 `DshTranscriptAdapter` 读 dsh
 * `sessionPersistence` 服务。返回 `Context | null` — adapter 还没
 * 装载时为 null（init 早期 / dsh 模式未启动）。
 *
 * dsh-020 / transcript 恢复修复:d sh 模式下 `getTranscriptStore()` 必须
 * 拿到 dsh-side `JsonlSessionPersistence` 才能读 session.log,否则 routes
 * 列表 / 详情 / patch 全部返回 opencc 占位数据,用户看不到 dsh 会话。
 */
let activeDshContext: Context | null = null

export function getDshHandleForTranscript(): Context | null {
  return activeDshContext
}

/** Test seam — 单元测试可重置 module-level 状态。 */
export function __resetDshContextForTests(): void {
  activeDshContext = null
}

function toAgentSession(sessionId: string, cwd: string): AgentSession {
  return { kernel: DSH_KERNEL, sessionId, cwd }
}

export async function createDshKernelAdapter(
  cfg: DshKernelConfig,
): Promise<KernelAdapter> {
  const bridge = await import('@zn-ai/dsh-bridge')

  // ── 1. 长驻 Cordis ctx 装配（B1a T1.1 + dsh-013 修复） ─────
  //
  // dsh-013 修复:zai-server 不是浏览器,无法走 dsh-host-apiproxy UI 配 key
  // 流程。直接读 env (`ANTHROPIC_BASE_URL` / `ANTHROPIC_API_KEY` /
  // `ANTHROPIC_DEFAULT_SONNET_MODEL`)构 provider profile,显式传给
  // createDshRuntime,dsh-bridge 内部通过 cordis-plugin-loader 装载
  // dsh-base patch + dsh-llm-pi-ai provider,让 dsh agents service 能查表。
  //
  // apiKeyEnv 是**引用**而非 key 本身 —— dsh-llm-pi-ai 每次请求按引用从
  // `launchEnvironmentOf(ctx).get(ref)` 拉取,不在 zai 进程缓存。
  const defaultModel =
    cfg.settings.model
    ?? process.env.ANTHROPIC_DEFAULT_SONNET_MODEL
    ?? process.env.ANTHROPIC_SMALL_FAST_MODEL
    ?? ''
  const anthropicApiKeyEnv =
    process.env.ANTHROPIC_API_KEY ? 'ANTHROPIC_API_KEY' : 'ANTHROPIC_AUTH_TOKEN'
  // Phase 3 P1: minimaxi 提供 MiniMax-M3 + MiniMax-M2.7 + M2.7-highspeed
  // 三个 model;MiniMax-M3 / M2.7 支持 image input(per pi-ai 内置
  // minimax-cn.json registry)。给 anthropic profile 注册完整 catalog
  // + 显式声明 `input: ['text', 'image']`,dsh-llm-pi-ai 才能识别
  // vision-capable model(否则 streamSimple 抛 `does not support image
  // input (UNSUPPORTED_CONTENT)`)。
  //
  // 用户切换 model 时(zai front-end ModelStatusButton 选 MiniMax-M3),
  // dsh-llm-pi-ai 在 streamSimple 时按 `model.input` 校验,声明过 image
  // 的 model 才能接 image block。
  const anthropicProfile: import('@zn-ai/dsh-bridge').DshProviderProfile = {
    name: 'anthropic',
    displayName: 'Anthropic (Anthropic-compatible)',
    baseURL:
      process.env.ANTHROPIC_BASE_URL
      ?? 'https://api.anthropic.com',
    apiKeyEnv: anthropicApiKeyEnv,
    // dsh-021 root cause 修复:profile-level `defaultReasoningEffort` 才是
    // dsh-llm-pi-ai `PiAiProviderProfile.reasoning` 的真正入口 —
    // 写到这才能让 streamSimple 给 anthropic API 发 `thinking: { type: 'enabled' }`,
    // API 才会返 thinking 块,dsh 才会 emit `thinking_*` 事件,dsh-bridge
    // translateSessionEvent 才会 emit `runtime.thinking`,UI ThinkingBlock
    // 才会渲染。zai OPENCC 模式走 vendor Anthropic SDK,SDK 默认按 client
    // 端 settings 发 thinking;DSH 模式必须**显式**写到 dsh-bridge profile。
    defaultReasoningEffort: 'medium',
    models: [
      // 显式声明的 vision-capable model — 必须列在前面让 dsh-llm-pi-ai
      // catalog 优先匹配(否则 dsh-llm-pi-ai 找不到 model id 报
      // UNKNOWN_MODEL)。
      //
      // reasoningEfforts: zai OPENCC 模式走 vendor Anthropic SDK,
      // SDK 默认按 client 端 settings 发 thinking。DSH 模式必须显式
      // 声明 reasoningEfforts — 否则 dsh-llm-pi-ai profile.reasoning
      // 是空,stream 时 resolveReasoningLevel 返回 'off',不 emit
      // thinking_delta → dsh-bridge translateSessionEvent 永远不收
      // 到 reasoning-delta → runtime.thinking SSE 永远不发 → UI
      // ThinkingBlock 不渲染。
      //
      // 高speed variant 不一定支持 extended thinking,设 false 显式
      // 声明不支持(dsh-llm-pi-ai schema 允许 z.const(false))。
      {
        id: 'MiniMax-M3',
        input: ['text', 'image'],
        contextWindow: 1_000_000,
        maxTokens: 128_000,
        reasoningEfforts: ['low', 'medium', 'high'],
        defaultReasoningEffort: 'medium',
      },
      {
        id: 'MiniMax-M2.7',
        input: ['text', 'image'],
        contextWindow: 204_800,
        maxTokens: 131_072,
        reasoningEfforts: ['low', 'medium', 'high'],
        defaultReasoningEffort: 'medium',
      },
      {
        id: 'MiniMax-M2.7-highspeed',
        input: ['text'],  // highspeed 不支持 image
        contextWindow: 204_800,
        maxTokens: 131_072,
        reasoningEfforts: false,
      },
    ],
  }
  // Phase 5P-MCP: zai 端提前调 `loadMcpServers(cwd)` 解析 4 scope .mcp.json
  // (enterprise > user > local > project),把结果传给 `createDshRuntime({
  // mcpServers })`。由 createDshRuntime 装载阶段 spawn N 个 dsh-mcp-client plugin。
  // 取代之前 dsh-bridge 内部 `registerMcpTools(ctx, {cwd})` 自实现 MCPClientPool
  // (577 行代码删除)。
  //
  // 字段适配:zai 的 `McpServerSpec.transport` 是 discriminated union
  // (stdio / sse / http);dsh-bridge 期望扁平 (command / url / headers)。
  // `transport.kind` 决定 command-or-url,扁平化后再传。
  const mcpServers = loadMcpServers(cfg.cwd).map((s) => {
    const t = s.transport
    if (t.kind === 'stdio') {
      return {
        name: s.name,
        command: t.command,
        args: t.args,
        env: t.env,
        cwd: cfg.cwd,
      }
    }
    // sse / http 都用 url + headers
    return {
      name: s.name,
      url: t.url,
      headers: t.headers,
      cwd: cfg.cwd,
    }
  })
  const handle = await bridge.createDshRuntime({
    dataDir: cfg.dataDir,
    runtimeId: 'zai-server-dsh',
    defaultCwd: cfg.cwd,
    defaultModel,
    providers: [anthropicProfile],
    mcpServers,
  })
  await handle.start()
  // dsh-020:暴露 ctx 给 DshTranscriptAdapter,让 routes 读 dsh session.log。
  // 必须在 start() 之后 — `JsonlSessionPersistence` 是 plugin,需 plugin 装载
  // 完成才能 `ctx.get('sessionPersistence')` 拿到实例。
  activeDshContext = handle.ctx

  // ── 1.5 dsh-bridge bridges（B2/B4/B5/B7 真实化 — dsh-016） ───────
  // 装载 zai 增强工具（bash/fs/ripgrep/mcp/skill）+ 把后台 bash 任务接到
  // zai `bashBackgroundTracker`（让 UI TaskDock 可见）+ 装审批/AskUser 桥
  // + slash 命令桥 + 插件 hooks/commands。
  let toolsDisposer: (() => void) | null = null
  let interactionDisposer: (() => void) | null = null
  let slashDisposer: (() => void) | null = null
  let pluginDisposer: (() => void) | null = null
  // Phase 5P5 适配:监听 dsh sessionProjections 的 todos 投影,把上游
  // whole-list snapshot 推成 zai stateChangeBus 'v2_task.snapshot'。
  // 卸载时 dispose。
  let projectionDisposer: (() => void) | null = null

  // (a) zai 增强工具 + 后台 bash tracker 接线
  const bashTracker = getBashBackgroundTracker()
  toolsDisposer = await bridge.registerZaiTools(handle.ctx, {
    cwd: cfg.cwd,
    // Phase 3 P0-A+ B1: 子 agent 需 provider + model 才能调 LLM(否则
    // dsh 抛 "has no provider/model")。注入 anthropic profile 名 +
    // defaultModel 给所有工具(Agent 工具 spawn 时传给子 agent)。
    getProvider: () => anthropicProfile.name,
    getDefaultModel: () => defaultModel || undefined,
    onBackgroundStart: ({ taskId, command, cwd: _cwd }) => {
      bashTracker.register(taskId, {
        command,
        sessionId: getCurrentSessionId() ?? '',
        description: command,
        startedAt: Date.now(),
      })
    },
    notifyBackground: ({ taskId, status }) => {
      bashTracker.markFinished(
        taskId,
        status === 'done' ? 'completed' : status === 'killed' ? 'killed' : 'failed',
        {},
      )
    },
    // dsh-017: 把当前 sessionId 传给 dsh-bridge,Task*/Cron* 工具用它做 session
    // 隔离(主计划 R4)。getParentAgent 给 cron 触发时用 — 从 dsh agents
    // service 按 sessionId 拿 agent 句柄,触发时 followup(<cron-fire>)。
    getSessionId: () => getCurrentSessionId() ?? undefined,
    getParentAgent: (sessionId: string) => {
      const agents = handle.ctx.get('agents') as {
        get?: (id: unknown) => { followup?: (msg: unknown) => void; session?: unknown; cancel?: (cause: { kind: 'user' }) => void } | undefined
      } | undefined
      // dsh-side Agent 接口的最小子集 — zai 不直接 import @deepseek-ai/dsh-agent
      // (避免增加 zai 包依赖),按 dsh-bridge spawnDshSubagent 期望的 contract
      // 暴露 followup / session / cancel 即可。
      return agents?.get?.(sessionId) as unknown as import('@zn-ai/dsh-bridge').AgentToolParentAgent | undefined
    },
    // dsh-017: Agent 工具 spawn 子 agent 时需要 dsh `agents` service。
    // zai 端预解析 ctx.get('agents') 后通过 callback 注入(因为 dsh-tools
    // ToolRunContext 不暴露 cordis ctx)。
    getAgentsService: () => {
      return handle.ctx.get('agents')
    },
    // dsh-019 修复 `ctx.plugin is not a function` — 传真实 cordis ctx,
    // 让 spawnDshSubagent 内部 createScope 能调 ctx.plugin(scope) 装载
    // 子 scope(单传 agents service 不够,因为 createScope 走 plugin 而
    // 不是 ctx.get)。
    getDshCtx: () => handle.ctx,
    onTaskStart: ({ taskId, description, prompt }) => {
      // dsh-017: 复用 bashBackgroundTracker 显示 subagent 任务(同 tracker
      // 但 description 是 prompt 摘要,command 字段填 taskId 方便辨识)。
      bashTracker.register(taskId, {
        command: `[subagent ${taskId}] ${description}`,
        sessionId: getCurrentSessionId() ?? '',
        description: prompt.slice(0, 200),
        startedAt: Date.now(),
      })
      // dsh-019: 推 subagent.changed 事件 — zai-side stateBridge
      // 翻译成 ServerEvent 'subagent.changed' 推到前端,UI Subagents
      // tab 用此事件实时刷新(spinner + interrupt 按钮)。
      stateChangeBus.emit('subagent.changed', {
        sessionId: getCurrentSessionId() ?? '',
        taskId,
        description,
        status: 'running',
        action: 'start',
      } as never)
    },
    onTaskFinish: ({ taskId, status, error }) => {
      bashTracker.markFinished(
        taskId,
        status === 'done' ? 'completed' : status === 'cancelled' ? 'killed' : 'failed',
        {},
      )
      // dsh-019: 推 subagent.changed 事件(action=finish),让 UI 自动
      // 移除 spinner,显示 result/error。
      stateChangeBus.emit('subagent.changed', {
        sessionId: getCurrentSessionId() ?? '',
        taskId,
        description: '',
        status: status === 'cancelled' ? 'cancelled' : status === 'done' ? 'done' : 'failed',
        action: 'finish',
        ...(error ? { error } : {}),
      } as never)
    },
    onTaskChange: ({ sessionId, task, action }) => {
      // dsh-017: 转发到 stateChangeBus,让 zai-side stateBridge
      // 把 v2_task.changed 翻成 eventBus ServerEvent,UI TodoZone 实时刷新。
      // payload shape 与 zai compat taskListStore 对齐:整个 task object
      // + action ('upsert' | 'delete')。
      stateChangeBus.emit('v2_task.changed', {
        sessionId,
        task: task as unknown as TaskItem,
        action: action === 'create' ? 'upsert' : 'upsert',  // Phase 1: dsh 不删,都走 upsert
      } as never)
    },
    onCronChange: ({ action, task, sessionId }) => {
      if (!task) return
      // dsh-018: emit stateChangeBus 'cron.changed' — stateBridge handler
      // 翻译成 ServerEvent 'cron.changed' 推到前端 SSE 通道。Phase 1
      // UI 端暂无 cron-specific handler(消息只流到 eventBus),Phase 2
      // 加 UI 集成(类似 TodoZone 的 CronZone)。
      stateChangeBus.emit('cron.changed', {
        sessionId,
        cronTaskId: task.id,
        cron: task.cron,
        prompt: task.prompt,
        nextFireAt: task.nextFireAt,
        action,
      } as never)
    },
  })

  // (b) 审批 + AskUser 桥 → zai 现有 registry
  const interactionBridges = bridge.installInteractionBridges(handle.ctx)
  interactionBridges.setSink({
    requestApprove: async (req) => {
      const { decision, comment } = await getApproveRegistry().register(
        req.toolUseId,
        req.sessionId,
        req.filePath,
        req.abortSignal,
      )
      if (decision === 'approved') return { kind: 'allow' }
      return { kind: 'deny', reason: comment }
    },
    requestAskUser: async (req) => {
      const answers = await getAskRegistry().register(
        req.toolUseId,
        req.sessionId,
        req.abortSignal,
      )
      // dsh `AskUserAnswer.answers: Record<string, string>`；zai 返回的
      // answers.answers 是数组形态,转成 {question.text: answer.text} 字典。
      const map: Record<string, string> = {}
      const arr = (answers as { answers?: Array<{ answer: { text?: string } | string }> })?.answers
      if (Array.isArray(arr)) {
        for (let i = 0; i < arr.length; i++) {
          const raw = arr[i]?.answer
          const text = typeof raw === 'string' ? raw : raw?.text ?? ''
          const key = req.questions[i]?.question ?? String(i)
          map[key] = text
        }
      }
      return { answers: map }
    },
    getSessionId: () => getCurrentSessionId() ?? undefined,
  })
  interactionDisposer = () => interactionBridges.dispose()

  // Phase 5P5 适配:订阅 dsh 上游 todos 投影,把每次变更 whole-list 推
  // stateChangeBus 'v2_task.snapshot'。stateBridge.ts 已有 onV2TaskSnapshot
  // 转发到 eventBus,SSE 推前端 → useAgentStore reducer。
  projectionDisposer = subscribeDshSessionProjections(handle.ctx)

  // (c) slash 命令桥 → zai command registry
  const cmdReg = getCommandRegistry()
  slashDisposer = bridge.installSlashCommands(handle.ctx, {
    listCommands: async () =>
      cmdReg.all().map((c) => ({
        name: c.name,
        description: c.description,
        source: c.source === 'user' ? 'user' : 'builtin',
      })),
    executeCommand: async (input, { sessionId, cwd }) => {
      const resolved = cmdReg.resolve(input)
      if (!resolved) return { output: `Unknown command: ${input}`, isError: true }
      // Command 联合类型: LocalCommand 有 execute,PromptCommand 没有。
      const cmd = resolved.command
      if (cmd.type !== 'local') {
        return { output: `Command "${cmd.name}" cannot be executed directly (type=${cmd.type})`, isError: true }
      }
      const result = await cmd.call(resolved.args, {
        cwd,
        sessionId,
        dataDir: cfg.dataDir,
      })
      return {
        output: typeof result === 'string' ? result : JSON.stringify(result),
      }
    },
  })

  // (d) 插件 hooks/commands
  pluginDisposer = await bridge.installZaiPlugins(handle.ctx)

  // ── 2. globalThis 桥安装（B0 T0.8） ──────────────────────────────
  installZaiGlobalBridges({
    __zaiEventBus: (globalThis as any).__zaiEventBus,
    __zaiBridgeCtx: (globalThis as any).__zaiBridgeCtx,
    __zaiSessionInbox: (globalThis as any).__zaiSessionInbox,
  })
  for (const key of ZAI_GLOBAL_BRIDGE_KEYS) {
    trackZaiGlobalBridge(key, (globalThis as any)[key])
  }

  // ── 2.5 dsh-019: __zaiDshSubagentControl 桥 ──────────────────────────
  // 把 dsh-bridge 的 subagent 3 件套(list/cancel/sendMessage)通过
  // globalThis 暴露给 zai compat `subagentControl` 工具(opencc-src/tools
  // /opencc/subagentControl.ts 检测此桥存在则走 dsh 模式,否则走原
  // BackgroundRuntime — opencc 模式)。这样 dsh 模式下 LLM 调
  // subagent_control 工具时,能列/中断/给 dsh subagent 投消息。
  ;(globalThis as {
    __zaiDshSubagentControl?: {
      list: (parentSessionId?: string) => Promise<Array<{ id: string; status: string; description?: string }>>
      cancel: (taskId: string) => Promise<{ ok: boolean }>
      sendMessage: (taskId: string, prompt: string) => Promise<{ ok: boolean }>
    }
  }).__zaiDshSubagentControl = {
    list: async (parentSessionId?: string) => {
      const tasks = await bridge.listDshSubagents(handle.ctx, parentSessionId)
      return tasks.map((t) => ({
        id: t.taskId,
        status: t.status,
        ...(t.prompt ? { description: t.prompt.slice(0, 120) } : {}),
      }))
    },
    cancel: async (taskId: string) => {
      try {
        const updated = await bridge.interruptDshSubagent(handle.ctx, taskId)
        return { ok: updated != null }
      } catch (err) {
        return { ok: false }
      }
    },
    sendMessage: async (taskId: string, prompt: string) => {
      try {
        return await bridge.sendMessageToDshSubagent(handle.ctx, taskId, prompt)
      } catch {
        return { ok: false }
      }
    },
  }

  // ── 2.6 dsh-019 Phase 2: __zaiDshSubagentDetail 桥 ─────────────────────
  // 暴露 readTask(id) — 直接读 ~/.zai/tasks-dsh/<taskId>.json 拿完整
  // DshTaskState(带 startedAt/finishedAt/result/error/prompt/toolCalls),
  // 给 /api/subagent-tasks/:id 详情端点用(Subagent 详情 Drawer)。
  // Phase 3 P0-A 新增 toolCalls 字段 — spawnDshSubagent 期间累积,详情
  // Drawer 渲染子 agent 的工具调用历史。
  ;(globalThis as {
    __zaiDshSubagentDetail?: {
      readTask: (taskId: string) => Promise<{
        taskId: string
        sessionId: string
        parentSessionId?: string
        status: 'running' | 'done' | 'failed' | 'cancelled'
        prompt: string
        startedAt: number
        finishedAt?: number
        result?: unknown
        error?: string
        toolCalls?: Array<{
          callId: string
          toolName: string
          input: unknown
          output?: unknown
          status: 'running' | 'done' | 'error'
          ts: number
          durationMs?: number
          error?: { name: string; code: string }
        }>
      } | null>
    }
  }).__zaiDshSubagentDetail = {
    readTask: async (taskId: string) => {
      const t = await bridge.readDshTask(taskId)
      if (!t) return null
      // 截断 prompt 到 8K 防 LLM 反向读取时 token 爆;result 不截(通常小)
      return {
        taskId: t.taskId,
        sessionId: t.sessionId,
        ...(t.parentSessionId ? { parentSessionId: t.parentSessionId } : {}),
        status: t.status,
        prompt: t.prompt.length > 8192 ? t.prompt.slice(0, 8192) + '\n\n[...truncated...]' : t.prompt,
        startedAt: t.startedAt,
        ...(t.finishedAt !== undefined ? { finishedAt: t.finishedAt } : {}),
        ...(t.result !== undefined ? { result: t.result } : {}),
        ...(t.error !== undefined ? { error: t.error } : {}),
        ...(t.toolCalls && t.toolCalls.length > 0 ? { toolCalls: t.toolCalls } : {}),
      }
    },
  }

  let startedAt = Date.now()
  let totalTurns = 0
  let totalToolCalls = 0
  let totalApiRequests = 0
  let activeSessions = 0
  let stopped = false

  const askHandlers = new Set<(req: AskRequest) => Promise<AskResponse>>()
  const approveHandlers = new Set<(req: ApproveRequest) => Promise<ApproveResponse>>()
  const stateSubscribers = new Set<(e: StateChangeEvent) => void>()

  // 简单 metrics
  const metrics = (): KernelMetrics => ({
    activeSessions,
    totalTurns,
    totalToolCalls,
    totalApiRequests,
    startedAt,
  })

  const adapter: KernelAdapter = {
    kernel: DSH_KERNEL,

    async start() {
      startedAt = Date.now()
    },

    async shutdown() {
      if (stopped) return
      stopped = true

      // 1. 拒绝新请求 — stopped flag
      // 2. flush 当前 turn — handle.shutdown 内部执行
      // 3. dispose Cordis ctx — handle.shutdown 内部执行
      try {
        await handle.shutdown()
      } catch (err) {
        console.warn('[dsh-adapter] handle.shutdown failed:', err)
      }

      // dsh-020: 清 module-level ctx,避免 shutdown 后路由仍指向已
      // dispose 的 ctx(read 会拿到 stale service,抛 'ctx disposed')。
      if (activeDshContext === handle.ctx) {
        activeDshContext = null
      }

      // 4. 清 globalThis 桥
      clearZaiGlobalBridges()

      // 5. dsh-016:拆 dsh-bridge bridges(slash/plugins/tools/interaction)
      try { slashDisposer?.() } catch (err) { console.warn('[dsh-adapter] slash dispose failed:', err) }
      try { pluginDisposer?.() } catch (err) { console.warn('[dsh-adapter] plugin dispose failed:', err) }
      try { toolsDisposer?.() } catch (err) { console.warn('[dsh-adapter] tools dispose failed:', err) }
      try { interactionDisposer?.() } catch (err) { console.warn('[dsh-adapter] interaction dispose failed:', err) }
      try { projectionDisposer?.() } catch (err) { console.warn('[dsh-adapter] projection dispose failed:', err) }
    },

    async createSession(opts) {
      if (stopped) throw new Error('[dsh-adapter] shutdown, refusing new session')
      const sessionId = opts.sessionId ?? `sess-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
      activeSessions++
      // dsh-020 / transcript 恢复修复:之前 createSession 是 stub,只生成
      // sessionId,没有真的在 dsh ctx 里建立 agent。导致 dsh-side agent
      // 第一次 followup 时 `agents.create` 跑全量初始化(plugin 装载 +
      // session/created 事件 + agent loop 启动),首 token 延迟高且
      // 中间出错概率上升。
      //
      // 现在调 `agents.create({ sessionId, meta: { cwd } })` 提前把 agent
      // 装载好(后续 `run()` 直接 `agents.get()` 取到,免去 whenIdle 等待);
      // 若 dsh-side 抛错(sessions.create 已存在等情况),降级返回 token,
      // 让后续 runOnce 处理 — 与旧行为兼容。
      try {
        const agents = handle.ctx.get('agents') as {
          create?: (opts: {
            sessionId: { toString(): string } & string
            meta?: { cwd?: string }
          }) => Promise<unknown>
        } | undefined
        if (agents?.create) {
          await agents.create({
            sessionId: sessionId as unknown as { toString(): string } & string,
            meta: { cwd: opts.cwd },
          })
        }
      } catch (err) {
        // 创建失败不阻断 — 用户拿到的 sessionId 仍然有效,后续 runOnce
        // 内部会重试 agents.create()。常见失败原因:sessionId 已存在
        // (runOnce 先 get 找不到再 create 的两阶段防护已足够,但在两个
        // 并发 prompt 同一 sid 时会失败 — 让 dsh 抛错比 zai 重复创建安全)。
        if (process.env.ZAI_DEBUG === '1') {
          console.warn(`[dsh-adapter] createSession(${sessionId}) pre-create failed:`, err)
        }
      }
      return toAgentSession(sessionId, opts.cwd)
    },

    async resumeSession(opts) {
      if (stopped) throw new Error('[dsh-adapter] shutdown, refusing resume')
      activeSessions++
      // dsh-020 / transcript 恢复修复:resume 时尝试 `agents.resume(...)`
      // 从持久化恢复 session + agent —— 用户重启 zai 后点 sidebar 的
      // 历史会话,立即触发"恢复"。失败(ENOENT / 文件损坏)降级返回
      // token,后续 runOnce 会从 disk 重新加载。
      //
      // 注意:不强制成功 — 旧的 dsh session(没存到 ctx 但磁盘上有)
      // 也能正常 resume,只需 runOnce 阶段再次尝试。
      try {
        const agents = handle.ctx.get('agents') as {
          resume?: (opts: { resumeSessionId: string }) => Promise<unknown>
          get?: (id: unknown) => unknown
        } | undefined
        // 优先复用 ctx 里已存在的 agent(同进程多 turn 续传)。
        if (agents?.get?.(opts.sessionId)) {
          return toAgentSession(opts.sessionId, opts.cwd)
        }
        if (agents?.resume) {
          await agents.resume({ resumeSessionId: opts.sessionId })
          return toAgentSession(opts.sessionId, opts.cwd)
        }
      } catch (err) {
        if (process.env.ZAI_DEBUG === '1') {
          console.warn(`[dsh-adapter] resumeSession(${opts.sessionId}) pre-resume failed:`, err)
        }
      }
      return toAgentSession(opts.sessionId, opts.cwd)
    },

    async listSessions(opts): Promise<SessionMeta[]> {
      // dsh-020 / transcript 恢复修复:之前 listSessions 只读 dsh 磁盘目录
      // 拿 SessionHeader,看不到 zai-side meta(model/title/mainAgent 等)。
      // 现在通过 DshTranscriptAdapter 拿完整 meta — 与 sidebar 期望对齐
      // (picker 选中行的 model 状态 / title 摘要都从这拿)。
      const { DshTranscriptAdapter } = await import('@zn-ai/dsh-bridge')
      const adapter = new DshTranscriptAdapter(handle.ctx, cfg.dataDir)
      const metas = await adapter.list({ cwd: opts.cwd })
      return metas.map((m) => ({
        sessionId: m.sessionId,
        title: m.title || m.sessionId,
        cwd: m.cwd,
        createdAt: m.createdAt,
        firstSeq: 0,
        ...(m.model ? { model: m.model } : {}),
      }))
    },

    async deleteSession(opts) {
      // dsh-020 / transcript 恢复修复:之前 deleteSession 是 no-op,sidebar
      // 删除会话只清掉了前端 store,后端 dsh-sessions/<sid>/ 目录 + zai
      // meta 一直留着,磁盘持续泄漏。现在调 DshTranscriptAdapter.remove
      // 同时删 dsh session 目录 + zai meta 文件,与 GET list 互相对齐。
      if (stopped) throw new Error('[dsh-adapter] shutdown, refusing delete')
      try {
        const { DshTranscriptAdapter } = await import('@zn-ai/dsh-bridge')
        const adapter = new DshTranscriptAdapter(handle.ctx, cfg.dataDir)
        await adapter.remove(opts.sessionId, { cwd: opts.cwd })
      } catch (err) {
        console.warn(`[dsh-adapter] deleteSession(${opts.sessionId}) failed:`, err)
        throw err
      }
    },

    async *run(opts): AsyncIterable<ServerEvent> {
      if (stopped) throw new Error('[dsh-adapter] refusing run after shutdown')
      totalTurns++

      // dsh-016 修复:把当前 sessionId 写入 zai 单例 + globalThis 桥,
      // 让 bashBackgroundTracker.register / bashNotifier.handle 知道
      // 把 bash_task.changed 事件挂到正确的 session 下,UI TaskDock
      // 才能显示任务(opencc 模式 vendor 内部自动写,dsh 模式没人写)。
      setCurrentSessionId(opts.session.sessionId)

      // Phase 3 P1: dsh factory 现在完整支持 OpenccContentBlock[] 多模态。
      // OpenccContentBlock 形态:
      //   - text: { type: 'text', text: string }
      //   - image: { type: 'image', source: { type: 'base64', media_type, data } }
      //
      // dsh-side 的 ImageBlock 用的是 dsh-attachment 引用(不是 raw base64):
      //   ImageBlock { type: 'image', attachment: ImageAttachmentRef }
      // 所以 image block 必须先存到 dsh-attachment service 拿 ref,再传
      // ref 过去。zai 进程里 `handle.ctx.attachments` 就是 dsh 启动时
      // 注入的 LocalAttachmentStore。
      let promptText = ''
      const contentBlocks: Array<{ type: string; [k: string]: unknown }> = []
      if (typeof opts.prompt === 'string') {
        promptText = opts.prompt
      } else if (Array.isArray(opts.prompt)) {
        for (const block of opts.prompt) {
          if (!block || typeof block !== 'object') continue
          const b = block as { type?: unknown; text?: unknown; source?: unknown }
          if (b.type === 'text') {
            contentBlocks.push({ type: 'text', text: String(b.text ?? '') })
          } else if (b.type === 'image') {
            // image block → 存到 dsh-attachment store 拿 ref
            const source = b.source as
              | { type?: unknown; media_type?: unknown; data?: unknown }
              | undefined
            if (!source || typeof source.data !== 'string') {
              throw new Error('invalid image block: missing source.data')
            }
            const mediaType = String(source.media_type ?? 'image/png')
            let data = new Uint8Array(Buffer.from(source.data, 'base64'))

            // Phase 3 P1 follow-up: 大图压缩。
            // dsh-attachment-local 默认 maxImageDimension=2000,超过抛
            // `Image exceeds the configured per-side pixel limit`。
            // 用户场景常见上传手机/电脑截图(3072x4096 起),必须压缩。
            // 用 sharp (zai 已有依赖) resize 到 max 2048 保持比例,长边
            // 优先压缩。压缩后保持原 mediaType(PNG → PNG,JPEG → JPEG)。
            // 失败 fallback:原图上报,让 dsh-attachment 走自己的错误路径。
            try {
              const sharp = (await import('sharp')).default
              const image = sharp(Buffer.from(data))
              const meta = await image.metadata()
              // dsh-attachment-local 默认 maxImageDimension=2000(超过抛
              // "Image exceeds the configured per-side pixel limit")。我们
              // 留 1px 余量到 1999,留 sharp 的 fit:'inside' + 等比缩放空间。
              const MAX_DIM = 1999
              if (meta.width && meta.height && (meta.width > MAX_DIM || meta.height > MAX_DIM)) {
                if (process.env.ZAI_DEBUG === '1') {
                  console.log(
                    `[dsh-adapter] resizing ${meta.width}x${meta.height} image to max ${MAX_DIM}`,
                  )
                }
                // 用 .resize 保持原 mediaType,fit:'inside' + withoutEnlargement
                // 保证长边 ≤ MAX_DIM,等比缩放。转回 Buffer 再 new Uint8Array,
                // dsh-attachment 校验用 raw bytes (sha256 + 头部探测)。
                const resized = await image
                  .resize({
                    width: meta.width >= meta.height ? MAX_DIM : undefined,
                    height: meta.height > meta.width ? MAX_DIM : undefined,
                    fit: 'inside',
                    withoutEnlargement: true,
                  })
                  .toBuffer()
                if (process.env.ZAI_DEBUG === '1') {
                  const newMeta = await sharp(resized).metadata()
                  console.log(
                    `[dsh-adapter] resized to ${newMeta.width}x${newMeta.height} (${resized.length} bytes)`,
                  )
                }
                // Buffer.from(buffer) 在 Node.js 类型下让 Uint8Array<ArrayBufferLike>
                // 转成 Uint8Array<ArrayBuffer>(拷贝语义,符合 dsh-attachment
                // saveImage 的 input.data: Uint8Array 约束)。
                data = new Uint8Array(Buffer.from(resized))
              } else if (process.env.ZAI_DEBUG === '1') {
                console.log(
                  `[dsh-adapter] image ${meta.width}x${meta.height} under limit, no resize`,
                )
              }
            } catch (resizeErr) {
              if (process.env.ZAI_DEBUG === '1') {
                console.warn('[dsh-adapter] sharp resize failed, using original:', resizeErr)
              }
              // 继续用原图,让 dsh-attachment 校验失败时给清晰错误
            }

            // attachments store 在 cordis ctx 上 — 直接 ctx.plugin 已经
            // 注册过 LocalAttachmentStore 到 ctx.attachments
            const store = handle.ctx.get('attachments') as
              | {
                  saveImage: (input: {
                    data: Uint8Array
                    mediaType: string
                  }) => Promise<{
                    attachmentId: string
                    mediaType: string
                    bytes: number
                    width: number
                    height: number
                  }>
                }
              | undefined
            if (!store) {
              throw new Error(
                '[dsh-adapter] attachment store unavailable — dsh-attachment-local 未装载?',
              )
            }
            const ref = await store.saveImage({ data, mediaType })
            contentBlocks.push({ type: 'image', attachment: ref })
          } else {
            // 未知 block 类型 — 透传,让 dsh 端决定怎么处理
            contentBlocks.push(b as { type: string; [k: string]: unknown })
          }
        }
      }

      // 其它扩展 opts 字段（model / permissionMode / providerOverride / providerId /
      // mainAgent / abortSignal）由 dsh session-level 配置接管,本 turn 内暂不消费:
      // dsh AgentOptions 仅支持 provider + model,model 若与 opts.model 不同,本
      // 次仍用 session 启动时绑定的 model（详见 createDshRuntime defaultModel）;
      // dsh 0.1.0-rc.7 不支持 AbortSignal,abort 走 cancel seam。
      void opts.model
      void opts.permissionMode
      void opts.providerOverride
      void opts.providerId
      void opts.mainAgent
      void opts.abortSignal

      // Phase 3 P1: runOnce 现在边收事件边 yield(看 run.ts)。
      // 这里 for await 直接拿到每个 token 翻译后的 runtime.delta,前端
      // SSE 立刻收到,实现真正的流式输出。
      //
      // dsh usage 提取:每个 step 结束的 `assistant/chunk(usage)` 与
      // 结构化收尾的 `assistant/message.usage` 都携带 provider 报的
      // TokenUsage(inputTokens / outputTokens / cacheReadTokens /
      // cacheWriteTokens)。把它们转成 opencc 风格的
      // `{ input, cache_creation, cache_read, output }` 写到 globalThis
      // 单 slot (`setLastContextUsage` 来自 opencc vendor 的
      // sessionApiCounter.ts),然后 `getLastContextTokens()` 读出,
      // 注入到 translateSessionEvent 的 ctx.lastContextTokens ——
      // turn/end(completed) case 会把它附给 runtime.done ServerEvent,
      // zai routes/agent.ts:921-930 命中后 emit session/projection 帧,
      // 前端 useProjection(sid, 'context.tokens') 实时显示当前上下文大小。
      //
      // 注:`assistant/message` 整体仍走 translateSessionEvent 的
      // "ignorable,文本由 chunk 流累积" 路径(避免重复气泡),但 usage
      // 字段是独立数据,先在这里抽取一次,再交给 translate。
      for await (const dshEvent of bridge.runOnce({
        ctx: handle.ctx,
        sessionId: opts.session.sessionId,
        cwd: opts.session.cwd,
        prompt: promptText,
        contentBlocks: contentBlocks.length > 0 ? contentBlocks : undefined,
        // dsh AgentOptions 仅支持 provider + model — 必须显式传,否则 dsh
        // 在 agent/request waterfall 找不到 provider/model,抛
        // "has no provider/model" 错误(B1a T1.4 收口)。
        provider: anthropicProfile.name,
        // models 形态: string | DshModelEntry — 只接受 string id。
        // defaultModel 也是 string,所以取首个 entry 的 id。
        model:
          defaultModel
          || (typeof anthropicProfile.models[0] === 'string'
            ? anthropicProfile.models[0]
            : anthropicProfile.models[0]?.id),
      })) {
        // (1) 抽取 dsh TokenUsage → opencc-style globalThis slot
        const usage = extractDshUsage(dshEvent)
        if (usage !== null) {
          setLastContextUsage(usage)
        }

        // (2) 翻译 SessionEvent → zai ServerEvent(turn/end 会读
        //     globalThis slot 把 contextTokens 附给 runtime.done)
        const translated = bridge.translateSessionEvent(dshEvent, {
          sessionId: opts.session.sessionId,
          turnIndex: 0,
          seqBase: 0,
          lastContextTokens: getLastContextTokens() ?? undefined,
        })
        if (translated !== null) {
          yield translated as ServerEvent
        }
      }
    },

    async abort(opts) {
      if (stopped) throw new Error('[dsh-adapter] shutdown, refusing abort')
      const agents = handle.ctx.get('agents') as {
        get?(id: unknown): { cancel?: (cause: { kind: 'user' | 'parent' | 'hook' | 'disposed' }, opts?: { keepInbox?: boolean }) => void } | undefined
      } | undefined
      const agent = agents?.get?.(opts.session.sessionId)
      agent?.cancel?.({ kind: 'user' })
    },

    async patchTranscript(opts) {
      if (stopped) throw new Error('[dsh-adapter] shutdown, refusing patchTranscript')
      const agents = handle.ctx.get('agents') as {
        get?(id: unknown): { session?: { append: (type: string, data: unknown) => unknown } } | undefined
      } | undefined
      const agent = agents?.get?.(opts.session.sessionId)
      if (!agent?.session) {
        console.warn(`[dsh-adapter] patchTranscript: agent ${opts.session.sessionId} not found`)
        return
      }
      // 逐条 append — Session.append 接 (type, data)；TranscriptPatch.kind 映射到 type。
      for (const entry of opts.entries) {
        agent.session.append(entry.kind, entry.payload)
      }
    },

    async *readTranscript(opts): AsyncIterable<TranscriptEntry> {
      if (stopped) throw new Error('[dsh-adapter] shutdown, refusing readTranscript')
      const persistence = handle.ctx.get('sessionPersistence') as {
        loadStored?: (id: unknown, signal?: AbortSignal) => Promise<{ events?: unknown[] } | undefined>
      } | undefined
      const { SessionId } = await import('@zn-ai/dsh-bridge')
      if (!persistence?.loadStored) {
        console.warn('[dsh-adapter] readTranscript: sessionPersistence unavailable')
        return
      }
      const loaded = await persistence.loadStored(SessionId(opts.session.sessionId))
      const rawEvents = loaded?.events ?? []
      let seq = opts.sinceSeq ?? 0
      for (const e of rawEvents as Array<{ type?: string; ts?: number; data?: unknown }>) {
        yield {
          seq: seq++,
          kind: (e.type ?? 'user') as TranscriptEntry['kind'],
          ts: e.ts ?? Date.now(),
          payload: (e.data ?? {}) as Record<string, unknown>,
        }
      }
    },

    onAsk(cb) {
      askHandlers.add(cb)
      return () => { askHandlers.delete(cb) }
    },
    onApprove(cb) {
      approveHandlers.add(cb)
      return () => { approveHandlers.delete(cb) }
    },

    subscribeState(cb) {
      stateSubscribers.add(cb)
      return () => { stateSubscribers.delete(cb) }
    },

    async enqueue(opts) {
      if (stopped) throw new Error('[dsh-adapter] shutdown, refusing enqueue')
      const agents = handle.ctx.get('agents') as {
        get?(id: unknown): { followup?: (msg: unknown) => void } | undefined
      } | undefined
      const agent = agents?.get?.(opts.session.sessionId)
      if (!agent?.followup) {
        console.warn(`[dsh-adapter] enqueue: agent ${opts.session.sessionId} not found`)
        return
      }
      const { createUserMessage } = await import('@zn-ai/dsh-bridge')
      agent.followup(
        createUserMessage({
          content: [{ type: 'text', text: opts.payload.text }],
          source: { kind: 'user' },
        }),
      )
    },

    metrics,
  }

  return adapter
}

// ────────────────────────────────────────────────────────────────────────
// dsh usage 提取 helper
// ────────────────────────────────────────────────────────────────────────

/**
 * dsh SessionEvent 中携带的 TokenUsage 形态来源有两处:
 *
 *   1. `assistant/chunk` — 每个 LLM step 结束时 `chunk.type === 'usage'`
 *      (由 `dsh-llm-pi-ai` 的 `toStreamChunks` 在 `done` / `error` 事件
 *      时 yield 出来),内容是 provider 报的累计 step usage。dsh-token-meter
 *      内部也是 last-wins 替换,所以同一 `(turn, step)` 多次 sample 不
 *      重复累加。
 *
 *   2. `assistant/message.usage` — 结构化收尾事件,与 message 同 seq,
 *      携带 provider 报的同 step 最终 usage。`usage` 字段在 adapter
 *      没上报时为 undefined。
 *
 * 两处的 `TokenUsage` 形态:
 *   { inputTokens, outputTokens, cacheReadTokens?, cacheWriteTokens? }
 *
 * 翻译成 opencc vendor `sessionApiCounter.ts` 的
 * `setLastContextUsage` 入参 `{ input, cache_creation, cache_read, output }`,
 * 让 zai 端的 `getLastContextTokens()` / `getContextTokensForSession()`
 * 能拿到 — 与 opencc 模式完全对称,无需新增 globalThis 桥。
 */
type DshSessionEventForUsage = {
  type: string
  data: unknown
}

/**
 * 公开导出仅供 `extractDshUsage.test.ts` 单测使用(测试 seam)。
 * zai 服务层不依赖此 helper,只 dsh factory 内部 `run()` 调用。
 */
export function extractDshUsage(event: DshSessionEventForUsage): {
  input: number
  cache_creation: number
  cache_read: number
  output: number
} | null {
  const data = event.data as
    | {
        chunk?: { type?: string; usage?: { inputTokens?: number; outputTokens?: number; cacheReadTokens?: number; cacheWriteTokens?: number } }
        usage?: { inputTokens?: number; outputTokens?: number; cacheReadTokens?: number; cacheWriteTokens?: number }
      }
    | undefined
  if (!data) return null

  let u: { inputTokens?: number; outputTokens?: number; cacheReadTokens?: number; cacheWriteTokens?: number } | undefined

  if (event.type === 'assistant/chunk') {
    const chunk = data.chunk
    if (chunk?.type === 'usage' && chunk.usage) u = chunk.usage
  } else if (event.type === 'assistant/message') {
    if (data.usage) u = data.usage
  }

  if (!u) return null
  return {
    input: u.inputTokens ?? 0,
    cache_creation: u.cacheWriteTokens ?? 0,
    cache_read: u.cacheReadTokens ?? 0,
    output: u.outputTokens ?? 0,
  }
}