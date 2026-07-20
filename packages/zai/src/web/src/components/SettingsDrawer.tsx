import { useEffect, useState } from 'react'
import {
  Drawer,
  Tabs,
  Form,
  Radio,
  Select,
  Tag,
  Input,
  List,
  Button,
  Space,
  message,
} from 'antd'
import { useAppStore } from '../store/useAppStore'
import { api } from '../lib/api'

type Theme = 'auto' | 'dark' | 'light' | 'high-contrast'
type Mode = 'default' | 'acceptEdits' | 'plan' | 'bypassPermissions' | 'dontAsk'
const PERMISSION_MODES: Mode[] = [
  'default',
  'acceptEdits',
  'plan',
  'bypassPermissions',
  'dontAsk',
]
// 4 行 mock,首期不接 modelCaller.ts:46 的真实 ZaiSettings.env
const MOCK_ENV: { name: string; secret: boolean; value: string }[] = [
  { name: 'ANTHROPIC_API_KEY', secret: true, value: 'sk-ant-mock••••' },
  { name: 'ANTHROPIC_BASE_URL', secret: false, value: 'https://api.minimaxi.com/v1' },
  { name: 'ANTHROPIC_DEFAULT_SONNET_MODEL', secret: false, value: 'MiniMax-M3' },
  { name: 'ANTHROPIC_SMALL_FAST_MODEL', secret: false, value: 'MiniMax-M2.7-highspeed' },
]

export default function SettingsDrawer() {
  const open = useAppStore((s) => s.settingsDrawerOpen)
  const close = useAppStore((s) => s.closeSettingsDrawer)
  const theme = useAppStore((s) => s.settingsTheme)
  const setTheme = useAppStore((s) => s.setSettingsTheme)

  // Model tab: 拉一次 GET /api/agent/settings. 失败 fallback,不弹 toast (SPEC 阶段 1).
  // defaultMode 来自同一个 endpoint 的响应 — agentSettings.ts:137 透传 getDefaultMode().
  type AgentSettings = {
    defaultModel: string
    baseURL: string | null
    models: { alias: string; model: string; label: string; baseUrl: string }[]
    defaultMode?: Mode
  }
  const [settings, setSettings] = useState<AgentSettings | null>(null)
  useEffect(() => {
    if (!open || settings) return
    let cancel = false
    api
      .get<AgentSettings>('/agent/settings')
      .then((d) => {
        if (!cancel) setSettings(d)
      })
      .catch(() => {
        if (!cancel) setSettings({ defaultModel: 'unknown', baseURL: null, models: [] })
      })
    return () => {
      cancel = true
    }
  }, [open, settings])

  if (!open) return null

  // Permission tab fallback:未拉到 settings 时用 'default',避免空白闪烁
  const defaultMode: Mode = settings?.defaultMode ?? 'default'

  return (
    <Drawer
      title="设置"
      width={480}
      placement="right"
      open={open}
      onClose={close}
      destroyOnClose
      data-testid="settings-drawer"
      footer={
        <Space style={{ width: '100%', justifyContent: 'flex-end' }}>
          <Button
            onClick={() => message.info('UI 原型,本期不写入')}
            data-testid="settings-reset-button"
          >
            重置
          </Button>
          <Button type="primary" onClick={close}>
            关闭
          </Button>
        </Space>
      }
    >
      <Tabs
        defaultActiveKey="model"
        items={[
          {
            key: 'model',
            label: 'Model',
            children: (
              <div data-testid="settings-tab-model">
                <Form layout="vertical" style={{ marginTop: 16 }}>
                  <Form.Item label="默认模型">
                    <Tag color="blue">{settings?.defaultModel ?? '加载中…'}</Tag>
                  </Form.Item>
                  <Form.Item label="API Base URL">
                    <Tag>{settings?.baseURL ?? '默认'}</Tag>
                  </Form.Item>
                  <Form.Item label="可选模型">
                    <Select
                      style={{ width: '100%' }}
                      disabled
                      value={settings?.defaultModel}
                      options={(settings?.models ?? []).map((m) => ({
                        label: m.label,
                        value: m.alias,
                      }))}
                      placeholder="(首期不可切换 — 阶段 2 启用)"
                    />
                  </Form.Item>
                </Form>
              </div>
            ),
          },
          {
            key: 'permission',
            label: 'Permission',
            children: (
              <div data-testid="settings-tab-permission">
                <Form layout="vertical" style={{ marginTop: 16 }}>
                  <Form.Item label="当前模式">
                    <Tag color="blue">{defaultMode}</Tag>
                  </Form.Item>
                  <Form.Item label="支持列表(只读,首期)">
                    <Radio.Group disabled value={defaultMode}>
                      <Space direction="vertical">
                        {PERMISSION_MODES.map((m) => (
                          <Radio key={m} value={m}>
                            {m}
                          </Radio>
                        ))}
                      </Space>
                    </Radio.Group>
                  </Form.Item>
                </Form>
              </div>
            ),
          },
          {
            key: 'theme',
            label: 'Theme',
            children: (
              <div data-testid="settings-tab-theme">
                <Form layout="vertical" style={{ marginTop: 16 }}>
                  <Form.Item label="界面主题">
                    <Radio.Group
                      value={theme}
                      onChange={(e) => setTheme(e.target.value as Theme)}
                    >
                      <Space direction="vertical">
                        <Radio value="auto">auto(跟随系统)</Radio>
                        <Radio value="dark">dark</Radio>
                        <Radio value="light">light</Radio>
                        <Radio value="high-contrast">high-contrast</Radio>
                      </Space>
                    </Radio.Group>
                  </Form.Item>
                  <p style={{ color: 'rgba(0,0,0,0.45)', fontSize: 12 }}>
                    阶段 1:仅前端 state,刷新 / 重开 Drawer 后还原为 auto。
                  </p>
                </Form>
              </div>
            ),
          },
          {
            key: 'env',
            label: 'Env Vars',
            children: (
              <div data-testid="settings-tab-env">
                <Form layout="vertical" style={{ marginTop: 16 }}>
                  <p style={{ color: 'rgba(0,0,0,0.45)', fontSize: 12, marginBottom: 8 }}>
                    阶段 1:只读 mock 数据,阶段 4 对接 modelCaller 真实 ZaiSettings.env。
                  </p>
                  <List
                    dataSource={MOCK_ENV}
                    renderItem={(item) => (
                      <List.Item key={item.name}>
                        <Form.Item label={item.name} style={{ marginBottom: 0, width: '100%' }}>
                          {item.secret ? (
                            <Input.Password value={item.value} disabled />
                          ) : (
                            <Input value={item.value} disabled />
                          )}
                        </Form.Item>
                      </List.Item>
                    )}
                  />
                </Form>
              </div>
            ),
          },
        ]}
      />
    </Drawer>
  )
}
