# zai Web 图片粘贴与解析 — 设计规格

> 文档版本: 1.0 · 2026-07-12 · 状态: 设计已敲定, 待用户 review

## 0. 背景

zai Web Agent 页面 (`packages/zai/src/web/src/pages/Agent.tsx:1150`) 的对话输入框只接受纯文本:
`<TextArea>` 无 onPaste/onDrop, 无上传按钮, `handleSend` 仅 `sendMessage(trimmed, cwd)`。

OpenCC CLI 端通过 `cli/src/utils/imagePaste.ts` 监听剪贴板 / 拖拽, 把图片落盘后调 Anthropic Files API, 拿到 `file_id` 写入 `imagePasteIds`。但 zai 走的是 MiniMax (`ANTHROPIC_BASE_URL=https://api.minimaxi.com/anthropic`), 该代理的 Files API 行为不一致:
- MiniMax 自有 `/v1/files/upload` 端点, 需 multipart + `purpose` 参数
- 返回 `file_id` 是 integer, 不是 string
- 引用 scheme 是 `mm_file://{file_id}`, 不是 Anthropic 的 `anthropic://files/{id}`
- purpose 列表 (`voice_clone / prompt_audio / t2a_async_input / video_understanding`) 不含 image_understanding

直接把 zai-agent-core 的 `uploadFile()` (走 Anthropic Files API) 接到 zai-web 会失败在 MiniMax 边界。

## 1. 方案

**前端 base64 内联 + ContentBlock 透传**。

用户在 `<TextArea>` 粘贴/拖拽/选择图片时:
1. 前端 `FileReader.readAsDataURL(file)` 转 base64 dataURL
2. 校验 `mime ∈ IMAGE_MIME_TYPES` 且 `size ≤ 10MB` (MiniMax 限制)
3. 缩略图条渲染在 TextArea 上方 (用本地 objectURL)
4. 用户按 Enter 时, 把所有附件打包成 `ContentBlock[] = [{ type: 'image', source: { type: 'base64', media_type, data } }, ..., { type: 'text', text: prompt }]`
5. POST `/api/agent/run` body 含 `contentBlocks`
6. server 调 `createUserMessage({ content: contentBlocks })`, zai runtime → Anthropic SDK → MiniMax /anthropic/v1/messages
7. MiniMax 直接接受 base64 image block (文档明确支持, 示例见 `platform.minimax.io/docs/api-reference/text-chat-anthropic`)

**不引入 Files API 调用**。base64 内联路径覆盖 MiniMax base64 10MB 限制以内的全部场景。

**持久化**: base64 写入 transcript (zai 的 `TranscriptStore` 用 JSON 文件, 不像 OpenCC 走 JSONL)。单条 user message 可达 13.3MB (10MB 图片 base64 编码), transcript 体积会膨胀但可接受 — 后续如需优化可改为本地文件 + URL 引用, 当前 YAGNI。

## 2. 文件改动

### 2.1 新建 `packages/zai/src/web/src/lib/imageReader.ts`

```ts
// MiniMax 限制: image ≤ 10MB (直接 base64 输入), 支持 JPEG/PNG/GIF/WEBP
// Source: https://platform.minimax.io/docs/api-reference/text-chat-anthropic (MediaSource)
const MAX_BYTES = 10 * 1024 * 1024
const ALLOWED_MIME = new Set(['image/jpeg', 'image/png', 'image/gif', 'image/webp'])

export class ImageReadError extends Error {
  constructor(public reason: 'unsupported_mime' | 'too_large' | 'read_failed', message: string) {
    super(message)
    this.name = 'ImageReadError'
  }
}

export async function readImageAsBase64(
  file: File,
  signal?: AbortSignal,
): Promise<{ mime: string; dataUrl: string; size: number; filename: string }> {
  if (!ALLOWED_MIME.has(file.type)) {
    throw new ImageReadError('unsupported_mime', `不支持的图片格式: ${file.type || '未知'}`)
  }
  if (file.size > MAX_BYTES) {
    throw new ImageReadError('too_large', `图片超过 10MB 上限 (${(file.size / 1024 / 1024).toFixed(1)}MB)`)
  }
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onerror = () => reject(new ImageReadError('read_failed', reader.error?.message ?? '读取失败'))
    reader.onabort = () => reject(new ImageReadError('read_failed', '已取消'))
    reader.onload = () => {
      const dataUrl = reader.result as string
      resolve({ mime: file.type, dataUrl, size: file.size, filename: file.name || 'image' })
    }
    if (signal) {
      if (signal.aborted) {
        reject(new ImageReadError('read_failed', '已取消'))
        return
      }
      signal.addEventListener('abort', () => reader.abort(), { once: true })
    }
    reader.readAsDataURL(file)
  })
}
```

