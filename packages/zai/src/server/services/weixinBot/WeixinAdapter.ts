/**
 * WeixinAdapter — 微信入站 long-poll + 解析 + outbound 推送核心。
 *
 * 状态机:
 *   disconnected ──connect()──► connecting ──success──► connected
 *                                          └──failure──► failed
 *   connected ──disconnect()──► disconnecting ──► disconnected
 *
 * 入站路径:
 *   connect() 启动 _poll_loop → iLinkClient.getUpdates(sync_buf, 35s)
 *      → for each msg: _processMessage_safe (异步,互不阻塞)
 *      → dedup / access policy / 媒体下载 / context token 持久化
 *      → 文本 debounce → _emitInternal () 派发给 eventBus (B3 阶段接入)
 *
 * 出站路径(在 B2 阶段实现):
 *   sendText / sendImage / sendDocument / sendVideo / sendVoice / sendTyping
 *
 * 关键防护:
 *   - 连续 1-2 次错误 2s retry,3+ 次 30s backoff
 *   - session expired (-14) 暂停 10 分钟
 *   - RateLimit (-2) 触发熔断器
 *   - token 锁: 同一 token 只能一个 zai 实例拉
 *   - 媒体 URL 白名单 (SSRF)
 *
 * 设计目标:不阻塞 zai 主进程 — 失败时仅 warn,不 throw 到 initAgentRuntime。
 */
import { createHash } from 'node:crypto'
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { ILinkClient } from './iLinkClient.js'
import {
  type ILinkInboundMessageT,
  type ILinkItemT,
  ILINK_ERROR,
  ITEM_TEXT,
  ITEM_IMAGE,
  ITEM_VOICE,
  ITEM_FILE,
  ITEM_VIDEO,
} from './iLinkTypes.js'
import { ContextTokenStore } from './stores/ContextTokenStore.js'
import { SyncBufStore } from './stores/SyncBufStore.js'
import { TypingTicketCache } from './stores/TypingTicketCache.js'
import { MessageDeduplicator } from './stores/MessageDeduplicator.js'
import { TextDebouncer } from './debounce.js'
import { AccountLock } from './AccountLock.js'
import { evaluateAccessPolicy, guessChatType, type DmPolicy, type GroupPolicy } from './accessPolicy.js'
import { decryptAes128Ecb, assertSafeCdnUrl, mimeForMediaType } from './mediaCrypto.js'
import { WEIXIN_MEDIA_DIR } from './paths-internal.js'
import {
  LONG_POLL_TIMEOUT_MS,
  MESSAGE_DEDUP_TTL_SECONDS,
  MAX_CONSECUTIVE_FAILURES,
  RETRY_DELAY_SECONDS,
  BACKOFF_DELAY_SECONDS,
  SESSION_EXPIRED_BACKOFF_SECONDS,
  TYPING_TICKET_TTL_SECONDS,
  API_TIMEOUT_MS,
  WEIXIN_CDN_BASE_URL,
} from './constants.js'
import type { ILinkClientOptions } from './iLinkClient.js'

export type AdapterState = 'disconnected' | 'connecting' | 'connected' | 'reconnecting' | 'failed'

export interface WeixinAdapterOptions {
  accountId: string
  token: string
  baseUrl?: string
  cdnBaseUrl?: string
  /** 入站 fetch 实现,生产用 Node 内置 fetch */
  fetchImpl?: typeof fetch
  /** 访问策略 */
  dmPolicy?: DmPolicy
  groupPolicy?: GroupPolicy
  allowFrom?: string[]
  groupAllowFrom?: string[]
  /** iLink global allow-all 兜底开关(从 env 读) */
  globalAllowAll?: boolean
  /** 持久化媒体目录 */
  mediaDir?: string
}

export interface InternalWeixinMessage {
  accountId: string
  chatId: string
  chatType: 'dm' | 'group'
  senderId: string
  text: string
  mediaPaths: string[]
  mediaTypes: string[]
  messageId: string
  contextToken: string | null
  /** iLink 原始 payload,留作调试 */
  raw: unknown
}

export type InternalEmit = (msg: InternalWeixinMessage) => void

