# zai FsTab MD 渲染复用 — 设计

> 状态: 待 review
> 日期: 2026-07-21
> 范围: `packages/zai/src/web/src/components/splitPane/FsTab.tsx` + `components/transcript/MessageBubble.tsx`

## 1. 背景

zai 的 Files 标签(`FsTab`)用于浏览会话 cwd 的文件树,选中文件后右侧预览面板显示内容。`renderPreview` 当前的分支:
- `.ts/.tsx/.py/.go/...` → `react-syntax-highlighter` + Prism oneDark
- `.md/.json/.txt/未知` → 纯 `<pre>`

`.md` 落进 plain-text 分支,把 markdown 原文当文字渲染 — 标题、加粗、表格、列表全部丢失。

与此同时,对话气泡 (`MessageBubble.tsx`) 早有一套完整的 markdown 渲染:`MarkdownText` 组件 + `markdownComponents` 自定义映射(`p`/`h1..h4`/`ul`/`ol`/`code`/`table`/`blockquote`/`a`/`hr` 等),风格与项目整体深色 UI 协调。但它是 module-private,被 `MessageBubble.tsx:39-228` 圈在自己文件里。

目标: 文件预览里的 `.md` 文件走与对话气泡**同一套** markdown 渲染,样式保持一致,代码块沿用现有 dark Prism 主题。

## 2. 设计

### 2.1 模块拆分 — `components/markdown/MarkdownText.tsx`

新建 `packages/zai/src/web/src/components/markdown/MarkdownText.tsx`,**逐行搬迁** `MessageBubble.tsx:39-228` 的以下内容,无任何逻辑/样式变更:

- `const CODE_BG = "#282c34";`
- `const CODE_FONT_FAMILY = "ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace";`
- `const markdownComponents = {...}`(整段 p / h1-h4 / ul / ol / li / code / pre / table / thead / tbody / tr / th / td / blockquote / a / hr)
- `export const MarkdownText = React.memo(function MarkdownText({ text }) {...})`

文件自身导入:
- `react`
- `react-markdown`
- `remark-gfm`
- `react-syntax-highlighter`
- `react-syntax-highlighter/dist/esm/styles/prism`(oneDark)

新增 export:`MarkdownText`、`markdownComponents`(named)。

### 2.2 `MessageBubble.tsx` 改动 — 只改 import

- 删除 import:`ReactMarkdown`、`remarkGfm`、`SyntaxHighlighter`、`oneDark`。
- 删除模块级常量:`CODE_BG`、`CODE_FONT_FAMILY`、`markdownComponents`、`MarkdownText` 定义(L39-228 整段)。
- 新增:`import { MarkdownText } from "../markdown/MarkdownText.js";`
- 调用点不变:`<MarkdownText text={...} />` 在 L1007 / L1164 等(以及 `StreamingMarkdown` 内部 L243,通过同一 named export)。

`StreamingMarkdown`(L235-269)继续留在 `MessageBubble.tsx`,因为它依赖 `splitMarkdownOnIncomplete` + `linkifyText` + 自己的光标动画,仅对话气泡使用。

行为完全等价:同 props、同 React.memo、同 children 输出。

### 2.3 `FsTab.tsx` 改动 — renderPreview 加 MD 分支

`packages/zai/src/web/src/components/splitPane/FsTab.tsx:26-72` 的 `renderPreview` 改造:

```ts
function renderPreview(content: string, name?: string): JSX.Element {
  const containerStyle: React.CSSProperties = {
    flex: 1, minHeight: 0, overflow: 'auto', borderRadius: 6,
  };

  // MD 分支: 在 lang 检查之前,先识别 .md / .markdown,走 MarkdownText。
  // 用 regex 而非 extToLanguage, 因为 extToLanguage 不把 MD 视为 code,
  // 返回 null, 会让 MD 落到 plain text 分支(就是现在的 bug)。
  if (name && /\.(md|markdown)$/i.test(name)) {
    return (
      <div data-testid="fs-preview-md" style={containerStyle}>
        <MarkdownText text={content} />
      </div>
    );
  }

  const lang = name ? extToLanguage(name) : null;
  if (lang) { /* 原 Prism 分支, 不变 */ }
  return ( /* 原 plain text 分支, 不变 */ );
}
```

新增 import:`import { MarkdownText } from "../markdown/MarkdownText.js";`

`containerStyle` 与现有 `data-testid="fs-preview-code"` / `"fs-preview-text"` 列保持一致:
- `flex: 1` — 占满外层 60% 列
- `minHeight: 0` — flex 列必须,否则父级会被内容撑高
- `overflow: 'auto'` — 长 MD 自带滚动
- `borderRadius: 6` — 与 code/text 一致

`MarkdownText` 内层已自带 `fontSize: 14, lineHeight: 1.6, wordBreak: 'break-word'` 包装(见 L213-219 原代码),无需 FsTab 再覆写。

`extToLanguage` 文件不变。`FsTab` 现有的"按需加载" tree、refresh 按钮、selected / loaded state、空状态分支、error 分支一律不动。

## 3. 数据流

无后端变更。`useFsFile(cwd, selected)` → `GET /api/fs/file?dir=...&file=...` → 返回 `{ ok, content, name }`(TEXT_EXTS allow-list 已经包含 `.md`,见 `routes/fs.ts`)。`renderPreview(content, name)` 内部判断分支,MD 命中即走 `MarkdownText`。

## 4. 错误处理

- 文件不存在 / 权限不足:`useFsFile` 返回 `error` 字段,FsTab 提前在 L254 `<Empty description={file.error} />` 拦截,不到 `renderPreview`。
- MD 解析异常:`react-markdown` 内部 catch(已知行为),会渲染原文或空 div,与对话气泡一致 — 不引入新错误通道。
- `MarkdownText` 自身被 `React.memo` 包裹,props 不变时不重渲。

## 5. 测试

### 5.1 新增 `MarkdownText.test.tsx`

`packages/zai/src/web/src/components/markdown/MarkdownText.test.tsx`:
- case 1: 渲染 `# hello` → 断言 `<h1>hello</h1>` 存在
- case 2: 渲染 ```ts\nconst x = 1\n``` → 断言 Prism 渲染器被调用,DOM 含 `language-ts` 类的 `<pre>`
- case 3: 渲染 GFM 表格 → 断言 `<table>` 节点
- case 4: 渲染 `[link](https://x)` → 断言 `<a target="_blank">`

### 5.2 扩展 `FsTab.test.tsx`(已存在)

mock `useFsFile` 返回 `{ name: 'README.md', content: '# Title\n\nbody' }`,断言:
- 渲染 `<h1>Title</h1>`
- 不渲染 `data-testid="fs-preview-text"`
- 渲染 `data-testid="fs-preview-md"`

反向 case(已存在):`.txt` 文件仍走 `<pre data-testid="fs-preview-text">`,回归保护。

### 5.3 不需要回归

- `MessageBubble.test.tsx`: `MarkdownText` 行为不变,既有断言全过。
- 其他 transcript 用例:同源。

## 6. 已知边界 / 不做

不做(YAGNI):
- 顶部文件名 / 复制按钮(用户确认不要)
- 源码 / 渲染 tab 切换
- 大文件虚拟化
- MD 内图片尺寸自适应(`react-markdown` 默认 `<img>`,本期不动)
- `extToLanguage` 把 MD 也映射成某种"语言"

边界:
- 长 MD 走外层 `overflow:auto`,与对话气泡同策略
- MD 中链接 `target="_blank"` 顶开新 tab — 行为可接受,不做限定
- MD 文件后缀识别 `\.md$` / `\.markdown$`,case-insensitive