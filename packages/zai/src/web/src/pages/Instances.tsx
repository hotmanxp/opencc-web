import { useEffect, useState } from 'react'
import {
  Alert,
  Button,
  Card,
  Col,
  Descriptions,
  Empty,
  Form,
  Input,
  Modal,
  Popconfirm,
  Row,
  Space,
  Spin,
  Tag,
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

const INSTANCE_START_POLL_MS = 250
const INSTANCE_START_TIMEOUT_MS = 30_000

export async function waitForRunningInstance(
  id: string,
  applySnapshot: (snapshot: InstanceSnapshot) => void,
): Promise<InstanceSnapshot> {
  const deadline = Date.now() + INSTANCE_START_TIMEOUT_MS
  while (true) {
    const res = await fetch(`/api/instances/${id}`)
    if (!res.ok) throw new Error('无法读取实例状态')
    const data = (await res.json()) as { instance: InstanceSnapshot }
    applySnapshot(data.instance)
    if (data.instance.state === 'running' && data.instance.port !== null) {
      return data.instance
    }
    if (data.instance.state === 'down') {
      throw new Error(data.instance.lastError?.message ?? '实例启动失败')
    }
    if (Date.now() >= deadline) throw new Error('实例启动超时,请稍后手动打开')
    await new Promise<void>((resolve) => setTimeout(resolve, INSTANCE_START_POLL_MS))
  }
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
  const [form] = Form.useForm<{ name: string; cwd: string }>()
  const currentCwd = instances.find((s) => s.isCurrent)?.cwd ?? ''

  useEffect(() => {
    void loadInstances()
  }, [loadInstances])

  async function act(method: 'POST' | 'DELETE', id: string, action?: 'start' | 'stop' | 'restart'): Promise<void> {
    const url = action ? `/api/instances/${id}/${action}` : `/api/instances/${id}`
    const res = await fetch(url, { method })
    if (!res.ok && res.status !== 204) {
      const data = (await res.json().catch(() => ({}))) as { error?: string }
      message.error(data.error ?? '操作失败')
    }
    void loadInstances()
  }

  async function onCreate(): Promise<void> {
    const popup = window.open('about:blank', '_blank', 'noopener,noreferrer')
    try {
      const values = await form.validateFields()
      const res = await fetch('/api/instances', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(values),
      })
      if (!res.ok) {
        const data = (await res.json().catch(() => ({}))) as { error?: string }
        throw new Error(data.error ?? '创建失败')
      }
      const data = (await res.json()) as { instance: InstanceSnapshot }
      setOpen(false)
      form.resetFields()
      void loadInstances()
      const started = await waitForRunningInstance(data.instance.id, applyInstanceSnapshot)
      const url = `http://localhost:${started.port}`
      if (popup && !popup.closed) popup.location.href = url
    } catch (err) {
      if (popup && !popup.closed) popup.close()
      message.error(err instanceof Error ? err.message : '创建失败')
    }
  }

  function renderActions(row: InstanceSnapshot): JSX.Element {
    const canStart = !row.isCurrent && (row.state === 'stopped' || row.state === 'down')
    const canStop = !row.isCurrent && (row.state === 'running' || row.state === 'starting')
    const canRestart = !row.isCurrent && row.state === 'running'
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
        {loading && instances.length === 0 ? (
          <Col xs={24} md={12} lg={8}><Card loading /></Col>
        ) : instances.length === 0 ? (
          <Col span={24}><Empty description="暂无实例" /></Col>
        ) : instances.map((inst) => (
          <Col key={inst.id} xs={24} md={12} lg={8}>
            <Card
              title={
                <Space>
                  {inst.name}
                  {inst.isCurrent && <Tag color="blue">当前</Tag>}
                </Space>
              }
              extra={<Tag color={STATE_TAG_COLOR[inst.state]}>{stateLabel(inst.state)}</Tag>}
            >
              <Descriptions size="small" column={1}>
                <Descriptions.Item label="端口">{inst.port ?? '-'}</Descriptions.Item>
                <Descriptions.Item label="cwd">{inst.cwd}</Descriptions.Item>
                <Descriptions.Item label="pid">{inst.pid ?? '-'}</Descriptions.Item>
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
        <Form form={form} layout="vertical" initialValues={{ cwd: currentCwd }}>
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
