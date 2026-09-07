/**
 * sessionAgentRegistry — per-session agentId 集合注册表 (zai patch 2026-09-07,
 * fix-busy-flush-v2-r2, worktree-dsh, Item C)。
 *
 * 设计意图:
 *   vendor `commandQueue` 全局单例里, cmd.agentId === parentSessionId
 *   这种 fallback 路由在多 session 并发时是错的 —— 任何 session 的
 *   agentId 可能跟另一个 session 的 sid 字面值撞上 (sess-xxxx vs
 *   sess-yyyy 这种前缀相似)。原来 `cmd.agentId === sid` 一刀切的 fallback
 *   会把别的 session 的通知误派到这里。
 *
 *   修法: 维护一个 `sessionId → Set<agentId>` 索引, 来自 SubagentNotifier
 *   实际观察到的 (parentSessionId, task.id) 配对 (terminal 事件时记)。
 *   busyFlush.drainCommandQueueForSession 的 fallback 仅在该 agentId 属于
 *   当前 session 时才匹配, 否则静默跳过 (但 warn log, 方便排查 cron /
 *   第三方 vendor 调用方漏走 zai wrapper 的情况)。
 *
 *   这里不主动追踪"已 spawn 但未 complete"的 agentId —— terminal 事件是
 *   唯一稳定的注入点 (task.parentSessionId + task.id 在 spawn 时写入,
 *   但 spawn 路径不走 SubagentNotifier)。如果有 cron / 第三方 vendor
 *   调用方 enqueue 没走 zai wrapper 又需要被 drain, 应改为走 wrapper
 *   (messageQueueAdapter.ts 的 zaiEnqueue/zaiEnqueuePendingNotification)。
 */

const sessionAgents = new Map<string, Set<string>>()

/**
 * Register an agentId as belonging to sessionId. Idempotent.
 * Typically called from SubagentNotifier.handle on terminal events,
 * where (parentSessionId, task.id) is the canonical parent→child pair.
 */
export function registerSessionAgent(sessionId: string, agentId: string): void {
  if (!sessionId || !agentId) return
  let set = sessionAgents.get(sessionId)
  if (!set) {
    set = new Set<string>()
    sessionAgents.set(sessionId, set)
  }
  set.add(agentId)
}

/**
 * Returns true if `agentId` was previously registered as belonging to
 * `sessionId`. Used by busyFlush.drainCommandQueueForSession to safely
 * fall back from cmd.sessionId === sid to cmd.agentId === sid when the
 * commandQueue entry's sessionId is undefined (vendor caller didn't go
 * through zai wrapper).
 */
export function isAgentOfSession(sessionId: string, agentId: string): boolean {
  if (!sessionId || !agentId) return false
  return sessionAgents.get(sessionId)?.has(agentId) ?? false
}

/**
 * Snapshot of all agentIds registered for a session. Useful for debug /
 * status endpoints. Returns a frozen array copy.
 */
export function listAgentsOfSession(sessionId: string): readonly string[] {
  const set = sessionAgents.get(sessionId)
  if (!set) return Object.freeze([])
  return Object.freeze([...set])
}

/**
 * Drop all registered agentIds for a session. Idempotent. Should be
 * called when a session is disposed / killed to avoid memory bloat.
 */
export function disposeSessionAgents(sessionId: string): void {
  sessionAgents.delete(sessionId)
}

/**
 * Test seam — clear all registrations.
 */
export function __resetSessionAgentsForTests(): void {
  sessionAgents.clear()
}
