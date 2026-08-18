/**
 * iLink Bot API HTTP 客户端。
 *
 * 7 个端点(getUpdates / sendMessage / sendTyping / getConfig / getUploadUrl /
 * getBotQrcode / getQrcodeStatus),全部走 iLink 自有 HTTP/JSON 接口,无 webhook。
 *
 * 设计要点:
 *   - fetch 注入:测试时 vi.fn() 替换,生产用 Node 20+ 内置 fetch。
 *   - long-poll 35s 超时:用 AbortController + setTimeout 强制 abort,避免
 *     Node fetch 默认 socket idle timeout 干扰。
 *   - 错误码解析:每个 endpoint 返回 ILinkResponse,统一检查 ret/errcode,
 *     错码语义高阶化(SESSION_EXPIRED / RATE_LIMIT)
 *   - JSON 序列化:ensure_ascii=false 兼容中文消息。
 *
 * iLink 端点列表 & 字段语义详见 iLinkTypes.ts。
 */
import { ILINK_BASE_URL } from './constants.js'
import type {
  ILinkGetUpdatesResponseT,
  ILinkSendTextPayloadT,
  ILinkSendMediaPayloadT,
  ILinkGetBotQrcodeResponseT,
  ILinkGetQrcodeStatusResponseT,
  ILinkGetConfigResponseT,
  ILinkGetUploadUrlResponseT,
} from './iLinkTypes.js'
import { ILinkGetUpdatesResponse, ILinkGetBotQrcodeResponse, ILinkGetQrcodeStatusResponse, ILinkGetConfigResponse, ILinkGetUploadUrlResponse } from './iLinkTypes.js'

export interface ILinkClientOptions {
  baseUrl: string
  token: string
  /** 测试可注入;缺省 fetch */
  fetchImpl?: typeof fetch
  /** AbortSignal 工厂;缺省 5s connect / 35s read */
  defaultTimeoutMs?: number
}

export class ILinkClient {
  private readonly baseUrl: string
  private readonly token: string
  private readonly fetchImpl: typeof fetch
  private readonly defaultTimeoutMs: number

  constructor(opts: ILinkClientOptions) {
    this.baseUrl = opts.baseUrl.replace(/\/$/, '')
    this.token = opts.token
    this.fetchImpl = opts.fetchImpl ?? fetch
    this.defaultTimeoutMs = opts.defaultTimeoutMs ?? 15_000
  }

  /** 通用 POST。所有 iLink 端点除 getQrcodeStatus 外都走 POST */
  private async post<T>(
    endpoint: string,
    payload: Record<string, unknown>,
    timeoutMs?: number,
    signal?: AbortSignal,
  ): Promise<T> {
    const body = JSON.stringify({ ...payload, base_info: { ilink_app_id: 'bot', ilink_app_client_version: '0x020200' } })
    const url = `${this.baseUrl}/${endpoint}`
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), timeoutMs ?? this.defaultTimeoutMs)
    if (signal) {
      // 外部 cancel 时透传
      if (signal.aborted) controller.abort()
      else signal.addEventListener('abort', () => controller.abort(), { once: true })
    }
    try {
      const res = await this.fetchImpl(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'iLink-App-Id': 'bot',
          'iLink-App-ClientVersion': '0x020200',
          Authorization: `Bearer ${this.token}`,
        },
        body,
        signal: controller.signal,
      })
      if (!res.ok) {
        const raw = await res.text().catch(() => '')
        throw new Error(`iLink POST ${endpoint} HTTP ${res.status}: ${raw.slice(0, 200)}`)
      }
      const json = (await res.json()) as T
      return json
    } finally {
      clearTimeout(timer)
    }
  }

  /** 通用 GET(getQrcodeStatus 用,无 base_info) */
  private async get<T>(endpoint: string, timeoutMs?: number): Promise<T> {
    const url = `${this.baseUrl}/${endpoint}`
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), timeoutMs ?? this.defaultTimeoutMs)
    try {
      const res = await this.fetchImpl(url, {
        method: 'GET',
        headers: {
          'iLink-App-Id': 'bot',
          'iLink-App-ClientVersion': '0x020200',
        },
        signal: controller.signal,
      })
      if (!res.ok) {
        const raw = await res.text().catch(() => '')
        throw new Error(`iLink GET ${endpoint} HTTP ${res.status}: ${raw.slice(0, 200)}`)
      }
      return (await res.json()) as T
    } finally {
      clearTimeout(timer)
    }
  }

  // ─── 端点实现 ────────────────────────────────────────────────

  /**
   * long-pull 拉消息,默认 35s。iLink 服务端 hold 住直到有消息或超时。
   * 返回 parsed ILinkGetUpdatesResponse,错误码仍由 ret/errcode 字段承载。
   * 抛 TimeoutError 表示正常长轮询超时(无消息),调用方应立即重试。
   */
  async getUpdates(
    syncBuf: string,
    timeoutMs: number,
    signal?: AbortSignal,
  ): Promise<ILinkGetUpdatesResponseT> {
    try {
      const raw = await this.post<unknown>(
        'ilink/bot/getupdates',
        { get_updates_buf: syncBuf },
        timeoutMs,
        signal,
      )
      return ILinkGetUpdatesResponse.parse(raw)
    } catch (err) {
      if (err instanceof Error && err.name === 'AbortError') {
        // 长轮询超时 — 视为"无消息",返回空
        return { ret: 0, errcode: 0, msgs: [], get_updates_buf: syncBuf }
      }
      throw err
    }
  }

  async sendMessage(payload: ILinkSendTextPayloadT): Promise<unknown> {
    return this.post('ilink/bot/sendmessage', payload as unknown as Record<string, unknown>)
  }

  async sendMediaMessage(payload: ILinkSendMediaPayloadT): Promise<unknown> {
    return this.post('ilink/bot/sendmessage', payload as unknown as Record<string, unknown>)
  }

  async sendTyping(
    toUserId: string,
    typingTicket: string,
    status: 1 | 2,
  ): Promise<unknown> {
    return this.post('ilink/bot/sendtyping', {
      to_user_id: toUserId,
      typing_ticket: typingTicket,
      status,
    })
  }

  async getConfig(userId: string, contextToken: string | null): Promise<ILinkGetConfigResponseT> {
    const raw = await this.post<unknown>('ilink/bot/getconfig', {
      user_id: userId,
      context_token: contextToken ?? undefined,
    })
    return ILinkGetConfigResponse.parse(raw)
  }

  async getUploadUrl(): Promise<ILinkGetUploadUrlResponseT> {
    const raw = await this.post<unknown>('ilink/bot/getuploadurl', {})
    return ILinkGetUploadUrlResponse.parse(raw)
  }

  async getBotQrcode(): Promise<ILinkGetBotQrcodeResponseT> {
    const raw = await this.post<unknown>('ilink/bot/get_bot_qrcode', {})
    return ILinkGetBotQrcodeResponse.parse(raw)
  }

  async getQrcodeStatus(qrcodeId: string): Promise<ILinkGetQrcodeStatusResponseT> {
    const raw = await this.get<unknown>(
      `ilink/bot/get_qrcode_status?qrcode_id=${encodeURIComponent(qrcodeId)}`,
      10_000,
    )
    return ILinkGetQrcodeStatusResponse.parse(raw)
  }

  static defaultBaseUrl(): string {
    return ILINK_BASE_URL
  }
}
