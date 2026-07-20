# Streaming Markdown Render Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在 `Agent.tsx` 流式输出过程中，已闭合的 markdown 块立即按 Markdown 渲染，仅可能未闭合的尾巴保留为 pre-wrap + 光标。

**Architecture:** 新增 `splitMarkdownOnIncomplete` 纯函数 + `StreamingMarkdown` 组件；后者在 `Agent.tsx` 流式分支内复用现有 `MarkdownText` 与 `markdownComponents`，光标样式与当前一致。仅一处文件改动（`Agent.tsx`）加一个新工具 + 测试。

**Tech Stack:** TypeScript、React、react-markdown、remark-gfm、Vitest。

## Global Constraints

- **Ticket ID**: `HRMSV3-ZN-WEBSITE#668`
- **Commit message format**: `HRMSV3-ZN-WEBSITE#668 <type>(scope): 描述`
- **Typecheck 必须通过**: `cd packages/zai && npm run typecheck`
- **构建必须通过**: `cd packages/zai && npm run build`
- **测试运行**: `cd packages/zai && npm test -- <pattern>`（按文件名匹配，例 `splitMarkdown`）
- **路径约定**: web 端模块用相对 import 加 `.js` 后缀（项目 `module: NodeNext` + `tsc -b` 要求）
- **范围**: 不修改 SSE / store / 后端；`TaskDrawer.tsx` 不动；transcript 历史回放路径不动

---

## File Structure

- **Create** `packages/zai/src/web/src/lib/splitMarkdown.ts` — 纯函数 `splitMarkdownOnIncomplete(text)`
- **Create** `packages/zai/src/web/src/lib/splitMarkdown.test.ts` — vitest 单测
- **Modify** `packages/zai/src/web/src/pages/Agent.tsx` — 在文件作用域新增 `StreamingMarkdown` 组件，把流式分支替换为 `<StreamingMarkdown text={text} />`

---

### Task 1: 纯函数 `splitMarkdownOnIncomplete` (TDD)

**Files:**
- Create: `packages/zai/src/web/src/lib/splitMarkdown.ts`
- Create: `packages/zai/src/web/src/lib/splitMarkdown.test.ts`

**Interfaces:**
- Consumes: 无（无外部依赖）
- Produces: `export function splitMarkdownOnIncomplete(text: string): { complete: string; tail: string }`

- [ ] **Step 1: 写失败测试**

创建 `packages/zai/src/web/src/lib/splitMarkdown.test.ts`：

