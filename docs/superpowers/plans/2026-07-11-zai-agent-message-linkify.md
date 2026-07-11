# zai Agent 对话消息链接可点击 — 实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让 zai Web Agent 对话中所有 `http(s)://` 链接 (含裸 URL) 可点击且新开页面打开, 与现有 markdown 链接行为保持一致.

**Architecture:** 在 `packages/zai/src/web/src/lib/linkify.ts` 新增 `linkifySegments` (纯数据) + `linkifyText` (React 包装), 替换 Agent.tsx 与 QuestionCard.tsx 共 10 处纯文本渲染点. 不引入新依赖, 不动 ReactMarkdown 路径.

**Tech Stack:** TypeScript, React (JSX), vitest (node 环境).

## Global Constraints

- 仅匹配 `http://` 与 `https://`, 不引入 ftp/mailto (决策 §1)
- 不引入新 npm 依赖
- 链接样式 (`#1677ff` + 下划线) + `target="_blank"` + `rel="noopener noreferrer"` 与现有 markdown `a` 组件 (Agent.tsx:113-117) 完全一致
- 不动 ReactMarkdown 路径
- 提交规范: `feat: 新功能 | fix: 修复 | docs: 文档 | refactor: 重构 | chore: 工具链 | test: 测试`
- vitest 配置: `environment: 'node'`, 测试只能依赖纯数据 / 纯函数, 不能 import jsdom

---

## 文件结构

| 文件 | 状态 |
|------|------|
| `packages/zai/src/web/src/lib/linkify.ts` | 新建 |
| `packages/zai/test/web/linkify.test.ts` | 新建 |
| `packages/zai/src/web/src/pages/Agent.tsx` | 改 (8 处调用点) |
| `packages/zai/src/web/src/components/QuestionCard.tsx` | 改 (2 处调用点) |

---

## Task 1: 实现 `lib/linkify.ts` (TDD)

**Files:**
- Create: `packages/zai/src/web/src/lib/linkify.ts`
- Create: `packages/zai/test/web/linkify.test.ts`

**Interfaces:**
- Produces:
  ```ts
  export type LinkSegment =
    | { kind: 'text'; value: string }
    | { kind: 'link'; raw: string; href: string }

  export function linkifySegments(text: string): LinkSegment[]
  export function linkifyText(text: string): ReactNode[]
  ```

- [ ] **Step 1: 写失败的测试 `packages/zai/test/web/linkify.test.ts`**

```ts
import { describe, it, expect } from 'vitest'
import { linkifySegments } from '../../src/web/src/lib/linkify.js'

describe('linkifySegments', () => {
  it('空字符串返回单 text 段', () => {
    expect(linkifySegments('')).toEqual([{ kind: 'text', value: '' }])
  })

  it('无 URL 文本原样返回', () => {
    expect(linkifySegments('hello world')).toEqual([
      { kind: 'text', value: 'hello world' },
    ])
  })

  it('单 URL 切分为 [text, link, text]', () => {
    const out = linkifySegments('看 https://example.com 这个')
    expect(out).toEqual([
      { kind: 'text', value: '看 ' },
      { kind: 'link', raw: 'https://example.com', href: 'https://example.com' },
      { kind: 'text', value: ' 这个' },
    ])
  })

  it('匹配 http 与 https', () => {
    const out = linkifySegments('http://a.com https://b.com')
    expect(out.filter((s) => s.kind === 'link').map((s) => (s as any).href)).toEqual([
      'http://a.com',
      'https://b.com',
    ])
  })

  it('多个 URL 顺序保持', () => {
    const out = linkifySegments('a https://x.com b https://y.com c')
    expect(out.filter((s) => s.kind === 'link').length).toBe(2)
  })

  it('剥离尾部标点 . , ; : ! ? )', () => {
    expect(linkifySegments('看 https://x.com.').filter((s) => s.kind === 'link')[0])
      .toEqual({ kind: 'link', raw: 'https://x.com.', href: 'https://x.com' })
    expect(linkifySegments('看 https://x.com).').filter((s) => s.kind === 'link')[0])
      .toEqual({ kind: 'link', raw: 'https://x.com).', href: 'https://x.com' })
  })

  it('URL 在字符串开头/末尾正常工作', () => {
    expect(linkifySegments('https://start.com').map((s) => s.kind)).toEqual(['link'])
    expect(linkifySegments('end https://end.com').map((s) => s.kind)).toEqual([
      'text',
      'link',
    ])
  })

  it('括号内 URL 在首个 ) 处终止', () => {
    // 正则字符类排除 ), 所以 (foo) 形式的 URL 在 ( 处匹配, ) 处终止.
    // 期望: raw 包含开括号, href 不包含尾括号.
    const out = linkifySegments('wiki (https://en.wikipedia.org/wiki/Foo_(bar))').filter(
      (s) => s.kind === 'link',
    )
    expect((out[0] as any).href).not.toMatch(/\)$/)
  })

  it('不匹配 markdown 风格的 [label](url) 中的 url 部分被独立识别为 link', () => {
    // 设计上 linkifySegments 不知道 markdown 上下文, 内部 url 仍会被单独识别.
    // 这是预期行为 (QuestionCard / 流式文本 不走 markdown 解析).
    const out = linkifySegments('[点这里](https://x.com)')
    const links = out.filter((s) => s.kind === 'link')
    expect(links.length).toBe(1)
    expect((links[0] as any).href).toBe('https://x.com')
  })
})
```

