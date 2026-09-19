/**
 * 微信 (Weixin) 机器人配置 + 状态共享类型。
 * 服务端 (WeixinBotManager / WeixinAdapter) 与客户端 (Web UI / SettingsDrawer)
 * 都从这个文件 zod parse + 共享类型。
 */
import { z } from 'zod'

export const DmPolicySchema = z.enum(['open', 'allowlist', 'pairing', 'disabled'])
export const GroupPolicySchema = z.enum(['open', 'allowlist', 'disabled'])

// 专用实例的默认端口等编排常量放在零依赖的 `shared/weixinInstance.ts` ——
// 前端也要用同一个值,而本文件顶层 import zod,不该被 web bundle 引用。
// 引用方(服务端 `channelProfile.ts` / 前端 `WeixinBotPanel.tsx`)直接从那里取。

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
  /**
   * 会话轮转:同一微信对话的绑定 session 存活超过该小时数后,下一条
   * 入站消息自动迁入新 sess-uuid(旧绑定保留出站反查兼容)。0 = 永不轮转。
   * 默认 6h。轮转时触发记忆沉淀(见 weixinMemory.ts)。
   */
  sessionTtlHours: z.number().nonnegative().default(6),
  /**
   * 微信专用实例的端口(默认 9199)。
   *
   * `enabled=true` 时,顶层主实例启动会自动拉起一个 `app=weixin` 的受管子
   * 实例来独占通道;本字段是该实例的固定端口。显式指定即视为用户 pin —
   * 端口被占用时启动失败并报 EADDRINUSE,不静默换端口(见根 AGENTS.md
   * 「端口使用」约束)。
   */
  instancePort: z.number().int().min(1).max(65535).default(9199),
  /**
   * 微信专用实例的工作目录。空字符串 = 用户主目录(homedir)。
   *
   * 它决定微信会话绑定到哪个 project(见 weixinInboundBridge 的 getCwd),
   * 也决定 agent 读写文件时的工作根。留空走 homedir 是为了让微信侧默认
   * 不落进任何一个具体工程。
   */
  instanceCwd: z.string().default(''),
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
    // 本进程既不是持有者也不是待命者,而是「不该跑通道的进程」——
    // 通道归 `app=weixin` 的专用实例独占(见 weixinDedicatedInstance.ts)。
    // 主实例 / task-factory 实例都会落到这个状态,面板据此提示去配置专用实例。
    'dedicated_instance_required',
  ]),
  accountId: z.string().optional(),
  lastError: z.string().optional(),
  lastConnAt: z.number().optional(),
  /** 本进程是否为通道持有者(全局单实例锁)。 */
  owner: z.boolean().default(false),
  /**
   * 微信专用实例(`app=weixin`)的运行时快照。
   *
   * 只有主实例(能读 instanceSupervisor 的进程)会填;专用实例自身填 null。
   * 面板在主实例上据此展示「通道由哪个实例、哪个端口、哪个 cwd 承载」。
   */
  dedicatedInstance: z
    .object({
      id: z.string(),
      name: z.string(),
      state: z.string(),
      port: z.number().nullable(),
      pid: z.number().nullable(),
      cwd: z.string(),
      lastError: z.string().nullable(),
    })
    .nullable()
    .optional(),
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
