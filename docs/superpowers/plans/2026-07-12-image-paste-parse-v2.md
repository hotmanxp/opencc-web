# zai Web 图片粘贴 v2 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在 zai Web 的 Agent 页面支持粘贴/拖拽/点击上传图片，base64 ContentBlock 透传到 MiniMax，transcript 持久化还原，刷新页面可恢复。

**Architecture:** Agent.tsx 局部 `useState` 持有 `attachments`，`readImageAsBase64` 转 dataURL，`handleSend` 拼 `ContentBlock[]` POST 到 `/agent/prompt`。Server 拼 `promptArg: string | UserMessage[]` 走 zai-agent-core `queryEngine` array 路径。Transcript `raw.content` 序列化数组，`loadTranscript` 还原缩略图条。

**Tech Stack:** Bun + pnpm + vitest, React 18, zustand, AntD 5, Express 5, zod, EventSource-based SSE.

## Global Constraints

- 路径规则: `packages/zai-agent-core` 是独立 npm package, `packages/zai` 另一个. 跨包改动需各自 commit
- 提交规范: `feat: 新功能 | fix: 修复 | docs: 文档 | refactor: 重构 | chore: 工具链 | style: 格式 | test: 测试`
- 单张图片 ≤ **10MB**, 仅接受 MIME `image/jpeg | image/png | image/gif | image/webp`
- 单次粘贴/拖拽/选择最多 **10** 张, 超出的 File 静默丢弃
- `createUserMessage.imagePasteIds` 形参类型 `string[]` (已 main, 不动)
- `transcript.raw.content` JSON 序列化数组 (与 string content 兼容)
- 服务端路由路径: **`POST /api/agent/prompt`** (v1 的 `/agent/stream` 已废弃)
- 不引入 Files API 调用, 不动 zai-agent-core `uploadFile()`, 不增 server `/api/files/upload` route
- 测试框架: vitest (`packages/zai/test/web/`, `packages/zai/test/server/`), 命令 `pnpm -F zai test` / `pnpm -F zai-agent-core test`
- v1 遗留 carry 已知 (本 plan 不修): `imageReader.test.ts:7` 未用 `name`/`sizeBytes` 参数; `tsc -b` 不覆盖 `src/web/**`
- 全局工作目录: `/Users/ethan/code/opencc-web` (不在 worktree 中 — v2 在 main 直接做, 3 个正交 commit 已在 main, worktree 留着 v1 不动)

## File Structure

### 复用 (已在 main)
- `packages/zai/src/web/src/lib/imageReader.ts` (cherry-pick `645f242`)
- `packages/zai/src/web/src/lib/imageReader.test.ts`
- `packages/zai-agent-core/src/opencc-internals/utils/messages.ts:497` `imagePasteIds: string[]` (cherry-pick `37dc4b6`)
- `packages/zai-agent-core/src/runtime/queryEngine.ts:99` array content 通过 (cherry-pick `5d272d4`)

### 新建
- `packages/zai/src/web/src/components/AttachmentStrip.tsx` (从 `feat/image-paste` worktree commit `891312d` 取文件内容)

### 修改
- `packages/zai/src/server/routes/agent.ts` (PromptRequest zod + contentBlocks + 拼 promptArg)
- `packages/zai/src/web/src/pages/Agent.tsx` (attachments state + onPaste/onDrop + 🖼 按钮 + AttachmentStrip + handleSend + MessageBubble attachments 渲染)
- `packages/zai/src/web/src/store/useAgentStore.ts` (loadTranscript Array 分支 + dataURLtoBlob helper)
- `packages/zai/test/server/agent.test.ts` (新增 image-only 用例)

### 不修改
- `useEventStream.ts`, `eventSource.ts`, `api.ts`, `useAppStore.ts`, `eventBus.ts`, `translateRuntimeEvents` (新架构已支持)

---

## Task 1: 引入 AttachmentStrip 组件 (从 worktree cherry-pick)

**Files:**
- Create: `packages/zai/src/web/src/components/AttachmentStrip.tsx` (文件内容从 worktree commit `891312d` 取)