### 2.2 改 `packages/zai/src/web/src/store/useAgentStore.ts`

新增 attachments slice:

```ts
type PendingAttachment = {
  localId: string       // crypto.randomUUID()
  mime: string
  size: number
  filename: string
  thumbnailUrl: string  // URL.createObjectURL(file), removeAttachment 时 revoke
  base64DataUrl: string // 'data:image/png;base64,...'
  status: 'reading' | 'ready' | 'error'
  error?: string
}

// 单次粘贴/拖拽最多附加 10 张图 (避免单条 message base64 体积失控 +
// 与 MiniMax request body ≤ 64MB 留足余量). 超出的 File 在
// addAttachments 内直接丢弃, 不进 attachments, 也不报错 (静默,
// 用户能通过缩略图条长度判断是否全部接受).
const MAX_ATTACHMENTS_PER_TURN = 10

// 现有 AgentState 扩展:
attachments: PendingAttachment[]
addAttachments: (files: File[], signal?: AbortSignal) => Promise<void>
removeAttachment: (localId: string) => void
clearAttachments: () => void
```

`sendMessage` 签名扩展:

```ts
sendMessage: (args: { text: string; contentBlocks?: ContentBlock[] }, cwd?: string) => Promise<void>
// 内部:
//   - 推 userMsg 到 store.messages (含 attachments 缩略图)
//   - runAgentStream({ prompt: text, contentBlocks, cwd, sessionId, signal, onEvent })
//   - 成功后 clearAttachments()
```

`loadTranscript` 改造:

```ts
// 现有: 从 transcript.messages[].raw.content 读 string
// 新增: 如果 raw.content 是 array (ContentBlock[]), 重建 user.text 气泡 + 缩略图条
//   重新生成 objectURL: blob = dataURLtoBlob(a.base64DataUrl); url = URL.createObjectURL(blob)
//   组件 unmount 时统一 revoke (用 ref 追踪)
// 兼容老 transcript (string content) — 维持原行为
```

### 2.3 改 `packages/zai/src/web/src/lib/sseAgent.ts`

```ts
// runAgentStream 签名扩展:
export function runAgentStream(args: {
  prompt: string
  contentBlocks?: ContentBlock[]
  cwd?: string
  sessionId?: string
  signal: AbortSignal
  onEvent: (e: RuntimeEvent) => void
  onEnd: () => void
})

// POST /api/agent/run body: { prompt, contentBlocks, cwd, sessionId }
// contentBlocks 为空数组或 undefined 时省略该字段 (兼容老调用)
```

### 2.4 改 `packages/zai/src/web/src/pages/Agent.tsx`

`Agent` 组件改造:

