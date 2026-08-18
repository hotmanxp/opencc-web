/**
 * zai server → 子 agent 运行环境(bundle 内)的 inbox 投递桥。
 *
 * 为什么用 globalThis(zai patch,对齐 agentTaskBridge):
 *   opencc-src/server 的 bundle 由 esbuild 单文件打包,import zai server 的
 *   sessionInbox 会把该模块内联成 bundle 私有实例,与 zai server 用的不是
 *   同一个 —— 事件到不了主对话。zai server 在 init 时把真实的
 *   sessionInbox.followup/inject 注入 `globalThis.__zaiSessionInbox`。
 *   纯 zn-agent-core 单测 / vendor CLI 直跑时无桥 → 返回 false,调用方 no-op。
 */
export interface InboxMessageLike {
  id: string
  source: { kind: string; form: string; senderSessionId?: string; agentType?: string; [k: string]: unknown }
  content: string
  createdAt: number
}

export interface InboxBridgeLike {
  followup(sessionId: string, msg: InboxMessageLike): void
  inject(sessionId: string, msg: InboxMessageLike): void
}

export function tryGetInboxBridge(): InboxBridgeLike | null {
  const v = (globalThis as { __zaiSessionInbox?: InboxBridgeLike }).__zaiSessionInbox
  return v ?? null
}

/** core 侧统一投递入口。返回是否真的投出(无 bridge → false)。 */
export function deliverInboxMessage(opts: {
  parentSessionId: string
  senderSessionId: string
  content: string
  delivery: 'wakeup' | 'quiet'
  source: { kind: string; form: string; agentType?: string }
}): boolean {
  const bridge = tryGetInboxBridge()
  if (!bridge) return false
  const msg: InboxMessageLike = {
    id: `${opts.source.kind}-${Date.now()}`,
    source: { ...opts.source, senderSessionId: opts.senderSessionId },
    content: opts.content,
    createdAt: Date.now(),
  }
  if (opts.delivery === 'wakeup') bridge.followup(opts.parentSessionId, msg)
  else bridge.inject(opts.parentSessionId, msg)
  return true
}