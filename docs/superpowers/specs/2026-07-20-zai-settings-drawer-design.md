# Zai Settings Drawer 设计

## 背景

用户截图:

```
┌──────────────────────────────────────────────────────────┐
│  [ ▢ ]   [ ⛶ ]   [ 🔧 ]   [ 🖼 ]   [ ⓘ ]                │
└──────────────────────────────────────────────────────────┘
       ↑ 红框高亮,要求在此处插入"设置"按钮
```

zai 现在的 AgentInputBox 状态行(右端图标栏)依次是:`折叠 transcript` / `修复 transcript` / `上传图片` / `查看对话信息` —— **没有"设置"入口**。opencc 上游已经有完整 Settings 系统(`opencc/src/components/Settings/Settings.tsx` 5 个 tab + `Config.tsx` 处理 Model/Theme/Permissions/Env/Editor),zai 明显落后。

**本任务目标**:
1. 在 zai 状态行最右端四个图标**之前**插入一个"设置"按钮(占图中的红框位置)
2. 点击后弹出右侧 Drawer,布局对齐 opencc 的 Config tab —— 包含 Model / Permission / Theme / Env Vars **四个 tab 的完整 UI**
3. **首期不做实质功能对接**(用户明示):Drawer 内所有控件仅 UI 展示、可视化对齐 opencc,不写 PUT、不持久化 Theme、不接通 Env 编辑器真实路径

## 范围与非范围

### In scope
- 新建 `SettingsButton.tsx` —— 一个 `SettingOutlined` 灰色按钮,放在状态行最右端四个图标之前
- 新建 `SettingsDrawer.tsx` —— AntD `Drawer` + `Tabs`,4 个 tab,tab 内表单只做展示与前端 state
- 在 `useAppStore` 加 `settingsDrawerOpen` + 暂存 Theme 等前端的轻量 state
- 在 `Agent.tsx` 顶层 mount SettingsDrawer(避免每个 AgentInputBox 实例单独挂载)
- `GET /api/agent/settings` 已有,Drawer 打开时拉一次 Model tab 的真实数据
- 4 个 tab 字段命名 / 标签文案 / 顺序对齐 `opencc/src/components/Settings/Config.tsx`

### Out of scope(本期明示不做)
- ❌ 写 PUT 接口 / 不写盘 `~/.zai/settings.json`
- ❌ Theme 持久化到磁盘 —— 仅前端 useState,Drawer 关闭后丢失
- ❌ Env Vars 编辑器接到 `modelCaller.ts:46` 的真实 `ZaiSettings.env`
- ❌ Permissions allow/deny rules 结构化编辑
- ❌ 全屏重构 / 不动 `Config.tsx` Provider 表单
- ❌ 新增后端路由
- ❌ 自动化单元测试(纯 UI stub,浏览器/手动验证即可;yagni)

## 架构

```
packages/zai/src/web/src/
  components/
    AgentInputBox.tsx          ← 改: 在行 685 与 690 之间插 <SettingsButton />
    SettingsButton.tsx         ← 新: SettingOutlined icon 按钮
    SettingsDrawer.tsx         ← 新: Drawer + Tabs(4 tab UI)
  pages/
    Agent.tsx                  ← 改: 顶层 mount <SettingsDrawer />
  store/
    useAppStore.ts             ← 改: 加 settingsDrawerOpen + 3 action
```

无后端改动。

### 视觉布局(Drawer 打开时)

```
┌─────────────────── Zai Settings ──────────────── [✕] ┐
│                                                       │
│  [Model] [Permission] [Theme] [Env Vars]              │
│  ──────                                              │
│                                                       │
│  (active tab content)                                │
│                                                       │
│                                                       │
│                                                       │
│                                          [Reset] [✕] │
└───────────────────────────────────────────────────────┘
```

## 详细设计

### 1. `useAppStore` 扩展

```ts
interface AppState {
  // ... 现有字段
  settingsDrawerOpen: boolean;
  settingsTheme: 'auto' | 'dark' | 'light' | 'high-contrast';  // 前端暂存
  openSettingsDrawer: () => void;
  closeSettingsDrawer: () => void;
  setSettingsTheme: (t: AppState['settingsTheme']) => void;
}
```

> **注意**:跟 opencc 上游对齐 theme 字段名(`ThemeSetting` 包含这些值),但不持久化。

### 2. `SettingsButton.tsx`

