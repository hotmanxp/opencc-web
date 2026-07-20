# zai 对话消息 Copy 功能 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 给 zai Agent transcript 的 `user.text` / `assistant.text` 气泡加一个始终可见的 Copy 按钮,点击后把整段文字(markdown 原文 / 用户原始纯文本)复制到剪贴板,expanded 与 collapsed 两套视图同步支持。

**Architecture:** 抽 `lib/clipboard.ts` 公共 util(`navigator.clipboard` 优先 + `document.execCommand` fallback),在 `MessageBubble.tsx` 内新增 `MessageCopyButton` 组件并 export 给 `CollapsedMessageBubble.tsx` 复用;在两类气泡的 Card 右上角绝对定位嵌入。

**Tech Stack:** React 18 + AntD 5(`Button` / `message` / `@ant-design/icons` `CopyOutlined` / `CheckOutlined`) + vitest + happy-dom + @testing-library/react

**Spec:** `docs/superpowers/specs/2026-07-20-zai-message-copy-design.md`

## File Structure

```
新增:
  packages/zai/src/web/src/lib/clipboard.ts                     (util, ~30 行)
  packages/zai/src/web/src/lib/clipboard.test.ts                (单测, ~50 行)
  packages/zai/src/web/src/components/transcript/CollapsedMessageBubble.test.tsx (单测, ~80 行)

修改:
  packages/zai/src/web/src/components/transcript/MessageBubble.tsx
    - 新增 MessageCopyButton 组件 (named export, 供 CollapsedMessageBubble 与测试 import)
    - user.text 分支 Card 加 position:relative + 内嵌 <MessageCopyButton text={visibleText} variant="user" />
    - assistant.text 分支 Card 加 position:relative + 内嵌 <MessageCopyButton text={text} variant="ai" />
    - 不动 thinking / tool_use / runtime.error / legacy tool.call|tool.result / content_block_delta

  packages/zai/src/web/src/components/transcript/MessageBubble.test.tsx
    - 追加 describe('MessageCopyButton', ...) 5 个
    - 追加 describe('MessageBubble — copy button integration', ...) 6 个

  packages/zai/src/web/src/components/transcript/CollapsedMessageBubble.tsx
    - import { MessageCopyButton } from './MessageBubble.js'
    - user.text / assistant.text 两个分支 Card 加 position:relative + 内嵌按钮

  packages/zai/src/web/src/components/ConversationInfoCard.tsx
    - 替换内联 copy 逻辑为 import { copyToClipboard } from '../lib/clipboard.js'
    - 行为完全等价(只去重, 不加新功能)
```

---

## Global Constraints

- React 18 + AntD 5,`Button` / `message` / `CopyOutlined` / `CheckOutlined` 从现有 import 路径(`antd` / `@ant-design/icons`)
- 单测环境 `@vitest-environment happy-dom`,与 `MessageBubble.test.tsx:1` 同款
- antd mock 用 `vi.mock('antd', () => ({ message: msgMock }))`,与 `lib/sse.test.ts:5` 模式一致
- 复制成功 toast 文案: `message.success('已复制')`;失败: `message.warning('复制失败, 请手动选中')`(中文)
- 按钮位置 `position: absolute; top: 8; right: 8; zIndex: 1;`,父 Card 加 `position: 'relative'`
- 复制 AI 消息用 `msg.text` 原文(markdown 语法保留);复制 user 消息用 `visibleText`(`msg.text || msg.prompt`,不复制 isRenderedPrompt 第二行)
- Timer 1.5s,`clearTimeout` 防重入,`useEffect` cleanup 防 setState on unmounted

---

## Task 1: 抽 `lib/clipboard.ts` 公共 util (TDD)

**Files:**
- Create: `packages/zai/src/web/src/lib/clipboard.ts`
- Test: `packages/zai/src/web/src/lib/clipboard.test.ts`

**Interfaces:**
- Produces: `export async function copyToClipboard(text: string): Promise<boolean>`
  - `true` = 复制成功(`navigator.clipboard.writeText` 或 `execCommand('copy')` 至少一条路径成功)
  - `false` = 两条路径都失败(抛错或返回 false)
  - **不抛**,调用方根据 boolean 决定 UI 反馈