**Interfaces:**
- Produces:
  ```ts
  export type StripAttachment = {
    localId: string
    mime: string
    filename: string
    thumbnailUrl: string
    status: 'reading' | 'ready' | 'error'
    error?: string
  }
  export function AttachmentStrip(props: { attachments: StripAttachment[]; onRemove?: (localId: string) => void }): JSX.Element | null
  ```

- [ ] **Step 1: 在 main 的 worktree 外取出文件内容并写到目标位置**

```bash
cd /Users/ethan/code/opencc-web
git show 891312d:packages/zai/src/web/src/components/AttachmentStrip.tsx \
  > packages/zai/src/web/src/components/AttachmentStrip.tsx
wc -l packages/zai/src/web/src/components/AttachmentStrip.tsx
```

Expected: 100 行 (与 v1 review 通过的最终版本一致)

- [ ] **Step 2: typecheck**

```bash
pnpm -F zai typecheck
```

Expected: 0 errors

- [ ] **Step 3: commit**

```bash
cd /Users/ethan/code/opencc-web
git add packages/zai/src/web/src/components/AttachmentStrip.tsx
git -c user.name=opencode -c user.email=opencode@local commit -m "feat(zai-web): 新增 AttachmentStrip 组件 (复用 v1 worktree)"
```

---

## Task 2: server `/api/agent/prompt` 接 contentBlocks

**Files:**
- Modify: `packages/zai/src/server/routes/agent.ts:16-36` (PromptRequest zod) + 80-100 区域 (拼 promptArg)
- Modify: `packages/zai/test/server/agent.test.ts` (新增 image-only 用例)

**Interfaces:**
- Consumes: `UserMessage` / `UserMessageContent` local alias (已在文件 line 8-9) — 镜像 zai-agent-core `runtime/types.ts:8-11` 形状
- Produces: `runtime.run({ prompt: promptArg, ... })` where `promptArg: string | UserMessage[]`. 当 contentBlocks 存在时, promptArg 是 `[{ role: 'user', content: UserMessageContent }]`, 否则是 string

- [ ] **Step 1: 写失败测试**

`packages/zai/test/server/agent.test.ts` 末尾追加 (在已有 `describe` 块里):

```ts
  it('accepts contentBlocks without prompt (image-only)', async () => {
    lastRunOpts = null
    const { url, close } = await startApp()
    try {
      const res = await fetch(`${url}/api/agent/prompt`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          contentBlocks: [
            { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'AAA' } },
          ],
        }),
      })
      // 400 是我们想要的: prompt 为空时 refine 应触发
      // v2 接受 image-only, 所以应该是 200 + activeSessionId
      expect([200, 202]).toContain(res.status)
      // 排空 stream
      const reader = res.body!.getReader()
      while (true) {
        const { done } = await reader.read()
        if (done) break
      }
      expect(lastRunOpts).not.toBeNull()
      expect(Array.isArray(lastRunOpts.prompt)).toBe(true)
      expect(lastRunOpts.prompt[0].role).toBe('user')
      expect(Array.isArray(lastRunOpts.prompt[0].content)).toBe(true)
      expect(lastRunOpts.prompt[0].content[0].type).toBe('image')
    } finally {
      close()
    }
  })

  it('rejects when both prompt and contentBlocks are missing', async () => {
    const { url, close } = await startApp()
    try {
      const res = await fetch(`${url}/api/agent/prompt`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ cwd: '/tmp' }),
      })
      expect(res.status).toBe(400)
    } finally {
      close()
    }
  })
```

- [ ] **Step 2: 跑测试确认失败**

```bash
cd /Users/ethan/code/opencc-web/packages/zai
node_modules/.bin/vitest run test/server/agent.test.ts
```

Expected: 新 2 个用例 FAIL (server 尚未接 contentBlocks)

- [ ] **Step 3: 改 server route**

`packages/zai/src/server/routes/agent.ts`:

```diff
 const PromptRequest = z.object({
-  prompt: z.string().min(1).max(32_000),
+  prompt: z.string().max(32_000).optional(),
+  contentBlocks: z
+    .array(
+      z.object({
+        type: z.string(),
+        source: z
+          .object({
+            type: z.enum(['base64', 'url']),
+            media_type: z.string(),
+            data: z.string(),
+          })
+          .passthrough(),
+      }).passthrough(),
+    )
+    .max(10)
+    .optional(),
   cwd: z.string().optional(),
   sessionId: z.string().optional(),
-})
+}).refine(
+  (v) => Boolean(v.prompt?.trim()) || Boolean(v.contentBlocks?.length),
+  { message: 'prompt or contentBlocks required' },
+)
```

在 fire-and-forget `void (async () => {` 块内, 把 `runtime.run({ prompt, ... })` 改成接 `promptArg`. 在该块开头 `const text = parsed.data.prompt?.trim() ?? ''` 之后, `const blocks = parsed.data.contentBlocks` 之后:

```ts
    // ★ image-paste v2: contentBlocks 拼成 user message array; 走 queryEngine array 路径
    // (zai-agent-core queryEngine.ts:114-118 把每个元素 append 到 messages[]).
    // 当 contentBlocks 为空时, promptArg 退化为 string, 走 queryEngine 的 string 路径.
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

(把现有的 `prompt: prompt,` 改为 `prompt: promptArg,`)

- [ ] **Step 4: 跑测试确认通过**

```bash
cd /Users/ethan/code/opencc-web/packages/zai
node_modules/.bin/vitest run test/server/agent.test.ts
```

Expected: 4/4 pass (2 v1 cherry-pick + 2 v2 新)

- [ ] **Step 5: 跑全 zai typecheck**

```bash
pnpm -F zai typecheck
```

Expected: 0 errors

- [ ] **Step 6: commit**

```bash
cd /Users/ethan/code/opencc-web
git add packages/zai/src/server/routes/agent.ts packages/zai/test/server/agent.test.ts
git -c user.name=opencode -c user.email=opencode@local commit -m "feat(zai-server): /api/agent/prompt 接 contentBlocks (image-only 允许)"
```

---

## Task 3: Agent.tsx UI — local state + handlers + handleSend + MessageBubble attachments

**Files:**
- Modify: `packages/zai/src/web/src/pages/Agent.tsx` (imports + state + handlers + JSX 替换 + MessageBubble user.text 分支)

**Interfaces:**
- Consumes: `readImageAsBase64(file)` from `packages/zai/src/web/src/lib/imageReader.ts` (已有, 抛出 `ImageReadError`)
- Consumes: `AttachmentStrip` / `StripAttachment` from `packages/zai/src/web/src/components/AttachmentStrip.tsx` (Task 1)
- Produces: `attachments: PendingAttachment[]` local state; `handleSend` 把 `attachments` (filter status === 'ready') 拼成 ContentBlock[] 随 `api.post('/agent/prompt', ...)` 上行

- [ ] **Step 1: 改 imports**

`packages/zai/src/web/src/pages/Agent.tsx` 顶部 imports 块:

```diff
 import { PictureOutlined } from '@ant-design/icons'
+import { useState as _useStateAlias } from 'react'  // 仅占位, 实际 useState 已在
+import { AttachmentStrip } from '../components/AttachmentStrip'
+import { readImageAsBase64, ImageReadError } from '../lib/imageReader'
```

注: `useState` 已经在文件顶部有 import (检查 `import { useState } from 'react'` 这一行, 不重复添加). 这次只新增 `AttachmentStrip` 和 `readImageAsBase64`/`ImageReadError` 两条.

实际 edit:

```diff
+import { AttachmentStrip } from '../components/AttachmentStrip'
+import { readImageAsBase64, ImageReadError } from '../lib/imageReader'
```

(放在现有的 antd / icons / antd icons imports 之后, 跟其他本地 lib imports 同一处)

- [ ] **Step 2: 在 Agent() 组件顶部加 local state + refs**

`packages/zai/src/web/src/pages/Agent.tsx:772` 附近, `export default function Agent()` 函数体第一行 (destructure useAgentStore 之后):

```tsx
  const [attachments, setAttachments] = useState<PendingAttachment[]>([])
  const fileInputRef = useRef<HTMLInputElement>(null)
  const uploadAbortRef = useRef<AbortController | null>(null)

  // 组件 unmount 时清理 objectURL, 防止内存泄漏
  useEffect(() => {
    return () => {
      // eslint-disable-next-line react-hooks/exhaustive-deps
      attachments.forEach((a) => URL.revokeObjectURL(a.thumbnailUrl))
    }
  }, [])
