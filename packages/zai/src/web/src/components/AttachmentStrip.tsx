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
  onPreview,
  align = 'start',
  size = 80,
  compact = false,
  previewSize,
}: {
  attachments: StripAttachment[]
  onRemove?: (localId: string) => void
  /** 点击缩略图回调. 传入时缩略图变为可点击 (cursor: zoom-in),
   *  用于 MessageBubble 等"展示已发送图片"场景 — 让用户能放大查看
   *  previewSize 模式显示得不够大的原图细节. 状态栏不传, 保持只读 + 移除. */
  onPreview?: (attachment: StripAttachment) => void
  align?: 'start' | 'end'
  /** 缩略图边长 (px). 状态栏内嵌版用 40~48, 默认 80 适配原有大方块场景.
   *  previewSize 模式下被忽略. */
  size?: number
  /** 紧凑模式: 去掉上下 padding, 用于内嵌到状态栏这类本身已有 padding 的容器里.
      MessageBubble 等独立场景保持默认 false, 仍带 8px 上下间距. */
  compact?: boolean
  /** "完整可见"模式: 容器变成 maxWidth/maxHeight = previewSize (例如 240),
   *  图片用 objectFit: contain + max-width/height:100% 按比例缩放,
   *  长截图 (聊天记录 / 长图) 整张都能看到, 不会被 cover 裁掉.
   *  仍可与 onPreview 联用做"点击再放大看更多细节".
   *  不传则保持原方块 cover 行为 (状态栏等不需要看全部内容的场景). */
  previewSize?: number
}) {
  if (attachments.length === 0) return null
  const isPreviewMode = typeof previewSize === 'number' && previewSize > 0
  // 移除按钮尺寸: 方块 cover 模式按 size 缩放 (24px@80, 16px@40).
  // previewSize 模式按容器尺寸缩放, 略大 (24px@240) 方便点击.
  const removeBtnSize = isPreviewMode
    ? Math.max(20, Math.round((previewSize ?? 0) * 0.1))
    : Math.max(14, Math.round(size * 0.25))
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
      {attachments.map((a) => {
        // onPreview 模式下缩略图可点击: cursor 提示 + 用 button 让键盘 / 无障碍
        // 也能触发 (Enter / Space). onRemove 仍是内嵌 X 按钮独立处理 stopPropagation,
        // 避免点 X 误触发放大.
        const clickable = Boolean(onPreview) && a.status === 'ready'
        const handleClick = (e: React.MouseEvent) => {
          if (!onPreview) return
          e.stopPropagation()
          onPreview(a)
        }
        // previewSize 模式: 容器是 maxWidth/maxHeight 上限 (非固定 size*size),
        // 图片按原始宽高比缩放到容器内 (objectFit: contain). 这样长截图整张可见,
        // cover 模式下被切掉的边缘内容 (对话头部/底部的人名、时间戳等) 都能看到.
        const containerStyle: React.CSSProperties = isPreviewMode
          ? {
              position: 'relative',
              maxWidth: previewSize,
              maxHeight: previewSize,
              minWidth: 80,
              minHeight: 40,
              borderRadius: 6,
              overflow: 'hidden',
              background: 'rgba(0,0,0,0.04)',
              border:
                a.status === 'error'
                  ? '1px solid #ff4d4f'
                  : '1px solid transparent',
              cursor: clickable ? 'zoom-in' : undefined,
              padding: 0,
              // button 默认 inline-block 行为会让 <img max-width:100%> 失效 —
              // flex+center 保证图片被居中且自适应到容器内.
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
            }
          : {
              position: 'relative',
              width: size,
              height: size,
              borderRadius: 6,
              overflow: 'hidden',
              background: 'rgba(0,0,0,0.04)',
              border:
                a.status === 'error'
                  ? '1px solid #ff4d4f'
                  : '1px solid transparent',
              cursor: clickable ? 'zoom-in' : undefined,
              padding: 0,
            }
        const imgStyle: React.CSSProperties = isPreviewMode
          ? {
              // contain: 图片完整显示不裁剪, 自适应到容器内.
              maxWidth: '100%',
              maxHeight: typeof previewSize === 'number' ? previewSize : '100%',
              width: 'auto',
              height: 'auto',
              display: 'block',
              objectFit: 'contain',
            }
          : {
              width: '100%',
              height: '100%',
              objectFit: 'cover',
              display: 'block',
            }
        const inner = (
          <>
            {a.status === 'ready' ? (
              <img
                src={a.thumbnailUrl}
                alt={a.filename}
                style={imgStyle}
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
                onClick={(e) => {
                  // 阻止冒泡到外层 onClick, 避免点 X 同时触发放大.
                  e.stopPropagation()
                  onRemove(a.localId)
                }}
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
          </>
        )
        if (clickable && onPreview) {
          return (
            <button
              key={a.localId}
              type="button"
              onClick={handleClick}
              title={`${a.filename} — 点击查看大图`}
              style={{
                ...containerStyle,
                // 覆盖 button 默认 user-agent 样式, 避免蓝边 / 系统字体.
                appearance: 'none',
                WebkitAppearance: 'none',
                outline: 'none',
              }}
            >
              {inner}
            </button>
          )
        }
        return (
          <div
            key={a.localId}
            style={containerStyle}
            title={a.filename}
          >
            {inner}
          </div>
        )
      })}
    </div>
  )
}
