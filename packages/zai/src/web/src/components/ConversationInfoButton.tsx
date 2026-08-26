import { useState } from 'react'
import { Button, Modal, Popover } from 'antd'
import { InfoCircleOutlined } from '@ant-design/icons'
import { useConversationInfo } from '../hooks/useConversationInfo.js'
import ConversationInfoCard from './ConversationInfoCard.js'
import { useAppStore } from '../store/useAppStore.js'
import { toolbarIconButtonStyle } from './toolbarStyles.js'

/**
 * 工具栏 [i] 按钮 — 展示会话元信息。
 *
 * - 桌面端 (isMobile=false): 走 antd Popover,placement="topRight",
 *   卡片锚定在按钮旁。
 * - 移动端 (isMobile=true): 走 antd Modal,centered + 响应式宽度,
 *   在视口居中且不被屏幕宽度裁切。
 *
 * isMobile===undefined(初次渲染 / SSR 边界)回退 Popover,避免桌面
 * 初始态闪一下 Modal。
 */
export default function ConversationInfoButton() {
  const info = useConversationInfo()
  // 显式 boolean 化,避免 undefined 时 .startsWith 等判断出错.
  const isMobile = useAppStore((s) => s.isMobile) === true

  // 移动端: 默认打开(用户在窄屏点 [i] 一次就看到内容).
  // 桌面端: 维持 Popover 自带 trigger="click" 的语义,本地 open 不参与.
  const [mobileOpen, setMobileOpen] = useState<boolean>(isMobile)

  const handleTriggerClick = () => {
    if (isMobile) setMobileOpen((v) => !v)
  }

  const cardBody = (
    <div onClick={(e) => e.stopPropagation()}>
      <ConversationInfoCard info={info} />
    </div>
  )

  if (isMobile) {
    return (
      <>
        <Button
          icon={<InfoCircleOutlined />}
          aria-label="查看对话信息"
          title="查看对话信息"
          style={toolbarIconButtonStyle}
          data-testid="conversation-info-trigger"
          onClick={handleTriggerClick}
        />
        <Modal
          open={mobileOpen}
          onCancel={() => setMobileOpen(false)}
          centered
          width="min(360px, calc(100vw - 32px))"
          footer={null}
          maskClosable
          destroyOnHidden
          title="会话信息"
          aria-label="会话信息"
          data-testid="mobile-conversation-info-modal"
        >
          {cardBody}
        </Modal>
      </>
    )
  }

  return (
    <Popover
      trigger="click"
      placement="topRight"
      content={cardBody}
      overlayInnerStyle={{ padding: 12 }}
      destroyTooltipOnHide
    >
      <Button
        icon={<InfoCircleOutlined />}
        aria-label="查看对话信息"
        title="查看对话信息"
        style={toolbarIconButtonStyle}
        data-testid="conversation-info-trigger"
      />
    </Popover>
  )
}
