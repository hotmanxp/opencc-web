import { useState } from 'react'
import { Button, Drawer, Popconfirm, Tooltip, message } from 'antd'
import { CommentOutlined, ReloadOutlined } from '@ant-design/icons'
import AgentConversation from '../../pages/AgentConversation'
import { useAgentStore } from '../../store/useAgentStore'
import { useSuperTaskStore } from '../../store/useSuperTaskStore'
import { LIGHT_PAGE_VARS } from './lightThemeVars'

/**
 * 移动端任务调度官对话入口(2026-09-04 新增,/m-super-tasks 路由使用)。
 *
 * - 默认折叠:右下角固定圆形 FAB,点开 → bottom Drawer 高度 90%,
 *   内含 `<AgentConversation hideShareAndPlugin />`(调度官 transcript
 *   跨开/关保留 —— 不开 destroyOnHidden)。
 * - FAB streaming 指示:`useAgentStore.status === 'streaming'` 时
 *   右上角叠小圆点。
 * - 抽屉头部右上角「重置会话」按钮(tf-68obb3j3):图标按钮 +
 *   Popconfirm 二次确认 + 复用 `useSuperTaskStore.resetSupervisorSession` →
 *   `window.location.reload()`(与桌面端 TaskOverviewBar 同款接口与反馈)。
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
  const resetSupervisorSession = useSuperTaskStore((s) => s.resetSupervisorSession)
  const [resetting, setResetting] = useState(false)

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
        extra={
          /*
            重置任务调度官会话(tf-68obb3j3):抽屉头部右上角图标按钮。
            - 复用 useSuperTaskStore.resetSupervisorSession()(2026-09-02 桌面
              同款接口),不要重复造服务端轮子。
            - Popconfirm 二次确认防误点;成功后 window.location.reload()
              触发 mount 引导,新建一条空调度官会话替换当前对话。
            - 触摸区域 ≥44px(移动端规范),与抽屉关闭按钮风格一致。
          */
          <Popconfirm
            title="重置任务调度官会话?"
            description={
              <span>
                将创建一条新的空调度官会话替换当前对话。
                <br />
                旧的 transcript 文件保留在 <code>~/.zai/tasks/</code> 与新调度官不再关联。
              </span>
            }
            okText="重置"
            cancelText="取消"
            okButtonProps={{ danger: true, loading: resetting }}
            onConfirm={async () => {
              if (resetting) return
              setResetting(true)
              try {
                await resetSupervisorSession()
                // 全局 reload —— 让 store / 看板 / 调度官 transcript 干净同步
                window.location.reload()
              } catch (err) {
                setResetting(false)
                message.error(
                  `重置失败: ${err instanceof Error ? err.message : String(err)}`,
                )
              }
            }}
          >
            <Tooltip title="清空当前任务调度官会话,触发全新引导">
              <Button
                type="text"
                icon={<ReloadOutlined />}
                loading={resetting}
                disabled={resetting}
                aria-label="重置任务调度官会话"
                data-testid="mobile-supervisor-reset-button"
                style={{ minWidth: 44, minHeight: 44 }}
              />
            </Tooltip>
          </Popconfirm>
        }
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