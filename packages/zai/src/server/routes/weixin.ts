/**
 * Weixin (微信) 机器人 REST API。
 *
 * 端点:
 *   GET  /api/weixin/status                 当前状态 + 配置
 *   POST /api/weixin/connect                启用并连接(用 settings 里的 accountId/token)
 *   POST /api/weixin/disconnect             断开
 *   POST /api/weixin/reload                 重启 adapter(改了 settings 后)
 *   POST /api/weixin/setup/start            开始 QR 登录 (B5:返回 qrcodeId + qrcodeUrl)
 *   GET  /api/weixin/setup/poll?qrcodeId=   轮询 QR 状态
 *   POST /api/weixin/setup/cancel           取消 QR 登录
 *   POST /api/weixin/setup/confirm          拿到 QR 凭据后保存 + 启动 adapter
 *
 * 详见 docs/superpowers/plans/2026-08-16-zai-weixin-bot-platform.md B4。
 */
import { Router, type IRouter, type Request, type Response } from 'express'
import { z } from 'zod'
import { getWeixinBotManager } from '../services/weixinBot/WeixinBotManager.js'
import { WeixinBotSettingsSchema } from '../../shared/weixin.js'

const router: IRouter = Router()

function getManager() {
  return getWeixinBotManager()
}

router.get('/status', async (_req: Request, res: Response) => {
  try {
    res.json(getManager().status())
  } catch (err) {
    res.status(500).json({ error: (err as Error).message })
  }
})

router.post('/connect', async (req: Request, res: Response) => {
  try {
    const body = z.object({}).parse(req.body)
    void body
    await getManager().start()
    res.json(getManager().status())
  } catch (err) {
    res.status(400).json({ error: (err as Error).message })
  }
})

router.post('/disconnect', async (_req: Request, res: Response) => {
  try {
    await getManager().stop()
    res.json(getManager().status())
  } catch (err) {
    res.status(500).json({ error: (err as Error).message })
  }
})

router.post('/reload', async (_req: Request, res: Response) => {
  try {
    await getManager().reload()
    res.json(getManager().status())
  } catch (err) {
    res.status(500).json({ error: (err as Error).message })
  }
})

router.get('/settings', async (_req: Request, res: Response) => {
  try {
    const settings = WeixinBotSettingsSchema.parse({})
    res.json(settings)
  } catch (err) {
    res.status(500).json({ error: (err as Error).message })
  }
})

router.post('/setup/start', async (_req: Request, res: Response) => {
  try {
    const adapter = getManager().getAdapter()
    if (!adapter) {
      res.status(503).json({ error: 'weixin adapter not initialized' })
      return
    }
    const iLink = adapter.getClient()
    const result = await iLink.getBotQrcode()
    if (!result.qrcode_id || !result.qrcode_url) {
      res.status(502).json({ error: 'iLink getBotQrcode returned empty' })
      return
    }
    res.json({ qrcodeId: result.qrcode_id, qrcodeUrl: result.qrcode_url })
  } catch (err) {
    res.status(500).json({ error: (err as Error).message })
  }
})

router.get('/setup/poll', async (req: Request, res: Response) => {
  try {
    const qrcodeId = String(req.query.qrcodeId ?? '').trim()
    if (!qrcodeId) {
      res.status(400).json({ error: 'qrcodeId required' })
      return
    }
    const adapter = getManager().getAdapter()
    if (!adapter) {
      res.status(503).json({ error: 'weixin adapter not initialized' })
      return
    }
    const result = await adapter.getClient().getQrcodeStatus(qrcodeId)
    res.json({
      status: result.status ?? 'waiting',
      accountId: result.account_id,
      baseUrl: result.base_url,
    })
  } catch (err) {
    res.status(500).json({ error: (err as Error).message })
  }
})

const SetupConfirmBody = z.object({
  accountId: z.string().min(1),
  token: z.string().min(1),
  baseUrl: z.string().url().optional(),
})

router.post('/setup/confirm', async (req: Request, res: Response) => {
  try {
    const parsed = SetupConfirmBody.safeParse(req.body)
    if (!parsed.success) {
      res.status(400).json({ error: 'invalid body', details: parsed.error.flatten() })
      return
    }
    await getManager().saveAccount(parsed.data.accountId, parsed.data.token, parsed.data.baseUrl)
    await getManager().reload()
    res.json(getManager().status())
  } catch (err) {
    res.status(500).json({ error: (err as Error).message })
  }
})

router.post('/setup/cancel', async (_req: Request, res: Response) => {
  try {
    res.json({ status: 'cancelled' })
  } catch (err) {
    res.status(500).json({ error: (err as Error).message })
  }
})

export { router as weixinRouter }