### Step 1: 写失败的测试

写入 `packages/zai/src/web/src/lib/clipboard.test.ts`:

```typescript
// @vitest-environment happy-dom
import { describe, expect, test, vi } from 'vitest'
import { copyToClipboard } from './clipboard.js'

describe('copyToClipboard', () => {
  test('navigator.clipboard.writeText 可用时, 调用之并返回 true', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined)
    vi.stubGlobal('navigator', { clipboard: { writeText } })
    const ok = await copyToClipboard('hello')
    expect(writeText).toHaveBeenCalledWith('hello')
    expect(ok).toBe(true)
  })

  test('writeText 抛错时 fallback 到 execCommand 并返回 true', async () => {
    const writeText = vi.fn().mockRejectedValue(new Error('denied'))
    vi.stubGlobal('navigator', { clipboard: { writeText } })
    const execSpy = vi.spyOn(document, 'execCommand').mockReturnValue(true)
    const ok = await copyToClipboard('hello')
    expect(execSpy).toHaveBeenCalledWith('copy')
    expect(ok).toBe(true)
  })

  test('writeText 抛错且 execCommand 返回 false 时, 返回 false 且不抛', async () => {
    const writeText = vi.fn().mockRejectedValue(new Error('denied'))
    vi.stubGlobal('navigator', { clipboard: { writeText } })
    const execSpy = vi.spyOn(document, 'execCommand').mockReturnValue(false)
    await expect(copyToClipboard('hello')).resolves.toBe(false)
    expect(execSpy).toHaveBeenCalledWith('copy')
  })

  test('navigator.clipboard 整个不存在时, 直接走 execCommand', async () => {
    vi.stubGlobal('navigator', {})
    const execSpy = vi.spyOn(document, 'execCommand').mockReturnValue(true)
    const ok = await copyToClipboard('plain')
    expect(execSpy).toHaveBeenCalledWith('copy')
    expect(ok).toBe(true)
  })

  test('execCommand 抛错时返回 false', async () => {
    vi.stubGlobal('navigator', {})
    vi.spyOn(document, 'execCommand').mockImplementation(() => {
      throw new Error('blocked')
    })
    await expect(copyToClipboard('x')).resolves.toBe(false)
  })
})
```

### Step 2: 跑测试,确认失败

Run: `cd packages/zai && npx vitest run src/web/src/lib/clipboard.test.ts`
Expected: FAIL with `Failed to resolve import "./clipboard.js"` 或 module not found

### Step 3: 写最小实现

写入 `packages/zai/src/web/src/lib/clipboard.ts`:

```typescript
// copyToClipboard: navigator.clipboard.writeText 优先, 失败 fallback 到 textarea + execCommand.
// 返回 boolean 而非抛错, 让调用方根据成败决定 UI 反馈(✓ / warning toast).
// 不抛是设计选择: 复制是 best-effort UX 增强, 不应阻塞对话流.

export async function copyToClipboard(text: string): Promise<boolean> {
  if (typeof navigator !== 'undefined' && navigator.clipboard?.writeText) {
    try {
      await navigator.clipboard.writeText(text)
      return true
    } catch {
      // fall through to legacy path
    }
  }
  if (typeof document === 'undefined') return false
  try {
    const ta = document.createElement('textarea')
    ta.value = text
    ta.style.position = 'fixed'
    ta.style.opacity = '0'
    document.body.appendChild(ta)
    ta.select()
    const ok = document.execCommand('copy')
    document.body.removeChild(ta)
    return ok
  } catch {
    return false
  }
}
```

### Step 4: 跑测试,确认通过

Run: `cd packages/zai && npx vitest run src/web/src/lib/clipboard.test.ts`
Expected: PASS, 5 个 test 全过

### Step 5: 提交

```bash
cd /Users/ethan/code/opencc-web
git add packages/zai/src/web/src/lib/clipboard.ts packages/zai/src/web/src/lib/clipboard.test.ts
git commit -m "feat(zai-web): extract copyToClipboard util

navigator.clipboard 优先 + execCommand fallback, 返回 boolean 不抛错.
供 MessageBubble / CollapsedMessageBubble 复用, 替代 ConversationInfoCard
内联实现."
```

