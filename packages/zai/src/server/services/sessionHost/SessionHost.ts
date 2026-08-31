/**
 * SessionHost —— 单会话进程宿主(B1 路线)。
 *
 * 生命周期:spawn `opencc -p` 子进程 → stdout NDJSON 逐行分发 → zai 侧
 * `forwardQuery(input)` 写 stdin user message 并迭代该 turn 的
 * RuntimeEvent 流(经 `translateSdkToRuntime` 复用 legacy 同款翻译) →
 * turn 以 vendor `result` 行结束。子进程常驻,直到 abort/kill/崩溃。
 *
 * 事件分发(Phase A 最小版):
 * - `system/init`:缓存 init 信息,resolve `ready()`(Phase B/D 前端投影用)。
 * - `control_request`(can_use_tool 等):登记进 ControlRequestRegistry,
 *   Phase A 只 log(子进程以 --dangerously-skip-permissions 启动,正常不触发);
 *   Phase B bridgeToolYield 在这里改走 SSE 弹窗。
 * - turn 期间(有 in-flight forwardQuery):行入队喂消费者。
 * - 非 turn 期间(后台 cron fire / 其他异步输出):Phase A 丢弃 + debug log
 *   (Phase D 改走 eventBus 转发,让 cron 等后台消息回流到前端)。
 */

import { randomUUID } from 'node:crypto'
import type {
  OpenccQueryInput,
  RuntimeEvent,
  SdkEventMeta,
} from '@zn-ai/zn-agent-core'
import { translateSdkToRuntime } from '@zn-ai/zn-agent-core'
import { spawnSessionHost } from './cliSpawn.js'
import { killChildTree } from '../../utils/killTree.js'
import { ControlRequestRegistry } from './controlRequest.js'
import { parseNdjson } from './ndjsonStream.js'
import type {
  NdjsonRow,
  OutboundControlRequest,
  ResultRow,
  SessionHostState,
  SpawnRequest,
} from './types.js'

/** nextRow() 的哨兵:host.abort() 唤醒等待者时返回,表示本轮强制结束。 */
const ABORT_SENTINEL = Symbol('sessionHost.abort')

type Waiter = {
  resolve: (row: NdjsonRow | typeof ABORT_SENTINEL) => void
}

export class SessionHost {
  readonly sessionId: string
  /** 传给 vendor `--session-id` 的纯 UUID。zai 的 sessionId(`sess-<timestamp>-<rand>`
   *  或 `sess-<uuid>`)不满足 vendor "must be a valid UUID" 校验,故每个 host
   *  生成一个稳定的随机 UUID 映射;`--no-session-persistence` 下 vendor 不落盘,
   *  zai 的持久化(TranscriptStore / sessionFacade)走 zai 自己 sessionId。
   *  Phase C 做 resume 时再对齐 vendor 文件名与 zai 会话的映射。 */
  private readonly vendorSessionId: string
  private readonly cwd: string
  private readonly model?: string

  private child: ReturnType<typeof spawnSessionHost>['child'] | null = null
  private state: SessionHostState = 'pending'
  private initInfo: Record<string, unknown> | null = null
  private readyResolvers: Array<() => void> = []

  /** 待消费的 stdout 行(当前 turn 的事件缓冲)。 */
  private queue: NdjsonRow[] = []
  /** 单槽 waiter:正在等待下一行的 forwardQuery 消费者。 */
  private waiter: Waiter | null = null
  /** 当前是否有 in-flight turn(forwardQuery 未结束)。 */
  private turning = false
  /** abort() 被调用过且尚未被消费(下次 nextRow 直接返回哨兵)。 */
  private abortPending = false

  /** stdout control_request 注册表(子进程 → 宿主)。 */
  readonly controlRequests = new ControlRequestRegistry()
  /** 当前 turn 的起点:上次 spawn 后第一个 turn 序号。 */
  private turnIndex = 0

  constructor(sid: string, opts: SpawnRequest) {
    this.sessionId = sid
    this.vendorSessionId = randomUUID()
    this.cwd = opts.cwd
    this.model = opts.model
  }

  /** 当前宿主状态。 */
  getState(): SessionHostState {
    return this.state
  }

  /** spawn 时写入的主模型(model 切换时 SessionRegistry 靠它判断 respawn)。 */
  getModel(): string | undefined {
    return this.model
  }

  /** vendor system/init 到达时 resolve;已就绪则立即 resolve。 */
  ready(): Promise<void> {
    if (this.state === 'ready') return Promise.resolve()
    return new Promise<void>((resolve) => this.readyResolvers.push(resolve))
  }

  isAlive(): boolean {
    return this.state !== 'killed' && !!this.child && this.child.exitCode === null
  }

