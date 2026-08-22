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
  stateChangeBus,
  type TaskItem,
} from '@zn-ai/zn-agent-core'
import {
  getAskRegistry,
  getApproveRegistry,
  getCurrentSessionId,
  setCurrentSessionId,
} from '../../agentRuntime.js'

interface DshKernelConfig {
  cwd: string
  dataDir: string
  settings: ZaiSettings
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
  const anthropicProfile: import('@zn-ai/dsh-bridge').DshProviderProfile = {
    name: 'anthropic',
    displayName: 'Anthropic (Anthropic-compatible)',
    baseURL:
      process.env.ANTHROPIC_BASE_URL
      ?? 'https://api.anthropic.com',
    apiKeyEnv: anthropicApiKeyEnv,
    models: defaultModel ? [defaultModel] : ['claude-3-5-sonnet-latest'],
  }
  const handle = await bridge.createDshRuntime({
    dataDir: cfg.dataDir,
    runtimeId: 'zai-server-dsh',
    defaultCwd: cfg.cwd,
    defaultModel,
    providers: [anthropicProfile],
  })
  await handle.start()

  // ── 1.5 dsh-bridge bridges（B2/B4/B5/B7 真实化 — dsh-016） ───────
  // 装载 zai 增强工具（bash/fs/ripgrep/mcp/skill）+ 把后台 bash 任务接到
  // zai `bashBackgroundTracker`（让 UI TaskDock 可见）+ 装审批/AskUser 桥
  // + slash 命令桥 + 插件 hooks/commands。
  let toolsDisposer: (() => void) | null = null
  let interactionDisposer: (() => void) | null = null
  let slashDisposer: (() => void) | null = null
  let pluginDisposer: (() => void) | null = null

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

      // 4. 清 globalThis 桥
      clearZaiGlobalBridges()

      // 5. dsh-016:拆 dsh-bridge bridges(slash/plugins/tools/interaction)
      try { slashDisposer?.() } catch (err) { console.warn('[dsh-adapter] slash dispose failed:', err) }
      try { pluginDisposer?.() } catch (err) { console.warn('[dsh-adapter] plugin dispose failed:', err) }
      try { toolsDisposer?.() } catch (err) { console.warn('[dsh-adapter] tools dispose failed:', err) }
      try { interactionDisposer?.() } catch (err) { console.warn('[dsh-adapter] interaction dispose failed:', err) }
    },

    async createSession(opts) {
      if (stopped) throw new Error('[dsh-adapter] shutdown, refusing new session')
      const sessionId = opts.sessionId ?? `sess-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
      activeSessions++
      return toAgentSession(sessionId, opts.cwd)
    },

    async resumeSession(opts) {
      if (stopped) throw new Error('[dsh-adapter] shutdown, refusing resume')
      activeSessions++
      return toAgentSession(opts.sessionId, opts.cwd)
    },

    async listSessions(opts): Promise<SessionMeta[]> {
      // B3 T3.1（部分实现）：从隔离目录扫描读取会话列表
      const { listDshSessions } = await import('@zn-ai/dsh-bridge')
      const metas = await listDshSessions(cfg.dataDir, opts.cwd)
      return metas.map((m) => ({
        sessionId: m.sessionId,
        title: m.sessionId, // title 由 B3 T3.2 完整对齐（读 SessionHeader + 首条 prompt 摘要）
        cwd: m.cwd,
        createdAt: m.createdAt,
        firstSeq: 0,
      }))
    },

    async deleteSession(_opts) {
      // B3 T3.1：删 dsh-sessions/<sid>/ 目录。当前 stub — 由 B3 deep-dive 实现。
      void _opts
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
      // 之前版本只取首个 block 的 text 字段,丢弃图片 — 导致 dsh 模式
      // 图片 prompt 400。修复:把整个 block 数组透传给 runOnce。
      // OpenccContentBlock 形态: { type: 'text' | 'image', text?, source? }
      //   - text: { type: 'text', text: string }
      //   - image: { type: 'image', source: { type: 'base64', media_type, data } }
      //
      // runOnce 内部把它们直接拼到 createUserMessage 的 content 数组,
      // 由 dsh-session 按 Anthropic protocol 序列化发给模型。
      let promptText = ''
      const contentBlocks: Array<{ type: string; [k: string]: unknown }> = []
      if (typeof opts.prompt === 'string') {
        promptText = opts.prompt
      } else if (Array.isArray(opts.prompt)) {
        for (const block of opts.prompt) {
          if (!block || typeof block !== 'object') continue
          const b = block as { type?: unknown; text?: unknown; source?: unknown }
          if (b.type === 'text') {
            // text 块可以合到 promptText(避免 runOnce 重复拼接)
            // 但为了保持原始顺序,还是放到 contentBlocks
            contentBlocks.push({ type: 'text', text: String(b.text ?? '') })
          } else if (b.type === 'image') {
            contentBlocks.push({ type: 'image', source: b.source })
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
        model: defaultModel || anthropicProfile.models[0],
      })) {
        const translated = bridge.translateSessionEvent(dshEvent, {
          sessionId: opts.session.sessionId,
          turnIndex: 0,
          seqBase: 0,
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