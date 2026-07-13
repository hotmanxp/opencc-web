# zai Web 图片粘贴与解析 v2 — 设计规格

> 文档版本: 1.0 · 2026-07-12 · 状态: 设计已敲定, 待用户 review
>
> 关系: v1 (`2026-07-12-image-paste-parse-design.md`) 基于已废弃的 SSE-stream 架构，本 v2 适配 main 的 stable-connection 重构（EventSource + `/agent/prompt` + `useEventStream` + `applyRuntimeEvent`）。

## 0. 背景

v1 在 worktree 完成了 11 commit，但 main 同期推进了 11 commit 的 stable-connection 重构：route 从 `POST /agent/stream`（SSE-per-request）改为 `POST /agent/prompt`（fire-and-forget → eventBus）+ `GET /api/event`（SSE 单连接订阅）+ 前端 `useEventStream` hook + 新 `useAgentStore` reducers（`applyRuntimeEvent` / `applySessionEvent` / `applyPromptAsk`）。`sseAgent.ts` 在 main 被删除，`useAgentStore.sendMessage` 改为 stub（实际 prompt 流程在 `Agent.tsx` 直接 `api.post('/agent/prompt', { prompt, cwd })`）。

v1 的 8 个 zai-web commit（Task 4-8）依赖被废弃的 `sseAgent` / `useAgentStore.sendMessage`，rebase 4 文件冲突无法解决。已 cherry-pick v1 中 3 个正交 commit 到 main：

- `feat(zai-web): 新增 readImageAsBase64 helper` (`645f242`)
- `fix(zai-agent-core): createUserMessage.imagePasteIds 类型 number[] → string[]` (`37dc4b6`)
- `fix(zai-agent-core): queryEngine resume path preserves ContentBlock[] array` (`5d272d4`)

v2 重做 v1 的 zai-web 部分，适配新架构。

## 1. 方案

**前端 base64 内联 + ContentBlock 透传**（与 v1 决策一致）。

`Agent.tsx` 局部 `useState` 持有 `attachments: PendingAttachment[]`。粘贴/拖拽/选文件 → `readImageAsBase64(file)` → 转 base64 dataURL → 加到 state → 渲染 `<AttachmentStrip attachments={...} onRemove={...} />`。

用户按 Enter：`handleSend` 把 `input.trim()` + `attachments`（过滤 `status === 'ready'`）拼成 `ContentBlock[] = [{ type: 'image', source: { type: 'base64', media_type, data } }, ...]`，连同 `text` 一起 POST 到 `/agent/prompt`。允许 image-only（无文字）。

`/agent/prompt` server 端 zod 接收 `contentBlocks?: ContentBlock[]`（max 10），relax `prompt` 为可选（prompt 与 contentBlocks 至少有一个非空）。拼出 `promptArg: string | UserMessage[]`：`string` 时直接传；`UserMessage[]` 时走 `zai-agent-core` 的 `queryEngine` array 路径（已支持，见 `5d272d4`）。`runtime.run` 启动后，事件经 `eventBus` → `/api/event` SSE → `subscribeServerEvents` → `useEventStream` → `useAgentStore.applyRuntimeEvent` → 进 `messages[]`。

**持久化**：base64 写进 `transcript.raw.content`（`TranscriptMessage.raw: unknown` 自动 JSON 序列化）。`loadTranscript` 新增 `Array.isArray(raw.content)` 分支：text 块 `join('\n')` 进 `text` 字段，image 块转 dataURL → Blob → `URL.createObjectURL` 生成缩略图 URL，挂到 `msg.attachments`。与 v1 一致。

**附件状态生命周期**：
- 上传完成 → `status: 'ready'`，`thumbnailUrl` 是 `objectURL`（撤销时机：`onRemove` / `clearAttachments` / `handleSend` 后清理）
- 历史回放：附件挂到 `user.text` 消息的 `msg.attachments`（数据 URL 或 objectURL）
- session 切换 / new session / clear：v2 范围内由组件 unmount 触发 React 清理（useEffect cleanup）— 不污染 store

## 2. 文件改动

### 2.1 改 `packages/zai/src/server/routes/agent.ts`

```ts
// PromptRequest zod 改动:
//   - prompt: z.string().optional()  (从 .min(1) 放宽, 配合 contentBlocks 实现 image-only)
//   - 增加 contentBlocks: z.array(...).max(10).optional()
const PromptRequest = z.object({
  prompt: z.string().max(32_000).optional(),
  contentBlocks: z
    .array(
      z.object({
        type: z.string(),
        source: z
          .object({
            type: z.enum(['base64', 'url']),
            media_type: z.string(),
            data: z.string(),
          })
          .passthrough(),
      }).passthrough(),
    )
    .max(10)
    .optional(),
  cwd: z.string().optional(),
  sessionId: z.string().optional(),
}).refine(
  (v) => Boolean(v.prompt?.trim()) || Boolean(v.contentBlocks?.length),
  { message: 'prompt or contentBlocks required' },
)
```