  // ------------------------------------------------------------------
  // spawn / 生命周期
  // ------------------------------------------------------------------

  /** spawn 子进程(幂等;重复调用直接 return)。 */
  spawn(): void {
    if (this.state !== 'pending') return
    this.state = 'initializing'
    const { child } = spawnSessionHost({
      sessionId: this.vendorSessionId,
      cwd: this.cwd,
      model: this.model,
    })
    this.child = child

    child.once('error', (err) => {
      console.error(`[sessionHost:${this.sessionId}] spawn 失败:`, err)
      this.child = null
      this.state = 'killed'
      this.controlRequests.rejectAll('child spawn error')
      this.abortPending = true
      this.wakeWaiter()
    })

    child.once('exit', (code, signal) => {
      console.error(
        `[sessionHost:${this.sessionId}] 子进程退出 code=${code} signal=${
          signal ?? 'none'
        }${this.state === 'killed' ? '(zai 主动 kill)' : ''}`,
      )
      this.state = 'killed'
      this.child = null
      this.controlRequests.rejectAll('child exited')
      this.abortPending = true
      this.wakeWaiter()
    })

    // stderr:透传诊断信息(zai dev 时 opencc 的 log 都在这)。
    child.stderr?.on('data', (chunk) => {
      const text = String(chunk).trimEnd()
      if (text) {
        console.error(`[sessionHost:${this.sessionId}:stderr] ${text}`)
      }
    })

    // stdout NDJSON 读循环 —— 常驻分发。
    const stdout = child.stdout
    if (!stdout) throw new Error('opencc 子进程 stdout 未 pipe')
    void (async () => {
      for await (const line of parseNdjson(stdout)) {
        this.onLine(line as NdjsonRow)
      }
    })()
  }

  // ------------------------------------------------------------------
  // turn 生命周期:forwardQuery(input)
  // ------------------------------------------------------------------

  /**
   * 执行一轮 turn:写 stdin user message,迭代子进程 stdout 该 turn 的
   * RuntimeEvent 流,至 vendor `result` 行(或 abort / 进程退出)结束。
   * 事件词汇与 legacy `runtime.query()` 完全一致(经 translateSdkToRuntime),
   * 上层 translateRuntimeEvents 零改动。
   */
  async *forwardQuery(input: OpenccQueryInput): AsyncGenerator<RuntimeEvent> {
    this.spawn()
    if (!this.isAlive()) {
      yield runtimeErrorEvent(input.sessionId, '子进程不可用(opencc 未运行)')
      return
    }
    if (this.turning) {
      console.warn(
        `[sessionHost:${this.sessionId}] 收到重叠 forwardQuery,忽略`,
      )
      return
    }

    const meta: SdkEventMeta = {
      sessionId: input.sessionId,
      turnIndex: this.turnIndex++,
      eventCounter: 0,
      toolNameByUseId: new Map(),
      streamedBlockIndices: new Set(),
    }

    const onAbort = () => {
      void this.abort('user_abort')
    }
    input.abortSignal?.addEventListener('abort', onAbort, { once: true })

    this.turning = true
    this.abortPending = false
    this.writeStdin({
      type: 'user',
      message: {
        role: 'user',
        content: toContentBlocks(input.prompt),
      },
      parent_tool_use_id: null,
      session_id: '',
    })

    try {
      for (;;) {
        const row = await this.nextRow()
        if (row === ABORT_SENTINEL) break
        const events = translateSdkToRuntime(row, meta)
        meta.eventCounter += 1
        for (const evt of events) {
          yield evt
        }
        if (isTurnEnd(row)) break
      }
    } finally {
      this.turning = false
      input.abortSignal?.removeEventListener('abort', onAbort)
    }
  }

  /**
   * 打断当前 turn:向子进程发 `control_request {subtype:'interrupt'}`,
   * 并唤醒正在等待的 forwardQuery 消费者(即使子进程的 result 行未如期
   * 到达,本地迭代也立即结束)。子进程仍常驻,可继续下一轮。
   */
  async abort(reason: string = 'user_abort'): Promise<void> {
    if (!this.isAlive()) return
    console.debug(
      `[sessionHost:${this.sessionId}] abort(${reason}) -> interrupt`,
    )
    this.writeControlRequest('interrupt', { reason })
    this.abortPending = true
    this.wakeWaiter()
  }

  /** 优雅结束会话进程:发 `end_session`,随后 kill。 */
  async endSession(): Promise<void> {
    if (this.isAlive()) {
      this.writeControlRequest('end_session', {})
      await new Promise((r) => setTimeout(r, 100))
    }
    this.kill()
  }

