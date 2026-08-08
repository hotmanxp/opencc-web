import { useEffect, useState } from 'react'
import {
  Alert,
  Button,
  Card,
  Checkbox,
  Col,
  Descriptions,
  Empty,
  Form,
  Input,
  InputNumber,
  Modal,
  Popconfirm,
  Row,
  Space,
  Spin,
  Switch,
  Tag,
  Tooltip,
  Typography,
  message,
} from 'antd'
import {
  PlayCircleOutlined,
  StopOutlined,
  ReloadOutlined,
  DeleteOutlined,
  PlusOutlined,
  ExportOutlined,
  FolderOpenOutlined,
  HomeOutlined,
  ArrowUpOutlined,
  FolderOutlined,
} from '@ant-design/icons'
import { useInstanceStore } from '../store/useInstanceStore.js'
import type { InstanceSnapshot, InstanceState } from '../../../shared/instances.js'
import type { FsPickerEntry, FsPickerList } from '../../../shared/fsPicker.js'

const STATE_TAG_COLOR: Record<InstanceState, string> = {
  stopped: 'default',
  starting: 'blue',
  running: 'green',
  stopping: 'orange',
  down: 'red',
}

function stateLabel(state: InstanceState): string {
  return ({ stopped: '已停止', starting: '启动中', running: '运行中', stopping: '停止中', down: '异常' } as const)[state]
}

function relativeAgo(iso: string | null): string {
  if (!iso) return '-'
  const ms = Date.now() - new Date(iso).getTime()
  if (ms < 0) return '刚刚'
  const sec = Math.floor(ms / 1000)
  if (sec < 60) return `${sec} 秒前`
  const min = Math.floor(sec / 60)
  if (min < 60) return `${min} 分钟前`
  const hr = Math.floor(min / 60)
  return `${hr} 小时前`
}

// 启动时间 / 运行时长 渲染:{inst.startedAt ? formatDuration(...) : '-'}。
// 运行时长需要定期 re-render 才不会卡在同一数字,见页面顶部的
// now-tick useState。
function formatDuration(ms: number): string {
  if (ms < 0) return '-'
  const totalSec = Math.floor(ms / 1000)
  const days = Math.floor(totalSec / 86400)
  const hours = Math.floor((totalSec % 86400) / 3600)
  const min = Math.floor((totalSec % 3600) / 60)
  const sec = totalSec % 60
  if (days > 0) return `${days}天${hours}小时`
  if (hours > 0) return `${hours}小时${min}分`
  if (min > 0) return `${min}分${sec}秒`
  return `${sec}秒`
}

// 死透了的实例在 UI 层视作 stopped:
// 服务端 20s 心跳超时只把它打 'down',但 3 分钟还没复活就等同于
// "没人管了",UI 上把 Tag 颜色切到 stopped 的 default,启动按钮可点。
// 服务端 state 不变(保留历史),只改 UI 渲染。
export const STALE_THRESHOLD_MS = 3 * 60 * 1000
export function effectiveState(s: InstanceSnapshot): InstanceState {
  if (s.state === 'down' && s.lastHeartbeatAt) {
    const last = new Date(s.lastHeartbeatAt).getTime()
    if (Date.now() - last > STALE_THRESHOLD_MS) return 'stopped'
  }
  return s.state
}

type DirectoryPickerProps = {
  open: boolean
  initialPath: string
  onCancel: () => void
  onSelect: (path: string) => void
}