```tsx
import { Button, Tooltip } from 'antd';
import { SettingOutlined } from '@ant-design/icons';
import { useAppStore } from '../store/useAppStore';

export default function SettingsButton() {
  const open = useAppStore((s) => s.openSettingsDrawer);
  return (
    <Tooltip title="设置" placement="top">
      <Button
        type="text"
        icon={<SettingOutlined />}
        onClick={open}
        data-testid="agent-settings-button"
        // 视觉对齐: 与同行的 PictureOutlined / ToolOutlined 一致
        style={{ color: 'rgba(255,255,255,0.45)', flexShrink: 0 }}
      />
    </Tooltip>
  );
}
```

**插入位置**(AgentInputBox.tsx):在 `<span style={{ flex: 1, minWidth: 0 }} />`(行 685)之后、`<Tooltip title="..."> <Button icon={CompressOutlined} ... />`(行 690)之前。

视觉上这是右端工具栏组的**第一项**,符合用户"在四个图标之前"的指示;左侧 spacer 仍把它与任务摘要隔开,不挤压状态文字。

### 3. `SettingsDrawer.tsx`

```
Drawer
├── title:   "设置"  (左对齐)
├── width:   480     (跟随右侧)
├── placement: 'right'
├── open:    useAppStore.settingsDrawerOpen
├── onClose: closeSettingsDrawer
├── body:    <Tabs activeKey ... onChange ... items={[Model,Permission,Theme,Env]} />
└── footer:  [ <Button onClick={() => message.info('UI 原型,本期不写入')}>重置</Button> ,
             <Button onClick={close} type="primary">关闭</Button> ]
```

**4 个 Tab 内容(均参考 opencc/src/components/Settings/Config.tsx 字段名 + 顺序)**:

| Tab | 字段 | 控件 | 数据来源 |
|---|---|---|---|
| Model | 当前默认 model + baseURL 标签 | `<Tag>` 只读 | `GET /api/agent/settings`(已有) |
|  | 模型列表(可选条目) | `<Select disabled>` | 同上 |
| Permission | 当前 permission mode | `<Tag color="blue">{mode}</Tag>` | `useAgentStore.defaultMode`(已存在,直接复用,store 不新增字段) |
|  | mode 支持列表 | `<Radio.Group disabled>` | 硬编码 5 种 mode |
| Theme | auto/dark/light/high-contrast | `<Radio.Group value={settingsTheme} onChange={...}>` | useAppStore 暂存 |
| Env Vars | ANTHROPIC_API_KEY / ANTHROPIC_BASE_URL / ... | `<Input.Password disabled>` + `<List>` 只读 | 固定 mock 4 行 |

**每个 tab 内控件**:`Form layout="vertical"`,spacing 与 opencc Config 行为一致(`marginBottom: 16`)。所有 `<Select>` / `<Input>` 用 `disabled` prop,**视觉上可点击但实际不可交互**(与"UI 原型"声明一致)。

### 4. `Agent.tsx` 顶层 mount

```tsx
// Agent.tsx 顶层(在 <Layout> 之后,或与 Toast/JobDock 同级)
return (
  <>
    <Layout>...</Layout>
    <SettingsDrawer />   // 新增,根据 store.open 决定是否渲染
  </>
);
```

放在 Agent 顶层而不是 AgentInputBox,避免每次状态行 rerender 重挂(虽然 Drawer 自带 open 动画,但布局不必要重渲染)。

## 数据流

```
AgentInputBox.tsx:685
   onClick ─→ useAppStore.openSettingsDrawer()
                                   ↓
                          settingsDrawerOpen = true
                                   ↓
                Agent.tsx 顶层 <SettingsDrawer open={true} />
                                   ↓
              useEffect ─→ GET /api/agent/settings (一次)
                                   ↓
                            Model tab 显示数据
                                   ↓
                            Theme Radio 点击 ─→ useAppStore.setSettingsTheme
                                   ↓
                  前端 useState 暂存,刷新 / 重开 Drawer 后还原为 auto
```

`GET /api/agent/settings` 已经在 `routes/agentSettings.ts:130`,返回 `{defaultModel, baseURL, models[], defaultMode}`,无需后端修改。

## 错误处理

- 拉 `/api/agent/settings` 失败 → Model tab fallback 显示 "无法加载" + 静默,不弹 toast(纯 stub 阶段)
- Esc / 点击遮罩关闭 Drawer → 走 AntD Drawer 默认 onClose,直接 `closeSettingsDrawer()`
- Theme 写入失败永远不存在(本阶段不写)

## 验收(yagni — 人工验证)

