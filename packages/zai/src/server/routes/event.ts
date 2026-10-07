import { Router, type IRouter, type Request, type Response } from 'express'
import type { ServerEvent } from '../../shared/events.js'
import { eventBus, ServerEventBus, SERVER_BOOT_ID } from '../services/eventBus.js'
import { writeSse, SSE_HEADERS } from '../services/sse.js'
import { getBackgroundRuntime } from '../services/backgroundRuntime.js'

const router: IRouter = Router()
const HEARTBEAT_MS = 15_000

/**
 * 拿 bg runtime,失败时返回 null(不抛)。
 * dsh 模式 / 早期 boot 阶段 / 任何 init 异常都被吞掉,继续走 SSE 主流程
 * — 没有合成 push 不影响历史 replay 和 live 订阅,只是退回到原 bug 行为。
 */
function safeGetBackgroundRuntime() {
  try {
    return getBackgroundRuntime()
  } catch {
    return null
  }
}

// 从 query / header 里拿 wantedSid. query 优先 (EventSource URL 友好:
// EventSource 自带重连时浏览器会重发 ?sid=xxx; header 是 fetch 兼容路径).
// 两个都缺 → 维持旧行为 (全量转发, 给非 Agent 页面比如 /system /install 等用).
function readWantedSid(req: Request): string | null {
  const q = req.query.sid
  if (typeof q === 'string' && q.length > 0) return q
  const h = req.headers['x-session-id']
  if (typeof h === 'string' && h.length > 0) return h
  return null
}

// 从 query 读 topics (csv). 缺省 / 空 = 订阅全量.
function readWantedTopics(req: Request): string[] {
  const q = req.query.topics
  if (typeof q !== 'string' || q.length === 0) return []
  return q.split(',').map((s) => s.trim()).filter(Boolean)
}

