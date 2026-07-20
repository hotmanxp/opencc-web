# zai 对话消息 Copy 功能 — Design

> **Spec for**: zai — Agent 对话气泡(user.text / assistant.text)单条文字 copy 功能
> **Date**: 2026-07-20
> **Status**: Draft (awaiting user review)

## 1. 概述与背景

### 1.1 问题

zai Web 前端当前在 Agent transcript 里**没有任何"复制单条消息"**的能力:

- `MessageBubble.tsx`(expanded 视图)与 `CollapsedMessageBubble.tsx`(collapsed 视图)只渲染文本,用户要从一段 Markdown 回答里复制一行,只能手动鼠标选中。
- 现有唯一的 copy 路径在 `ConversationInfoCard.tsx:20-39`,只用于复制 `sessionId`,逻辑内联在组件里、不可复用。
- 用户在调试 / 写 issue / 引用回话时常说"我想把这一段回答贴出去"。

### 1.2 目标

在每条 user.text / assistant.text 气泡右上角加一个 **始终可见的小 Copy 按钮**,点击后:

- 整段文字(原始 markdown 文本,代码块围栏 / 列表 / 链接语法保留)被复制到系统剪贴板
- 按钮图标临时变成 ✓,顶部 toast 提示"已复制",1.5s 复原
- collapsed 视图下同样行为,保持两套视图交互一致

### 1.3 非目标(YAGNI)

- ❌ thinking 块 / tool 调用块的 copy(范围隔离,后续有需要再加)
- ❌ 整轮 / 整段对话复制(留作后续扩展,不与"复制单条消息"混在一起)
- ❌ Dropdown 多动作面板(只做单一 copy 动作,避免引入菜单 UI)
- ❌ 复制为渲染后纯文本(用户已确认走 AI 复制 markdown 原文 / User 复制原始纯文本)
- ❌ 把 clipboard util 抽象成 framework 级公共包(只在 web 内共享即可)

### 1.4 决策汇总(经 brainstorming 确认)

| 决策项 | 决定 |
|---|---|
| 覆盖范围 | 仅 `user.text` / `assistant.text` 两类气泡 |
| UI 触发 | 气泡右上角始终可见的 Copy 图标按钮 |
| 复制格式 | AI 复制 markdown 原文;User 复制原始纯文本(`msg.text`) |
| 成功反馈 | 图标临时变 ✓ + 1.5s 复原 + AntD `message.success('已复制')` |
| collapsed 视图 | 与 expanded 同步实现 |
| 实现方案 | 方案 A — 组件内嵌按钮 + 公共 clipboard util |

## 2. 架构

### 2.1 组件边界

```
lib/clipboard.ts                       (新增,公共 util)
  └─ copyToClipboard(text): Promise<boolean>

components/transcript/MessageBubble.tsx                  (修改)
  ├─ MessageCopyButton (新增,模块私有)
  └─ 在 user.text / assistant.text 两个分支的 Card 内嵌 <MessageCopyButton>

components/transcript/CollapsedMessageBubble.tsx         (修改)
  ├─ 复用 MessageCopyButton(从 MessageBubble.tsx 导出)
  └─ 在 user / assistant 气泡内嵌 <MessageCopyButton>
```

**为何 MessageCopyButton 放在 MessageBubble.tsx 而不是独立文件**:体量小(约 60 行)、只服务这两个文件,提前拆成独立文件反而增加 import 噪音;后续真有第二个使用场景再拆。

### 2.2 数据流(点击复制)

```
User 鼠标点击 <CopyOutlined /> 按钮
  ↓
MessageCopyButton.handleClick(e)
  ├─ e.stopPropagation() + e.preventDefault()   ← 防 click 冒泡触发 Card 折叠/链接
  ├─ copyToClipboard(text) → Promise<boolean>
  │    ├─ navigator.clipboard.writeText(text)   ← 现代路径 (https / localhost)
  │    └─ document.execCommand('copy') 兜底     ← http / 老浏览器
  ├─ true → setCopied(true)
  │          message.success('已复制')
  │          setTimeout(1500) → setCopied(false) + clearTimeout 防重入
  └─ false → message.warning('复制失败, 请手动选中')
```

### 2.3 复制格式策略

| `variant` | 复制源 | 原因 |
|---|---|---|
| `"ai"` | `msg.text`(markdown 原文) | AI 回答通常是 markdown,保留围栏代码块 / 列表 / 链接,贴到 Notion / IDE / Issue 仍有高亮 |
| `"user"` | `msg.text` 或 `msg.prompt`(原始输入) | 用户键入就是纯文本,不需要再处理 linkify 后的 HTML |

**isRenderedPrompt 边界**:对 `isRenderedPrompt: true` 的 user.text 消息,只复制第一行用户原始输入;muted "渲染后" 第二行不进入复制内容(避免复制带一段奇怪的元信息)。

