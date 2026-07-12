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
}: {
  attachments: StripAttachment[]
  onRemove?: (localId: string) => void
}) {
  if (attachments.length === 0) return null
  return (
    <div
      style={{
        display: 'flex',
        gap: 8,
        flexWrap: 'wrap',
        padding: '8px 0',
      }}
    >
      {attachments.map((a) => (
        <div
          key={a.localId}
          style={{
            position: 'relative',
            width: 80,
            height: 80,
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
                width: 20,
                height: 20,
                minWidth: 20,
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
