import { useConversationInfo } from '../hooks/useConversationInfo.js'

/**
 * Small text badge that surfaces the current session's model name in the
 * chat status bar.
 *
 * Reads `info.model` from useConversationInfo — falls back from
 * session.model to the runtime defaultModel from /api/agent/settings.
 * Renders nothing while the settings fetch is still in flight (model is
 * null) to avoid a "未知" flicker.
 *
 * Intentionally minimal: this is a presence indicator, not the full info
 * card. The ConversationInfoButton popover still exposes sessionId etc.
 */
export default function ModelStatusBadge() {
  const { model } = useConversationInfo()
  if (!model) return null

  return (
    <span
      style={{
        color: 'rgba(255,255,255,0.55)',
        // 用 monospace 跟状态栏其他文本一致; maxWidth 防长模型名撑爆布局.
        fontFamily:
          'ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace',
        maxWidth: 180,
        overflow: 'hidden',
        textOverflow: 'ellipsis',
        whiteSpace: 'nowrap',
      }}
      title={`当前模型: ${model}`}
    >
      {model}
    </span>
  )
}