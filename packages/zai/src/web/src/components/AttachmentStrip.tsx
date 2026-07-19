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
  previewHeight,
  previewMaxWidth,
}: {
  attachments: StripAttachment[]
  onRemove?: (localId: string) => void
  /** 点击缩略图回调. 传入时缩略图变为可点击 (cursor: zoom-in),
   *  用于 MessageBubble 等"展示已发送图片"场景 — 让用户能放大看
   *  previewHeight 模式显示得不够大的原图细节. 状态栏不传, 保持只读 + 移除. */
  onPreview?: (attachment: StripAttachment) => void
  align?: 'start' | 'end'
  /** 缩略图边长 (px). 状态栏内嵌版用 40~48, 默认 80 适配原有大方块场景.
   *  previewHeight 模式下被忽略. */
  size?: number
  /** 紧凑模式: 去掉上下 padding, 用于内嵌到状态栏这类本身已有 padding 的容器里.
      MessageBubble 等独立场景保持默认 false, 仍带 8px 上下间距. */
  compact?: boolean
  /** "高固定宽自适应" 预览模式: 容器高度 = previewHeight (例如 80),
   *  宽度由图片原始宽高比自动撑开 + maxWidth 上限 (默认 480).
   *  跟 cover 方块不同 — 长截图 (聊天记录 / 长图) 整张可见不被裁掉,
   *  但因为按比例缩放不会过份挤占卡片空间.
   *  仍可与 onPreview 联用做"点击再放大看更多细节".
   *  不传则保持原方块 cover 行为 (状态栏等不需要看全部内容的场景). */
  previewHeight?: number
  /** "高固定宽自适应" 模式的最大宽度. 防止极宽截图 (例如 1920x1080 横屏截图)
   *  占满整个卡片. 默认 480. 0 / 不传 = 不限. */
  previewMaxWidth?: number
}) {
  if (attachments.length === 0) return null
  const isPreviewMode =
    typeof previewHeight === 'number' && previewHeight > 0
  // 移除按钮尺寸: 方块 cover 模式按 size 缩放 (24px@80, 16px@40).
  // previewHeight 模式按高度缩放, 略小 (20px@80) 避免过大显得突兀.
  const removeBtnSize = isPreviewMode
    ? Math.max(16, Math.round((previewHeight ?? 0) * 0.25))
    : Math.max(14, Math.round(size * 0.25))
  return (
    <div
      style={{
        display: 'flex',
        justifyContent: align === 'end' ? 'flex-end' : 'flex-start',
        gap: 8,
        flexWrap: 'wrap',
        // previewHeight 模式宽度由图撑开, maxWidth 上限防止外溢卡片,
        // 单张时宽度 = 图片按比例缩放到指定高度的宽度;
        // 多张时 flexWrap 让长截图也能在一行 / 多行展开.
        maxWidth: isPreviewMode ? previewMaxWidth ?? 480 : undefined,
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
        // previewHeight 模式: 容器高度固定, 宽度 auto, 内部 <img height:100% width:auto>
        // 自动按原始宽高比撑开宽度. 长截图整张可见不被裁剪 (cover 方块的问题).
        // outer <div> 用 inline-flex 让容器贴合图片尺寸.
        const containerStyle: React.CSSProperties = isPreviewMode
          ? {
              position: 'relative',
              height: previewHeight,
              width: 'auto',
              maxWidth: '100%',
              display: 'inline-flex',
              alignItems: 'center',
              justifyContent: 'center',
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
              // 按比例缩放: 高度固定 100%, 宽度 auto. 浏览器根据图片 natural
              // 比例自动计算宽度, 长截图整张按比例显示. objectFit: contain 兜底
              // 防止图片本身分辨率大于容器被拉伸 (应不会发生, 浏览器会尊重 natural size).
              height: '100%',
              width: 'auto',
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
