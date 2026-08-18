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
  ]),
  accountId: z.string().optional(),
  lastError: z.string().optional(),
  lastConnAt: z.number().optional(),
})

export type WeixinStatus = z.infer<typeof WeixinStatusSchema>
