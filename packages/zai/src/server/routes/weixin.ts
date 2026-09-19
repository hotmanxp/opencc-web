/**
 * Weixin (微信) 机器人 REST API。
 *
 * 端点:
 *   GET  /api/weixin/status                 当前状态 + owner + 指标 + 专用实例快照
 *   POST /api/weixin/connect                宿主=连接通道;主实例=拉起专用实例
 *   POST /api/weixin/disconnect             宿主=断开通道;主实例=停掉专用实例
 *   POST /api/weixin/reload                 重启 adapter(改了 settings 后)
 *   GET  /api/weixin/settings               UI 可见设置(enabled/dmPolicy/实例端口/cwd,不含凭据)
 *   PUT  /api/weixin/settings               改设置并热生效(enabled=服务启动自动启动微信机器人)
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
 *
 * ─── 进程模型(2026-09-13) ──────────────────────────────────────────────
 *   主实例(顶层受管 child,无 ZAI_INSTANCE_ID):**不跑通道**。只按
 *     `settings.weixinBot.enabled` 拉起/停掉专用实例(见
 *     weixinDedicatedInstance.ts),manager 状态恒为
 *     `dedicated_instance_required`。
 *   专用实例(`app=weixin`):机器上唯一取 owner 锁、收消息、跑 agent turn
 *     并发回复的进程。启动时由 `maybeAutoStartWeixinBot()` 自动连接。
 *   其它实例:与通道无关,status 同样是 `dedicated_instance_required`。
 *   "连接/断开"按当前进程角色分派(见各自 handler 注释),面板无需感知差异。
 */
import { Router, type IRouter, type Request, type Response } from 'express'
import { z } from 'zod'
import { getWeixinBotManager } from '../services/weixinBot/WeixinBotManager.js'
import { getWeixinPairingStore } from '../services/weixinBot/WeixinPairingStore.js'
import { WeixinBotSettingsSchema } from '../../shared/weixin.js'
import { isManagedChild } from '../../cli/managedChild.js'
import { isWeixinChannelHost } from '../services/weixinBot/channelProfile.js'
import {
  DEFAULT_WEIXIN_INSTANCE_PORT,
  ensureDedicatedInstance,
  findDedicatedInstance,
  restartDedicatedInstance,
  stopDedicatedInstance,
} from '../services/weixinBot/weixinDedicatedInstance.js'
import { readZaiSettings, updateZaiSettings } from '../services/zaiSettingsStore.js'

const router: IRouter = Router()

function getManager() {
  return getWeixinBotManager()
}

/**
 * 面板统一的状态载荷:manager 自身状态 + 本机专用实例快照。
 *
 * 非宿主进程(主实例)的 manager 状态恒为 `dedicated_instance_required`(它不跑
 * 通道),真正有价值的信息是 `dedicatedInstance` —— 通道就在那个实例里。
 */
async function statusPayload() {
  const status = await getManager().statusAsync()
  return { ...status, dedicatedInstance: findDedicatedInstance() }
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
    res.json(await statusPayload())
  } catch (err) {
    res.status(500).json({ error: (err as Error).message })
  }
})

router.post('/connect', async (_req: Request, res: Response) => {
  try {
    if (supervisorBlocked(res)) return
    if (isWeixinChannelHost()) {
      await getManager().start()
    } else {
      // 主实例:通道归 `app=weixin` 专用实例。这里的"连接"= 确保专用实例
      // 已拉起 —— 用户在面板上点按钮即表达意图,所以跳过 enabled 开关门控
      // (`ensureDedicatedInstance` 走 force 路径)。
      const result = await ensureDedicatedInstance()
      if (!result.attempted && result.reason === 'failed') {
        res.status(502).json({
          error: 'failed to start the dedicated weixin instance',
          detail: result.detail,
          reason: result.reason,
        })
        return
      }
    }
    res.json(await statusPayload())
  } catch (err) {
    res.status(400).json({ error: (err as Error).message })
  }
})

router.post('/disconnect', async (_req: Request, res: Response) => {
  try {
    if (isWeixinChannelHost()) {
      await getManager().stop()
    } else {
      // 通道在专用实例上,本进程没有通道可断 —— "断开"只能是把那个实例停掉。
      const result = await stopDedicatedInstance()
      if (!result.ok && result.reason === 'failed') {
        res.status(502).json({
          error: 'failed to stop the dedicated weixin instance',
          detail: result.detail,
          reason: result.reason,
        })
        return
      }
    }
    res.json(await statusPayload())
  } catch (err) {
    res.status(500).json({ error: (err as Error).message })
  }
})

router.post('/reload', async (_req: Request, res: Response) => {
  try {
    if (supervisorBlocked(res)) return
    // 只有宿主有 adapter 可重载;主实例的 manager 从没启动过通道,
    // reload() 会直接落到 dedicated_instance_required 分支,是无害 no-op。
    await getManager().reload()
    res.json(await statusPayload())
  } catch (err) {
    res.status(500).json({ error: (err as Error).message })
  }
})

