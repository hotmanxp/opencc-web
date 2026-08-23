// Regression fixture for Form.Item 豁免规则
// Spec 豁免条件 ②: <Form.Item label="..."> 包裹的 Input/Select/TextArea 等
// 必须被识别为合规 — 否则会被误报为 violation。
//
// 这条 fixture 专门盯 Form.Item 豁免分支的可达性:
// <Form> 必须在 INTERACTIVE_WHITELIST(否则 isInteractiveName 直接 return null),
// <Form.Item> 走 isInteractiveName 通过,豁免 4 分支检查 label + 子节点含 Input。
// 还要覆盖 div / Space 等任意 JSXElement 包装(递归查找)。
import { Form, Input, Select, TextArea, Switch } from 'antd'

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
      {/* div 包裹 — 修复前会误报,修复后必须豁免 */}
      <Form.Item label="启动端口">
        <div style={{ display: 'flex' }}>
          <Form.Item label="开关" noStyle>
            <Switch />
          </Form.Item>
          <Form.Item label="端口" noStyle>
            <Input />
          </Form.Item>
        </div>
      </Form.Item>
    </Form>
  )
}