# zai 白色主题与主题切换 — 设计 spec

> **状态**:草案(v1) — 待用户审阅
> **范围**:阶段 1 — 实现 light/dark/auto 三档即时切换;不持久化;只收敛高优先硬编码颜色
> **不在范围**:持久化、`high-contrast` 真实主题、边栏/CodeMirror 主题联动、剩余分散硬编码

---

## 1. 背景

zai 前端当前完全以暗色为主题。`packages/zai/src/web/src/App.tsx` 的 AntD `ConfigProvider` 硬编码 `theme.darkAlgorithm` 和 9 个深色 token;`packages/zai/src/web/src/index.css` 在 `:root` 定义 16 个 CSS 自定义属性,值全部是深色;约 120+ 处散落的内联硬编码颜色进一步强化了暗色观感。

`useAppStore.settingsTheme` 字段(`'auto' | 'dark' | 'light' | 'high-contrast'`)和 `setSettingsTheme` setter、`SettingsDrawer.tsx` 第 629–641 行的 Theme 切换 UI 都已就位。**唯一缺的是把这三者接通的渲染逻辑。**

本 spec 把这条链路打通,实现 light/dark/auto 三档即时切换,默认 auto 跟随系统。

---

## 2. 目标 / 非目标

### 2.1 目标

1. 在 Settings 面板选 Light / Dark,无需刷新即可看到全站换肤。
2. 默认 `'auto'` 档:跟随系统 `prefers-color-scheme`,系统主题变化时页面实时跟随。
3. AntD 全组件(Button / Menu / Modal / Drawer / Tag / Tabs / Card / Table / ...)+ 自定义组件(QuestionCard / MessageBubble / TaskDock / TaskDrawer)颜色都切换。
4. 不破坏既有 `useAppStore` 的 `setSettingsTheme` 契约与 `SettingsDrawer.test.tsx` 回归测试。

### 2.2 非目标(后续 phase)

- 把 `settingsTheme` 持久化到 `localStorage` 或 `~/.zai/settings.json`(新增 server 端点)。
- 实现 `high-contrast` 主题的真实视觉(目前 enum 里有,但 UI 把它映射回 `'auto'`,本 spec 沿用)。
- `<Layout>` 边栏 `<Menu theme="dark">` 跟随主题联动。
- CodeMirror 6 编辑器(`TextEditor.tsx`)跟随主题联动。
- 收敛剩余 ~85 处分散内联硬编码颜色(本 spec 只动 4 个高优先文件)。

---

## 3. 架构(三层)

```
┌──────────────────────────────────────────────────────┐
│ State     useAppStore.settingsTheme                  │
│           'auto'|'dark'|'light'|'high-contrast'      │
│           (类型/setter/默认值已就位,本期不动)         │
└──────────────────┬───────────────────────────────────┘
                   ▼
┌──────────────────────────────────────────────────────┐
│ Resolve  useEffectiveTheme()                         │
│           输入: settingsTheme + matchMedia            │
│           输出: 'dark' | 'light'                     │
│           'auto' / 'high-contrast' → 跟随系统        │
│           matchMedia 不可用 → 降级 'dark'             │
└──────────────────┬───────────────────────────────────┘
                   ▼
┌──────────────────────────────────────────────────────┐
│ Apply    App.tsx 读 effective →                     │
│           ├─ ConfigProvider.algorithm (dark/default)│
│           ├─ ConfigProvider.token   (dark/light 两套) │
│           └─ documentElement.dataset.theme = 'dark'  │
│              | 'light'                                │
│           index.css [data-theme='light'] 覆盖 16 个   │
│           :root CSS 变量                              │
└──────────────────────────────────────────────────────┘
```

**关键设计决策**

| 决策 | 理由 |
|---|---|
| 不改 store 类型/初始值/默认值 | 已有契约,改了会破坏 `setSettingsTheme` 回归测试;`useAppStore` 是客户端单例,刷新重置可接受(用户已选 no-persistence) |
| 新增独立 hook `useEffectiveTheme` 而非 selector | hook 自带生命周期管理(mount/unmount 时订阅/退订 matchMedia),塞进 zustand selector 会让 effect 泄漏 |
| 用 `document.documentElement.dataset.theme` 而不是 body class | HTML 根级属性在 `<head>` 解析时即可被 CSS 命中,无 FOUC;且 React 不管理 DOM 属性,写数据集副作用小 |
| `high-contrast` 沿用现有映射(`SettingsDrawer.tsx:634`)→ `'auto'` | 避免改 enum 触发更广的回归;真实实现留给后续 phase |
| 不为 Light 模式引入额外的 `light.css` / `dark.css` 双文件 | 单文件 + `[data-theme]` 选择器足以覆盖 16 个变量;避免引入新构建产物 |