```ts
import { describe, expect, test } from 'vitest'
import { splitMarkdownOnIncomplete } from './splitMarkdown.js'

describe('splitMarkdownOnIncomplete', () => {
  test('空字符串返回空 complete 与 tail', () => {
    expect(splitMarkdownOnIncomplete('')).toEqual({ complete: '', tail: '' })
  })

  test('无 \\n\\n 的单段全部归 tail', () => {
    expect(splitMarkdownOnIncomplete('Hello **bold')).toEqual({
      complete: '',
      tail: 'Hello **bold',
    })
  })

  test('以 \\n\\n 结尾时 complete 含 \\n\\n, tail 为空', () => {
    expect(splitMarkdownOnIncomplete('Hello\n\n')).toEqual({
      complete: 'Hello\n\n',
      tail: '',
    })
  })

  test('多段, 最后段未结束', () => {
    expect(splitMarkdownOnIncomplete('A\n\nB ')).toEqual({
      complete: 'A\n\n',
      tail: 'B ',
    })
  })

  test('完整闭合围栏 (无语言)', () => {
    expect(splitMarkdownOnIncomplete('```\nx\n```')).toEqual({
      complete: '```\nx\n```',
      tail: '',
    })
  })

  test('完整闭合围栏 (带语言)', () => {
    expect(splitMarkdownOnIncomplete('```python\nx\n```')).toEqual({
      complete: '```python\nx\n```',
      tail: '',
    })
  })

  test('未闭合围栏: complete 为空, tail 含围栏', () => {
    expect(splitMarkdownOnIncomplete('```py\nx\n')).toEqual({
      complete: '',
      tail: '```py\nx\n',
    })
  })

  test('已闭合围栏 + 后续未完 prose', () => {
    expect(splitMarkdownOnIncomplete('```py\nx\n```\nMore')).toEqual({
      complete: '```py\nx\n```\n',
      tail: 'More',
    })
  })

  test('4 个反引号围栏', () => {
    expect(splitMarkdownOnIncomplete('````md\n````')).toEqual({
      complete: '````md\n````',
      tail: '',
    })
  })

  test('围栏内含 \\n\\n 不应误判为段落结束', () => {
    expect(splitMarkdownOnIncomplete('```py\na\n\nb\n```')).toEqual({
      complete: '```py\na\n\nb\n```',
      tail: '',
    })
  })
})
```

- [ ] **Step 2: 跑测试, 确认失败**

```bash
cd packages/zai && npm test -- splitMarkdown
```

预期：FAIL，错误信息 `Failed to resolve import "./splitMarkdown.js" from ... Does the file exist?`

- [ ] **Step 3: 实现函数**

创建 `packages/zai/src/web/src/lib/splitMarkdown.ts`：

```ts
/**
 * 把 markdown 文本切成 [complete, tail]：
 * - complete 是"已完整闭合"的全部内容, 可安全丢给 react-markdown 渲染
 * - tail 是末尾可能未闭合的尾巴, 按 pre-wrap 渲染 (避免出现半截 fence / 半截加粗导致 UI 跳变)
 *
 * 切点规则:
 * 1. 若当前仍处于已开未闭的 fenced code block, 切点为该开启围栏所在行首 ——
 *    围栏内可能含 \n\n, 不能用 \n\n 判定段落边界, 所以先判围栏状态.
 * 2. 否则, 找最后一个 \n\n (段落分隔), 切在该 \n\n 之后.
 * 3. 兜底: 整段归 tail.
 */
export function splitMarkdownOnIncomplete(
  text: string,
): { complete: string; tail: string } {
  if (!text) return { complete: '', tail: '' }

  // 1) 检查是否处于未闭合 fenced code block
  const fenceOpenPos = findOpenFenceStart(text)
  if (fenceOpenPos !== -1) {
    return {
      complete: text.slice(0, fenceOpenPos),
      tail: text.slice(fenceOpenPos),
    }
  }

  // 2) 找最后一个 \n\n
  const lastBlank = text.lastIndexOf('\n\n')
  if (lastBlank === -1) {
    return { complete: '', tail: text }
  }

  // 含 \n\n 本身, 保留块间空行, 后续块继续按 \n\n 边界判断
  return {
    complete: text.slice(0, lastBlank + 2),
    tail: text.slice(lastBlank + 2),
  }
}

/**
 * 行扫描统计 fenced code block 开闭. 开启: 行匹配 `/^\s*\`{3,}\w*\s*$/`
 * (如 ```python); 闭合: 行匹配 `/^\s*\`{3,}\s*$/` (无语言标识).
 * CommonMark 规定闭合标记长度 >= 开启标记长度. 返回已开未闭的开启围栏
 * 所在行首位置; 若所有围栏均闭合, 返回 -1.
 */