// async handler: 连接的整个生命周期都在这个函数内, 结束条件是 `closed` promise
// (client close / 心跳写失败). 这样 heartbeat timer 与 unsubscribe 的释放可以
// 统一收敛到 finally — 无论中途哪一步抛错 (writeSse 对非 EPIPE 错误会 rethrow,
// 见 services/sse.ts), timer 都不会泄漏.
router.get('/event', async (req: Request, res: Response) => {
  const lastEventId = req.headers['last-event-id'] as string | undefined
  const wantedSid = readWantedSid(req)
  const wantedTopics = readWantedTopics(req)

  let unsubscribe: (() => void) | undefined
  let heartbeat: ReturnType<typeof setInterval> | undefined
  let markClosed: () => void = () => {}

  try {
    // close 监听必须在第一个 await **之前**注册。Node 的 'close' 是一次性事件:
    // 客户端已经断开之后再注册监听器,它永远不会触发。原先注册在
    // `await bg.list()` 之后,客户端在那段窗口里断开时:
    //   - `closed` promise 永久挂起 → `finally` 永不执行
    //   - → unsubscribe() 不调用(订阅泄漏在 eventBus.subs 里)
    //   - → 心跳 setInterval 不 clearInterval(定时器泄漏)
    // 心跳写失败也救不了:已 destroy 的 response 上 res.write 返回 false
    // 而不抛异常,`:150` 的 catch 永不触发。
    const closed = new Promise<void>((resolve) => {
      markClosed = resolve
    })
    req.on('close', markClosed)

    for (const [k, v] of Object.entries(SSE_HEADERS)) res.setHeader(k, v)
    res.flushHeaders()

    // 1. 注册 subscriber (必须在 emit 前注册, 否则 emit 时没人接收).
    //    4 分支:
    //    - 有 topics + 有 sid → subscribeTopics(sid, topics, ...)
    //    - 有 topics + 无 sid → subscribeTopics(null, topics, ...)
    //    - 无 topics + 有 sid → subscribeScoped (旧行为)
    //    - 无 topics + 无 sid → subscribe (旧行为, 兼容非 Agent 页面)
    const writeEvent = (event: ServerEvent) =>
      writeSse(res, event as unknown as Parameters<typeof writeSse>[1])

    if (wantedTopics.length > 0) {
      unsubscribe = eventBus.subscribeTopics(wantedSid, wantedTopics, writeEvent)
    } else if (wantedSid) {
      unsubscribe = eventBus.subscribeScoped(wantedSid, writeEvent)
    } else {
      unsubscribe = eventBus.subscribe(writeEvent)
    }

    // 2. 重连补发 (必须在 emit 前执行, 避免 server.connected 被 replay 切片包含).
    //    topics 同样 apply 到 replay:
    //    - 有 topics + 有 sid → getHistoryAfterForSidWithTopics
    //    - 有 topics + 无 sid → getHistoryAfter + topicMatches 过滤
    //    - 无 topics + 有 sid → getHistoryAfterForSid (旧行为)
    //    - 无 topics + 无 sid → getHistoryAfter (旧行为)
    if (wantedSid && wantedTopics.length > 0) {
      for (const ev of eventBus.getHistoryAfterForSidWithTopics(lastEventId, wantedSid, wantedTopics)) {
        writeSse(res, ev as unknown as Parameters<typeof writeSse>[1])
      }
    } else if (wantedSid) {
      for (const ev of eventBus.getHistoryAfterForSid(lastEventId, wantedSid)) {
        writeSse(res, ev as unknown as Parameters<typeof writeSse>[1])
      }
    } else if (wantedTopics.length > 0) {
      const hist = eventBus.getHistoryAfter(lastEventId)
      for (const ev of hist) {
        if (ServerEventBus.topicMatches(ev.type, wantedTopics)) {
          writeSse(res, ev as unknown as Parameters<typeof writeSse>[1])
        }
      }
    } else {
      for (const ev of eventBus.getHistoryAfter(lastEventId)) {
        writeSse(res, ev as unknown as Parameters<typeof writeSse>[1])
      }
    }

    // 2.5. 主动推送当前所有 bg task 的最新状态 (agent_task.changed 合成事件)
    //    修复刷新后 CliAgent / 后台任务事件丢失的 bug:
    //    背景 — agent_task.changed 是「状态型」事件,每条 task 只 emit 一次
    //    (attach/dispatch 起 task 时),但 per-sid eventBus history 上限 256
    //    (CAPACITY=256,超出后 arr.shift() 淘汰最老)。session 跑久后,
    //    那 1 条 agent_task.changed 早就被 runtime.* 流量挤出 history;
    //    客户端刷新页面时,新 SSE 连接 replay 拿不到这条事件 →
    //    useAgentStore.agentTasksBySession[sid] 缺该 task → TaskDrawer 的
    //    detail 是 null → 整段 body 因为 `detail && !isBashTask` 守卫被卸,
    //    体感「没有任务的消息」(实际 task 事件流仍能正常到达 SSE,
    //    只是 drawer body 不渲染)。
    //    修法 — 新 SSE 连接建立后,服务端绕开 eventBus 容量上限,直接遍历
    //    bg runtime 当前 task 列表,把每条 task 当作「合成的
    //    agent_task.changed」事件通过本连接的 writeEvent 单独 push 给
    //    新客户端 (不走 eventBus,不被淘汰)。wantedSid 有值时按
    //    task.parentSessionId 过滤。
    //    seq 字段取自 eventBus 的下一个 seqCounter (走完 getHistoryAfter
    //    之后此值最大),保证客户端 reorder 时合成的 state 排在 replay 之后。
    //
    //    **topic 闸门 (2026-10-07)**:本段此前完全不过滤 topics,与上面 replay
    //    分支的 `topicMatches` 判定不一致。后果是无 sid + topics 白名单的连接
    //    (即 useEventStream 在 sessionId===null 时发的 GLOBAL_ONLY_TOPICS,
    //    覆盖 /instances 等不建会话的页面)照样收下**全机** bg task:该白名单
    //    刻意不含 `agent_task`(useEventStream 注释明说不要让无会话页面持有
    //    别的会话状态),但 §2.5 绕过了它。线上实测该页面首屏收到 2071 条
    //    合成帧 / 9MB,覆盖 352 个 session,每条带完整 `input.prompt` 与
    //    `resultText` —— 既是几十秒的加载卡顿,也是实打实的跨会话内容泄露。
    //
    //    修法:与 replay 用同一条判据(`topicMatches`),无 topics 参数 = 全量
    //    订阅 = 维持旧行为(推全部 task)。这样:
    //      - `?sid=A`(Agent 页,不带 topics)→ 不过滤,仍按 sid 推,原
    //        CliAgent 刷新丢 task 的修复完全不受影响;
    //      - 无 sid + topics=/instances 那套白名单 → `agent_task` 不在其中,
    //        整段跳过;
    //      - 无 sid + 无 topics(老式全量连接)→ 维持推全部,既有语义不变。
    const wantsAgentTasks =
      wantedTopics.length === 0 ||
      ServerEventBus.topicMatches('agent_task.changed', wantedTopics)
    const bg = wantsAgentTasks ? safeGetBackgroundRuntime() : null
    if (bg) {
      let synthSeq = eventBus.getNextSeq()
      for (const task of await bg.list()) {
        if (wantedSid && task.parentSessionId !== wantedSid) continue
        const synth: ServerEvent = {
          type: 'agent_task.changed',
          sessionId: task.parentSessionId ?? null,
          task,
          eventId: `synth-bgstate-${task.id}`,
          ts: Date.now(),
          seq: synthSeq++,
        }
        writeSse(res, synth as unknown as Parameters<typeof writeSse>[1])
      }
    }

    // 3. 立即发 server.connected (最后发, 这样它只进入 live subscriber, 不在 replay 切片中)
    eventBus.emit({ type: 'server.connected', sessionId: null, bootId: SERVER_BOOT_ID })

    // 4. 心跳 + 挂起直到连接结束.
    //    timer 回调里不再自己 clearInterval — 写失败只负责 settle `closed`,
    //    真正的释放统一由 finally 做 (定时器回调抛出的异常无法被 finally 捕获,
    //    所以这里仍需就地 catch, 但不再承担清理职责).
    //    `markClosed` / `closed` 已在第一个 await 之前建好(见 try 开头),这里
    //    只挂心跳,不再重复注册 close 监听。
    heartbeat = setInterval(() => {
      try {
        res.write(': heartbeat\n\n')
      } catch {
        markClosed()
      }
    }, HEARTBEAT_MS)

    await closed
  } catch {
    // 连接层写失败 (socket 已断 / 非 EPIPE 写错误). headers 早已 flush,
    // 交给 Express error handler 也只能销毁连接, 这里静默收口, 由 finally 释放资源.
  } finally {
    if (heartbeat) clearInterval(heartbeat)
    unsubscribe?.()
    try {
      res.end()
    } catch {
      // already closed
    }
  }
})

export default router