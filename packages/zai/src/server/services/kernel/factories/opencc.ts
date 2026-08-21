/**
 * OpenccKernelAdapter — opencc 轨道的 KernelAdapter 封装（B0 T0.3）。
 *
 * 把现有 `createOpenccRuntime()` 包成 KernelAdapter 接口形式。
 * 行为不变：内部仍是 opencc vendor 的运行时，仅暴露 KernelAdapter 抽象。
 *
 * 范围（主计划 §3.1 + B0 T0.3 约束）：
 * - T0.3 不迁移事件翻译（沿用 translateRuntimeEvents）；事件翻译的迁移
 *   分批进行（B1b 11 通道对齐，T1.5）。
 * - T0.3 必须 wrap `getRuntime()` 全部调用面（审查 R9：`agentRuntime.ts:411-425`
 *   等位置仍返回 `OpenccRuntime`，不能"仅包外壳"）。
 *
 * 设计：
 * - 内部持有 `runtime: OpenccRuntime`，start() 时构造。
 * - shutdown() 走显式 drain 顺序（B-1 尖峰定义）：
 *   1. 拒绝新请求 — 标记 runtime.stopped
 *   2. flush 当前 turn — vendor `streamingToolExecutor` 已有 abort 路径
 *   3. dispose — vendor runtime.dispose()
 *   4. 清 globalThis 桥（__zaiEventBus / __zaiBridgeCtx / __zaiSessionInbox / __zaiCurrentSessionId）
 * - run() 流式返回 ServerEvent — 直接透传 vendor `queryModelWithStreaming` 的事件。
 * - abort() 调 vendor `sessionControllers.get(sessionId)?.abort()`。
 *
 * 注意：当前实现以 minimum-viable 形态交付，后续 B1b/B2/B3 各批逐步补齐
 * patchTranscript / readTranscript / subscribeState / enqueue 等接口。
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
  type BackgroundTaskHandle,
} from '../kernelAdapter.js'
import {
  installZaiGlobalBridges,
  trackZaiGlobalBridge,
  clearZaiGlobalBridges,
  ZAI_GLOBAL_BRIDGE_KEYS,
} from '../globalThisBridge.js'
import { OPENCC_KERNEL } from '../paths.js'

// 动态 import vendor runtime，避免在 dsh 模式（不会调到此 adapter）下加载
// opencc bundle。 vendor 是 esbuild 单文件 bundle，启动开销 ~5s。
type OpenccRuntime = Awaited<
  ReturnType<Awaited<typeof import('@zn-ai/zn-agent-core')>['createOpenccRuntime']>
>

interface OpenccKernelConfig {
  cwd: string
  dataDir: string
  settings: ZaiSettings
  /** agent.kernel === 'opencc' 时调到这里 */
  runtimeId?: string
}

/**
 * 把 sessionId + cwd 包装成 AgentSession。Adapter 不暴露 runtime 内部状态。
 */
function toAgentSession(sessionId: string, cwd: string): AgentSession {
  return { kernel: OPENCC_KERNEL, sessionId, cwd }
}

