# FsTab MD 渲染复用 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让 zai 文件预览树里的 `.md` 文件走与对话气泡同一套 markdown 渲染,样式保持一致,代码块沿用 dark Prism 主题。

**Architecture:** 把 `MessageBubble.tsx` 里的 module-private `MarkdownText` 组件 + `markdownComponents` 表提取到独立文件 `components/markdown/MarkdownText.tsx`;`MessageBubble` 改成 import 复用;`FsTab.tsx` 的 `renderPreview` 在 `extToLanguage` 之前识别 `.md` / `.markdown` 后缀,分支走 `MarkdownText` 而不是回落到 plain `<pre>`。

**Tech Stack:** React + TypeScript + AntD;`react-markdown@9` + `remark-gfm@4` + `react-syntax-highlighter`(`oneDark` 主题);Vitest + `@testing-library/react` + happy-dom。

## Global Constraints

- 工程根:`/Users/liangxuechao572/code/opencc-web/`,本计划只动 `packages/zai/src/web/`(无须跨 workspace 改 zai-agent-core)。
- 测试运行:`pnpm -F zai test`(vitest workspace 模式,file-level 过滤用 `pnpm -F zai vitest run <path>`)。
- TypeScript:`@/*` 与相对路径混用,统一遵守 `*.js` 后缀(Vite 解析需要,见 `FsTab.tsx:6-9` 的 `.js` import 风格)。
- 现有 `FsTab.test.tsx:203-237` 的 "uses fs-preview-text test-id for .md files" 测试会被本计划 Task 3 替换 — 不要保留旧断言。
- 不做的事(YAGNI):不引入复制按钮、不加 tab 切换、不动 `extToLanguage`、不做图片尺寸自适应。
- Spec:`docs/superpowers/specs/2026-07-21-zai-fs-tab-md-render-design.md`。

---

## File Structure

| 文件 | 角色 | 状态 |
|------|------|------|
| `packages/zai/src/web/src/components/markdown/MarkdownText.tsx` | MD 渲染组件 + markdownComponents 表 + CODE 常量 | 新建 |
| `packages/zai/src/web/src/components/markdown/MarkdownText.test.tsx` | MarkdownText 单元测试 | 新建 |
| `packages/zai/src/web/src/components/transcript/MessageBubble.tsx` | 删本地实现,改 import 引用新文件 | 修改 L24-27, L39-228, L1007, L1164 |
| `packages/zai/src/web/src/components/splitPane/FsTab.tsx` | renderPreview 增加 MD 分支 | 修改 L1-9, L26-72 |
| `packages/zai/src/web/src/components/splitPane/FsTab.test.tsx` | 替换旧 `.md` 走 plain text 的测试,新增 `fs-preview-md` 断言 | 修改 L203-237,追加新 case |

---

### Task 1: 新建 MarkdownText 模块

**Files:**
- Create: `packages/zai/src/web/src/components/markdown/MarkdownText.tsx`

**Interfaces:**
- Produces (named exports):
  - `MarkdownText: React.MemoExoticComponent<(props: { text: string }) => JSX.Element>`
  - `markdownComponents: Record<string, (...args: any[]) => JSX.Element>`(p / h1-h4 / ul / ol / li / code / pre / table / thead / tbody / tr / th / td / blockquote / a / hr)

**Step 1: 创建目录并写文件**