- [ ] **Step 2: 运行测试确认失败**

Run: `cd packages/zai && bun test test/web/linkify.test.ts`
Expected: FAIL with "Cannot find module .../lib/linkify.js" 或类似 import error.

- [ ] **Step 3: 创建 `packages/zai/src/web/src/lib/linkify.ts`**

```ts
import type { ReactNode } from 'react'

export type LinkSegment =
  | { kind: 'text'; value: string }
  | { kind: 'link'; raw: string; href: string }

// 仅匹配 http(s), 避免误把版本号 / 文件路径渲染成链接.
// 字符类排除空白 / < > " ' ), 防止吃到 HTML 边界或 markdown 链接右半边.
const URL_RE = /\bhttps?:\/\/[^\s<>"')]+/g

// 尾部标点剥离: 句末 "https://x.com." 的 "." 不应圈进 href.
function stripTrailingPunct(href: string): string {
  return href.replace(/[.,;:!?)]+$/, '')
}

export function linkifySegments(text: string): LinkSegment[] {
  if (!text) return [{ kind: 'text', value: text }]
  const segments: LinkSegment[] = []
  let last = 0
  for (const m of text.matchAll(URL_RE)) {
    const start = m.index!
    const raw = m[0]
    const href = stripTrailingPunct(raw)
    if (start > last) {
      segments.push({ kind: 'text', value: text.slice(last, start) })
    }
    segments.push({ kind: 'link', raw, href })
    last = start + raw.length
  }
  if (last < text.length) {
    segments.push({ kind: 'text', value: text.slice(last) })
  }
  return segments
}

export function linkifyText(text: string): ReactNode[] {
  return linkifySegments(text).map((seg, i) => {
    if (seg.kind === 'text') return seg.value
    return (
      <a
        key={i}
        href={seg.href}
        target="_blank"
        rel="noopener noreferrer"
        style={{ color: '#1677ff', textDecoration: 'underline' }}
      >
        {seg.raw}
      </a>
    )
  })
}
```

- [ ] **Step 4: 运行测试确认通过**

Run: `cd packages/zai && bun test test/web/linkify.test.ts`
Expected: 9 个 test 全部 PASS.

- [ ] **Step 5: 跑 typecheck 确保无 TS 错误**

Run: `cd packages/zai && bun run typecheck`
Expected: PASS, 无任何 error.

- [ ] **Step 6: 提交**

```bash
cd packages/zai
git add src/web/src/lib/linkify.ts test/web/linkify.test.ts
git commit -m "feat(zai-web): add linkifySegments/linkifyText for bare URL detection"
```

---

## Task 2: 在 `Agent.tsx` 接入 linkify

**Files:**
- Modify: `packages/zai/src/web/src/pages/Agent.tsx` (8 处调用点)
- 顶部 import 加入 `import { linkifyText } from '../lib/linkify.js'`

**Interfaces:**
- Consumes: `linkifyText(text: string): ReactNode[]` (from Task 1)

- [ ] **Step 1: 在 Agent.tsx 顶部添加 import**

