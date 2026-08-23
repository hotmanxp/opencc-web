# zai Web 端 aria-label 强制实施设计

**日期：** 2026-08-23
**状态：** 已确认，待实施

## 背景

zai Web 前端（`packages/zai/src/web/src/`，134 个 `.tsx`）使用 React 18 + AntD 5.22 + Tailwind 构建本地管理界面。当前**部分**交互元素（`Button` / `a` / `button` / `input` / `select` / `Switch` 等）缺少 `aria-label` 等可访问名（accessible name），屏幕阅读器（VoiceOver / NVDA / JAWS）读不出元素用途，键盘 / 辅助技术用户无法有效操作。

抽样统计：当前共 46 处 `aria-label`，估算 ~215 处交互元素仍缺；分布在 12 个 pages 与 53+ 个 components。

屏幕阅读器依赖以下三种可访问名来源（优先级）：

1. `aria-labelledby` 引用的可见文本
2. `aria-label`
3. 可见文本内容（children / label prop）

本设计目标：

- **一次性补全**：对所有缺可访问名的交互元素补 `aria-label`（中文硬编码，与现有文案保持一致）
- **永久强制**：写静态审计脚本 `scripts/verify-web-aria-labels.mjs`，挂入 zai `typecheck` 链路，新组件提交即校验
- **文档化**：AGENTS.md 新增「UI 页面规范」章节，把豁免规则与文案约定写明

## 范围

### 第一版覆盖

- `packages/zai/src/web/src/pages/**` 与 `components/**` 下所有 `.tsx`
- 包含路由可达页面：`/agent`、`/m`（移动端）、`/instances`、`/login`、`/config`、`/tools`、`/manage`、`/dashboard`、`/resources`、`/directory`
- 一次性补全 + 审计脚本 + AGENTS.md 规则

### 不在范围（明确剔除）

- `<img alt>` 全量审计：图片 alt 不在「交互元素」范围，留待后续 a11y 专项
- `<table>` 标题 / `<th scope>`：表格语义不在本批
- `role` 显式重写（除非 React 渲染出的元素语义不符）
- color contrast / 焦点环可见性：axe-core 等运行时审计留待后续
- Wrapper 组件抽象（`<AccessibleButton>`）：是大范围重构，单独 spec

## 已确认的取舍

| 决策点 | 结论 | 理由 |
|--------|------|------|
| 范围 | 所有交互元素（`Button` / `a` / `button` / `input` / `select` / `textarea` / `Switch` / `Tooltip` 触发器等） | 用户明确要求；与 WCAG 2.1 AA 主流要求一致 |
| 豁免 | ① 含可见文本 children 的 `<Button>文字</Button>` / `<a>文字</a>`；② `<Form.Item label>` 包裹的表单控件（AntD 自动 `htmlFor`） | 与屏幕阅读器算法一致；不强制重复 |
| 强制机制 | AGENTS.md 规则 + 代码评审 + 静态审计脚本 | 不引入新依赖（eslint-plugin-jsx-a11y 之类）；与本仓 `verify-server-types-self-contained.mjs` 同模式 |
| 文案语言 | 中文硬编码 | 仓库无 i18n 库（已 grep `react-i18next` / `react-intl` 均无结果），与现有 `aria-label="命令/技能列表"` 等 46 处保持一致 |
| 装饰图标 | AntD `<Icon>` 已被父级 `aria-label` 包含时无需处理；独立 `<Star />` 等纯装饰加 `aria-hidden="true"` | AntD 图标组件本身已带 `aria-hidden`；只在未带时补 |
| 验证方式 | 仅静态审计脚本（不引入 axe-core、不走 ego-browser 视觉） | ego-browser 偏视觉不深入 a11y；axe-core 是新依赖且范围超出本批；静态脚本足够兜底 |

## 分层

```
packages/zai/src/web/src/pages/**/*.tsx         ← 一次性补 aria-label(本 spec 实施期)
packages/zai/src/web/src/components/**/*.tsx     ← 一次性补 aria-label(本 spec 实施期)
        ↓
scripts/verify-web-aria-labels.mjs               ← 新增:静态审计(JSX AST + 豁免表)
        ↓
packages/zai/package.json scripts.typecheck      ← 末尾追加:node ../../scripts/verify-web-aria-labels.mjs
        ↓
AGENTS.md "UI 页面规范(可访问性 · 强制)" 章节    ← 新增:规则 + 豁免 + 文案约定 + 验证命令
```

复用的工具：

- `@babel/parser` + `@babel/traverse`：JSX AST 解析（仓库 Vitest 已带 `@babel/parser` 依赖；`@babel/traverse` 需新增 devDependency）
- 现有 AGENTS.md「强制开发规则」段格式

## 豁免细则（决策表）