```tsx
// packages/zai/src/web/src/components/markdown/MarkdownText.tsx
// Extracted verbatim from MessageBubble.tsx (formerly lines 39-228):
// - markdownComponents custom renderer map (p/h1-h4/ul/ol/li/code/pre/table/thead/tbody/tr/th/td/blockquote/a/hr)
// - MarkdownText memoized wrapper around ReactMarkdown + remark-gfm
// - CODE_BG / CODE_FONT_FAMILY constants
// No behavior change — this is the same renderer used inside chat bubbles,
// now reusable for the FsTab file preview path.
import React from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { Prism as SyntaxHighlighter } from "react-syntax-highlighter";
import { oneDark } from "react-syntax-highlighter/dist/esm/styles/prism";

const CODE_BG = "#282c34";
const CODE_FONT_FAMILY =
  "ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace";

const markdownComponents = {
  p: ({ children }: any) => <p style={{ margin: "0 0 8px 0" }}>{children}</p>,
  h1: ({ children }: any) => (
    <h1 style={{ fontSize: 20, fontWeight: 600, margin: "12px 0 8px 0" }}>
      {children}
    </h1>
  ),
  h2: ({ children }: any) => (
    <h2 style={{ fontSize: 18, fontWeight: 600, margin: "12px 0 8px 0" }}>
      {children}
    </h2>
  ),
  h3: ({ children }: any) => (
    <h3 style={{ fontSize: 16, fontWeight: 600, margin: "10px 0 6px 0" }}>
      {children}
    </h3>
  ),
  h4: ({ children }: any) => (
    <h4 style={{ fontSize: 14, fontWeight: 600, margin: "8px 0 4px 0" }}>
      {children}
    </h4>
  ),
  ul: ({ children }: any) => (
    <ul style={{ margin: "0 0 8px 0", paddingLeft: 20 }}>{children}</ul>
  ),
  ol: ({ children }: any) => (
    <ol style={{ margin: "0 0 8px 0", paddingLeft: 20 }}>{children}</ol>
  ),
  li: ({ children }: any) => <li style={{ marginBottom: 4 }}>{children}</li>,
  code: ({ className, children }: any) => {
    const match = /language-(\w+)/.exec(className || "");
    if (!match) {
      return (
        <code
          style={{
            background: "transparent",
            color: "#a78bfa",
            padding: "1px 6px",
            borderRadius: 3,
            fontSize: "0.9em",
            fontFamily: CODE_FONT_FAMILY,
            fontWeight: 500,
          }}
        >
          {children}
        </code>
      );
    }
    return (
      <SyntaxHighlighter
        language={match[1]}
        style={oneDark}
        customStyle={{
          margin: "6px 0 10px 0",
          padding: "12px 14px",
          borderRadius: 6,
          fontSize: 12,
          lineHeight: 1.55,
          background: CODE_BG,
        }}
        codeTagProps={{
          style: { fontFamily: CODE_FONT_FAMILY },
        }}
        wrapLongLines={false}
        showLineNumbers={false}
      >
        {String(children).replace(/\n$/, "")}
      </SyntaxHighlighter>
    );
  },
  pre: ({ children }: any) => <>{children}</>,
  table: ({ children }: any) => (
    <table
      style={{
        borderCollapse: "collapse",
        margin: "4px 0 8px 0",
        fontSize: 13,
        width: "100%",
      }}
    >
      {children}
    </table>
  ),
  thead: ({ children }: any) => (
    <thead style={{ background: "rgba(255,255,255,0.05)" }}>{children}</thead>
  ),
  tbody: ({ children }: any) => <tbody>{children}</tbody>,
  tr: ({ children }: any) => (
    <tr style={{ borderBottom: "1px solid rgba(255,255,255,0.08)" }}>
      {children}
    </tr>
  ),
  th: ({ children }: any) => (
    <th
      style={{
        padding: "6px 10px",
        textAlign: "left",
        fontWeight: 600,
        border: "1px solid rgba(255,255,255,0.08)",
      }}
    >
      {children}
    </th>
  ),
  td: ({ children }: any) => (
    <td
      style={{
        padding: "6px 10px",
        border: "1px solid rgba(255,255,255,0.08)",
      }}
    >
      {children}
    </td>
  ),
  blockquote: ({ children }: any) => (
    <blockquote
      style={{
        borderLeft: "3px solid rgba(255,255,255,0.2)",
        paddingLeft: 12,
        margin: "4px 0 8px 0",
        color: "rgba(255,255,255,0.7)",
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
      style={{ color: "#1677ff", textDecoration: "underline" }}
    >
      {children}
    </a>
  ),
  hr: () => (
    <hr
      style={{
        border: "none",
        borderTop: "1px solid rgba(255,255,255,0.08)",
        margin: "12px 0",
      }}
    />
  ),
};

export const MarkdownText = React.memo(function MarkdownText({ text }: { text: string }) {
  return (
    <div
      style={{
        fontSize: 14,
        lineHeight: 1.6,
        color: "inherit",
        wordBreak: "break-word",
      }}
    >
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        components={markdownComponents}
      >
        {text}
      </ReactMarkdown>
    </div>
  );
});
```

**Step 2: 跑现有对话气泡测试,确认未引入回归(此时还没改 MessageBubble,临时跳过 — 直接进 Task 2)**

```bash
cd /Users/liangxuechao572/code/opencc-web
pnpm -F zai vitest run src/web/src/components/transcript/MessageBubble.test.tsx
```

Expected: 全过。新文件尚未被导入,MessageBubble 仍用本地实现,本步骤实际是预热 vitest。**可跳过,Task 2 完成后再测。**