---

## 4. 文件改动

### 4.1 新增

| 路径 | 职责 |
|---|---|
| `packages/zai/src/web/src/hooks/useEffectiveTheme.ts` | 解析 `settingsTheme` + 订阅 `matchMedia('(prefers-color-scheme: dark)')`,返回 `'dark' \| 'light'`。`matchMedia` 不可用时降级到 `'dark'`。SSR-safe(`typeof window === 'undefined'` 早返回)。 |
| `packages/zai/src/web/src/App.test.tsx` | smoke:挂载时 `document.documentElement.dataset.theme === 'dark'`(auto + matchMedia 默认 dark);`setSettingsTheme('light')` → dataset 变 `'light'`;AntD ConfigProvider 收到的 algorithm 用 `useToken` 反查是 `defaultAlgorithm`。 |

### 4.2 修改

| 路径 | 改动 |
|---|---|
| `packages/zai/src/web/src/App.tsx` | `ConfigProvider` 改为受控:订阅 `settingsTheme` → `useEffectiveTheme()` → 计算 algorithm + token + 写 `documentElement.dataset.theme`。原 9 个深色 token 拆成 dark/light 两套常量。 |
| `packages/zai/src/web/src/index.css` | `:root { --xxx: 深色 }` → `:root { 默认(dark) }` + 新增 `:root[data-theme='light'] { --xxx: 浅色 }` 覆盖块。补 `color-scheme: light dark`。 |
| `packages/zai/src/web/src/store/useAppStore.ts` | 仅更新注释:第 67–68 行 `'Theme 仅前端暂存(SPEC 阶段 1)'` → `'Theme 仅前端暂存(SPEC 阶段 1),auto 跟随系统'`。类型/setter/default 全不动。 |
| `packages/zai/src/web/src/components/QuestionCard.tsx` | 14 处 `#fff0e2` / `#1f1f1f` / `#ff6600` → `var(--bg-card)` / `var(--text-primary)` / `var(--accent-start)`。`.question-card-scope` 内的样式继续作用域。 |
| `packages/zai/src/web/src/components/TaskDock.tsx` | ~13 处硬编码颜色 → `var(--bg-*)` / `var(--text-*)`。 |
| `packages/zai/src/web/src/components/TaskDrawer.tsx` | ~13 处硬编码颜色 → 同上。 |
| `packages/zai/src/web/src/components/MessageBubble.tsx` | ~9 处硬编码颜色 → 同上。 |

### 4.3 不改

| 路径 | 原因 |
|---|---|
| `Layout.tsx:145` `<Menu theme="dark">` | YAGNI:边栏主题联动是独立重构,见 §2.2 |
| `components/splitPane/TextEditor.tsx` 的 CodeMirror 主题 | CodeMirror 6 主题切浅色需重定义所有 token color,工作量独立 |
| `components/QuestionCard.tsx` 的 `.question-card-scope`(index.css:193-256) | 该作用域本身已按浅色设计,改用 CSS 变量后自动跟随 |
| `Agent.tsx` 第 64–67 行硬编码 `colorPrimary` 注释 | 注释内的设计依据仍然成立(ConfigProvider 默认 token.colorPrimary),不动 |

---

## 5. 数据流

### 5.1 用户手动切换

```
用户在 SettingsDrawer 选中 Light
  │
  ├─ SettingsDrawer.tsx:763 调 handleChange('theme', 'light')
  │    └─ setTheme('light') → setSettingsTheme('light')        [useAppStore.ts:228]
  │         └─ store.settingsTheme = 'light'
  │
  ├─ useEffectiveTheme() 重算(subscribed) → 返回 'light'
  │
  └─ App.tsx 重渲染:
       ├─ <ConfigProvider algorithm={defaultAlgorithm} token={lightTokens}>
       │    └─ 所有 antd 组件用浅色 algorithm + 显式浅色 token
       └─ useEffect(() => documentElement.dataset.theme = 'light')
            └─ index.css [data-theme='light'] 选择器命中
                 └─ 16 个 CSS 变量切换
                      └─ 自定义组件(var(--xxx) 引用方)同步换色
```

### 5.2 auto 模式跟随系统

```
matchMedia('(prefers-color-scheme: dark)').addEventListener('change', ...)
  │
  └─ 系统主题切换(如 macOS 深色 → 浅色)
       └─ listener 回调 → setInternalResolvedTheme(newDark)
            └─ useEffectiveTheme() 返回值变化
                 └─ App.tsx 重渲染 → dataset.theme + ConfigProvider 同步
```

