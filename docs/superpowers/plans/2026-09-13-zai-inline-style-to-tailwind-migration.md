# zai 内联样式 → Tailwind 迁移

- **日期**: 2026-09-13
- **范围**: `packages/zai/src/web/src/**/*.{ts,tsx}`
- **预计工作量**: 1073 处 `style={{...}}` × 92 文件

---

## Context

zai 前端代码风格以 AntD 组件 + 内联 `style={{...}}` 为主,而项目已经预装 Tailwind 3.4.15(`packages/zai/tailwind.config.ts`、`postcss.config.js`、`index.css` 已就绪,只是 `@tailwind` 链路里没有实际工具类被使用)。

迁移目标:
1. 把静态、布局类、装饰类的 `style={{...}}` 转为 Tailwind utility class,减少组件树噪声。
2. 保留所有动态 / 计算 / AntD 专属样式不动 — 这部分本质上无法也不应该机械翻译。
3. 通过"改前/改后真实浏览器截图对比"确保零视觉回退。

预期收益:组件可读性提升,样式复用更便利,后续主题切换和 dark mode 调整更轻量。

---

## 决策(已与用户确认)

| 议题 | 决策 |
|---|---|
| 范围 | **仅 `style={{...}}`**;AntD 组件的 `styles={{ body: {...} }}` 不动(AntD cssinjs 优先级压 Tailwind,改写没有收益)。 |
| 动态样式 | **保留 inline**。拖拽坐标、calc/env/keyframes、事件驱动 style 改写一律不动。 |
| 测试断言 | **同步更新**。改写 inline 后,直接断言 `el.style.height` 之类的测试要改成断言 `className` 包含对应 class,或删除已无意义的断言。 |

---

## 现状数据(2026-09-13 调研)

### `style={{...}}` 分布(共 1073 处 / 92 文件)

按使用次数 top 10:

| 文件 | 次数 |
|---|---|
| `pages/Desktop.tsx` | 69 |
| `components/TaskDrawer.tsx` | 53 |
| `components/transcript/MessageBubble.tsx` | 51 |
| `components/QuestionCard.tsx` | 41 |
| `components/AgentInputBox.tsx` | 34 |
| `components/superTasks/SuperTaskDetailDrawer.tsx` | 27 |
| `components/TaskDock.tsx` | 27 |
| `components/MobileQuickDrawer.tsx` | 27 |
| `components/ModelPickerPanel.tsx` | 26 |
| `components/PluginModal/MarketplaceSourcePanel.tsx` | 11 |

按桶分类(粗估):

| 类型 | 占比 | 改写策略 |
|---|---|---|
| 静态字面量 | ~55% | 直接转 `p-6`、`flex`、`gap-1` 等 |
| CSS var | ~20% | 转 `bg-[var(--xxx)]`、`text-[var(--xxx)]` |
| 动态计算 / 模板字符串 | ~10% | **保留 inline** |
| AntD 组件 style prop | ~10% | **保留 inline**(本计划不涉及 `styles={{}}` 拆分) |
| 复杂组合(backdropFilter、writingMode、keyframes、SVG 内联) | ~5% | **保留 inline** |

### 路由与截图目标

| # | 路由 | 页面/视图 | 截图名 | 优先级 |
|---|---|---|---|---|
| 01 | `/agent` | Agent.tsx(对话页 + SplitPane) | `agent-desktop` | P0 |
| 02 | `/agent`(子区) | AgentConversation + MessageBubble 消息流 | `agent-conversation` | P0 |
| 03 | `/desktop` | Desktop.tsx(全屏办公桌面) | `desktop-fullscreen` | P0 |
| 04 | `/desktop`(子区) | Desktop Dock + 顶栏(毛玻璃) | `desktop-dock-header` | P0 |
| 05 | 全局浮层 | SettingsDrawer(任意路由唤起) | `settings-drawer` | P0 |
| 06 | `/m` | MobileAgent.tsx(移动端) | `mobile-agent` | P1 |
| 07 | `/dashboard` | Dashboard.tsx | `dashboard` | P1 |
| 08 | `/manage?tab=config` | Manage/Config Tab | `manage-config` | P1 |
| 09 | `/login` | Login.tsx | `login` | P1 |

