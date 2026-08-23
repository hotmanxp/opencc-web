/**
 * abort() 真实接线 — P0-4。
 *
 * 通过 dsh-agent 的 `agent.cancel()` 真实中断当前 turn。
 * zai 侧 abort 信号来自 SSE 客户端断开 / 用户点停按钮 / 路由超时等。
 *
 * 工作流：
 *   1. 用 sessionId 在 ctx 的 `agents` service 里查找 Agent
 *   2. 调 agent.cancel({ kind: 'user' }) 触发中断
 *   3. await agent.whenIdle() 让 driver 收敛
 *   4. flush 当前 turn（让已 emit 的事件落盘）
 *
 * 已知缺口：
 *   - dsh Agent 没有公开的 bySessionId 查找 API（agents service 持有 Agent 实例）。
 *     当前实现让调用方在创建 Agent 时把映射表传入 ctx（通过 setupAgentMap）。
 */

import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@zn-ai/dsh-bridge/dsh-core'
import { type AgentCancelCause } from '@zn-ai/dsh-bridge/dsh-core'
import { flushDshSession } from './sessions/store.js'

export interface AgentMap {
  /** sessionId → Agent 实例 */
  get(sessionId: string): Agent | undefined
  set(sessionId: string, agent: Agent): void
  delete(sessionId: string): void
  /** 当前所有活跃 sessionId */
  keys(): IterableIterator<string>
}

/**
 * 默认 AgentMap — 用 Map 包装。
 */
export function createAgentMap(): AgentMap {
  const inner = new Map<string, Agent>()
  return {
    get: (id) => inner.get(id),
    set: (id, agent) => void inner.set(id, agent),
    delete: (id) => void inner.delete(id),
    keys: () => inner.keys(),
  }
}

/**
 * abort 当前 turn。
 *
 * @param ctx - dsh 长驻 ctx
 * @param sessionId - 要中断的会话 ID
 * @param cause - 中断原因（默认 'user'）
 * @returns 是否成功中断（agent 不存在时返回 false）
 */
export async function abortDshTurn(
  ctx: Context,
  sessionId: string,
  cause: AgentCancelCause = { kind: 'user' },
  opts?: { agentMap?: AgentMap },
): Promise<{ aborted: boolean; reason?: string }> {
  const agentMap = opts?.agentMap ?? readGlobalAgentMap(ctx)
  if (!agentMap) {
    return { aborted: false, reason: 'no_agent_map' }
  }
  const agent = agentMap.get(sessionId)
  if (!agent) {
    return { aborted: false, reason: 'agent_not_found' }
  }

  try {
    // 清空 inbox（keepInbox: false 是默认）+ 中断当前 turn
    agent.cancel(cause)
    // 等待 driver 收敛
    await agent.whenIdle()
    // flush 落盘（让已 emit 的事件写入 jsonl）
    const session = agent.session
    if (session) {
      await flushDshSession(ctx, session)
    }
    return { aborted: true }
  } catch (err) {
    return {
      aborted: false,
      reason: err instanceof Error ? err.message : String(err),
    }
  }
}

/**
 * 全局 AgentMap — 存到 ctx 的 isolate 内（goroutine-safe via WeakMap-style）。
 *
 * 用 ctx 内置存储；ctx.dispose 时由调用方负责清理。
 */
const AGENT_MAP_KEY = Symbol.for('dsh-bridge/agentMap')

export function installAgentMap(ctx: Context): AgentMap {
  const existing = readGlobalAgentMap(ctx)
  if (existing) return existing
  const map = createAgentMap()
  ;(ctx as unknown as Record<symbol, unknown>)[AGENT_MAP_KEY] = map
  return map
}

function readGlobalAgentMap(ctx: Context): AgentMap | undefined {
  return (ctx as unknown as Record<symbol, AgentMap | undefined>)[AGENT_MAP_KEY]
}

/**
 * 注册 agent 到全局 map。
 */
export function trackAgent(ctx: Context, sessionId: string, agent: Agent): void {
  const map = installAgentMap(ctx)
  map.set(sessionId, agent)
}

/**
 * 注销 agent。
 */
export function untrackAgent(ctx: Context, sessionId: string): void {
  readGlobalAgentMap(ctx)?.delete(sessionId)
}