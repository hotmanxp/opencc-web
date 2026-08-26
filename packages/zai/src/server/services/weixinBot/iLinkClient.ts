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
 *
 * B7.6:跟 hermes-agent gateway/platforms/weixin.py 对齐 — AuthorizationType +
 * X-WECHAT-UIN header + base_info.channel_version 是 iLink 服务端 session
 * 校验必需字段。原实现 zai iLinkClient 漏了这三个,导致 getUpdates 返 -14
 * SESSION_EXPIRED。
 */
import { createHash, randomBytes } from 'node:crypto'
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
  /** B7.6:QR confirmed 返的 ilink_user_id,getUpdates 用来激活/绑定 session */
  ilinkUserId?: string
}

export class ILinkClient {
  private readonly baseUrl: string
  private readonly token: string
  private readonly fetchImpl: typeof fetch
  private readonly defaultTimeoutMs: number
  private readonly ilinkUserId: string | undefined
  /** diag:第一次 getUpdates 时打 body/headers,后续不再打 */
  private dumpedGetUpdatesHeaders = false
  /**
   * 稳定 X-WECHAT-UIN:hermes-agent weixin.py:201 的 "random 4-byte b64"
   * 注释里 zai 之前误解成每请求重 random,实际 hermes 那个 random 是模块级
   * 单值(zai 复现后实测每请求 random → iLink 把每次长轮询当成不同 client,
   * session 永远绑不上 user → ret=0 msgs=0,几十个 cycle 后被 iLink 主动
   * -14 session timeout)。改成构造时 hash(token) 生成一次,跨 35s 长轮询
   * 复用同一个 UIN,iLink 才能把同一 bot 的多次请求关联到同一个 session。
   */
  private readonly stableWechatUin: string

  constructor(opts: ILinkClientOptions) {
    this.baseUrl = opts.baseUrl.replace(/\/$/, '')
    this.token = opts.token
    this.fetchImpl = opts.fetchImpl ?? fetch
    this.defaultTimeoutMs = opts.defaultTimeoutMs ?? 15_000
    this.ilinkUserId = opts.ilinkUserId
    // hash(token) → 4-byte → b64(ascii of uint32),与 hermes 的格式一致但跨请求稳定
    const h = createHash('sha256').update(opts.token).digest()
    const u32 = h.readUInt32BE(0)
    this.stableWechatUin = Buffer.from(String(u32), 'utf-8').toString('base64')
  }

  /**
   * B7.6:iLink 服务端对 base_info 期望的是 { channel_version: '2.2.0' },
   * 不是 zai 之前用的 { ilink_app_id, ilink_app_client_version }。后者导致
   * getUpdates 返 -14 session expired。
   */
  private _baseInfo(): Record<string, string> {
    return { channel_version: '2.2.0' }
  }

  /**
   * B7.6:hermes-agent gateway/platforms/weixin.py:201 用 random 4-byte b64
   * 模拟微信 UIN,iLink 服务端 session 校验需要这个 header。
   */
  private _randomWechatUin(): string {
    const buf = randomBytes(4)
    // 转成与 hermes 等价的 str -> b64:big-endian unsigned int to ascii base64
    // hermes: struct.unpack('>I', secrets.token_bytes(4))[0] -> str -> b64
    const n = buf.readUInt32BE(0)
    return Buffer.from(String(n), 'utf-8').toString('base64')
  }