### dev 服务端口

- **Vite**: 5173(`VITE_PORT` 可覆盖)
- **API**: 7715(默认;`ZAI_API_ORIGIN` 可覆盖)
- **绝对禁止动**: 920x(zai 正式服务)
- **起独立实例命令**: `VITE_PORT=5200 ZAI_API_ORIGIN=http://localhost:7715 pnpm --filter @zn-ai/zai dev` 或 `--port 8800` 同时换两个端口。

---

## 并行 Agent 拆分(按目录分组)

7 个并行 worker,各自负责一组目录。所有 worker 共享同一份"before 截图集"(基线一次性截完后分发)。每个 worker 改完后只截自己负责的页面。

| Worker | 负责目录/文件 | 工作量(处) | 风险等级 |
|---|---|---|---|
| **W1** | `pages/` 全部 9 个页面 + `Layout.tsx` + `MobileLayout.tsx` | ~200 | 中 |
| **W2** | `components/desktop/`(DesktopWindow、AttachmentZone、StickyNotes、TodoPanel、DesktopExplorer、NotesIcon、WallpaperUploadField、FilePreviewBody) | ~150 | **高** |
| **W3** | `components/transcript/`(MessageBubble、CollapsedMessageBubble、MessageListView、ToolGroupCard) | ~120 | **高**(含 keyframes) |
| **W4** | `components/superTasks/`(9 个文件,主要是 Drawer/Modal) | ~150 | 中 |
| **W5** | `components/pluginModal/` + `components/splitPane/`(文件浏览器、SplitPane、TextEditor、languageIcons) | ~130 | 中 |
| **W6** | 根级通用组件:`TaskDrawer`、`SettingsDrawer`、`AgentInputBox`、`QuestionCard`、`TaskDock`、`ModelPickerPanel`、`MobileQuickDrawer`、`MobileSessionDrawer`、`ApproveDrawer` | ~280 | **高** |
| **W7** | 根级其他组件 + `components/common/` + `components/markdown/` + `components/toolRenderers/` | ~80 | 低 |

每个 worker 必须遵循:
1. 拿到"before 截图集"路径(从 `screenshots/before/`)。
2. 改前先核对截图,理解当前视觉。
3. 改写时:静态字面量 / CSS var 直接转;动态 / AntD / 复杂组合保留 inline。
4. 改完后截自己负责的页面到 `screenshots/after/<worker-id>/`,**逐张与 before 对比**,任何肉眼可见差异视为回归。
5. 同步更新对应测试断言(见下)。
6. PR 描述里贴 before/after 截图链接,便于 review。

---

## 实施流程(分 5 阶段)

### 阶段 0: 基线(0.5h)

1. **起独立 dev 服务**(不抢占 920x)。
   ```bash
   # 先 lsof 确认空闲
   lsof -i :5200 ; lsof -i :8800
   # 起服务
   VITE_PORT=5200 pnpm --filter @zn-ai/zai dev -- --api-port 8800
   ```
2. **截 9 张 before 截图**,存到 `docs/superpowers/plans/2026-09-13-zai-inline-style-to-tailwind/screenshots/before/`。
   - 走 `/ego-browser` skill(ego-browser 在 zai dev 跑着时可用,AGENTS.md 第 50 行)。
   - 桌面:1280×800;移动(`/m`):iPhone 12 视口 390×844。
   - 截全页(包含滚动后内容),不要只截视口。
   - **重要**:截 before 前,所有 worker 应已对齐"什么是肉眼可见差异"(像素阈值 1px / 颜色差异 < 3 RGB)。

### 阶段 1-7: 并行改写(每个 worker 独立)

