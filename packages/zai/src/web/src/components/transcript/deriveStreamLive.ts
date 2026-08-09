import type { AgentMessage } from '../../store/useAgentStore.js'

/**
 * 找到 `messages` 数组中最后一条 `assistant.text` 消息的下标。
 * 没有时返回 -1。`isAgentToolMessage` 之类的过滤由调用方负责 — helper 接收
 * 的数组应该是已过滤的 visibleMessages。
 *
 * 只在 collapsed 视图用于决定 forceExpanded (最后一条 assistant.text 完整展开)。
 * 流式 thinking 块的 streaming 判定不依赖这个 — 直接用 `idx === lastIdx` 即可。
 */
export function lastAssistantTextIndex(messages: AgentMessage[]): number {
  for (let i = messages.length - 1; i >= 0; i--) {
    if ((messages[i] as { type?: string }).type === 'assistant.text') return i
  }
  return -1
}
