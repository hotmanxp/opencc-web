import { useEffect, useState } from 'react'
import {
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
} from '@ant-design/icons'
import { useInstanceStore } from '../store/useInstanceStore.js'
import type { InstanceSnapshot, InstanceState } from '../../../shared/instances.js'

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

export default function Instances(): JSX.Element {
  const { instances, loading, loadInstances, applyInstanceSnapshot } = useInstanceStore()
  const [open, setOpen] = useState(false)
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
          <Form.Item name="cwd" label="工作目录" rules={[{ required: true, message: '请输入工作目录' }]}>
            <Input placeholder="/absolute/path" />
          </Form.Item>
        </Form>
      </Modal>
    </Card>
  )
}
