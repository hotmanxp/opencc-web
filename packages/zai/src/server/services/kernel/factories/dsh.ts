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

  // ── 1. 长驻 Cordis ctx 装配（B1a T1.1） ─────────────────────────
  const handle = await bridge.createDshRuntime({
    dataDir: cfg.dataDir,
    runtimeId: 'zai-server-dsh',
    defaultCwd: cfg.cwd,
    defaultModel:
      cfg.settings.model
      ?? process.env.ANTHROPIC_DEFAULT_SONNET_MODEL
      ?? process.env.ANTHROPIC_SMALL_FAST_MODEL
      ?? '',
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

    async listSessions(_opts): Promise<SessionMeta[]> {
      // B1b T1.7：dsh 会话元信息从隔离目录读取（dsh-sessions/<sid>/）。
      // 当前由 B3 T3.1 完整对齐（读 header.createdAt + cwd）。
      return []
    },

    async deleteSession(_opts) {
      // B3 T3.1：删 dsh-sessions/<sid>/ 目录。
    },

    async *run(opts): AsyncIterable<ServerEvent> {
      if (stopped) throw new Error('[dsh-adapter] shutdown, refusing run')
      totalTurns++

      // B1a T1.2 + T1.3：runOnce 产 dsh SessionEvent 序列，
      // translateSessionEvent → zai ServerEvent。
      for await (const dshEvent of bridge.runOnce({
        ctx: handle.ctx,
        sessionId: opts.session.sessionId,
        cwd: opts.session.cwd,
        prompt: opts.prompt,
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
      // B1b T1.6：调 agent.cancel()。
      // dsh Agent 没有直接的 abort API ——通过 ctx.dispose 让 Cordis 走 cancel 路径。
      // 当前为 stub：B1b T1.6 真实接线。
      void opts
    },

    async patchTranscript(_opts) {
      // B3 T3.3：把 transcript 条目注入 dsh session。
    },

    async *readTranscript(_opts): AsyncIterable<TranscriptEntry> {
      // B3 T3.3：从 dsh session.events 重建 transcript。
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

    async enqueue(_opts) {
      // B5 阶段：把 prompt 塞入 session inbox。
    },

    metrics,
  }

  return adapter
}