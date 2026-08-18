/**
 * iLink Bot API 协议契约。
 *
 * 协议参考: hermes-agent 已验证的 iLink 6+1 端点(gateway/platforms/weixin.py),
 * 翻译为 zod schema 集中在本文件,后续 iLink 协议升级只需改这一处。
 *
 * 关键字段语义:
 *   - ret / errcode: 都是 0 表示成功,iLink 同时返回两个字段;某些错码只通过
 *     其中一个字段表达(SESSION_EXPIRED=-14 / RATE_LIMIT=-2)。
 *   - context_token: iLink 要求出站消息回传最后一次入站的 context_token,
 *     否则 sendmessage 会被拒;持久化在 ContextTokenStore,重启后回填。
 *   - get_updates_buf: long-poll 续读游标,持久化在 SyncBufStore。
 *   - longpolling_timeout_ms: iLink 返回的下一次建议 timeout,client 自行调整。
 */
import { z } from 'zod'

/** iLink 错误码(跟 hermes-agent gateway/platforms/weixin.py 同步) */
export const ILINK_ERROR = {
  OK: 0,
  /** 登录会话失效,需要重新扫码;hermes 把这等同"未知 session"处理 */
  SESSION_EXPIRED: -14,
  /** 频率限制;触发了需开熔断器 */
  RATE_LIMIT: -2,
} as const

export type ILinkErrorCode = (typeof ILINK_ERROR)[keyof typeof ILINK_ERROR]

/** iLink 通用响应外壳 */
export const ILinkResponse = z.object({
  ret: z.number().int().default(0),
  errcode: z.number().int().default(0),
  errmsg: z.string().optional(),
  msg: z.string().optional(),
})
export type ILinkResponseT = z.infer<typeof ILinkResponse>

/**
 * iLink 请求体里的 base_info 段,所有 6 端点 POST 都带。
 * B7.6:hermes-agent gateway/platforms/weixin.py:75 + :207 实际发的是
 * { channel_version: '2.2.0' } —— 原 schema 用的 { ilink_app_id, ilink_app_client_version }
 * 是 iLink 早期 / 其他 iLink 风格,服务端对 getUpdates session 校验期望的是
 * channel_version,带错会被拒返 -14。改为只接受 channel_version 字符串。
 */
export const ILinkBaseInfo = z.object({
  channel_version: z.literal('2.2.0'),
})
export type ILinkBaseInfoT = z.infer<typeof ILinkBaseInfo>

// ── 入站消息 item 类型 ─────────────────────────────────────────
// type 编号来自 hermes-agent 解析;保持稳定,与 iLink 协议一致。
export const ITEM_TEXT = 1
export const ITEM_IMAGE = 2
export const ITEM_VOICE = 3
export const ITEM_FILE = 4
export const ITEM_VIDEO = 5

export const MSG_TYPE_USER = 1
export const MSG_TYPE_BOT = 2

const MediaReference = z.object({
  encrypt_query_param: z.string().optional(),
  aes_key: z.string().optional(),
  full_url: z.string().optional(),
  // 兜底:有些字段不是严格命名,用 raw 兜住
  encrypt_query_string: z.string().optional(),
}).passthrough()

const ItemText = z.object({
  text: z.string(),
}).passthrough()

const ItemImage = z.object({
  aeskey: z.string().optional(),
  media: MediaReference.optional(),
}).passthrough()

const ItemVoice = z.object({
  text: z.string().optional(),
  media: MediaReference.optional(),
}).passthrough()

const ItemFile = z.object({
  file_name: z.string().optional(),
  media: MediaReference.optional(),
}).passthrough()

const ItemVideo = z.object({
  media: MediaReference.optional(),
}).passthrough()

const RefMessage: z.ZodType<unknown> = z.object({
  message_item: z.union([
    z.object({
      type: z.number().int(),
      text_item: ItemText.optional(),
      image_item: ItemImage.optional(),
      voice_item: ItemVoice.optional(),
      file_item: ItemFile.optional(),
      video_item: ItemVideo.optional(),
    }).passthrough(),
    z.null(),
  ]).optional(),
}).passthrough()

/** item_list 中单条 item;type 决定下面哪个 *item 有值 */
export const ILinkItem: z.ZodType<unknown> = z.object({
  type: z.number().int(),
  text_item: ItemText.optional(),
  image_item: ItemImage.optional(),
  voice_item: ItemVoice.optional(),
  file_item: ItemFile.optional(),
  video_item: ItemVideo.optional(),
  ref_msg: RefMessage.optional(),
}).passthrough()
export type ILinkItemT = z.infer<typeof ILinkItem>

/** 单条入站消息。group/dm 通用,chatType 通过 _guessChatType 派生 */
export const ILinkInboundMessage = z.object({
  message_id: z.string(),
  from_user_id: z.string(),
  to_user_id: z.string().optional(),
  room_id: z.string().optional(),
  chat_room_id: z.string().optional(),
  msg_type: z.number().int().default(1),
  context_token: z.string().optional(),
  item_list: z.array(ILinkItem).default([]),
}).passthrough()
export type ILinkInboundMessageT = z.infer<typeof ILinkInboundMessage>

