# zai Agent 对话消息链接可点击 — 设计规格

> 文档版本: 1.0 · 2026-07-11 · 状态: 设计已敲定, 待用户 review

## 0. 背景

zai Web Agent 页面的对话气泡, 链接可点击性不一致:

- **已可点击**: `assistant.text` 在流式结束后的 Markdown 渲染 (Agent.tsx:113-117 的 `markdownComponents.a`) 已经设置了 `target="_blank" rel="noopener noreferrer"`。即 `[label](https://example.com)` 形式的链接能正确新开页面。
- **不可点击**: 多个纯文本渲染点, 模型输出裸 URL (`https://example.com`) 时只显示成灰字文本, 既不可点击也不会新开页面:
  1. 流式期间的 `assistant.text` / `content_block_delta` 渲染 (Agent.tsx:556-578, `whiteSpace: pre-wrap`)
  2. 思考块展开后内容 (Agent.tsx:237-254)
  3. 工具调用的 `参数 / 结果 / 错误` 三块 `<pre>` 输出 (Agent.tsx:419-432, 460-465, 480-495)
  4. 用户消息气泡 (Agent.tsx:524-527, AntD `<Text>`)
  5. Legacy `tool.call` / `tool.result` 的 `<pre>` (Agent.tsx:626, 665)
  6. QuestionCard 选项 `description` (QuestionCard.tsx:117-118, 134-135)

用户期望: 所有出现在对话中的链接 (无论裸 URL 还是 markdown 链接) 都可点击、且统一新开页面。

## 1. 方案

新增一个轻量纯函数 `linkifyText(text: string): React.ReactNode[]`, 把纯文本中的 `http(s)://...` 切分成"普通文本段 + `<a>` 节点"序列; 然后在上述 6 处纯文本渲染点替换调用。新生成的 `<a>` 与 markdown `<a>` 保持完全一致的样式 (`#1677ff` + 下划线) 与 `target` / `rel` 行为。

**不引入新依赖**, 不动 ReactMarkdown 路径 (已经 work), 不做范围更大的重构。

## 2. 文件改动

### 2.1 新建 `packages/zai/src/web/src/lib/linkify.ts`

```ts
import type { ReactNode } from 'react'

// 仅匹配 http(s), 避免误把版本号 / 文件路径渲染成链接.
// 字符类排除空白 / < > " ' 防止吃到 HTML 边界或 markdown 链接的右半边.
const URL_RE = /\bhttps?:\/\/[^\s<>"')]+/g

// 尾部标点剥离: 句末 "https://x.com." 的 "." 不应圈进 href
// (浏览器打开 https://x.com. 通常能容错, 但显式更稳).
function stripTrailingPunct(href: string): string {
  return href.replace(/[.,;:!?)]+$/, '')
}

export function linkifyText(text: string): ReactNode[] {
  if (!text) return [text]
  const parts: ReactNode[] = []
  let last = 0
  for (const m of text.matchAll(URL_RE)) {
    const start = m.index!
    const raw = m[0]
    const href = stripTrailingPunct(raw)
    if (start > last) parts.push(text.slice(last, start))
    parts.push(
      <a
        key={start}
        href={href}
        target="_blank"
        rel="noopener noreferrer"
        style={{ color: '#1677ff', textDecoration: 'underline' }}
      >
        {raw}
      </a>,
    )
    last = start + raw.length
  }
  if (last < text.length) parts.push(text.slice(last))
  // 若整段没匹配到, 返回原始字符串 (而不是空数组), 让调用点省一次 fallback.
  return parts.length > 0 ? parts : [text]
}
```

### 2.2 改动 `packages/zai/src/web/src/pages/Agent.tsx`