读取 `packages/zai/src/web/src/pages/Agent.tsx` 顶部 import 区 (line 1-29). 在最后一行 `import QuestionCard from '../components/QuestionCard.jsx'` 之后追加:

```ts
import { linkifyText } from '../lib/linkify.js'
```

- [ ] **Step 2: 替换用户消息气泡 (line 524-527)**

找到:
```tsx
<Space>
  <UserOutlined />
  <Text>{(msg.text as string) || (msg.prompt as string) || ''}</Text>
</Space>
```

改为:
```tsx
<Space>
  <UserOutlined />
  <Text>{linkifyText((msg.text as string) || (msg.prompt as string) || '')}</Text>
</Space>
```

- [ ] **Step 3: 替换流式期间纯文本渲染 (line 556-578)**

找到流式分支:
```tsx
{streaming ? (
  <div
    style={{
      fontSize: 14,
      lineHeight: 1.6,
      whiteSpace: 'pre-wrap',
      wordBreak: 'break-word',
      color: 'inherit',
    }}
  >
    {text}
    <span ... />
  </div>
) : ...}
```

把 `{text}` 改为 `{linkifyText(text)}`:
```tsx
{streaming ? (
  <div
    style={{
      fontSize: 14,
      lineHeight: 1.6,
      whiteSpace: 'pre-wrap',
      wordBreak: 'break-word',
      color: 'inherit',
    }}
  >
    {linkifyText(text)}
    <span ... />
  </div>
) : ...}
```

- [ ] **Step 4: 替换 ThinkingBlock 展开后文本 (line 253)**

找到:
```tsx
<div
  style={{ ... }}
>
  {text}
</div>
```

把 `{text}` 改为 `{linkifyText(text)}`. 注意: **不动** 折叠态预览 (line 233 `{preview}`), 仅替换展开后的 children 内的 `{text}`.

- [ ] **Step 5: 替换工具调用参数 pre (line 431)**

找到:
```tsx
<pre style={{ ... }}>
  {JSON.stringify(input, null, 2)}
</pre>
```

改为:
```tsx
<pre style={{ ... }}>
  {linkifyText(JSON.stringify(input, null, 2))}
</pre>
```

- [ ] **Step 6: 替换工具调用结果 pre (line 462-464)**

找到:
```tsx
<pre style={{ ... }}>
  {typeof output === 'string'
    ? output
    : JSON.stringify(output, null, 2)}
</pre>
```

改为:
```tsx
<pre style={{ ... }}>
  {linkifyText(
    typeof output === 'string'
      ? output
      : JSON.stringify(output, null, 2),
  )}
</pre>
```

- [ ] **Step 7: 替换工具调用错误 pre (line 493)**

找到:
```tsx
<pre style={{ ... }}>
  {errorText}
</pre>
```

改为:
```tsx
<pre style={{ ... }}>
  {linkifyText(errorText)}
</pre>
```

- [ ] **Step 8: 替换 legacy tool.call pre (line 626)**

找到:
```tsx
<pre style={{ fontSize: 12, margin: 0, whiteSpace: 'pre-wrap' }}>
  {JSON.stringify(args, null, 2)}
</pre>
```

改为:
```tsx
<pre style={{ fontSize: 12, margin: 0, whiteSpace: 'pre-wrap' }}>
  {linkifyText(JSON.stringify(args, null, 2))}
</pre>
```

- [ ] **Step 9: 替换 legacy tool.result pre (line 666)**

找到:
```tsx
<pre
  style={{
    fontSize: 12,
    margin: 0,
    whiteSpace: 'pre-wrap',
    color: isError ? '#ff4d4f' : undefined,
  }}
>
  {typeof result === 'string' ? result : JSON.stringify(result, null, 2)}
</pre>
```

改为:
```tsx
<pre
  style={{
    fontSize: 12,
    margin: 0,
    whiteSpace: 'pre-wrap',
    color: isError ? '#ff4d4f' : undefined,
  }}
>
  {linkifyText(
    typeof result === 'string' ? result : JSON.stringify(result, null, 2),
  )}
</pre>
```

- [ ] **Step 10: 跑 typecheck**

Run: `cd packages/zai && bun run typecheck`
Expected: PASS.

- [ ] **Step 11: 提交**