/** getUpdates 响应;长轮询 35s */
export const ILinkGetUpdatesResponse = ILinkResponse.extend({
  msgs: z.array(ILinkInboundMessage).optional(),
  longpolling_timeout_ms: z.number().int().optional(),
  get_updates_buf: z.string().optional(),
})
export type ILinkGetUpdatesResponseT = z.infer<typeof ILinkGetUpdatesResponse>

// ── 出站 payload ──────────────────────────────────────────────

/** 出站文本消息 */
export const ILinkSendTextPayload = z.object({
  from_user_id: z.literal(''),
  to_user_id: z.string(),
  client_id: z.string(),
  message_type: z.literal(MSG_TYPE_BOT),
  content: z.object({
    text: z.string(),
    context_token: z.string().optional(),
  }),
  base_info: ILinkBaseInfo,
})
export type ILinkSendTextPayloadT = z.infer<typeof ILinkSendTextPayload>

/** 出站媒体消息(image/video/file/voice) */
export const ILinkSendMediaPayload = z.object({
  from_user_id: z.literal(''),
  to_user_id: z.string(),
  client_id: z.string(),
  message_type: z.literal(MSG_TYPE_BOT),
  content: z.object({
    media: z.object({
      // type 2=image, 3=voice, 4=file, 5=video
      type: z.number().int(),
      encrypt_query_param: z.string(),
      aes_key: z.string(),
      file_name: z.string().optional(),
      // 向后兼容,某些 iLink 版本用全裸 URL
      full_url: z.string().optional(),
    }),
    context_token: z.string().optional(),
  }),
  base_info: ILinkBaseInfo,
})
export type ILinkSendMediaPayloadT = z.infer<typeof ILinkSendMediaPayload>

// ── QR 登录 ──────────────────────────────────────────────────

export const QR_STATUS = {
  WAITING: 'waiting',
  SCANNED: 'scanned',
  CONFIRMED: 'confirmed',
  EXPIRED: 'expired',
} as const
export type QrStatus = (typeof QR_STATUS)[keyof typeof QR_STATUS]

export const ILinkGetBotQrcodeResponse = ILinkResponse.extend({
  // hermes-agent 已验证:iLink 真实 server 用 `qrcode` (不是 `qrcode_id`) 作为 ID,
  // 用 `qrcode_img_content` (不是 `qrcode_url`) 作为图片 URL。两个都接受,
  // client 内部 normalize 到 `qrcode_id` / `qrcode_url` 统一字段,简化下游调用。
  qrcode: z.string().optional(),
  qrcode_id: z.string().optional(),
  qrcode_url: z.string().optional(),
  qrcode_img_url: z.string().optional(),
  qrcode_img_content: z.string().optional(),
})
export type ILinkGetBotQrcodeResponseT = z.infer<typeof ILinkGetBotQrcodeResponse>

export const ILinkGetQrcodeStatusResponse = ILinkResponse.extend({
  // iLink 真实 schema(经 hermes-agent 验证):
  //   status 字段: 'wait' / 'scaned' (注意拼写少一个 n) / 'scaned_but_redirect' / 'expired' / 'confirmed'
  //   confirmed 响应: ilink_bot_id + bot_token + baseurl + ilink_user_id
  // manager 内部 normalize 到 'waiting' / 'scanned' / 'expired' / 'confirmed',
  // 同时兼容两端字段名(ilink_bot_id / account_id, bot_token / token 等)。
  status: z.enum(['waiting', 'scanned', 'expired', 'confirmed', 'wait', 'scaned', 'scaned_but_redirect']).optional(),
  account_id: z.string().optional(),
  ilink_bot_id: z.string().optional(),
  token: z.string().optional(),
  bot_token: z.string().optional(),
  base_url: z.string().optional(),
  baseurl: z.string().optional(),
  ilink_user_id: z.string().optional(),
  redirect_host: z.string().optional(),
})
export type ILinkGetQrcodeStatusResponseT = z.infer<typeof ILinkGetQrcodeStatusResponse>

// ── 媒体上传 ──────────────────────────────────────────────────

export const ILinkGetUploadUrlResponse = ILinkResponse.extend({
  upload_url: z.string().optional(),
  encrypted_query_param: z.string().optional(),
  filekey: z.string().optional(),
})
export type ILinkGetUploadUrlResponseT = z.infer<typeof ILinkGetUploadUrlResponse>

// ── 输入态 ────────────────────────────────────────────────────

export const TYPING_START = 1
export const TYPING_STOP = 2

export const ILinkGetConfigResponse = ILinkResponse.extend({
  typing_ticket: z.string().optional(),
})
export type ILinkGetConfigResponseT = z.infer<typeof ILinkGetConfigResponse>
