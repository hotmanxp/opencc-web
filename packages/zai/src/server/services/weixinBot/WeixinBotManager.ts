/**
 * WeixinBotManager — 把 WeixinAdapter 接入 zai agent 运行时。
 *
 * 职责边界(2026-09-13 重写):
 *   - **生命周期门控(P6)**:只有 supervisor 拉起的进程才能启动通道。
 *   - **全局单实例(P5)**:启动前必须拿到机器级 owner 锁(`WeixinOwnerLock`)。
 *     拿不到 → `standby`,不 poll / 不出站 / 不处理入站。
 *   - **入站(P0)**:`_onInbound` 保留 eventBus 观测事件,并交给
 *     `WeixinInboundBridge.deliver()` 注入 agent 运行时(配对鉴权 / 落盘防丢 /
 *     渲染 prompt 全在 bridge)。
 *   - **出站(P0/P3)**:订阅 `runtime.started/delta/done/error/aborted`,
 *     按 sessionId → 映射表反查 chatId 精确回发;补错误/中断/空输出回执。
 *
 * 为什么不能重入 supervisor:受管子进程不会再次进入 supervisor 逻辑,
 * 见 `cli/start.ts` 的 `--managed-child` 处理。
 */
import { eventBus } from '../eventBus.js'
import type { ServerEvent } from '../../../shared/events.js'
import { WeixinAdapter, type InternalWeixinMessage } from './WeixinAdapter.js'
import {
  WeixinBotSettingsSchema,
  type WeixinBotSettings,
  type WeixinStatus,
  type WeixinSessionBinding,
} from '../../../shared/weixin.js'
import { ensureWeixinDirs } from '../paths.js'
import { writeFile, mkdir, readFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import QRCode from 'qrcode'
import { isManagedChild } from '../../../cli/managedChild.js'
import { getCachedZaiSettingsSync } from '../zaiSettingsStore.js'
import {
  WeixinOwnerLock,
  buildSelfOwnerInfo,
  type WeixinOwnerHandle,
  type WeixinOwnerInfo,
  type WeixinOwnerSnapshot,
} from './WeixinOwnerLock.js'
import { getWeixinSessionMap } from './WeixinSessionMap.js'
import { getWeixinPairingStore } from './WeixinPairingStore.js'
import { getWeixinPendingStore } from './WeixinPendingStore.js'
import {
  getWeixinInboundBridge,
  resolveWeixinCwd,
  type WeixinInboundBridge,
} from './weixinInboundBridge.js'

export type WeixinManagerState =
  | 'disabled'
  | 'unconfigured'
  | 'failed'
  | 'connecting'
  | 'connected'
  | 'disconnected'
  /** 另一实例持有机器级 owner 锁,本进程待命。 */
  | 'standby'
  /** 本进程不是由 supervisor 拉起,禁止启动通道。 */
  | 'supervisor_required'

export type { WeixinStatus }

/** 首字延迟超过该毫秒数 → 先回一条「正在处理…」占位(0 = 关闭)。 */
const FIRST_TOKEN_NOTICE_MS = Number(process.env.WEIXIN_FIRST_TOKEN_NOTICE_MS ?? 8000)
/** 长任务期间刷新 typing 的最小间隔。 */
const TYPING_REFRESH_MS = 5000

export interface WeixinBotManagerDeps {
  /**
   * Read settings — 生产从 zai settings 缓存读。
   * 返回裸 settings 形状(可能缺省字段)即可,start() 会用
   * `WeixinBotSettingsSchema.safeParse` 补默认值。
   */
  getSettings: () => Partial<WeixinBotSettings> | null
  /** Create new WeixinAdapter (测试可注入) */
  createAdapter: (settings: WeixinBotSettings) => WeixinAdapter
  /** P6 门控。默认 `isManagedChild()`;测试注入 `() => true`。 */
  isManagedChild?: () => boolean
  /** P5 取锁。默认 `WeixinOwnerLock.acquire`。 */
  acquireOwner?: (info: WeixinOwnerInfo) => Promise<Awaited<ReturnType<typeof WeixinOwnerLock.acquire>>>
  /** 注入 bridge(测试用)。 */
  bridge?: WeixinInboundBridge
  /** project cwd 解析(默认 serverCwd)。 */
  resolveCwd?: () => string
}

const DEFAULT_DEPS: WeixinBotManagerDeps = {
  // P0/D7:生产接线 —— 之前是 `() => null`,导致 settings.json 里的
  // dmPolicy / allowFrom / groupPolicy 完全不生效。
  getSettings: () => {
    try {
      return getCachedZaiSettingsSync().weixinBot ?? null
    } catch {
      return null
    }
  },
  createAdapter: (settings) => new WeixinAdapter({
    accountId: settings.accountId ?? '',
    token: settings.token ?? '',
    baseUrl: settings.baseUrl,
    cdnBaseUrl: settings.cdnBaseUrl,
    dmPolicy: settings.dmPolicy,
    groupPolicy: settings.groupPolicy,
    allowFrom: settings.allowFrom,
    groupAllowFrom: settings.groupAllowFrom,
    ilinkUserId: settings.ilinkUserId,
    // P1:Web 面板批准后即时生效的动态白名单。
    dmAllowlistProvider: () => getWeixinPairingStore().allowedSenderIds(),
  }),
  isManagedChild,
  acquireOwner: (info) => WeixinOwnerLock.acquire(info),
  resolveCwd: resolveWeixinCwd,
}

export class WeixinBotManager {
  private readonly deps: WeixinBotManagerDeps
  private readonly bridge: WeixinInboundBridge
  private adapter: WeixinAdapter | null = null
  private ownerLease: WeixinOwnerHandle | null = null
  private ownerSnapshot: WeixinOwnerSnapshot | null = null
  private busUnsub: (() => void) | null = null
  private statusListeners = new Set<(s: WeixinStatus) => void>()
  private _state: WeixinManagerState = 'unconfigured'
  private lastError: string | null = null
  private lastConnAt: number | null = null
  /** runtime.delta 缓冲:runtimes 流式输出按 sessionId 累积, runtime.done 触发 send */
  private outboundBuffers = new Map<string, { chatId: string; text: string }>()
  /** 本 turn 是否已给该 session 发过任何内容(用于 done 空输出的兜底提示)。 */
  private outboundSent = new Set<string>()
  /** 首字延迟占位定时器。 */
  private firstTokenTimers = new Map<string, ReturnType<typeof setTimeout>>()
  /** typing 刷新节流。 */
  private lastTypingAt = new Map<string, number>()
  private metricsCache = {
    inbound: 0,
    outbound: 0,
    pendingReplay: 0,
    pairingPending: 0,
    boundSessions: 0,
  }
  /**
   * 最近入站消息环形缓冲(最多 50 条),供面板「最近入站消息」展示。
   *
   * 为什么不走 SSE:`_onInbound` 发的 `weixin.inbound` 事件其 `sessionId` 是
   * `weixin:<acct>:<chatType>:<chatId>` 这个**关联键**,而服务端 SSE 是按当前
   * tab 的 zai sessionId(`sess-<uuid>`)过滤的 —— 两者永远匹配不上,面板订阅
   * 收不到任何一条。与其改全局 SSE 过滤语义(会牵动其它事件),不如在服务端留
   * 一份环形缓冲,面板打开时轮询 `/diagnostics` 取。
   */
  private recentInbound: Array<{
    id: string
    ts: number
    senderId: string
    chatType: string
    chatId: string
    text: string
    mediaCount: number
  }> = []
  /** QR 登录当前活动状态 */
  private activeSetup: {
    qrcodeId: string
    qrcodeUrl: string
    retries: number
    /** startSetup 时拿到的 settings(用户 settings 或 dummy),pollSetup confirmed 时用来 merge token */
    baseSettings: WeixinBotSettings
  } | null = null
  /**
   * QR 登录 confirmed 后落地的凭据 + 完整 settings 快照(merged)。
   * settings.json 里通常没有 token(token 写到 accounts/<id>.json 0600),
   * 所以 reload → start 时如果 deps.getSettings() 拿不到 token,从这个 cache
   * 兜底启动 adapter。
   */
  private lastConfirmedCreds: WeixinBotSettings | null = null

  /**
   * 「本机是否已有可用凭据(accountId + token)」。
   *
   * 为什么不能直接用 `!!this.adapter` 当 `configured`:`startSetup()`(QR 登录
   * wizard)也会创建一个 adapter(用 `pending`/dummy settings 只为了调
   * `getBotQrcode`)。一旦用它判断,用户点过一次「连接微信」但没扫完码,
   * `configured` 就变成 true —— 前端 setup 区块的条件是
   * `!configured || state === 'unconfigured'`,于是**二维码入口被藏掉**,
   * 只剩一个必然失败的「连接」按钮,用户卡死到重启进程。
   *
   * 语义修正:configured = 「有凭据」,与 adapter 对象是否已实例化解耦。
   */
  private hasCreds = false

  constructor(deps?: Partial<WeixinBotManagerDeps>) {
    this.deps = { ...DEFAULT_DEPS, ...(deps ?? {}) }
    this.bridge = deps?.bridge ?? getWeixinInboundBridge()
  }

  state(): WeixinManagerState { return this._state }
  status(): WeixinStatus {
    return {
      configured: this.hasCreds,
      enabled: this._state !== 'disabled' && this._state !== 'unconfigured',
      state: this._state,
      accountId: this.adapter?.getAccountId(),
      lastError: this.lastError ?? undefined,
      lastConnAt: this.lastConnAt ?? undefined,
      owner: !!this.ownerLease,
      ownerInfo: this.ownerSnapshot
        ? {
            instanceId: this.ownerSnapshot.info.instanceId,
            pid: this.ownerSnapshot.info.pid,
            supervisorPid: this.ownerSnapshot.info.supervisorPid,
            port: this.ownerSnapshot.info.port,
            cwd: this.ownerSnapshot.info.cwd,
            accountId: this.ownerSnapshot.info.accountId,
            hostname: this.ownerSnapshot.info.hostname,
            startedAt: this.ownerSnapshot.info.startedAt,
            self: this.ownerSnapshot.self,
            live: this.ownerSnapshot.live,
          }
        : null,
      metrics: { ...this.metricsCache },
    }
  }

  /** status() 的异步版本:顺带刷新 owner/配对/绑定/待重放等磁盘指标。 */
  async statusAsync(): Promise<WeixinStatus> {
    await this.refreshMetrics()
    return this.status()
  }

  onStatus(l: (s: WeixinStatus) => void): () => void {
    this.statusListeners.add(l)
    return () => this.statusListeners.delete(l)
  }

  private emitStatus(): void {
    const s = this.status()
    for (const l of this.statusListeners) {
      try { l(s) } catch { /* ignore */ }
    }
  }

  private setState(s: WeixinManagerState, err?: string | null): void {
    this._state = s
    this.lastError = err ?? null
    if (s === 'connected') this.lastConnAt = Date.now()
    this.emitStatus()
  }

  /** 刷新磁盘派生指标 + owner 快照。 */
  async refreshMetrics(): Promise<void> {
    try {
      const [pairings, bound, pend, snap] = await Promise.all([
        getWeixinPairingStore().list(),
        getWeixinSessionMap().size(),
        getWeixinPendingStore().count(),
        WeixinOwnerLock.read(),
      ])
      this.metricsCache = {
        inbound: this.bridge.metrics(0, 0).inbound,
        outbound: this.bridge.metrics(0, 0).outbound,
        pendingReplay: pend,
        pairingPending: pairings.pending.length,
        boundSessions: bound,
      }
      this.ownerSnapshot = snap
    } catch (err) {
      this.lastError = `refreshMetrics failed: ${(err as Error).message}`
    }
  }

  /** 启动 weixin bot(best-effort) */
  async start(): Promise<void> {
    let settings = this.deps.getSettings()
    // 兜底:zai 重启后 `deps.getSettings()` 返回 null 时,从 `accounts/` 挑
    // mtime 最新的那个 bot 凭据补上 token / ilinkUserId,免得每次重启都重新扫码。
    if (!settings) {
      const persisted = await this.loadLatestAccount()
      if (persisted && persisted.token) {
        const partial: Partial<WeixinBotSettings> = {
          enabled: true,
          accountId: persisted.accountId,
          token: persisted.token,
          baseUrl: persisted.baseUrl ?? 'https://ilinkai.weixin.qq.com',
          ilinkUserId: persisted.ilinkUserId,
        }
        const parsedDefault = WeixinBotSettingsSchema.safeParse(partial)
        if (parsedDefault.success) {
          settings = parsedDefault.data
          console.warn(`[weixin.manager] auto-restored from accounts/: accountId=${persisted.accountId} ilinkUserId=${persisted.ilinkUserId ?? '<none>'}`)
        }
      }
    }
    // QR 登录后 lastConfirmedCreds 里的 accountId / token / baseUrl /
    // ilinkUserId 是服务端最新 session 绑定凭据,**必须始终覆盖**
    // settings.json 里同名字段(B7.5 fix:旧 token 会让 iLink 返 ret=0 msgs=0,
    // 表现为 connected 但永远收不到消息)。
    if (settings && this.lastConfirmedCreds) {
      const parsedProbe = WeixinBotSettingsSchema.safeParse(settings)
      if (parsedProbe.success) {
        settings = {
          ...parsedProbe.data,
          accountId: this.lastConfirmedCreds.accountId,
          token: this.lastConfirmedCreds.token,
          baseUrl: this.lastConfirmedCreds.baseUrl ?? parsedProbe.data.baseUrl,
          ilinkUserId: this.lastConfirmedCreds.ilinkUserId,
          enabled: parsedProbe.data.enabled ?? true,
        }
      }
    } else if (!settings && this.lastConfirmedCreds) {
      settings = { ...this.lastConfirmedCreds, enabled: true }
    }
    if (!settings) {
      this.setState('unconfigured')
      return
    }
    const parsed = WeixinBotSettingsSchema.safeParse(settings)
    if (!parsed.success) {
      this.setState('failed', `invalid settings: ${parsed.error.message}`)
      return
    }
    const s = parsed.data
    if (!s.enabled) {
      this.setState('disabled')
      return
    }
    if (!s.accountId || !s.token) {
      this.setState('failed', 'accountId/token missing')
      return
    }
    // 走到这里说明凭据齐全 —— configured 转为 true,前端才会从「扫码登录」
    // 切到「设置 / 连接」形态。见 hasCreds 字段的注释。
    this.hasCreds = true
    // 兜底:缺 ilinkUserId 时从 accounts/<id>.json 补上 —— iLink getUpdates
    // 没有它不知道往哪个 WeChat user 路由,即使 session 活着 msgs 永远 0。
    if (!s.ilinkUserId) {
      const persisted = await this.loadAccount(s.accountId)
      if (persisted?.ilinkUserId) {
        s.ilinkUserId = persisted.ilinkUserId
        console.warn(`[weixin.manager] ilinkUserId auto-restored from accounts/${s.accountId}.json`)
      }
    }

    // ── P6:只允许 supervisor 拉起的进程运行通道 ──────────────────────
    const managed = this.deps.isManagedChild ?? isManagedChild
    if (!managed()) {
      this.setState(
        'supervisor_required',
        'weixin channel only runs in a supervisor-managed process (ZAI_SUPERVISOR_PID missing)',
      )
      return
    }

    try {
      await ensureWeixinDirs()
    } catch (err) {
      this.setState('failed', `ensureWeixinDirs failed: ${(err as Error).message}`)
      return
    }

    this.setState('connecting')

    // ── P5:机器级全局单实例锁 ───────────────────────────────────────
    const cwd = (this.deps.resolveCwd ?? resolveWeixinCwd)()
    const acquireOwner = this.deps.acquireOwner ?? ((info) => WeixinOwnerLock.acquire(info))
    const acquireResult = await acquireOwner(buildSelfOwnerInfo({ cwd, accountId: s.accountId }))
    if (!acquireResult.ok) {
      this.ownerLease = null
      this.ownerSnapshot = await WeixinOwnerLock.read()
      this.setState('standby', `another instance owns the weixin channel: ${acquireResult.reason}`)
      console.warn(`[weixin.manager] standby — ${acquireResult.reason}`)
      return
    }
    this.ownerLease = acquireResult.handle
    this.ownerSnapshot = await WeixinOwnerLock.read()

    try {
      this.adapter = this.deps.createAdapter(s)
      this.adapter.setEmitter((internal) => this._onInbound(internal))
      const ok = await this.adapter.connect()
      if (!ok) {
        this.lastError = this.adapter.status().lastError ?? 'connect failed'
        await this.releaseOwner()
        this.setState('failed', this.lastError)
        return
      }

      // bridge 拿到 settings 快照 + 出站回调(配对提示 / 错误回执用)
      this.bridge.configure({
        accountId: s.accountId,
        dmPolicy: s.dmPolicy,
        groupPolicy: s.groupPolicy,
        allowFrom: s.allowFrom,
        sendToChat: (chatId, text) => {
          const a = this.adapter
          if (!a) return
          this.bridge.noteOutbound()
          return a.sendText(chatId, text)
        },
      })

      this._subscribeOutbound()
      this.setState('connected')
      await this.refreshMetrics()

      // P2:崩溃重放 —— connect 之后再重放,保证出站通道已就绪。
      try {
        const n = await this.bridge.replayPending()
        if (n > 0) await this.refreshMetrics()
      } catch (err) {
        console.warn('[weixin.manager] replayPending failed:', err)
      }
    } catch (err) {
      await this.releaseOwner()
      this.setState('failed', (err as Error).message)
    }
  }

  async stop(): Promise<void> {
    if (this.busUnsub) {
      try { this.busUnsub() } catch { /* ignore */ }
      this.busUnsub = null
    }
    this.clearOutboundState()
    try { this.bridge.configure(null) } catch { /* ignore */ }
    if (this.adapter) {
      try { await this.adapter.disconnect() } catch { /* ignore */ }
      this.adapter = null
    }
    await this.releaseOwner()
    this.setState('disconnected')
  }

  /** 重新连接(用户改 settings 后) */
  async reload(): Promise<void> {
    await this.stop()
    await this.start()
  }

  /**
   * 释放全局 owner 锁。同时清掉 owner 快照(自己已不再持有)。
   */
  async releaseOwner(): Promise<void> {
    if (this.ownerLease) {
      try { await this.ownerLease.release() } catch { /* ignore */ }
      this.ownerLease = null
    }
  }

  /** 读当前机器级 owner(即使不是本进程)。 */
  async readOwner(): Promise<WeixinOwnerSnapshot | null> {
    this.ownerSnapshot = await WeixinOwnerLock.read()
    return this.ownerSnapshot
  }

  /**
   * 最近入站消息(新→旧,最多 50 条)。面板打开时轮询 `/diagnostics` 取。
   * 进程内内存态 —— 重启即清空,不需要持久化(持久化那部分是 P2 的
   * WeixinPendingStore,负责不丢消息,不是拿来做展示的)。
   */
  listRecentInbound(): Array<{
    id: string
    ts: number
    senderId: string
    chatType: string
    chatId: string
    text: string
    mediaCount: number
  }> {
    return [...this.recentInbound]
  }

  /** 清掉非存活持有者的锁,便于本进程接管(P7)。 */
  async forceTakeoverOwner(): Promise<{ ok: boolean; reason: string }> {
    const result = await WeixinOwnerLock.forceTakeover()
    await this.refreshMetrics()
    return result
  }

  /** 会话绑定列表(诊断 / Web 面板)。 */
  async listSessionBindings(): Promise<WeixinSessionBinding[]> {
    return getWeixinSessionMap().list()
  }

  /** 上传凭据(用于 QR 登录) */
  async saveAccount(
    accountId: string,
    token: string,
    baseUrl?: string,
    ilinkUserId?: string,
  ): Promise<void> {
    const safe = accountId.replace(/[^a-zA-Z0-9_@.-]/g, '_')
    const { weixinAccountsDir } = await import('../paths.js')
    const accountsDir = weixinAccountsDir()
    await mkdir(accountsDir, { recursive: true })
    const path = join(accountsDir, `${safe}.json`)
    const payload = {
      accountId,
      token,
      baseUrl: baseUrl ?? 'https://ilinkai.weixin.qq.com',
      ilinkUserId,
      createdAt: new Date().toISOString(),
    }
    await writeFile(path, JSON.stringify(payload, null, 2), { mode: 0o600 })
  }

  async loadAccount(accountId: string): Promise<{ token: string; baseUrl?: string; ilinkUserId?: string } | null> {
    const safe = accountId.replace(/[^a-zA-Z0-9_@.-]/g, '_')
    const { weixinAccountsDir } = await import('../paths.js')
    const path = join(weixinAccountsDir(), `${safe}.json`)
    if (!existsSync(path)) return null
    try {
      const raw = JSON.parse(await readFile(path, 'utf-8')) as {
        token: string
        baseUrl?: string
        ilinkUserId?: string
      }
      return { token: raw.token, baseUrl: raw.baseUrl, ilinkUserId: raw.ilinkUserId }
    } catch {
      return null
    }
  }

  /**
   * 启动兜底:`accounts/<id>.json` 持久化了 QR 扫码的
   * accountId/token/ilinkUserId,挑 mtime 最新的那一个恢复。
   * 不删除老 accounts(用户可能想换回老 bot),不强制覆盖 settings。
   */
  async loadLatestAccount(): Promise<{
    accountId: string
    token: string
    baseUrl?: string
    ilinkUserId?: string
  } | null> {
    try {
      const { readdir, stat } = await import('node:fs/promises')
      const { weixinAccountsDir } = await import('../paths.js')
      const accountsDir = weixinAccountsDir()
      const files = (await readdir(accountsDir)).filter((f) => f.endsWith('.json'))
      if (files.length === 0) return null
      let latest: { file: string; mtime: number } | null = null
      for (const f of files) {
        const p = join(accountsDir, f)
        const s = await stat(p)
        if (!latest || s.mtimeMs > latest.mtime) latest = { file: f, mtime: s.mtimeMs }
      }
      if (!latest) return null
      const raw = JSON.parse(
        await readFile(join(accountsDir, latest.file), 'utf-8'),
      ) as {
        accountId: string
        token: string
        baseUrl?: string
        ilinkUserId?: string
      }
      return {
        accountId: raw.accountId,
        token: raw.token,
        baseUrl: raw.baseUrl,
        ilinkUserId: raw.ilinkUserId,
      }
    } catch {
      return null
    }
  }

  // ─── 内部:入站派发 ──────────────────────────────────────────

  private _onInbound(msg: InternalWeixinMessage): void {
    if (!this.adapter) return
    // 面板「最近入站消息」数据源(环形缓冲,最多 50 条)。放在最前面:
    // 即使后面 deliver 抛错,用户也能在面板看到「消息到了」。
    try {
      this.recentInbound.unshift({
        id: msg.messageId,
        ts: Date.now(),
        senderId: msg.senderId,
        chatType: msg.chatType,
        chatId: msg.chatId,
        text: msg.text ?? '',
        mediaCount: msg.mediaPaths?.length ?? 0,
      })
      if (this.recentInbound.length > 50) this.recentInbound.length = 50
    } catch {
      /* 观测面失败不影响主链路 */
    }
    // 观测事件的 sid 仍用 `weixin:<acct>:<chatType>:<chatId>` 关联键 ——
    // 它只给 SSE / Web 面板消费,不是 zai sessionId(后者走映射表)。
    const sessionId = `weixin:${msg.accountId}:${msg.chatType}:${msg.chatId}`
    try {
      eventBus.emit({
        type: 'weixin.inbound',
        sessionId,
        accountId: msg.accountId,
        chatType: msg.chatType,
        chatId: msg.chatId,
        senderId: msg.senderId,
        text: msg.text,
        mediaPaths: msg.mediaPaths,
        mediaTypes: msg.mediaTypes,
        messageId: msg.messageId,
        contextToken: msg.contextToken,
        raw: msg.raw,
      } as unknown as ServerEvent)
    } catch (err) {
      this.lastError = `eventBus.emit weixin.inbound failed: ${(err as Error).message}`
    }
    // P0:注入 agent 运行时。deliver 内部自带幂等 + 异常兜底,
    // 绝不向上抛打挂 poll loop。
    void this.bridge.deliver(msg)
  }

  // ─── 出站镜像:订阅 runtime.* ─────────────────────────────────

  private clearOutboundState(): void {
    this.outboundBuffers.clear()
    this.outboundSent.clear()
    for (const t of this.firstTokenTimers.values()) clearTimeout(t)
    this.firstTokenTimers.clear()
    this.lastTypingAt.clear()
  }

  private _subscribeOutbound(): void {
    if (!this.adapter) return
    this.busUnsub = eventBus.subscribe((event: ServerEvent) => {
      try {
        this._handleOutboundEvent(event)
      } catch (err) {
        this.lastError = `outbound subscribe err: ${(err as Error).message}`
      }
    })
  }

  /**
   * 出站路由:sessionId → WeixinSessionMap 反查 chatId(O(1) 精确匹配),
   * 取代旧的 `sid.split(':').slice(3).join(':')` 前缀 hack。
   */
  private _handleOutboundEvent(event: ServerEvent): void {
    const sid = (event as { sessionId?: string }).sessionId
    if (!sid) return
    const binding = getWeixinSessionMap().lookupBySessionIdSync(sid)
    if (!binding) return
    const chatId = binding.chatId

    switch (event.type) {
      case 'runtime.started': {
        this.outboundSent.delete(sid)
        this.firstTokenTimers.delete(sid)
        if (FIRST_TOKEN_NOTICE_MS > 0) {
          const timer = setTimeout(() => {
            this.firstTokenTimers.delete(sid)
            const a = this.adapter
            if (!a) return
            if (this.outboundBuffers.get(sid)?.text) return
            if (this.outboundSent.has(sid)) return
            this.outboundSent.add(sid)
            this.bridge.noteOutbound()
            void a.sendText(chatId, '正在处理…').catch(() => { /* ignore */ })
          }, FIRST_TOKEN_NOTICE_MS)
          timer.unref?.()
          this.firstTokenTimers.set(sid, timer)
        }
        this._sendTypingThrottled(chatId, 'start')
        break
      }
      case 'runtime.delta': {
        this._clearFirstTokenTimer(sid)
        const delta = (event as { delta?: string }).delta ?? ''
        const existing = this.outboundBuffers.get(sid)
        if (existing) existing.text += delta
        else this.outboundBuffers.set(sid, { chatId, text: delta })
        break
      }
      case 'runtime.tool_call': {
        // P3-4:长任务期间保持 typing 存活。
        this._sendTypingThrottled(chatId, 'start')
        break
      }
      case 'runtime.done': {
        this._clearFirstTokenTimer(sid)
        const buf = this.outboundBuffers.get(sid)
        this.outboundBuffers.delete(sid)
        const sentBefore = this.outboundSent.delete(sid)
        const a = this.adapter
        if (!a) return
        if (buf?.text) {
          this.bridge.noteOutbound()
          void a.sendText(chatId, buf.text).catch(() => { /* logged in adapter */ })
        } else if (!sentBefore) {
          // D4:空输出且此前没发过任何内容 → 兜底提示,避免用户干等。
          this.bridge.noteOutbound()
          void a.sendText(chatId, '（本次没有产生可回复的内容）').catch(() => { /* ignore */ })
        }
        void a.sendTyping(chatId, 'stop').catch(() => { /* ignore */ })
        break
      }
      case 'runtime.error': {
        const errEvent = event as { error?: { category?: string; message?: string }; toolUseId?: string }
        // 工具级失败(toolUseId 存在)不单独回执 —— 会被 agent 自己处理,
        // 逐条回执会把微信刷屏。只回 turn / 引擎级错误。
        if (errEvent.toolUseId) return
        this._clearFirstTokenTimer(sid)
        this.outboundBuffers.delete(sid)
        this.outboundSent.delete(sid)
        const a = this.adapter
        if (!a) return
        this.bridge.noteOutbound()
        void a.sendText(chatId, renderErrorForWeixin(errEvent.error)).catch(() => { /* ignore */ })
        void a.sendTyping(chatId, 'stop').catch(() => { /* ignore */ })
        break
      }
      case 'runtime.aborted': {
        this._clearFirstTokenTimer(sid)
        this.outboundBuffers.delete(sid)
        this.outboundSent.delete(sid)
        const a = this.adapter
        if (!a) return
        this.bridge.noteOutbound()
        void a.sendText(chatId, '已中断本次任务。').catch(() => { /* ignore */ })
        void a.sendTyping(chatId, 'stop').catch(() => { /* ignore */ })
        break
      }
      default:
        break
    }
  }

  private _clearFirstTokenTimer(sid: string): void {
    const t = this.firstTokenTimers.get(sid)
    if (t) {
      clearTimeout(t)
      this.firstTokenTimers.delete(sid)
    }
  }

  private _sendTypingThrottled(chatId: string, status: 'start' | 'stop'): void {
    const a = this.adapter
    if (!a) return
    const now = Date.now()
    const last = this.lastTypingAt.get(chatId) ?? 0
    if (status === 'start' && now - last < TYPING_REFRESH_MS) return
    this.lastTypingAt.set(chatId, now)
    void a.sendTyping(chatId, status).catch(() => { /* ignore */ })
  }

  /** 给测试 / 诊断用:暴露 adapter */
  getAdapter(): WeixinAdapter | null { return this.adapter }

  // ─── QR 登录 wizard (B5) ─────────────────────────────────────

  /** 启动 QR 登录流程 —— 调 iLink getBotQrcode,服务端渲染 QR PNG data URL */
  async startSetup(): Promise<{ qrcodeId: string; qrcodeUrl: string; pollUrl: string } | null> {
    const dummySettings: WeixinBotSettings = {
      enabled: true,
      accountId: 'pending',
      token: 'pending',
      baseUrl: 'https://ilinkai.weixin.qq.com',
      cdnBaseUrl: 'https://novac2c.cdn.weixin.qq.com/c2c',
      dmPolicy: 'pairing',
      groupPolicy: 'disabled',
      allowFrom: [],
      groupAllowFrom: [],
      textBatchDelaySeconds: 3.0,
      textBatchSplitDelaySeconds: 5.0,
      sendChunkDelaySeconds: 1.5,
      sendChunkRetries: 4,
      rateLimitCircuitThreshold: 1,
      rateLimitCircuitOpenSeconds: 30.0,
    }
    // 归一化成完整 settings(补 schema 默认值),createAdapter 契约要求完整形状。
    const parsedBase = WeixinBotSettingsSchema.safeParse(this.deps.getSettings() ?? dummySettings)
    const baseSettings: WeixinBotSettings = parsedBase.success ? parsedBase.data : dummySettings
    if (!this.adapter) {
      try {
        this.adapter = this.deps.createAdapter(baseSettings)
      } catch {
        return null
      }
    }
    const iLink = this.adapter.getClient()
    const result = await iLink.getBotQrcode()
    // iLink 真实 schema:`qrcode` (ID) + `qrcode_img_content` (URL);hermes 旧实现用
    // `qrcode_id` / `qrcode_url`,都接受,normalize 到统一字段。
    const qrcodeId = result.qrcode ?? result.qrcode_id
    const scanUrl = result.qrcode_img_content ?? result.qrcode_url ?? result.qrcode_img_url
    if (!qrcodeId || !scanUrl) return null
    let qrcodeUrl: string
    try {
      qrcodeUrl = await QRCode.toDataURL(scanUrl, {
        errorCorrectionLevel: 'M',
        margin: 2,
        width: 240,
        color: { dark: '#000000', light: '#FFFFFF' },
      })
    } catch (err) {
      this.lastError = `QRCode.toDataURL failed: ${(err as Error).message}`
      return null
    }
    this.activeSetup = {
      qrcodeId,
      qrcodeUrl,
      retries: 0,
      baseSettings,
    }
    return {
      qrcodeId,
      qrcodeUrl,
      pollUrl: `/api/weixin/setup/poll?qrcodeId=${encodeURIComponent(qrcodeId)}`,
    }
  }

  /**
   * 轮询 QR 状态。iLink 返回 confirmed 时,自动 saveAccount + reload。
   * expired 时,自动重新拉(最多 3 次,失败超限放弃)。
   */
  async pollSetup(qrcodeId: string): Promise<{
    status: 'waiting' | 'scanned' | 'confirmed' | 'expired' | 'gone'
    accountId?: string
    baseUrl?: string
  }> {
    if (!this.adapter) return { status: 'gone' }
    const iLink = this.adapter.getClient()
    const result = await iLink.getQrcodeStatus(qrcodeId)
    const rawStatus = result.status ?? 'wait'
    const status: 'waiting' | 'scanned' | 'expired' | 'confirmed' =
      rawStatus === 'wait' ? 'waiting' :
      rawStatus === 'scaned' || rawStatus === 'scaned_but_redirect' ? 'scanned' :
      rawStatus
    if (process.env.ZAI_DEBUG === '1') {
      console.warn(`[weixin.pollSetup] raw=${JSON.stringify({
        status: result.status,
        ilink_bot_id: result.ilink_bot_id,
        bot_token: result.bot_token ? `${result.bot_token.slice(0, 8)}...` : undefined,
        account_id: result.account_id,
        token: result.token ? `${result.token.slice(0, 8)}...` : undefined,
        baseurl: result.baseurl,
        base_url: result.base_url,
        ilink_user_id: result.ilink_user_id,
      })} normalized=${status}`)
    }
    const accountId = result.ilink_bot_id ?? result.account_id
    const token = result.bot_token ?? result.token
    const baseUrl = result.baseurl ?? result.base_url
    const ilinkUserId = result.ilink_user_id
    if (status === 'confirmed' && accountId && token) {
      await this.saveAccount(accountId, token, baseUrl, ilinkUserId)
      const base: Partial<WeixinBotSettings> =
        this.activeSetup?.baseSettings ?? this.deps.getSettings() ?? {}
      const creds: WeixinBotSettings = {
        enabled: true,
        accountId,
        token,
        baseUrl: baseUrl ?? base.baseUrl ?? 'https://ilinkai.weixin.qq.com',
        cdnBaseUrl: base.cdnBaseUrl ?? 'https://novac2c.cdn.weixin.qq.com/c2c',
        dmPolicy: base.dmPolicy ?? 'pairing',
        groupPolicy: base.groupPolicy ?? 'disabled',
        allowFrom: base.allowFrom ?? [],
        groupAllowFrom: base.groupAllowFrom ?? [],
        textBatchDelaySeconds: base.textBatchDelaySeconds ?? 3.0,
        textBatchSplitDelaySeconds: base.textBatchSplitDelaySeconds ?? 5.0,
        sendChunkDelaySeconds: base.sendChunkDelaySeconds ?? 1.5,
        sendChunkRetries: base.sendChunkRetries ?? 4,
        rateLimitCircuitThreshold: base.rateLimitCircuitThreshold ?? 1,
        rateLimitCircuitOpenSeconds: base.rateLimitCircuitOpenSeconds ?? 30.0,
        ilinkUserId,
      }
      this.lastConfirmedCreds = creds
      this.hasCreds = true
      this.activeSetup = null
      await this.reload()
      return { status: 'confirmed', accountId, baseUrl }
    }
    if (status === 'expired') {
      if (this.activeSetup && this.activeSetup.retries < 3) {
        const fresh = await iLink.getBotQrcode()
        const freshId = fresh.qrcode ?? fresh.qrcode_id
        const freshScan = fresh.qrcode_img_content ?? fresh.qrcode_url
        if (freshId && freshScan) {
          let freshQrPng: string | null = null
          try {
            freshQrPng = await QRCode.toDataURL(freshScan, {
              errorCorrectionLevel: 'M', margin: 2, width: 240,
            })
          } catch { /* ignore */ }
          if (freshQrPng) {
            this.activeSetup = {
              qrcodeId: freshId,
              qrcodeUrl: freshQrPng,
              retries: this.activeSetup.retries + 1,
              baseSettings: this.activeSetup.baseSettings,
            }
            return { status: 'expired' }
          }
        }
      }
      this.activeSetup = null
      return { status: 'expired' }
    }
    return { status, accountId, baseUrl }
  }

  /** 取消 QR 登录 */
  cancelSetup(): void {
    this.activeSetup = null
  }

  getActiveSetup(): { qrcodeId: string; qrcodeUrl: string; retries: number } | null {
    return this.activeSetup
  }
}

/**
 * 渲染给微信用户的错误回执(D4)。**不透传原始堆栈** —— 里面可能含本机
 * 绝对路径 / 密钥。只给分类提示 + 脱敏后的短消息。
 */
export function renderErrorForWeixin(error?: { category?: string; message?: string }): string {
  const category = error?.category ?? 'internal'
  const hint =
    category === 'rate_limit'
      ? '上游限流了,请稍后重试。'
      : category === 'auth'
        ? '鉴权失败,请检查 zai 侧的模型配置。'
        : category === 'timeout'
          ? '执行超时了,请重试或缩小任务范围。'
          : '执行出错了。'
  const detail = sanitizeForWeixin(error?.message)
  return detail ? `${hint}\n(${category}: ${detail})` : `${hint}\n(${category})`
}

/** 脱敏:去掉绝对路径,截断长度。 */
function sanitizeForWeixin(message?: string): string {
  if (!message) return ''
  const redacted = message
    .replace(/\/[\w.@-]+(?:\/[\w.@-]+)+/g, '<path>')
    .replace(/[A-Za-z]:\\[\w.@\\-]+/g, '<path>')
  return redacted.length > 200 ? `${redacted.slice(0, 200)}…` : redacted
}

// 单例 — 与 zai 主进程同进程启动,受管进程由 weixinRuntimeBoot 自动拉起。
let _instance: WeixinBotManager | null = null
export function getWeixinBotManager(): WeixinBotManager {
  if (!_instance) _instance = new WeixinBotManager()
  return _instance
}

export function resetWeixinBotManagerForTests(): void {
  _instance = null
}

// re-export type for test convenience
export type { WeixinAdapter }
