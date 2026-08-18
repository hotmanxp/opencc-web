/**
 * iLink Bot API 端点常量 + 限流/超时常量。
 *
 * 集中常量便于测试与升级同步,所有超时参照 hermes-agent 经验值。
 */
export const ILINK_BASE_URL = 'https://ilinkai.weixin.qq.com'
export const WEIXIN_CDN_BASE_URL = 'https://novac2c.cdn.weixin.qq.com/c2c'

/** long-poll 35s,iLink 服务端 hold;超时视作"无消息" */
export const LONG_POLL_TIMEOUT_MS = 35_000
/** 普通 API 默认 15s */
export const API_TIMEOUT_MS = 15_000
/** QR 状态轮询 10s */
export const QR_STATUS_TIMEOUT_MS = 10_000

/** 连续 iLink 错误 1-2 次 → 2s 重试;3+ 次 → 30s 退避 */
export const MAX_CONSECUTIVE_FAILURES = 3
export const RETRY_DELAY_SECONDS = 2
export const BACKOFF_DELAY_SECONDS = 30
/** session expired (-14) 后暂停 10 分钟,等用户重新扫码 */
export const SESSION_EXPIRED_BACKOFF_SECONDS = 600

/** 出站单 chunk 默认 1.5s 间隔,避免 WeChat 限流 */
export const DEFAULT_SEND_CHUNK_DELAY_SECONDS = 1.5
/** 文本合并静默期默认 3s */
export const DEFAULT_TEXT_BATCH_DELAY_SECONDS = 3.0
/** 接近分块阈值时的更长静默期 5s */
export const DEFAULT_TEXT_BATCH_SPLIT_DELAY_SECONDS = 5.0
/** 触发"用更长静默期"的单 chunk 长度阈值 */
export const TEXT_BATCH_SPLIT_THRESHOLD = 1800

/** typing ticket TTL 600s */
export const TYPING_TICKET_TTL_SECONDS = 600
/** iLink 出站单文本最大长度(hermes 沿用 4000) */
export const MAX_MESSAGE_LENGTH = 4000
/** 媒体加密 AES-128 密钥长度 */
export const AES_KEY_LENGTH = 16

/** 去重滑动窗口 5 分钟(hermes 经验值) */
export const MESSAGE_DEDUP_TTL_SECONDS = 300

/** 账号锁(基于 proper-lockfile)默认重试参数 */
export const ACCOUNT_LOCK_RETRIES = 5
export const ACCOUNT_LOCK_MIN_TIMEOUT_MS = 50
export const ACCOUNT_LOCK_MAX_TIMEOUT_MS = 200
