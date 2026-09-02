import { useEffect } from 'react'
import { subscribeServerEvents } from '../lib/eventSource.js'
import { useAgentStore, type AgentStoreApi } from './useAgentStore.js'
import { useAppStore } from './useAppStore.js'
import { useInstanceStore } from './useInstanceStore.js'
import { useSuperTaskStore } from './useSuperTaskStore.js'
import type { ServerEvent } from '../../../shared/events.js'

// 调试开关 — 与 eventSource.ts 同源(三选一): window.__ZAI_DEBUG_SSE__ /
// localStorage 'zai-debug-sse'=1 / URL ?zai-debug-sse=1
function isDebugSse(): boolean {
  if (typeof window === 'undefined') return false
  const w = window as any
  if (w.__ZAI_DEBUG_SSE__ === true) return true
  try {
    if (window.localStorage?.getItem('zai-debug-sse') === '1') return true
    const sp = new URLSearchParams(window.location.search)
    if (sp.get('zai-debug-sse') === '1') return true
  } catch {
    // ignore
  }
  return false
}
const DEBUG_SSE = isDebugSse()

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
    const handle = subscribeServerEvents(sessionId, enqueue, (state, attempt) => {
      // 连接状态机 → useAppStore, UI 顶栏据此显示连接指示。
      // server.connected 事件到达时 applyBatch 还会再次置 connected (覆盖
      // EventSource onopen 的时序差 — 见 applyBatch 顶部特殊处理)。
      useAppStore.getState().setStreamState(state, attempt)
    })
    return () => {
      handle.close()
    }
  }, [sessionId])
}

// microtask 批量: 同 tick 收到的 N 个 SSE 事件合并成一次 flush, applyBatch
// 一次性消费。避免一帧内 N 个事件触发 N 次 reducer 链 (P4)。
// 受控输入 (submitPrompt / 本地 UI 状态) 不走此路径, 保持同步。
let pending: ServerEvent[] = []
let scheduled = false

export function enqueue(event: ServerEvent): void {
  pending.push(event)
  if (scheduled) return
  scheduled = true
  queueMicrotask(() => {
    scheduled = false
    const batch = pending
    pending = []
    applyBatch(batch)
  })
}

