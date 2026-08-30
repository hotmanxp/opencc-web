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
 *
 * zai patch (2026-08-30, plan P3): slash command 路由。
 * /-prefixed prompt 在 submit 后立即识别,已知命令(loop/swarm/send)
 * yield `kind: '<cmd>-scheduled'` notification + runtime.done;未知
 * slash yield `kind: 'unknown-command'` notification + runtime.done。
 * 永不 yield runtime.error — Path 4/7/8 12-path 验证 fail 的根因。
 * 非 slash prompt 走原路径不变。
 */

import {
  createReplSession,
  parseSlashCommand,
  isKnownSlashCommand,
} from '@zn-ai/zn-agent-core'

import type { OpenccRuntime } from '@zn-ai/zn-agent-core'

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

// zai patch (2026-08-30, plan P3.1-T1): OpenccRuntime.query 产出的事件由
// vendor sdkEventAdapter (translateSdkToRuntime) 翻译为 Anthropic primitives
// (message_start / content_block_* / message_stop / tool_use:* / result)。
// routes/agent.ts 的 translateRuntimeEvents 知道这套词汇;ReplRuntime
// 透传即可,不再自己生成 runtime.* 包装事件(那是 P3 stub 的折中,P3.1
// 起交给 OpenccRuntime 真产出)。事件字段用 indexed map 表示,运行时由
// translateRuntimeEvents 按 type 字段分支处理。

export class ReplRuntime {
  // zai patch (2026-08-30, plan P3.1-T1): shared OpenccRuntime 由
  // services/agentRuntime.ts init 时构造,挂进本类。query() 优先委托给它;
  // 未提供时(单元测试 / 渐进迁移场景)走原 createReplSession 路径。
  constructor(private readonly openccRuntime?: OpenccRuntime) {}

  private sessions = new Map<string, ReturnType<typeof createReplSession>>()
  private eventQueues = new Map<string, RuntimeEvent[]>()
  private queueWaiters = new Map<string, Array<(ev: RuntimeEvent) => void>>()