---

## Task 2: `ConversationInfoCard.tsx` 切到公共 util

**Files:**
- Modify: `packages/zai/src/web/src/components/ConversationInfoCard.tsx`

**Interfaces:**
- Consumes: `copyToClipboard` from `../lib/clipboard.js`

> 顺手清理,验证 util 在已有 caller 下等价工作。本 task 不需要新测试(行为完全等价)。

### Step 1: 修改 import 与函数

编辑 `packages/zai/src/web/src/components/ConversationInfoCard.tsx`:

在 `import { Button, Descriptions, message, Typography } from 'antd'` 行**之后**插入:

```typescript
import { copyToClipboard } from '../lib/clipboard.js'
```

删除整个本地 `async function copyToClipboard(text: string): Promise<void>` 块(`ConversationInfoCard.tsx:20-39`),完整替换为上面那行 import 即可(本文件不再定义本地 copy 函数)。

修改 `handleCopy` (`ConversationInfoCard.tsx:54-64`),完整替换为:

```typescript
const handleCopy = async (e: React.MouseEvent) => {
  e.stopPropagation()
  e.preventDefault()
  const ok = await copyToClipboard(info.sessionId!)
  if (ok) message.success('已复制 sessionId')
  else message.warning('复制失败, 请手动选中')
}
```

### Step 2: typecheck

Run: `cd packages/zai && npx tsc -b --noEmit`
Expected: 无报错

### Step 3: 跑已有 zai 测试,确认无回归

Run: `cd packages/zai && npx vitest run`
Expected: 全部 PASS

### Step 4: 提交

```bash
cd /Users/ethan/code/opencc-web
git add packages/zai/src/web/src/components/ConversationInfoCard.tsx
git commit -m "refactor(zai-web): ConversationInfoCard 使用公共 clipboard util

行为不变, 仅去重 + 改用 boolean 返回替代 try/catch."
```

---

## Task 3: `MessageCopyButton` 组件 (TDD)

**Files:**
- Modify: `packages/zai/src/web/src/components/transcript/MessageBubble.tsx`
- Modify: `packages/zai/src/web/src/components/transcript/MessageBubble.test.tsx`

**Interfaces:**
- Produces: `export function MessageCopyButton({ text, variant }: { text: string; variant: 'ai' | 'user' })`
  - 渲染 antd `Button`(`type="text"`, `size="small"`, icon 在 `CopyOutlined` / `CheckOutlined` 之间切换)
  - 点击成功复制 `text` → `setCopied(true)` + `message.success('已复制')` + 1.5s 后复原
  - 点击失败 → `message.warning('复制失败, 请手动选中')`,按钮状态不变
  - `e.stopPropagation() + e.preventDefault()` 防 click 冒泡
  - `useEffect` cleanup 里 `clearTimeout`

### Step 1: 写失败的测试

编辑 `packages/zai/src/web/src/components/transcript/MessageBubble.test.tsx`,在文件末尾追加:

```typescript
import { fireEvent } from '@testing-library/react'
import { MessageCopyButton } from './MessageBubble.js'

const msgMock = vi.hoisted(() => ({ success: vi.fn(), warning: vi.fn() }))
vi.mock('antd', () => ({ message: msgMock }))

describe('MessageCopyButton', () => {
  beforeEach(() => {
    msgMock.success.mockReset()
    msgMock.warning.mockReset()
  })

  test('渲染默认 Copy 按钮, aria-label 区分 ai/user', () => {
    render(<MessageCopyButton text="hello" variant="ai" />)
    expect(screen.getByLabelText('复制助手回答')).toBeInTheDocument()
    render(<MessageCopyButton text="hi" variant="user" />)
    expect(screen.getByLabelText('复制用户消息')).toBeInTheDocument()
  })

  test('点击复制成功: 调用 writeText, 弹 message.success, 不弹 warning', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined)
    vi.stubGlobal('navigator', { clipboard: { writeText } })
    render(<MessageCopyButton text="markdown body" variant="ai" />)
    fireEvent.click(screen.getByLabelText('复制助手回答'))
    await vi.waitFor(() => {
      expect(writeText).toHaveBeenCalledWith('markdown body')
    })
    expect(msgMock.success).toHaveBeenCalledWith('已复制')
    expect(msgMock.warning).not.toHaveBeenCalled()
  })

  test('复制成功后按钮不卸载 (aria-label 仍可定位)', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined)
    vi.stubGlobal('navigator', { clipboard: { writeText } })
    render(<MessageCopyButton text="x" variant="user" />)
    fireEvent.click(screen.getByLabelText('复制用户消息'))
    await vi.waitFor(() => {
      expect(msgMock.success).toHaveBeenCalled()
    })
    expect(screen.getByLabelText('复制用户消息')).toBeInTheDocument()
  })

  test('复制失败时弹 message.warning, 不弹 success', async () => {
    vi.stubGlobal('navigator', {})
    vi.spyOn(document, 'execCommand').mockReturnValue(false)
    render(<MessageCopyButton text="x" variant="ai" />)
    fireEvent.click(screen.getByLabelText('复制助手回答'))
    await vi.waitFor(() => {
      expect(msgMock.warning).toHaveBeenCalledWith('复制失败, 请手动选中')
    })
    expect(msgMock.success).not.toHaveBeenCalled()
  })

  test('点击不冒泡 (e.stopPropagation 调用过)', () => {
    const writeText = vi.fn().mockResolvedValue(undefined)
    vi.stubGlobal('navigator', { clipboard: { writeText } })
    const parentClick = vi.fn()
    render(
      <div onClick={parentClick}>
        <MessageCopyButton text="x" variant="ai" />
      </div>,
    )
    fireEvent.click(screen.getByLabelText('复制助手回答'))
    expect(parentClick).not.toHaveBeenCalled()
  })
})
```

### Step 2: 跑测试,确认失败

Run: `cd packages/zai && npx vitest run src/web/src/components/transcript/MessageBubble.test.tsx`
Expected: FAIL(`MessageCopyButton` 未导出, import 报错)

### Step 3: 实现 `MessageCopyButton` 组件

编辑 `packages/zai/src/web/src/components/transcript/MessageBubble.tsx`:

1. 修改现有 `import React, { useState, useEffect, useMemo } from "react"` 为 `import React, { useState, useEffect, useMemo, useRef } from "react"`。

2. 在 `@ant-design/icons` 的 import 行追加 `CheckOutlined`,即:

```typescript
import {
  RobotFilled,
  UserOutlined,
  ToolOutlined,
  BulbOutlined,
  CaretDownOutlined,
  CaretRightOutlined,
  CopyOutlined,
  CheckOutlined,
} from "@ant-design/icons";
```

3. 在 `antd` 的 import 行追加 `message`,即:

```typescript
import { Card, Collapse, Modal, Space, Tag, Typography, message } from "antd";
```

4. 在 `AttachmentStrip` 的 import 行**之后**追加:

```typescript
import { copyToClipboard } from "../../lib/clipboard.js";
```

5. 在 `ToolUsePill` 函数定义之前(`MessageBubble.tsx:466` 之前)插入 `MessageCopyButton`:

```typescript
// 气泡右上角 copy 按钮: 始终可见, 点击后 1.5s 内图标变 ✓.
// e.stopPropagation 防 click 冒泡到 Card 内部 (Collapse/链接).
// timerRef + useEffect cleanup 防组件卸载时 setState on unmounted component.
export function MessageCopyButton({
  text,
  variant,
}: {
  text: string;
  variant: "ai" | "user";
}) {
  const [copied, setCopied] = useState(false);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(
    () => () => {
      if (timerRef.current) clearTimeout(timerRef.current);
    },
    [],
  );

  const handleClick = async (e: React.MouseEvent) => {
    e.stopPropagation();
    e.preventDefault();
    const ok = await copyToClipboard(text);
    if (!ok) {
      message.warning("复制失败, 请手动选中");
      return;
    }
    setCopied(true);
    message.success("已复制");
    if (timerRef.current) clearTimeout(timerRef.current);
    timerRef.current = setTimeout(() => setCopied(false), 1500);
  };

  return (
    <Button
      type="text"
      size="small"
      icon={copied ? <CheckOutlined /> : <CopyOutlined />}
      onClick={handleClick}
      title="复制"
      aria-label={variant === "ai" ? "复制助手回答" : "复制用户消息"}
      style={{
        position: "absolute",
        top: 8,
        right: 8,
        zIndex: 1,
        background: "rgba(255,255,255,0.06)",
        borderRadius: 4,
        opacity: 0.85,
      }}
    />
  );
}
```

