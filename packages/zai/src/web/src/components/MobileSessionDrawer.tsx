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
  // 对话进行中(streaming)禁用会话切换/新建/删除 — 与桌面端侧栏一致。
  const status = useAgentStore((s) => s.status)
  const isBusy = status === "streaming"

  const handlePick = (sid: string) => {
    if (isBusy) return
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
          disabled={isBusy}
          aria-label="新建会话"
          title={isBusy ? "对话进行中,请等待当前回复结束" : undefined}
        />
      }
    >
      {sessions.length === 0 && (
        <div className="p-4 text-[var(--text-dim-45)] text-[13px]">暂无历史会话</div>
      )}
      <div className="flex flex-col">
        {sessions.map((s) => {
          const active = s.sessionId === sessionId
          return (
            <div
              key={s.sessionId}
              role="button"
              tabIndex={0}
              onClick={() => handlePick(s.sessionId)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' || e.key === ' ') {
                  e.preventDefault()
                  handlePick(s.sessionId)
                }
              }}
              data-testid={`mobile-session-item-${s.sessionId}`}
              style={{
                background: active ? 'rgba(255,102,0,0.10)' : 'transparent',
              }}
              className="py-3 px-4 cursor-pointer border-b border-[var(--border-faint)] flex items-center gap-2"
            >
              <div className="flex-1 min-w-0">
                <div
                  style={{
                    color: active ? '#ff8533' : 'var(--text-primary)',
                  }}
                  className="text-[14px] overflow-hidden text-ellipsis whitespace-nowrap"
                >
                  {s.title || '新会话'}
                </div>
                <div className="text-[11px] text-[var(--text-dim-45)] mt-0.5">
                  {new Date(s.updatedAt).toLocaleString()}
                </div>
              </div>
              <Popconfirm
                title="删除该会话?"
                aria-label="删除会话"
                okText="删除"
                cancelText="取消"
                okButtonProps={{ danger: true }}
                onConfirm={(e) => {
                  e?.stopPropagation()
                  void deleteSession(s.sessionId)
                }}
                onCancel={(e) => e?.stopPropagation()}
              >
                <Button
                  type="text"
                  size="small"
                  danger
                  icon={<DeleteOutlined />}
                  disabled={isBusy}
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