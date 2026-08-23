/**
 * dsh run() 驱动 — B1a T1.2 + Phase 3 P1 streaming fix。
 *
 * 流程（dsh-headless index.js:96-134 同款模式）：
 *   1. agents.create({ sessionId, meta: { cwd }, agentOptions, setup }) 构造 Agent
 *   2. 首次 await agent.whenIdle() — 等 loader 装载完成
 *   3. 记 firstSeq = agent.session.seq
 *   4. agent.followup(createUserMessage(...)) 推入用户消息
 *   5. **Phase 3 P1 streaming**: 边收 session/event 边 yield(不等
 *      whenIdle 完成) — turn/end 事件触发结束信号,前端 SSE 立即收到
 *      每个 assistant/chunk 翻译后的 runtime.delta,实现真正的流式
 *      输出(用户看到 token 边生成边显示)。
 *   6. turn/end 后才 await agent.whenIdle() + sessions.flush() 落盘。
 *   7. 把剩余 queue 事件 yield,off 取消订阅。
 *
 * **Phase 3 P1 streaming 关键约束**:
 *   - safety timer: turn 未结束 + 60s 无事件 → 强制退出(LLM 抽风 / 网络断)
 *   - turnEnded 信号: turn/end 事件一来就解锁 waiter,避免最后一次
 *     await Promise 卡住。
 *   - 多 turn session 安全:不 unsubscribe 时旧的 listener 会跨 turn
 *     累积,所以在 finally 里 off。
 *
 * **关键不变量**(主计划 §4.3 + B-1 尖峰验证):
 *   - 首次 await agent.whenIdle() 必加 — 漏掉会拿到未完成挂载的 plugin tree
 *   - sessions.flush 在 turn/end 后调 — 否则 log 未持久化
 */

import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { Session, SessionEvent } from '@deepseek-ai/dsh-session'
import { SessionId } from '@deepseek-ai/dsh-session'
import { createUserMessage } from '@deepseek-ai/dsh-llm'

export interface DshRunOptions {
  ctx: Context
  sessionId: string
  cwd: string
  prompt: string
  provider?: string
  model?: string
  /**
   * Phase 3 P1: 多模态 content blocks(图片/文档)。若提供,会拼到
   * createUserMessage 的 content 数组里(代替纯 text)。fallback:
   * 仅用 opts.prompt 当 text content。
   */
  contentBlocks?: Array<{ type: string; [k: string]: unknown }>
  /**
   * Phase 3 P1: 流式 yield 的 safety timer(毫秒)— turn 未结束且
   * 这么久无新事件时强制退出,避免 LLM 卡死永远不结束。默认 60s,
   * dsh 0.1.0-rc.7/8 暂未设上限。
   */
  streamingIdleTimeoutMs?: number
}

/**
 * 跑一轮 prompt 流，把 dsh SessionEvent 流式产出为 AsyncIterable。
 *
 * 调用方负责订阅 `session/event` 事件，yield 在 followup 完成且 flush 后的事件。
 */
