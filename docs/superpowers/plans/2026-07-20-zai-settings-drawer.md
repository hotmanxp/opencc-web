# Zai Settings Drawer 实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在 zai web 端 AgentInputBox 状态行的现有四个图标之前,插入一个 Settings 按钮;点击弹出右侧 Drawer,内含 Model / Permission / Theme / Env Vars 四个 tab,**首期作为 UI 原型**(visual stub)—— 不接通 PUT 写盘、不持久化、不接 modelCaller 真实 Env。

**Architecture:** 新增一个轻量 `SettingsButton`(单文件组件)+ 一个 `SettingsDrawer`(Drawer + Tabs,4 个内联 Tab pane);扩展 `useAppStore` 加 3 个 action 控开闭 + 1 个字段暂存 Theme;在 `pages/Agent.tsx` 顶层 mount `<SettingsDrawer />`。前端 fetch `GET /api/agent/settings`(已存在)提供 Model tab 的真实数据,其他 3 tab 用前端 mock。

**Tech Stack:** React + AntD(`Drawer` / `Tabs` / `Radio` / `Select` / `Form` / `Tag` / `Button` / `Tooltip` / `Input`)+ `@ant-design/icons`(`SettingOutlined`)+ zustand(`useAppStore`)+ happy-dom + vitest。

## Global Constraints

- 严格按 spec `docs/superpowers/specs/2026-07-20-zai-settings-drawer-design.md` 范围,首期不做实质功能对接
- 不引入新 npm 依赖(AntD 全部已存在)
- 不写后端代码(`routes/agentSettings.ts` 0 改动)
- 视觉对齐:状态行新按钮颜色 `rgba(255,255,255,0.45)`,与同行的 PictureOutlined / ToolOutlined / CompressOutlined 现有按钮完全一致
- Tab 顺序与字段名对齐 opencc `opencc/src/components/Settings/Config.tsx`:Model → Permission → Theme → Env Vars
- 提交规范:`feat:` `/ `chore:` `/ `test:`;无 `TODO` 残留在已合并代码中
- 单元测试仅加 1 个 `SettingsButton.test.tsx` 验证点击打开 store;Drawer 的 Tabs / Mock 数据交互用 happy-dom 测 1 个最小用例(其余 UI 用人工验收)
- yagni:不写 AntD ConfigProvider 主题切换(留给阶段 2);不写 PUT 路由;不接 modelCaller 的 env

---

## 文件结构

| 包 | 文件 | 状态 |
|---|---|---|
| zai (web) | `src/web/src/components/SettingsButton.tsx` | 新建 |
| zai (web) | `src/web/src/components/SettingsDrawer.tsx` | 新建 |
| zai (web) | `src/web/src/components/AgentInputBox.tsx` | 改(行 685/690 之间插入) |
| zai (web) | `src/web/src/store/useAppStore.ts` | 改(扩 3 action + 2 state) |
| zai (web) | `src/web/src/pages/Agent.tsx` | 改(顶层 mount Drawer) |
| zai (web) | `test/web/SettingsButton.test.tsx` | 新建 |

后端 0 改动;其他测试 0 改动。

---

## Task 1: useAppStore 扩展(settingsDrawerOpen + Theme 暂存)

**Files:**
- Modify: `packages/zai/src/web/src/store/useAppStore.ts:35-47`(扩展 `AppState` 接口)
- Modify: `packages/zai/src/web/src/store/useAppStore.ts:49-158`(在 store 实现内加新 state + 3 个 action)

**Interfaces:**
- Produces:
  - `state.settingsDrawerOpen: boolean`(初始 `false`)
  - `state.settingsTheme: 'auto' | 'dark' | 'light' | 'high-contrast'`(初始 `'auto'`)
  - `state.openSettingsDrawer(): void`
  - `state.closeSettingsDrawer(): void`
  - `state.setSettingsTheme(t): void`

**Consumes:** 无 — 仅扩展现有 store,不依赖任何外部模块。

- [ ] **Step 1: 改 AppState 接口**

读 `packages/zai/src/web/src/store/useAppStore.ts:35-47`,在 `applySystemEvent: (event: ServerEvent) => void;` 这一行之后追加:

```ts
  // Settings Drawer 入口状态:右端工具栏的 [⚙] 按钮触发,Agent.tsx 顶层监听渲染.
  // 首期仅 frontend toggle;后续阶段 2 再接 PUT 写盘.
  settingsDrawerOpen: boolean;
  // Theme 仅前端暂存(SPEC 阶段 1),刷新/重开 Drawer 后还原为 'auto'.
  // 与 opencc 上游 ThemeSetting 字段名对齐 (opencc/src/utils/theme.ts:111).
  settingsTheme: 'auto' | 'dark' | 'light' | 'high-contrast';
  openSettingsDrawer: () => void;
  closeSettingsDrawer: () => void;
  setSettingsTheme: (t: 'auto' | 'dark' | 'light' | 'high-contrast') => void;
```

- [ ] **Step 2: 改 store 实现**

读 `packages/zai/src/web/src/store/useAppStore.ts:49-158`。在 `connected: false,` 这一行(line 57 附近)追加:

```ts
  settingsDrawerOpen: false,
  settingsTheme: 'auto',
```

并在 `dismissToast` action(line 154-157)之前或 store 末尾追加:

```ts
  openSettingsDrawer: () => set({ settingsDrawerOpen: true }),
  closeSettingsDrawer: () => set({ settingsDrawerOpen: false }),
  setSettingsTheme: (t) => set({ settingsTheme: t }),
```

- [ ] **Step 3: typecheck 验证**

Run:
```bash
cd packages/zai && npx tsc -b --noEmit 2>&1 | tail -20
```
Expected:无 `useAppStore` 相关错误,其它独立错误可忽略。

- [ ] **Step 4: Commit**

```bash
git add packages/zai/src/web/src/store/useAppStore.ts
git commit -m "feat(zai-store): add settingsDrawerOpen + settingsTheme state

为 Settings Drawer 首期 UI 原型铺底:Toggle 控制 + Theme 前端暂存。
不接 PUT / 不写盘 — spec 阶段 1 范围。"
```

---

## Task 2: SettingsButton 组件 + 单元测试

**Files:**
- Create: `packages/zai/src/web/src/components/SettingsButton.tsx`
- Create: `packages/zai/test/web/SettingsButton.test.tsx`

**Interfaces:**
- Consumes:
  - `useAppStore` 中的 `openSettingsDrawer: () => void`
- Produces:
  - `<SettingsButton />` 单文件 React FC(无 props),点击触发 `openSettingsDrawer`
  - `data-testid="agent-settings-button"` 便于测试定位
  - 视觉与同行的 `PictureOutlined` button 一致(color `rgba(255,255,255,0.45)`)

- [ ] **Step 1: 写失败测试先**

新建 `packages/zai/test/web/SettingsButton.test.tsx`:

```tsx
// @vitest-environment happy-dom
import { describe, it, expect, beforeEach } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import SettingsButton from '../../src/web/src/components/SettingsButton.js'
import { useAppStore } from '../../src/web/src/store/useAppStore.js'

beforeEach(() => {
  useAppStore.setState({
    settingsDrawerOpen: false,
    openSettingsDrawer: useAppStore.getState().openSettingsDrawer,
    closeSettingsDrawer: useAppStore.getState().closeSettingsDrawer,
    setSettingsTheme: useAppStore.getState().setSettingsTheme,
  } as any)
})

describe('SettingsButton', () => {
  it('点击后 settingsDrawerOpen 变 true', () => {
    render(<SettingsButton />)
    const btn = screen.getByTestId('agent-settings-button')
    fireEvent.click(btn)
    expect(useAppStore.getState().settingsDrawerOpen).toBe(true)
  })

  it('初始 settingsDrawerOpen === false', () => {
    render(<SettingsButton />)
    expect(useAppStore.getState().settingsDrawerOpen).toBe(false)
  })
})
```

- [ ] **Step 2: 跑测试确认失败(SettingsButton 还不存在)**

Run:
```bash
cd packages/zai && npx vitest run test/web/SettingsButton.test.tsx 2>&1 | tail -15
```
Expected:FAIL — `Failed to resolve import "../../src/web/src/components/SettingsButton.js"`。

- [ ] **Step 3: 写 SettingsButton 组件**

新建 `packages/zai/src/web/src/components/SettingsButton.tsx`:

