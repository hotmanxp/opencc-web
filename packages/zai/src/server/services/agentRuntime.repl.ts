// @ts-nocheck
/**
 * zai patch (2026-08-30, plan P1): ReplRuntime adapter.
 * Wraps createReplSession (zn-agent-core compat/repl) as OpenccRuntimeV2
 * interface. Wires session lifecycle to zai eventBus + translateSdkToRuntime.
 * Spec: docs/superpowers/specs/2026-08-30-inproc-repl-extract-design.md §5.1.
 *
 * zai patch (2026-08-30, P1 真机修复): ReplRuntime.query() 不再产出
 * 缺字段的合成事件;改为在 session.onEvent() 钩子里把 ReplEvent 转成
 * runtime.* 形态,query() 透传 onEvent 队列里累积的事件。stub session
 * 只 emit turnStart/turnEnd + sessionStart/sessionEnd;我们在这层包
 * runtime.started/runtime.done,让 routes/agent.ts 的 for-await 链路
 * 不再 f.map 抛错。P2 替换为 vendor query() 真实集成。
 */

import { createReplSession } from '@zn-ai/zn-agent-core'

// 客户端约定的事件形态(从 routes/agent.ts ServerEventInput 抽出最常用字段)。
type RuntimeEvent = {
  type: string
  sessionId?: string
  turnIndex?: number
  delta?: string
  toolUseId?: string
  toolName?: string
  input?: unknown
  output?: unknown
  isError?: boolean
  error?: { message?: string }
  apiRequestCount?: number
  contextTokens?: number
  ts?: number
}

export class ReplRuntime {
  private sessions = new Map<string, ReturnType<typeof createReplSession>>()
  private eventQueues = new Map<string, RuntimeEvent[]>()
  private queueWaiters = new Map<string, Array<(ev: RuntimeEvent) => void>>()

  /**
   * query() 是 zai 路由层的输入接口。它是 async generator,把 session
   * 在 onEvent 钩子里 emit 的 ReplEvent 转成 runtime.* 事件后透传给消费者。
   * 不调 vendor query() — P2 才接。
   */
  async *query(input: any): AsyncGenerator<RuntimeEvent> {
    const session = await this.getOrCreate(input.sessionId)
    // 把 input.prompt 推进 session(同步,stub 实现);real submit 应在后台跑。
    // 真 submit 是异步,这里 await 等 stub 完成 + emit turnStart/turnEnd。
    // 为避免 await session.submit(input.prompt) 把整个 turn 卡死,我们
    // 立刻 yield runtime.started,然后 async-poll event queue 直到
    // 看到 turnEnd 或 runtime.done,最后 yield runtime.done。
    const turnIndex = (session.getState().turnIndex ?? 0) + 1
    yield {
      type: 'runtime.started',
      sessionId: input.sessionId,
      turnIndex,
      apiRequestCount: 0,
      contextTokens: undefined,
      ts: Date.now(),
    } as RuntimeEvent

    // 启动后台 submit (不 await 它,否则会卡到 turnEnd 才返回)
    const submitPromise = session.submit(input.prompt).catch((err: unknown) => {
      // swallow into a synthetic error event
      const msg = err instanceof Error ? err.message : String(err)
      console.warn('[ReplRuntime] submit threw:', msg)
      this.enqueueEvent(input.sessionId, {
        type: 'runtime.error',
        sessionId: input.sessionId,
        turnIndex,
        error: { message: msg },
        ts: Date.now(),
      })
    })

    // 透传 onEvent 队列里的事件,直到 turnEnd 或 runtime.done
    while (true) {
      const ev = await this.dequeueEvent(input.sessionId)
      if (!ev) break
      yield ev
      if (
        ev.type === 'runtime.done' ||
        ev.type === 'runtime.aborted' ||
        ev.type === 'runtime.error'
      ) {
        break
      }
    }

    // 确保 submit 完成(可能在我们退出循环时还没完)
    await submitPromise.catch(() => {})

    // 防御性: 如果 onEvent 队列里没有 emit 过 runtime.done(例如 stub 没
    // emit 过对应的 ReplEvent),手动补一条 runtime.done 让 routes/agent.ts
    // 的 for-await 能正常 break。
    yield {
      type: 'runtime.done',
      sessionId: input.sessionId,
      turnIndex,
      apiRequestCount: 0,
      ts: Date.now(),
    } as RuntimeEvent
  }

  async abort(sessionId: string, reason?: string) {
    const session = this.sessions.get(sessionId)
    if (session) await session.interrupt(reason)
    this.enqueueEvent(sessionId, {
      type: 'runtime.aborted',
      sessionId,
      reason,
      ts: Date.now(),
    })
  }

