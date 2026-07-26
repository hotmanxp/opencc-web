import { Button } from 'antd'
import { MenuOutlined, PlusOutlined } from '@ant-design/icons'
import { useAgentStore } from '../store/useAgentStore'

export interface MobileHeaderProps {
  /** 点左上角 [≡] 按钮触发(父组件打开会话列表 Drawer) */
  onOpenSessionDrawer: () => void
}

/**
 * 移动端 44px 顶栏:
 *   左: [≡] 抽屉触发按钮 + 当前会话标题(取 sessions.find(s => s.transcriptId === sessionId).title)
 *   右: [+] 新建会话按钮
 * 不渲染设置/分享按钮 — 这两个由 AgentInputBox 内部工具栏提供。
 */
export default function MobileHeader({ onOpenSessionDrawer }: MobileHeaderProps) {
  const sessionId = useAgentStore((s) => s.sessionId)
  const sessions = useAgentStore((s) => s.sessions)
  const createNewSession = useAgentStore((s) => s.createNewSession)
  const current = sessions.find((s) => s.transcriptId === sessionId)
  const title = current?.title || '新会话'

  return (
    <div
      style={{
        height: 44,
        display: 'flex',
        alignItems: 'center',
        padding: '0 8px',
        borderBottom: '1px solid rgba(255,255,255,0.10)',
        background: '#12121a',
        flexShrink: 0,
      }}
    >
      <Button
        type="text"
        icon={<MenuOutlined />}
        onClick={onOpenSessionDrawer}
        data-testid="mobile-header-drawer-toggle"
        aria-label="打开会话列表"
        style={{ width: 36, height: 36, padding: 0 }}
      />
      <div
        style={{
          flex: 1,
          textAlign: 'center',
          fontSize: 14,
          fontWeight: 500,
          color: '#f1f5f9',
          overflow: 'hidden',
          textOverflow: 'ellipsis',
          whiteSpace: 'nowrap',
          padding: '0 8px',
        }}
        data-testid="mobile-header-title"
      >
        {title}
      </div>
      <Button
        type="text"
        icon={<PlusOutlined />}
        onClick={() => void createNewSession()}
        data-testid="mobile-header-new-session"
        aria-label="新建会话"
        style={{ width: 36, height: 36, padding: 0 }}
      />
    </div>
  )
}