import { Button, Popover } from 'antd'
import { InfoCircleOutlined } from '@ant-design/icons'
import { useConversationInfo } from '../hooks/useConversationInfo.js'
import ConversationInfoCard from './ConversationInfoCard.js'

export default function ConversationInfoButton() {
  const info = useConversationInfo()

  return (
    <Popover
      trigger="click"
      placement="topRight"
      // 阻止内部 click 冒泡到外层, 避免 antd Popover 的 outside-click 检测误关.
      content={<div onClick={(e) => e.stopPropagation()}><ConversationInfoCard info={info} /></div>}
      overlayInnerStyle={{ padding: 12 }}
      destroyTooltipOnHide
    >
      <Button
        type="text"
        icon={<InfoCircleOutlined />}
        title="查看对话信息"
        // 与现有 PictureOutlined 按钮样式对齐 (状态栏右侧灰色 icon)
        style={{ color: 'rgba(255,255,255,0.45)' }}
      />
    </Popover>
  )
}