### 5.3 SSR / 老浏览器

```
typeof window === 'undefined'
  → useEffectiveTheme() 直接返回 'dark'  [SSR:服务端渲染默认深色]

typeof window.matchMedia !== 'function'
  → useEffectiveTheme() 直接返回 'dark'  [旧浏览器降级]

两者都不会抛错;副作用(documentElement.dataset)只在 client 调用。
```

---

## 6. CSS 变量值(light 套)

参考 `index.css:4-21` 的 16 个变量,light 套建议初值(产品可后续微调):

| 变量 | dark(现状) | light(建议初值) |
|---|---|---|
| `--bg-body` | `#0a0a0f` | `#f8fafc` |
| `--bg-card` | `#12121a` | `#ffffff` |
| `--bg-card-hover` | `#1a1a2e` | `#f1f5f9` |
| `--bg-sidebar` | `#0d0d14` | `#f1f5f9` |
| `--bg-input` | `#1a1a2e` | `#ffffff` |
| `--border-subtle` | `rgba(255,102,0,0.15)` | `rgba(15,23,42,0.10)` |
| `--border-active` | `rgba(255,102,0,0.40)` | `rgba(255,102,0,0.50)` |
| `--text-primary` | `#f1f5f9` | `#0f172a` |
| `--text-secondary` | `#94a3b8` | `#475569` |
| `--text-tertiary` | `#64748b` | `#94a3b8` |
| `--accent-start` | `#ff6600` | `#ff6600`(主题色保持) |
| `--accent-end` | `#ff8533` | `#ff8533` |
| `--glow` | `rgba(255,102,0,0.15)` | `rgba(255,102,0,0.12)` |
| `--success` | `#22c55e` | `#16a34a` |
| `--error` | `#ef4444` | `#dc2626` |
| `--warning` | `#f59e0b` | `#d97706` |

AntD ConfigProvider light token 关键覆盖(初值建议):

| token | dark(现状) | light(初值) |
|---|---|---|
| `colorBgContainer` | `#12121a` | `#ffffff` |
| `colorBgElevated` | `#1a1a2e` | `#ffffff` |
| `colorBgLayout` | `#0a0a0f` | `#f8fafc` |
| `colorText` | `#f1f5f9` | `#0f172a` |
| `colorTextSecondary` | `#94a3b8` | `#475569` |
| `colorBorder` | `rgba(255,102,0,0.15)` | `rgba(15,23,42,0.10)` |
| `colorPrimary` | `#ff6600` | `#ff6600`(主题色不变) |
| `borderRadius` | `8` | `8`(不变) |

---

## 7. 测试

### 7.1 新增单测

**`useEffectiveTheme.test.ts`**(vitest + @testing-library/react-hooks)

| case | 输入 | 期望 |
|---|---|---|
| 1 | `settingsTheme='dark'`,任何 `matchMedia` 状态 | 返回 `'dark'` |
| 2 | `settingsTheme='light'`,任何 `matchMedia` 状态 | 返回 `'light'` |
| 3 | `settingsTheme='auto'`,`matchMedia.matches=true` | 返回 `'dark'` |
| 4 | `settingsTheme='auto'`,`matchMedia.matches=false` | 返回 `'light'` |
| 5 | `typeof window.matchMedia === 'undefined'`(mock) | 返回 `'dark'`(降级) |
| 6 | `settingsTheme='high-contrast'`,`matchMedia.matches=false` | 返回 `'light'`(沿用 `'auto'` 语义) |
| 7 | `settingsTheme='auto'`,触发 `matchMedia` change 事件 | 返回值随之更新(unmount 后 listener 清理) |

**`App.test.tsx`**(新建)

| case | 输入 | 期望 |
|---|---|---|
| 1 | 挂载,mock `matchMedia.matches=true` | `documentElement.dataset.theme === 'dark'`,ConfigProvider 收到 `theme.darkAlgorithm` |
| 2 | 挂载后调 `useAppStore.setSettingsTheme('light')` | `documentElement.dataset.theme === 'light'`,ConfigProvider 改 `theme.defaultAlgorithm` |
| 3 | 挂载,mock `matchMedia.matches=false` | `documentElement.dataset.theme === 'light'`(auto 解析) |

### 7.2 既有测试

- `SettingsDrawer.test.tsx`:不动,行为没变
- `useAppStore.test.ts`(如有):不动
- 全量 `pnpm test` 通过