/** Adapter 状态订阅 — 给 UI/B3 manager 使用 */
export type StatusListener = (status: AdapterStatus) => void
export interface AdapterStatus {
  state: AdapterState
  lastError: string | null
  lastConnAt: number | null
  consecutiveFailures: number
}

export class WeixinAdapter {
  private readonly opts: Required<Omit<WeixinAdapterOptions, 'fetchImpl' | 'mediaDir'>> & {
    fetchImpl: typeof fetch | undefined
    mediaDir: string
  }
  private readonly client: ILinkClient
  private readonly contextStore = new ContextTokenStore()
  private readonly syncStore = new SyncBufStore()
  private readonly typingCache = new TypingTicketCache({ ttlSeconds: TYPING_TICKET_TTL_SECONDS })
  private readonly dedup = new MessageDeduplicator({ ttlSeconds: MESSAGE_DEDUP_TTL_SECONDS })
  private readonly debounce = new TextDebouncer()
  private readonly statusListeners = new Set<StatusListener>()
  private lock: AccountLock | null = null
  private _state: AdapterState = 'disconnected'
  private lastError: string | null = null
  private lastConnAt: number | null = null
  private consecutiveFailures = 0
  private running = false
  private pollAbort: AbortController | null = null
  private pollLoopPromise: Promise<void> | null = null

  /** B3 阶段接入;未注入时 inbound 仅落 disk / console */
  private emitInternal: InternalEmit | null = null

  constructor(options: WeixinAdapterOptions) {
    this.opts = {
      accountId: options.accountId,
      token: options.token,
      baseUrl: options.baseUrl ?? 'https://ilinkai.weixin.qq.com',
      cdnBaseUrl: options.cdnBaseUrl ?? WEIXIN_CDN_BASE_URL,
      dmPolicy: options.dmPolicy ?? 'pairing',
      groupPolicy: options.groupPolicy ?? 'disabled',
      allowFrom: options.allowFrom ?? [],
      groupAllowFrom: options.groupAllowFrom ?? [],
      globalAllowAll: options.globalAllowAll ?? false,
      mediaDir: options.mediaDir ?? WEIXIN_MEDIA_DIR,
      fetchImpl: options.fetchImpl,
    }
    const clientOpts: ILinkClientOptions = {
      baseUrl: this.opts.baseUrl,
      token: this.opts.token,
      fetchImpl: this.opts.fetchImpl,
    }
    this.client = new ILinkClient(clientOpts)
  }

  // ─── 状态管理 ────────────────────────────────────────────────

  state(): AdapterState { return this._state }
  status(): AdapterStatus {
    return {
      state: this._state,
      lastError: this.lastError,
      lastConnAt: this.lastConnAt,
      consecutiveFailures: this.consecutiveFailures,
    }
  }

  onStatus(listener: StatusListener): () => void {
    this.statusListeners.add(listener)
    return () => this.statusListeners.delete(listener)
  }

  private setState(s: AdapterState, err: string | null = null): void {
    this._state = s
    if (err) this.lastError = err
    if (s === 'connected') {
      this.lastConnAt = Date.now()
      this.lastError = null
    }
    for (const l of this.statusListeners) {
      try { l(this.status()) } catch { /* listener error ignored */ }
    }
  }

  /** B3 阶段注入事件派发器 */
  setEmitter(emit: InternalEmit): void {
    this.emitInternal = emit
  }

  /** 给 B2 / B3 用的访问器 */
  getClient(): ILinkClient { return this.client }
  getContextStore(): ContextTokenStore { return this.contextStore }
  getTypingCache(): TypingTicketCache { return this.typingCache }
  getAccountId(): string { return this.opts.accountId }
  getBaseUrl(): string { return this.opts.baseUrl }
  getCdnBaseUrl(): string { return this.opts.cdnBaseUrl }
  getDmPolicy(): DmPolicy { return this.opts.dmPolicy }
  getGroupPolicy(): GroupPolicy { return this.opts.groupPolicy }
  getAllowFrom(): string[] { return this.opts.allowFrom }
  getGroupAllowFrom(): string[] { return this.opts.groupAllowFrom }
  getGlobalAllowAll(): boolean { return this.opts.globalAllowAll }