  /** 强制终止子进程(不可恢复)。 */
  kill(): void {
    this.abortPending = true
    this.wakeWaiter()
    this.controlRequests.rejectAll('host killed')
    const child = this.child
    this.state = 'killed'
    if (child && child.exitCode === null) {
      // win32 下 child 可能是 `cmd /c opencc...` 包装层,child.kill 只杀
      // cmd.exe、opencc 孙进程会存活 —— 必须走进程树强杀。
      killChildTree(child, { force: true })
    }
  }

  // ------------------------------------------------------------------
  // stdin 写(基础帧)
  // ------------------------------------------------------------------

  private writeControlRequest(subtype: string, payload: Record<string, unknown> = {}): void {
    if (!this.isAlive()) return
    this.writeStdin({
      type: 'control_request',
      request_id: randomUUID(),
      request: { subtype, ...payload },
    })
  }

  /** 写一条 stdin JSONL。子进程 stdin 关闭后静默忽略(不抛)。 */
  private writeStdin(message: unknown): void {
    const child = this.child
    if (!child?.stdin || child.stdin.destroyed) return
    try {
      child.stdin.write(JSON.stringify(message) + '\n')
    } catch (err) {
      console.warn(`[sessionHost:${this.sessionId}] stdin 写失败:`, err)
    }
  }

  // ------------------------------------------------------------------
  // stdout 分发与队列
  // ------------------------------------------------------------------

  private onLine(row: NdjsonRow): void {
    if (!row || typeof row.type !== 'string') return

    // system/init:缓存 + resolve ready。
    if (row.type === 'system' && row.subtype === 'init') {
      this.initInfo = row as unknown as Record<string, unknown>
      this.state = 'ready'
      for (const resolve of this.readyResolvers.splice(0)) resolve()
      console.debug(
        `[sessionHost:${this.sessionId}] init 到达,model=${String(
          (row as Record<string, unknown>).model ?? '-',
        )}`,
      )
      return
    }

    // control_request:子进程向宿主请求决策(Phase B bridge;此处只登记 + log)。
    if (row.type === 'control_request') {
      const creq = row as unknown as OutboundControlRequest
      if (typeof creq.request_id === 'string' && creq.request?.subtype) {
        this.controlRequests.register(
          creq.request_id,
          String(creq.request.subtype),
          row,
        )
        console.warn(
          `[sessionHost:${this.sessionId}] 收到 control_request subtype=${creq.request.subtype}(Phase B 前仅登记不响应,晚到会被 poll 卡住)`,
        )
      }
      return
    }

    // 非 turn 期间的异步输出(cron fire / 后台任务回调)。
    if (!this.turning) {
      if (row.type !== 'keep_alive' && row.type !== 'control_response') {
        console.debug(
          `[sessionHost:${this.sessionId}] 非活跃事件丢弃(type=${row.type}${row.subtype ? `/${row.subtype}` : ''};Phase D 转 eventBus)`,
        )
      }
      return
    }

    // turn 期间:先喂等待者,队列为空时直接交付。
    if (this.waiter) {
      const resolve = this.waiter.resolve
      this.waiter = null
      resolve(row)
      return
    }
    this.queue.push(row)
  }

  /** 取下一行;abort 已请求时直接返回哨兵。 */
  private async nextRow(): Promise<NdjsonRow | typeof ABORT_SENTINEL> {
    if (this.abortPending) return ABORT_SENTINEL
    if (this.queue.length > 0) return this.queue.shift() as NdjsonRow
    return new Promise<NdjsonRow | typeof ABORT_SENTINEL>((resolve) => {
      this.waiter = { resolve }
      // 注册后立刻再查一次 —— abort() 可能在 waiter 建立前已把
      // abortPending 置位,避免消费者永久悬挂。
      if (this.abortPending) {
        const w = this.waiter
        this.waiter = null
        w.resolve(ABORT_SENTINEL)
      }
    })
  }

  private wakeWaiter(): void {
    if (this.waiter) {
      const w = this.waiter
      this.waiter = null
      w.resolve(ABORT_SENTINEL)
    }
  }
}

// ---------------------------------------------------------------------
// 工具
// ---------------------------------------------------------------------

function isTurnEnd(row: NdjsonRow): boolean {
  return row.type === 'result'
}

function runtimeErrorEvent(
  sessionId: string,
  message: string,
): RuntimeEvent {
  return {
    type: 'runtime.error',
    eventId: `evt-err-${Date.now()}`,
    sessionId,
    turnIndex: 0,
    ts: Date.now(),
    error: message,
  } as RuntimeEvent
}

/** prompt(string | content-block 数组)→ vendor stdin user message 的 content。 */
function toContentBlocks(
  prompt: string | NonNullable<OpenccQueryInput['prompt']>,
): unknown[] {
  if (Array.isArray(prompt)) return prompt
  return [{ type: 'text', text: String(prompt) }]
}

export type { ResultRow, SessionHostState }