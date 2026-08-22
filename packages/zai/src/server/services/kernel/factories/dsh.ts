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

  // ── 2. globalThis 桥安装（B0 T0.8） ──────────────────────────────
  installZaiGlobalBridges({
    __zaiEventBus: (globalThis as any).__zaiEventBus,
    __zaiBridgeCtx: (globalThis as any).__zaiBridgeCtx,
    __zaiSessionInbox: (globalThis as any).__zaiSessionInbox,
  })
  for (const key of ZAI_GLOBAL_BRIDGE_KEYS) {
    trackZaiGlobalBridge(key, (globalThis as any)[key])
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

      // B1a T1.2 + T1.3：runOnce 产 dsh SessionEvent 序列，
      // translateSessionEvent → zai ServerEvent。
      //
      // dsh 0.1.0-rc.7 runOnce 仅接受 string prompt。多模态（readonly unknown[]）
      // 走 text 提取：dsh-side 多模态由后续版本支持，目前 zai front-end 在 dsh 模式下
      // 不传 image block，仅以文本 prompt 入栈，故 fallback 仅触发于编程错误。
      const promptText =
        typeof opts.prompt === 'string'
          ? opts.prompt
          : (() => {
              const first = opts.prompt[0]
              return typeof first === 'object' && first !== null && 'text' in first
                ? String((first as { text?: unknown }).text ?? '')
                : ''
            })()

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

      for await (const dshEvent of bridge.runOnce({
        ctx: handle.ctx,
        sessionId: opts.session.sessionId,
        cwd: opts.session.cwd,
        prompt: promptText,
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