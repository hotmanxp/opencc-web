# Task 7 Review — `BottomStatusBar` 组件

## Spec compliance

**Status: ✅ PASS**

| 项 | 要求 | 实际 | 结果 |
|---|---|---|---|
| New file path | `packages/zai/src/web/src/components/BottomStatusBar.tsx` | 命中,diff 显示 new file | ✅ |
| Export style | `export function` (named, no default) | `export function BottomStatusBar(...)` 第 13 行 | ✅ |
| Props shape | `{ todos: TodoItem[]; v2Tasks: V2TaskItem[]; label?: string }` + default `"任务"` | 命中,line 11-18 | ✅ |
| Popover attrs | `placement="topRight"` / `trigger="click"` / `arrow={false}` / `destroyTooltipOnHide` | 全部命中 line 81-84 | ✅ |
| Popover content | `<TodoDropdown todos={todos} v2Tasks={v2Tasks} />` | 命中 line 80 | ✅ |
| Trigger testid | `data-testid="bottom-status-trigger"` | 命中 line 37 | ✅ |
| Summary testid | `data-testid="bottom-status-summary"` | 命中 line 57 | ✅ |
| Caret | `CaretUpOutlined` from `@ant-design/icons` | 命中 line 7 + 73 | ✅ |
| Empty state | `<span>暂无 {label}</span>` 含 label 插值 | 命中 line 55 | ✅ |
| Color — done===total | `<span>` 走 `#52c41a` | line 58 命中 | ✅ |
| Color — in-progress | `#a78bfa` | line 62 命中 | ✅ |
| Color — open | `rgba(255,255,255,0.55)` | line 67 命中 | ✅ |
| Agent.tsx import | `import { BottomStatusBar } from "../components/BottomStatusBar";` | 命中 line 51 in new Agent.tsx | ✅ |
| Agent.tsx selector | `const v2TasksBySession = useAgentStore((s) => s.v2TasksBySession);` | 命中,紧跟 `todosBySession` 之后 | ✅ |
| Agent.tsx derived | `const v2TasksForCurrentSession: V2TaskItem[] = ...` | 命中,`todosForCurrentSession` 正下方 | ✅ |
| Agent.tsx JSX 位置 | `<BottomStatusBar>` 在 `<div className="bottom-stack">` **上方**(spec checklist 准) | 命中 diff line 184-186 | ✅ |
| Commit msg 字面 | `feat(zai-web): add BottomStatusBar above input box for merged TODO + V2 task summary` | `06e2e99` 完全一致 | ✅ |
| Scope | 仅 `BottomStatusBar.tsx`(新)+ `Agent.tsx`(改) | diff 仅列这 2 文件 | ✅ |

### 关于 brief 内部一处矛盾(已由 spec checklist 澄清)

原始 brief Step 2 第 3 条正文写的是"在 `<div className="bottom-stack">` **内部、`<AgentInputBox />` 之前**插入",但同一步的代码示例本身是 `<BottomStatusBar>` 放在 `<div className="bottom-stack">` **外侧**(兄弟节点)。本次 review spec checklist 在最上方明确要求"ABOVE `<div className="bottom-stack">`",与 brief 代码示例一致。

实现者最终落在 **ABOVE** —— 这与 spec checklist + brief 代码示例两边都对齐,与 brief 正文版指令相反。判定:**正确执行**(spec checklist 是单一真相源,代码示例与之一致)。

## Code quality

**Status: Approved**

### TypeScript

- `TodoItem` / `V2TaskItem` 从 `../store/useAgentStore.js` import,带 `.js` 后缀 —— 与 `TodoDropdown.tsx` 兄弟约定一致。✅
- Agent.tsx 里 `V2TaskItem` 加入到现有 `useAgentStore` 类型 import 块(沿用无 `.js` 的相对路径,与同文件中 `TodoItem` 写法一致),没有另开一行路径不一致的 import。✅

### Pure 派生

- `todoTotal / todoDone / todoInProgress / todoOpen / v2Total / v2Done / v2InProgress / total / done / inProgress / open` 全为纯表达式,无 `setState` / `Math.random` / `Date.now()`。✅
- V2 的 open 派生为 `v2Total - v2Done - v2InProgress`(隐含假设 V2 没有 "open/pending" 显式状态),与 brief 完全一致。✅

### Store 隔离

- `BottomStatusBar.tsx` 内部 **没有任何** `useAgentStore` / `zustand` import —— 数据完全经由 props 流入,与 `TodoDropdown` 同模式。✅
- Agent.tsx 是唯一持有 `v2TasksBySession` selector 的地方,职责单一。✅

### Comments 风格

- 沿用 TaskDock 风格的 dense 中文:
  - `// 老 TODO (会话内) 与 V2 (跨会话持久) 各自统计`
  - `// 触发器: \`N/M 任务 · K 进行中 · J 待开始\` + 向上 caret`
- JSDoc `/** 触发按钮文字，默认 "任务"。 */` 也是中文,简洁。✅

### 细节加分项

- Popover 多加了 `data-testid="bottom-status-popover"` —— brief 代码示例里有,实现者保留了。e2e 友好。✅
- `Tooltip` 包了 `{trigger}`,空态/有态提示文本做了分支(`暂无${label},点击查看历史` / `点击查看${label}详情`)—— 体验更稳,无副作用。✅
- 触发器样式放在 inline style 而非 CSS,与 brief 1:1 一致;无越界改动。✅

## Findings

| 严重度 | 数量 |
|---|---|
| Critical | 0 |
| Important | 0 |
| Minor   | 1 |

### Minor

1. **缺 EOF 换行符**(cosmetic)
   - 位置:`packages/zai/src/web/src/components/BottomStatusBar.tsx`
   - 现象:diff 末尾显示 `\ No newline at end of file`,文件最后一行的 `}` 后没有 `\n`。
   - 影响:仅 tooling(部分 lint / formatter / git blame)差异,不影响运行。
   - 建议:补一行 `echo "" >> ...` 或编辑时多按一次回车;若项目根 `.editorconfig` 设 `insert_final_newline = true`,顺手 fix 即可。

## 其他观察(非 finding,留个底)

- 任务最终把 `<BottomStatusBar>` 放在 `<div className="bottom-stack">` 外侧(兄弟),这与原 brief Step 2 正文的"内部"措辞冲突,但与 brief 同步骤的代码示例 + review checklist 完全一致。后续 brief 撰写建议统一文本与代码示例,避免歧义。本次不属于实现者责任,故不计入 finding。
- Agent.tsx 父容器上是否对 `<BottomStatusBar>` 的横向 padding/margin 有进一步约束,需要浏览器目测验证 —— 但这是 **Step 4**(浏览器目测)未做范畴,实现者已在 report 中标注 deferred;建议下一位 owner 启 dev server 时顺手验证红框视觉。本审查不阻塞。

## Verdict

**Spec compliance: ✅**
**Quality: Approved**
**Findings: 0 Critical / 0 Important / 1 Minor (EOF newline, cosmetic)**

可以合并。建议顺手补一个 trailing newline 后 squash 或 amend,无需重跑 typecheck。