  // ─── connect / disconnect ─────────────────────────────────────

  async connect(): Promise<boolean> {
    if (this._state === 'connected' || this._state === 'connecting') return true
    this.setState('connecting')
    try {
      this.lock = await AccountLock.acquire(this.opts.token)
    } catch (err) {
      this.setState('failed', (err as Error).message)
      return false
    }
    this.running = true
    this.pollAbort = new AbortController()
    this.pollLoopPromise = this._pollLoop().catch((err) => {
      // _pollLoop 自身不 throw —— 这里是兜底
      this.lastError = (err as Error).message
      this.setState('failed', this.lastError)
    })
    this.setState('connected')
    return true
  }

  async disconnect(): Promise<void> {
    this.running = false
    if (this.pollAbort) {
      try { this.pollAbort.abort() } catch { /* ignore */ }
      this.pollAbort = null
    }
    if (this.pollLoopPromise) {
      try { await this.pollLoopPromise } catch { /* loop should swallow */ }
      this.pollLoopPromise = null
    }
    this.debounce.flushAll(() => { /* drop */ })
    this.typingCache.destroy()
    this.dedup.destroy()
    if (this.lock) {
      try { await this.lock.release() } catch { /* ignore */ }
      this.lock = null
    }
    this.setState('disconnected')
  }

  /** 暴露 iLinkConfig 给上层 setup wizard */
  static hashToken(token: string): string {
    return createHash('sha256').update(token).digest('hex').slice(0, 16)
  }

  // ─── poll loop ───────────────────────────────────────────────

  private async _pollLoop(): Promise<void> {
    let syncBuf = await this.syncStore.load(this.opts.accountId)
    let timeoutMs = LONG_POLL_TIMEOUT_MS
    while (this.running) {
      let response: Awaited<ReturnType<ILinkClient['getUpdates']>>
      try {
        response = await this.client.getUpdates(syncBuf, timeoutMs, this.pollAbort?.signal)
      } catch (err) {
        // AbortError 是 graceful shutdown
        if (err instanceof Error && (err.name === 'AbortError' || /aborted/i.test(err.message))) {
          return
        }
        this.consecutiveFailures += 1
        this.lastError = (err as Error).message
        if (this.consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) {
          this.setState('reconnecting', this.lastError)
          await this._sleep(BACKOFF_DELAY_SECONDS)
          this.consecutiveFailures = 0
        } else {
          await this._sleep(RETRY_DELAY_SECONDS)
        }
        continue
      }

      const suggested = response.longpolling_timeout_ms
      if (typeof suggested === 'number' && suggested > 0) timeoutMs = suggested

      const ret = response.ret ?? 0
      const errcode = response.errcode ?? 0
      if (ret !== 0 || errcode !== 0) {
        if (ret === ILINK_ERROR.SESSION_EXPIRED || errcode === ILINK_ERROR.SESSION_EXPIRED) {
          this.lastError = 'session expired (-14); pausing 10 minutes'
          this.setState('reconnecting', this.lastError)
          await this._sleep(SESSION_EXPIRED_BACKOFF_SECONDS)
          this.consecutiveFailures = 0
          continue
        }
        this.consecutiveFailures += 1
        this.lastError = `getUpdates failed ret=${ret} errcode=${errcode} errmsg=${response.errmsg ?? ''}`
        if (this.consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) {
          this.setState('reconnecting', this.lastError)
          await this._sleep(BACKOFF_DELAY_SECONDS)
          this.consecutiveFailures = 0
        } else {
          await this._sleep(RETRY_DELAY_SECONDS)
        }
        continue
      }

      this.consecutiveFailures = 0
      const newBuf = response.get_updates_buf
      if (newBuf) {
        syncBuf = newBuf
        try { await this.syncStore.save(this.opts.accountId, syncBuf) } catch { /* disk only */ }
      }

      const msgs = response.msgs ?? []
      // 并发派发,互不阻塞
      for (const m of msgs) {
        // 异步,不等待
        this._processMessageSafe(m).catch(() => { /* already swallowed */ })
      }
    }
  }