```bash
cd packages/zai
git add src/web/src/pages/Agent.tsx
git commit -m "feat(zai-web): linkify bare URLs in Agent conversation bubbles"
```

---

## Task 3: 在 `QuestionCard.tsx` 接入 linkify

**Files:**
- Modify: `packages/zai/src/web/src/components/QuestionCard.tsx` (2 处调用点 + import)

**Interfaces:**
- Consumes: `linkifyText(text: string): ReactNode[]` (from Task 1)

- [ ] **Step 1: 添加 import**

读取 `packages/zai/src/web/src/components/QuestionCard.tsx` 顶部. 在 `import { Radio, Checkbox, Tabs, Input, Button, Popconfirm, Tag } from 'antd'` 之后追加:

```ts
import { linkifyText } from '../lib/linkify.js'
```

- [ ] **Step 2: 替换多选 description (line 117-118)**

找到:
```tsx
<Checkbox key={opt.label} value={opt.label}>
  <div>
    <div style={{ fontWeight: 500, color: CARD_FG }}>{opt.label}</div>
    {opt.description && <span style={{ fontSize: 12, color: CARD_FG_MUTED }}>{opt.description}</span>}
    {opt.preview && <PreviewText text={opt.preview} />}
  </div>
</Checkbox>
```

把 description 替换:
```tsx
{opt.description && (
  <span style={{ fontSize: 12, color: CARD_FG_MUTED }}>
    {linkifyText(opt.description)}
  </span>
)}
```

- [ ] **Step 3: 替换单选 description (line 134)**

找到:
```tsx
<Radio key={opt.label} value={opt.label}>
  <div>
    <div style={{ fontWeight: 500, color: CARD_FG }}>{opt.label}</div>
    {opt.description && <span style={{ fontSize: 12, color: CARD_FG_MUTED }}>{opt.description}</span>}
    {opt.preview && <PreviewText text={opt.preview} />}
  </div>
</Radio>
```

把 description 替换:
```tsx
{opt.description && (
  <span style={{ fontSize: 12, color: CARD_FG_MUTED }}>
    {linkifyText(opt.description)}
  </span>
)}
```

- [ ] **Step 4: 跑 typecheck**

Run: `cd packages/zai && bun run typecheck`
Expected: PASS.

- [ ] **Step 5: 提交**

```bash
cd packages/zai
git add src/web/src/components/QuestionCard.tsx
git commit -m "feat(zai-web): linkify bare URLs in QuestionCard option descriptions"
```

---

## Task 4: 跑全部测试 + typecheck 收尾

**Files:** (无代码改动)

- [ ] **Step 1: 跑 zai 包全部 vitest**

Run: `cd packages/zai && bun test`
Expected: 全部 PASS, 包含新加的 `test/web/linkify.test.ts` (9 用例) 与既有 `test/web/useAgentStore.test.ts`.

- [ ] **Step 2: 跑 zai 包 typecheck**

Run: `cd packages/zai && bun run typecheck`
Expected: PASS.

- [ ] **Step 3: 跑 zai 包 web 构建**

Run: `cd packages/zai && bun run build:web`
Expected: vite build 成功, 无 import / syntax 错误.

- [ ] **Step 4: 检查 git log**

Run: `cd packages/zai && git log --oneline -5`
Expected: 看到 3 条新 commit (Task 1 lib+test, Task 2 Agent.tsx, Task 3 QuestionCard.tsx).

---

## Self-Review Checklist

- [x] Spec §2.1 `linkify.ts` 实现 → Task 1
- [x] Spec §2.2 Agent.tsx 8 处替换 → Task 2 steps 2-9
- [x] Spec §2.3 QuestionCard.tsx 2 处替换 → Task 3 steps 2-3
- [x] Spec §3 测试 8 条 → Task 1 step 1 (9 用例覆盖全部)
- [x] 风险: 依赖 React JSX 在 .tsx 文件中, typecheck 通过即保证语法; vitest node 环境无法 import JSX, 故测试只覆盖纯数据 (`linkifySegments`), React 渲染由 typecheck 兜底
- [x] 不动 ReactMarkdown 路径, 不动 ThinkingBlock 折叠态预览, 不动 QuestionCard label/preview
- [x] 无 placeholder / TBD / "类似 Task N"