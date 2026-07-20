# TaskDrawer LLM 文本项 Markdown 渲染设计

- 日期：2026-07-16
- 范围：`packages/zai/src/web/src/components/TaskDrawer.tsx`
- 目标：后台 Agent 输出详情列表中 LLM 输出的文案使用 Markdown 渲染。

## 需求

`TaskDrawer` 时间线里 `{ kind: 'text', text }` 项（来自 `content_block_delta` 累积的 LLM 文案）当前以 `whiteSpace: 'pre-wrap'` 纯文本展示：用户看到的是一行行带 `\n` 的原始 markdown 源码，例如：

```text
# 标题
- 列表项
```python
print("hello")
```
```

需要把这些文本按 GFM 渲染成结构化 HTML：标题分级、列表缩进、围栏代码块走 Prism oneDark、行内 code 染紫罗兰色、超链接 target=_blank、表格 / 引用 / 分隔线全套支持。

**仅作用于** `{ kind: 'text' }` 项。`kind: 'tool'`、`kind: 'system'`、顶部 `detail.input.prompt`（用户原始 prompt）、`task.ended` 时设置的 `resultText`（暂未参与本次改动）全部保持现有纯文本渲染。

## 方案

单文件改动（`TaskDrawer.tsx`），纯前端，不动后端 / SSE / 数据结构：

1. 新增 imports：`ReactMarkdown`、`remarkGfm`、`Prism as SyntaxHighlighter`、`oneDark`。
2. 在文件作用域内新增 `markdownComponents` 常量，等价于 `Agent.tsx` 第 77-227 行：行内 `code` 用 `#a78bfa`（violet-400）、围栏代码块用 `oneDark` 高亮 + 背景 `#282c34`（字面复制，不跨文件 import Agent.tsx 的 `CODE_BG` 常量）、表格 / 列表 / 引用 / 标题 / 链接 / 分隔线（hr）全套。
3. 把时间线 `kind: 'text'` 分支的 `<div>{item.text}</div>`（`whiteSpace: 'pre-wrap'`）替换为 `<div><ReactMarkdown remarkPlugins={[remarkGfm]} components={markdownComponents}>{item.text}</ReactMarkdown></div>`。
4. 外层容器保留 `padding: '6px 0'` 和 `wordBreak: 'break-word'`；**去掉 `whiteSpace: 'pre-wrap'`**（markdown 的 `<p>` 间距已经由 `components.p` 的 `margin: "0 0 8px 0"` 控制，预格式化会让段落之间出现大块空白）。

不复用 `Agent.tsx` 的 `markdownComponents` 常量，避免跨文件耦合；两份等价常量独立维护。若未来需要再新增第三个使用者，再抽到 `web/src/components/markdownComponents.tsx`。

### 渲染策略：始终 Markdown，不做流式切换

与 `Agent.tsx` 不同，`TaskDrawer` 的 `buildTimeline` 把 `content_block_delta`（text_delta / thinking_delta）累积到切片点（`message_stop` / `tool_use:start` / `runtime.done` / `runtime.error`）才推出一项 `kind: 'text'`。**一个 text 项一旦 push 就不再生长**。所以：

- 不需要 `Agent.tsx` 的"流式期间 `pre-wrap`、idle 后切 markdown"策略 — 那个策略是为同一段文本持续 append 字符设计的，在 `TaskDrawer` 不适用。
- React 通过稳定的 `key="text-${ev.seq}"` 复用已挂载的 `ReactMarkdown` 子树，新项首次挂载时才跑 unified pipeline。

## 数据流与边界

- 输入：来自 `buildTimeline(events)` 的 `kind: 'text'` 项，`text` 字段已经是 LLM 累积输出。
- 输出：`<ReactMarkdown>` 渲染后的 DOM；样式由 `markdownComponents` 控制。
- **不变**：
  - `buildTimeline` 的事件聚合逻辑
  - SSE wire 格式与 server 端
  - `kind: 'tool'` / `kind: 'system'` 渲染
  - `detail.input.prompt` / `detail.resultText` 渲染
- **新行为**：
  - `kind: 'text'` 项渲染为结构化 markdown 文档
  - 容器去掉 `whiteSpace: 'pre-wrap'`
- 无新增依赖（`react-markdown` / `remark-gfm` / `react-syntax-highlighter` 已在 `packages/zai/package.json`）。

## 测试与验收

扩展 `packages/zai/src/web/src/components/TaskDrawer.test.tsx`（已用 `// @vitest-environment happy-dom`，满足 `ReactMarkdown` 的 DOM 要求）：

1. **代码块渲染**：构造含 `` ```python\nprint(1)\n``` `` 的 text 项，渲染后查询 DOM 出现 `<pre>` 与 Prism token class，行内 `` `x` `` 出现 `<code>`。
2. **列表 / 链接**：构造 `- a\n- b` 和 `[click](https://x.com)`，验证 `<ul><li>` 结构和 `<a href="https://x.com" target="_blank">`。
3. **XSS 净化回归**：构造 `<script>alert(1)</script>`，渲染后 DOM 中不应出现 `<script>` 节点（ReactMarkdown v10 默认不过 `rehype-raw`，HTML 标签被转义）。
4. **回归**：现有 `buildTimeline` / `formatToolInput` / `formatToolCallLine` 测试不变且全部通过。

**手动验收**：
- 跑一个 background agent 让其回复包含代码块、列表、表格，确认 `TaskDrawer` 视觉与 `Agent.tsx` 主对话一致。
- 截图前后对比，目测暗色调色板和字距一致。
- 检查 `whiteSpace: 'pre-wrap'` 已移除，段落间距正常。

**执行命令**：

```bash
cd packages/zai && npm test -- TaskDrawer
cd packages/zai && npm run typecheck
```

## 非目标

- 不修改后端接口或 SSE 协议。
- 不修改 `buildTimeline` 的事件聚合逻辑。
- 不修改 `detail.input.prompt`（用户原始 prompt）的渲染。
- 不修改 `resultText` 的渲染（即使它语义上是 LLM 输出）。
- 不抽出共享 `markdownComponents` 模块（YAGNI；当前仅两处使用）。
- 不提供"原始 / 渲染"切换 toggle（YAGNI）。
- 不引入 markdown 解析的 ErrorBoundary（YAGNI）。
- 不区分 `thinking_delta` 与 `text_delta` 的渲染（本次范围之外；保留 `buildTimeline` 的现状）。