  private async _sleep(seconds: number): Promise<void> {
    if (seconds <= 0) return
    await new Promise<void>((resolve) => {
      const tick = () => {
        if (!this.running || this.pollAbort?.signal.aborted) {
          resolve()
          return
        }
        const t = setTimeout(resolve, 1000)
        t.unref?.()
      }
      if (!this.running || this.pollAbort?.signal.aborted) {
        resolve()
        return
      }
      const t = setTimeout(tick, 1000)
      t.unref?.()
    })
  }

  // ─── per-message 处理 ───────────────────────────────────────

  private async _processMessageSafe(msg: ILinkInboundMessageT): Promise<void> {
    try {
      await this._processMessage(msg)
    } catch (err) {
      this.lastError = (err as Error).message
      // 不 throw — 阻止一条坏消息杀掉整个 poll loop
    }
  }

  private async _processMessage(msg: ILinkInboundMessageT): Promise<void> {
    const senderId = (msg.from_user_id ?? '').trim()
    if (!senderId) return
    if (senderId === this.opts.accountId) return  // 自己发的消息

    const messageId = (msg.message_id ?? '').trim()
    if (messageId && this.dedup.isDuplicate(messageId)) return

    const { chatType, chatId } = guessChatType(msg, this.opts.accountId)
    if (!chatId) return

    const access = evaluateAccessPolicy({
      chatType,
      senderId,
      chatId,
      dmPolicy: this.opts.dmPolicy,
      groupPolicy: this.opts.groupPolicy,
      allowFrom: this.opts.allowFrom,
      groupAllowFrom: this.opts.groupAllowFrom,
      globalAllowAll: this.opts.globalAllowAll,
    })
    if (!access.allowed) return

    // context token 持久化
    const contextToken = (msg.context_token ?? '').trim() || null
    if (contextToken) {
      try { await this.contextStore.set(this.opts.accountId, senderId, contextToken) } catch { /* disk only */ }
    }

    // 异步预热 typing ticket
    if (contextToken) {
      void this._refreshTypingTicket(senderId, contextToken).catch(() => { /* ignore */ })
    }

    // 抽取文本 + 媒体
    const text = this._extractText(msg.item_list)
    const mediaPaths: string[] = []
    const mediaTypes: string[] = []
    for (const item of msg.item_list) {
      await this._collectMedia(item, mediaPaths, mediaTypes)
      const refItem = (msg.item_list[0] as unknown as { ref_msg?: { message_item?: unknown } })?.ref_msg?.message_item
      if (refItem && typeof refItem === 'object') {
        await this._collectMedia(refItem as ILinkItemT, mediaPaths, mediaTypes)
      }
    }

    if (!text && mediaPaths.length === 0) return

    // 内容指纹二次去重
    if (text) {
      const contentKey = `content:${senderId}:${createHash('md5').update(text).digest('hex')}`
      if (this.dedup.isDuplicate(contentKey)) return
    }

    const internal: InternalWeixinMessage = {
      accountId: this.opts.accountId,
      chatId,
      chatType,
      senderId,
      text,
      mediaPaths,
      mediaTypes,
      messageId: messageId,
      contextToken,
      raw: msg,
    }

    const sessionKey = `weixin:${this.opts.accountId}:${chatType}:${chatId}`
    // 文本走 debounce,媒体直接 flush
    if (text && mediaPaths.length === 0) {
      this.debounce.enqueue(sessionKey, {
        text,
        mediaPaths: [],
        mediaTypes: [],
      }, (item) => {
        this._emit({
          ...internal,
          text: item.text,
          mediaPaths: item.mediaPaths,
          mediaTypes: item.mediaTypes,
        })
      })
    } else {
      this._emit(internal)
    }
  }

  private _emit(msg: InternalWeixinMessage): void {
    if (this.emitInternal) {
      try { this.emitInternal(msg) } catch { /* emitter must not throw */ }
    }
  }