  async enqueue(input: { sessionId: string; prompt: any; priority: 'now' | 'next' | 'later' }) {
    const session = await this.getOrCreate(input.sessionId)
    await session.enqueue(input.prompt, input.priority)
  }

  async interrupt(sessionId: string, reason?: string) {
    const session = this.sessions.get(sessionId)
    if (session) await session.interrupt(reason)
    this.enqueueEvent(sessionId, {
      type: 'runtime.aborted',
      sessionId,
      reason,
      ts: Date.now(),
    })
  }

  async getSessionState(sessionId: string): Promise<Record<string, unknown> | null> {
    const session = this.sessions.get(sessionId)
    if (!session) return null
    return session.getState() as unknown as Record<string, unknown>
  }

  async shutdown() {
    const disposes = Array.from(this.sessions.values()).map(s => s.dispose())
    await Promise.all(disposes)
    this.sessions.clear()
    this.eventQueues.clear()
    this.queueWaiters.clear()
  }

  // -------------------------------------------------------------------------
  // 内部: session 事件 → runtime.* 适配层
  // -------------------------------------------------------------------------

  private enqueueEvent(sessionId: string, ev: RuntimeEvent): void {
    if (process.env.ZAI_DEBUG_SSE === '1') {
      console.log(`[ReplRuntime] enqueue ${sessionId} ${ev.type}`)
    }
    const queue = this.eventQueues.get(sessionId) ?? []
    queue.push(ev)
    this.eventQueues.set(sessionId, queue)
    // wake up waiter if any
    const waiters = this.queueWaiters.get(sessionId)
    if (waiters && waiters.length > 0) {
      const cb = waiters.shift()!
      cb(ev)
      if (waiters.length === 0) this.queueWaiters.delete(sessionId)
    }
  }

  private dequeueEvent(sessionId: string): Promise<RuntimeEvent | null> {
    const queue = this.eventQueues.get(sessionId) ?? []
    if (queue.length > 0) {
      const ev = queue.shift()!
      this.eventQueues.set(sessionId, queue)
      return Promise.resolve(ev)
    }
    // no events available — wait for the next one (with a 5s safety timeout
    // so we don't hang forever if the session is stuck)
    return new Promise<RuntimeEvent | null>((resolve) => {
      const waiters = this.queueWaiters.get(sessionId) ?? []
      const timer = setTimeout(() => {
        // 5s timeout: drain waiters and resolve null
        const idx = this.queueWaiters.get(sessionId)?.indexOf(waker) ?? -1
        if (idx >= 0) this.queueWaiters.get(sessionId)!.splice(idx, 1)
        resolve(null)
      }, 5000)
      const waker = (ev: RuntimeEvent) => {
        clearTimeout(timer)
        resolve(ev)
      }
      waiters.push(waker)
      this.queueWaiters.set(sessionId, waiters)
    })
  }

  private async getOrCreate(sessionId: string) {
    let session = this.sessions.get(sessionId)
    if (!session) {
      session = createReplSession({
        sessionId,
        cwd: process.cwd(),
        input: (async function* () {})(),
        hooks: {
          onEvent: (replEvent: any) => {
            // 适配 ReplEvent → runtime.*。P1 stub session emit 的事件:
            //   turnStart/turnEnd/sessionStart/sessionEnd/sessionCrash/notification
            // 我们把 turnStart 当 runtime.started 之前的隐含信号(已被
            // query() 外层 yield),turnEnd 对应 runtime.done 触发信号,
            // sessionCrash 对应 runtime.error。
            const sid = sessionId
            if (replEvent.type === 'turnEnd') {
              this.enqueueEvent(sid, {
                type: 'runtime.done',
                sessionId: sid,
                turnIndex: replEvent.turnIndex,
                ts: replEvent.timestamp ?? Date.now(),
              })
            } else if (replEvent.type === 'sessionCrash') {
              this.enqueueEvent(sid, {
                type: 'runtime.error',
                sessionId: sid,
                turnIndex: replEvent.turnIndex,
                error: replEvent.payload ?? { message: 'session crash' },
                ts: replEvent.timestamp ?? Date.now(),
              })
            } else if (replEvent.type === 'notification') {
              // notification 事件保持原 type 透传
              this.enqueueEvent(sid, {
                ...replEvent,
                sessionId: sid,
                ts: replEvent.timestamp ?? Date.now(),
              } as RuntimeEvent)
            }
            // turnStart / sessionStart / sessionEnd 由 query() 外层包装,
            // 不在这里 yield (避免重复)。
          },
        },
      })
      this.sessions.set(sessionId, session)
    }
    return session
  }
}