```tsx
import { Button, Tooltip } from 'antd'
import { SettingOutlined } from '@ant-design/icons'
import { useAppStore } from '../store/useAppStore'

/**
 * 状态行最右端的"设置"按钮 — 触发 SettingsDrawer(Agent.tsx 顶层 mount).
 *
 * 视觉对齐:与同行的 PictureOutlined / ToolOutlined 一致 (color rgba(255,255,255,0.45)).
 * 位置:AgentInputBox.tsx 行 685 与 690 之间(右端工具栏第一项,在四个原图标之前).
 * 阶段 1 仅触发 drawer.open;后续阶段再接 PUT 写盘.
 */
export default function SettingsButton() {
  const open = useAppStore((s) => s.openSettingsDrawer)
  return (
    <Tooltip title="设置" placement="top">
      <Button
        type="text"
        icon={<SettingOutlined />}
        onClick={open}
        data-testid="agent-settings-button"
        style={{ color: 'rgba(255,255,255,0.45)', flexShrink: 0 }}
      />
    </Tooltip>
  )
}
```

- [ ] **Step 4: 跑测试确认通过**

Run:
```bash
cd packages/zai && npx vitest run test/web/SettingsButton.test.tsx 2>&1 | tail -15
```
Expected:2 tests pass。

- [ ] **Step 5: Commit**

```bash
git add packages/zai/src/web/src/components/SettingsButton.tsx packages/zai/test/web/SettingsButton.test.tsx
git commit -m "feat(zai-web): add SettingsButton trigger for settings drawer

状态行最右端[⚙]图标,点击 open settings drawer。视觉与同行的
PictureOutlined / ToolOutlined 一致 — 灰 #rgba(255,255,255,0.45)。"
```

---

## Task 3: AgentInputBox 插入按钮

**Files:**
- Modify: `packages/zai/src/web/src/components/AgentInputBox.tsx:1-50`(import 部分)
- Modify: `packages/zai/src/web/src/components/AgentInputBox.tsx:685-690`(在 spacer 之后、CompressOutlined button 之前插入 `<SettingsButton />`)

**Interfaces:**
- Consumes: `SettingsButton` 单文件组件(Task 2 产出)
- Produces: 状态行右端的视觉序列变为 `设置 / 折叠 / 修复 / 上传 / 信息`

- [ ] **Step 1: 加 import**

读 `packages/zai/src/web/src/components/AgentInputBox.tsx:1-50`。在 `import` 列表末尾(SettingsButton 之前已有的 ConversationInfoButton 或 AttachmentStrip 附近)追加:

```tsx
import SettingsButton from './SettingsButton'
```

- [ ] **Step 2: 在 spacer 之后插入按钮**

读 `packages/zai/src/web/src/components/AgentInputBox.tsx:682-700`。定位 `<span style={{ flex: 1, minWidth: 0 }} />`(行 685)与紧随其后的 `</span>`(若有)/下一个 `<Tooltip>`(行 690 附近)之间。在该 `<span>` 之后插入:

```tsx
        {/* settings 按钮(首期 UI 原型入口,点击弹出 SettingsDrawer).
            位置:右端工具栏第一项,在 CompressOutlined 之前 — 与原 4 个图标
            共用同一行 flex 容器,颜色一致 (rgba(255,255,255,0.45)).
            替代原 opencc 上游 [⚙] 内嵌快捷键;阶段 2 再加 dropdown 双层结构. */}
        <SettingsButton />
```

- [ ] **Step 3: typecheck**

Run:
```bash
cd packages/zai && npx tsc -b --noEmit 2>&1 | grep -E "AgentInputBox|SettingsButton" | head -10
```
Expected:无报错。

- [ ] **Step 4: 现有测试不回归**

Run:
```bash
cd packages/zai && npx vitest run test/web/ 2>&1 | tail -15
```
Expected:所有 web 测试通过(只新增 2 个 SettingsButton 测试)。

- [ ] **Step 5: Commit**

```bash
git add packages/zai/src/web/src/components/AgentInputBox.tsx
git commit -m "feat(zai-web): insert SettingsButton before AgentInputBox status icons

把 [⚙] 加到状态行右端工具栏第一项,后续图片 / 折叠 / 修复 / 信息
图标位置不动 — 与用户截图右侧四个原图标的红框位置对齐。"
```

