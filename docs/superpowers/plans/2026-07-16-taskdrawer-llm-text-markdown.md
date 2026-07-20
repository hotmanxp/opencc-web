# TaskDrawer LLM 文本项 Markdown 渲染实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把 `TaskDrawer` 时间线中 `kind: 'text'` 项从 `whiteSpace: pre-wrap` 纯文本升级为 GFM markdown 渲染，复用 `Agent.tsx` 的 `markdownComponents` 视觉。

**Architecture:** 单文件改动（`TaskDrawer.tsx`）。新增 4 个 import（`ReactMarkdown` / `remarkGfm` / `Prism` / `oneDark`），在文件作用域内新增 `markdownComponents` 常量（与 `Agent.tsx` 第 77-227 行等价，字面复制，不跨文件 import），把 `kind: 'text'` 分支替换为 `<ReactMarkdown remarkPlugins={[remarkGfm]} components={markdownComponents}>{item.text}</ReactMarkdown>`，并去掉外层容器的 `whiteSpace: 'pre-wrap'`。始终 markdown 渲染，不做流式切换（TaskDrawer 中一个 text 项 push 后即 freeze）。

**Tech Stack:** React 18、`react-markdown@^10.1.0`、`remark-gfm@^4.0.1`、`react-syntax-highlighter@^16.1.1`（Prism + oneDark）、Vitest + happy-dom。

## Global Constraints

- 单文件改动：`packages/zai/src/web/src/components/TaskDrawer.tsx`；测试文件：`packages/zai/src/web/src/components/TaskDrawer.test.tsx`
- 不修改后端接口 / SSE wire / `buildTimeline` 聚合逻辑
- 不修改 `kind: 'tool'` / `kind: 'system'` / `detail.input.prompt` / `resultText` 渲染
- 不抽出共享 `markdownComponents` 模块（YAGNI）
- 不提供 markdown / 原始切换 toggle（YAGNI）
- 不引入 markdown 解析 ErrorBoundary（YAGNI）
- 不区分 `thinking_delta` 与 `text_delta`（保持 `buildTimeline` 现状）
- commit message 格式：`HRMSV3-ZN-WEBSITE#668 <type>(<scope>): <描述>`
- 测试与 typecheck 命令：
  - `cd packages/zai && npm test -- TaskDrawer`
  - `cd packages/zai && npm run typecheck`

---

## File Structure

| File | Role | Change |
|---|---|---|
| `packages/zai/src/web/src/components/TaskDrawer.tsx` | 后台 Agent 详情抽屉 | 新增 imports / `markdownComponents` / `MarkdownText` / 替换 `kind: 'text'` 分支 |
| `packages/zai/src/web/src/components/TaskDrawer.test.tsx` | 时间线纯逻辑测试（happy-dom） | 新增 markdown 渲染 / XSS 净化测试用例 |

---

## Task 1: 渲染 markdown 代码块 + 行内 code

**Files:**
- Modify: `packages/zai/src/web/src/components/TaskDrawer.tsx:1-15`（imports 区域）
- Modify: `packages/zai/src/web/src/components/TaskDrawer.tsx:145`（在 `TOOL_STATUS_LABEL` 之后插入 `markdownComponents` + `MarkdownText`）
- Modify: `packages/zai/src/web/src/components/TaskDrawer.tsx:468-484`（timeline `kind: 'text'` 分支）
- Modify: `packages/zai/src/web/src/components/TaskDrawer.test.tsx`（追加 describe 块）

**Interfaces:**
- Consumes: 现有的 `buildTimeline(events)` 产出的 `{ kind: 'text', key: string, text: string }`
- Produces: 导出 `MarkdownText({ text: string })` 组件，渲染 `<pre>`（围栏代码块）+ `<code>`（行内）

- [ ] **Step 1: 写失败测试 — 围栏代码块渲染为 `<pre>`，行内 code 渲染为 `<code>`**

在 `packages/zai/src/web/src/components/TaskDrawer.test.tsx` 末尾追加：

```tsx
import { render } from '@testing-library/react'
import { MarkdownText } from './TaskDrawer.js'

describe('MarkdownText (kind="text" 渲染器)', () => {
  test('围栏代码块渲染为 <pre>，行内 code 渲染为 <code>', () => {
    const text = '```python\nprint(1)\n``` 和行内 `x`'
    const { container } = render(<MarkdownText text={text} />)
    expect(container.querySelector('pre')).toBeTruthy()
    expect(container.querySelector('code')).toBeTruthy()
  })
})
```

为什么测 `MarkdownText` 而不是 `TaskDrawer`：`TaskDrawer` 内部通过 SSE 拉取事件，单元测试无法注入 events；`MarkdownText` 是纯渲染组件，直接 `text` 入参，测试隔离最干净。

