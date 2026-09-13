/**
 * Weixin (微信) 机器人 REST API。
 *
 * 端点:
 *   GET  /api/weixin/status                 当前状态 + owner + 指标
 *   POST /api/weixin/connect                启用并连接(仅受管进程生效)
 *   POST /api/weixin/disconnect             断开(释放全局 owner 锁)
 *   POST /api/weixin/reload                 重启 adapter(改了 settings 后)
 *   POST /api/weixin/setup/start            开始 QR 登录 (返回 qrcodeId + qrcodeUrl)
 *   GET  /api/weixin/setup/poll?qrcodeId=   轮询 QR 状态
 *   POST /api/weixin/setup/cancel           取消 QR 登录
 *   POST /api/weixin/setup/confirm          拿到 QR 凭据后保存 + 启动 adapter
 *
 * P1 配对鉴权:
 *   GET  /api/weixin/pairings               白名单 + 待批准队列
 *   POST /api/weixin/pairings/approve       { senderId } 批准
 *   POST /api/weixin/pairings/reject        { senderId } 拒绝
 *   POST /api/weixin/pairings/verify        { senderId, code } 按配对码批准
 *   POST /api/weixin/pairings/revoke        { senderId } 吊销已批准用户
 *
 * P5/P7 全局单实例锁:
 *   GET  /api/weixin/owner                  当前机器级通道持有者
 *   POST /api/weixin/owner/takeover         清除失联持有者的锁
 *
 * P4 观测:
 *   GET  /api/weixin/diagnostics            会话绑定 / 指标 / owner
 */
import { Router, type IRouter, type Request, type Response } from 'express'
import { z } from 'zod'
import { getWeixinBotManager } from '../services/weixinBot/WeixinBotManager.js'
import { getWeixinPairingStore } from '../services/weixinBot/WeixinPairingStore.js'
import { WeixinBotSettingsSchema } from '../../shared/weixin.js'
import { isManagedChild } from '../../cli/managedChild.js'

const router: IRouter = Router()

function getManager() {
  return getWeixinBotManager()
}

/** P6:通道只由 supervisor 拉起的进程运行。非受管进程给出明确原因。 */
function supervisorBlocked(res: Response): boolean {
  if (isManagedChild()) return false
  res.status(409).json({
    error: 'supervisor_required',
    detail:
      'Weixin channel only runs in a supervisor-managed process. Start zai via its supervisor (default `zai start`), not a bare dev/direct process.',
  })
  return true
}

router.get('/status', async (_req: Request, res: Response) => {
  try {
    res.json(await getManager().statusAsync())
  } catch (err) {
    res.status(500).json({ error: (err as Error).message })
  }
})

router.post('/connect', async (_req: Request, res: Response) => {
  try {
    if (supervisorBlocked(res)) return
    await getManager().start()
    res.json(await getManager().statusAsync())
  } catch (err) {
    res.status(400).json({ error: (err as Error).message })
  }
})

router.post('/disconnect', async (_req: Request, res: Response) => {
  try {
    await getManager().stop()
    res.json(await getManager().statusAsync())
  } catch (err) {
    res.status(500).json({ error: (err as Error).message })
  }
})

router.post('/reload', async (_req: Request, res: Response) => {
  try {
    if (supervisorBlocked(res)) return
    await getManager().reload()
    res.json(await getManager().statusAsync())
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
    if (supervisorBlocked(res)) return
    const result = await getManager().startSetup()
    if (!result) {
      res.status(502).json({ error: 'iLink getBotQrcode returned empty or adapter init failed' })
      return
    }
    res.json(result)
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
    const result = await getManager().pollSetup(qrcodeId)
    res.json(result)
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
    res.json(await getManager().statusAsync())
  } catch (err) {
    res.status(500).json({ error: (err as Error).message })
  }
})

router.post('/setup/cancel', async (_req: Request, res: Response) => {
  try {
    getManager().cancelSetup()
    res.json({ status: 'cancelled' })
  } catch (err) {
    res.status(500).json({ error: (err as Error).message })
  }
})

// ─── P1 配对鉴权 ────────────────────────────────────────────────────

router.get('/pairings', async (_req: Request, res: Response) => {
  try {
    res.json(await getWeixinPairingStore().list())
  } catch (err) {
    res.status(500).json({ error: (err as Error).message })
  }
})

const SenderBody = z.object({ senderId: z.string().min(1) })