```tsx
// 新增 state / handlers:
const { attachments, addAttachments, removeAttachment, clearAttachments, sendMessage } = useAgentStore()
const uploadAbortRef = useRef<AbortController | null>(null)
const fileInputRef = useRef<HTMLInputElement>(null)

const handlePaste = (e: React.ClipboardEvent) => {
  const files: File[] = []
  for (const item of e.clipboardData.items) {
    if (item.kind === 'file') {
      const f = item.getAsFile()
      if (f) files.push(f)
    }
  }
  if (files.length === 0) return  // 纯文本粘贴走默认行为
  e.preventDefault()
  uploadAbortRef.current = new AbortController()
  void addAttachments(files, uploadAbortRef.current.signal)
}

const handleDrop = (e: React.DragEvent) => {
  if (status === 'streaming' || pendingAsk?.status === 'pending') {
    e.preventDefault()
    message.warning('请等待当前回复结束')
    return
  }
  const files = Array.from(e.dataTransfer.files).filter(f => f.type.startsWith('image/'))
  if (files.length === 0) return
  e.preventDefault()
  uploadAbortRef.current = new AbortController()
  void addAttachments(files, uploadAbortRef.current.signal)
}

const handleFilePick = (e: React.ChangeEvent<HTMLInputElement>) => {
  const files = Array.from(e.target.files ?? [])
  if (files.length === 0) return
  uploadAbortRef.current = new AbortController()
  void addAttachments(files, uploadAbortRef.current.signal)
  e.target.value = ''  // 允许重复选同一文件
}

const handleSend = async () => {
  const text = input.trim()
  const blocks: ContentBlock[] = attachments
    .filter(a => a.status === 'ready')
    .map(a => ({ type: 'image', source: { type: 'base64', media_type: a.mime, data: a.base64DataUrl } }))
  if (!text && blocks.length === 0) return
  if (status === 'streaming') return
  setInput('')
  await sendMessage({ text, contentBlocks: blocks }, cwd || undefined)
}

// JSX (替换现有 TextArea 区域):
<div onDrop={handleDrop} onDragOver={e => e.preventDefault()} style={{ /* 容器 */ }}>
  {attachments.length > 0 && (
    <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', padding: '8px 0' }}>
      {attachments.map(a => (
        <div key={a.localId} style={{ position: 'relative', width: 80, height: 80 }}>
          {a.status === 'ready' ? (
            <img src={a.thumbnailUrl} alt={a.filename} style={{ width: '100%', height: '100%', objectFit: 'cover', borderRadius: 6 }} />
          ) : a.status === 'error' ? (
            <div style={{ /* 红色失败占位 */ }}>{a.error}</div>
          ) : (
            <Spin />
          )}
          <Button size="small" icon={<CloseOutlined />} onClick={() => removeAttachment(a.localId)}
            style={{ position: 'absolute', top: -8, right: -8 }} />
        </div>
      ))}
    </div>
  )}
  <div style={{ display: 'flex', alignItems: 'stretch' }}>
    <Button icon={<PictureOutlined />} onClick={() => fileInputRef.current?.click()} title="上传图片" />
    <input ref={fileInputRef} type="file" accept="image/*" multiple style={{ display: 'none' }} onChange={handleFilePick} />
    <TextArea
      value={input}
      onChange={e => setInput(e.target.value)}
      onKeyDown={handleKeyDown}
      onPaste={handlePaste}
      placeholder="输入消息, 按 Enter 发送, Shift+Enter 换行. 可直接粘贴或拖拽图片."
      rows={3}
      disabled={status === 'streaming' || pendingAsk?.status === 'pending'}
      style={{ resize: 'none', flex: 1 }}
    />
  </div>
</div>
```

`MessageBubble` 改造 (现有 user.text 渲染点附近):

```tsx
// user.text 消息渲染时, 如果 msg.attachments 存在, 在 <Text> 上方渲染缩略图条
// 历史回放时同样支持 (msg.attachments 由 loadTranscript 从 ContentBlock[] 还原)
```

### 2.5 改 `packages/zai/src/server/routes/agent.ts` (或 `stream.ts`)

```ts
// POST /api/agent/run 接受新字段:
const { prompt, contentBlocks, cwd, sessionId } = req.body as {
  prompt: string
  contentBlocks?: Array<{ type: string; source?: unknown; [k: string]: unknown }>
  cwd?: string
  sessionId?: string
}

// 拼 user message:
const content = contentBlocks?.length
  ? [...contentBlocks, { type: 'text' as const, text: prompt || '' }]
  : prompt
const userMsg = createUserMessage({ content, /* 其它现有字段 */ })

// 透传给 zai runtime
```

