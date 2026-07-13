import { Button, Spin } from 'antd'
import { CloseOutlined } from '@ant-design/icons'

export type StripAttachment = {
  localId: string
  mime: string
  filename: string
  thumbnailUrl: string
  status: 'reading' | 'ready' | 'error'
  error?: string
}

export function AttachmentStrip({
  attachments,
  onRemove,
  align = 'start',
  size = 80,
  compact = false,
}: {
  attachments: StripAttachment[]
  onRemove?: (localId: string) => void
  align?: 'start' | 'end'
  /** 缩略图边长 (px). 状态栏内嵌版用 40~48, 默认 80 适配原有大方块场景. */
  size?: number
  /** 紧凑模式: 去掉上下 padding, 用于内嵌到状态栏这类本身已有 padding 的容器里.
      MessageBubble 等独立场景保持默认 false, 仍带 8px 上下间距. */
  compact?: boolean
}) {
  if (attachments.length === 0) return null
  // 移除按钮尺寸随 size 缩放: 24 (size=80) → 16 (size=40); 大缩略图才显,
  // 小缩略图里 20x20 的 X 会把图片盖掉一大块, 缩到 14~16 更合理.
  const removeBtnSize = Math.max(14, Math.round(size * 0.25))
  return (
    <div
      style={{
        display: 'flex',
        justifyContent: align === 'end' ? 'flex-end' : 'flex-start',
        gap: 8,
        flexWrap: 'wrap',
        padding: compact ? 0 : '8px 0',
      }}
    >
      {attachments.map((a) => (
        <div
          key={a.localId}
          style={{
            position: 'relative',
            width: size,
            height: size,
            borderRadius: 6,
            overflow: 'hidden',
            background: 'rgba(0,0,0,0.04)',
            border: a.status === 'error' ? '1px solid #ff4d4f' : '1px solid transparent',
          }}
          title={a.filename}
        >
          {a.status === 'ready' ? (
            <img
              src={a.thumbnailUrl}
              alt={a.filename}
              style={{
                width: '100%',
                height: '100%',
                objectFit: 'cover',
                display: 'block',
              }}
            />
          ) : a.status === 'error' ? (
            <div
              style={{
                fontSize: 10,
                color: '#ff4d4f',
                padding: 4,
                overflow: 'hidden',
                textOverflow: 'ellipsis',
                wordBreak: 'break-all',
              }}
            >
              {a.error ?? '加载失败'}
            </div>
          ) : (
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', height: '100%' }}>
              <Spin size="small" />
            </div>
          )}
          {onRemove && (
            <Button
              size="small"
              type="text"
              icon={<CloseOutlined />}
              onClick={() => onRemove(a.localId)}
              title="移除"
              style={{
                position: 'absolute',
                top: 2,
                right: 2,
                width: removeBtnSize,
                height: removeBtnSize,
                minWidth: removeBtnSize,
                padding: 0,
                background: 'rgba(0,0,0,0.55)',
                color: '#fff',
                display: 'inline-flex',
                alignItems: 'center',
                justifyContent: 'center',
              }}
            />
          )}
        </div>
      ))}
    </div>
  )
}