// 批量 dispatcher — 从 dispatch 的 switch 重构而来, 供 enqueue 的 microtask
// flush 调用, 也导出供测试直接驱动 (test/web/eventStream-dispatch.test.ts 与
// src/web/src/store/useEventStream.test.ts 直接调它, 不再复制 switch)。
//
// 2026-09-02 重构成 `applyBatchTo(store, batch)` 形式:让 NewSuperTaskModal
// 内的独立 intake store 也能复用同一份 reducer 链(原 `applyBatch` 改为对
// 默认 `useAgentStore` 单例的薄封装)。任何想把 SSE 帧刷到非默认 store 的
// 调用方都直接 `applyBatchTo(store, batch)`。
export function applyBatchTo(store: AgentStoreApi, batch: ServerEvent[]): void {
  // 按 seq 全局排序: seq 是服务端全局单调顺序基准, 重连补发 / 乱序到达时
  // 保证同一 session 的事件按发布顺序应用 (T5 的 seq 守卫再兜底丢弃重放)。
  const ordered = [...batch].sort((a, b) => a.seq - b.seq)

  if (DEBUG_SSE) {
    for (const ev of ordered) {
      // eslint-disable-next-line no-console
      console.log('[client-sse] dispatch', JSON.stringify({
        type: ev.type,
        sessionId: (ev as any).sessionId,
        turnIndex: (ev as any).turnIndex,
        seq: (ev as any).seq,
      }))
    }
  }

  // server.connected 特殊处理 (在逐事件路由前执行): 置 connected 并触发
  // 冷启动快照补全 — SSE per-sid slice 已注册, 此时拉 REST 不会漏事件。
  // 详见 docs/superpowers/specs/2026-07-23-session-cold-state-design.md §5.1。
  const connected = ordered.find((e) => e.type === 'server.connected')
  if (connected) {
    useAppStore.getState().setConnected(true)
    useAppStore.getState().setStreamState('connected', 0)
    const _connectedSid = store.getState().sessionId
    if (_connectedSid) void store.getState().hydrateSessionState(_connectedSid)
  }

  for (const event of ordered) {
    switch (event.type) {
    case 'runtime.started':
    case 'runtime.delta':
    case 'runtime.thinking':
    case 'runtime.tool_call':
    case 'runtime.tool_result':
    case 'runtime.done':
    case 'runtime.aborted':
    case 'runtime.error':
    case 'runtime.compacted':
      store.getState().applyRuntimeEvent(event)
      break
    case 'session.created':
    case 'session.deleted':
    case 'session.renamed':
      store.getState().applySessionEvent(event)
      break
    case 'job.started':
    case 'job.progress':
    case 'job.done':
    case 'job.failed':
      useAppStore.getState().applyJobEvent(event)
      break
    case 'prompt.ask':
      store.getState().applyPromptAsk(event)
      break
    case 'prompt.approve':
      store.getState().applyPromptApprove(event as any)
      break
    case 'prompt.permission':
      store.getState().applyPromptPermission(event)
      break
    case 'queue.changed':
      store.getState().applyQueueChanged(event)
      break
    case 'session/projection':
      store.getState().applyProjection(event)
      break
    // server.connected 已在 applyBatch 顶部统一处理 (置 connected + hydrate)。
    case 'stream/error':
      // 结构化帧级错误: 置 error 态 (UI 显示红色错误 + 手动重连)。
      // applySystemEvent 当前不识别 stream/error (安全 no-op), toast 逻辑
      // 在 Task 7 完善。
      useAppStore.getState().setStreamState('error', 0)
      useAppStore.getState().applySystemEvent(event)
      break
    case 'server.error':
    case 'toast':
    case 'system.restarting':
    case 'system.restart.canceled':
      useAppStore.getState().applySystemEvent(event)
      break
    case 'branch.changed':
      useAppStore.getState().applySystemEvent(event)
      break
    // state.* — 4 个独立 case 分别路由到 useAgentStore 上对应的 reducer
    // (Task 10). 不能合并 case 因为 reducer 入参 shape 各不相同
    // (applyCwdChanged 不需要 task, applyV2TaskChanged 需要 action 字段).
    case 'cwd.changed':
      store.getState().applyCwdChanged(event); break
    case 'bash_task.changed':
      store.getState().applyBashTaskChanged(event); break
    case 'v2_task.changed':
      store.getState().applyV2TaskChanged(event); break
    case 'agent_task.changed':
      store.getState().applyAgentTaskChanged(event); break
    case 'instance.changed':
      useInstanceStore.getState().applyInstanceChanged(event)
      break
    // task_factory — 任务工厂事件(全局,不带 sid):刷新看板 + 记录
    // created 的任务 id(新建任务弹窗据此显示「已创建」完成条)。
    case 'task_factory':
      useSuperTaskStore.getState().applyTaskFactoryEvent(event)
      break
    // app.update.* — zai 自身版本自动升级通道的事件,UpdateNotifier 监听
    // appUpdate 状态显示 Modal / notification。统一走 useAppStore,
    // 不进 useAgentStore(这是 system 级,不是会话级)。
    case 'app.update.checking':
    case 'app.update.installing':
    case 'app.update.complete':
    case 'app.update.failed':
      useAppStore.getState().applyAppUpdate(event)
      break
  }
  }
}
/**
 * applyBatch — 兼容旧调用方:对默认全局 useAgentStore 单例的事件 dispatch。
 * 2026-09-02: 实际逻辑已抽到 `applyBatchTo(store, batch)`,本函数仅保留
 * `applyBatch(batch) === applyBatchTo(useAgentStore, batch)` 的语义,供
 * 测试 + 老代码继续引用。
 */
export function applyBatch(batch: ServerEvent[]): void {
  applyBatchTo(useAgentStore, batch)
}