  private async _refreshTypingTicket(userId: string, contextToken: string | null): Promise<void> {
    if (this.typingCache.get(userId)) return
    const res = await this.client.getConfig(userId, contextToken)
    if (res.typing_ticket) {
      this.typingCache.set(userId, res.typing_ticket)
    }
  }

  private _extractText(items: ILinkItemT[]): string {
    const parts: string[] = []
    for (const item of items as unknown as Array<{ type: number; text_item?: { text?: string } }>) {
      if (item.type === ITEM_TEXT) {
        const t = (item.text_item?.text ?? '').trim()
        if (t) parts.push(t)
      }
    }
    return parts.join('\n').trim()
  }

  private async _collectMedia(item: ILinkItemT, out: string[], types: string[]): Promise<void> {
    const it = item as unknown as {
      type: number
      image_item?: { aeskey?: string; media?: { encrypt_query_param?: string; full_url?: string; aes_key?: string } }
      video_item?: { media?: { encrypt_query_param?: string; full_url?: string; aes_key?: string } }
      file_item?: { file_name?: string; media?: { encrypt_query_param?: string; full_url?: string; aes_key?: string } }
      voice_item?: { text?: string; media?: { encrypt_query_param?: string; full_url?: string; aes_key?: string } }
    }
    try {
      if (it.type === ITEM_IMAGE) {
        const path = await this._downloadMediaItem('image', it.image_item?.media, it.image_item?.aeskey, 'image/jpeg', '.jpg')
        if (path) { out.push(path); types.push('image/jpeg') }
      } else if (it.type === ITEM_VIDEO) {
        const path = await this._downloadMediaItem('video', it.video_item?.media, undefined, 'video/mp4', '.mp4')
        if (path) { out.push(path); types.push('video/mp4') }
      } else if (it.type === ITEM_FILE) {
        const filename = (it.file_item?.file_name ?? 'document.bin').replace(/[^\w.\-]/g, '_')
        const mime = mimeForMediaType(ITEM_FILE, filename)
        const path = await this._downloadMediaItem('file', it.file_item?.media, undefined, mime, filename)
        if (path) { out.push(path); types.push(mime) }
      } else if (it.type === ITEM_VOICE) {
        if (it.voice_item?.text) return  // 有文字转写就不下载音频
        const path = await this._downloadMediaItem('voice', it.voice_item?.media, undefined, 'audio/silk', '.silk')
        if (path) { out.push(path); types.push('audio/silk') }
      }
    } catch (err) {
      this.lastError = `_collectMedia failed: ${(err as Error).message}`
    }
  }

  private async _downloadMediaItem(
    kind: 'image' | 'video' | 'file' | 'voice',
    media: { encrypt_query_param?: string; full_url?: string; aes_key?: string } | undefined,
    fallbackAesKey: string | undefined,
    _mime: string,
    ext: string,
  ): Promise<string | null> {
    if (!media) return null
    const aesKey = media.aes_key ?? fallbackAesKey
    let buffer: Buffer
    if (media.encrypt_query_param) {
      const url = `${this.opts.cdnBaseUrl}/download?encrypted_query_param=${encodeURIComponent(media.encrypt_query_param)}`
      const res = await fetch(url, { signal: this.pollAbort?.signal })
      if (!res.ok) throw new Error(`cdn download HTTP ${res.status}`)
      buffer = Buffer.from(await res.arrayBuffer())
    } else if (media.full_url) {
      assertSafeCdnUrl(media.full_url)
      const res = await fetch(media.full_url, { signal: this.pollAbort?.signal })
      if (!res.ok) throw new Error(`cdn full_url HTTP ${res.status}`)
      buffer = Buffer.from(await res.arrayBuffer())
    } else {
      return null
    }
    if (aesKey) {
      buffer = decryptAes128Ecb(buffer, aesKey)
    }
    const hash = createHash('sha1').update(buffer).digest('hex').slice(0, 12)
    await mkdir(this.opts.mediaDir, { recursive: true })
    const filename = `${Date.now()}-${hash}${ext.startsWith('.') ? ext : '.' + ext}`
    const path = join(this.opts.mediaDir, filename)
    await writeFile(path, buffer)
    return path
  }
}