### Step 4: 跑测试,确认通过

Run: `cd packages/zai && npx vitest run src/web/src/components/transcript/MessageBubble.test.tsx`
Expected: PASS, 原 isRenderedPrompt 2 个 + 新 MessageCopyButton 5 个 = 7 个 test 全过

### Step 5: typecheck

Run: `cd packages/zai && npx tsc -b --noEmit`
Expected: 无报错

### Step 6: 提交

```bash
cd /Users/ethan/code/opencc-web
git add packages/zai/src/web/src/components/transcript/MessageBubble.tsx \
        packages/zai/src/web/src/components/transcript/MessageBubble.test.tsx
git commit -m "feat(zai-web): add MessageCopyButton component

气泡右上角 Copy 按钮: 始终可见, 点击复制文本到剪贴板,
成功 ✓ + 1.5s 复原 + success toast, 失败 warning toast.
timer cleanup + stopPropagation 防泄漏 / 冒泡."
```

---

## Task 4: `MessageBubble` user.text / assistant.text 嵌入 Copy 按钮

**Files:**
- Modify: `packages/zai/src/web/src/components/transcript/MessageBubble.tsx`
- Modify: `packages/zai/src/web/src/components/transcript/MessageBubble.test.tsx`

**Interfaces:**
- Consumes: 已存在的 `MessageCopyButton` (Task 3)

### Step 1: 写集成测试

编辑 `packages/zai/src/web/src/components/transcript/MessageBubble.test.tsx`,在 `MessageCopyButton` describe 块之后追加:

```typescript
describe('MessageBubble — copy button integration', () => {
  const writeText = vi.fn().mockResolvedValue(undefined)

  beforeEach(() => {
    msgMock.success.mockReset()
    msgMock.warning.mockReset()
    vi.stubGlobal('navigator', { clipboard: { writeText } })
    writeText.mockClear()
  })

  test('assistant.text 气泡渲染 Copy 按钮', () => {
    render(
      <MessageBubble
        msg={{
          eventId: 'a-1',
          sessionId: 'sess-1',
          ts: 1,
          turnIndex: 0,
          type: 'assistant.text',
          text: 'AI reply',
        }}
      />,
    )
    expect(screen.getByLabelText('复制助手回答')).toBeInTheDocument()
  })

  test('user.text 气泡渲染 Copy 按钮', () => {
    render(
      <MessageBubble
        msg={{
          eventId: 'u-1',
          sessionId: 'sess-1',
          ts: 1,
          turnIndex: 0,
          type: 'user.text',
          text: 'user msg',
        }}
      />,
    )
    expect(screen.getByLabelText('复制用户消息')).toBeInTheDocument()
  })

  test('assistant.thinking 路径不渲染 Copy 按钮', () => {
    const { container } = render(
      <MessageBubble
        msg={{
          eventId: 't-1',
          sessionId: 'sess-1',
          ts: 1,
          turnIndex: 0,
          type: 'assistant.thinking',
          text: 'thinking content',
        }}
      />,
    )
    expect(container.querySelector('[aria-label="复制助手回答"]')).toBeNull()
    expect(container.querySelector('[aria-label="复制用户消息"]')).toBeNull()
  })

  test('tool_use:start 路径不渲染 Copy 按钮', () => {
    const { container } = render(
      <MessageBubble
        msg={{
          eventId: 'tool-1',
          sessionId: 'sess-1',
          ts: 1,
          turnIndex: 0,
          type: 'tool_use:start',
          toolUseId: 'tu-1',
          name: 'Bash',
          input: { command: 'ls' },
        }}
      />,
    )
    expect(container.querySelector('[aria-label="复制助手回答"]')).toBeNull()
    expect(container.querySelector('[aria-label="复制用户消息"]')).toBeNull()
  })

  test('点击 assistant Copy 按钮复制 msg.text', async () => {
    render(
      <MessageBubble
        msg={{
          eventId: 'a-2',
          sessionId: 'sess-1',
          ts: 1,
          turnIndex: 0,
          type: 'assistant.text',
          text: '```ts\nconst x = 1\n```',
        }}
      />,
    )
    fireEvent.click(screen.getByLabelText('复制助手回答'))
    await vi.waitFor(() => {
      expect(writeText).toHaveBeenCalledWith('```ts\nconst x = 1\n```')
    })
  })

  test('点击 user Copy 按钮复制 visibleText, 不含 isRenderedPrompt 第二行', async () => {
    render(
      <MessageBubble
        msg={{
          eventId: 'u-2',
          sessionId: 'sess-1',
          ts: 1,
          turnIndex: 0,
          type: 'user.text',
          text: '原始问题',
          isRenderedPrompt: true,
        }}
      />,
    )
    fireEvent.click(screen.getByLabelText('复制用户消息'))
    await vi.waitFor(() => {
      expect(writeText).toHaveBeenCalledWith('原始问题')
    })
    const calledWith = writeText.mock.calls[0]?.[0] ?? ''
    expect(calledWith).not.toContain('渲染后')
  })
})
```

