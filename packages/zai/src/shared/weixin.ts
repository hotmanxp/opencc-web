/**
 * 微信 (Weixin) 机器人配置 + 状态共享类型。
 * 服务端 (WeixinBotManager / WeixinAdapter) 与客户端 (Web UI / SettingsDrawer)
 * 都从这个文件 zod parse + 共享类型。
 */
import { z } from 'zod'

export const DmPolicySchema = z.enum(['open', 'allowlist', 'pairing', 'disabled'])
export const GroupPolicySchema = z.enum(['open', 'allowlist', 'disabled'])

export type DmPolicy = z.infer<typeof DmPolicySchema>
export type GroupPolicy = z.infer<typeof GroupPolicySchema>

export const WeixinBotSettingsSchema = z.object({
  enabled: z.boolean().default(false),
  accountId: z.string().optional(),
  token: z.string().optional(),
  baseUrl: z.string().url().default('https://ilinkai.weixin.qq.com'),
  cdnBaseUrl: z.string().url().default('https://novac2c.cdn.weixin.qq.com/c2c'),
  dmPolicy: DmPolicySchema.default('pairing'),
  groupPolicy: GroupPolicySchema.default('disabled'),
  allowFrom: z.array(z.string()).default([]),
  groupAllowFrom: z.array(z.string()).default([]),
  textBatchDelaySeconds: z.number().nonnegative().default(3.0),
  textBatchSplitDelaySeconds: z.number().nonnegative().default(5.0),
  sendChunkDelaySeconds: z.number().nonnegative().default(1.5),
  sendChunkRetries: z.number().int().nonnegative().default(4),
  rateLimitCircuitThreshold: z.number().int().positive().default(1),
  rateLimitCircuitOpenSeconds: z.number().nonnegative().default(30.0),
  /** B7.6:QR confirmed 响应的 ilink_user_id,getUpdates 用它跟 bot_token
   * 一起做 session 鉴权。重新扫码后会被 lastConfirmedCreds 刷新覆盖。 */
  ilinkUserId: z.string().optional(),
})

export type WeixinBotSettings = z.infer<typeof WeixinBotSettingsSchema>

export const WeixinStatusSchema = z.object({
  configured: z.boolean(),
  enabled: z.boolean(),
  state: z.enum([
    'disabled',
    'unconfigured',
    'failed',
    'connecting',
    'connected',
    'disconnected',
    // 全局单实例锁:本进程不是机器上的 weixin 通道持有者,处于待命态。
    // 不 poll、不出站、不处理入站 —— 由持有者实例独占。
    'standby',
    // 本进程不是由 supervisor 拉起。weixin 通道只允许 supervisor 托管进程启动。
    'supervisor_required',
  ]),
  accountId: z.string().optional(),
  lastError: z.string().optional(),
  lastConnAt: z.number().optional(),
  /** 本进程是否为通道持有者(全局单实例锁)。 */
  owner: z.boolean().default(false),
  /** 当前通道持有者信息(可能不是本进程)。 */
  ownerInfo: z
    .object({
      instanceId: z.string(),
      pid: z.number(),
      supervisorPid: z.number().nullable(),
      port: z.number().nullable(),
      cwd: z.string(),
      accountId: z.string(),
      hostname: z.string(),
      startedAt: z.number(),
      self: z.boolean(),
      live: z.boolean(),
    })
    .nullable()
    .default(null),
  /** 观测计数(入站/出站/待注入/待配对)。 */
  metrics: z
    .object({
      inbound: z.number(),
      outbound: z.number(),
      pendingReplay: z.number(),
      pairingPending: z.number(),
      boundSessions: z.number(),
    })
    .default({ inbound: 0, outbound: 0, pendingReplay: 0, pairingPending: 0, boundSessions: 0 }),
})

export type WeixinStatus = z.infer<typeof WeixinStatusSchema>

// ─── 配对鉴权 (P1) ────────────────────────────────────────────────────

export const WeixinPairingAllowedSchema = z.object({
  senderId: z.string(),
  displayName: z.string().optional(),
  pairedAt: z.number(),
  /** 批准来源:'web' 面板批准 / 'code' 用户回码 */
  approvedVia: z.enum(['web', 'code']).default('web'),
})

export const WeixinPairingPendingSchema = z.object({
  senderId: z.string(),
  displayName: z.string().optional(),
  code: z.string(),
  requestedAt: z.number(),
  expiresAt: z.number(),
  /** 已尝试回码次数(上限后作废,防暴力枚举) */
  attempts: z.number().default(0),
})

export const WeixinPairingsSchema = z.object({
  allowed: z.array(WeixinPairingAllowedSchema),
  pending: z.array(WeixinPairingPendingSchema),
})

export type WeixinPairingAllowed = z.infer<typeof WeixinPairingAllowedSchema>
export type WeixinPairingPending = z.infer<typeof WeixinPairingPendingSchema>
export type WeixinPairings = z.infer<typeof WeixinPairingsSchema>

// ─── 会话绑定 (D1) ────────────────────────────────────────────────────

export const WeixinSessionBindingSchema = z.object({
  conversationKey: z.string(),
  sessionId: z.string(),
  cwd: z.string(),
  accountId: z.string(),
  chatType: z.enum(['dm', 'group']),
  chatId: z.string(),
  senderId: z.string(),
  displayName: z.string().optional(),
  createdAt: z.number(),
  lastActiveAt: z.number(),
})

export type WeixinSessionBinding = z.infer<typeof WeixinSessionBindingSchema>