```ts
// 在 fire-and-forget 块内, 拼 promptArg:
const text = parsed.data.prompt?.trim() ?? ''
const blocks = parsed.data.contentBlocks
const userContent =
  blocks && blocks.length
    ? [
        ...blocks,
        ...(text ? [{ type: 'text' as const, text }] : []),
      ]
    : text
const promptArg: string | UserMessage[] =
  typeof userContent === 'string'
    ? userContent
    : [{ role: 'user', content: userContent as UserMessageContent }]

const events = getRuntime().run({
  prompt: promptArg,
  cwd,
  ...(existingSessionId ? { resumeFromTranscriptId: existingSessionId } : {}),
  systemPrompt,
  abortSignal: abortController.signal,
})
```

注: `UserMessage` / `UserMessageContent` local alias 已在文件中（v1 cherry-pick 时引入的本地 mirror，因为 `@zn-ai/zai-agent-core` 没 re-export `UserMessage`）。

### 2.2 改 `packages/zai/src/web/src/pages/Agent.tsx`

**local state**:

```tsx
const [attachments, setAttachments] = useState<PendingAttachment[]>([])
const fileInputRef = useRef<HTMLInputElement>(null)
const uploadAbortRef = useRef<AbortController | null>(null)
```

**handlers**:

```tsx
const handlePaste = (e: React.ClipboardEvent) => {
  const files: File[] = []
  for (const item of e.clipboardData.items) {
    if (item.kind === 'file') {
      const f = item.getAsFile()
      if (f) files.push(f)
    }
  }
  if (files.length === 0) return
  e.preventDefault()
  void addAttachments(files)
}

const handleDrop = (e: React.DragEvent) => {
  if (status === 'streaming') {
    e.preventDefault()
    message.warning('请等待当前回复结束')
    return
  }
  const files = Array.from(e.dataTransfer.files).filter((f) => f.type.startsWith('image/'))
  if (files.length === 0) return
  e.preventDefault()
  void addAttachments(files)
}

const handleFilePick = (e: React.ChangeEvent<HTMLInputElement>) => {
  const files = Array.from(e.target.files ?? [])
  if (files.length === 0) return
  void addAttachments(files)
  e.target.value = ''
}

const addAttachments = async (files: File[]) => {
  const accepted = files.slice(0, 10) // MAX_ATTACHMENTS_PER_TURN
  const placeholders: PendingAttachment[] = accepted.map((file) => ({
    localId: crypto.randomUUID(),
    mime: file.type,
    size: file.size,
    filename: file.name || 'image',
    thumbnailUrl: URL.createObjectURL(file),
    base64DataUrl: '',
    status: 'reading',
  }))
  setAttachments((prev) => [...prev, ...placeholders])
  await Promise.all(
    placeholders.map(async (p, i) => {
      try {
        const r = await readImageAsBase64(accepted[i]!)
        setAttachments((prev) =>
          prev.map((a) => (a.localId === p.localId ? { ...a, base64DataUrl: r.dataUrl, status: 'ready' } : a)),
        )
      } catch (e) {
        const msg = e instanceof ImageReadError ? e.message : (e as Error).message
        setAttachments((prev) =>
          prev.map((a) => (a.localId === p.localId ? { ...a, status: 'error', error: msg } : a)),
        )
      }
    }),
  )
}

const removeAttachment = (localId: string) => {
  const att = attachments.find((a) => a.localId === localId)
  if (att) URL.revokeObjectURL(att.thumbnailUrl)
  setAttachments((prev) => prev.filter((a) => a.localId !== localId))
}

// 组件 unmount / handleSend 后清理
useEffect(() => {
  return () => {
    attachments.forEach((a) => URL.revokeObjectURL(a.thumbnailUrl))
  }
}, [])
```

**handleSend 改**:

```tsx
const handleSend = async () => {
  const text = input.trim()
  const blocks = attachments
    .filter((a) => a.status === 'ready')
    .map((a) => ({
      type: 'image' as const,
      source: { type: 'base64' as const, media_type: a.mime, data: a.base64DataUrl },
    }))
  if (!text && blocks.length === 0) return
  if (status === 'streaming') return
  setInput('')

  const userMsg: AgentMessage = {
    eventId: `user-${Date.now()}`,
    sessionId: '',
    ts: Date.now(),
    turnIndex: 0,
    type: 'user.text',
    text,
    // ★ 关键: snapshot attachments 到 user message, 用 dataURL 不用 objectURL
    //   (handleSend 后的 setAttachments 清空不会 revoke 引用)
    attachments: attachments
      .filter((a) => a.status === 'ready')
      .map((a) => ({
        localId: a.localId,
        mime: a.mime,
        filename: a.filename,
        thumbnailUrl: a.base64DataUrl, // dataURL 而非 objectURL
        status: a.status,
      })),
  }
  useAgentStore.setState((s) => ({
    status: 'streaming',
    messages: [...s.messages, userMsg],
    sendSeq: s.sendSeq + 1,
  }))

  // 清理本地附件 (snapshot 已存到 userMsg)
  attachments.forEach((a) => URL.revokeObjectURL(a.thumbnailUrl))
  setAttachments([])

  const { sessionId } = await api.post<{ sessionId: string }>('/agent/prompt', {
    prompt: text || undefined,
    contentBlocks: blocks.length > 0 ? blocks : undefined,
    cwd: cwd || undefined,
  })
  useAgentStore.setState({ activeSessionId: sessionId })
}
```

**JSX 替换** (TextArea 区):

```tsx
<div
  onDrop={handleDrop}
  onDragOver={(e) => e.preventDefault()}
>
  <AttachmentStrip attachments={attachments} onRemove={removeAttachment} />
  <div style={{ display: 'flex', alignItems: 'stretch' }}>
    <Button
      icon={<PictureOutlined />}
      onClick={() => fileInputRef.current?.click()}
      title="上传图片"
      disabled={status === 'streaming'}
    />
    <input
      ref={fileInputRef}
      type="file"
      accept="image/*"
      multiple
      style={{ display: 'none' }}
      onChange={handleFilePick}
    />
    <TextArea
      value={input}
      onChange={(e) => setInput(e.target.value)}
      onKeyDown={handleKeyDown}
      onPaste={handlePaste}
      placeholder="输入消息, 按 Enter 发送, Shift+Enter 换行. 可直接粘贴或拖拽图片."
      rows={3}
      disabled={status === 'streaming'}
      style={{ resize: 'none', flex: 1 }}
    />
  </div>
</div>
```

### 2.3 改 `packages/zai/src/web/src/pages/Agent.tsx` 的 `MessageBubble`

在 `user.text` 分支 (line 545-563 区域) 加 attachments 渲染:

```tsx
if (msg.type === 'user.text' || msg.type === 'user.message') {
  const msgAttachments = (msg.attachments as PendingAttachment[] | undefined) ?? []
  return (
    <div style={{ display: 'flex', justifyContent: 'flex-end', marginBottom: 16 }}>
      <Card size="small" style={{ maxWidth: '70%', background: '#e6f4ff', borderRadius: 12 }}>
        {msgAttachments.length > 0 && <AttachmentStrip attachments={msgAttachments} />}
        <Space>
          <UserOutlined />
          <Text>{linkifyText((msg.text as string) || (msg.prompt as string) || '')}</Text>
        </Space>
      </Card>
    </div>
  )
}
```

### 2.4 改 `packages/zai/src/web/src/store/useAgentStore.ts` 的 `loadTranscript`

`loadTranscript` 当前 (line 350+ 区域) 只处理 `string` content。加 `Array.isArray` 分支:

```ts
if (msg.type === 'user') {
  if (rawObj.kind === 'skill_injection') continue
  if (Array.isArray(rawObj.content)) {
    // ContentBlock[] (可能含图片) — 还原 text 字段 + 重建 attachments
    const blocks = rawObj.content as Array<{ type: string; source?: { type?: string; media_type?: string; data?: string }; text?: string }>
    const textFromBlocks = blocks
      .filter((b) => b.type === 'text' && typeof b.text === 'string')
      .map((b) => b.text!)
      .join('\n')
    const restoredAttachments = blocks
      .filter((b) => b.type === 'image' && b.source?.type === 'base64')
      .map((b, i) => {
        const dataUrl = `data:${b.source!.media_type};base64,${b.source!.data}`
        const blob = dataURLtoBlob(dataUrl)
        const thumbnailUrl = blob ? URL.createObjectURL(blob) : dataUrl
        return {
          localId: `${msg.uuid}-img-${i}`,
          mime: b.source!.media_type ?? 'image/png',
          filename: '[历史图片]',
          thumbnailUrl,
          status: blob ? 'ready' : 'error',
          error: blob ? undefined : '图片已损坏',
        }
      })
    messages.push({
      ...baseFields,
      eventId: msg.uuid,
      type: 'user.text',
      text: textFromBlocks,
      ...(restoredAttachments.length ? { attachments: restoredAttachments } : {}),
    })
  } else {
    messages.push({ ...baseFields, eventId: msg.uuid, type: 'user.text', text })
  }
}
```