**Step 3: Commit**

```bash
git add packages/zai/src/web/src/components/markdown/MarkdownText.tsx
git commit -m "feat(zai/web): extract MarkdownText to components/markdown/"
```

---

### Task 2: 让 MessageBubble 复用 MarkdownText 模块

**Files:**
- Modify: `packages/zai/src/web/src/components/transcript/MessageBubble.tsx`
  - L24-27(react-markdown / remark-gfm / SyntaxHighlighter / oneDark imports)
  - L39-228(CODE_BG / CODE_FONT_FAMILY / markdownComponents / MarkdownText 定义)
  - L1007 / L1164(调用点,无须改 JSX)

**Interfaces:**
- Consumes:`MarkdownText` named export from `../markdown/MarkdownText.js`
- 行为不变:同 props、同 React.memo、同 children。

**Step 1: 替换顶部 imports**

把当前 L24-27 的:
```tsx
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { Prism as SyntaxHighlighter } from "react-syntax-highlighter";
import { oneDark } from "react-syntax-highlighter/dist/esm/styles/prism";
```

替换成一行:
```tsx
import { MarkdownText } from "../markdown/MarkdownText.js";
```

(注意:删除 4 行后,这 4 个包还在文件其它地方用吗?用 `grep` 复核:`SyntaxHighlighter` 仍由 `ToolCallBlock` 等用 — **不**,grep 一下 `MessageBubble.tsx` 全文,确认除了 L24-27 没有别处 import 这些符号。)

**Step 1.5: 复核 import 安全性**

```bash
grep -nE "SyntaxHighlighter|oneDark|ReactMarkdown|remarkGfm" \
  /Users/liangxuechao572/code/opencc-web/packages/zai/src/web/src/components/transcript/MessageBubble.tsx
```

Expected: 删除 L24-27 后,grep 结果为空(L24-27 之外不再有引用)。

如果 `ToolCallBlock`/`DiffBlock` 等内部组件用了 `SyntaxHighlighter`,保留它们各自的 local import — 但根据 L24-27 现状,这些只在 markdownComponents 段里用,搬走后没有别处引用。

**Step 2: 删除模块级常量 + markdownComponents + MarkdownText 定义(原 L38-228 整段)**

用 Edit(remove range)或 Edit 把整段 `const CODE_BG = ...` 到 `});` 末尾(MarkdownText 定义结束)整段删掉,确保函数 `StreamingMarkdown` (L235 起) 完好。

具体来说:
- 删除范围:`MessageBubble.tsx` 当前 L38 的 `const CODE_BG = ...` 到 L228 的 `});`(MarkdownText 组件结束的 `});`)
- 保留:`StreamingMarkdown` (L235-269)及其后所有内容,以及 import `splitMarkdownOnIncomplete` 等(若仅 markdownComponents 用,同样一并检查)

`StreamingMarkdown` 是否引用了 `markdownComponents` 或 `MarkdownText`?查看 L235-269:
```tsx
return (
  <>
    {complete && <MarkdownText text={complete} />}
    {tail && (...)}
  </>
);
```
仅引用了 `MarkdownText` 组件名,新模块 named export 同名 — OK。

**Step 3: 跑 MessageBubble 测试**

```bash
cd /Users/liangxuechao572/code/opencc-web
pnpm -F zai vitest run src/web/src/components/transcript/MessageBubble.test.tsx
```

Expected: 全过。`MarkdownText` 名字保持原样,行为等同。

**Step 4: 跑全量 web 测试,确认无回归**

```bash
cd /Users/liangxuechao572/code/opencc-web
pnpm -F zai test
```

Expected: 所有 web 测试通过。若 `streamAdapter` / `transcript` 路径有 snapshot,需要确认没有被本次 import-only 改动破坏。

**Step 5: Commit**

```bash
git add packages/zai/src/web/src/components/transcript/MessageBubble.tsx
git commit -m "refactor(zai/web): MessageBubble imports MarkdownText from shared module"
```

---

### Task 3: FsTab.renderPreview 增加 MD 分支

**Files:**
- Modify: `packages/zai/src/web/src/components/splitPane/FsTab.tsx`
  - L1-9:顶部 import 列表(`MarkdownText` 加在末尾)
  - L26-72:`renderPreview` 函数体,在 `if (lang)` 分支前插入 MD 分支

**Step 1: 写失败测试(先红)**

在 `packages/zai/src/web/src/components/splitPane/FsTab.test.tsx` 末尾(L257 后)追加:

```tsx
  it('renders .md files via MarkdownText (fs-preview-md test-id)', () => {
    // Selecting a .md file should mount the MarkdownText wrapper
    // (data-testid="fs-preview-md") so the markdown source is rendered
    // as proper markdown — heading elements, lists, tables — NOT a
    // raw <pre>. This is the new behavior introduced by the FsTab
    // MD rendering refactor.
    mockList.mockReturnValue({
      data: {
        ok: true,
        entries: [
          { name: 'README.md', path: 'README.md', type: 'file', size: 12 },
        ],
      },
      loading: false,
      error: null,
      refetch: vi.fn(),
    });
    mockFile.mockReturnValue({
      data: {
        ok: true,
        path: '/repo/README.md',
        name: 'README.md',
        size: 12,
        mtime: '2026-07-21T00:00:00Z',
        content: '# Hello\n\nbody',
      },
      loading: false,
      error: null,
    });
    render(<FsTab cwd="/repo" />);
    fireEvent.click(screen.getByText('README.md'));
    // The new MD branch wrapper:
    expect(screen.getByTestId('fs-preview-md')).toBeTruthy();
    expect(screen.queryByTestId('fs-preview-text')).toBeNull();
    expect(screen.queryByTestId('fs-preview-code')).toBeNull();
    // Markdown was actually rendered (heading element appeared).
    expect(screen.getByRole('heading', { level: 1, name: 'Hello' })).toBeTruthy();
    // The raw "# Hello" text should NOT appear as raw text (it became a heading).
    expect(screen.queryByText('# Hello', { selector: 'pre, code' })).toBeNull();
  });

  it('renders .markdown files (alternate suffix) via MarkdownText', () => {
    // The regex is /\.md|\.markdown$/i — confirm .markdown variant hits
    // the same branch.
    mockList.mockReturnValue({
      data: {
        ok: true,
        entries: [
          { name: 'NOTES.markdown', path: 'NOTES.markdown', type: 'file', size: 5 },
        ],
      },
      loading: false,
      error: null,
      refetch: vi.fn(),
    });
    mockFile.mockReturnValue({
      data: {
        ok: true,
        path: '/repo/NOTES.markdown',
        name: 'NOTES.markdown',
        size: 5,
        mtime: '2026-07-21T00:00:00Z',
        content: '## Section',
      },
      loading: false,
      error: null,
    });
    render(<FsTab cwd="/repo" />);
    fireEvent.click(screen.getByText('NOTES.markdown'));
    expect(screen.getByTestId('fs-preview-md')).toBeTruthy();
    expect(screen.getByRole('heading', { level: 2, name: 'Section' })).toBeTruthy();
  });

  it('still renders .txt files via plain <pre> (regression guard)', () => {
    // .txt files should NOT hit the new MD branch.
    mockList.mockReturnValue({
      data: {
        ok: true,
        entries: [
          { name: 'notes.txt', path: 'notes.txt', type: 'file', size: 4 },
        ],
      },
      loading: false,
      error: null,
      refetch: vi.fn(),
    });
    mockFile.mockReturnValue({
      data: {
        ok: true,
        path: '/repo/notes.txt',
        name: 'notes.txt',
        size: 4,
        mtime: '2026-07-21T00:00:00Z',
        content: 'plain text',
      },
      loading: false,
      error: null,
    });
    render(<FsTab cwd="/repo" />);
    fireEvent.click(screen.getByText('notes.txt'));
    expect(screen.getByTestId('fs-preview-text')).toBeTruthy();
    expect(screen.queryByTestId('fs-preview-md')).toBeNull();
  });
```

**Step 2: 替换旧的 MD plain-text 断言(L203-237)**

把现有的 "uses fs-preview-text test-id for .md files (no highlighting)" 整个 `it(...)` 删掉 — 它断言的是本次改动前被替换的行为。继续保留会让本计划 Task 3 完成后测试失败。

具体:`FsTab.test.tsx` L203-237 整段(L203 `it('uses fs-preview-text test-id for .md files (no highlighting)', () => {` 到 L237 `});` 结束的 `});`),直接删除 — 上方 Step 1 已经在末尾追加 3 个新 case,旧的失效。

**Step 3: 跑测试,确认新 case 失败(此时尚无 MD 分支实现)**

```bash
cd /Users/liangxuechao572/code/opencc-web
pnpm -F zai vitest run src/web/src/components/splitPane/FsTab.test.tsx
```

