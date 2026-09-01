# 任务工厂看板式任务面板设计（T12 UI 重设计）

## 背景

用户对 `/super-tasks` 页面提出三条反馈：① 页面太丑，任务应为**卡片式看板**；② 需有**总览信息**；③ 主管 Agent 对话区太大（原占 42%）。本设计是在既有任务工厂 spec（`2026-09-01-task-factory-design.md`）之上的 UI 修正，不改变后端 API、状态机、数据模型之外的展示字段。

## 目标布局

```
┌────────┬─────────────────────────────────────┐
│ 主管    │ [排队 2][执行中 1][已完成 1][失败 1⚠] │
│ 对话    │            [AI托管开] [新建任务]     │
│ ~280px  │ ┌───────────┐ ┌───────────┐ ┌─────┐ │
│ [《] 折叠│ │ 队列 (2)    │ │ 执行中 (1) │ │完成 │ │
│         │ │ ☑全选[删除] │ │ 全选[删除]  │ │  …  │ │
│         │ │ ┌卡片┐┌卡片┐│ │ ┌卡片┐     │ │ …  │ │
└────────┴─────────────────────────────────────┘
```

- **左主管边栏**：280px，可折叠（折叠后 40px 图标条，点图标恢复）。折叠状态为组件内 state，不持久化。
- **右面板**：flex:1。顶部总览行 + 三栏看板。

## 组件拆分

### 1. `TaskOverviewBar`（新建，`packages/zai/src/web/src/components/superTasks/TaskOverviewBar.tsx`）

- 四个统计卡：排队（queue 桶数）/ 执行中（processing 桶数）/ 已完成（finished 桶中 `status==='done'` 数）/ **失败**（桶中 `status==='failed'` 数，⚠ 黄/红醒目）。
- **可点击筛选**：选中某卡 → 隐藏/降透明度非该类卡片（其余卡片 opacity 0.35 + `pointer-events:none`，保持版面），卡再用点取消；处筛选态时显示「✕ 清除筛选」。筛选维度按 status 归类：queue→`queued`、processing→`processing|paused`、finished→`done`、failed→`failed`。
- 右侧：AI 托管 Switch（沿用 store.setManaged）、新建任务按钮（沿用弹窗）、loading「刷新中…」指示（沿用现有 3s 轮询的 loading 态）。
- 统计卡的数据源 = `useSuperTaskStore.buckets`（3s 轮询已有，不需新请求）。

### 2. `SuperTaskCard`（新建，`…/superTasks/SuperTaskCard.tsx`）

单任务信息卡（用户选定「信息卡·常显操作」）：

```
┌☑─────────────────────────────┐
│ 验收任务A          [排队][dsh] │  ← 标题(bold,单行截断) + 状态Tag + agent Tag
│ 在 /tmp/tf-accept/a1 创建…    │  ← 描述 2 行截断(ellipsis)
│ 📎 /tmp/tf-accept/a1          │  ← cwd 行(单行截断,等宽感)
│ 09-01 17:05        [▶] [🗑]   │  ← 创建时间 + 操作按钮(常显)
└──────────────────────────────┘
```

- 卡片整体 onClick → `setDetailId(row.id)` 打开既有详情抽屉；checkbox/按钮 onClick **stopPropagation**。
- 操作按钮按 `bucket + status`：`queue-tasks` → ▶（手工启动）；`processing-tasks + processing` → ⏸（暂停）+「验收」；`processing-tasks + paused` → ▶（继续）；其余无操作。
- 单卡 🗑 删除（Popconfirm 确认；processing 桶禁用 + Tooltip「需先暂停」，含 paused）。
- 左上角 ☑ 多选框（进入栏内所选集）。
- 描述来源见 §4。

### 3. `SuperTaskPanel` 重写（`…/superTasks/SuperTaskPanel.tsx`）