| 元素类型 | 需要 aria-label? | 豁免条件 |
|---------|----------------|---------|
| `<Button>` AntD | 必须 | **children 含 ≥1 个非空白字符** → 豁免 |
| `<Button icon={X}>文字</Button>` | 必须 | 同上（文字 children 已存在） |
| `<Button icon={X}>` 纯图标 | 必须 | **不能**豁免（children 仅为 icon，无文本） |
| 原生 `<a>` / `<button>` | 必须 | children 含可见文本时豁免 |
| 裸 `<input type="text\|number\|...">` | 必须 | — |
| `<Form.Item label="...">` 内 input / select / textarea | 豁免 | AntD 自动 `htmlFor` 关联 |
| 裸 `<Select>` / `<Switch>` / `<Input.TextArea>` / `<Slider>` | 必须 | — |
| `<Tooltip title="...">` 包裹的触发元素 | 必须 | `title` 不视作可访问名，**不能**豁免 |
| `<Popconfirm>` 触发元素 | 必须 | 同 Tooltip |
| `<Modal>` / `<Drawer>` 标题 | 视情况 | 含 `title` prop 且非空 → 豁免（AntD 自动 aria-labelledby 指向标题元素）；`title` 为空 / 缺 → 必须 `aria-label` |
| `<Tabs.TabPane tab="...">` / `<Tabs items=[{ label }]>` | 豁免 | `tab` / `item.label` 已经是可访问名 |
| 纯装饰 `<Icon />` / `<span>`（无 onClick） | 不必须 | 父元素已含 aria-label 时 AntD Icon 自动 `aria-hidden`；独立使用建议 `aria-hidden="true"` |

**算法（审计脚本核心判断）：**

```
对每个 JSXElement(openingElement.name 是交互元素清单):
  1. openingElement.attributes 含 aria-label / aria-labelledby → PASS
  2. children 中任意 JSXText 节点 .value.trim().length >= 1 → PASS（豁免）
  3. openingElement 是 Form.Item 且 attributes.label 存在且子节点含 input/select/textarea → PASS（豁免）
  4. openingElement 是 Modal/Drawer 且 attributes.title 非空 → PASS（豁免，AntD 自动 aria-labelledby）
  5. 其他 → FAIL，输出 行号 + 元素名 + 建议文案
```

## 审计脚本设计

### 文件

`scripts/verify-web-aria-labels.mjs`（仓库根 `scripts/` 下，与 `release.mjs` / `kill-switch-drill.sh` 同级）

### 依赖

- `@babel/parser`（已有，无需新增）
- `@babel/traverse`（新增 devDependency，加在根 `package.json`）
- `glob`（新增 devDependency，或用 Node 22+ 内置 `fs.globSync` —— 优先用 Node 22+ 内置，避免新增依赖）

### 流程

1. 扫描 `packages/zai/src/web/src/{pages,components}/**/*.tsx`
2. 对每个文件 `@babel/parser.parse(src, { sourceType: 'module', plugins: ['jsx', 'typescript'] })`
3. `@babel/traverse` 遍历 `JSXOpeningElement`：
   - `name.name` 命中交互元素清单（白名单：`Button`、`a`、`button`、`input`、`select`、`textarea`、`Switch`、`Slider`、`Checkbox`、`Radio`、`Modal`、`Drawer`、`Popconfirm`、`Tooltip`）
   - **不**入白名单的容器组件：`Tabs` / `Upload` / `Form` —— 这些组件本身不直接产生可交互元素，其子节点（`Button` / `input`）受审计
   - AntD 子组件命名空间：`JSXMemberExpression`（如 `Button.Group`、`Modal.confirm`、`Form.Item`）单独走通配：点分路径任意一段命中白名单即纳入
   - 注意：`SettingsButton` / `PluginButton` / `ConversationInfoButton` 等项目内 wrapper 组件**不在白名单**，其内部已包 AntD `Button`（该 `Button` 本身受审计），wrapper 不重复审计
4. 对每个命中元素跑豁免算法
5. 违规列表为空 → 输出 `✓ all <N> elements pass`，退出码 0
6. 有违规 → 输出 `✗ <file>:<line> <ElementName> 缺少 aria-label`（每条一行），退出码 1

### 接入

`packages/zai/package.json` `scripts.typecheck` 末尾追加：

```diff
- "typecheck": "tsc -b --noEmit"
+ "typecheck": "tsc -b --noEmit && node ../../scripts/verify-web-aria-labels.mjs"
```

跨 workspace 路径相对 `packages/zai/`：`../../scripts/verify-web-aria-labels.mjs`。

### 误报抑制

- `<input type="hidden">` 跳过
- `<button type="submit">` 含 `form` 属性（HTML5 form attribute）—— 太复杂，本批跳过，按「原生 button 一律要 label」处理
- `disabled` 元素 —— 仍校验（屏幕阅读器仍可读），不豁免

## AGENTS.md 新增章节（草稿）

插入位置：`## 强制开发规则` 段之后、`## 常用验证命令` 段之前，独立新段。

````markdown
## UI 页面规范(可访问性 · 强制)

**适用范围**:所有 `packages/zai/src/web/src/pages/**` 与 `components/**` 下的 `.tsx`。