- [ ] **Step 2: 跑测试确认失败（缺少 `MarkdownText` 导出）**

```bash
cd packages/zai && npm test -- TaskDrawer.test.tsx
```

预期：FAIL — `'MarkdownText' is not exported from './TaskDrawer.js'`（或 `MarkdownText is not defined`）。

- [ ] **Step 3: 引入依赖 + 实现 `markdownComponents` 常量 + 导出 `MarkdownText`**

修改 `packages/zai/src/web/src/components/TaskDrawer.tsx`：

1. 在 imports 区域（约 1-15 行）追加：

```tsx
import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { Prism as SyntaxHighlighter } from 'react-syntax-highlighter'
import { oneDark } from 'react-syntax-highlighter/dist/esm/styles/prism'
```

2. 在 `buildTimeline` 之前（约 145 行附近，紧跟 `TOOL_STATUS_LABEL` 之后）追加 `markdownComponents` 常量与 `MarkdownText` 导出：

```tsx
const CODE_BG = '#282c34'
const CODE_FONT_FAMILY =
  'ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace'

// 与 Agent.tsx 第 77-227 行等价。字面复制,不跨文件 import Agent 的 CODE_BG/CODE_FONT_FAMILY,
// 避免跨文件耦合。后续如出现第三个使用者再抽到 web/src/components/markdownComponents.tsx。
const markdownComponents = {
  p: ({ children }: any) => <p style={{ margin: '0 0 8px 0' }}>{children}</p>,
  h1: ({ children }: any) => (
    <h1 style={{ fontSize: 20, fontWeight: 600, margin: '12px 0 8px 0' }}>{children}</h1>
  ),
  h2: ({ children }: any) => (
    <h2 style={{ fontSize: 18, fontWeight: 600, margin: '12px 0 8px 0' }}>{children}</h2>
  ),
  h3: ({ children }: any) => (
    <h3 style={{ fontSize: 16, fontWeight: 600, margin: '10px 0 6px 0' }}>{children}</h3>
  ),
  h4: ({ children }: any) => (
    <h4 style={{ fontSize: 14, fontWeight: 600, margin: '8px 0 4px 0' }}>{children}</h4>
  ),
  ul: ({ children }: any) => (
    <ul style={{ margin: '0 0 8px 0', paddingLeft: 20 }}>{children}</ul>
  ),
  ol: ({ children }: any) => (
    <ol style={{ margin: '0 0 8px 0', paddingLeft: 20 }}>{children}</ol>
  ),
  li: ({ children }: any) => <li style={{ marginBottom: 4 }}>{children}</li>,
  code: ({ className, children }: any) => {
    const match = /language-(\w+)/.exec(className || '')
    if (!match) {
      return (
        <code
          style={{
            background: 'transparent',
            color: '#a78bfa',
            padding: '1px 6px',
            borderRadius: 3,
            fontSize: '0.9em',
            fontFamily: CODE_FONT_FAMILY,
            fontWeight: 500,
          }}
        >
          {children}
        </code>
      )
    }
    return (
      <SyntaxHighlighter
        language={match[1]}
        style={oneDark}
        customStyle={{
          margin: '6px 0 10px 0',
          padding: '12px 14px',
          borderRadius: 6,
          fontSize: 12,
          lineHeight: 1.55,
          background: CODE_BG,
        }}
        codeTagProps={{ style: { fontFamily: CODE_FONT_FAMILY } }}
        wrapLongLines={false}
        showLineNumbers={false}
      >
        {String(children).replace(/\n$/, '')}
      </SyntaxHighlighter>
    )
  },
  pre: ({ children }: any) => <>{children}</>,
  table: ({ children }: any) => (
    <table style={{ borderCollapse: 'collapse', margin: '4px 0 8px 0', fontSize: 13, width: '100%' }}>
      {children}
    </table>
  ),
  thead: ({ children }: any) => (
    <thead style={{ background: 'rgba(255,255,255,0.05)' }}>{children}</thead>
  ),
  tbody: ({ children }: any) => <tbody>{children}</tbody>,
  tr: ({ children }: any) => (
    <tr style={{ borderBottom: '1px solid rgba(255,255,255,0.08)' }}>{children}</tr>
  ),
  th: ({ children }: any) => (
    <th
      style={{
        padding: '6px 10px',
        textAlign: 'left',
        fontWeight: 600,
        border: '1px solid rgba(255,255,255,0.08)',
      }}
    >
      {children}
    </th>
  ),
  td: ({ children }: any) => (
    <td style={{ padding: '6px 10px', border: '1px solid rgba(255,255,255,0.08)' }}>{children}</td>
  ),
  blockquote: ({ children }: any) => (
    <blockquote
      style={{
        borderLeft: '3px solid rgba(255,255,255,0.2)',
        paddingLeft: 12,
        margin: '4px 0 8px 0',
        color: 'rgba(255,255,255,0.7)',
      }}
    >
      {children}
    </blockquote>
  ),
  a: ({ href, children }: any) => (
    <a
      href={href}
      target="_blank"
      rel="noopener noreferrer"
      style={{ color: '#1677ff', textDecoration: 'underline' }}
    >
      {children}
    </a>
  ),
  hr: () => (
    <hr
      style={{
        border: 'none',
        borderTop: '1px solid rgba(255,255,255,0.08)',
        margin: '12px 0',
      }}
    />
  ),
}

export function MarkdownText({ text }: { text: string }) {
  return (
    <ReactMarkdown remarkPlugins={[remarkGfm]} components={markdownComponents}>
      {text}
    </ReactMarkdown>
  )
}
```

