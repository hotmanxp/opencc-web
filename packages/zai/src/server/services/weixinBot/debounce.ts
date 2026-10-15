/**
 * 文本批量 debounce — Telegram 适配器在 hermes 也用同款模式。
 *
 * iLink 把转发的多条消息拆成独立 ms 推送;不合并会让 agent 一次 invocation
 * 处理一行非完整文本,体验差。这里按 session_key 缓冲,文本追加,媒体合并,
 * 静默期(默认 3s)到了再 flush。
 *
 * 长文本阈值:最近 fragment 长度 ≥ TEXT_BATCH_SPLIT_THRESHOLD 时切换到更长
 * 静默期(5s),给 iLink "拖拽粘贴后还在分段"的场景多留点时间。
 */
import { DEFAULT_TEXT_BATCH_DELAY_SECONDS, DEFAULT_TEXT_BATCH_SPLIT_DELAY_SECONDS, TEXT_BATCH_SPLIT_THRESHOLD } from './constants.js'

export interface DebounceItem {
  text: string
  mediaPaths: string[]
  mediaTypes: string[]
}

export interface DebounceOptions {
  defaultDelaySeconds?: number
  splitDelaySeconds?: number
  splitThreshold?: number
}

export class TextDebouncer {
  private readonly defaultDelay: number
  private readonly splitDelay: number
  private readonly splitThreshold: number
  private readonly pending = new Map<string, DebounceItem>()
  private readonly timers = new Map<string, ReturnType<typeof setTimeout>>()
  /**
   * 每个 key 入队时注册的 flush 回调。必须存下来 —— 否则 `flushAll` 只能拿到
   * 调用方临时传的回调,而真正的派发闭包(带 messageId / mediaPaths / raw)只
   * 存在于 enqueue 的参数里,断连时缓冲区会被静默丢弃。
   */
  private readonly handlers = new Map<string, (item: DebounceItem) => void | Promise<void>>()

  constructor(opts: DebounceOptions = {}) {
    this.defaultDelay = opts.defaultDelaySeconds ?? DEFAULT_TEXT_BATCH_DELAY_SECONDS
    this.splitDelay = opts.splitDelaySeconds ?? DEFAULT_TEXT_BATCH_SPLIT_DELAY_SECONDS
    this.splitThreshold = opts.splitThreshold ?? TEXT_BATCH_SPLIT_THRESHOLD
  }

  /**
   * 推入一条 fragment,返回累计的 DebounceItem + resolved promise。
   * 同一 key 再次推入时,append 文本/媒体并重置 timer;最先入队的 promise
   * 仍然解析,后续 reset 时给前一个 promise 标记 outdated 让其 skip 自身 flush。
   */
  enqueue(
    key: string,
    fragment: DebounceItem,
    onFlush: (item: DebounceItem) => void | Promise<void>,
  ): void {
    const existing = this.pending.get(key)
    if (existing) {
      existing.text = existing.text ? `${existing.text}\n${fragment.text}` : fragment.text
      existing.mediaPaths.push(...fragment.mediaPaths)
      existing.mediaTypes.push(...fragment.mediaTypes)
    } else {
      this.pending.set(key, {
        text: fragment.text,
        mediaPaths: [...fragment.mediaPaths],
        mediaTypes: [...fragment.mediaTypes],
      })
    }
    this.handlers.set(key, onFlush)

    // 重置 timer
    const prev = this.timers.get(key)
    if (prev) clearTimeout(prev)
    const lastLen = (this.pending.get(key)?.text.length) ?? 0
    const delayMs = (lastLen >= this.splitThreshold ? this.splitDelay : this.defaultDelay) * 1000
    const timer = setTimeout(() => {
      this.flush(key)
    }, delayMs)
    // 不阻塞进程退出
    timer.unref?.()
    this.timers.set(key, timer)
  }

  /**
   * 强制立即 flush(adapter 断连时调用)。
   *
   * 用每个 key 自己 enqueue 时注册的回调真正派发,并 await 全部完成 ——
   * adapter 靠它保证「disconnect 返回前缓冲区里的消息已走到 bridge 落盘」。
   * 早先的 `flushAll(() => {})` 是纯丢弃:游标已推进,服务端不重投,消息永久丢失。
   */
  async flushAll(): Promise<void> {
    const inFlight: Array<void | Promise<void>> = []
    for (const [key, item] of this.pending) {
      const t = this.timers.get(key)
      if (t) clearTimeout(t)
      const handler = this.handlers.get(key)
      this.pending.delete(key)
      this.timers.delete(key)
      this.handlers.delete(key)
      if (!handler) continue
      if (!item.text && item.mediaPaths.length === 0) continue
      inFlight.push(handler(item))
    }
    this.pending.clear()
    this.timers.clear()
    this.handlers.clear()
    await Promise.all(inFlight.map((p) => Promise.resolve(p).catch(() => {})))
  }

  private flush(key: string): void {
    const item = this.pending.get(key)
    const handler = this.handlers.get(key)
    this.pending.delete(key)
    this.timers.delete(key)
    this.handlers.delete(key)
    if (!item || !handler) return
    if (!item.text && item.mediaPaths.length === 0) return
    void handler(item)
  }

  /** 测试用 */
  size(): number {
    return this.pending.size
  }
}