/**
 * GET /settings —— 面板「设置」表单的数据源。
 * 只回 UI 需要的字段,token 等凭据永不出网。enabled 语义 =
 * 「服务启动时自动启动微信机器人」(主实例据此拉起专用实例;
 * 专用实例自身的通道启动也走同一个开关)。
 */
router.get('/settings', async (_req: Request, res: Response) => {
  try {
    const raw = (await readZaiSettings()).weixinBot ?? {}
    const parsed = WeixinBotSettingsSchema.safeParse(raw)
    const s = parsed.success ? parsed.data : null
    res.json({
      enabled: s?.enabled ?? false,
      dmPolicy: s?.dmPolicy ?? 'pairing',
      groupPolicy: s?.groupPolicy ?? 'disabled',
      allowFrom: s?.allowFrom ?? [],
      sessionTtlHours: s?.sessionTtlHours ?? 6,
      // 专用实例编排参数(主实例用):端口 + 工作目录。
      instancePort: s?.instancePort ?? DEFAULT_WEIXIN_INSTANCE_PORT,
      instanceCwd: s?.instanceCwd ?? '',
    })
  } catch (err) {
    res.status(500).json({ error: (err as Error).message })
  }
})

const WeixinSettingsPatch = z.object({
  enabled: z.boolean().optional(),
  instancePort: z.number().int().min(1).max(65535).optional(),
  /** 空串 = 用户主目录。路径存在性由拉起时校验(不存在会给明确错误)。 */
  instanceCwd: z.string().optional(),
  // 通道行为参数。专用实例只在启动时读一次 settings,所以改了这几个必须让
  // 它重启才生效(见下方 PUT 处理)。
  dmPolicy: z.enum(['open', 'allowlist', 'pairing', 'disabled']).optional(),
  groupPolicy: z.enum(['open', 'allowlist', 'disabled']).optional(),
  allowFrom: z.array(z.string()).optional(),
})

/**
 * PUT /settings —— 改设置并热生效。
 *
 * 宿主进程(专用实例):读-合并-写 weixinBot 段,然后 `manager.reload()`
 * (`stop` + `start`)—— enabled=false → 断开并置 disabled;true → 重新拉起。
 *
 * 非宿主进程(主实例):manager 侧无事可做,改为把**专用实例**对齐到新配置 ——
 * 开关打开就拉起,关掉就停掉,改了通道参数(端口 / 目录 / dmPolicy / …)就重启
 * 它让新配置生效。
 */
router.put('/settings', async (req: Request, res: Response) => {
  try {
    if (supervisorBlocked(res)) return
    const parsed = WeixinSettingsPatch.safeParse(req.body)
    if (!parsed.success) {
      res.status(400).json({ error: 'invalid body', details: parsed.error.flatten() })
      return
    }
    const cur = await readZaiSettings()
    const weixinBot = { ...(cur.weixinBot ?? {}) }
    for (const key of ['enabled', 'instancePort', 'instanceCwd', 'dmPolicy', 'groupPolicy', 'allowFrom'] as const) {
      const value = parsed.data[key]
      if (value !== undefined) (weixinBot as Record<string, unknown>)[key] = value
    }
    await updateZaiSettings({ weixinBot })

    if (isWeixinChannelHost()) {
      await getManager().reload()
    } else if (parsed.data.enabled === true) {
      await ensureDedicatedInstance()
    } else if (parsed.data.enabled === false) {
      await stopDedicatedInstance()
    } else if (findDedicatedInstance()) {
      // 改的是通道行为参数 —— 专用实例只在启动时读 settings,重启才生效。
      // 实例不存在时不为了改配置凭空拉起一个(那是 enabled 开关的职责)。
      await restartDedicatedInstance()
    }
    res.json(await statusPayload())
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
    // 扫码确认那一刻凭据已落盘(manager 内部 saveAccount → accounts/<id>.json)。
    // 非宿主进程此时必须重启专用实例 —— 它在启动时读一次凭据,不起就读不到新
    // token,表现为「扫码成功但收不到消息」。
    if (result.status === 'confirmed' && !isWeixinChannelHost()) {
      await restartDedicatedInstance()
    }
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
    if (isWeixinChannelHost()) {
      await getManager().reload()
    } else {
      // 凭据已落到 accounts/<id>.json;重启专用实例让它读走并连通道。
      await restartDedicatedInstance()
    }
    res.json(await statusPayload())
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
      statusPayload(),
      manager.listSessionBindings(),
      getWeixinPairingStore().list(),
    ])
    res.json({
      supervisorManaged: isManagedChild(),
      /** 本进程是否为 `app=weixin` 通道宿主。面板据此区分"主实例 / 专用实例"视角。 */
      channelHost: isWeixinChannelHost(),
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