- [ ] **Step 4: 跑测试确认通过（仅 `MarkdownText` 测试）**

```bash
cd packages/zai && npm test -- TaskDrawer.test.tsx
```

预期：PASS — 新加的 `MarkdownText` describe 块通过；已有 `formatToolInput` / `formatToolCallLine` / `buildTimeline` 测试不受影响。

- [ ] **Step 5: 把 `kind: 'text'` 分支替换为 `<MarkdownText>` + 去掉 `whiteSpace: 'pre-wrap'`**

修改 `packages/zai/src/web/src/components/TaskDrawer.tsx` 第 468-484 行的 timeline 渲染，把：

```tsx
if (item.kind === 'text') {
  return (
    <div
      key={item.key}
      style={{
        fontSize: 13,
        color: '#fff',
        padding: '6px 0',
        whiteSpace: 'pre-wrap',
        wordBreak: 'break-word',
      }}
    >
      {item.text}
    </div>
  )
}
```

替换为：

```tsx
if (item.kind === 'text') {
  return (
    <div
      key={item.key}
      style={{
        fontSize: 13,
        color: '#fff',
        padding: '6px 0',
        wordBreak: 'break-word',
      }}
    >
      <MarkdownText text={item.text} />
    </div>
  )
}
```

- [ ] **Step 6: 跑完整 TaskDrawer 测试套件确认通过**

```bash
cd packages/zai && npm test -- TaskDrawer
```

预期：PASS — 原有 4 个 describe 块 + 新加 `MarkdownText` 测试，全部通过。

- [ ] **Step 7: Commit**

```bash
git add packages/zai/src/web/src/components/TaskDrawer.tsx packages/zai/src/web/src/components/TaskDrawer.test.tsx
git commit -m "$(cat <<'EOF'
HRMSV3-ZN-WEBSITE#668 feat(zai-web): TaskDrawer LLM 文本项渲染为 markdown

把 buildTimeline 的 kind='text' 分支从 whiteSpace:pre-wrap 纯文本升级为
GFM markdown 渲染。本地定义 markdownComponents（与 Agent.tsx 第 77-227 行
等价），通过 ReactMarkdown + remarkGfm + Prism oneDark 渲染,暗色调色板与
主对话一致。导出独立 MarkdownText 组件便于单元测试。

TaskDrawer 的 text 项在 push 到 timeline 后即 freeze,不需要流式切换策略。
EOF
)"
```

---

## Task 2: 列表 / 链接 / 表格 / 引用全套元素

**Files:**
- Modify: `packages/zai/src/web/src/components/TaskDrawer.test.tsx`（追加测试用例）

**Interfaces:**
- Consumes: Task 1 导出的 `MarkdownText`
- Produces: 全套 markdown 元素的可测试性

- [ ] **Step 1: 追加测试 — 列表、链接、表格、引用**

在 `packages/zai/src/web/src/components/TaskDrawer.test.tsx` 的 `describe('MarkdownText ...')` 块内追加：

```tsx
test('列表渲染为 <ul><li>', () => {
  const { container } = render(<MarkdownText text={'- a\n- b' />)
  expect(container.querySelector('ul')).toBeTruthy()
  expect(container.querySelectorAll('li').length).toBe(2)
})

test('链接 target=_blank, href 正确', () => {
  const { container } = render(<MarkdownText text="[click](https://x.com)" />)
  const a = container.querySelector('a')
  expect(a?.getAttribute('href')).toBe('https://x.com')
  expect(a?.getAttribute('target')).toBe('_blank')
  expect(a?.getAttribute('rel')).toContain('noopener')
})

test('表格渲染为 <table><thead><tbody>', () => {
  const text = '| h1 | h2 |\n| --- | --- |\n| a | b |'
  const { container } = render(<MarkdownText text={text} />)
  expect(container.querySelector('table')).toBeTruthy()
  expect(container.querySelector('thead')).toBeTruthy()
  expect(container.querySelector('tbody')).toBeTruthy()
})

test('引用渲染为 <blockquote>', () => {
  const { container } = render(<MarkdownText text="> 注" />)
  expect(container.querySelector('blockquote')).toBeTruthy()
})
```