## 3. 组件设计

### 3.1 `lib/clipboard.ts`(新增,~30 行)

直接抽取 `ConversationInfoCard.tsx:20-39` 的现有实现,去掉局部耦合:

```typescript
export async function copyToClipboard(text: string): Promise<boolean> {
  if (navigator.clipboard?.writeText) {
    try {
      await navigator.clipboard.writeText(text)
      return true
    } catch {
      // fall through to legacy path
    }
  }
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

签名从 `Promise<void>` 改成 `Promise<boolean>`,方便调用方根据成败切换 ✓ / 弹 warning。

### 3.2 `MessageCopyButton`(在 `MessageBubble.tsx` 内,模块私有)

```typescript
function MessageCopyButton({ text, variant }: { text: string; variant: 'ai' | 'user' }) {
  const [copied, setCopied] = useState(false)
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  useEffect(() => () => {
    if (timerRef.current) clearTimeout(timerRef.current)
  }, [])

  const handleClick = async (e: React.MouseEvent) => {
    e.stopPropagation()
    e.preventDefault()
    const ok = await copyToClipboard(text)
    if (!ok) {
      message.warning('复制失败, 请手动选中')
      return
    }
    setCopied(true)
    message.success('已复制')
    if (timerRef.current) clearTimeout(timerRef.current)
    timerRef.current = setTimeout(() => setCopied(false), 1500)
  }

  return (
    <Button
      type="text"
      size="small"
      icon={copied ? <CheckOutlined /> : <CopyOutlined />}
      onClick={handleClick}
      title="复制"
      aria-label={variant === 'ai' ? '复制助手回答' : '复制用户消息'}
      style={{
        position: 'absolute',
        top: 8,
        right: 8,
        zIndex: 1,
        background: 'rgba(255,255,255,0.06)',
        borderRadius: 4,
        opacity: 0.85,
      }}
    />
  )
}
```

样式要点:
- 绝对定位 `top: 8, right: 8`,父 Card 加 `position: 'relative'`
- 半透明白底 `rgba(255,255,255,0.06)` 在绿底 AI 卡 / 蓝底 User 卡 / 暗色主题卡上都可见,不依赖主题变量
- `zIndex: 1` 防止被气泡内 link / code 覆盖

### 3.3 `MessageBubble.tsx` 修改点

> 关键:MessageCopyButton 自身 `position: absolute` + 父 Card `position: relative`,JSX 中 `<MessageCopyButton>` 写在哪个子位置对最终视觉无影响(总在右上角)。这里只标记必加 `position: 'relative'` 与具体 props。

- `user.text` 分支(`MessageBubble.tsx:768-821`):
  - Card `style` 追加 `position: 'relative'`
  - 在 Card 内任意位置插入 `<MessageCopyButton text={visibleText} variant="user" />`(建议放在 `msgAttachments` 与 `<Space>` 之间,与 `<Space>` 平级但语义上属"卡片头部操作")
  - `visibleText` 取自 `msg.text || msg.prompt`,不复制 `isRenderedPrompt` 第二行 muted 文本
- `assistant.text` 分支(`MessageBubble.tsx:877-897`):
  - Card `style` 追加 `position: 'relative'`
  - 在 Card 内任意位置插入 `<MessageCopyButton text={text} variant="ai" />`(建议放在 `<Space>` 之后,与文本流分离)
  - `text` 直接取 `msg.text` 即 markdown 原文(`AssistantTextBody` 已流式累加完成)
  - `content_block_delta` 分支不渲染气泡本身,无关

> 决策记录:把按钮放在 Card 内部而非 Card 外部,跟着 Card 一起滚、一起折叠;如果用户切到 collapsed 视图,该气泡被替换为 `CollapsedMessageBubble`,按钮重新挂载到新组件,状态自然丢弃。

### 3.4 `CollapsedMessageBubble.tsx` 修改点

导出 `MessageCopyButton` 后,在 `user.text` / `assistant.text` 两个分支同样嵌入:

- `user.text` 分支(`CollapsedMessageBubble.tsx:85-112`):Card 加 `position: 'relative'`,`MessageCopyButton` 放在 Card 内 `Paragraph` 之后
- `assistant.text` 分支(`CollapsedMessageBubble.tsx:56-82`):Card 加 `position: 'relative'`,`MessageCopyButton` 放在 Card 内 `Space` 之后

把 `MessageCopyButton` 从 `MessageBubble.tsx` 导出(从模块私有升为 named export),让 `CollapsedMessageBubble.tsx` 直接 import。

## 4. 错误处理

| 场景 | 行为 |
|---|---|
| `navigator.clipboard` 不可用(http / 老浏览器) | util 内自动 fallback 到 `document.execCommand('copy')`,**对调用者透明** |
| 两条路径都失败 | util 返回 `false`,按钮不切换 ✓,`message.warning('复制失败, 请手动选中')` |
| 用户在 streaming 中途复制 | 复制当前累计 `msg.text`(累计到那一 delta),符合"复制看到的"直觉;按钮不加 disabled |
| 复制空文本 | user 端复制空串不会报错,toast 仍弹(用户罕见场景,先不专门处理) |
| 按钮 click 冒泡 | `e.stopPropagation() + e.preventDefault()`,防触发 Card 折叠 / 链接点击 |
| 重复点击 | `clearTimeout` + 新 timer,不会重复弹 toast / 累积多个 timeout |
| 组件卸载时 timer 未清 | `useEffect` cleanup 里 `clearTimeout`,防止 setState on unmounted component |
| 主题切换 / 暗色主题 | 按钮用半透明白底 + 浅色 `CopyOutlined`,不依赖主题变量 |
| 键盘可达性 | antd Button 默认 `<button>` 元素,可 Tab 聚焦 / Enter / Space 触发;`title` 给 hover 提示 |

## 5. 测试策略

### 5.1 单元测试(vitest + happy-dom)

```
packages/zai/src/web/src/lib/clipboard.test.ts                  (~40 行,新增)
  ✓ happy-dom: navigator.clipboard.writeText 被调用, 传入正确 text, 返回 true
  ✓ clipboard 抛错时 fallback 到 textarea + execCommand, 返回 true
  ✓ 两条都失败返回 false (不抛)

