/**
 * WeixinBotManager — 把 WeixinAdapter 接入 zai eventBus 的双向桥。
 *
 * 启动:
 *   1. 读 zaiSettings.weixinBot,决定 enabled / disabled
 *   2. 启用则 create WeixinAdapter → adapter.setEmitter(emitInternalWeixin)
 *      → adapter.connect() 启动 long-poll
 *   3. 订阅 eventBus 上的 `weixin:<acct>:<chatType>:<chatId>` session 的
 *      runtime.delta / runtime.done,把 agent 输出镜像给 iLink sendmessage
 *
 * 启动失败 best-effort: 不 throw,只 warn,不破坏 zai 主进程;manager 后续仍
 * 可被 reload() 重启。
 *
 * 出站策略(send-final-only):
 *   WeChat 客户端不支持 message editing,iLink 端也没暴露 edit API。SSE 推到
 *   Web UI 的流式体验保留,微信侧只看到最终分块结果。runtime.delta 触发
 *   内部 buffer 累积 + sendTyping('start');runtime.done 触发 sendText(
 *   buffer) + sendTyping('stop')。
 *
 * 关闭:
 *   1. unsubscribe eventBus
 *   2. adapter.disconnect() (in-flight fetch abort + lock release)
 *   3. clear subscriptions
 */