router.post('/pairings/approve', async (req: Request, res: Response) => {
  try {
    const parsed = SenderBody.safeParse(req.body)
    if (!parsed.success) { res.status(400).json({ error: 'senderId required' }); return }
    await getWeixinPairingStore().approve(parsed.data.senderId, 'web')
    res.json(await getWeixinPairingStore().list())
  } catch (err) {
    res.status(500).json({ error: (err as Error).message })
  }
})

router.post('/pairings/reject', async (req: Request, res: Response) => {
  try {
    const parsed = SenderBody.safeParse(req.body)
    if (!parsed.success) { res.status(400).json({ error: 'senderId required' }); return }
    await getWeixinPairingStore().reject(parsed.data.senderId)
    res.json(await getWeixinPairingStore().list())
  } catch (err) {
    res.status(500).json({ error: (err as Error).message })
  }
})

router.post('/pairings/revoke', async (req: Request, res: Response) => {
  try {
    const parsed = SenderBody.safeParse(req.body)
    if (!parsed.success) { res.status(400).json({ error: 'senderId required' }); return }
    await getWeixinPairingStore().revoke(parsed.data.senderId)
    res.json(await getWeixinPairingStore().list())
  } catch (err) {
    res.status(500).json({ error: (err as Error).message })
  }
})

const VerifyBody = z.object({ senderId: z.string().min(1), code: z.string().min(1) })

router.post('/pairings/verify', async (req: Request, res: Response) => {
  try {
    const parsed = VerifyBody.safeParse(req.body)
    if (!parsed.success) { res.status(400).json({ error: 'senderId + code required' }); return }
    const result = await getWeixinPairingStore().verifyCode(parsed.data.senderId, parsed.data.code)
    res.json({ ...result, pairings: await getWeixinPairingStore().list() })
  } catch (err) {
    res.status(500).json({ error: (err as Error).message })
  }
})

// ─── P5/P7 全局单实例锁 ─────────────────────────────────────────────

router.get('/owner', async (_req: Request, res: Response) => {
  try {
    const snapshot = await getManager().readOwner()
    res.json(snapshot ?? null)
  } catch (err) {
    res.status(500).json({ error: (err as Error).message })
  }
})

router.post('/owner/takeover', async (_req: Request, res: Response) => {
  try {
    if (supervisorBlocked(res)) return
    const result = await getManager().forceTakeoverOwner()
    res.status(result.ok ? 200 : 409).json(result)
  } catch (err) {
    res.status(500).json({ error: (err as Error).message })
  }
})

// ─── P4 观测 ───────────────────────────────────────────────────────

router.get('/diagnostics', async (_req: Request, res: Response) => {
  try {
    const manager = getManager()
    const adapter = manager.getAdapter()
    const [status, bindings, pairings] = await Promise.all([
      manager.statusAsync(),
      manager.listSessionBindings(),
      getWeixinPairingStore().list(),
    ])
    res.json({
      supervisorManaged: isManagedChild(),
      status,
      bindings,
      pairingPending: pairings.pending,
      // 面板「最近入站消息」数据源。SSE 那条 weixin.inbound 用的是关联键
      // sessionId(weixin:<acct>:...),按 zai sessionId 过滤的 SSE 收不到,
      // 所以从服务端环形缓冲取。
      recentInbound: manager.listRecentInbound(),
      // adapter 内部状态(manager.state 是 manager 自己的,两者可能不一致)
      adapterState: adapter ? adapter.status() : null,
    })
  } catch (err) {
    res.status(500).json({ error: (err as Error).message })
  }
})

// diag:手动触发 sendText,绕开 inbound → agent → outbound 整条链。
// 仅在 WEIXIN_DIAG=1 时挂载,避免生产暴露。
if (process.env.WEIXIN_DIAG === '1') {
  const SendBody = z.object({
    chatId: z.string().min(1),
    text: z.string().min(1).max(4000),
  })
  router.post('/send', async (req: Request, res: Response) => {
    try {
      const parsed = SendBody.safeParse(req.body)
      if (!parsed.success) {
        res.status(400).json({ error: 'invalid body', details: parsed.error.flatten() })
        return
      }
      const adapter = getManager().getAdapter()
      if (!adapter) {
        res.status(503).json({ error: 'adapter not initialized' })
        return
      }
      const r = await adapter.sendText(parsed.data.chatId, parsed.data.text)
      res.json(r)
    } catch (err) {
      res.status(500).json({ error: (err as Error).message })
    }
  })
}

export { router as weixinRouter }