```

并且在文件顶部 (在 `AgentMessage` 类型 import 之后或附近) 加 `PendingAttachment` 类型:

```ts
type PendingAttachment = {
  localId: string
  mime: string
  size: number
  filename: string
  thumbnailUrl: string
  base64DataUrl: string
  status: 'reading' | 'ready' | 'error'
  error?: string
}

const MAX_ATTACHMENTS_PER_TURN = 10
```

- [ ] **Step 3: 加 handlers (addAttachments / removeAttachment)**

在 Agent() 内部, `handleSend` 之前:

```tsx
  const addAttachments = async (files: File[]) => {
    const accepted = files.slice(0, MAX_ATTACHMENTS_PER_TURN)
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
            prev.map((a) =>
              a.localId === p.localId
                ? { ...a, base64DataUrl: r.dataUrl, status: 'ready' }
                : a,
            ),
          )
        } catch (e) {
          const msg = e instanceof ImageReadError ? e.message : (e as Error).message
          setAttachments((prev) =>
            prev.map((a) =>
              a.localId === p.localId
                ? { ...a, status: 'error', error: msg }
                : a,
            ),
          )
        }
      }),
    )
  }

  const removeAttachment = (localId: string) => {
    setAttachments((prev) => {
      const att = prev.find((a) => a.localId === localId)
      if (att) URL.revokeObjectURL(att.thumbnailUrl)
      return prev.filter((a) => a.localId !== localId)
    })
  }

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
    const files = Array.from(e.dataTransfer.files).filter((f) =>
      f.type.startsWith('image/'),
    )
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
```

- [ ] **Step 4: 改 handleSend**

`packages/zai/src/web/src/pages/Agent.tsx:854-877` 区域 (当前 `handleSend`), 替换为:

```tsx
  const handleSend = async () => {
    const text = input.trim()
    const readyAttachments = attachments.filter((a) => a.status === 'ready')
    const blocks = readyAttachments.map((a) => ({
      type: 'image' as const,
      source: {
        type: 'base64' as const,
        media_type: a.mime,
        // ★ 关键: data 是 base64DataUrl 去掉 'data:image/...;base64,' 前缀
        // 因为 server zod / openaiShim 已经会拼前缀, 重复会双重前缀.
        data: a.base64DataUrl.replace(/^data:[^;]+;base64,/, ''),
      },
    }))
    if (!text && blocks.length === 0) return
    if (status === 'streaming') return
    setInput('')

    // ★ 快照: 把 attachments 的精简版挂到 userMsg.attachments, 用 dataURL
    // (base64DataUrl) 当 thumbnailUrl. handleSend 后的 setAttachments([]) +
    // 组件 unmount 不会影响已发的气泡.
    const userMsg: AgentMessage = {
      eventId: `user-${Date.now()}`,
      sessionId: '',
      ts: Date.now(),
      turnIndex: 0,
      type: 'user.text',
      text,
      attachments: readyAttachments.map((a) => ({
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

    // 清理本地附件 (snapshot 已存到 userMsg, 不再需要)
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

- [ ] **Step 5: 替换输入区 JSX**

`packages/zai/src/web/src/pages/Agent.tsx:1149-1160` 区域 (现有 `<div style={{ display: 'flex', alignItems: 'stretch' }}>...<TextArea ...></div>`) 替换为:

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

- [ ] **Step 6: 改 MessageBubble user.text 分支**

`packages/zai/src/web/src/pages/Agent.tsx:545-563` 区域 (现有 `if (msg.type === 'user.text' || msg.type === 'user.message') { ... }`):

```tsx
  if (msg.type === 'user.text' || msg.type === 'user.message') {
    const msgAttachments = (msg.attachments as PendingAttachment[] | undefined) ?? []
    return (
      <div style={{ display: 'flex', justifyContent: 'flex-end', marginBottom: 16 }}>
        <Card
          size="small"
          style={{
            maxWidth: '70%',
            background: '#e6f4ff',
            borderRadius: 12,
          }}
        >
          {msgAttachments.length > 0 && (
            <AttachmentStrip attachments={msgAttachments} />
          )}
          <Space>
            <UserOutlined />
            <Text>{linkifyText((msg.text as string) || (msg.prompt as string) || '')}</Text>
          </Space>
        </Card>
      </div>
    )
  }
```

- [ ] **Step 7: typecheck**

```bash
cd /Users/ethan/code/opencc-web
pnpm -F zai typecheck
```

Expected: 0 errors (注: `tsc -b` 不覆盖 `src/web/**`, 但 vite build 仍会类型检查)

- [ ] **Step 8: commit**

```bash
cd /Users/ethan/code/opencc-web
git add packages/zai/src/web/src/pages/Agent.tsx
git -c user.name=opencode -c user.email=opencode@local commit -m "feat(zai-web): Agent.tsx 接图片粘贴/拖拽/按钮 + MessageBubble 渲染 attachments"
```

---

## Task 4: useAgentStore.loadTranscript 加 ContentBlock[] 分支

**Files:**
- Modify: `packages/zai/src/web/src/store/useAgentStore.ts` (顶层加 `dataURLtoBlob` helper + loadTranscript user.message 分支扩 Array 分支)

**Interfaces:**
- Consumes: `TranscriptFile.messages[].raw` 当前是 `unknown` (透明 JSON)
- Produces: 当 `Array.isArray(raw.content)`, 还原 `msg.attachments: StripAttachment[]` (useEffect revoke objectURL 由调用方负责 — 实际不强制要求, 因为 dataURL 也行)

- [ ] **Step 1: 加 dataURLtoBlob helper**

`packages/zai/src/web/src/store/useAgentStore.ts` 顶部 (imports 之后, `let runtimeToolCounter = 0` 之前):

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

- [ ] **Step 2: 改 loadTranscript**

`packages/zai/src/web/src/store/useAgentStore.ts` 内 `loadTranscript` 函数, 大约 360-395 行, `if (msg.type === 'user')` 分支 (line 366 区域):

```diff
         if (msg.type === 'user') {
           if (rawObj.kind === 'skill_injection') continue
-          messages.push({ ...baseFields, eventId: msg.uuid, type: 'user.text', text })
+          if (Array.isArray(rawObj.content)) {
+            // ContentBlock[] (可能含 image) — 还原 text 拼接 + 重建 attachments
+            const blocks = rawObj.content as Array<{
+              type: string
+              source?: { type?: string; media_type?: string; data?: string }
+              text?: string
+            }>
+            const textFromBlocks = blocks
+              .filter((b) => b.type === 'text' && typeof b.text === 'string')
+              .map((b) => b.text!)
+              .join('\n')
+            const restoredAttachments = blocks
+              .filter((b) => b.type === 'image' && b.source?.type === 'base64')
+              .map((b, i) => {
+                const dataUrl = `data:${b.source!.media_type};base64,${b.source!.data}`
+                const blob = dataURLtoBlob(dataUrl)
+                const thumbnailUrl = blob ? URL.createObjectURL(blob) : dataUrl
+                return {
+                  localId: `${msg.uuid}-img-${i}`,
+                  mime: b.source!.media_type ?? 'image/png',
+                  filename: '[历史图片]',
+                  thumbnailUrl,
+                  status: blob ? ('ready' as const) : ('error' as const),
+                  error: blob ? undefined : '图片已损坏',
+                }
+              })
+            messages.push({
+              ...baseFields,
+              eventId: msg.uuid,
+              type: 'user.text',
+              text: textFromBlocks,
+              ...(restoredAttachments.length ? { attachments: restoredAttachments } : {}),
+            })
+          } else {
+            messages.push({ ...baseFields, eventId: msg.uuid, type: 'user.text', text })
+          }
         } else if (msg.type === 'assistant') {
```

- [ ] **Step 3: typecheck**

```bash
cd /Users/ethan/code/opencc-web
pnpm -F zai typecheck
```

Expected: 0 errors

- [ ] **Step 4: 跑 web 测试确认没回归**

```bash
cd /Users/ethan/code/opencc-web/packages/zai
node_modules/.bin/vitest run test/web/
```

Expected: 现有测试都通过 (4 imageReader 已有, 其他不变)

- [ ] **Step 5: commit**

```bash
cd /Users/ethan/code/opencc-web
git add packages/zai/src/web/src/store/useAgentStore.ts
git -c user.name=opencode -c user.email=opencode@local commit -m "feat(zai-web): useAgentStore.loadTranscript 还原 ContentBlock[] (图片消息)"
```

---

## Task 5: 全量 build + smoke

**Files:** 无

- [ ] **Step 1: 全 workspace build**

```bash
cd /Users/ethan/code/opencc-web
pnpm -r build
```

Expected: 0 errors (zai-agent-core tsc Done + zai tsc + vite 5119 modules Done)

- [ ] **Step 2: web 测试**

```bash
cd /Users/ethan/code/opencc-web/packages/zai
node_modules/.bin/vitest run test/web/ test/server/agent.test.ts
```

Expected: 全 pass (imageReader 4 + 已有 11+ + agent.test.ts 4)

- [ ] **Step 3: dev server smoke**

```bash
cd /Users/ethan/code/opencc-web/packages/zai
node bin/zai.js dev 2>&1 &
ZAI_PID=$!
sleep 5
lsof -i :7715 2>&1 | grep LISTEN
lsof -i :9888 2>&1 | grep LISTEN
kill $ZAI_PID 2>/dev/null
wait 2>/dev/null
echo "smoke done"
```

Expected: API :7715 + Vite :9888 都 LISTEN, no panic, no errors

- [ ] **Step 4: 无 commit (验证步骤)**

如 Step 1-3 全部通过, 任务完成. 失败则回到对应 Task 修.

---

## Self-Review Checklist

### 1. Spec coverage

- §2.1 server route contentBlocks → Task 2 ✓
- §2.2 Agent.tsx local state + handlers → Task 3 ✓
- §2.3 MessageBubble attachments render → Task 3 Step 6 ✓
- §2.4 loadTranscript array branch → Task 4 ✓
- §2.5 AttachmentStrip cherry-pick → Task 1 ✓
- §3 不引入 — 显式未动 useEventStream / sendMessage / useAppStore 等 ✓
- §4 错误处理 — Task 3 的 handlePaste/handleDrop 已覆盖 ✓
- §5 测试 — Task 2 (server unit) + Task 5 (E2E manual deferred) ✓
- §6 范围外 — 显式 YAGNI ✓

### 2. Placeholder scan

- 无 "TBD" / "TODO" / "类似 Task N"
- 每个代码块都完整可运行
- 路径精确到行号

### 3. Type consistency

- `PendingAttachment` 在 Task 3 (Agent.tsx) 定义, 在 Task 3 Step 6 (MessageBubble) 引用 — 一致
- `StripAttachment` 从 Task 1 (cherry-pick AttachmentStrip) 导出, Task 3 Step 6 引用 — 一致
- `dataURLtoBlob` 单点定义 (Task 4)
- `UserMessage` / `UserMessageContent` 已在 agent.ts 顶部 (line 8-9), Task 2 复用 — 一致
- Task 3 handleSend 的 `data: a.base64DataUrl.replace(/^data:[^;]+;base64,/, '')` 与 v1 review 修复 (dataURL 前缀) 一致

---

## Execution Handoff

**Plan complete and saved to `docs/superpowers/plans/2026-07-12-image-paste-parse-v2.md`. Two execution options:**

1. **Subagent-Driven (recommended)** - Fresh subagent per task with review gates
2. **Inline Execution** - Execute in this session with checkpoints

**Which approach?**