// 目录选择器 Modal:跨平台路径处理交由服务端 (routes/fsPicker.ts) 完成,
// 客户端只负责"展示 path + 触发 list"。回填 onSelect 时直接用服务端
// 规范化后的 path — Windows 上是 `C:\Users\foo` 风格,POSIX 上是
// `/Users/foo` 风格,客户端不做转换 (转换在跨 OS 上不稳定)。
//
// 起点策略:initialPath 优先 (从父表单拿到的 currentCwd),空时让服务端
// 返回 homedir()。这样用户第一次开 modal 时总是落在有意义的目录。
function DirectoryPicker({ open, initialPath, onCancel, onSelect }: DirectoryPickerProps): JSX.Element {
  const [currentPath, setCurrentPath] = useState('')
  const [parent, setParent] = useState<string | null>(null)
  const [home, setHome] = useState('')
  const [entries, setEntries] = useState<FsPickerEntry[]>([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    if (!open) return
    const target = initialPath.trim()
    void loadPath(target)
  }, [open])

  async function loadPath(p: string): Promise<void> {
    setLoading(true)
    setError(null)
    try {
      const url = `/api/fs/picker?path=${encodeURIComponent(p)}`
      const res = await fetch(url)
      const data = (await res.json().catch(() => ({}))) as FsPickerList
      if (!res.ok || !data.ok) {
        setError(data.error ?? `请求失败 (HTTP ${res.status})`)
        // 保留 currentPath / entries 不动,只显示错误 — 用户可点上级 / 主页恢复
        return
      }
      setCurrentPath(data.path ?? '')
      setParent(data.parent ?? null)
      setHome(data.home ?? '')
      setEntries(data.entries ?? [])
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setLoading(false)
    }
  }

  return (
    <Modal
      title="选择工作目录"
      open={open}
      onCancel={onCancel}
      width={640}
      destroyOnClose
      footer={[
        <Button key="cancel" onClick={onCancel} data-testid="picker-cancel">
          取消
        </Button>,
        <Button
          key="select"
          type="primary"
          disabled={!currentPath || loading}
          onClick={() => onSelect(currentPath)}
          data-testid="picker-select"
        >
          选择当前目录
        </Button>,
      ]}
    >
      <Space style={{ marginBottom: 8 }} wrap>
        <Button
          icon={<HomeOutlined />}
          disabled={!home || loading}
          onClick={() => void loadPath(home)}
        >
          主页
        </Button>
        <Button
          icon={<ArrowUpOutlined />}
          disabled={!parent || loading}
          onClick={() => parent && void loadPath(parent)}
        >
          上级
        </Button>
        <Button
          icon={<ReloadOutlined />}
          disabled={!currentPath || loading}
          onClick={() => void loadPath(currentPath)}
        >
          刷新
        </Button>
      </Space>
      <Input
        value={currentPath}
        readOnly
        // 在窄屏上 (<640px) 让 input 占满一行;Windows 长路径 (C:\Users\...) 也不溢出
        style={{ fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace' }}
      />
      <div
        style={{
          marginTop: 8,
          minHeight: 240,
          maxHeight: 360,
          overflowY: 'auto',
          border: '1px solid var(--border-light)',
          borderRadius: 4,
          background: 'var(--bg-popup)',
          padding: '4px 0',
        }}
      >
        {loading ? (
          <div style={{ textAlign: 'center', padding: 32 }}>
            <Spin />
          </div>
        ) : entries.length === 0 ? (
          <div
            style={{
              padding: 24,
              textAlign: 'center',
              color: 'var(--text-dim-45)',
              fontSize: 12,
            }}
          >
            空目录
          </div>
        ) : (
          entries.map((entry) => (
            <div
              key={entry.path}
              role="button"
              tabIndex={0}
              data-testid={`picker-entry-${entry.name}`}
              onClick={() => void loadPath(entry.path)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' || e.key === ' ') {
                  e.preventDefault()
                  void loadPath(entry.path)
                }
              }}
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: 8,
                padding: '6px 12px',
                cursor: 'pointer',
                color: 'var(--text-dim-85)',
                fontSize: 13,
                fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
              }}
              // hover 背景用 CSS 变量 --bg-faint-06,亮/暗主题各自的值在
              // index.css 的 :root / :root[data-theme='light'] 已定义
              // (暗: rgba(255,255,255,0.06);亮: rgba(0,0,0,0.06))。
              // 直接写 rgba(255,255,255,0.06) 在亮主题下基本不可见。
              onMouseEnter={(e) => {
                ;(e.currentTarget as HTMLDivElement).style.background = 'var(--bg-faint-06)'
              }}
              onMouseLeave={(e) => {
                ;(e.currentTarget as HTMLDivElement).style.background = 'transparent'
              }}
            >
              <span style={{ width: 16, textAlign: 'center' }}>
                <FolderOutlined />
              </span>
              <span style={{ flex: 1 }}>{entry.name}</span>
              <span style={{ fontSize: 11, color: 'var(--text-dim-45)' }}>打开</span>
            </div>
          ))
        )}
      </div>
      {error && (
        <Alert
          type="error"
          showIcon
          message={error}
          style={{ marginTop: 8 }}
          data-testid="picker-error"
        />
      )}
    </Modal>
  )
}

