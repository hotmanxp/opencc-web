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
/** 已完成的消息状态。出站必带,缺了 iLink 判 -2 invalid arguments。 */
export const MSG_STATE_FINISH = 2

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

/**
 * 出站媒体引用。`aes_key` 必须是 `base64(hex_string)`(即对 16 字节密钥的
 * **hex 文本**再做 base64),不是 `base64(raw_bytes)` —— 后者收端能解密失败,
 * 图片显示为灰块(hermes-agent weixin.py:2150 实测结论)。
 */
const ILinkOutboundMediaRef = z.object({
  encrypt_query_param: z.string(),
  aes_key: z.string(),
  encrypt_type: z.number().int().optional(),
})

const ILinkOutboundTextItem = z.object({
  type: z.literal(ITEM_TEXT),
  text_item: z.object({ text: z.string() }),
})

const ILinkOutboundImageItem = z.object({
  type: z.literal(ITEM_IMAGE),
  image_item: z.object({
    media: ILinkOutboundMediaRef,
    mid_size: z.number().int().optional(),
  }),
})

const ILinkOutboundFileItem = z.object({
  type: z.literal(ITEM_FILE),
  file_item: z.object({
    media: ILinkOutboundMediaRef,
    file_name: z.string(),
    len: z.string().optional(),
  }),
})

const ILinkOutboundVideoItem = z.object({
  type: z.literal(ITEM_VIDEO),
  video_item: z.object({
    media: ILinkOutboundMediaRef,
    video_size: z.number().int().optional(),
    play_length: z.number().int().optional(),
    video_md5: z.string().optional(),
  }),
})

const ILinkOutboundVoiceItem = z.object({
  type: z.literal(ITEM_VOICE),
  voice_item: z.object({
    media: ILinkOutboundMediaRef,
    encode_type: z.number().int().optional(),
    sample_rate: z.number().int().optional(),
    bits_per_sample: z.number().int().optional(),
    playtime: z.number().int().optional(),
  }),
})

export const ILinkOutboundItem = z.union([
  ILinkOutboundTextItem,
  ILinkOutboundImageItem,
  ILinkOutboundFileItem,
  ILinkOutboundVideoItem,
  ILinkOutboundVoiceItem,
])
export type ILinkOutboundItemT = z.infer<typeof ILinkOutboundItem>

/**
 * 出站消息信封。**必须**整体包在 `msg` 里,且正文只能走 `item_list`。
 *
 * 血泪教训(2026-09-13 实测):原先发的是「裸 payload + content.text」,
 * iLink 一律返 `{"ret":-2,"errmsg":"invalid arguments"}`,出站 100% 失败。
 * 而 `{msg:{..., message_state, item_list:[{type:1,text_item:{text}}]}}`
 * 立即返 `{"message_id":...}` 成功。hermes-agent weixin.py:455-469 同形。
 *
 * base_info 由 iLinkClient.post() 强制注入,不在 payload 里声明。
 */
export const ILinkOutboundMsg = z.object({
  from_user_id: z.literal(''),
  to_user_id: z.string(),
  client_id: z.string(),
  message_type: z.literal(MSG_TYPE_BOT),
  message_state: z.literal(MSG_STATE_FINISH),
  item_list: z.array(ILinkOutboundItem).min(1),
  context_token: z.string().optional(),
})
export type ILinkOutboundMsgT = z.infer<typeof ILinkOutboundMsg>

/** 出站文本消息。 */
export const ILinkSendTextPayload = z.object({
  msg: ILinkOutboundMsg.extend({ item_list: z.array(ILinkOutboundTextItem).min(1) }),
})
export type ILinkSendTextPayloadT = z.infer<typeof ILinkSendTextPayload>

/** 出站媒体消息(image/video/file/voice)。 */
export const ILinkSendMediaPayload = z.object({
  msg: ILinkOutboundMsg,
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

/**
 * getuploadurl 请求体。实测(hermes-agent weixin.py:519-534 同形)必须带
 * filekey/media_type/to_user_id/rawsize/rawfilemd5/filesize/no_need_thumb/aeskey,
 * 空对象 `{}` 服务端不报错但返回缺 upload_param 的残缺响应。
 * media_type 与 item_list 里的 ITEM_* 不同:IMAGE=1 / VIDEO=2 / FILE=3 / VOICE=4。
 */
export const ILinkGetUploadUrlPayload = z.object({
  filekey: z.string(),
  /** IMAGE=1 / VIDEO=2 / FILE=3 / VOICE=4(hermes MEDIA_* 常量) */
  media_type: z.number().int(),
  to_user_id: z.string(),
  /** 明文字节数 */
  rawsize: z.number().int(),
  /** 明文 md5 hex */
  rawfilemd5: z.string(),
  /** AES PKCS#7 填充后字节数:((rawsize+1+15)//16)*16 */
  filesize: z.number().int(),
  no_need_thumb: z.literal(true),
  /** 16 字节密钥的 hex 文本 */
  aeskey: z.string(),
})
export type ILinkGetUploadUrlPayloadT = z.infer<typeof ILinkGetUploadUrlPayload>

/** getuploadurl 响应。真实字段是 upload_param / upload_full_url(hermes weixin.py:2130 同) */
export const ILinkGetUploadUrlResponse = ILinkResponse.extend({
  upload_param: z.string().optional(),
  upload_full_url: z.string().optional(),
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