  /** 通用 POST。所有 iLink 端点除 getQrcodeStatus 外都走 POST */
  private async post<T>(
    endpoint: string,
    payload: Record<string, unknown>,
    timeoutMs?: number,
    signal?: AbortSignal,
    /** 额外 headers。getUpdates 用它传 X-WECHAT-UIN(iLink sendmessage 拒) */
    extraHeaders?: Record<string, string>,
  ): Promise<T> {
    const body = JSON.stringify({ ...payload, base_info: this._baseInfo() })
    const url = `${this.baseUrl}/${endpoint}`
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), timeoutMs ?? this.defaultTimeoutMs)
    if (signal) {
      // 外部 cancel 时透传
      if (signal.aborted) controller.abort()
      else signal.addEventListener('abort', () => controller.abort(), { once: true })
    }
    try {
      const headers: Record<string, string> = {
        'Content-Type': 'application/json',
        // B7.6:iLink 用 AuthorizationType 区分 token 类型(bot / user),
        // 不设会直接 -14。详见 hermes-agent weixin.py:213。
        AuthorizationType: 'ilink_bot_token',
        Authorization: `Bearer ${this.token}`,
        // BUG(2026-08-19):iLink-App-Id / iLink-App-ClientVersion / X-WECHAT-UIN
        // 这三个 header 仅 getupdates 端点合法 —— 实测 sendmessage 端点收到
        // 任意一个都返 ret:-2 "invalid arguments",bot 出站被静默拒。提到
        // getUpdates 专属 header(extraHeaders),其它端点不发送。
      }
      if (extraHeaders) Object.assign(headers, extraHeaders)
      // diag:第一次 getUpdates 时把实际发出的 body + headers 全打出来,
      // 排查"session 活着但 msgs=0"是哪个字段不对。
      if (endpoint === 'ilink/bot/getupdates' && !this.dumpedGetUpdatesHeaders) {
        this.dumpedGetUpdatesHeaders = true
        console.warn(`[weixin.ilinkClient] first getUpdates body=${body}`)
        console.warn(`[weixin.ilinkClient] first getUpdates headers=${JSON.stringify(headers)}`)
      }
      const res = await this.fetchImpl(url, {
        method: 'POST',
        headers,
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
        {
          get_updates_buf: syncBuf,
          // 2026-08-19:实测 iLink 路由需要 bot_id(来自 iLink 自己的 bot 身份
          // 识别,不是 user_id)。不传 bot_id 时 iLink 把 getUpdates 视为匿名
          // pull,绑定不到具体 bot,msgs 永远 0。user_id 仍带 —— 用来给 iLink
          // 指明"绑定的 WeChat user",配合 bot_id 一起做 session routing。
          bot_id: this.token.split(':')[0] ?? this.token,  // token 格式 <bot_id>:<hex>
          ...(this.ilinkUserId ? { user_id: this.ilinkUserId } : {}),
        },
        timeoutMs,
        signal,
        // BUG(2026-08-19):这三个 header 仅 getupdates 端点合法 —— 其它端点
        // 收到任意一个都返 ret:-2 "invalid arguments",bot 出站被静默拒。
        {
          'X-WECHAT-UIN': this.stableWechatUin,
          'iLink-App-Id': 'bot',
          'iLink-App-ClientVersion': '0x020200',
        },
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

  async getBotQrcode(botType = 3): Promise<ILinkGetBotQrcodeResponseT> {
    // iLink server 实际 schema: bot_type 是 URL query 参数,不是 JSON body。
    // 不传或传错位置都会返回 {"err_msg":"missing bot_type","ret":1}。
    // 详见 hermes-agent gateway/platforms/weixin.py:1022。
    const raw = await this.post<unknown>(
      `ilink/bot/get_bot_qrcode?bot_type=${botType}`,
      {},
    )
    return ILinkGetBotQrcodeResponse.parse(raw)
  }

  async getQrcodeStatus(qrcodeId: string, botType = 3): Promise<ILinkGetQrcodeStatusResponseT> {
    // iLink 真实 schema:query 参数是 `qrcode=<id>`(不是 `qrcode_id=`),iLink 用这个
    // 区分 QR 流程的 token 与 long-poll 的 sync_buf 字段。
    // 错传 `qrcode_id` 会让 iLink 返回 {"ret":1} 不带 errmsg,无从调试。
    // 详见 hermes-agent gateway/platforms/weixin.py:1061。
    //
    // B7.5:这个端点是 iLink 端 long-poll 行为 — 真实测量 server 会 hold 住
    // 等待用户扫码,实测 16s 才返回 {"ret":0,"status":"wait"}。原来 10s
    // timeout 永远 abort,前端 poll 每次都 500,链路整个断。改 35s 与
    // getUpdates 长轮询同档,确保 wait→scanned→confirmed 状态变更都能收到。
    const raw = await this.get<unknown>(
      `ilink/bot/get_qrcode_status?qrcode=${encodeURIComponent(qrcodeId)}&bot_type=${botType}`,
      35_000,
    )
    return ILinkGetQrcodeStatusResponse.parse(raw)
  }

  /**
   * 把已经 AES-128-ECB 加密的 ciphertext 上传到 iLink 提供的 CDN URL。
   * 抽到 client 内部是为了让 server 端的 fetch 注入(test-mock)在此也生效,
   * 避免直接调全局 fetch。
   */
  async uploadCiphertext(
    uploadUrl: string,
    ciphertext: Uint8Array,
  ): Promise<{ xEncryptedParam: string | null }> {
    return await this.fetchImpl(uploadUrl, {
      method: 'POST',
      body: ciphertext as unknown as BodyInit,
      headers: { 'Content-Type': 'application/octet-stream' },
    }).then(async (res) => {
      if (res.status !== 200) {
        const raw = await res.text().catch(() => '')
        throw new Error(`cdn upload HTTP ${res.status}: ${raw.slice(0, 200)}`)
      }
      const xEncryptedParam = res.headers.get('x-encrypted-param')
      return { xEncryptedParam }
    })
  }

  static defaultBaseUrl(): string {
    return ILINK_BASE_URL
  }
}
