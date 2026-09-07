// packages/zn-agent-core/src/compat/repl/setup/setupMailboxBridge.ts
// @ts-nocheck
/**
 * zai patch (2026-08-30, plan P1): L1 hook adapter — setupMailboxBridge.
 * Writes cross-session messages to recipient's inbox file. Mirrors
 * useMailboxBridge semantics.
 *
 * zai patch (2026-09-07, plan P2-2.6, worktree-dsh): in-memory signal
 * 替代 appendFileSync + 文件 inbox。原 vendor 实现把 mailbox 当文件
 * 追加日志用 (appendFileSync), zai 是多 session 服务, 多 session 同时
 * 跨 session 发消息时共享同一文件系统 (cwd 下的 .zai/inbox/),
 * session 间消息互相覆盖 + 串行写阻塞。
 *
 * 这里改 in-memory signal: 每个 session 独立的 MailboxBridge 实例,
 * 内置一个 in-memory ring buffer (per-session) + EventTarget 风格
 * listener, send() 推入 buffer + notify listener (同步), poll() 取出
 * head message + 标记 read。文件 inbox 仅作可选 opt-in fallback
 * (opts.persistFile = true 时保留原 appendFileSync 行为)。
 *
 * 与 useMailboxBridge (Phase 2.3) 的兼容:
 *   useMailboxBridge.ts 检查 mailbox.pollForSession 方法, 本 setup 暴露
 *   `inboxState: { pollForSession(sessionId) }` 让 vendor hook 找到
 *   per-session poll 入口。
 */

import { appendFileSync, mkdirSync } from 'fs'
import { join, dirname } from 'path'

type SetupMailboxBridgeOpts = {
  sessionId: string
  cwd: string
  teamName?: string
  agentName?: string
  onSubmitMessage: (msg: any) => void
  /**
   * zai patch (2026-09-07, plan P2-2.6, worktree-dsh): 可选 opt-in 旧行为。
   * false (默认) = in-memory signal only, 不写文件; true = 保留原
   * appendFileSync 行为(用于测试 / 调试跨进程场景)。
   */
  persistFile?: boolean
}

// zai patch (2026-09-07, plan P2-2.6, worktree-dsh): per-session in-memory
// queue + listener 注册表。zai 多 session 共享同一 fs 是错的设计;
// in-memory 隔离 + 同步 push 解决。
type InboxEntry = {
  from: string
  team?: string
  agent?: string
  timestamp: number
  payload: any
}
const sessionMailboxes = new Map<string, InboxEntry[]>()
const sessionListeners = new Map<string, Set<() => void>>()

/** zai 层 inbox state(per-session)。useMailboxBridge 通过 pollForSession 路由。 */
export const inboxState = {
  pollForSession(sid: string): InboxEntry | null {
    const queue = sessionMailboxes.get(sid)
    if (!queue || queue.length === 0) return null
    return queue.shift() ?? null
  },
  peekForSession(sid: string): readonly InboxEntry[] {
    return sessionMailboxes.get(sid) ?? []
  },
  pushForSession(sid: string, entry: InboxEntry): void {
    let queue = sessionMailboxes.get(sid)
    if (!queue) {
      queue = []
      sessionMailboxes.set(sid, queue)
    }
    queue.push(entry)
    const listeners = sessionListeners.get(sid)
    if (listeners) for (const fn of listeners) fn()
  },
  subscribeForSession(sid: string, listener: () => void): () => void {
    let set = sessionListeners.get(sid)
    if (!set) {
      set = new Set()
      sessionListeners.set(sid, set)
    }
    set.add(listener)
    return () => {
      set!.delete(listener)
    }
  },
  /** Test seam: 清空所有 session mailboxes / listeners。 */
  __resetAll(): void {
    sessionMailboxes.clear()
    sessionListeners.clear()
  },
}

export function setupMailboxBridge(opts: SetupMailboxBridgeOpts) {
  let disposed = false

  return {
    async send(to: string, msg: any) {
      if (disposed) return
      const entry: InboxEntry = {
        from: opts.sessionId,
        team: opts.teamName,
        agent: opts.agentName,
        timestamp: Date.now(),
        payload: msg,
      }
      // zai patch (2026-09-07, plan P2-2.6, worktree-dsh): in-memory signal
      // 主路径。pushForSession 同步触发 listener (useMailboxBridge
      // 同步 drain), 跨 session 路由在 inboxState 层完成, 此 setup
      // 仅是 producer。
      inboxState.pushForSession(to, entry)

      // opt-in 旧行为: persistFile=true 时同时写文件 inbox(测试 / 调试)
      if (opts.persistFile) {
        const inboxDir = join(opts.cwd, '.zai', 'inbox')
        mkdirSync(inboxDir, { recursive: true })
        const filePath = join(inboxDir, `${to}.jsonl`)
        try {
          appendFileSync(filePath, JSON.stringify(entry) + '\n')
        } catch (err) {
          console.warn(`[setupMailboxBridge] failed to write to ${filePath}:`, err)
        }
      }
    },
    teardown() {
      if (disposed) return
      disposed = true
    },
    /**
     * zai patch (2026-09-07, plan P2-2.6, worktree-dsh): 暴露 inboxState
     * 给 vendor useMailboxBridge hook 调用 —— vendor hook 通过
     * mailbox.pollForSession() 路由 per-session drain。本 setup 返回的
     * 对象上挂 inboxState, vendor 调用方按 (bridge as any).inboxState
     * 取值。
     */
    inboxState,
  }
}