### 强制规则

所有交互元素必须提供可访问名(accessible name),优先级:

1. `aria-label="..."`(中文硬编码,与现有文案保持一致)
2. `aria-labelledby="..."`(引用现有可见文字的 id)
3. 可见文本 children(豁免条件,见下)

### 豁免条件(满足其一即可)

- 元素含可见文本 children(例:`<Button>提交</Button>` / `<a>删除</a>`)
- `<Form.Item label="...">` 包裹的 input / select / textarea(AntD 自动 `htmlFor` 关联)

### 必须 aria-label 的元素清单

- 纯图标 `<Button icon={X}>`(无文字 children)
- 原生 `<a>` / `<button>`
- 裸 `<input type="text|number|...">`(未包 Form.Item)
- 裸 `<Select>` / `<Switch>` / `<Input.TextArea>` / `<Slider>` / `<Checkbox>` / `<Radio>`
- `<Tooltip>` / `<Popconfirm>` 包裹的触发元素(`title` 不算可访问名)
- `<Modal>` / `<Drawer>` `title` 为空或缺省时(有 title 时 AntD 自动 aria-labelledby,豁免)

### 文案约定

- 中文为主,与页面现有文案语气一致
- 动词 + 名词(如「删除会话」、「新建草稿」)优于模糊词(如「按钮」、「操作」)
- 禁止「点击这里」、「更多」这类无意义标签

### 验证

```bash
node scripts/verify-web-aria-labels.mjs          # 单跑
pnpm --filter @zn-ai/zai typecheck               # 自动含此检查(typecheck 末尾追加)
```

新组件提交前必须跑过 audit,违规会 fail loud(退出码 1)。详细豁免算法与元素白名单见 `docs/superpowers/specs/2026-08-23-zai-web-aria-label-enforcement-design.md`。
````

## 验证

### 本 spec 完成后(一次性补全阶段)

```bash
# 跑静态审计,确认零违规
node scripts/verify-web-aria-labels.mjs
# 预期输出: ✓ all <N> elements pass

# 跑 zai 单测,确认没改坏组件行为
pnpm --filter @zn-ai/zai test src/web/src/
```

### 长期(规则强制阶段)

```bash
# CI / 提交前
pnpm --filter @zn-ai/zai typecheck
# 含 tsc -b --noEmit + verify-web-aria-labels.mjs
# 任意阶段 fail 即拦截
```

### 视觉 / 屏幕阅读器走查(可选,本 spec 不强制)

- 用 `/ego-browser` skill 启动 zai dev,逐路由点击交互元素,确认 button tooltip 与视觉一致(非 a11y 强校验,只是 sanity check)
- 屏幕阅读器实际测试(VoiceOver / NVDA)留给后续 axe-core 专项

## 风险与回退

| 风险 | 触发条件 | 回退方案 |
|------|---------|---------|
| 审计脚本误报(AntD 子组件命名空间识别漏) | 第一版实施期 | 在白名单加 `Button.Group` 等命名空间;白名单抽到独立常量便于扩展 |
| 中文硬编码 label 与未来 i18n 冲突 | 项目决定引入 i18n 时 | 把 `aria-label="删除会话"` 替换为 `aria-label={t('session.delete')}`;脚本豁免判断不变(只关心「有没有」,不关心值) |
| 一次性 diff 过大(~215 行)review 难 | PR review 阶段 | 按组件目录分批提交;每个 components/*.tsx 独立 commit |
| `<Form.Item label>` 嵌套解析误判 | 复杂嵌套场景 | 只判断一层 Form.Item 包裹;多层不豁免(强制要求内层 input 自带 aria-label) |

## 不在范围(明确剔除)

- axe-core 集成 Vitest 跑全页扫描(运行时 a11y 校验)
- `<img alt>` / `<table>` 语义 / 焦点环可见性 / color contrast
- Wrapper 组件抽象(`<AccessibleButton>` 等)
- 屏幕阅读器实际走查(VoiceOver / NVDA)
- i18n 化 aria-label(本批硬编码,后续 i18n 引入时改)
- 已存在但语义错的 aria-label(例如 `aria-label="按钮"`)审计 —— 第二轮再处理

## 实施预估

- 一次性补全：~215 处 × 平均 30 秒一处 ≈ 2 小时
- 审计脚本：~150 行 JS,1.5 小时
- AGENTS.md 新增：~50 行 Markdown,15 分钟
- 联调与 typecheck 接入：30 分钟
- **总计约 4 小时**

实施期分批建议：

1. 先写审计脚本 + 跑通(可标红全部违规),建立 baseline
2. 按 `pages/` 目录逐文件补(每文件一 commit,易 review)
3. `components/` 目录按子目录分批(`Layout.tsx` / `*Drawer.tsx` / `*Button.tsx` ...)
4. 最后跑 `pnpm --filter @zn-ai/zai typecheck` 全绿
5. AGENTS.md 新章节合并到首个合入 commit 之后