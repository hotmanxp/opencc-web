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
  state: 'unconfigured' | 'disabled' | 'failed' | 'connecting' | 'connected' | 'disconnected'
  accountId?: string
  lastError?: string
  lastConnAt?: number
}

interface SetupState {
  qrcodeId?: string
  qrcodeUrl?: string
  status: 'idle' | 'waiting' | 'scanned' | 'confirmed' | 'expired'
}

interface InboxItem {
  id: string
  ts: number
  sessionId: string
  accountId: string
  chatId: string
  chatType: 'dm' | 'group'
  senderId: string
  text: string
  mediaPaths: string[]
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

  useEffect(() => {
    if (open) void refresh()
  }, [open, refresh])

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
    console.warn(`[weixin-panel] poll effect enter qrcodeId=${setup.qrcodeId} pollingRef=${pollingRef.current ? 'set' : 'null'}`)
    if (pollingRef.current) return
    const qrcodeId = setup.qrcodeId
    const t = setInterval(async () => {
      console.warn(`[weixin-panel] poll tick qrcodeId=${qrcodeId}`)
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
        console.warn(`[weixin-panel] poll response:`, r)
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
      console.warn(`[weixin-panel] poll cleanup`)
      if (pollingRef.current) {
        clearInterval(pollingRef.current)
        pollingRef.current = null
      }
    }
  }, [setup.qrcodeId, refresh])

  const handleStartSetup = useCallback(async () => {
    setLoading(true)
    console.warn('[weixin-panel] handleStartSetup click')
    try {
      const r = await apiRpc.weixin.setup.start.post(undefined)
      console.warn('[weixin-panel] setup/start response:', r)
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
        <div style={{ marginBottom: 16 }}>
          <h4>状态</h4>
          {status ? (
            <div>
              <Tag color={stateColor(status.state)}>{status.state}</Tag>
              {status.accountId && (
                <span style={{ marginLeft: 8 }}>accountId: <code>{status.accountId}</code></span>
              )}
              {status.lastError && (
                <Alert
                  type="error"
                  message={status.lastError}
                  style={{ marginTop: 8 }}
                />
              )}
              <div style={{ marginTop: 8 }}>
                {status.state === 'connected' ? (
                  <Button onClick={handleDisconnect}>断开</Button>
                ) : (
                  <Button onClick={handleConnect} type="primary" disabled={!status.configured}>
                    连接
                  </Button>
                )}
              </div>
            </div>
          ) : (
            <Spin />
          )}
        </div>

        {/* 2. SetupSection */}
        {(!status?.configured || status?.state === 'unconfigured') && (
          <div style={{ marginBottom: 16 }}>
            <h4>扫码登录</h4>
            {setup.qrcodeUrl ? (
              <div>
                <img
                  src={setup.qrcodeUrl}
                  alt="WeChat QR"
                  style={{ width: 200, height: 200, border: '1px solid #ddd' }}
                />
                <p style={{ marginTop: 8 }}>
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
          <div style={{ marginBottom: 16 }}>
            <h4>设置</h4>
            <div style={{ marginBottom: 8 }}>
              <label>DM policy:&nbsp;</label>
              <Select
                value={dmPolicy}
                onChange={setDmPolicy}
                style={{ width: 180 }}
                options={[
                  { value: 'open', label: 'open' },
                  { value: 'allowlist', label: 'allowlist' },
                  { value: 'pairing', label: 'pairing(默认)' },
                  { value: 'disabled', label: 'disabled' },
                ]}
              />
            </div>
            <div style={{ marginBottom: 8 }}>
              <label>Group policy:&nbsp;</label>
              <Select
                value={groupPolicy}
                onChange={setGroupPolicy}
                style={{ width: 180 }}
                options={[
                  { value: 'open', label: 'open' },
                  { value: 'allowlist', label: 'allowlist' },
                  { value: 'disabled', label: 'disabled(默认)' },
                ]}
              />
            </div>
            <div style={{ marginBottom: 8 }}>
              <label>Allow From (user IDs, 逗号分隔):&nbsp;</label>
              <Input
                value={allowFrom}
                onChange={(e) => setAllowFrom(e.target.value)}
                placeholder="user_id_1,user_id_2"
                style={{ width: 280 }}
              />
            </div>
            <Button onClick={handleSaveSettings}>应用</Button>
            <p style={{ fontSize: 12, color: '#999', marginTop: 8 }}>
              实际值持久化在 ~/.zai/settings.json (zaiSettings.weixinBot)。
              应用后会请重启 zai 触发 reload。
            </p>
          </div>
        )}

        {/* 4. InboxPreview */}
        <div>
          <h4>最近入站消息 (实时)</h4>
          {inbox.length === 0 ? (
            <p style={{ color: '#999' }}>暂无消息</p>
          ) : (
            <div style={{ maxHeight: 240, overflow: 'auto', border: '1px solid #eee', padding: 8 }}>
              {inbox.map((item) => (
                <div key={item.id} style={{ borderBottom: '1px solid #f0f0f0', padding: 4 }}>
                  <div style={{ fontSize: 12, color: '#666' }}>
                    [{item.chatType}] {item.senderId} → {item.chatId} · {new Date(item.ts).toLocaleTimeString()}
                  </div>
                  <div style={{ marginTop: 2 }}>{item.text || <i>(空)</i>}</div>
                  {item.mediaPaths.length > 0 && (
                    <div style={{ fontSize: 11, color: '#999' }}>
                      媒体: {item.mediaPaths.length} 个
                    </div>
                  )}
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
    case 'disconnected':
      return 'default'
    case 'disabled':
      return 'default'
    default:
      return 'default'
  }
}