- [ ] 状态行出现 `[⚙]`,在 4 个原图标之前(顺序: 设置 / 折叠 / 修复 / 上传 / 信息)
- [ ] 灰度色 `rgba(255,255,255,0.45)`,尺寸与邻居一致(约 32x32)
- [ ] 鼠标悬停 → Tooltip "设置"
- [ ] 点击 → 右侧 Drawer 滑出,宽 480,4 个 tab: Model / Permission / Theme / Env Vars
- [ ] 切 tab 内容布局对齐 opencc Config 字段(同顺序、同 label)
- [ ] Model tab 真实展示当前 defaultModel/baseURL(从 `/api/agent/settings` 拉)
- [ ] Theme 点击 Radio 即时变化(前端 state,刷新即丢)
- [ ] 关闭 → Drawer 滑出,焦点正确回流到设置按钮(antd Drawer 默认行为)
- [ ] Esc 也能关闭
- [ ] 不影响其他按钮、ConversationInfoButton、transcript repair 等

## 与其他 PR 的关系

- `2026-07-13-conversation-info-button-design.md` —— ConversationInfoButton 是单按钮 Popover,只显示会话信息。新 Settings Drawer 是设置入口,**功能正交**,共存
- `2026-07-13-zai-clickable-model-switcher-design.md` + `2026-07-13-zai-model-status-button-tui-redesign-design.md` —— ModelStatusButton 在状态栏,SettingsDrawer 里只是 "Model" tab 的纯展示部分,**不会替代现有的快速切换入口**
- `2026-07-14-agent-mode-design.md` —— 同理,SettingsDrawer 不替代 ModeStatusButton

## 后续阶段路线(不在本期)

| 阶段 | 内容 |
|---|---|
| 阶段 2 | 真实接通 PUT /api/agent/settings;Theme 持久化到 settings.json;Theme 实际影响 CSS variables |
| 阶段 3 | Permissions allow/deny rules 结构化 UI(替换 Config.tsx 里的 raw JSON) |
| 阶段 4 | Env Vars 结构化编辑器(对接 `modelCaller.ts:46` 的 `ZaiSettings.env`) |
| 阶段 5 | Notification / Attribution 等小项 |

---

## 修订:2026-07-20 TUI 重写

**首期提交(prototype)按 spec 实现了 AntD Drawer + Tabs + Form 风格**,但实际效果与 opencc 上游 `Config.tsx` 的「文字列表 TUI」风格差距明显。用户反馈:`> cursor` + 单行文本 + 右对齐值 + 键盘交互(Space / Enter / `/` / Esc)的紧凑交互才是预期形态,而不是 AntD Radio/Select/Tag。

**本修订保留 Drawer 作为右侧容器,但内部替换为 opencc /config 风格的文本行列表**:

- ❌ 删除 AntD `Tabs` / `Form` / `Radio.Group` / `Select` / `Tag` / `List`(原 spec 详设 §3 + §验收)
- ❌ 删除 4 tab 划分(Model / Permission / Theme / Env Vars)
- ✅ 改为单一文本行列表,按 section(Permission / Theme / Language)分组;每行 `左 label` + `右 value`,`>` 标记当前光标行
- ✅ 键盘交互(对齐 opencc /config):
  - `↑↓` 移动光标(跳过 section header)
  - `Space` 切换 boolean 行
  - `Enter` 在 enum 行上弹居中下拉; `↑↓` 选;`Enter` 确认;`Esc` 取消
  - `/` 进入搜索;输入过滤;`Esc` 退出搜索(回到完整列表)
  - `Esc`(非搜索、非浮层)关闭 Drawer
- ✅ 行类型只保留 boolean / enum;原 Model tab(GET `/api/agent/settings`)+ Env Vars mock 在阶段 2 重新接入
- ✅ 字体:`ui-monospace, ...` + 13px,行高 1.5,与截图的 TUI 风格一致

**实施影响**:

- 行为变更:`SettingsDrawer.tsx` 整文件重写,但 store (`settingsDrawerOpen` / `settingsTheme` / 三个 action)、`SettingsButton.tsx`、`Agent.tsx` 顶层 mount 点保持不变
- 数据流:`SettingsList` 内部 schema 仍由父组件通过 `onChange(key, value)` 回调写回(本阶段不持久化;主题行额外 `setSettingsTheme` 同步到 store)
- 测试:新增 `test/web/SettingsDrawer.test.tsx` 覆盖 20 个用例(渲染 / 导航 / Space / Enter 弹层 / `/` 搜索 / Esc / store 联动);`SettingsButton.test.tsx` 不变
- 阶段 2 重写计划:删除「Model tab GET /api/agent settings」+「Env Vars mock」两条;改为「在 Permission section 之前插入『Model』section + 一行 enum (当前 model),数据从 `/api/agent/settings` 拼;Env Vars 推迟到阶段 4」