Expected: 3 个新 case 失败 — `fs-preview-md` 找不到 / 找不到 `<h1>Hello</h1>` / 旧 case 已删除所以不会出现"误过"。

**Step 4: 在 FsTab.tsx 顶部 import 增加 MarkdownText**

`FsTab.tsx` L1-9 当前是:
```tsx
import { useEffect, useRef, useState } from 'react';
import { Button, Empty, Spin, Tree } from 'antd';
import { ReloadOutlined, FolderOutlined, FileOutlined } from '@ant-design/icons';
import { Prism as SyntaxHighlighter } from 'react-syntax-highlighter';
import { oneDark } from 'react-syntax-highlighter/dist/esm/styles/prism';
import type { DataNode } from 'antd/es/tree';
import { useFsList } from './useFsList.js';
import { useFsFile } from './useFsFile.js';
import { extToLanguage } from './extToLang.js';
import { useElementHeight } from './useElementHeight.js';
```

在最后一行后追加:
```tsx
import { MarkdownText } from '../markdown/MarkdownText.js';
```

**Step 5: 在 renderPreview 内增加 MD 分支**

把当前 L26-32:
```tsx
function renderPreview(content: string, name?: string): JSX.Element {
  const lang = name ? extToLanguage(name) : null;
  const containerStyle: React.CSSProperties = {
    flex: 1,
    minHeight: 0,
    overflow: 'auto',
    borderRadius: 6,
  };
```

替换为:
```tsx
function renderPreview(content: string, name?: string): JSX.Element {
  const containerStyle: React.CSSProperties = {
    flex: 1,
    minHeight: 0,
    overflow: 'auto',
    borderRadius: 6,
  };

  // MD 分支: 在 lang 检查之前,先识别 .md / .markdown,走 MarkdownText。
  // 用 regex 而非 extToLanguage, 因为 extToLanguage 不把 MD 视为 code,
  // 返回 null, 会让 MD 落到 plain text 分支(就是现状的 bug)。
  if (name && /\.(md|markdown)$/i.test(name)) {
    return (
      <div data-testid="fs-preview-md" style={containerStyle}>
        <MarkdownText text={content} />
      </div>
    );
  }

  const lang = name ? extToLanguage(name) : null;
```

**Step 6: 跑测试,确认新 case 通过**

```bash
cd /Users/liangxuechao572/code/opencc-web
pnpm -F zai vitest run src/web/src/components/splitPane/FsTab.test.tsx
```

Expected: 全部通过(`.md` / `.markdown` 走 `fs-preview-md` + 渲染 `<h1>`;`.txt` 仍走 `fs-preview-text`)。

**Step 7: 跑全量 web 测试**

```bash
cd /Users/liangxuechao572/code/opencc-web
pnpm -F zai test
```

Expected: 全过。MessageBubble.test + FsTab.test + 其余 web 测试全绿。

**Step 8: Commit**

```bash
git add packages/zai/src/web/src/components/splitPane/FsTab.tsx \
        packages/zai/src/web/src/components/splitPane/FsTab.test.tsx
git commit -m "feat(zai/web): FsTab renders .md files via shared MarkdownText"
```

---

### Task 4: 新建 MarkdownText.test.tsx 单元测试

**Files:**
- Create: `packages/zai/src/web/src/components/markdown/MarkdownText.test.tsx`

**Step 1: 写测试**

```tsx
// @vitest-environment happy-dom
import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import { MarkdownText } from "./MarkdownText.js";

describe("MarkdownText", () => {
  it("renders a top-level heading as <h1>", () => {
    render(<MarkdownText text="# hello" />);
    expect(screen.getByRole("heading", { level: 1, name: "hello" })).toBeTruthy();
  });

  it("renders inline code with the violet (#a78bfa) custom style", () => {
    const { container } = render(<MarkdownText text="use `foo` here" />);
    // The markdownComponents.code branch (no language class) returns
    // <code style={{ color: "#a78bfa" ... }}>; we assert color:react-style.
    const code = container.querySelector("code");
    expect(code).toBeTruthy();
    expect(code?.style.color).toBe("rgb(167, 139, 250)"); // happy-dom normalises #a78bfa
  });

  it("renders a fenced code block through Prism with language-XXX class", () => {
    render(<MarkdownText text={"```ts\nconst x = 1;\n```"} />);
    // react-syntax-highlighter wraps the source in <pre><code class="language-ts ...">,
    // which is the signal that Prism was invoked.
    const codeWithLang = document.querySelector("code.language-ts, code[class*='language-ts']");
    expect(codeWithLang).toBeTruthy();
  });

  it("renders a GFM table as <table>", () => {
    const md = [
      "| a | b |",
      "| - | - |",
      "| 1 | 2 |",
    ].join("\n");
    const { container } = render(<MarkdownText text={md} />);
    expect(container.querySelector("table")).toBeTruthy();
  });

  it("opens external links in a new tab", () => {
    render(<MarkdownText text="[x](https://example.com)" />);
    const a = screen.getByText("x") as HTMLAnchorElement;
    expect(a.tagName).toBe("A");
    expect(a.target).toBe("_blank");
    expect(a.rel).toMatch(/noopener/);
    expect(a.rel).toMatch(/noreferrer/);
  });
});
```