`dataURLtoBlob` helper 放在文件顶部 (模块级函数):

```ts
function dataURLtoBlob(dataUrl: string): Blob | null {
  const m = dataUrl.match(/^data:([^;]+);base64,(.+)$/)
  if (!m) return null
  const mime = m[1]!
  const bin = atob(m[2]!)
  const arr = new Uint8Array(bin.length)
  for (let i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i)
  return new Blob([arr], { type: mime })
}
```

### 2.5 新增 `packages/zai/src/web/src/components/AttachmentStrip.tsx`

从 `feat/image-paste` worktree cherry-pick commit `891312d` (该 commit 是 v1 Task 6 的 fix，组件已经匹配 v1 spec 的 `StripAttachment` 类型 + 三态 + 80px)。该组件在 v2 继续使用，props 不变。

## 3. 不引入

- ❌ `sseAgent.ts` (已删除，新架构用 EventSource)
- ❌ `useAgentStore.sendMessage` 实际实现 (它是 stub；prompt 流程在 Agent.tsx)
- ❌ `useEventStream.ts` 改动 (已经是 ServerEvent consumer)
- ❌ 任何 server route 之外的 server 改动 (eventBus / translateRuntimeEvents 维持原样)
- ❌ useAppStore 改动
- ❌ 新建全局 attachment slice (v2 决策：local useState)

## 4. 错误处理

| 场景 | 行为 |
|------|------|
| 粘贴非 image/* MIME | 静默忽略 (仅 text 进 input) |
| 图片 > 10MB | `ImageReadError('too_large')` → attachment.status = 'error' → 缩略图位置红色错误文字 |
| FileReader 失败 | 同上 |
| 批量超过 10 张 | 第 11 张起静默丢弃 (避免 toast 噪音) |
| streaming 中拖拽 | preventDefault + message.warning |
| 历史 transcript 含损坏 base64 | 该 image block 降级为 `status: 'error'`, 仍渲染 message (text 部分可见) |
| 提交时网络断开 | 与现有 `api.post` 错误处理一致 |

## 5. 测试策略

### 5.1 单元 (vitest)

- `imageReader.test.ts` 已在 main，新增测试无需（已 cherry-pick）
- `server agent.test.ts` 已有 (来自 v1 cherry-pick 的 2 个用例)，新增 `image-only` 用例：
  - POST `/agent/prompt` with only contentBlocks, no prompt → 200, runtime.run called with array
  - POST without prompt and without contentBlocks → 400 invalid

### 5.2 集成

- 完整路径：粘贴 → 缩略图 → handleSend → mock api.post → userMsg snapshot 含 attachments → server route zod 通过 → runtime.run 收到 array prompt
- 历史回放：构造含 ContentBlock[] 的 transcript → loadTranscript → 还原 attachments

### 5.3 E2E 手动

1. Cmd+V 截图 → 缩略图 < 500ms
2. 拖拽 PNG → 缩略图
3. 点 🖼 按钮 → 文件选择器 → 缩略图
4. 仅发图（无文字）→ 模型回复引用图片
5. 文字 + 图 → 发送 → 模型回复
6. 刷新页面 → 历史气泡缩略图仍在
7. 拖入 11 张 → 只显示 10 张
8. 拖入 11MB → toast 拒绝
9. streaming 时拖拽 → toast 提示
10. × 移除某张 → 不出现在消息中

## 6. 范围外 (YAGNI)

- PDF / 视频 / 音频 (仅 image/*)
- 图片压缩 / 缩略图压缩
- 剪贴板轮询监听
- Drag 多文件跨文件夹递归
- OCR / 图片理解二次处理
- transcript 体积优化
- 真实 Anthropic Files API 路径 (MiniMax 不兼容，已分析)

## 7. 开放项

- `Agent.tsx` 中 `uploadAbortRef` 引用 — v1 review 标记为 dangling。v2 沿用同一 pattern，不实现 Esc 取消 (YAGNI)
- v1 留下的 `imageReader.test.ts:7` 未用 `name`/`sizeBytes` 参数 (Minor carry) — 已在 main，v2 不动
- `tsc -b` 不覆盖 `src/web/**` — 项目级 infra 问题 (v1 review carry)，v2 不修
- `dataURLtoBlob` 无单元测试 — 单元测试成本 > 价值 (逻辑简单，集成测试已覆盖)