packages/zai/src/web/src/components/transcript/
    MessageBubble.copy.test.tsx                                  (~80 行,新增)
  ✓ assistant.text 渲染包含 CopyOutlined 的按钮
  ✓ user.text 渲染包含 CopyOutlined 的按钮
  ✓ ThinkingBlock 渲染路径不渲染 Copy 按钮 (用 assistant.thinking msg)
  ✓ ToolCallBlock 渲染路径不渲染 Copy 按钮 (用 tool_use:start msg)
  ✓ 点击 Copy 按钮成功复制 msg.text (mock clipboard.writeText), 图标变 CheckOutlined
  ✓ 复制失败时弹 message.warning, 图标不变 ✓

packages/zai/src/web/src/components/transcript/
    CollapsedMessageBubble.copy.test.tsx                         (~60 行,新增)
  ✓ user 气泡渲染 Copy 按钮
  ✓ assistant 气泡渲染 Copy 按钮
  ✓ 点击复制 msg.text
```

### 5.2 手动验收清单(给 PR reviewer)

1. 任意 assistant 消息右上角出现小 Copy 图标 → 点击 → 顶部 toast "已复制" + 图标变 ✓ + 1.5s 复原
2. 粘贴到 IDE / Notion 看 markdown 语法保留(代码块围栏、列表、链接)
3. user 消息同样行为,粘贴是纯文本(无 linkify HTML)
4. `isRenderedPrompt: true` 消息只复制第一行,不复制 muted "渲染后" 第二行
5. streaming 中途复制 → 复制当前累计内容
6. collapsed 视图下同样行为
7. thinking 块 / tool_use 块**没有** Copy 按钮(范围隔离)
8. http 环境下复制仍可用(textarea fallback)
9. 重复点击不会重复弹 toast
10. 键盘 Tab 能聚焦到按钮,Enter / Space 能触发复制

## 6. 改动清单

**新增文件**:
- `packages/zai/src/web/src/lib/clipboard.ts`(util,~30 行)
- `packages/zai/src/web/src/lib/clipboard.test.ts`(单测,~40 行)
- `packages/zai/src/web/src/components/transcript/MessageBubble.copy.test.tsx`(单测,~80 行)
- `packages/zai/src/web/src/components/transcript/CollapsedMessageBubble.copy.test.tsx`(单测,~60 行)

**修改文件**:
- `packages/zai/src/web/src/components/transcript/MessageBubble.tsx`(新增 MessageCopyButton 模块私有组件 + 导出让 CollapsedMessageBubble 复用 + user.text/assistant.text 两分支嵌入)
- `packages/zai/src/web/src/components/transcript/CollapsedMessageBubble.tsx`(user.text/assistant.text 两分支嵌入 MessageCopyButton)
- `packages/zai/src/web/src/components/transcript/ConversationInfoCard.tsx`(顺手把内联的 copy 逻辑替换为 `import { copyToClipboard }`,减少重复)

## 7. 后续扩展(留作未来 PR,不在本次范围)

- thinking 块 / tool 块 copy 按钮
- 整轮对话复制(hover 整段 TranscriptGroup 出"复制整段"按钮)
- Dropdown 菜单式多动作(复制 markdown / 复制纯文本 / 引用回复)
- 复制 markdown 时把 `linkifyText` 处理过的链接反转回原始 `[text](url)` 形式(目前 AI 端 `msg.text` 已是 markdown 原文,无需反转)