### 2.6 改 `packages/zai-agent-core/src/opencc-internals/utils/messages.ts`

`createUserMessage` 形参类型同步:

```ts
// 现状: imagePasteIds?: number[]  (与 UserMessage.imagePasteIds?: string[] 不一致)
// 改为: imagePasteIds?: string[]  (与顶层类型对齐, Anthropic file_id 是 string)
// 本次改动后 zai 路径不再使用 imagePasteIds (走 base64), 保留为可选字段以兼容 OpenCC 上游 type
```

### 2.7 改 `packages/zai-agent-core/src/transcript/store.ts` 或上层 wrap

`append` 写入 user message 时, 把 ContentBlock[] 序列化进 `raw.content`:

```ts
// 位置: 上层 wrap (比如 server routes/agent.ts 的 SSE 流出口处) 而非 store.ts 本身.
// store.ts.append() 接 (transcriptId, msg: TranscriptMessage), 直接写入 msg.raw.
// wrap 层在调用 append 之前:
//   if (Array.isArray(userMsg.message.content)) {
//     msg.raw = { ...msg.raw, content: userMsg.message.content, imagePasteIds: userMsg.imagePasteIds }
//   }
// 读取时 deserializeFile 已经处理 unknown 字段, 无需改 reader
```

注: `TranscriptMessage.raw` 类型是 `unknown`, 写入/读取透明, **不需要改 store.ts schema**。只需要在写入前正确序列化 (`JSON.stringify`), 读取后正确解析 (`typeof === 'string' ? string : ContentBlock[]`)。

### 2.8 改 `packages/zai/src/web/src/components/MessageBubble.tsx` (或等价物)

现有 user.text 渲染点附近, 增加缩略图条:

```tsx
// 如果 msg.attachments 存在 (前端 store 字段), 在 <Text>{text}</Text> 上方渲染 <AttachmentStrip attachments={msg.attachments} />
// 缩略图条组件独立: 接收 attachments[], 渲染 img 列表, useEffect cleanup 时 revoke 所有 objectURL
```

## 3. 不引入

- ❌ server `/api/files/upload` route — 不需要
- ❌ zai-agent-core `uploadFile()` 调用 — 不需要
- ❌ Files API beta header — 不需要
- ❌ 第三方 image compression 库 — base64 直接传
- ❌ IndexedDB / localStorage 缓存 — transcript 已经存 base64

## 4. 错误处理