每个 worker 启动后:
1. read 自己负责文件列表(从 plan 拿)
2. 在自己的 worktree / 分支上工作(避免互相踩)
3. 改写时遵守"决策"段落的三条规则
4. 改完自己截 after 截图,做对比,任何差异修复或标注
5. 同步更新测试

### 阶段 8: 测试同步更新

每个 worker 改写后,跑自己文件对应测试:
```bash
pnpm --filter @zn-ai/zai test <path/to/file.test.tsx>
```

改写规则:
- `expect(tree.style.height).toBe('calc(100vh - 140px)')` → 改为 `expect(tree).toHaveClass('h-[calc(100vh-140px)]')` 或直接断言 `getComputedStyle` 后保留。
- `expect(el.style.opacity).toBe('0.7')` → 改为 `expect(el).toHaveClass('opacity-70')`。
- `expect(greenSpan?.style.color === '#52c41a')` → 改为 `expect(greenSpan).toHaveClass('text-[#52c41a]')`。
- happy-dom 不解析 Tailwind class,所以**优先断言 className 字符串**,而不是 `getComputedStyle`。
- AGENTS.md 明令样式改动不跑单测作门禁 — 但代码层面这些断言不更新会让 `pnpm test` 持续红,影响 CI。**更新断言是 CI 卫生,不是样式验证**。

涉及测试文件(13+,已知):
- `splitPane/FsTab.test.tsx`(75, 578-580, 1348, 1372, 1377, 1392, 1406-1422, 1469, 1493)
- `BottomStatusBar.test.tsx:64`
- `markdown/MarkdownText.test.tsx:20`
- `TaskDrawer.test.tsx:184`
- `AgentInputBox.test.tsx:407`
- `desktop/StickyNotes.test.tsx:69,73,76`
- `desktop/TodoPanel.test.tsx:14`
- `transcript/MessageBubble.test.tsx:342`
- `superTasks/QuickCreateModal.test.tsx:224-242,288`
- `superTasks/SuperTaskPanel.test.tsx:72,73,76`
- `superTasks/NewSuperTaskModal.test.tsx:237`
- `superTasks/SuperTaskDetailDrawer.test.tsx:279,297`
- `components/ConversationInfoButton.test.tsx:50`

### 阶段 9: 整体回归(每个 worker 完成后集中)

1. `pnpm -r test` 跑全量(只在 CI / 合并前,不要日常跑 — AGENTS.md 第 80 行)。
2. 各 worker 的 before/after 截图对比过 review。
3. 跨 worker 影响检查:W6 改 SettingsDrawer 可能影响 W1 的 Agent 页浮层唤起 — 视觉一致性由 after 截图兜底。

### 阶段 10: PR 合并

每个 worker 一个 PR,合并顺序:
- W7(低风险)→ W1 → W4 → W5 → W6 → W2 → W3(高风险最后)
- 每个 PR 必须:截图对比、测试通过、`pnpm typecheck` 通过。

---

## 验证标准(ego-browser 真实浏览器)

每个 worker 改完自己页面后,**必须**用 `/ego-browser` skill 走真实路径验证:

```
1. 打开 http://localhost:5200/<route>
2. 等待 hydration
3. 截全页截图 → screenshots/after/<worker-id>/<page-name>.png
4. 用 getBoundingClientRect / getComputedStyle 抽 5-10 个关键元素的像素级证据
   (padding / margin / width / height / color / background)
5. 与 before 对比,差值 = 0 或 ≤1px (亚像素舍入)即通过
```

具体页面验证点(给 worker 模板):
- `/agent`:会话侧栏 140px / 40px 切换、SplitPane 拖拽 50/50 分割、消息卡 max-width、输入框 padding
- `/desktop`:窗口拖拽后位置 / 大小、Dock 毛玻璃、图标网格 84px 间距、便签 z-index
- SettingsDrawer:键盘导航行高 28px / padding 0 12px、toggle 圆点 14px、Drawer body padding 16px
- `/m`:底部安全区 padding、移动端输入框高度 44px