---

## Task 4: SettingsDrawer 组件(Drawer + 4 Tabs)

**Files:**
- Create: `packages/zai/src/web/src/components/SettingsDrawer.tsx`

**Interfaces:**
- Consumes:
  - `useAppStore`: `settingsDrawerOpen` / `closeSettingsDrawer` / `settingsTheme` / `setSettingsTheme`
  - `api.get<{ defaultModel; baseURL; models; defaultMode }>('/agent/settings')` 用于 Model tab
  - `useAgentStore.defaultMode` 用于 Permission tab(已存在,见 AgentInputBox 用法)
- Produces:
  - `<SettingsDrawer />` 默认 export,顶层挂载
  - `data-testid="settings-drawer"`,`data-testid="settings-tab-<name>"` 便于后续测试
  - Drawer 在 `settingsDrawerOpen=false` 时不渲染(避免内存浪费),`true` 时挂载并 fetch

- [ ] **Step 1: 写组件骨架(Drawer + Tabs + 关闭)**

新建 `packages/zai/src/web/src/components/SettingsDrawer.tsx`:

```tsx
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
import { useAgentStore } from '../store/useAgentStore'
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
  const defaultMode = useAgentStore((s) => s.defaultMode)

  // Model tab: 拉一次 GET /api/agent/settings. 失败 fallback,不弹 toast (SPEC 阶段 1).
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
            ),
          },
          {
            key: 'permission',
            label: 'Permission',
            children: (
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
            ),
          },
          {
            key: 'theme',
            label: 'Theme',
            children: (
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
            ),
          },
          {
            key: 'env',
            label: 'Env Vars',
            children: (
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
            ),
          },
        ]}
      />
    </Drawer>
  )
}
```

- [ ] **Step 2: typecheck**

Run:
```bash
cd packages/zai && npx tsc -b --noEmit 2>&1 | grep -E "SettingsDrawer" | head -10
```
Expected:无报错。

- [ ] **Step 3: Commit**

```bash
git add packages/zai/src/web/src/components/SettingsDrawer.tsx
git commit -m "feat(zai-web): add SettingsDrawer (4 tabs UI prototype)

Model/Permission/Theme/Env Vars 四 tab — Model tab 拉真实
GET /api/agent/settings,Theme 仅前端 useAppStore 暂存。
首期未接 PUT / 未接 modelCaller。Spec 阶段 1 范围。"
```

---

## Task 5: Agent.tsx 顶层 mount SettingsDrawer

**Files:**
- Modify: `packages/zai/src/web/src/pages/Agent.tsx:515-518`(在 `</div>` 关闭、`);` return 之前 mount)

**Interfaces:**
- Consumes:`SettingsDrawer` 单文件组件(Task 4 产出)
- Produces:Agent 顶层永远挂着 1 个 `<SettingsDrawer />`,只在 `settingsDrawerOpen=true` 时实际渲染(组件内部已处理)

- [ ] **Step 1: 加 import**

读 `packages/zai/src/web/src/pages/Agent.tsx:41-52`(现有 `import` 区)。在 `TaskDrawer` 之后追加:

```tsx
import SettingsDrawer from '../components/SettingsDrawer'
```

- [ ] **Step 2: 顶层 mount**

读 `packages/zai/src/web/src/pages/Agent.tsx:516-518`(行尾 `</div>` 与 `);` 之间)。定位 `<SessionCwdBridge />` 这一行(line 517),在其**之前**插入:

```tsx
      <SettingsDrawer />
```

最终行 516-519 区段(以现有代码为准,只确认顺序)形如:

```tsx
      <TaskDrawer taskId={selectedTaskId} onClose={() => setSelectedTaskId(null)} />
      <SettingsDrawer />
      <SessionCwdBridge />
    </div>
  );
```

- [ ] **Step 3: typecheck + 现有测试回归**

Run:
```bash
cd packages/zai && npx tsc -b --noEmit 2>&1 | grep -E "Agent.tsx" | head -5
cd packages/zai && npx vitest run test/web/ 2>&1 | tail -10
```
Expected:typecheck 无报错;所有 web 测试通过。

- [ ] **Step 4: Commit**

