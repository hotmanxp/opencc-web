import { Button, Descriptions, message, Typography } from 'antd'
import { copyToClipboard } from '../lib/clipboard.js'
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

// zai patch (2026-08-09): 把 token 数字按 K 显示, 小于 1000 直接显示原文。
// 1,000,000 → "1000K"(用户明确要求 K 单位, 即便 million 级别也走 K 不切 M),
// 200 → "200"(< 1000 保留原文避免 0K 歧义)。
function fmtTokens(n: number): string {
  if (n < 1000) return n.toString()
  return `${Math.round(n / 1000)}K`
}

interface Props {
  info: ConversationInfo
}

export default function ConversationInfoCard({ info }: Props) {
  if (!info.sessionId) {
    return (
      <div style={{ padding: 8, color: 'var(--text-dim-45)', fontSize: 13 }}>
        暂无活跃会话
      </div>
    )
  }

  const handleCopy = async (e: React.MouseEvent) => {
    // 不让 click 冒泡到 Popover 触发关闭, 也不让 button 触发 form submit 之类.
    e.stopPropagation()
    e.preventDefault()
    const ok = await copyToClipboard(info.sessionId!)
    if (ok) message.success('已复制 sessionId')
    else message.warning('复制失败, 请手动选中')
  }

  return (
    <Descriptions
      size="small"
      column={1}
      bordered
      // 跟随外层容器宽度 (桌面 Popover 自带 360px / 移动 Modal 90vw),
      // 避免固定 360 在窄屏 modal 内被 Descriptions label + 内容撑破.
      style={{ width: '100%' }}
      labelStyle={{ width: 110, color: 'var(--text-dim-65)' }}
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
      <Descriptions.Item label="API 请求次数">{info.apiRequestCount}</Descriptions.Item>
      <Descriptions.Item label="上下文">
        {/* zai patch (2026-08-09): 把"当前上下文大小"(后端 vendor message_delta
            推上来的最近一次 API usage)与"模型支持上下文大小"(从
            settings.models[].capabilities.contextWindow 派生)合并到一行,
            格式 "current / max", 两边都未知时显示 "— / —", 单边未知时
            该边用 "—" 占位。两边都按 K 显示(<1000 保留原文)。 */}
        <span style={{ fontVariantNumeric: 'tabular-nums' }}>
          {info.contextTokens === null ? '—' : fmtTokens(info.contextTokens)}
          {' / '}
          {info.contextWindow === null ? '—' : fmtTokens(info.contextWindow)}
        </span>
      </Descriptions.Item>
      <Descriptions.Item label="状态">{statusLabel(info.status)}</Descriptions.Item>
    </Descriptions>
  )
}