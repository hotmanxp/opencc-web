import { useCallback, useEffect, useMemo, useSyncExternalStore } from 'react'
import { useMailbox } from '../context/mailbox.js'

// zai patch (2026-08-30, plan P1): also export imperative setupMailboxBridge.
export { setupMailboxBridge } from '../../compat/repl/setup/setupMailboxBridge.js'

// zai patch (2026-09-07, plan P2-2.3, worktree-dsh): 增加可选 sessionId 字段。
// zai 多 session 服务下, mailbox 是 process-level singleton, 多个 session
// 共享同一个 mailbox.poll() 队列会互相窜。zai 调用方在 Props 传 sessionId,
// poll 时按 sessionId 路由 —— 只 poll 本 session 的消息, 其它 session 的
// 消息保留在 queue 中, 等该 session 自己 idle 时 drain。
//
// vendor 单进程场景下不传 sessionId, 走兼容路径(全部 poll), 行为不变。
// 23 行 useEffect 的 mailbox.poll() 在 zai 调用方传 sessionId 时升级为
// mailbox.pollForSession(sessionId), mailbox 模块无该方法时 fallback 到
// 原始 poll() —— mailbox.ts 不在本 phase 范围, 留给 compat/repl/setup/
// setupMailboxBridge.ts 提供适配(Phase 2.6)。
type Props = {
  isLoading: boolean
  onSubmitMessage: (content: string) => boolean
  sessionId?: string
}

export function useMailboxBridge({ isLoading, onSubmitMessage, sessionId }: Props): void {
  const mailbox = useMailbox()

  const subscribe = useMemo(() => mailbox.subscribe.bind(mailbox), [mailbox])
  const getSnapshot = useCallback(() => mailbox.revision, [mailbox])
  const revision = useSyncExternalStore(subscribe, getSnapshot)

  useEffect(() => {
    if (isLoading) return
    // zai patch (2026-09-07, plan P2-2.3, worktree-dsh): per-session poll。
    // mailbox 对象可能没有 pollForSession 方法(纯 vendor 兼容路径), 这
    // 里 try/catch + 字段检查走默认 poll()。compat/repl/setup/
    // setupMailboxBridge.ts 在 zai fallback 路径下注入 pollForSession。
    let msg: { content: string } | null = null
    try {
      const pollFor = (mailbox as any).pollForSession
      if (typeof pollFor === 'function') {
        msg = pollFor.call(mailbox, sessionId) ?? null
      } else {
        msg = mailbox.poll() ?? null
      }
    } catch {
      msg = mailbox.poll() ?? null
    }
    if (msg) onSubmitMessage(msg.content)
  }, [isLoading, revision, mailbox, onSubmitMessage, sessionId])
}