### Step 2: 跑测试,确认失败

Run: `cd packages/zai && npx vitest run src/web/src/components/transcript/MessageBubble.test.tsx`
Expected: 前 4 个测试 FAIL(按钮未渲染);tool_use:start 1 个 PASS(原本就没按钮)

### Step 3: 修改 user.text 分支

编辑 `packages/zai/src/web/src/components/transcript/MessageBubble.tsx` 的 user.text 分支:

找到 user.text 的 Card 起始(在 `msgAttachments.length > 0 && (` 之前),完整 Card 块改写为(在 `style` 内追加 `position: "relative"`,在 `<Card>` 紧邻 `<` 之后插入 `<MessageCopyButton>`):

```typescript
        <Card
          size="small"
          style={{
            maxWidth: "70%",
            background: "#e6f4ff",
            borderRadius: 12,
            position: "relative",
          }}
        >
          <MessageCopyButton text={visibleText} variant="user" />
          {msgAttachments.length > 0 && (
```

### Step 4: 修改 assistant.text 分支

编辑 `MessageBubble.tsx` 的 assistant.text 分支:

找到 assistant.text 的 Card 起始(在 `<Space align="start" size={8} style={{ width: "100%" }}>` 之前),完整 Card 块改写为:

```typescript
        <Card
          size="small"
          style={{
            width: "100%",
            maxWidth: "100%",
            marginRight: 20,
            background: "#f6ffed",
            borderRadius: 12,
            position: "relative",
          }}
        >
          <MessageCopyButton text={text} variant="ai" />
          <Space align="start" size={8} style={{ width: "100%" }}>
            <RobotFilled style={{ color: "#ff6600", fontSize: 18 }} />
            <div style={{ flex: 1, minWidth: 0 }}>
              {streaming ? (
                <StreamingMarkdown text={text} />
              ) : (
                <MarkdownText text={text} />
              )}
            </div>
          </Space>
        </Card>
```

### Step 5: 跑测试,确认通过

Run: `cd packages/zai && npx vitest run src/web/src/components/transcript/MessageBubble.test.tsx`
Expected: PASS,所有 describe 块(包括集成 6 个)全过

### Step 6: typecheck

Run: `cd packages/zai && npx tsc -b --noEmit`
Expected: 无报错

### Step 7: 提交

```bash
cd /Users/ethan/code/opencc-web
git add packages/zai/src/web/src/components/transcript/MessageBubble.tsx \
        packages/zai/src/web/src/components/transcript/MessageBubble.test.tsx
git commit -m "feat(zai-web): MessageBubble 嵌入 Copy 按钮

user.text / assistant.text 两个 Card 右上角加 MessageCopyButton.
thinking / tool_use / runtime.error / legacy tool.call|tool.result
不在范围, 不加按钮."
```