function findOpenFenceStart(text: string): number {
  // 匹配一行: 可选前置空白 + 3+ 反引号 + 可选语言 (开启), 或仅 3+ 反引号 (闭合)
  const fenceLine = /^(\s*)(`{3,})(\s*\S*)\s*$/

  let cursor = 0
  let openPos = -1
  let openMarkerLen = 0

  while (cursor <= text.length) {
    const nl = text.indexOf('\n', cursor)
    const lineEnd = nl === -1 ? text.length : nl
    const line = text.slice(cursor, lineEnd)

    const m = fenceLine.exec(line)
    if (m) {
      const indent = m[1] ?? ''
      const marker = m[2] ?? ''
      const rest = (m[3] ?? '').trim()
      if (openPos === -1) {
        // 围栏开启 (有语言标识) 或单独 ``` (无语言, 既可开也可闭)
        // CommonMark: 围栏开启必须能包含 info string; 无 info string 时按闭合处理
        if (rest.length > 0) {
          openPos = cursor + indent.length
          openMarkerLen = marker.length
        }
      } else {
        // 尝试闭合: marker 长度 >= 开启 marker, 且无 info string
        if (marker.length >= openMarkerLen && rest.length === 0) {
          openPos = -1
          openMarkerLen = 0
        }
      }
    }

    if (nl === -1) break
    cursor = nl + 1
  }

  return openPos
}
```

- [ ] **Step 4: 跑测试, 确认通过**

```bash
cd packages/zai && npm test -- splitMarkdown
```

预期：PASS，全部 10 个 case 通过。

- [ ] **Step 5: typecheck**

```bash
cd packages/zai && npm run typecheck
```

预期：通过，无 TS 错误。

- [ ] **Step 6: commit**

```bash
cd /Users/liangxuechao572/code/opencc-web
git add packages/zai/src/web/src/lib/splitMarkdown.ts \
        packages/zai/src/web/src/lib/splitMarkdown.test.ts
git commit -m "HRMSV3-ZN-WEBSITE#668 feat(zai-web): splitMarkdownOnIncomplete 工具 — 切分完整块与未闭合尾巴"
```

---

### Task 2: `StreamingMarkdown` 组件 + 替换 `Agent.tsx` 流式分支

**Files:**
- Modify: `packages/zai/src/web/src/pages/Agent.tsx`

**Interfaces:**
- Consumes: `splitMarkdownOnIncomplete` from `../lib/splitMarkdown.js`; 现有 `MarkdownText` / `markdownComponents` / `linkifyText`
- Produces: 导出/不导出的 `StreamingMarkdown({ text }: { text: string })` 组件，渲染 `{complete && <MarkdownText text={complete} />}{tail && <pre-wrap>...cursor</pre-wrap>}`

- [ ] **Step 1: 在 Agent.tsx 顶部 import 新工具**

`packages/zai/src/web/src/pages/Agent.tsx` 顶部 imports 区，找到 `linkifyText` 的 import 行（同 group 或紧邻）：

```tsx
import { linkifyText } from "../lib/linkify.js";
```

在该行下方追加：

```tsx
import { splitMarkdownOnIncomplete } from "../lib/splitMarkdown.js";
```

- [ ] **Step 2: 新增 `StreamingMarkdown` 组件**

定位：`Agent.tsx` 中 `MarkdownText` 函数定义（line 229-247）**之后** 插入：

```tsx
/**
 * 流式渲染：把 text 切成 [complete, tail]. complete 走 MarkdownText 渲染为结构化 HTML,
 * tail 按 pre-wrap 显示 + 末尾 blink 光标. 仅渲染已完整闭合的块, 避免半截 fence /
 * 半截加粗导致的 UI 跳变 (参见 2026-07-17-streaming-markdown-render-design.md).
 *
 * 光标样式与原流式分支 (line 770-779) 完全一致, 不改 index.css 的 zai-blink keyframes.
 */