| 行号 | 场景 | 替换 |
|------|------|------|
| L527 | 用户消息气泡 `<Text>` | `{linkifyText(msg.text)}` |
| L567 | 流式期间 `<div>{text}</div>` | `{linkifyText(text)}` |
| L253 | 思考块展开后 `<div>{text}</div>` | `{linkifyText(text)}` |
| L431 | 工具调用参数 `<pre>{JSON.stringify(input, null, 2)}</pre>` | `<pre>{linkifyText(JSON.stringify(input, null, 2))}</pre>` |
| L463 | 工具调用结果 `<pre>{...}</pre>` | `<pre>{linkifyText(...)}</pre>` |
| L488 | 工具调用错误 `<pre>{errorText}</pre>` | `<pre>{linkifyText(errorText)}</pre>` |
| L627 | legacy `tool.call` `<pre>{JSON.stringify(args, null, 2)}</pre>` | `<pre>{linkifyText(JSON.stringify(args, null, 2))}</pre>` |
| L666 | legacy `tool.result` `<pre>{...}</pre>` | `<pre>{linkifyText(...)}</pre>` |

**保持不动:**
- `markdownComponents.a` (L113-117) — 已经处理 markdown `[..](..)`, 保留
- `MarkdownText` 整体 — 走 ReactMarkdown 路径, 由 markdown 组件覆盖
- ThinkingBlock 的折叠态预览 (L142-146) — 只是一行截断文本, 不链接化避免视觉跳动

### 2.3 改动 `packages/zai/src/web/src/components/QuestionCard.tsx`

| 行号 | 场景 | 替换 |
|------|------|------|
| L118 | 选项 `description` `<span>` | `{linkifyText(opt.description)}` |
| L135 | 同上 (多选分支) | `{linkifyText(opt.description)}` |

**保持不动:**
- 选项 `label` (L117, L133) — 通常短, 不需要
- 选项 `preview` (L119, L135, 走 `PreviewText`) — 是代码风格, 不应该被 linkify 破坏对齐
- Review 标签、备注等其它文本

## 3. 测试

新建 `packages/zai/test/web/linkify.test.ts`, 用 vitest + @testing-library/react 覆盖:

1. 空字符串 → 返回 `['']`
2. 纯文本 (无 URL) → 返回单元素数组且内容等于原文
3. 单个 URL → 切分成 [text-prefix, `<a>`, text-suffix] 三段
4. 多个 URL → 顺序保持, 每段独立 key
5. `http://` 与 `https://` 都被匹配
6. 尾部标点 `.` / `,` / `)` / `;` 被剥离到 text 段, href 不带
7. URL 中含 `(` 时, 配对 `)` 不被吃进 href (`https://en.wikipedia.org/wiki/Foo_(bar)` → href 停在 `Foo_(bar`, 但实际正则在 `)` 处中断 — 接受这种行为, 因为我们要排除 `)`, 不引入更复杂的 balanced-paren 处理)
8. 输出包含 `<a target="_blank" rel="noopener noreferrer">`

## 4. 风险与边界

- **性能**: `linkifyText` 仅在消息渲染时调用, 单条消息长度 < 10KB 是常态, regex `matchAll` 毫秒级。无明显开销。
- **XSS**: 不引入 `dangerouslySetInnerHTML`, 全部走 React 文本节点 / `<a href={href}>` (href 是受控字符串, 非 HTML 注入面)。
- **markdown 链接双重处理**: ReactMarkdown 在传入 `[label](https://x)` 时, 已经把整段渲染成 `<a>` (label + href), `linkifyText` 不会运行在这条路径上 (由 `MarkdownText` 接管)。唯一可能"双重"的是用户在 plain-text 输入里写出 `[label](https://x)` 但没有走 Markdown — 这种情况下正则会匹配 `https://x` 渲染成链接, 而 `[label](...)` 整体作为文本显示。可接受。
- **回流 / 重渲染**: `linkifyText` 每次调用都返回新数组, React 会做 diff。对流式高频场景, 仅对**末尾**那条消息执行, 频率仍可控。
- **样式冲突**: 工具调用 `<pre>` 已经设置了 `whiteSpace: pre-wrap` + 等宽字体, 在段内插入 `<a>` 不会破坏布局 (行内元素)。