---

## Task 5: `CollapsedMessageBubble` 嵌入 Copy 按钮

**Files:**
- Modify: `packages/zai/src/web/src/components/transcript/CollapsedMessageBubble.tsx`
- Create: `packages/zai/src/web/src/components/transcript/CollapsedMessageBubble.test.tsx`

**Interfaces:**
- Consumes: `MessageCopyButton` from `./MessageBubble.js` (Task 3)

### Step 1: 写失败的测试

写入 `packages/zai/src/web/src/components/transcript/CollapsedMessageBubble.test.tsx`:

```typescript
// @vitest-environment happy-dom
import { describe, expect, test, vi, beforeEach } from 'vitest'
import '@testing-library/jest-dom'
import { render, screen, fireEvent } from '@testing-library/react'
import { CollapsedMessageBubble } from './CollapsedMessageBubble.js'

const msgMock = vi.hoisted(() => ({ success: vi.fn(), warning: vi.fn() }))
vi.mock('antd', () => ({ message: msgMock }))

describe('CollapsedMessageBubble — copy button', () => {
  const writeText = vi.fn().mockResolvedValue(undefined)

  beforeEach(() => {
    msgMock.success.mockReset()
    msgMock.warning.mockReset()
    vi.stubGlobal('navigator', { clipboard: { writeText } })
    writeText.mockClear()
  })

  test('assistant.text 气泡渲染 Copy 按钮', () => {
    render(
      <CollapsedMessageBubble
        message={
          {
            eventId: 'a-1',
            sessionId: 'sess-1',
            ts: 1,
            turnIndex: 0,
            type: 'assistant.text',
            text: 'collapsed AI text',
          } as any
        }
      />,
    )
    expect(screen.getByLabelText('复制助手回答')).toBeInTheDocument()
  })

  test('user.text 气泡渲染 Copy 按钮', () => {
    render(
      <CollapsedMessageBubble
        message={
          {
            eventId: 'u-1',
            sessionId: 'sess-1',
            ts: 1,
            turnIndex: 0,
            type: 'user.text',
            text: 'collapsed user text',
          } as any
        }
      />,
    )
    expect(screen.getByLabelText('复制用户消息')).toBeInTheDocument()
  })

  test('点击 assistant Copy 按钮复制 msg.text', async () => {
    render(
      <CollapsedMessageBubble
        message={
          {
            eventId: 'a-2',
            sessionId: 'sess-1',
            ts: 1,
            turnIndex: 0,
            type: 'assistant.text',
            text: 'AI markdown here',
          } as any
        }
      />,
    )
    fireEvent.click(screen.getByLabelText('复制助手回答'))
    await vi.waitFor(() => {
      expect(writeText).toHaveBeenCalledWith('AI markdown here')
    })
  })

  test('点击 user Copy 按钮复制 msg.text', async () => {
    render(
      <CollapsedMessageBubble
        message={
          {
            eventId: 'u-2',
            sessionId: 'sess-1',
            ts: 1,
            turnIndex: 0,
            type: 'user.text',
            text: 'user raw input',
          } as any
        }
      />,
    )
    fireEvent.click(screen.getByLabelText('复制用户消息'))
    await vi.waitFor(() => {
      expect(writeText).toHaveBeenCalledWith('user raw input')
    })
  })
})
```

### Step 2: 跑测试,确认失败

Run: `cd packages/zai && npx vitest run src/web/src/components/transcript/CollapsedMessageBubble.test.tsx`
Expected: FAIL(`MessageCopyButton` 未从 `./MessageBubble.js` 导出 / 按钮未渲染)

### Step 3: 修改 import 区域

编辑 `packages/zai/src/web/src/components/transcript/CollapsedMessageBubble.tsx`:

找到:
```typescript
import { MarkdownText, StreamingMarkdown, ThinkingBlock } from './MessageBubble.js'
```

替换为:
```typescript
import { MarkdownText, MessageCopyButton, StreamingMarkdown, ThinkingBlock } from './MessageBubble.js'
```

### Step 4: 修改 user.text 分支

编辑 `CollapsedMessageBubble.tsx` user.text 分支的 Card 行:

