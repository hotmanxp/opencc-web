// Regression fixture for Form.Item 豁免规则
// Spec 豁免条件 ②: <Form.Item label="..."> 包裹的 Input/Select/TextArea 等
// 必须被识别为合规 — 否则会被误报为 violation。
//
// 这条 fixture 专门盯 Form.Item 豁免分支的可达性:
// <Form> 必须在 INTERACTIVE_WHITELIST(否则 isInteractiveName 直接 return null),
// <Form.Item> 走 isInteractiveName 通过,豁免 4 分支检查 label + 子节点含 Input。
import { Form, Input, Select, TextArea } from 'antd'

export function FormItemExample() {
  return (
    <Form>
      <Form.Item label="用户名">
        <Input />
      </Form.Item>
      <Form.Item label="角色">
        <Select />
      </Form.Item>
      <Form.Item label="备注">
        <TextArea />
      </Form.Item>
      <Form.Item label="嵌套">
        <Form.Item label="内层">
          <Input />
        </Form.Item>
      </Form.Item>
    </Form>
  )
}