import { Drawer } from 'antd'
import { CommentOutlined } from '@ant-design/icons'
import AgentConversation from '../../pages/AgentConversation'
import { useAgentStore } from '../../store/useAgentStore'
import { LIGHT_PAGE_VARS } from './lightThemeVars'

/**
 * 移动端任务调度官对话入口(2026-09-04 新增,/m-super-tasks 路由使用)。
 *
 * - 默认折叠:右下角固定圆形 FAB,点开 → bottom Drawer 高度 90%,
 *   内含 `<AgentConversation hideShareAndPlugin />`(调度官 transcript
 *   跨开/关保留 —— 不开 destroyOnHidden)。
 * - FAB streaming 指示:`useAgentStore.status === 'streaming'` 时
 *   右上角叠小圆点。
 *
 * Drawer 走 portal 挂在 document.body 下,拿不到页面根 div 上的
 * LIGHT_PAGE_VARS CSS 变量;body 内层必须再注入一份(参考
 * NewSuperTaskModal.tsx L276-278 注释)。
 */
export default function MobileSupervisorDrawer({
  open,
  onOpen,
  onClose,
}: {
  open: boolean
  onOpen: () => void
  onClose: () => void
}): JSX.Element {
  const status = useAgentStore((s) => s.status)
  const streaming = status === 'streaming'

  return (
    <>
      <button
        type="button"
        aria-label="打开任务调度官对话"
        data-testid="mobile-supervisor-fab"
        onClick={onOpen}
        style={{
          position: 'fixed',
          right: 16,
          bottom: 'calc(16px + env(safe-area-inset-bottom))',
          width: 52,
          height: 52,
          borderRadius: '50%',
          border: 'none',
          background: '#f97316',
          color: '#ffffff',
          boxShadow: '0 4px 12px rgba(0,0,0,.18)',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          zIndex: 900,
          cursor: 'pointer',
          outline: 'none',
        }}
      >
        <CommentOutlined style={{ fontSize: 22, color: '#ffffff' }} />
        {streaming && (
          <span
            data-testid="mobile-supervisor-fab-dot"
            style={{
              position: 'absolute',
              top: 4,
              right: 4,
              width: 10,
              height: 10,
              borderRadius: '50%',
              background: '#ffffff',
              border: '2px solid #f97316',
            }}
          />
        )}
      </button>
      <Drawer
        open={open}
        onClose={onClose}
        placement="bottom"
        height="90%"
        destroyOnHidden={false}
        title="任务调度官对话"
        styles={{ body: { padding: 0 } }}
        data-testid="mobile-supervisor-drawer"
      >
        <div
          style={{
            ...LIGHT_PAGE_VARS,
            background: '#eef2f7',
            height: '100%',
            display: 'flex',
            flexDirection: 'column',
          }}
        >
          <div style={{ flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column' }}>
            <AgentConversation hideShareAndPlugin />
          </div>
        </div>
      </Drawer>
    </>
  )
}