找到:
```typescript
        <Card size="small" style={{ maxWidth: '70%', borderRadius: 12 }}>
          <Space>
            <UserOutlined />
            <Paragraph
```

替换为:
```typescript
        <Card size="small" style={{ maxWidth: '70%', borderRadius: 12, position: 'relative' }}>
          <MessageCopyButton text={text} variant="user" />
          <Space>
            <UserOutlined />
            <Paragraph
```

### Step 5: 修改 assistant.text 分支

编辑 `CollapsedMessageBubble.tsx` assistant.text 分支的 Card 行:

找到:
```typescript
        <Card
          size="small"
          style={{ width: '100%', maxWidth: '100%', borderRadius: 12 }}
        >
          <Space align="start" size={8} style={{ width: '100%' }}>
```

替换为:
```typescript
        <Card
          size="small"
          style={{ width: '100%', maxWidth: '100%', borderRadius: 12, position: 'relative' }}
        >
          <MessageCopyButton text={(m.text as string) || ''} variant="ai" />
          <Space align="start" size={8} style={{ width: '100%' }}>
```

### Step 6: 跑测试,确认通过

Run: `cd packages/zai && npx vitest run src/web/src/components/transcript/CollapsedMessageBubble.test.tsx`
Expected: PASS,4 个 test 全过

### Step 7: typecheck

Run: `cd packages/zai && npx tsc -b --noEmit`
Expected: 无报错

### Step 8: 提交

```bash
cd /Users/ethan/code/opencc-web
git add packages/zai/src/web/src/components/transcript/CollapsedMessageBubble.tsx \
        packages/zai/src/web/src/components/transcript/CollapsedMessageBubble.test.tsx
git commit -m "feat(zai-web): CollapsedMessageBubble 嵌入 Copy 按钮

collapsed 视图 user.text / assistant.text Card 右上角加 MessageCopyButton.
复用 MessageBubble 导出的 MessageCopyButton, 行为与 expanded 视图一致."
```

---

## Task 6: 端到端验证

**Files:** 无修改

### Step 1: 跑全部 zai 测试,确认无回归

Run: `cd packages/zai && npx vitest run`
Expected: 全部 PASS,包含新增:
- `src/web/src/lib/clipboard.test.ts`(5)
- `src/web/src/components/transcript/MessageBubble.test.tsx`(原 2 + MessageCopyButton 5 + 集成 6 = 13)
- `src/web/src/components/transcript/CollapsedMessageBubble.test.tsx`(4)

### Step 2: 全包 typecheck

Run: `cd packages/zai && npx tsc -b --noEmit`
Expected: 无报错

### Step 3: 手工冒烟(可选, 仅在 dev 环境)

Run: `cd packages/zai && npm run dev`
人工验证清单(对应 spec §5.2 手动验收):
1. assistant 气泡右上角小 Copy 图标 → 点击 → toast + ✓ + 1.5s 复原
2. 粘贴到 IDE 保留 markdown 围栏
3. user 消息同样行为, 粘贴为纯文本
4. `isRenderedPrompt: true` 只复制第一行
5. streaming 中途复制 → 复制当前累计
6. collapsed 视图同样行为
7. thinking / tool_use 块无 Copy 按钮
8. http 环境(走 fallback)仍可用

如发现偏差, 修复后回到对应 task 补一个回归 test, 不要在本 task 里硬塞临时修复.

---

## Self-Review Notes (执行前的最后检查)

执行时若发现:
- MessageBubble.tsx 行号与本 plan 引用不一致(import 顺序 / 行数偏移) → 用 `grep -n` 重新定位, 不要硬照搬行号
- antd `Button` 在 happy-dom 下渲染的 DOM 结构与生产不同(罕见) → 测试失败时先看 DOM, 再判断是否要换 `getByRole`
- happy-dom 不实现 `navigator.clipboard` → 用 `vi.stubGlobal('navigator', { clipboard: { writeText } })` 注入 mock, 不要改产品代码适配测试
- 跨 task 依赖顺序: Task 1 → Task 2/3/5 都能用 util;Task 3 必须先 export `MessageCopyButton`, Task 4/5 才能 import