import { eventBus } from '../eventBus.js'
import type { ServerEvent } from '../../../shared/events.js'
import { WeixinAdapter, type InternalWeixinMessage } from './WeixinAdapter.js'
import { WeixinBotSettingsSchema, type WeixinBotSettings } from '../../../shared/weixin.js'
import { ensureWeixinDirs } from '../paths.js'
import { writeFile, mkdir, readFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { WEIXIN_ACCOUNTS_DIR } from './paths-internal.js'
import QRCode from 'qrcode'

export type WeixinManagerState =
  | 'disabled'
  | 'unconfigured'
  | 'failed'
  | 'connecting'
  | 'connected'
  | 'disconnected'

export interface WeixinStatus {
  configured: boolean
  enabled: boolean
  state: WeixinManagerState
  accountId?: string
  lastError?: string
  lastConnAt?: number
}

export interface WeixinBotManagerDeps {
  /** Read settings — zai patch 默认从 settingStore 读 */
  getSettings: () => WeixinBotSettings | null
  /** Create new WeixinAdapter (测试可注入) */
  createAdapter: (settings: WeixinBotSettings) => WeixinAdapter
}

const DEFAULT_DEPS: WeixinBotManagerDeps = {
  getSettings: () => null,
  createAdapter: (settings) => new WeixinAdapter({
    accountId: settings.accountId ?? '',
    token: settings.token ?? '',
    baseUrl: settings.baseUrl,
    cdnBaseUrl: settings.cdnBaseUrl,
    dmPolicy: settings.dmPolicy,
    groupPolicy: settings.groupPolicy,
    allowFrom: settings.allowFrom,
    groupAllowFrom: settings.groupAllowFrom,
  }),
}

export class WeixinBotManager {
  private adapter: WeixinAdapter | null = null
  private busUnsub: (() => void) | null = null
  private statusListeners = new Set<(s: WeixinStatus) => void>()
  private _state: WeixinManagerState = 'unconfigured'
  private lastError: string | null = null
  private lastConnAt: number | null = null
  /** runtime.delta 缓冲:runtimes 流式输出按 sessionId 累积, runtime.done 触发 send */
  private outboundBuffers = new Map<string, { chatId: string; text: string }>()
  /** QR 登录当前活动状态 */
  private activeSetup: { qrcodeId: string; qrcodeUrl: string; retries: number } | null = null

  constructor(private deps: WeixinBotManagerDeps = DEFAULT_DEPS) {}

  state(): WeixinManagerState { return this._state }
  status(): WeixinStatus {
    return {
      configured: !!this.adapter,
      enabled: this._state !== 'disabled' && this._state !== 'unconfigured',
      state: this._state,
      accountId: this.adapter?.getAccountId(),
      lastError: this.lastError ?? undefined,
      lastConnAt: this.lastConnAt ?? undefined,
    }
  }

  onStatus(l: (s: WeixinStatus) => void): () => void {
    this.statusListeners.add(l)
    return () => this.statusListeners.delete(l)
  }

  private emitStatus(): void {
    const s = this.status()
    for (const l of this.statusListeners) {
      try { l(s) } catch { /* ignore */ }
    }
  }

  private setState(s: WeixinManagerState, err?: string | null): void {
    this._state = s
    if (err) this.lastError = err
    if (s === 'connected') this.lastConnAt = Date.now()
    this.emitStatus()
  }

  /** 启动 weixin bot(best-effort) */
  async start(): Promise<void> {
    const settings = this.deps.getSettings()
    if (!settings) {
      this.setState('unconfigured')
      return
    }
    const parsed = WeixinBotSettingsSchema.safeParse(settings)
    if (!parsed.success) {
      this.setState('failed', `invalid settings: ${parsed.error.message}`)
      return
    }
    const s = parsed.data
    if (!s.enabled) {
      this.setState('disabled')
      return
    }
    if (!s.accountId || !s.token) {
      this.setState('failed', 'accountId/token missing')
      return
    }
    try {
      await ensureWeixinDirs()
    } catch (err) {
      this.setState('failed', `ensureWeixinDirs failed: ${(err as Error).message}`)
      return
    }

    this.setState('connecting')
    try {
      this.adapter = this.deps.createAdapter(s)
      this.adapter.setEmitter((internal) => this._onInbound(internal))
      const ok = await this.adapter.connect()
      if (!ok) {
        this.lastError = this.adapter.status().lastError ?? 'connect failed'
        this.setState('failed', this.lastError)
        return
      }
      this._subscribeOutbound()
      this.setState('connected')
    } catch (err) {
      this.setState('failed', (err as Error).message)
    }
  }

  async stop(): Promise<void> {
    if (this.busUnsub) {
      try { this.busUnsub() } catch { /* ignore */ }
      this.busUnsub = null
    }
    this.outboundBuffers.clear()
    if (this.adapter) {
      try { await this.adapter.disconnect() } catch { /* ignore */ }
      this.adapter = null
    }
    this.setState('disconnected')
  }

  /** 重新连接(用户改 settings 后) */
  async reload(): Promise<void> {
    await this.stop()
    await this.start()
  }

  /** 上传凭据(用于 QR 登录) */
  async saveAccount(accountId: string, token: string, baseUrl?: string): Promise<void> {
    await ensureWeixinDirs()
    const safe = accountId.replace(/[^a-zA-Z0-9_@.-]/g, '_')
    const path = join(WEIXIN_ACCOUNTS_DIR, `${safe}.json`)
    const payload = { accountId, token, baseUrl: baseUrl ?? 'https://ilinkai.weixin.qq.com', createdAt: new Date().toISOString() }
    await writeFile(path, JSON.stringify(payload, null, 2), { mode: 0o600 })
  }

  async loadAccount(accountId: string): Promise<{ token: string; baseUrl?: string } | null> {
    const safe = accountId.replace(/[^a-zA-Z0-9_@.-]/g, '_')
    const path = join(WEIXIN_ACCOUNTS_DIR, `${safe}.json`)
    if (!existsSync(path)) return null
    try {
      const raw = JSON.parse(await readFile(path, 'utf-8')) as { token: string; baseUrl?: string }
      return { token: raw.token, baseUrl: raw.baseUrl }
    } catch {
      return null
    }
  }

  // ─── 内部:入站派发 ──────────────────────────────────────────

  private _onInbound(msg: InternalWeixinMessage): void {
    if (!this.adapter) return
    const sessionId = `weixin:${msg.accountId}:${msg.chatType}:${msg.chatId}`
    try {
      eventBus.emit({
        type: 'weixin.inbound',
        sessionId,
        accountId: msg.accountId,
        chatType: msg.chatType,
        chatId: msg.chatId,
        senderId: msg.senderId,
        text: msg.text,
        mediaPaths: msg.mediaPaths,
        mediaTypes: msg.mediaTypes,
        messageId: msg.messageId,
        contextToken: msg.contextToken,
        raw: msg.raw,
      } as unknown as ServerEvent)
    } catch (err) {
      this.lastError = `eventBus.emit weixin.inbound failed: ${(err as Error).message}`
    }
  }

  // ─── 出站镜像:订阅 runtime.delta / runtime.done ─────────────

  private _subscribeOutbound(): void {
    if (!this.adapter) return
    const accountId = this.adapter.getAccountId()
    // 订阅:任何 sessionId 命中 weixin:<accountId>:<chatType>:<chatId> 的
    // runtime 事件。B3 阶段 chatId 我们从 sessionId 末段解析(略 chatType)。
    // 用 subscribeTopics 配合 sid prefix 比较稳。
    this.busUnsub = eventBus.subscribe((event: ServerEvent) => {
      try {
        if (event.type === 'runtime.delta') {
          const sid = (event as { sessionId?: string }).sessionId
          if (!sid || !sid.startsWith(`weixin:${accountId}:`)) return
          const chatId = sid.split(':').slice(3).join(':')
          const existing = this.outboundBuffers.get(sid)
          if (existing) {
            existing.text += (event as { delta?: string }).delta ?? ''
          } else {
            this.outboundBuffers.set(sid, { chatId, text: (event as { delta?: string }).delta ?? '' })
          }
        } else if (event.type === 'runtime.done') {
          const sid = (event as { sessionId?: string }).sessionId
          if (!sid || !sid.startsWith(`weixin:${accountId}:`)) return
          const buf = this.outboundBuffers.get(sid)
          this.outboundBuffers.delete(sid)
          if (!this.adapter || !buf) return
          if (buf.text) {
            void this.adapter.sendText(buf.chatId, buf.text).catch(() => { /* logged in adapter */ })
          }
          void this.adapter.sendTyping(buf.chatId, 'stop').catch(() => { /* ignore */ })
        } else if (event.type === 'runtime.started') {
          const sid = (event as { sessionId?: string }).sessionId
          if (!sid || !sid.startsWith(`weixin:${accountId}:`)) return
          const chatId = sid.split(':').slice(3).join(':')
          if (this.adapter) {
            void this.adapter.sendTyping(chatId, 'start').catch(() => { /* ignore */ })
          }
        }
      } catch (err) {
        this.lastError = `outbound subscribe err: ${(err as Error).message}`
      }
    })
  }

  /** 给 B4 / 测试用:暴露 adapter */
  getAdapter(): WeixinAdapter | null { return this.adapter }

  // ─── QR 登录 wizard (B5) ─────────────────────────────────────

  /** 启动 QR 登录流程 —— 调 iLink getBotQrcode,服务端渲染 QR PNG data URL */
  async startSetup(): Promise<{ qrcodeId: string; qrcodeUrl: string; pollUrl: string } | null> {
    if (!this.adapter) {
      // 自动创建 adapter(不需要 connect,只是为了 iLink client)。
      // settings 缺失时使用 dummy token,实际 QR 拿到后我们覆盖保存。
      const dummySettings: WeixinBotSettings = {
        enabled: true,
        accountId: 'pending',
        token: 'pending',
        baseUrl: 'https://ilinkai.weixin.qq.com',
        cdnBaseUrl: 'https://novac2c.cdn.weixin.qq.com/c2c',
        dmPolicy: 'pairing',
        groupPolicy: 'disabled',
        allowFrom: [],
        groupAllowFrom: [],
        textBatchDelaySeconds: 3.0,
        textBatchSplitDelaySeconds: 5.0,
        sendChunkDelaySeconds: 1.5,
        sendChunkRetries: 4,
        rateLimitCircuitThreshold: 1,
        rateLimitCircuitOpenSeconds: 30.0,
      }
      const settings = this.deps.getSettings() ?? dummySettings
      try {
        this.adapter = this.deps.createAdapter(settings)
      } catch {
        return null
      }
    }
    const iLink = this.adapter.getClient()
    const result = await iLink.getBotQrcode()
    // iLink 真实 schema:`qrcode` (ID) + `qrcode_img_content` (URL);hermes 旧实现用
    // `qrcode_id` / `qrcode_url`,都接受,normalize 到统一字段。
    const qrcodeId = result.qrcode ?? result.qrcode_id
    const scanUrl = result.qrcode_img_content ?? result.qrcode_url ?? result.qrcode_img_url
    if (!qrcodeId || !scanUrl) return null
    // 服务端用 `qrcode` npm 把 liteapp URL 渲染成 PNG data URL。
    // 直接 <img src={scanUrl}> 会显示 liteapp HTML(扫码确认页),不是 QR 图;
    // 改用 data:image/png;base64,... 让浏览器原生渲染 QR。
    // 详见 hermes-agent gateway/platforms/weixin.py:1065 同样模式。
    let qrcodeUrl: string
    try {
      qrcodeUrl = await QRCode.toDataURL(scanUrl, {
        errorCorrectionLevel: 'M',
        margin: 2,
        width: 240,
        color: { dark: '#000000', light: '#FFFFFF' },
      })
    } catch (err) {
      this.lastError = `QRCode.toDataURL failed: ${(err as Error).message}`
      return null
    }
    this.activeSetup = {
      qrcodeId,
      qrcodeUrl,
      retries: 0,
    }
    return {
      qrcodeId,
      qrcodeUrl,
      pollUrl: `/api/weixin/setup/poll?qrcodeId=${encodeURIComponent(qrcodeId)}`,
    }
  }

  /**
   * 轮询 QR 状态。iLink 返回 confirmed 时,自动 saveAccount + reload。
   * expired 时,自动重新拉(最多 3 次,失败超限放弃)。
   */
  async pollSetup(qrcodeId: string): Promise<{
    status: 'waiting' | 'scanned' | 'confirmed' | 'expired' | 'gone'
    accountId?: string
    baseUrl?: string
  }> {
    if (!this.adapter) return { status: 'gone' }
    const iLink = this.adapter.getClient()
    const result = await iLink.getQrcodeStatus(qrcodeId)
    // iLink 真实 status 字段值: 'wait' / 'scaned' (少一个 n) / 'scaned_but_redirect' / 'expired' / 'confirmed'
    // normalize 到 zai 内部统一值。
    const rawStatus = result.status ?? 'wait'
    const status: 'waiting' | 'scanned' | 'expired' | 'confirmed' =
      rawStatus === 'wait' ? 'waiting' :
      rawStatus === 'scaned' || rawStatus === 'scaned_but_redirect' ? 'scanned' :
      rawStatus
    // iLink confirmed 时返回 `ilink_bot_id` + `bot_token` + `baseurl` (iLink 风格);
    // 兼容 hermes 旧 schema 的 `account_id` + `token` + `base_url`。
    const accountId = result.ilink_bot_id ?? result.account_id
    const token = result.bot_token ?? result.token
    const baseUrl = result.baseurl ?? result.base_url
    if (status === 'confirmed' && accountId && token) {
      await this.saveAccount(accountId, token, baseUrl)
      this.activeSetup = null
      await this.reload()
      return { status: 'confirmed', accountId, baseUrl }
    }
    if (status === 'expired') {
      if (this.activeSetup && this.activeSetup.retries < 3) {
        const fresh = await iLink.getBotQrcode()
        const freshId = fresh.qrcode ?? fresh.qrcode_id
        const freshScan = fresh.qrcode_img_content ?? fresh.qrcode_url
        if (freshId && freshScan) {
          let freshQrPng: string | null = null
          try {
            freshQrPng = await QRCode.toDataURL(freshScan, {
              errorCorrectionLevel: 'M', margin: 2, width: 240,
            })
          } catch { /* ignore */ }
          if (freshQrPng) {
            this.activeSetup = {
              qrcodeId: freshId,
              qrcodeUrl: freshQrPng,
              retries: this.activeSetup.retries + 1,
            }
            return { status: 'expired' }
          }
        }
      }
      this.activeSetup = null
      return { status: 'expired' }
    }
    return { status, accountId, baseUrl }
  }

  /** 取消 QR 登录 */
  cancelSetup(): void {
    this.activeSetup = null
  }

  getActiveSetup(): { qrcodeId: string; qrcodeUrl: string; retries: number } | null {
    return this.activeSetup
  }
}

// 单例 — 与 zai 主进程同进程启动,initAgentRuntime 末尾调用 weixinBotManager.start()
let _instance: WeixinBotManager | null = null
export function getWeixinBotManager(): WeixinBotManager {
  if (!_instance) _instance = new WeixinBotManager()
  return _instance
}

export function resetWeixinBotManagerForTests(): void {
  _instance = null
}

// re-export type for test convenience
export type { WeixinAdapter }
