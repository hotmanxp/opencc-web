/**
 * dsh run() 驱动 — B1a T1.2。
 *
 * 流程（dsh-headless index.js:96-134 同款模式）：
 *   1. agents.create({ sessionId, meta: { cwd }, agentOptions, setup }) 构造 Agent
 *   2. 首次 await agent.whenIdle() — 等 loader 装载完成
 *   3. 记 firstSeq = agent.session.seq
 *   4. agent.followup(createUserMessage(...)) 推入用户消息
 *   5. 再次 await agent.whenIdle() — 等 turn 完成
 *   6. sessions.flush(agent.session) — 落盘
 *   7. 把 agent.session.events 从 firstSeq 起产出为 AsyncIterable
 *
 * 关键不变量（主计划 §4.3 + B-1 尖峰验证）：
 *   - 首次 await agent.whenIdle() 必加 — 漏掉会拿到未完成挂载的 plugin tree
 *   - sessions.flush 在 whenIdle 后调 — 否则 log 未持久化
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
}

/**
 * 跑一轮 prompt 流，把 dsh SessionEvent 序列产出为 AsyncIterable。
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
  }
  const sessions = ctx.get('sessions') as {
    flush(session: Session): Promise<unknown>
  }

  if (!agents || !sessions) {
    throw new Error('[dsh-run] agents / sessions service unavailable — loader not mounted?')
  }

  // ── 1. 构造 Agent（不应用 headless-runner 的 exit 语义）────────────
  const { agent } = await agents.create({
    sessionId: SessionId(opts.sessionId),
    meta: { cwd: opts.cwd },
    agentOptions: {
      provider: opts.provider,
      model: opts.model,
    },
    setup: (agentCtx) => {
      // 桥接 zai provider/model 选择（T1.4 真实 installModelSelection 调用）
      // 当前 stub：仅记录 ctx 引用
      agentCtx.set('zaiPrompt', opts.prompt)
    },
  })

  // ── 2. 首次 await whenIdle — 等 loader 装载（dsh-headless index.js:99 同款） ──
  await agent.whenIdle()

  // ── 3. 记 firstSeq（after loader idle） ────────────────────────────
  const firstSeq = agent.session.seq

  // 订阅 session/event — B1a 阶段每个事件都 yield 给调用方做翻译。
  const eventQueue: SessionEvent[] = []
  let waiter: (() => void) | null = null
  const off = ctx.on('session/event', (_session: Session, event: SessionEvent) => {
    if (event.seq < firstSeq) return
    eventQueue.push(event)
    waiter?.()
    waiter = null
  })

  // ── 4. followup 推入 prompt ─────────────────────────────────────
  agent.followup(
    createUserMessage({
      content: [{ type: 'text', text: opts.prompt }],
      source: { kind: 'user' },
    }),
  )

  // ── 5. 二次 whenIdle — 等 turn 完成 ─────────────────────────────
  await agent.whenIdle()

  // ── 6. flush 落盘 ──────────────────────────────────────────────
  await sessions.flush(agent.session).catch((err) => {
    console.warn('[dsh-run] sessions.flush failed:', err)
  })

  // 把队列里积压的事件全部 yield
  while (eventQueue.length > 0) {
    const ev = eventQueue.shift()!
    yield ev
  }

  off?.()
}

/**
 * 同步等待 agent 进入 idle — 用于 abort 后让 dsh 自然退出当前 turn。
 */
export async function awaitAgentIdle(agent: Agent): Promise<void> {
  await agent.whenIdle().catch((err) => {
    console.warn('[dsh-run] awaitAgentIdle failed:', err)
  })
}