export async function* runOnce(opts: DshRunOptions): AsyncIterable<SessionEvent> {
  const ctx = opts.ctx
  const agents = ctx.get('agents') as {
    create(opts: {
      sessionId: SessionId
      meta?: { cwd?: string }
      agentOptions?: { provider?: string; model?: string; maxTokens?: number }
      setup?: (agentCtx: Context) => unknown
    }): Promise<{ agent: Agent }>
    get?(id: SessionId | string): { agent?: Agent } | Agent | undefined
  }
  const sessions = ctx.get('sessions') as {
    flush(session: Session): Promise<unknown>
  }

  if (!agents || !sessions) {
    throw new Error('[dsh-run] agents / sessions service unavailable — loader not mounted?')
  }

  // ── 1. 构造或恢复 Agent（dsh-018 修复：多 turn session 复用）────────
  // dsh-agent 的 agents service 在 sessionId 已存在时调 `create` 会
  // 抛 "session already exists" 错误。先尝试 `get` 拿已存在的 agent；
  // 找不到再 `create`。这样多 turn 走同一 session 时复用同一个 dsh
  // Agent 实例（持续 history + 已 mount 的 dsh-scope），不会因为
  // dsh-009 修复后 routes/agent.ts 改走 adapter.run() 而产生冲突。
  //
  // 注:不再在 setup 里 provide('zaiPrompt') —— dsh-scope / dsh-tools /
  // dsh-system-prompt 在 agent scope 内已自动注册同名 service,重复 provide
  // 报 "service zaiPrompt has been registered at <scope>"。Prompt
  // 通过下面的 agent.followup(createUserMessage(...)) 传,不依赖 zaiPrompt。
  let agent: Agent | undefined
  const sessionId = SessionId(opts.sessionId)
  if (typeof agents.get === 'function') {
    const handle = agents.get(sessionId) as
      | { agent?: Agent }
      | Agent
      | undefined
    if (handle) {
      agent = 'agent' in handle ? handle.agent : (handle as Agent)
    }
  }
  if (!agent) {
    const created = await agents.create({
      sessionId,
      meta: { cwd: opts.cwd },
      agentOptions: {
        provider: opts.provider,
        model: opts.model,
      },
      // dsh-agent-presets session composition — 把当前 session 挂到默认
      // preset (general-purpose) 的 standing mount 上,确保这个 session 的
      // ctx.tools / ctx.systemPrompt / ctx.subagents 等 service 都能在
      // preset 自己的 scope chain 里被解析到。
      //
      // AgentFactory 在 session/created + agent/created 之前 await setup,
      // rejection 整段回滚(参见 @deepseek-ai/dsh-agent AgentSetup 注释),
      // 坏 preset 永远不会产生半个发布的 session。
      //
      // mount() 返回 resolved AgentPreset(用于记录),不需要 session 这边
      // 主动消费 — dsh-agent-presets 内部已经 parent 了 agentCtx 的
      // scope key 到 mount 的 standing key。
      setup: (agentCtx) => {
        const agentPresets = ctx.get('agentPresets') as
          | { mount: (agentCtx: Context, id?: string) => Promise<unknown> }
          | undefined
        if (!agentPresets) {
          // 未装载 — 走空 composition,不报错(graceful degradation):
          // dsh 模式最早版本(v0.1.0-rc.7)没有 dsh-agent-presets,某些
          // 老 ctx 可能仍能跑;不阻塞新 session 创建。
          return
        }
        return agentPresets.mount(agentCtx)
      },
    })
    agent = created.agent
  }

  // ── 2. 首次 await whenIdle — 等 loader 装载（dsh-headless index.js:99 同款） ──
  await agent.whenIdle()

  // ── 3. 记 firstSeq（after loader idle） ────────────────────────────
  const firstSeq = agent.session.seq

  // 订阅 session/event — Phase 3 P1 streaming:每个事件入队后立即
  // 解锁 waiter 让外层 yield loop 拿到。turn/end 作为终止信号。
  const eventQueue: SessionEvent[] = []
  let waiter: (() => void) | null = null
  let turnEnded = false
  let off: (() => void) | null = null
  off = ctx.on('session/event', (_session: Session, event: SessionEvent) => {
    if (typeof event.seq === 'number' && event.seq < firstSeq) return
    eventQueue.push(event)
    if (event.type === 'turn/end') {
      turnEnded = true
    }
    waiter?.()
    waiter = null
  })

  // ── 4. followup 推入 prompt(支持多模态 contentBlocks) ──────────────
  //
  // Phase 3 P1: opts.contentBlocks 是 OpenaiContentBlock 形态 — 直接拼到
  // createUserMessage 的 content 数组。fallback 到纯 text。
  // createUserMessage 接 readonly ContentBlock[],由 dsh-session 内部按
  // 类型(image/text)分类到 surface event,然后 LLM 端按 Anthropic
  // protocol 序列化发给模型。
  const userMessageContent: Array<{ type: string; [k: string]: unknown }> = []
  if (opts.contentBlocks && opts.contentBlocks.length > 0) {
    for (const block of opts.contentBlocks) {
      userMessageContent.push(block)
    }
  }
  if (opts.prompt && opts.prompt.trim().length > 0) {
    userMessageContent.push({ type: 'text', text: opts.prompt })
  }
  // 至少要有一个 content block(createUserMessage 校验)
  if (userMessageContent.length === 0) {
    userMessageContent.push({ type: 'text', text: '' })
  }

  agent.followup(
    createUserMessage({
      content: userMessageContent as unknown as Parameters<typeof createUserMessage>[0]['content'],
      source: { kind: 'user' },
    }),
  )

  // ── 5. Phase 3 P1 流式 yield loop ────────────────────────────────
  // 不立即 await whenIdle — 让每个 session/event 触发后立即 yield 给
  // 调用方(translator → zai ServerEvent → SSE → 前端),前端能看到
  // token 边生成边显示。
  //
  // 终止条件: turnEnded + queue 空,或 safety timer 触发(LLM 卡死)。
  const safetyMs = opts.streamingIdleTimeoutMs ?? 60_000
  let safetyTimer: ReturnType<typeof setTimeout> | null = null
  const exitReason: { kind: 'turn_end' | 'safety_timeout' } = { kind: 'turn_end' }

  try {
    while (!turnEnded || eventQueue.length > 0) {
      // queue 有事件 → yield 一个
      if (eventQueue.length > 0) {
        const ev = eventQueue.shift()!
        yield ev
        continue
      }
      // queue 空 + turn 还没结束 → 等下一个事件或 turn 结束
      if (!turnEnded) {
        await new Promise<void>((resolve) => {
          waiter = resolve
          // safety timer: 设 N 秒内没新事件就强制退出
          safetyTimer = setTimeout(() => {
            exitReason.kind = 'safety_timeout'
            resolve()
          }, safetyMs)
        })
        if (safetyTimer) {
          clearTimeout(safetyTimer)
          safetyTimer = null
        }
      } else {
        // turnEnded 但 queue 暂时空(可能还有事件在路上)→ 短暂等下
        await new Promise<void>((resolve) => {
          waiter = resolve
          safetyTimer = setTimeout(() => {
            exitReason.kind = 'safety_timeout'
            resolve()
          }, 5000) // 短超时,turn 已结束就快速退出
        })
        if (safetyTimer) {
          clearTimeout(safetyTimer)
          safetyTimer = null
        }
        // 5s 内都没新事件,认为 turn 已真正收尾
        break
      }
    }

    if (exitReason.kind === 'safety_timeout' && process.env.ZAI_DEBUG === '1') {
      console.warn('[dsh-run] safety timeout fired — turn may not have ended cleanly')
    }
  } finally {
    if (safetyTimer) clearTimeout(safetyTimer)
    off?.()
  }

  // ── 6. turn/end 后再次 await whenIdle + flush 落盘 ────────────────
  // 第二轮 whenIdle 不再 block 流式(我们已经在 turn/end 后立即退
  // 出 yield loop),只等可能的后续 maintenance work 收尾,确保
  // sessions.flush 拿到完整日志。
  await agent.whenIdle().catch((err) => {
    if (process.env.ZAI_DEBUG === '1') {
      console.warn('[dsh-run] post-turn whenIdle failed:', err)
    }
  })

  await sessions.flush(agent.session).catch((err) => {
    console.warn('[dsh-run] sessions.flush failed:', err)
  })
}