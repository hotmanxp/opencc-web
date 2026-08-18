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

    // 重置 timer
    const prev = this.timers.get(key)
    if (prev) clearTimeout(prev)
    const lastLen = (this.pending.get(key)?.text.length) ?? 0
    const delayMs = (lastLen >= this.splitThreshold ? this.splitDelay : this.defaultDelay) * 1000
    const timer = setTimeout(() => {
      this.flush(key, onFlush)
    }, delayMs)
    // 不阻塞进程退出
    timer.unref?.()
    this.timers.set(key, timer)
  }

  /** 强制立即 flush(adapter 断开、组件卸载时调用) */
  flushAll(onFlush: (key: string, item: DebounceItem) => void): void {
    for (const [key, item] of this.pending) {
      const t = this.timers.get(key)
      if (t) clearTimeout(t)
      onFlush(key, item)
    }
    this.pending.clear()
    this.timers.clear()
  }

  private flush(key: string, onFlush: (item: DebounceItem) => void | Promise<void>): void {
    const item = this.pending.get(key)
    this.pending.delete(key)
    this.timers.delete(key)
    if (!item) return
    if (!item.text && item.mediaPaths.length === 0) return
    void onFlush(item)
  }

  /** 测试用 */
  size(): number {
    return this.pending.size
  }
}
