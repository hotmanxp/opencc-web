import { Button, Popover } from 'antd'
import { InfoCircleOutlined } from '@ant-design/icons'
import { useConversationInfo } from '../hooks/useConversationInfo.js'
import ConversationInfoCard from './ConversationInfoCard.js'
import { toolbarIconButtonStyle } from './toolbarStyles.js'

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
        icon={<InfoCircleOutlined />}
        title="查看对话信息"
        // 与同行其他工具栏图标按钮共享样式 (边框 + 尺寸 + 颜色)
        style={toolbarIconButtonStyle}
      />
    </Popover>
  )
}