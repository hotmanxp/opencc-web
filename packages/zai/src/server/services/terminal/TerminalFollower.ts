import type { TerminalFrame } from '../../../shared/terminal.js'

/**
 * 单个 follower（一条 SSE 连接）的有界输出队列。
 * 移植自 deepseek-harness `packages/api/terminal-controller/src/stream.ts`。
 *
 * 关键约定：**慢消费者不阻塞 PTY**。队列超过 maxBytes 时该 follower 显式失败
 * （read() 抛错），由上层断开这条连接；客户端重连会拿到一份新的整屏 snapshot，
 * 所以丢掉中间输出是可接受的 —— 比让 shell 卡在写 stdout 上要好。
 */
export class TerminalFollower {
  private readonly frames: { frame: TerminalFrame; bytes: number }[] = []
  /** 队列头部下标，避免 Array.shift 的 O(n) 搬移。 */
  private head = 0
  private bytes = 0
  private wake: (() => void) | undefined
  private closed = false
  private finished = false
  private failure: Error | undefined

  /** @param maxBytes - 本 follower 待发队列的 UTF-8 字节上限。 */
  constructor(private readonly maxBytes: number) {}

  /** 入队一帧；超限则标记失败并关闭该 follower。 */
  push(frame: TerminalFrame): void {
    if (this.closed || this.finished) return
    const bytes = Buffer.byteLength(JSON.stringify(frame), 'utf8')
    if (this.bytes + bytes > this.maxBytes) {
      this.failure = new Error('终端输出消费过慢，已断开；重连可恢复当前屏幕')
      this.close()
      return
    }
    this.frames.push({ frame, bytes })
    this.bytes += bytes
    this.wake?.()
  }

  /** 交付完队列里剩余帧后结束（终端进程退出时调用）。 */
  finish(): void {
    this.finished = true
    this.wake?.()
  }

  /** 立即停止本 follower，但不影响终端进程（客户端断开时调用）。 */
  close(): void {
    this.closed = true
    this.frames.length = 0
    this.head = 0
    this.bytes = 0
    this.wake?.()
  }

  /**
   * 按序产出帧，直到断开、失败或结束。
   * @param signal - SSE 连接生命周期；abort 只解绑，不关终端。
   */
  async *read(signal: AbortSignal): AsyncIterable<TerminalFrame> {
    const abort = (): void => {
      this.close()
    }
    signal.addEventListener('abort', abort, { once: true })
    if (signal.aborted) abort()
    try {
      for (;;) {
        const next = this.head < this.frames.length ? this.frames[this.head++] : undefined
        if (next !== undefined) {
          this.bytes -= next.bytes
          if (this.head > 64 && this.head * 2 >= this.frames.length) {
            this.frames.splice(0, this.head)
            this.head = 0
          }
          yield next.frame
          continue
        }
        if (this.closed || this.finished) break
        await new Promise<void>((resolve) => {
          this.wake = resolve
        })
        this.wake = undefined
      }
      if (this.failure !== undefined) throw this.failure
    } finally {
      signal.removeEventListener('abort', abort)
      this.close()
    }
  }
}