export default function Instances(): JSX.Element {
  const { instances, loading, loadInstances, applyInstanceSnapshot } = useInstanceStore()
  const [open, setOpen] = useState(false)
  const [pickerOpen, setPickerOpen] = useState(false)
  const [lanBusyId, setLanBusyId] = useState<string | null>(null)
  // Instance whose pinned port is currently being edited in the per-row
  // modal. `null` means the modal is closed. We open the modal with the
  // snapshot we already have so the form can pre-fill from `def.port`
  // before the PATCH response comes back.
  const [portEditRow, setPortEditRow] = useState<InstanceSnapshot | null>(null)
  const [form] = Form.useForm<{
    name: string
    cwd: string
    lan?: boolean
    /**
     * When `true`, the user wants to pin a port on the new instance;
     * `portNumber` carries the actual number. Mirrors the supervisor's
     * `InstanceDefinition.port` field: `null` / `undefined` → auto,
     * `number` → supervisor must start on exactly this port.
     */
    portEnabled?: boolean
    portNumber?: number
  }>()
  // Separate form for the per-row "edit port" modal — kept independent
  // from the create form so its lifecycle never collides with the
  // create flow (e.g. resetting create form fields shouldn't clobber
  // the edit modal).
  const [portForm] = Form.useForm<{ portEnabled?: boolean; portNumber?: number }>()
  // Defensive: zustand guarantees an array, but a stray `undefined`
  // entry would still blow up `find` downstream. Filter so render
  // stays robust against partial hydration glitches.
  const safeInstances = instances.filter((s): s is InstanceSnapshot => s != null)
  const currentCwd = safeInstances.find((s) => s.isCurrent)?.cwd ?? ''
  // `useWatch` keeps the port-required rule in sync with the Switch —
  // switching back to "auto" clears the required flag so validation
  // passes without forcing the user to clear the InputNumber first.
  const portEnabled = Form.useWatch('portEnabled', form)
  const editPortEnabled = Form.useWatch('portEnabled', portForm)

  useEffect(() => {
    void loadInstances()
  }, [loadInstances])

  // 运行时长需要定期 re-render 才不会卡在同一数字。每 60s tick 一次,
  // 60s 粒度对"X 分 Y 秒"足够细;粒度更细会让 setInterval 频繁触发
  // re-render 但视觉上肉眼无差异。一个 1 小时的实例跑 60s 后才多 1 分钟,
  // tick 频率足够。
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 60_000)
    return () => clearInterval(id)
  }, [])
  // 让 lint 别报"unused":now 的用途在下面的 Descriptions 里取 Date.now()
  // 替换为 now,触发依赖 `now` 的 re-render。
  void now

  // Seed the per-row edit form whenever a row is opened (or re-opened
  // with a fresh snapshot). `destroyOnClose` on the modal handles the
  // teardown — we just have to land the right initial values before
  // the user can interact. Reading the latest snapshot from the store
  // — not `portEditRow` — so a concurrent PATCH that already landed
  // wins over our captured copy. `startPort` is the user-pinned port
  // (vs. `port` which carries the runtime port the child bound to).
  useEffect(() => {
    if (!portEditRow) return
    const live = instances.find((s) => s.id === portEditRow.id) ?? portEditRow
    const pinned = typeof live.startPort === 'number'
    portForm.setFieldsValue({
      portEnabled: pinned,
      portNumber: pinned ? live.startPort : undefined,
    })
  }, [portEditRow?.id, instances, portForm])

  async function act(method: 'POST' | 'DELETE', id: string, action?: 'start' | 'stop' | 'restart'): Promise<void> {
    const url = action ? `/api/instances/${id}/${action}` : `/api/instances/${id}`
    const res = await fetch(url, { method })
    if (!res.ok && res.status !== 204) {
      const data = (await res.json().catch(() => ({}))) as { error?: string }
      message.error(data.error ?? '操作失败')
    }
    void loadInstances()
  }

  // Toggle the persisted `lan` flag on a definition. Optimistic update
  // — flip the snapshot locally first so the Switch animates without
  // waiting for the round trip, then PATCH the server and roll back on
  // failure. The optimistic mutation uses `applyInstanceSnapshot` so
  // the zustand store stays the single source of truth.
  async function setLan(id: string, lan: boolean): Promise<void> {
    const before = instances.find((s) => s.id === id)
    if (!before) return
    const optimistic: InstanceSnapshot = { ...before, lan }
    applyInstanceSnapshot(optimistic)
    setLanBusyId(id)
    try {
      const res = await fetch(`/api/instances/${id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ lan }),
      })
      if (!res.ok) {
        const data = (await res.json().catch(() => ({}))) as { error?: string }
        applyInstanceSnapshot(before)
        message.error(data.error ?? '切换 LAN 失败')
      } else {
        const data = (await res.json()) as { instance: InstanceSnapshot }
        applyInstanceSnapshot(data.instance)
      }
    } catch (err) {
      applyInstanceSnapshot(before)
      message.error(err instanceof Error ? err.message : '切换 LAN 失败')
    } finally {
      setLanBusyId(null)
    }
  }

  // Patch the persisted `port` field on a definition. Same optimistic
  // pattern as `setLan`: write the intended value to the local store
  // first, PATCH the server, and roll back on failure. `null` clears
  // the pin (next start falls back to auto-scan); a number persists.
  async function setPort(id: string, port: number | null): Promise<void> {
    const before = instances.find((s) => s.id === id)
    if (!before) return
    const optimistic: InstanceSnapshot = { ...before, port }
    applyInstanceSnapshot(optimistic)
    try {
      const res = await fetch(`/api/instances/${id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ port }),
      })
      if (!res.ok) {
        const data = (await res.json().catch(() => ({}))) as { error?: string }
        applyInstanceSnapshot(before)
        message.error(data.error ?? '修改启动端口失败')
        return false
      }
      const data = (await res.json()) as { instance: InstanceSnapshot }
      applyInstanceSnapshot(data.instance)
      return true
    } catch (err) {
      applyInstanceSnapshot(before)
      message.error(err instanceof Error ? err.message : '修改启动端口失败')
      return false
    }
  }

  async function onCreate(): Promise<void> {
    try {
      const values = await form.validateFields()
      // Translate the Switch + InputNumber pair into the supervisor's
      // single `port` field: `null` when auto, the typed number when
      // manual. The server route rejects literal `null` for POST
      // (nothing to clear on a new definition) so we send `undefined`
      // here and let JSON.stringify drop the key entirely.
      const port = values.portEnabled === true && typeof values.portNumber === 'number'
        ? values.portNumber
        : undefined
      const res = await fetch('/api/instances', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: values.name, cwd: values.cwd, lan: values.lan === true, port }),
      })
      if (!res.ok) {
        const data = (await res.json().catch(() => ({}))) as { error?: string }
        throw new Error(data.error ?? '创建失败')
      }
      setOpen(false)
      form.resetFields()
      void loadInstances()
    } catch (err) {
      message.error(err instanceof Error ? err.message : '创建失败')
    }
  }

  function renderActions(row: InstanceSnapshot): JSX.Element {
    // 按钮可用性按 effectiveState 走:down + 超过 3 分钟视为 stopped,
    // "启动"按钮可点,让用户能重新拉起。"停止"/"重启"对死了 3 分钟的实例
    // 都没意义(进程已经没了),disable。
    const es = effectiveState(row)
    const canStart = !row.isCurrent && (es === 'stopped' || es === 'down')
    const canStop = !row.isCurrent && (es === 'running' || es === 'starting')
    const canRestart = !row.isCurrent && es === 'running'
    const canDelete = !row.isCurrent
    return (
      <Space wrap>
        <Button
          size="small"
          icon={<PlayCircleOutlined />}
          disabled={!canStart}
          onClick={() => void act('POST', row.id, 'start')}
        >
          启动
        </Button>
        <Button
          size="small"
          icon={<StopOutlined />}
          disabled={!canStop}
          onClick={() => void act('POST', row.id, 'stop')}
        >
          停止
        </Button>
        <Button
          size="small"
          icon={<ReloadOutlined />}
          disabled={!canRestart}
          onClick={() => void act('POST', row.id, 'restart')}
        >
          重启
        </Button>
        <Popconfirm
          title="确定删除该实例定义？"
          description="如果实例正在运行，会先停止。"
          onConfirm={() => void act('DELETE', row.id)}
        >
          <Button size="small" danger icon={<DeleteOutlined />} disabled={!canDelete}>
            删除
          </Button>
        </Popconfirm>
        {row.port != null && !row.isCurrent && (
          <Button
            size="small"
            icon={<ExportOutlined />}
            href={`http://localhost:${row.port}`}
            target="_blank"
            rel="noreferrer"
          >
            打开
          </Button>
        )}
      </Space>
    )
  }

  function renderLanToggle(row: InstanceSnapshot): JSX.Element | null {
    if (row.isCurrent) return null
    const lan = row.lan === true
    const busy = lanBusyId === row.id
    return (
      <Tooltip
        title={lan ? 'LAN 模式:该实例会以 --lan 启动并监听 0.0.0.0' : '仅本机访问 (127.0.0.1)。开启后下次启动会以 --lan 启动'}
      >
        <Space size={8}>
          <span style={{ color: 'var(--text-dim-65)', fontSize: 12 }}>LAN</span>
          <Switch
            size="small"
            checked={lan}
            disabled={busy}
            loading={busy}
            aria-label="LAN 启动"
            data-testid={`lan-switch-${row.id}`}
            onChange={(next) => void setLan(row.id, next)}
          />
          {lan ? <Tag color="cyan" style={{ marginInlineEnd: 0 }}>--lan</Tag> : null}
        </Space>
      </Tooltip>
    )
  }

  return (
    <Card
      title={<Typography.Title level={4} style={{ margin: 0 }}>实例管理</Typography.Title>}
      extra={
        <Button type="primary" icon={<PlusOutlined />} onClick={() => setOpen(true)}>
          新建实例
        </Button>
      }
      style={{ margin: 24 }}
    >
      <Row gutter={[16, 16]}>
        {loading && safeInstances.length === 0 ? (
          <Col xs={24} md={12} lg={8}><Card loading /></Col>
        ) : safeInstances.length === 0 ? (
          <Col span={24}><Empty description="暂无实例" /></Col>
        ) : safeInstances.map((inst) => (
          <Col key={inst.id} xs={24} md={12} lg={8}>
            <Card
              title={
                <Space>
                  {inst.name}
                  {inst.isCurrent && <Tag color="blue">当前</Tag>}
                </Space>
              }
              extra={
                <Space size={8} align="center">
                  {renderLanToggle(inst)}
                  <Tag color={STATE_TAG_COLOR[effectiveState(inst)]}>{stateLabel(effectiveState(inst))}</Tag>
                </Space>
              }
            >
              <Descriptions size="small" column={1}>
                <Descriptions.Item label="启动端口">
                  <Space size={4} align="center">
                    {inst.startPort == null ? (
                      <Tag color="default" style={{ marginInlineEnd: 0 }}>auto</Tag>
                    ) : (
                      <span data-testid={`startup-port-${inst.id}`}>{inst.startPort}</span>
                    )}
                    {!inst.isCurrent && (
                      <Button
                        size="small"
                        type="link"
                        style={{ padding: 0 }}
                        data-testid={`edit-port-${inst.id}`}
                        onClick={() => setPortEditRow(inst)}
                      >
                        编辑
                      </Button>
                    )}
                  </Space>
                </Descriptions.Item>
                <Descriptions.Item label="运行端口">{inst.port ?? '-'}</Descriptions.Item>
                <Descriptions.Item label="cwd">{inst.cwd}</Descriptions.Item>
                <Descriptions.Item label="pid">{inst.pid ?? '-'}</Descriptions.Item>
                <Descriptions.Item label="启动时间">
                  {inst.startedAt ? new Date(inst.startedAt).toLocaleString() : '-'}
                </Descriptions.Item>
                <Descriptions.Item label="运行时长">
                  {inst.startedAt ? formatDuration(now - new Date(inst.startedAt).getTime()) : '-'}
                </Descriptions.Item>
                <Descriptions.Item label="创建时间">
                  {inst.createdAt ? new Date(inst.createdAt).toLocaleString() : '-'}
                </Descriptions.Item>
                <Descriptions.Item label="最后心跳">{relativeAgo(inst.lastHeartbeatAt)}</Descriptions.Item>
                {inst.lastError ? (
                  <Descriptions.Item label="错误">
                    <Tag color="red">{inst.lastError.message}</Tag>
                  </Descriptions.Item>
                ) : null}
              </Descriptions>
              <div style={{ marginTop: 12 }}>{renderActions(inst)}</div>
            </Card>
          </Col>
        ))}
      </Row>
      <Modal
        title="新建实例"
        open={open}
        onCancel={() => setOpen(false)}
        onOk={() => void onCreate()}
        okText="创建"
        cancelText="取消"
      >
        <Form form={form} layout="vertical" initialValues={{ cwd: currentCwd, lan: false, portEnabled: false }}>
          <Form.Item name="name" label="名称" rules={[{ required: true, message: '请输入名称' }]}>
            <Input placeholder="例如 demo" />
          </Form.Item>
          {/*
            cwd Form.Item 拆成 outer + 内嵌 noStyle 的写法,目的是在 Input 右侧
            塞一个"浏览"按钮。外层保留 label / required 视觉提示,内层负责
            name 绑定 + required rule + 输入框。无 noStyle 时内层会再套一层
            Form.Item 默认 margin,导致与 Button 不在同一基线。
          */}
          <Form.Item
            label="工作目录"
            required
          >
            <div style={{ display: 'flex', gap: 8 }}>
              <Form.Item
                name="cwd"
                noStyle
                rules={[{ required: true, message: '请输入工作目录' }]}
              >
                <Input
                  placeholder="/absolute/path"
                  data-testid="cwd-input"
                  // Windows 上 placeholder 也用 / 风格 — 服务端 path.resolve 把
                  // / 与 \ 都视为分隔符,客户端无需预先规范。
                  style={{ flex: 1 }}
                />
              </Form.Item>
              <Button
                icon={<FolderOpenOutlined />}
                onClick={() => setPickerOpen(true)}
                data-testid="cwd-browse"
              >
                浏览
              </Button>
            </div>
          </Form.Item>
          <Form.Item
            name="lan"
            valuePropName="checked"
            // Tooltip wraps the field so the Switch inherits the same
            // keyboard-focusable surface as the rest of the form.
            tooltip="勾选后,该实例会以 --lan 启动,监听 0.0.0.0,局域网其他设备可访问"
            data-testid="lan-checkbox"
          >
            <Checkbox>LAN 模式启动 (--lan)</Checkbox>
          </Form.Item>
          {/*
            端口配置:Switch 切 auto / 手动;手动时 InputNumber 必填。
            Switch + InputNumber 放在同一个 Form.Item (noStyle inner) 里
            是为了共用同一行 label / tooltip,跟 cwd 字段的浏览按钮
            用的是同一种 outer + noStyle 内嵌的模式。`useWatch` 让
            "必填" 规则随 Switch 切换 — 切回 auto 时不再强制用户清空
            InputNumber 才能提交。
          */}
          <Form.Item
            label="启动端口"
            tooltip="默认自动分配（从 9201 起）。开启后可手动指定端口；端口被占用时启动失败。"
            data-testid="port-form-item"
          >
            <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
              <Form.Item name="portEnabled" valuePropName="checked" noStyle>
                <Switch
                  checkedChildren="手动"
                  unCheckedChildren="自动"
                  data-testid="port-mode-switch"
                />
              </Form.Item>
              <Form.Item
                name="portNumber"
                noStyle
                rules={portEnabled === true ? [{ required: true, message: '请输入端口' }, { type: 'integer', min: 1024, max: 65535, message: '端口需为 1024-65535 之间的整数' }] : []}
              >
                <InputNumber
                  min={1024}
                  max={65535}
                  placeholder="端口号"
                  disabled={portEnabled !== true}
                  data-testid="port-number"
                  style={{ width: 180 }}
                />
              </Form.Item>
              {portEnabled !== true ? <Tag color="default" style={{ marginInlineEnd: 0 }}>auto</Tag> : null}
            </div>
          </Form.Item>
        </Form>
      </Modal>
      {/*
        Per-row "edit port" modal. Re-uses the same Switch + InputNumber
        layout as the create form but operates against `portForm` (an
        independent antd Form instance) so its lifecycle doesn't clash
        with the create flow. We seed `portForm` from `portEditRow.port`
        on every (re)open so a freshly-loaded snapshot wins over a stale
        optimistic value the user might have rolled back.
      */}
      <Modal
        title={portEditRow ? `编辑「${portEditRow.name}」启动端口` : '编辑启动端口'}
        open={portEditRow != null}
        onCancel={() => setPortEditRow(null)}
        onOk={async () => {
          if (!portEditRow) return
          // Mirror the create flow: Switch on + a number → pin it;
          // anything else → clear the pin (null → PATCH clears back
          // to auto on the supervisor).
          const enabled = portForm.getFieldValue('portEnabled') === true
          const number = portForm.getFieldValue('portNumber')
          const next = enabled && typeof number === 'number' ? number : null
          try {
            await portForm.validateFields()
          } catch {
            return
          }
          const ok = await setPort(portEditRow.id, next)
          if (ok) setPortEditRow(null)
        }}
        okText="保存"
        cancelText="取消"
        destroyOnClose
      >
        <Form
          form={portForm}
          layout="vertical"
          initialValues={{ portEnabled: false }}
          data-testid="port-edit-form"
        >
          <Form.Item
            label="启动端口"
            tooltip="默认自动分配（从 9201 起）。开启后可手动指定端口；端口被占用时启动失败。"
          >
            <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
              <Form.Item name="portEnabled" valuePropName="checked" noStyle>
                <Switch
                  checkedChildren="手动"
                  unCheckedChildren="自动"
                  data-testid="port-edit-mode-switch"
                />
              </Form.Item>
              <Form.Item
                name="portNumber"
                noStyle
                rules={editPortEnabled === true ? [{ required: true, message: '请输入端口' }, { type: 'integer', min: 1024, max: 65535, message: '端口需为 1024-65535 之间的整数' }] : []}
              >
                <InputNumber
                  min={1024}
                  max={65535}
                  placeholder="端口号"
                  disabled={editPortEnabled !== true}
                  data-testid="port-edit-number"
                  style={{ width: 180 }}
                />
              </Form.Item>
              {editPortEnabled !== true ? <Tag color="default" style={{ marginInlineEnd: 0 }}>auto</Tag> : null}
            </div>
          </Form.Item>
        </Form>
      </Modal>
      <DirectoryPicker
        open={pickerOpen}
        initialPath={form.getFieldValue('cwd') || currentCwd}
        onCancel={() => setPickerOpen(false)}
        onSelect={(picked) => {
          form.setFieldsValue({ cwd: picked })
          setPickerOpen(false)
        }}
      />
    </Card>
  )
}
