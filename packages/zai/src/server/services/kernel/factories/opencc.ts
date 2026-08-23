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
import { translateRuntimeEvents } from '../../translation.js'

// 动态 import vendor runtime，避免在 dsh 模式（不会调到此 adapter）下加载
// opencc bundle。 vendor 是 esbuild 单文件 bundle，启动开销 ~5s。
type OpenccRuntime = Awaited<
  ReturnType<Awaited<typeof import('@zn-ai/zn-agent-core')>['createOpenccRuntime']>
>

/**
 * Module-level singleton: 最近一次 `createOpenccKernelAdapter` 构造时拿到的
 * OpenccRuntime 实例。zai 服务的 `getRuntime()` accessor 在 opencc 模式下
 * 走这里拿回 OpenccRuntime,以保留 `backgroundRuntime.ts` /
 * `routes/command.ts` / `routes/plugins.ts` 等依赖 vendor-specific 形状的
 * 老调用面（B7 flip-and-cleanup: 关闭 dsh-009/010 同时最小化回归面）。
 *
 * dsh 模式下不设该单例,getRuntime() 抛 "kernel is dsh, use getKernelAdapter()"。
 */
let currentOpenccRuntime: OpenccRuntime | null = null

/** Test seam + agentRuntime.ts initAgentRuntime 反查用。 */
export function getCurrentOpenccRuntime(): OpenccRuntime | null {
  return currentOpenccRuntime
}

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
  const { getTranscriptStore } = await import('../../agentRuntime.js')

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
    connectMcp: true,
    interactive: true,
  })
  // B7 flip-and-cleanup: 暴露给 zai 服务层 `getRuntime()` accessor,
  // 让 backgroundRuntime.ts / routes/command.ts 等 vendor-aware 老调用面
  // 在 opencc 模式下继续走原 OpenccRuntime 形状（dsh 模式下 getRuntime() 抛错）。
  currentOpenccRuntime = runtime

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
      // 5. 清 module-level 单例,避免 getRuntime() 在 adapter.shutdown 后
      // 仍返 stale runtime 引用。
      currentOpenccRuntime = null
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

    async listSessions(opts): Promise<SessionMeta[]> {
      if (stopped) throw new Error('[opencc-adapter] shutdown, refusing list')
      // 走 vendor TranscriptStore.list — 主计划 §3.1 listSessions 能力面对齐
      // 与 routes/agent.ts:1586 同款调用
      const store = getTranscriptStore()
      const entries = await store.list({ cwd: opts.cwd, excludeSubagent: true })
      return entries.map((entry) => ({
        sessionId: entry.sessionId,
        title: entry.title ?? entry.sessionId,
        cwd: opts.cwd,
        createdAt: entry.createdAt ?? 0,
        firstSeq: 0,
      }))
    },

    async deleteSession(opts) {
      if (stopped) throw new Error('[opencc-adapter] shutdown, refusing delete')
      const store = getTranscriptStore()
      await store.remove(opts.sessionId, opts.cwd ? { cwd: opts.cwd } : undefined)
    },

    // ─── 驱动 ──────────────────────────────────────────────────
    async *run(opts): AsyncIterable<ServerEvent> {
      if (stopped) throw new Error('[opencc-adapter] shutdown, refusing run')
      totalTurns++
      // B7 flip-and-cleanup (dsh-010): 真实接线。把 vendor runtime.query() 的
      // vendor-aware 字段（model / permissionMode / providerOverride /
      // providerId / mainAgent / abortSignal）从 adapter opts 透传给底层 OpenccRuntime，
      // 然后经 translateRuntimeEvents 把 vendor 事件翻译成 zai 前端 spec 形态。
      // 翻译层（services/translation.ts）原来嵌在 routes/agent.ts,本 commit 抽出,
      // 让 run() 在 factory 内部闭合,调用方（routes/agent.ts:prompt、
      // bashNotifier.ts）拿到的是已翻译的 ServerEvent 流。
      const vendorStream = runtime.query({
        // OpenccQueryInput.prompt accepts `string | OpenccContentBlockParam[]`.
        // For multimodal input we pass the raw `userContent` block array —
        // createOpenccRuntime-impl submits it directly to the vendor
        // QueryEngine.submitMessage(string | ContentBlockParam[]), which
        // converts image blocks to Anthropic protocol before hitting the
        // API. JSON-encoding here would leak base64 as plain text and the
        // model can't read the image.
        // KernelAdapter.run() opts.prompt 类型为 `string | readonly unknown[]`;
        // vendor 接受 `string | OpenccContentBlockParam[]` (mutable array)。
        // readonly unknown[] → mutable array 的窄化由 opencc factory 内部承担
        // (KernelAdapter interface 故意保持 vendor-agnostic,见 kernelAdapter.ts:185 注释)。
        prompt: opts.prompt as string | Parameters<typeof runtime.query>[0]['prompt'],
        cwd: opts.session.cwd,
        sessionId: opts.session.sessionId,
        // parentSessionId 由 vendor runtime 通过其 session facade 派生,
        // 顶层 prompt 调用方不再显式透传该字段; sub-agent 路径由 AgentTool
        // 在 BackgroundTask metadata 里携带。
        abortSignal: opts.abortSignal,
        model: opts.model,
        // 透传会话选定的 permission mode（如 plan）到 runtime AppState,让
        // vendor 权限管线按该模式运行。未设置时缺省不传 → runtime 保持
        // bypassPermissions 语义。
        ...(opts.permissionMode
          ? {
              permissionMode: opts.permissionMode as
                | 'default'
                | 'acceptEdits'
                | 'bypassPermissions'
                | 'dontAsk'
                | 'plan',
            }
          : {}),
        // zai patch: 按所选 model 解析 provider profile,对 openai provider
        // (e.g. zhiniao-* → wizard-ai OpenAI-Mix) 注入 providerOverride,
        // 让 vendor `getAnthropicClient` 走 `createOpenAIShimClient`(openai-shim)。
        ...(opts.providerOverride ? { providerOverride: opts.providerOverride } : {}),
        // zai patch: per-query providerId (from transcript.meta.providerId)。
        ...(opts.providerId ? { providerId: opts.providerId } : {}),
        // zai patch (2026-08-20): 会话级主 Agent 插槽。
        ...(opts.mainAgent ? { mainAgent: opts.mainAgent } : {}),
        // 系统注入标记:BashNotifier 用 true 避免通知 prompt 被 vendor 当 user 消息落盘。
        ...(opts.isMeta ? { isMeta: true } : {}),
      })
      for await (const ev of translateRuntimeEvents(
        vendorStream as AsyncIterable<Record<string, unknown>>,
        opts.session.sessionId,
      )) {
        yield ev as ServerEvent
      }
    },

    async abort(opts) {
      await abortSessionViaController(opts.session.sessionId, opts.reason)
    },

    // ─── transcript ────────────────────────────────────────────
    async patchTranscript(opts) {
      if (stopped) throw new Error('[opencc-adapter] shutdown, refusing patchTranscript')
      const store = getTranscriptStore()
      // TranscriptStore.patch 接受单个 patch 对象；KernelAdapter 接受 entries 数组。
      // 逐条调用 — vendor 内部保证 idempotent 与 last-write-wins 顺序。
      for (const entry of opts.entries) {
        await store.patch(opts.session.sessionId, entry as unknown as Record<string, unknown>, opts.session.cwd ? { cwd: opts.session.cwd } : undefined)
      }
    },

    async *readTranscript(opts): AsyncIterable<TranscriptEntry> {
      if (stopped) throw new Error('[opencc-adapter] shutdown, refusing readTranscript')
      const store = getTranscriptStore()
      const result = await store.read(opts.session.sessionId, { cwd: opts.session.cwd })
      const entries = result.messages as Array<{ kind?: string; ts?: number; [k: string]: unknown }>
      let seq = opts.sinceSeq ?? 0
      for (const e of entries) {
        yield {
          seq: seq++,
          kind: (e.kind ?? 'user') as TranscriptEntry['kind'],
          ts: e.ts ?? Date.now(),
          payload: e as Record<string, unknown>,
        }
      }
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
    async enqueue(opts) {
      if (stopped) throw new Error('[opencc-adapter] shutdown, refusing enqueue')
      const { sessionInbox } = await import('../../sessionInbox.js')
      // KernelAdapter.enqueue 接受 QueuePayload；映射到 InboxMessage（source.kind 由 caller 决定）
      sessionInbox.followup(opts.session.sessionId, {
        id: `enq-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
        source: {
          kind: opts.payload.source ?? 'user',
          form: 'text',
        },
        content: opts.payload.text,
        createdAt: Date.now(),
      })
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