差异超出阈值 → 立即修复,不能带病提交。

---

## 关键文件清单(改写时优先级)

### P0(高频 + 高风险)
- `packages/zai/src/web/src/pages/Desktop.tsx`(69)
- `packages/zai/src/web/src/components/TaskDrawer.tsx`(53)
- `packages/zai/src/web/src/components/transcript/MessageBubble.tsx`(51)
- `packages/zai/src/web/src/components/QuestionCard.tsx`(41)
- `packages/zai/src/web/src/components/AgentInputBox.tsx`(34)

### P1(中频 + 中风险)
- `packages/zai/src/web/src/components/superTasks/SuperTaskDetailDrawer.tsx`(27)
- `packages/zai/src/web/src/components/TaskDock.tsx`(27)
- `packages/zai/src/web/src/components/MobileQuickDrawer.tsx`(27)
- `packages/zai/src/web/src/components/ModelPickerPanel.tsx`(26)

### P2(低频 / 稳定)
- 其余 82 文件,合计 ~667 处

---

## 风险与回滚

| 风险 | 缓解 |
|---|---|
| AntD cssinjs 优先级压 Tailwind | 改前/改后截图对比作为唯一门禁;若视觉变化,回滚该处 |
| Tailwind content 扫描未覆盖 | `tailwind.config.ts` 已扫 `src/web/src/**/*.{ts,tsx}`,新增文件自动覆盖 |
| AntD 主题切换后颜色变量失效 | 颜色类全用 `text-[var(--xxx)]` / `bg-[var(--xxx)]`,不写死 hex |
| 拖拽坐标失效 | 保留 `style={{ left: b.x, top: b.y }}`,只在静态部分转 class |
| 测试断言漏改导致 CI 红 | 每个 worker 跑自己对应测试,确认绿后再 commit |
| Worker 互相影响 | 分支隔离(每个 worker 单独分支,合并顺序见阶段 10) |

回滚策略:每个 worker 一个独立分支 + 一个独立 PR;任何 worker 视觉回归直接 revert PR,不影响其他 worker。

---

## 已知不动的样式(显式列出,避免重复提问)

1. **`styles={{ body: {...} }}`** — AntD 组件专属,本计划不涉及。
2. **`style={{ left: b.x, top: b.y, width: b.w, height: b.h }}`** — 拖拽浮窗坐标,DesktopWindow.tsx 等。
3. **`style={{ height: 'calc(100vh - Npx)' }}`** — 视口动态计算。
4. **`style={{ paddingBottom: 'env(safe-area-inset-bottom)' }}`** — 移动端安全区。
5. **`onMouseEnter={(e) => e.currentTarget.style.background = ...}`** — 事件驱动直接改 DOM。
6. **MessageBubble.tsx 的 `<style>{`@keyframes ...`}</style>`** — 动态注入 keyframes。
7. **`style={{ writingMode: 'vertical-rl' }}`** — 无 Tailwind 等价。
8. **`style={{ backdropFilter: 'blur(...)' }}`** — Tailwind 有 `backdrop-blur-*`,但 `blur(18px) saturate(1.4)` 组合用 arbitrary value `backdrop-blur-[18px] backdrop-saturate-[1.4]` 表达,改写时需谨慎。
9. **SVG `<rect fill="..." />` 内联样式** — 不在 `style={{}}` 范围,但若碰到保留。

---

## 实施完成标志(Definition of Done)

1. ✅ 92 文件全部过一遍,1073 处已 review(转 / 保留 / 标注)。
2. ✅ 9 张 before 截图 + 9 张 after 截图对比通过(像素阈值 1px)。
3. ✅ 13+ 测试文件断言已更新,`pnpm --filter @zn-ai/zai test` 全绿(单文件粒度)。
4. ✅ `pnpm -r exec tsc --noEmit` 通过。
5. ✅ 各 worker PR 合并到 main,git 历史清晰。
6. ✅ `pnpm run build:web` 通过(确认 Tailwind 编译产物无错)。
