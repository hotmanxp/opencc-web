import { Button, Descriptions, message, Typography } from 'antd'
import { CopyOutlined } from '@ant-design/icons'
import type { ConversationInfo } from '../hooks/useConversationInfo.js'

const { Text } = Typography

function fmtTime(ts: number | null): string {
  if (!ts) return '—'
  return new Date(ts).toLocaleString()
}

function statusLabel(status: ConversationInfo['status']): string {
  switch (status) {
    case 'idle': return '就绪'
    case 'streaming': return '对话中'
    case 'aborted': return '已中止'
    case 'error': return '错误'
  }
}

async function copyToClipboard(text: string): Promise<void> {
  // navigator.clipboard requires a secure context (https / localhost).
  // Fall back to a temporary textarea for http / older browsers.
  if (navigator.clipboard?.writeText) {
    try {
      await navigator.clipboard.writeText(text)
      return
    } catch {
      // fall through to legacy path
    }
  }
  const ta = document.createElement('textarea')
  ta.value = text
  ta.style.position = 'fixed'
  ta.style.opacity = '0'
  document.body.appendChild(ta)
  ta.select()
  document.execCommand('copy')
  document.body.removeChild(ta)
}

interface Props {
  info: ConversationInfo
}

export default function ConversationInfoCard({ info }: Props) {
  if (!info.sessionId) {
    return (
      <div style={{ padding: 8, color: 'rgba(0,0,0,0.45)', fontSize: 13 }}>
        暂无活跃会话
      </div>
    )
  }

  const handleCopy = async (e: React.MouseEvent) => {
    // 不让 click 冒泡到 Popover 触发关闭, 也不让 button 触发 form submit 之类.
    e.stopPropagation()
    e.preventDefault()
    try {
      await copyToClipboard(info.sessionId!)
      message.success('已复制 sessionId')
    } catch {
      message.warning('复制失败, 请手动选中')
    }
  }

  return (
    <Descriptions
      size="small"
      column={1}
      bordered
      style={{ width: 360 }}
      labelStyle={{ width: 110, color: 'rgba(0,0,0,0.65)' }}
    >
      <Descriptions.Item label="Session ID">
        <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
          <Text code style={{ fontSize: 12, wordBreak: 'break-all' }}>
            {info.sessionId}
          </Text>
          <Button
            type="text"
            size="small"
            icon={<CopyOutlined />}
            onClick={handleCopy}
            title="复制 sessionId"
          />
        </span>
      </Descriptions.Item>
      <Descriptions.Item label="标题">{info.title ?? '—'}</Descriptions.Item>
      <Descriptions.Item label="首条消息时间">{fmtTime(info.startTime)}</Descriptions.Item>
      <Descriptions.Item label="最后更新">{fmtTime(info.lastUpdate)}</Descriptions.Item>
      <Descriptions.Item label="对话轮次">{info.turnCount}</Descriptions.Item>
      <Descriptions.Item label="消息数">{info.messageCount}</Descriptions.Item>
      <Descriptions.Item label="状态">{statusLabel(info.status)}</Descriptions.Item>
      <Descriptions.Item label="工作目录">{info.cwd ?? '—'}</Descriptions.Item>
      <Descriptions.Item label="当前模型">{info.model ?? '未知'}</Descriptions.Item>
    </Descriptions>
  )
}