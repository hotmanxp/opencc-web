import { Drawer, Button, Popconfirm } from 'antd'
import { PlusOutlined, DeleteOutlined } from '@ant-design/icons'
import { useAgentStore } from '../store/useAgentStore'

export interface MobileSessionDrawerProps {
  open: boolean
  onClose: () => void
}

/**
 * 从左侧滑出的会话列表 — 替代 PC 端内嵌的 40/140px 列。
 * 点某条会话 → setCurrentSession + loadTranscript,然后调 onClose 关抽屉。
 */
export default function MobileSessionDrawer({ open, onClose }: MobileSessionDrawerProps) {
  const sessions = useAgentStore((s) => s.sessions)
  const sessionId = useAgentStore((s) => s.sessionId)
  const setCurrentSession = useAgentStore((s) => s.setCurrentSession)
  const loadTranscript = useAgentStore((s) => s.loadTranscript)
  const deleteSession = useAgentStore((s) => s.deleteSession)
  const createNewSession = useAgentStore((s) => s.createNewSession)

  const handlePick = (sid: string) => {
    setCurrentSession(sid)
    void loadTranscript(sid)
    onClose()
  }

  return (
    <Drawer
      title="会话历史"
      placement="left"
      open={open}
      onClose={onClose}
      width="80%"
      styles={{ body: { padding: 0 } }}
      data-testid="mobile-session-drawer"
      extra={
        <Button
          type="text"
          icon={<PlusOutlined />}
          onClick={() => void createNewSession()}
          aria-label="新建会话"
        />
      }
    >
      {sessions.length === 0 && (
        <div style={{ padding: 16, color: 'var(--text-dim-45)', fontSize: 13 }}>暂无历史会话</div>
      )}
      <div style={{ display: 'flex', flexDirection: 'column' }}>
        {sessions.map((s) => {
          const active = s.transcriptId === sessionId
          return (
            <div
              key={s.transcriptId}
              role="button"
              tabIndex={0}
              onClick={() => handlePick(s.transcriptId)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' || e.key === ' ') {
                  e.preventDefault()
                  handlePick(s.transcriptId)
                }
              }}
              data-testid={`mobile-session-item-${s.transcriptId}`}
              style={{
                padding: '12px 16px',
                cursor: 'pointer',
                borderBottom: '1px solid var(--border-faint)',
                background: active ? 'rgba(255,102,0,0.10)' : 'transparent',
                display: 'flex',
                alignItems: 'center',
                gap: 8,
              }}
            >
              <div style={{ flex: 1, minWidth: 0 }}>
                <div
                  style={{
                    fontSize: 14,
                    color: active ? '#ff8533' : 'var(--text-primary)',
                    overflow: 'hidden',
                    textOverflow: 'ellipsis',
                    whiteSpace: 'nowrap',
                  }}
                >
                  {s.title || '新会话'}
                </div>
                <div style={{ fontSize: 11, color: 'var(--text-dim-45)', marginTop: 2 }}>
                  {new Date(s.updatedAt).toLocaleString()}
                </div>
              </div>
              <Popconfirm
                title="删除该会话?"
                okText="删除"
                cancelText="取消"
                okButtonProps={{ danger: true }}
                onConfirm={(e) => {
                  e?.stopPropagation()
                  void deleteSession(s.transcriptId)
                }}
                onCancel={(e) => e?.stopPropagation()}
              >
                <Button
                  type="text"
                  size="small"
                  danger
                  icon={<DeleteOutlined />}
                  onClick={(e) => e.stopPropagation()}
                  aria-label="删除会话"
                />
              </Popconfirm>
            </div>
          )
        })}
      </div>
    </Drawer>
  )
}