**Step 2: 跑测试**

```bash
cd /Users/liangxuechao572/code/opencc-web
pnpm -F zai vitest run src/web/src/components/markdown/MarkdownText.test.tsx
```

Expected: 5 个 case 全过。如果 `code.language-ts` 的 selector 不命中,改用 `pre[class*="language-ts"]` 或检查 happy-dom 是否实际跑通 Prism tokenization — 若 tokenization 缺类,断言改成 `code.textContent` 含 `const x = 1;`。

**Step 3: Commit**

```bash
git add packages/zai/src/web/src/components/markdown/MarkdownText.test.tsx
git commit -m "test(zai/web): unit tests for shared MarkdownText renderer"
```

---

### Task 5: 最终验证 + TypeScript 编译检查

**Files:** 不修改文件,只运行命令。

**Step 1: TypeScript 检查**

```bash
cd /Users/liangxuechao572/code/opencc-web
pnpm -F zai exec tsc --noEmit -p tsconfig.json
```

Expected: 退出码 0,无错误。注意 `vite-env.d.ts` 已含 `*.vue` / React 类型声明,React.memo、JSX.Element 等应无需新增配置。

**Step 2: 全量 web 测试**

```bash
cd /Users/liangxuechao572/code/opencc-web
pnpm -F zai test
```

Expected: 全过。

**Step 3: 手动 smoke(可选,UI 渲染验证)**

启动 dev server(`pnpm -F zai dev`),会话 cwd 选一个含 `README.md` 的项目目录,Files 标签选 `.md` 文件 → 应当看到样式化的 markdown(h1 加粗、列表、代码块深底)而非原始 `# Hello` 文字。

如果环境无可视化界面,跳过此步 — 自动化测试已经覆盖渲染路径。

**Step 4: Commit 任何遗漏(若有)**

本任务不修改文件,若前 4 个任务都 commit 完成,本步骤无需 commit。如果发现 tsc 报错并修了文件,单独 commit 修复。

---

## Self-Review

**Spec coverage:**
- §2.1 提取 MarkdownText 模块 → Task 1
- §2.2 MessageBubble 改 import → Task 2
- §2.3 FsTab.renderPreview MD 分支 → Task 3
- §3 数据流(无后端变更)→ 由 Task 3 验证(`useFsFile` 仍返回 `{ name, content }`)
- §4 错误处理(`useFsFile.error` 拦截 / react-markdown 内部 catch)→ 由现有 FsTab error 分支(MarkdownText 误不会 throw)继承,无须新 case
- §5 测试(MarkdownText.test + FsTab.test MD case)→ Task 4 + Task 3 Step 1
- §6 不做(YAGNI 列表)→ 全计划不引入;验证 Task 1-4 都未触碰 extToLanguage / 不复制工具栏 / 不加 tab

**Gaps:** 没有。

**Placeholder scan:** 复核 grep:`grep -nE "TBD|TODO|implement later|fill in"` → 无结果。

**Type consistency:**
- `MarkdownText` props:`{ text: string }` 在 Task 1 定义、Task 2 import、Task 3 step 调用、Task 4 测试均一致。
- test-id `fs-preview-md` 在 Task 3 与 Task 4 测试都引用同一个名字。
- import 路径 `../markdown/MarkdownText.js` — Task 2 来自 `transcript/`(需 `../`),Task 3 来自 `splitPane/`(需 `../`)— 都正确。

Plan complete and saved to `docs/superpowers/plans/2026-07-21-zai-fs-tab-md-render.md`. Two execution options:

1. **Subagent-Driven (recommended)** - I dispatch a fresh subagent per task, review between tasks, fast iteration
2. **Inline Execution** - Execute tasks in this session using executing-plans, batch execution with checkpoints

Which approach?