- 删除原三 Card+Table 实现，改为三栏看板（列 = 队列/执行中/已完成）。
- 栏头：标题 + 计数 + 全选 checkbox + 「删除选中 N」（Popconfirm；执行中/已完成中的状态规则：**processing 桶删除禁用**，finished/queue 桶允许——沿用 T11 路由 400 语义与 T9 面板既有判定）。
- 栏体：纵向卡片列表（flex column gap），支持溢出滚动。
- 空态：栏内「暂无任务」次级文案。
- 首载 `loading && 全空` → 保持父级已有 Spin 契约（沿用现逻辑）。
- 保留 `detailId` state + 详情抽屉渲染 + `data-detail-id` 测试锚点（挪到卡片容器）。
- 筛选态由 `TaskOverviewBar` 管理，向下传递到卡片可见性。

### 4. `SuperTasks.tsx` 布局改造

- 主管对话区从 42%/minWidth 400 → **280px 固定边栏 + 可折叠**（`collapsed` state；折叠为 40px 图标条，含「主管」竖排标签与展开按钮）。
- 右区 flex:1 承载面板；面板顶部即总览行。
- 保留主管会话引导逻辑（现有代码不动，仅布局包裹层变化）。

## 数据小改（core）

- `TaskSummary` 增加 `description?: string`：从 `index.md` **正文**（frontmatter 之后 `# <title>` 标题行下的首段非空文本，去首尾空白）解析，在 `taskFactoryFiles.ts` 的 `toSummary`/`listIn` 贯穿。
- **不动 frontmatter schema**（不加 `description:` 键，避免 esc 冒号/换行问题）；解析失败（无正文/仅标题）→ `undefined`，UI 不显示该行。
- 涉及文件：`taskFactoryFiles.ts`（类型 + 解析）、core 单测 `taskFactoryFiles.test.ts`（listTasks 含 description 断言）。改后 **build:core**。

## 测试

- `SuperTaskPanel.test.tsx` 重写（happy-dom）：
  - 三栏渲染 + 各任务标题可见；
  - 勾选卡片 checkbox → 点「删除选中」→ Popconfirm 确认 → `store.deleteTasks` 以所选 id 被调用；
  - 统计卡计数与宽度/结构断言（如 Statistic 数值文本）。
- `SuperTaskDetailDrawer.test.tsx` / `SuperTaskPanel` 回归：详情抽屉打开路径不变（卡片 onClick）。
- `SuperTasks.test.tsx`：适配窄栏布局（若其断言左栏宽度或 Table，需同步改）。
- core：`taskFactoryFiles.test.ts` 补 description 解析用例。
- 样式改动最终以 ego-browser 真实浏览器为准（AGENTS.md 规则）。

## 范围外（明确不做）

- 拖拽换列（看板 DnD）、卡片内嵌进度条、mobile 适配、看板视口宽度可拖拽调整、主管边栏宽度可调。

## 验收

实现后：`pnpm run build:core && pnpm run build:web` → 相关单测 → dev（`--app task-factory`）→ ego-browser 全流程重跑（新建→启动→执行中→暂停/继续→托管→完成→删除 + 新视觉截图）。
## 视觉配色（用户 2026-09-01 追加）

- **页面级亮色化**（仅 /super-tasks 页，不动全局主题）：根容器内联覆写 CSS 变量（`--bg-body/--bg-page=#eef2f7`、`--bg-card=#ffffff`、`--text-primary=#1f2937` 等），并嵌套 antd `ConfigProvider theme={{algorithm: defaultAlgorithm}}`，让本页 Drawer/Modal/Popconfirm 等 portal 组件用亮色 token。
- **统计卡**：排队=蓝、执行中=紫、已完成=绿、失败=红（各自 tinted 底色 + 同色系描边 + 计数同色；筛选激活态 2px 描边）。执行中紫 `#f3e8ff/#d8b4fe/#7e22ce`，已完成绿 `#e6f7ed/#86efac/#15803d`。
- **看板栏**：栏容器 `#f8fafc` + 圆角 12；栏头彩色圆点 + 同色标题（队列蓝 `#3b82f6` / 执行中紫 `#a855f7` / 已完成绿 `#22c55e`）+ 浅灰计数徽章。
- **任务卡**：白底 + `1px #e5e9f0` + 圆角 10 + 弱投影；左侧 4px 状态色条（queued `#3b82f6` / processing `#a855f7` / paused `#f59e0b` / done `#22c55e` / failed `#ef4444`）；状态 Tag processing=`purple`、done=`success`。
- **主管边栏**：白底 + `1px #e5e9f0` 右边界。