function StreamingMarkdown({ text }: { text: string }) {
  const { complete, tail } = useMemo(
    () => splitMarkdownOnIncomplete(text),
    [text],
  );
  return (
    <>
      {complete && <MarkdownText text={complete} />}
      {tail && (
        <div
          style={{
            fontSize: 14,
            lineHeight: 1.6,
            whiteSpace: "pre-wrap",
            wordBreak: "break-word",
            color: "inherit",
          }}
        >
          {linkifyText(tail)}
          <span
            style={{
              display: "inline-block",
              width: 7,
              height: 14,
              verticalAlign: "-2px",
              marginLeft: 2,
              background: "#1677ff",
              animation: "zai-blink 1s steps(1) infinite",
            }}
          />
        </div>
      )}
    </>
  );
}
```

确认 `useMemo` 已在文件顶部 imports（React 自带，line 29 附近）。若没有，添加：

```tsx
import React, { useEffect, useMemo, useRef, useState } from "react";
```

（视文件中已存在的 import 而定；保持现有 import 形态，仅补缺失项。）

- [ ] **Step 3: 替换流式分支**

定位：`Agent.tsx` 中 `MessageBubble` 内的流式分支（line 758-783）：

```tsx
              {streaming ? (
                <div
                  style={{
                    fontSize: 14,
                    lineHeight: 1.6,
                    whiteSpace: "pre-wrap",
                    wordBreak: "break-word",
                    color: "inherit",
                  }}
                >
                  {linkifyText(text)}
                  <span
                    style={{
                      display: "inline-block",
                      width: 7,
                      height: 14,
                      verticalAlign: "-2px",
                      marginLeft: 2,
                      background: "#1677ff",
                      animation: "zai-blink 1s steps(1) infinite",
                    }}
                  />
                </div>
              ) : (
                <MarkdownText text={text} />
              )}
```

整段替换为：

```tsx
              {streaming ? (
                <StreamingMarkdown text={text} />
              ) : (
                <MarkdownText text={text} />
              )}
```

- [ ] **Step 4: typecheck**

```bash
cd packages/zai && npm run typecheck
```

预期：通过。

- [ ] **Step 5: 跑测试 (含历史回归)**

```bash
cd packages/zai && npm test
```

预期：所有测试通过（含 splitMarkdown、TaskDrawer、Agent 等历史用例）。

- [ ] **Step 6: 构建**

```bash
cd packages/zai && npm run build
```

预期：通过；输出 `dist/web/index.html` 与 chunks。

- [ ] **Step 7: commit**

```bash
cd /Users/liangxuechao572/code/opencc-web
git add packages/zai/src/web/src/pages/Agent.tsx
git commit -m "HRMSV3-ZN-WEBSITE#668 feat(zai-web): 流式 Markdown 增量渲染, 完整块立即结构化"
```

---

### Task 3: 手动验收 (可选, 不阻塞 ship)

**Files:** 无

- [ ] **Step 1: 启动 dev server**

```bash
cd packages/zai && npm run dev
```

- [ ] **Step 2: 发起包含多段 + 代码块 + 列表的 prompt**

例如：「请用 markdown 写一个 Python 示例, 包含说明段落、列表、表格和一个 ```python 代码块」。

预期观察：
- 流式过程中：标题、列表、已闭合代码块立即按结构化渲染
- 最后一段未闭合的纯文本 + 蓝色光标正常显示
- 整段流式结束时, 整段按 MarkdownText 渲染, 与流式最终态视觉一致

- [ ] **Step 3: 切到历史 transcript 回放**

打开侧栏任一历史会话, 验证其 assistant.text 仍按 MarkdownText 整段渲染（不带光标），行为不变。

---

## Self-Review Checklist

- [x] **Spec 覆盖**：需求（已闭合块即时渲染）/ 方案（splitMarkdown + StreamingMarkdown）/ 边界（10 个测试用例）/ 范围（仅改 Agent.tsx 流式分支）/ 非目标 全部对应到 task
- [x] **占位符扫描**：无 TBD/TODO
- [x] **类型一致性**：`splitMarkdownOnIncomplete` 签名在 Task 1 定义，Task 2 调用一致；`StreamingMarkdown` 在 Task 2 定义并直接 inline 使用，不导出，组件名引用一致
- [x] **测试先行**：Task 1 完整 TDD（测试 → 跑失败 → 实现 → 跑通过）
- [x] **commit 频繁**：Task 1 / Task 2 各一个 commit，粒度合理
- [x] **命令可执行**：所有 cd 路径在仓库内可运行