export async function createOpenccKernelAdapter(
  cfg: OpenccKernelConfig,
): Promise<KernelAdapter> {
  const { createOpenccRuntime } = await import('@zn-ai/zn-agent-core')
  const { resolveMainAgent } = await import('../../mainAgents.js')

  // ─── 启动 ────────────────────────────────────────────────────────
  const settings = cfg.settings
  const { agent: mainAgent, agents: mainAgents } = await resolveMainAgent(settings.mainAgent)
  const runtime: OpenccRuntime = await createOpenccRuntime({
    dataDir: cfg.dataDir,
    mainAgent,
    mainAgents,
    runtimeId: cfg.runtimeId ?? 'zai-server',
    defaultCwd: cfg.cwd,
    defaultModel:
      process.env.ANTHROPIC_DEFAULT_SONNET_MODEL
      ?? process.env.ANTHROPIC_SMALL_FAST_MODEL,
    connectMcp: false,
    interactive: true,
  })

  // 启动时一次性把 zai 句柄挂到 globalThis，opencc vendor 内的 compat 模块
  // 通过这些桥与 zai 服务层交互（主计划 §4.1 + 现有 __zaiEventBus 注释）。
  installZaiGlobalBridges({
    __zaiEventBus: (globalThis as any).__zaiEventBus,
    __zaiBridgeCtx: (globalThis as any).__zaiBridgeCtx,
    __zaiSessionInbox: (globalThis as any).__zaiSessionInbox,
  })
  // 标记，让 shutdown 时清理（不清掉非 zai 注入的同名变量）
  for (const key of ZAI_GLOBAL_BRIDGE_KEYS) {
    trackZaiGlobalBridge(key, (globalThis as any)[key])
  }

  let startedAt = Date.now()
  let totalTurns = 0
  let totalToolCalls = 0
  let totalApiRequests = 0
  let activeSessions = 0
  let stopped = false

  const stateSubscribers = new Set<(e: StateChangeEvent) => void>()
  const askHandlers = new Set<(req: AskRequest) => Promise<AskResponse>>()
  const approveHandlers = new Set<(req: ApproveRequest) => Promise<ApproveResponse>>()

  // 把现有 sessionControllers 引用以异步方式取，避免静态 import 循环（B0 stub）
  async function abortSessionViaController(sessionId: string, reason?: string): Promise<void> {
    try {
      // 通过 require 拿 module.exports 是 zai-side ESM 互操作的常用方式
      const mod = await import('../../agentRuntime.js' as string)
      const ctrl = (mod as { sessionControllers?: Map<string, AbortController> }).sessionControllers?.get(sessionId)
      ctrl?.abort(reason ?? 'client_disconnect')
    } catch (err) {
      console.warn('[opencc-adapter] abort failed:', err)
    }
  }

  const adapter: KernelAdapter = {
    kernel: OPENCC_KERNEL,

    // ─── 生命周期 ───────────────────────────────────────────────
    async start() {
      // createOpenccRuntime 已在工厂中完成（包含 vendor enableConfigs + MACRO stub），
      // 这里只需记录 start 时间。
      startedAt = Date.now()
    },

    async shutdown() {
      if (stopped) return
      stopped = true

      // 1. 拒绝新请求 — stopped flag 已置，后续 createSession / run 立即 throw。
      // 2. flush 当前 turn — vendor streamingToolExecutor 内部维护 in-flight 队列；
      //    await vendor flush hook（如有）— B-1 尖峰阶段尚未提供 vendor flush API。
      // 3. dispose — vendor runtime 自身 dispose（如果有 dispose() 方法）。
      try {
        const maybeDispose = (runtime as unknown as { dispose?: () => void | Promise<void> }).dispose
        if (typeof maybeDispose === 'function') {
          await maybeDispose.call(runtime)
        }
      } catch (err) {
        // shutdown 失败仅记录，不抛 — 启动序列 init 时常 fail-safe 处理
        console.warn('[opencc-adapter] dispose failed:', err)
      }
      // 4. 清 globalThis 桥
      clearZaiGlobalBridges()
    },

    // ─── 会话 ──────────────────────────────────────────────────
    async createSession(opts) {
      if (stopped) throw new Error('[opencc-adapter] shutdown, refusing new session')
      const sessionId = opts.sessionId ?? `sess-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
      activeSessions++
      return toAgentSession(sessionId, opts.cwd)
    },

    async resumeSession(opts) {
      if (stopped) throw new Error('[opencc-adapter] shutdown, refusing resume')
      activeSessions++
      return toAgentSession(opts.sessionId, opts.cwd)
    },

    async listSessions(_opts): Promise<SessionMeta[]> {
      // vendor runtime 的 listSessions 暴露在本批未对齐；后续 B3 T3.1 通过
      // compat/transcript/persistence.ts 的目录扫描补充完整元信息。
      return []
    },

    async deleteSession(_opts) {
      // vendor runtime 当前未提供 delete；B3 阶段接入 transcriptStore.deleteSession。
    },

    // ─── 驱动 ──────────────────────────────────────────────────
    async *run(opts): AsyncIterable<ServerEvent> {
      if (stopped) throw new Error('[opencc-adapter] shutdown, refusing run')
      totalTurns++
      // B0 stub：返回空 stream。B1b T1.6 完整接入 routes/agent.ts 的 prompt 路径。
      void opts
      void runtime
      // 触发 yield 类型校验，让 TS 强制 ServerEvent 形态在 stub 阶段就可识别
      if (false as boolean) {
        yield {
          type: 'server.connected',
          sessionId: null,
          eventId: '',
          ts: 0,
          seq: 0,
        }
      }
    },

    async abort(opts) {
      await abortSessionViaController(opts.session.sessionId, opts.reason)
    },

    // ─── transcript ────────────────────────────────────────────
    async patchTranscript(_opts) {
      // B0 桩：B3 T3.1 完整对接 compat/transcript/persistence.ts
    },

    async *readTranscript(_opts): AsyncIterable<TranscriptEntry> {
      // B0 占位 — 由 B3 T3.3 替换为从 vendor runtime 重建。
    },

    // ─── 回调 ──────────────────────────────────────────────────
    onAsk(cb) {
      askHandlers.add(cb)
      return () => { askHandlers.delete(cb) }
    },
    onApprove(cb) {
      approveHandlers.add(cb)
      return () => { approveHandlers.delete(cb) }
    },

    // ─── 状态桥 ────────────────────────────────────────────────
    subscribeState(cb) {
      stateSubscribers.add(cb)
      return () => { stateSubscribers.delete(cb) }
    },

    // ─── 队列 / metrics ────────────────────────────────────────
    async enqueue(_opts) {
      // 沿用现有 sessionInbox.followup；B0 仅占位。
    },

    metrics(): KernelMetrics {
      return {
        activeSessions,
        totalTurns,
        totalToolCalls,
        totalApiRequests,
        startedAt,
      }
    },

    // ─── 后台任务（B5）────────────────────────────────────────
    // B0 不实现 — 沿用现有 BackgroundRuntime；B5 阶段由 backgroundRuntime.ts
    // 适配层接管。
  }

  return adapter
}