```bash
git add packages/zai/src/web/src/pages/Agent.tsx
git commit -m "feat(zai-web): mount SettingsDrawer at Agent page top level

单例挂载,根据 useAppStore.settingsDrawerOpen 切换可见性。
阶段 1 — 浏览器手动验证:点 [⚙] → Drawer 出,4 tab 切换 OK。"
```

---

## Task 6: 人工验收(浏览器验证)

**Files:** 无修改 — 仅在浏览器中验证

- [ ] **Step 1: 启动 zai dev**

Run:
```bash
cd packages/zai && pnpm dev 2>&1 | tail -10
```
Expected:看到 vite dev server 启动消息(端口详见 dev 输出)。

- [ ] **Step 2: 浏览器验证清单**

打开浏览器,人工逐项确认(spec 验收清单):

- [ ] 状态行出现 `[⚙]` 图标,顺序为 `设置 / 折叠 / 修复 / 上传 / 信息`
- [ ] `[⚙]` 颜色与其他四个图标一致 `rgba(255,255,255,0.45)`
- [ ] 鼠标悬停 → Tooltip "设置"
- [ ] 点击 → 右侧 Drawer 滑出,宽 480
- [ ] Drawer 标题"设置",底部有 [重置] [关闭] 两个按钮
- [ ] 4 个 Tab 文字:Model / Permission / Theme / Env Vars
- [ ] Model tab:显示默认模型 Tag(从 `GET /api/agent/settings` 拉)
- [ ] Permission tab:显示当前 mode Tag,5 个 Radio disabled
- [ ] Theme tab:4 个 Radio 可点,选中即时变化(前端的 state,刷新即丢)
- [ ] Env Vars tab:4 行 mock(Input.Password / Input disabled)
- [ ] Esc / 点击遮罩 → Drawer 关闭
- [ ] 关闭后焦点能回到 [⚙] 按钮
- [ ] 不影响其他按钮 / ConversationInfoButton / transcript repair

- [ ] **Step 3: stop dev server**

Run:`Ctrl+C` (zsh:可能需要按多次关闭 watch 子进程)。

Expected:`pnpm dev` 退出码 0,没有未捕获的错误栈。

- [ ] **Step 4: 最终 commit(若有 UI 调整)**

若验收中发现任何文案 / 间距 / 颜色需要微调,在 `packages/zai/src/web/src/components/SettingsButton.tsx` 或 `SettingsDrawer.tsx` 上做小范围 fix,然后:

```bash
git add -u packages/zai/src/web/src/components/
git commit -m "fix(zai-web): polish settings drawer UI per manual verification"
```

若无需调整,跳过本步。

---

## Self-Review (执行前自检)

**Spec 覆盖:**
- ✅ 新文件 2 个 (`SettingsButton.tsx`, `SettingsDrawer.tsx`) → Task 2/4
- ✅ 改动 3 处 (`AgentInputBox.tsx`, `useAppStore.ts`, `Agent.tsx`) → Task 1/3/5
- ✅ 4 个 Tab 内容 (Model / Permission / Theme / Env Vars) → Task 4
- ✅ 插入位置 (行 685 与 690 之间) → Task 3 步骤 2 显式指定
- ✅ Theme 前端 state 暂存,不写盘 → Task 4 `setTheme` 直接 set
- ✅ 单元测试 1 个最小用例 → Task 2
- ✅ 验收清单 → Task 6
- ✅ 提交规范、零后端改动 → Global Constraints

**占位符扫描:** 无 `TBD` / `TODO` / `implement later`。代码块完整。

**类型一致性:**
- `openSettingsDrawer`/`closeSettingsDrawer`:`Task 1` 定义 → `Task 2` 消费 → `Task 5` mount 的 Drawer 内部消费
- `settingsTheme` + `setSettingsTheme`:`Task 1` 定义 → `Task 4` 在 Theme tab 消费
- `defaultMode` from `useAgentStore`:`Task 4` Permission tab 消费 — 已确认 useAgentStore 持有 (参考 spec §3)
- `api.get('/agent/settings')` 返回 shape:`Task 4` 内联 `AgentSettings` 类型与 `routes/agentSettings.ts` 返回一致(参见 `MODEL_PROVIDERS_*` 字段)