- [ ] **Step 2: 跑测试确认通过**

```bash
cd packages/zai && npm test -- TaskDrawer.test.tsx
```

预期：PASS — Task 1 已经实现完整 `markdownComponents`，覆盖了列表 / 链接 / 表格 / 引用。

- [ ] **Step 3: Commit**

```bash
git add packages/zai/src/web/src/components/TaskDrawer.test.tsx
git commit -m "$(cat <<'EOF'
HRMSV3-ZN-WEBSITE#668 test(zai-web): TaskDrawer markdown 渲染覆盖列表/链接/表格/引用

为 MarkdownText 追加 4 个用例:列表、target=_blank 链接、表格、引用,
回归保护 markdownComponents 的视觉一致性。
EOF
)"
```

---

## Task 3: XSS 净化回归 + typecheck

**Files:**
- Modify: `packages/zai/src/web/src/components/TaskDrawer.test.tsx`（追加 XSS 测试）

**Interfaces:**
- Consumes: Task 1 导出的 `MarkdownText`
- Produces: `<script>` 等危险标签不被渲染为真实 DOM 的回归保护

- [ ] **Step 1: 追加 XSS 净化测试**

在 `packages/zai/src/web/src/components/TaskDrawer.test.tsx` 的 `describe('MarkdownText ...')` 块内追加：

```tsx
test('输入含 <script> 不会渲染为真实 <script> 节点', () => {
  const { container } = render(<MarkdownText text="<script>alert(1)</script>" />)
  expect(container.querySelector('script')).toBeNull()
  // 文本内容应保留(转义后出现在容器里),用户能看到但不执行
  expect(container.textContent).toContain('alert(1)')
})
```

- [ ] **Step 2: 跑测试确认通过**

```bash
cd packages/zai && npm test -- TaskDrawer.test.tsx
```

预期：PASS — ReactMarkdown v10 默认不渲染原始 HTML，`<script>` 标签被转义。

- [ ] **Step 3: 跑 typecheck**

```bash
cd packages/zai && npm run typecheck
```

预期：PASS（无新增类型错误）。

- [ ] **Step 4: 跑完整 TaskDrawer 测试套件（包含原有 buildTimeline / formatToolInput / formatToolCallLine）**

```bash
cd packages/zai && npm test -- TaskDrawer
```

预期：所有原有 + 新增测试全部 PASS。

- [ ] **Step 5: Commit**

```bash
git add packages/zai/src/web/src/components/TaskDrawer.test.tsx
git commit -m "$(cat <<'EOF'
HRMSV3-ZN-WEBSITE#668 test(zai-web): TaskDrawer markdown XSS 净化回归

验证 ReactMarkdown v10 默认不渲染原始 HTML,<script> 等危险标签被转义为
文本而非真实 DOM 节点,避免 LLM 输出污染触发 XSS。
EOF
)"
```

---

## Self-Review

**1. Spec coverage:**
- 范围仅 `kind: 'text'` ✓ Task 1 Step 5
- markdownComponents 复用 Agent.tsx（本地字面复制）✓ Task 1 Step 3
- 始终 markdown 渲染，不做流式切换 ✓ Task 1 Step 5 + Step 3 自检
- `whiteSpace: 'pre-wrap'` 移除 ✓ Task 1 Step 5
- 围栏代码块 Prism oneDark ✓ Task 1 Step 3（`SyntaxHighlighter` + `oneDark` + `CODE_BG='#282c34'`）
- 行内 code 染 `#a78bfa` ✓ Task 1 Step 3
- 表格 / 列表 / 引用 / 链接 ✓ Task 2 测试覆盖
- XSS 净化 ✓ Task 3
- 不修改后端 / SSE / `buildTimeline` ✓ 全部 Task 均未触及
- 不抽出共享模块 ✓ 全局约束 + 未引用 `Agent.tsx` 常量

**2. Placeholder scan:** 无 TBD / TODO / "类似 Task N"。

**3. Type consistency:** `MarkdownText` 在 Task 1 Step 3 导出，Task 1 Step 1 测试导入，Task 2 / Task 3 复用 — 类型一致 `{ text: string }`。