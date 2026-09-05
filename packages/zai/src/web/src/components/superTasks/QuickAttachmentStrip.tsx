import { Button } from 'antd'
import { CloseOutlined } from '@ant-design/icons'

export type QuickAttachment = {
  localId: string
  mime: string
  size: number
  filename: string
  thumbnailUrl: string
  dataUrl: string
  status: 'reading' | 'ready' | 'error'
  error?: string
}

/**
 * QuickCreateModal 的只读图片附件缩略图条(items / onRemove / disabled)。
 *
 * 不复用 AgentInputBox 的 AttachmentStrip:后者耦合 AgentInputBox 的
 * PendingAttachment 形状 + zustand store + 缩略图大小策略。QuickCreateModal
 * 用 50-70 行只读版本,父级用 `attachments.length > 0 && <QuickAttachmentStrip ...>`
 * 守卫空状态 —— 组件本身在 items=[] 时返回 null。
 */
export default function QuickAttachmentStrip({
  items,
  onRemove,
  disabled = false,
}: {
  items: QuickAttachment[]
  onRemove: (localId: string) => void
  disabled?: boolean
}): JSX.Element | null {
  if (items.length === 0) return null

  return (
    <div
      data-testid="quick-attachment-strip"
      style={{
        display: 'flex',
        flexWrap: 'wrap',
        gap: 6,
        padding: '4px 0',
      }}
    >
      {items.map((item) => (
        <span
          key={item.localId}
          data-testid={`quick-attachment-chip-${item.localId}`}
          style={{
            display: 'inline-flex',
            alignItems: 'center',
            gap: 4,
            padding: '2px 6px',
            background: item.status === 'error' ? 'var(--danger-bg, #fff1f0)' : 'rgba(255,102,0,0.15)',
            border: item.status === 'error' ? '1px solid var(--danger, #ff4d4f)' : '1px solid transparent',
            borderRadius: 6,
            fontSize: 12,
            maxWidth: '100%',
          }}
        >
          <img
            src={item.thumbnailUrl}
            alt={item.filename}
            style={{ width: 24, height: 24, objectFit: 'cover', borderRadius: 2, flexShrink: 0 }}
          />
          <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', maxWidth: 130, flexShrink: 1 }}>
            {item.status === 'error' ? item.error || '上传失败' : item.filename}
          </span>
          <Button
            size="small"
            type="text"
            disabled={disabled}
            aria-label="移除附件"
            icon={<CloseOutlined />}
            onClick={() => onRemove(item.localId)}
            data-testid={`quick-attachment-chip-${item.localId}-remove`}
            style={{ width: 18, height: 18, minWidth: 18, padding: 0, fontSize: 10, flexShrink: 0 }}
          />
        </span>
      ))}
    </div>
  )
}