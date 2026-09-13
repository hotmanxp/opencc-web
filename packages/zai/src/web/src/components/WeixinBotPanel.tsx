/**
 * WeixinBotPanel — 微信机器人配置 UI (Vite + React + AntD)。
 *
 * 入口:SettingsDrawer 顶部"微信机器人"按钮触发 Modal 渲染此组件。
 * 包含 4 个 section:
 *   1. StatusBanner: 当前状态 / accountId / lastError / 启停按钮
 *   2. SetupSection: 未配置时显示 "扫描二维码" 按钮 + 渲染 QR
 *      + 轮询状态(scanned / confirmed / expired)
 *   3. SettingsForm: 已配置时显示 dmPolicy / groupPolicy / allowFrom 等表单
 *   4. InboxPreview: 实时展示最近 50 条入站消息(SSE 订阅 weixin:* sessionId)
 *
 * 数据来源:apiRpc.weixin.* 类型化 RPC stub。
 * SSE 订阅:沿用现有 useEventStream hook,filter event.sessionId.startsWith('weixin:')。
 */
import { useEffect, useState, useCallback, useRef } from 'react'
import { Modal, Button, Input, Select, message, Spin, Alert, Tag } from 'antd'
import { apiRpc } from '../lib/api.js'

interface WeixinStatus {
  configured: boolean
  enabled: boolean
  state:
    | 'unconfigured'
    | 'disabled'
    | 'failed'
    | 'connecting'
    | 'connected'
    | 'disconnected'
    | 'reconnecting'
    | 'standby'
    | 'supervisor_required'
  accountId?: string
  lastError?: string
  lastConnAt?: number
  owner?: boolean
  ownerInfo?: OwnerInfo | null
  metrics?: {
    inbound: number
    outbound: number
    pendingReplay: number
    pairingPending: number
    boundSessions: number
  }
}

/** P5/P7:机器级通道持有者(全局单实例锁)。 */
interface OwnerInfo {
  instanceId: string
  pid: number
  supervisorPid: number | null
  port: number | null
  cwd: string
  accountId: string
  hostname: string
  startedAt: number
  self: boolean
  live: boolean
}

/** P1:配对白名单 + 待批准队列。 */
interface PairingAllowed {
  senderId: string
  displayName?: string
  pairedAt: number
  approvedVia: 'web' | 'code'
}
interface PairingPending {
  senderId: string
  displayName?: string
  code: string
  requestedAt: number
  expiresAt: number
  attempts: number
}
interface Pairings {
  allowed: PairingAllowed[]
  pending: PairingPending[]
}

/** P4:会话绑定(微信对话 → zai sessionId)。 */
interface SessionBinding {
  conversationKey: string
  sessionId: string
  cwd: string
  accountId: string
  chatType: 'dm' | 'group'
  chatId: string
  senderId: string
  lastActiveAt: number
}

interface SetupState {
  qrcodeId?: string
  qrcodeUrl?: string
  status: 'idle' | 'waiting' | 'scanned' | 'confirmed' | 'expired'
}

interface InboxItem {
  id: string
  ts: number
  /** 关联键 `weixin:<acct>:<chatType>:<chatId>`(仅 SSE 路径带;diagnostics 不带) */
  sessionId?: string
  accountId?: string
  chatId: string
  chatType: 'dm' | 'group'
  senderId: string
  text: string
  /** SSE 路径带实际路径 */
  mediaPaths?: string[]
  /** diagnostics 路径只带条数 */
  mediaCount?: number
}

export interface WeixinBotPanelProps {
  open: boolean
  onClose: () => void
  /** SSE 流入的 weixin.inbound 事件 payload (从 useEventStream 传过来) */
  inboxStream?: InboxItem[]
}