| 场景 | 行为 | 测试覆盖 |
|------|------|----------|
| 粘贴非 image/* MIME | 静默忽略 (仅 text 进 input) | unit: addAttachments 过滤 |
| 图片 > 10MB | `ImageReadError('too_large')` → attachment.status = 'error' → toast 提示 | unit: readImageAsBase64 |
| FileReader 失败 (磁盘损坏) | `ImageReadError('read_failed')` → 同上 | unit: readImageAsBase64 |
| 批量超过 10 张 | 超出 MAX_ATTACHMENTS_PER_TURN 的 File 静默丢弃, 不进 attachments 也不报错 (避免 toast 噪音; 用户通过缩略图条长度判断) | unit: addAttachments 上限校验 |
| 拖入文件夹 | 仅顶层 image, 不递归 | unit: handleDrop 过滤 |
| Esc 中断正在读取 | `AbortController.abort()` 终止 FileReader, attachment 状态 cancelled | unit: signal handler |
| 发送时网络断开 | 与现有 sendMessage 错误处理一致 | integration: runAgentStream error |
| 拖到 streaming 中的 TextArea | preventDefault + message.warning('请等待当前回复结束') | manual E2E |
| 历史 transcript 含损坏 base64 | loadTranscript 解析单个 image block 失败时, 把该 block 降级成 `text: '[图片已损坏]'` 注入到 attachments, 仍渲染 message 但缩略图位置显示占位文字. 不跳过整条消息, 保证 text 部分仍可见 | integration: loadTranscript 容错 |
| Anthropic SDK 拒绝 base64 (理论可能) | server 500 → 前端 SSE runtime.error → store status = 'error' | manual E2E |

## 5. 测试策略

### 5.1 单元 (vitest)

**`packages/zai/src/web/src/lib/imageReader.test.ts`**:
- `readImageAsBase64`: PNG → dataURL; jpeg → dataURL; text/plain → throw unsupported_mime; 11MB → throw too_large; aborted signal → throw read_failed
- FileReader mock: jest-like setup, 用 `vi.spyOn(global, 'FileReader')` 或更轻的 stub

**`packages/zai/src/web/src/store/useAgentStore.test.ts`**:
- `addAttachments([file1, file2])` → attachments.length === 2, status = 'ready'
- `addAttachments([oversized])` → attachments[0].status === 'error'
- `removeAttachment(localId)` → URL.revokeObjectURL 被调 (spy)
- `sendMessage({ text, contentBlocks })` → runAgentStream spy 收到正确 body
- `loadTranscript` 含 ContentBlock[] → attachments 重建, objectURL 创建
- `loadTranscript` 老 string content → 兼容, 不报错

**`packages/zai/src/server/routes/agent.test.ts`** (新):
- POST body 含 contentBlocks → createUserMessage spy 收到 ContentBlock[]
- POST body 仅 string → 兼容老路径

### 5.2 集成

- 完整路径: 粘贴 → addAttachments → sendMessage → mock runAgentStream → 检查 SSE 入参 → server 收到 → createUserMessage 收到
- transcript 往返: 写入 ContentBlock[] → 读取 → 还原 attachments 一致

### 5.3 E2E 手动

1. Cmd+V 截图 → 缩略图出现 < 500ms
2. 拖拽 PNG 到 TextArea → 缩略图出现
3. 点 🖼 按钮 → 文件选择器 → 选中 → 缩略图出现
4. 输入文字 + 1 张图 → 发送 → 模型回复引用图片
5. 刷新页面 → 历史气泡的缩略图仍在 (transcript 回放)
6. 拖入 11 张图 → 缩略图条只显示 10 张 (第 11 张静默丢弃)
7. 拖入 11MB PNG → toast 拒绝
8. streaming 时拖拽 → toast 提示
9. 删除某张缩略图 (×) → 不出现在消息中

## 6. 范围外 (YAGNI)

- PDF / 视频 / 音频附件 — 当前仅 image/*
- 图片压缩 / 缩略图压缩 — base64 直接传, MiniMax 接受 ≤ 10MB
- 剪贴板轮询监听 — 仅响应用户主动 paste
- Drag 多文件跨文件夹递归 — 仅顶层
- OCR / 图片理解二次处理 — 交给模型
- transcript 体积优化 (本地文件 + URL 引用) — 后续如需再说

## 7. 开放项 (Plan 阶段调查)

- **zai-agent-core 是否在 query.ts 读 imagePasteIds 转 ImageBlock?** 当前 zai 适配层可能 stub 掉了。本方案不走 imagePasteIds, 所以该调查**降级为可选**: 如果 zai-web 走 base64 路径不需要这块, 就不动; 如果未来想加 Files API 路径才需要。
- **zai-server 当前 `/api/agent/run` 的实际入口** (agent.ts vs stream.ts): Plan 阶段先 grep 确认再改。
- **`useAgentStore.sendMessage` 当前是否走 SSE** (从前面代码看是 `runAgentStream` → SSE): Plan 阶段确认后只改 `runAgentStream` 签名, 不改调用方太多。
- **MessageBubble 实际位置**: Plan 阶段 grep `MessageBubble` 定位 (可能是 Agent.tsx 内联组件或独立文件)。