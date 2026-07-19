import { useEffect } from 'react'
import { subscribeServerEvents } from '../lib/eventSource.js'
import { useAgentStore } from './useAgentStore.js'
import { useAppStore } from './useAppStore.js'
import type { ServerEvent } from '../../../shared/events.js'

// 订阅 useAgentStore.sessionId 变化 — sessionId 改变时 React 会重跑 effect,
// 关掉旧 EventSource + 拿新 sid 开新连接. 新连接走 ?sid=xxx 让后端按 sid
// filter 事件流, 旧 sid 的 runtime.* / job.* / prompt.ask 不再穿透到当前 tab.
//
// 设计: 不在 sessionId=null 时主动 unsubscribe, 让 useAgentStore 的初始化
// 流程 (createNewSession → setSessionId) 自然触发重建. 仅当 sid 已经从
// "非空" 切到 "非空" 时重建, sid=null 时维持旧连接, 给冷启动留一个缓冲.
//
// 为什么不挂 url?/X-Session-Id header 给 EventSource:
// - EventSource 不支持自定义 header (HTML 规范), 只能走 URL. 这就是为什么
//   sid 走 ?sid=xxx query 参数. server 也兼容 X-Session-Id header (供其它
//   fetch 调用用).
// - EventSource 自带自动重连, 重连时会重发当前 URL (含 ?sid=xxx), server
//   再次按新 sid 过滤. 不需要客户端代码额外处理重连.
export function useEventStream(): void {
  const sessionId = useAgentStore((s) => s.sessionId)
  useEffect(() => {
    if (!sessionId) return
    const handle = subscribeServerEvents(sessionId, dispatch)
    return () => {
      handle.close()
    }
  }, [sessionId])
}

function dispatch(event: ServerEvent) {
  switch (event.type) {
    case 'runtime.started':
    case 'runtime.delta':
    case 'runtime.thinking':
    case 'runtime.tool_call':
    case 'runtime.tool_result':
    case 'runtime.done':
    case 'runtime.aborted':
    case 'runtime.error':
      useAgentStore.getState().applyRuntimeEvent(event)
      break
    case 'session.created':
    case 'session.deleted':
    case 'session.renamed':
      useAgentStore.getState().applySessionEvent(event)
      break
    case 'job.started':
    case 'job.progress':
    case 'job.done':
    case 'job.failed':
      useAppStore.getState().applyJobEvent(event)
      break
    case 'prompt.ask':
      useAgentStore.getState().applyPromptAsk(event)
      break
    case 'server.connected':
      useAppStore.getState().setConnected(true)
      break
    case 'server.error':
    case 'toast':
      useAppStore.getState().applySystemEvent(event)
      break
    case 'branch.changed':
      useAppStore.getState().applySystemEvent(event)
      break
  }
}