export function WeixinBotPanel({ open, onClose, inboxStream = [] }: WeixinBotPanelProps) {
  const [status, setStatus] = useState<WeixinStatus | null>(null)
  const [setup, setSetup] = useState<SetupState>({ status: 'idle' })
  const [loading, setLoading] = useState(false)
  const [inbox, setInbox] = useState<InboxItem[]>([])
  const [dmPolicy, setDmPolicy] = useState<string>('pairing')
  const [groupPolicy, setGroupPolicy] = useState<string>('disabled')
  const [allowFrom, setAllowFrom] = useState<string>('')
  const [pairings, setPairings] = useState<Pairings>({ allowed: [], pending: [] })
  const [bindings, setBindings] = useState<SessionBinding[]>([])
  // polling handle 走 ref 而不是 state,避免 stale 闭包 + 每次 setInterval 重启
  // 时拿到旧的 interval id。
  const pollingRef = useRef<ReturnType<typeof setInterval> | null>(null)

  const refresh = useCallback(async () => {
    try {
      const s = await apiRpc.weixin.status.get()
      setStatus(s as WeixinStatus)
    } catch (err) {
      message.error(`获取状态失败: ${(err as Error).message}`)
    }
  }, [])

  const loadPairings = useCallback(async () => {
    try {
      const r = await fetch('/api/weixin/pairings')
      if (!r.ok) return
      setPairings((await r.json()) as Pairings)
    } catch {
      // 观测面失败不打扰用户
    }
  }, [])

  const loadDiagnostics = useCallback(async () => {
    try {
      const r = await fetch('/api/weixin/diagnostics')
      if (!r.ok) return
      const d = (await r.json()) as {
        bindings?: SessionBinding[]
        status?: WeixinStatus
        recentInbound?: InboxItem[]
      }
      setBindings(d.bindings ?? [])
      // 入站消息走服务端环形缓冲。原因:`weixin.inbound` 的 SSE 事件用的是
      // 关联键 sessionId(`weixin:<acct>:...`),而服务端 SSE 按当前 tab 的
      // zai sessionId 过滤,面板永远收不到 —— 所以别指望 inboxStream,
      // 打开面板时轮询 diagnostics。
      if (d.recentInbound) setInbox(d.recentInbound)
      if (d.status) setStatus((prev) => ({ ...(prev ?? ({} as WeixinStatus)), ...d.status } as WeixinStatus))
    } catch {
      // ignore
    }
  }, [])

  // 面板打开期间轮询 diagnostics(3s),让「最近入站消息 / 会话绑定 / 计数」
  // 实时起来。关闭即停,不给后端白刷请求。
  useEffect(() => {
    if (!open) return
    const t = setInterval(() => {
      void loadDiagnostics()
    }, 3_000)
    return () => clearInterval(t)
  }, [open, loadDiagnostics])

  useEffect(() => {
    if (!open) return
    void refresh()
    void loadPairings()
    void loadDiagnostics()
  }, [open, refresh, loadPairings, loadDiagnostics])

  const pairingAction = useCallback(
    async (action: 'approve' | 'reject' | 'revoke', senderId: string) => {
      try {
        const r = await fetch(`/api/weixin/pairings/${action}`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ senderId }),
        })
        if (!r.ok) throw new Error(`HTTP ${r.status}`)
        setPairings((await r.json()) as Pairings)
        await refresh()
      } catch (err) {
        message.error(`操作失败: ${(err as Error).message}`)
      }
    },
    [refresh],
  )

  const handleTakeover = useCallback(async () => {
    setLoading(true)
    try {
      const r = await fetch('/api/weixin/owner/takeover', { method: 'POST' })
      const body = (await r.json()) as { ok: boolean; reason: string }
      if (!body.ok) throw new Error(body.reason)
      message.success('已清除失联持有者的锁,可重试连接')
      await loadDiagnostics()
      await refresh()
    } catch (err) {
      message.error(`接管失败: ${(err as Error).message}`)
    } finally {
      setLoading(false)
    }
  }, [loadDiagnostics, refresh])

  // SSE 入站消息累积
  useEffect(() => {
    if (inboxStream.length === 0) return
    setInbox((prev) => {
      const merged = [...inboxStream, ...prev].slice(0, 50)
      return merged
    })
  }, [inboxStream])

  // 轮询 QR 状态。interval id 走 ref(不存 state)避免 stale 闭包 + effect 重跑
  // 时拿到旧的 t。确认(expired)时清掉 interval 并 refresh status;不能用
  // setSetup({...}) 直接替换,会丢掉 qrcodeId/qrcodeUrl 让 UI 闪回"连接微信"。
  // interval 5s — iLink QR 有效期实测 1-2 分钟,过短会让 server 端多次并发
  // 争抢同一 long-poll 槽,过长则用户扫码到 confirmed 状态推送不及时。5s 是
  // 经验折中(每个 poll 第一次 hold ~30s 后 iLink 返 wait,后续取消并重新
  // 发起)。B7.5: iLink get_qrcode_status timeout 35s,需要 > 35s 才能避免
  // client 端 abort,但前端 interval 仍按 5s — 长轮询回包后立刻发下一个。
  useEffect(() => {
    if (!setup.qrcodeId) return
    if (pollingRef.current) return
    const qrcodeId = setup.qrcodeId
    const t = setInterval(async () => {
      try {
        // B7.5:不用 apiRpc.weixin.setup.poll.get —— generated stub 走 GET +
        // body 路径,浏览器 fetch 规范禁止 GET 带 body 会抛 TypeError。这里
        // 自己构造 query string,GET 才是这个端点的真实形态(routes/weixin.ts
        // 也是从 req.query.qrcodeId 读)。后续若改 apiBase 支持 GET + query
        // 自动转换,这里可以恢复 stub。
        const r = await fetch(`/api/weixin/setup/poll?qrcodeId=${encodeURIComponent(qrcodeId)}`).then((res) => {
          if (!res.ok) throw new Error(`poll HTTP ${res.status}`)
          return res.json() as Promise<{ status: 'waiting' | 'scanned' | 'confirmed' | 'expired' | 'gone'; accountId?: string; baseUrl?: string }>
        })
        const nextStatus = r.status as SetupState['status']
        setSetup((s) => ({ ...s, status: nextStatus }))
        if (r.status === 'confirmed' || r.status === 'expired') {
          if (pollingRef.current) {
            clearInterval(pollingRef.current)
            pollingRef.current = null
          }
          if (r.status === 'confirmed') void refresh()
        }
      } catch (err) {
        console.warn(`[weixin-panel] poll err:`, err)
      }
    }, 5_000)
    pollingRef.current = t
    return () => {
      if (pollingRef.current) {
        clearInterval(pollingRef.current)
        pollingRef.current = null
      }
    }
  }, [setup.qrcodeId, refresh])

  const handleStartSetup = useCallback(async () => {
    setLoading(true)
    try {
      const r = await apiRpc.weixin.setup.start.post(undefined)
      setSetup({ qrcodeId: r.qrcodeId, qrcodeUrl: r.qrcodeUrl, status: 'waiting' })
    } catch (err) {
      console.warn('[weixin-panel] setup/start error:', err)
      message.error(`启动 QR 登录失败: ${(err as Error).message}`)
    } finally {
      setLoading(false)
    }
  }, [])

  const handleCancelSetup = useCallback(async () => {
    if (pollingRef.current) {
      clearInterval(pollingRef.current)
      pollingRef.current = null
    }
    try {
      await apiRpc.weixin.setup.cancel.post(undefined)
    } catch {
      // ignore
    }
    setSetup({ status: 'idle' })
  }, [])

  const handleConnect = useCallback(async () => {
    setLoading(true)
    try {
      const r = await apiRpc.weixin.connect.post(undefined)
      setStatus(r as WeixinStatus)
    } catch (err) {
      message.error(`连接失败: ${(err as Error).message}`)
    } finally {
      setLoading(false)
    }
  }, [])

  const handleDisconnect = useCallback(async () => {
    setLoading(true)
    try {
      const r = await apiRpc.weixin.disconnect.post(undefined)
      setStatus(r as WeixinStatus)
    } catch (err) {
      message.error(`断开失败: ${(err as Error).message}`)
    } finally {
      setLoading(false)
    }
  }, [])

  const handleSaveSettings = useCallback(async () => {
    // 简化:实际上 settings 持久化应该走 agentSettings 接口,这里只 reload
    setLoading(true)
    try {
      await apiRpc.weixin.reload.post(undefined)
      message.success('已应用,若需设置 allowFrom 等请编辑 ~/.zai/settings.json')
      void refresh()
    } catch (err) {
      message.error(`保存失败: ${(err as Error).message}`)
    } finally {
      setLoading(false)
    }
  }, [refresh])

  return (
    <Modal
      title="微信机器人"
      open={open}
      onCancel={onClose}
      footer={null}
      width={620}
    >
      <Spin spinning={loading}>
        {/* 1. StatusBanner */}
        <div className="mb-4">
          <h4>状态</h4>
          {status ? (
            <div>
              <Tag color={stateColor(status.state)}>{status.state}</Tag>
              {status.owner && <Tag color="green">本实例持有通道</Tag>}
              {status.accountId && (
                <span className="ml-2">accountId: <code>{status.accountId}</code></span>
              )}
              {status.state === 'supervisor_required' && (
                <Alert
                  type="warning"
                  className="mt-2"
                  message="微信通道只由 supervisor 拉起的进程启动"
                  description="当前进程没有 ZAI_SUPERVISOR_PID。请用默认的 `zai start`(会经 supervisor 托管)启动,而不是裸 dev / 直连进程。"
                />
              )}
              {status.state === 'standby' && (
                <Alert
                  type="info"
                  className="mt-2"
                  message="本机已有另一个助手实例持有微信通道"
                  description={
                    status.ownerInfo
                      ? `持有者 pid=${status.ownerInfo.pid} instance=${status.ownerInfo.instanceId} port=${status.ownerInfo.port ?? '-'}。同一台电脑只允许一个实例收发微信消息。`
                      : '另一个实例正在持有通道。'
                  }
                />
              )}
              {status.lastError && (
                <Alert
                  type="error"
                  message={status.lastError}
                  className="mt-2"
                />
              )}
              <div className="mt-2">
                {status.state === 'connected' ? (
                  <Button onClick={handleDisconnect}>断开</Button>
                ) : (
                  <Button
                    onClick={handleConnect}
                    type="primary"
                    disabled={!status.configured || status.state === 'supervisor_required'}
                  >
                    连接
                  </Button>
                )}
              </div>
            </div>
          ) : (
            <Spin />
          )}
        </div>

        {/* 1b. 通道持有者 (P7) */}
        {status && (status.owner || status.ownerInfo) && (
          <div className="mb-4">
            <h4>通道持有者 (全局单实例锁)</h4>
            {status.ownerInfo ? (
              <div className="text-xs">
                <div>
                  pid <code>{status.ownerInfo.pid}</code> · instance{' '}
                  <code>{status.ownerInfo.instanceId}</code> · port{' '}
                  <code>{status.ownerInfo.port ?? '-'}</code>{' '}
                  {status.ownerInfo.self ? <Tag color="green">本实例</Tag> : <Tag>其他实例</Tag>}{' '}
                  {status.ownerInfo.live ? <Tag color="blue">存活</Tag> : <Tag color="red">已失联</Tag>}
                </div>
                <div className="text-[#999] mt-1">cwd: {status.ownerInfo.cwd}</div>
                {!status.ownerInfo.self && !status.ownerInfo.live && (
                  <Button size="small" className="mt-2" onClick={handleTakeover}>
                    清除失联锁并接管
                  </Button>
                )}
              </div>
            ) : (
              <p className="text-[#999]">本实例持有通道。</p>
            )}
          </div>
        )}

        {/* 1c. 配对鉴权 (P1) */}
        {status?.configured && (
          <div className="mb-4">
            <h4>配对鉴权</h4>
            {pairings.pending.length === 0 ? (
              <p className="text-[#999]">暂无待批准请求</p>
            ) : (
              <div className="border border-[#eee] p-2">
                {pairings.pending.map((p) => (
                  <div key={p.senderId} className="border-b border-[#f0f0f0] p-1 flex items-center justify-between">
                    <div>
                      <div className="text-xs">
                        <code>{p.senderId}</code>
                        {p.displayName ? ` (${p.displayName})` : ''} · 配对码 <b>{p.code}</b>
                      </div>
                      <div className="text-[11px] text-[#999]">
                        请与对方核对配对码后批准 · 过期 {new Date(p.expiresAt).toLocaleTimeString()}
                      </div>
                    </div>
                    <div>
                      <Button size="small" type="primary" onClick={() => void pairingAction('approve', p.senderId)}>
                        批准
                      </Button>
                      <Button size="small" className="ml-1" onClick={() => void pairingAction('reject', p.senderId)}>
                        拒绝
                      </Button>
                    </div>
                  </div>
                ))}
              </div>
            )}
            {pairings.allowed.length > 0 && (
              <div className="mt-2">
                <div className="text-xs text-[#666]">已批准:</div>
                {pairings.allowed.map((a) => (
                  <div key={a.senderId} className="text-xs flex items-center justify-between border-b border-[#f7f7f7] p-1">
                    <span>
                      <code>{a.senderId}</code>
                      {a.displayName ? ` (${a.displayName})` : ''} · {a.approvedVia}
                    </span>
                    <Button size="small" danger onClick={() => void pairingAction('revoke', a.senderId)}>
                      吊销
                    </Button>
                  </div>
                ))}
              </div>
            )}
          </div>
        )}

        {/* 2. SetupSection */}
        {(!status?.configured || status?.state === 'unconfigured') && (
          <div className="mb-4">
            <h4>扫码登录</h4>
            {setup.qrcodeUrl ? (
              <div>
                <img
                  src={setup.qrcodeUrl}
                  alt="WeChat QR"
                  className="w-[200px] h-[200px] border border-[#ddd]"
                />
                <p className="mt-2">
                  请用微信扫描,状态: <Tag>{setup.status}</Tag>
                </p>
                <Button onClick={handleCancelSetup}>取消</Button>
              </div>
            ) : (
              <Button onClick={handleStartSetup} type="primary">连接微信</Button>
            )}
          </div>
        )}

        {/* 3. SettingsForm */}
        {status?.configured && (
          <div className="mb-4">
            <h4>设置</h4>
            <div className="mb-2">
              <label>DM policy:&nbsp;</label>
              <Select
                aria-label="DM policy"
                value={dmPolicy}
                onChange={setDmPolicy}
                className="w-[180px]"
                options={[
                  { value: 'open', label: 'open' },
                  { value: 'allowlist', label: 'allowlist' },
                  { value: 'pairing', label: 'pairing(默认)' },
                  { value: 'disabled', label: 'disabled' },
                ]}
              />
            </div>
            <div className="mb-2">
              <label>Group policy:&nbsp;</label>
              <Select
                aria-label="Group policy"
                value={groupPolicy}
                onChange={setGroupPolicy}
                className="w-[180px]"
                options={[
                  { value: 'open', label: 'open' },
                  { value: 'allowlist', label: 'allowlist' },
                  { value: 'disabled', label: 'disabled(默认)' },
                ]}
              />
            </div>
            <div className="mb-2">
              <label>Allow From (user IDs, 逗号分隔):&nbsp;</label>
              <Input
                value={allowFrom}
                onChange={(e) => setAllowFrom(e.target.value)}
                placeholder="user_id_1,user_id_2"
                className="w-[280px]"
              />
            </div>
            <Button onClick={handleSaveSettings}>应用</Button>
            <p className="text-xs text-[#999] mt-2">
              实际值持久化在 ~/.zai/settings.json (zaiSettings.weixinBot)。
              应用后会请重启 zai 触发 reload。
            </p>
          </div>
        )}

        {/* 4. InboxPreview */}
        <div>
          <h4>最近入站消息 (实时)</h4>
          {inbox.length === 0 ? (
            <p className="text-[#999]">暂无消息</p>
          ) : (
            <div className="max-h-[240px] overflow-auto border border-[#eee] p-2">
              {inbox.map((item) => {
                const mediaN = item.mediaPaths?.length ?? item.mediaCount ?? 0
                return (
                  <div key={item.id} className="border-b border-[#f0f0f0] p-1">
                    <div className="text-xs text-[#666]">
                      [{item.chatType}] {item.senderId} → {item.chatId} ·{' '}
                      {new Date(item.ts).toLocaleTimeString()}
                    </div>
                    <div className="mt-[2px]">{item.text || <i>(空)</i>}</div>
                    {mediaN > 0 && (
                      <div className="text-[11px] text-[#999]">
                        媒体: {mediaN} 个
                      </div>
                    )}
                  </div>
                )
              })}
            </div>
          )}
        </div>
        {/* 5. 诊断 (P4) */}
        <div className="mt-4">
          <h4>诊断</h4>
          {status?.metrics && (
            <div className="text-xs mb-2">
              入站 <b>{status.metrics.inbound}</b> · 出站 <b>{status.metrics.outbound}</b> ·
              待重放 <b>{status.metrics.pendingReplay}</b> · 待配对 <b>{status.metrics.pairingPending}</b> ·
              已绑定会话 <b>{status.metrics.boundSessions}</b>
            </div>
          )}
          {bindings.length === 0 ? (
            <p className="text-[#999]">暂无会话绑定</p>
          ) : (
            <div className="max-h-[160px] overflow-auto border border-[#eee] p-2">
              {bindings.map((b) => (
                <div key={b.sessionId} className="text-xs border-b border-[#f0f0f0] p-1">
                  <code>{b.sessionId}</code> ← [{b.chatType}] {b.chatId}
                  <div className="text-[11px] text-[#999]">cwd: {b.cwd}</div>
                </div>
              ))}
            </div>
          )}
        </div>
      </Spin>
    </Modal>
  )
}

function stateColor(state: WeixinStatus['state']): string {
  switch (state) {
    case 'connected':
      return 'green'
    case 'connecting':
      return 'blue'
    case 'reconnecting':
      return 'orange'
    case 'failed':
      return 'red'
    // P5:另一实例持有通道 —— 本进程待命,不是错误。
    case 'standby':
      return 'orange'
    // P6:非受管进程 —— 需要用户换启动方式。
    case 'supervisor_required':
      return 'gold'
    case 'disconnected':
      return 'default'
    case 'disabled':
      return 'default'
    default:
      return 'default'
  }
}
