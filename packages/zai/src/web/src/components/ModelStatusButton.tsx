import { Button, Popover } from 'antd'
import { CheckOutlined } from '@ant-design/icons'
import { useConversationInfo } from '../hooks/useConversationInfo.js'
import { useAgentStore } from '../store/useAgentStore.js'

/**
 * Clickable model badge — replaces the read-only ModelStatusBadge.
 *
 * Click opens a Popover listing the available models from
 * /api/agent/settings → models[]. Selecting one triggers
 * store.patchSessionModel which PATCHes transcript.meta.model.
 *
 * Empty models[] shows a "未配置 models[]" placeholder.
 */
export default function ModelStatusButton() {
  const { displayLabel, model, sessionId } = useConversationInfo()
  const models = useAgentStore((s) => s.availableModels)
  const patchSessionModel = useAgentStore((s) => s.patchSessionModel)

  const content = (
    <div style={{ width: 280 }}>
      <div style={{ fontSize: 12, color: 'rgba(255,255,255,0.45)', marginBottom: 8 }}>
        切换当前会话的模型
      </div>
      {models.length === 0 && (
        <div style={{ fontSize: 12, color: 'rgba(255,255,255,0.45)' }}>
          ~/.zai/settings.json 未配置 models[]
        </div>
      )}
      {models.map((m) => {
        const isCurrent = m.model === model
        return (
          <div
            key={m.alias}
            onClick={() => {
              if (isCurrent || !sessionId) return
              void patchSessionModel(sessionId, m.model)
            }}
            style={{
              padding: '6px 8px',
              borderRadius: 4,
              cursor: isCurrent ? 'default' : 'pointer',
              background: isCurrent ? 'rgba(22,119,255,0.15)' : 'transparent',
              display: 'flex',
              flexDirection: 'column',
              gap: 2,
            }}
          >
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
              <span style={{ fontSize: 13, color: '#fff', fontWeight: isCurrent ? 600 : 400 }}>
                {m.label ?? m.alias}
              </span>
              {isCurrent && <CheckOutlined style={{ color: '#1677ff', fontSize: 12 }} />}
            </div>
            {m.description && (
              <span style={{ fontSize: 11, color: 'rgba(255,255,255,0.55)' }}>
                {m.description}
              </span>
            )}
          </div>
        )
      })}
      <div style={{ fontSize: 11, color: 'rgba(255,255,255,0.30)', marginTop: 8, borderTop: '1px solid rgba(255,255,255,0.08)', paddingTop: 6 }}>
        仅作用于当前会话. 新建会话仍按 ~/.zai/settings.json 解析.
      </div>
    </div>
  )

  return (
    <Popover
      content={<div onClick={(e) => e.stopPropagation()}>{content}</div>}
      trigger="click"
      placement="topRight"
      destroyTooltipOnHide
    >
      <Button
        type="text"
        size="small"
        title={`当前模型: ${displayLabel ?? '未知'}\n点击切换`}
        style={{
          color: model ? 'rgba(255,255,255,0.55)' : 'rgba(255,255,255,0.30)',
          fontFamily:
            'ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace',
        }}
      >
        {displayLabel ?? '未知'}
      </Button>
    </Popover>
  )
}