### 7.3 视觉验收(手测)

| step | 期望 |
|---|---|
| 1. 启动 `pnpm --filter zai dev`,浏览器开 `http://localhost:5173` | 默认 auto + 系统深色 → 全站暗色 |
| 2. macOS 系统设置切浅色 | 页面实时跟随变白 |
| 3. Settings → Theme → Light | 锁定浅色,系统再切换不影响 |
| 4. Settings → Theme → Dark | 锁定深色 |
| 5. Settings → Theme → High contrast | 沿用旧行为:解析为 auto,跟随系统(本期不变) |
| 6. 检查 4 个收敛组件(QuestionCard / MessageBubble / TaskDock / TaskDrawer) | 切换无残留深色 / 浅色 |
| 7. 检查未收敛组件(ModeStatusButton / ModelStatusButton / BottomStatusBar) | 记录剩余 ~85 处硬编码(已知限制) |
| 8. 边栏 Menu 仍是深色 | 已知限制(本期 YAGNI) |
| 9. CodeMirror 编辑器仍是深色 | 已知限制(本期 YAGNI) |

---

## 8. 验收标准(AC)

1. ✅ 设置面板选 Light → 整个 App 立刻变白底,无需刷新
2. ✅ 默认 auto + macOS 深色模式 → 页面深色;系统切浅色 → 页面实时跟随变白
3. ✅ AntD 组件 + 4 个高优先自定义组件(QuestionCard / MessageBubble / TaskDock / TaskDrawer)颜色都切换
4. ✅ `<Layout>` 边栏 `<Menu theme="dark">` 继续是暗色(已知限制,文档化)
5. ✅ CodeMirror 编辑器继续是暗色(已知限制)
6. ✅ 现有 `SettingsDrawer.test.tsx` 与 `useAppStore` 回归测试全绿
7. ✅ 视觉烟测无白屏、无对比度 < 4.5:1 的关键文本(主标题/正文/按钮文字)
8. ✅ `useEffectiveTheme` 单测 7 个 case 全过
9. ✅ `App.test.tsx` smoke 3 个 case 全过

---

## 9. 风险与对策

| 风险 | 对策 |
|---|---|
| AntD `defaultAlgorithm` 与项目现有 `darkAlgorithm` 的 token 字段语义不完全对称(浅色 `colorBgContainer` 默认偏灰,我们要纯白) | 在 token 表里显式指定 `colorBgContainer: '#ffffff'` / `colorBgLayout: '#f8fafc'` 等覆盖值,不裸用 `defaultAlgorithm` 默认值 |
| `index.css` 30+ 处 `!important` 覆盖规则(如 `.ant-card { background: ... !important }`)在 light 模式仍输出深色 | 验证时单点补 `[data-theme='light'] .ant-card { background: var(--bg-card) !important }` |
| `documentElement.dataset.theme` 与 React render 之间产生一帧闪烁 | CSS 用 `:root[data-theme='light']` 在 `<head>` 解析时即可命中,无 FOUC;首屏渲染前在 `index.html` 提前读 localStorage 写 dataset——但本期不持久化,故接受一次首屏渲染(默认 auto + 系统通常深色 → 暗色无感知) |
| `<Menu theme="dark">` 在浅色 App 里仍输出黑底边栏 | §8 AC 4 明确接受;为后续 Sidebar 改造独立 phase |
| CodeMirror 6 主题切换需重定义所有 token | §8 AC 5 明确接受;独立 phase |
| 用户在 Setter 中选 'high-contrast' 但本期不实现 | 沿用现有 `SettingsDrawer.tsx:634` 映射 → `'auto'`,不破坏 UI 兼容 |
| matchMedia change 事件未触发(`fireEvent` 不会真改 system) | 测试用 `vi.spyOn(window, 'matchMedia').mockImplementation(...)` 控制 |

---

## 10. 后续 phase 索引

| phase | 内容 | 估算体量 |
|---|---|---|
| 2 | 持久化:`localStorage` + `PUT /api/agent/settings/theme` + 读 `~/.zai/settings.json` | 中 |
| 3 | `high-contrast` 真实实现(纯黑/纯白/加粗) | 小 |
| 4 | `<Layout>` 边栏 + `<Menu>` 主题联动 | 中 |
| 5 | CodeMirror 编辑器浅色主题 | 中 |
| 6 | 收敛剩余 ~85 处分散内联硬编码颜色 | 中 |

---

## 11. 变更日志

| 日期 | 作者 | 改动 |
|---|---|---|
| 2026-07-26 | (zai brainstorm) | 初稿 v1 |