  /**
   * query() 是 zai 路由层的输入接口。它是 async generator。
   *
   * zai patch (2026-08-30, plan P3.1-T1): 当构造时注入了 shared
   * `openccRuntime`,非 slash 命令直接委托给它,由 vendor
   * sdkEventAdapter (translateSdkToRuntime) 产出 Anthropic primitives
   * (message_start / content_block_* / message_stop / tool_use:*) ——
   * routes/agent.ts 的 translateRuntimeEvents 已经知道这套词汇。slash
   * 命令继续走 P3 stub 路径(/loop /swarm /send /unknown)产
   * runtime.notification + runtime.done,不动 OpenccRuntime。
   *
   * P3 旧路径(未注入 openccRuntime)保留兜底:把 input.prompt 推进
   * createReplSession 的 stub,onEvent 队列里累积的 ReplEvent 被本层包装
   * 成 runtime.* 透传给消费者。22 pre-existing test failures 不增不减。
   */
  async *query(input: any): AsyncGenerator<RuntimeEvent> {
    // zai patch (2026-08-30, plan P3): slash command 路由先于所有其他
    // 分支。识别 /-prefix prompt 后立即产出 notification + done,不走
    // normal turn;不调真 handler,永不 yield runtime.error。openccRuntime
    // 是否注入都不影响该路径。
    const slash = parseSlashCommand(typeof input.prompt === 'string' ? input.prompt : '')
    if (slash) {
      const turnIndexForSlash =
        typeof input.turnIndex === 'number' ? input.turnIndex : 0
      if (isKnownSlashCommand(slash.command)) {
        yield {
          type: 'runtime.notification',
          sessionId: input.sessionId,
          turnIndex: turnIndexForSlash,
          kind: `${slash.command}-scheduled`,
          payload: { args: slash.args, raw: slash.raw },
          ts: Date.now(),
        } as RuntimeEvent
      } else {
        // Unknown slash command — emit unknown-event, NO runtime.error
        yield {
          type: 'runtime.notification',
          sessionId: input.sessionId,
          turnIndex: turnIndexForSlash,
          kind: 'unknown-command',
          payload: { command: slash.command, args: slash.args },
          ts: Date.now(),
        } as RuntimeEvent
      }
      yield {
        type: 'runtime.done',
        sessionId: input.sessionId,
        turnIndex: turnIndexForSlash,
        apiRequestCount: 0,
        ts: Date.now(),
      } as RuntimeEvent
      return
    }

    // zai patch (2026-08-30, plan P3.1-T1): 委托 shared OpenccRuntime。
    // vendor 内部跑 sdkEventAdapter,产出 Anthropic primitives;本层只透传。
    // 不再 yield 包装的 runtime.* — 那会让 routes/agent.ts 看到两层事件,
    // translateRuntimeEvents 会重复吃 message_start / content_block_* 错乱。
    if (this.openccRuntime) {
      // Track the most recent turnIndex seen on the delegated stream so a
      // mid-turn throw reports the turn it actually failed on. Falls back to
      // `input.turnIndex` (the caller's turn hint) and finally to 0 when the
      // failure happens before any event was yielded and the caller didn't
      // supply one — documented limit: turnIndex is input/stream-driven here,
      // the ReplRuntime layer has no independent turn counter for the
      // delegated path (session state lives inside OpenccRuntime).
      let lastTurnIndex =
        typeof input.turnIndex === 'number' ? input.turnIndex : 0
      try {
        for await (const ev of this.openccRuntime.query(input)) {
          const evTurnIndex = (ev as RuntimeEvent)?.turnIndex
          if (typeof evTurnIndex === 'number') lastTurnIndex = evTurnIndex
          yield ev as RuntimeEvent
        }
      } catch (err) {
        // openccRuntime.query 抛错(例如网络失败 / model 401)— 转成
        // runtime.error 让 translateRuntimeEvents 把它包装成 SSE error event。
        const msg = err instanceof Error ? err.message : String(err)
        yield {
          type: 'runtime.error',
          sessionId: input.sessionId,
          turnIndex: lastTurnIndex,
          error: { message: msg },
          ts: Date.now(),
        } as RuntimeEvent
      }
      return
    }

    // P3 stub fallback — test-only path; production always has openccRuntime injected by initAgentRuntime.
    // P3 旧路径兜底:无 openccRuntime 注入时走 createReplSession stub。
    // 单元测试(slashCommands / agentRuntime.repl.test)在此路径验证。
    const session = await this.getOrCreate(input.sessionId)
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
            //
            // zai patch (2026-08-30, plan P3, Task 0): vendor
            // translateSdkToRuntime 通过 hooks.onEvent emit
            // ReplEvent { type: 'runtime', payload: { type: 'runtime.*' } }
            // for tool_call / tool_result / delta / thinking events.
            // 旧 handler 完全不识别 'runtime' 事件,这些 event 都被默默
            // 丢掉,导致 LLM 调了 Bash/Read 但前端看不到 tool_call 也
            // 看不到 tool_result。修复:增加一个分支直接转发 runtime.*
            // payload 到 enqueueEvent(保持 sessionId/ts 元数据一致)。
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
            } else if (
              replEvent.type === 'runtime'
              && replEvent.payload
              && typeof replEvent.payload.type === 'string'
              && replEvent.payload.type.startsWith('runtime.')
            ) {
              // zai patch (2026-08-30, plan P3, Task 0): forward
              // runtime.* events directly. The vendor adapter wraps
              // each RuntimeEvent in a ReplEvent { type: 'runtime',
              // payload: <RuntimeEvent> } — we unwrap and surface the
              // inner type so consumers see e.g. { type:
              // 'runtime.tool_call', toolUseId, toolName, input } instead
              // of the wrapper. sessionId + ts are normalized for
              // consistency with turnEnd / sessionCrash / notification.
              const inner = replEvent.payload
              this.enqueueEvent(sid, {
                ...inner,
                sessionId: sid,
                turnIndex: inner.turnIndex ?? replEvent.turnIndex,
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
