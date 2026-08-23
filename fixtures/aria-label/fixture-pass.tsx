// 全豁免 fixture: 期望审计通过
import { Button, Form, Input, Modal, Drawer, Tooltip } from 'antd'

export function PassExample() {
  return (
    <>
      {/* 豁免: 含可见文字 children */}
      <Button>提交</Button>
      <a href="/x">链接</a>
      <button>原生按钮</button>

      {/* 豁免: Form.Item label 包裹 */}
      <Form.Item label="用户名">
        <Input />
      </Form.Item>

      {/* 豁免: Modal/Drawer 含 title */}
      <Modal title="确认对话框" open={false} />
      <Drawer title="侧边栏" open={false} />

      {/* 豁免: aria-label 已存在 */}
      <Button aria-label="关闭">X</Button>
      <input aria-label="搜索框" />
    </>
  )
}