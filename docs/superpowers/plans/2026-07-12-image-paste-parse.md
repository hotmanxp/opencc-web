# zai Web 图片粘贴与解析 实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让 zai Web 的 Agent 聊天输入框支持粘贴 / 拖拽 / 点击上传图片，图片以 base64 ContentBlock 形式随消息送到 MiniMax，刷新页面仍能看到。

**Architecture:** 全前端 base64 内联。粘贴/拖拽/选文件 → `FileReader.readAsDataURL()` → 转 `ContentBlock[]` → `useAgentStore.sendMessage` → `runAgentStream` POST `/api/agent/stream` body 新增 `contentBlocks` → server 拼成 `prompt: [{ role: 'user', content: ContentBlock[] }]` 走 zai-agent-core `query()` 的 array 路径（已支持）→ MiniMax `/anthropic/v1/messages` 接受 base64 image block。transcript `raw.content` 序列化数组；前端 `loadTranscript` 还原缩略图条。

**Tech Stack:** Bun + pnpm + vitest, React 18, zustand, AntD 5, Express 5, zod, SSE (fetch ReadableStream).

## Global Constraints

- 单张图片 ≤ **10MB**, 仅接受 MIME `image/jpeg | image/png | image/gif | image/webp`
- 单次粘贴/拖拽/选择最多 **10** 张, 超出的 File 静默丢弃 (避免单条 message base64 体积爆炸)
- `createUserMessage.imagePasteIds` 形参类型 `number[]` → `string[]` (与 `UserMessage.imagePasteIds?: string[]` 顶层对齐)
- 服务端路由路径: **`POST /api/agent/stream`** (不是 `/api/agent/run`), 校验器在 `packages/zai/src/server/routes/agent.ts:11`
- MessageBubble 是 Agent.tsx 内联组件 (`packages/zai/src/web/src/pages/Agent.tsx:539`), 不是独立文件
- `QueryOptions.prompt` 已支持 `string | UserMessage | UserMessage[]` (zai-agent-core runtime/types.ts:82), array 路径在 `queryLoop.ts:114-118` 已实现
- 不引入 Files API 调用, 不调 zai-agent-core `uploadFile()`, 不增 server `/api/files/upload` route
- 提交规范: `feat(scope): xxx` / `fix(scope): xxx` / `chore / docs / refactor / test / style`, 详见 `AGENTS.md`
- 测试框架: vitest (`packages/zai/test/web/*.test.ts` 与 `packages/zai-agent-core/test/**/*.test.ts`), 全局命令 `pnpm -F zai test` / `pnpm -F zai-agent-core test`
- 包管理: zai 与 zai-agent-core 是 `packages/zai` 与 `packages/zai-agent-core` 两个独立 npm package, 路径相关 patch 需各自提交

---

## File Structure

### 新建

| 路径 | 职责 |
|------|------|
| `packages/zai/src/web/src/lib/imageReader.ts` | `readImageAsBase64(file, signal?)` + `ImageReadError` class, 校验 MIME + size + 包装 FileReader, 处理 abort |
| `packages/zai/src/web/src/components/AttachmentStrip.tsx` | 缩略图条组件, 接 `attachments: PendingAttachment[]`, useEffect cleanup revoke 所有 objectURL |

### 修改

| 路径 | 改动摘要 |
|------|----------|
| `packages/zai/src/web/src/lib/sseAgent.ts` | `AgentStreamOptions` 加 `contentBlocks?: ContentBlock[]`, POST body 序列化 |
| `packages/zai/src/web/src/store/useAgentStore.ts` | attachments slice (addAttachments / removeAttachment / clearAttachments), `sendMessage` 签名扩为 `{ text, contentBlocks }`, `loadTranscript` 重建 attachments |
| `packages/zai/src/web/src/pages/Agent.tsx` | TextArea onPaste/onDrop + 🖼 按钮 + 缩略图条 + `handleSend` 拼 contentBlocks + `MessageBubble` user.text 分支加 attachments 渲染 |
| `packages/zai/src/server/routes/agent.ts` | `StreamRequest` zod schema 加 `contentBlocks` 字段, 改用 array 路径 (`prompt: [{ role: 'user', content: ContentBlock[] }]`) |
| `packages/zai-agent-core/src/opencc-internals/utils/messages.ts:497` | `createUserMessage` 形参 `imagePasteIds?: number[]` → `string[]` |
| `packages/zai-agent-core/src/runtime/queryLoop.ts:99` | resumeFromTranscriptId 路径: 当 `raw.content` 是 array 时, 直接作为 content blocks 传给 modelCaller, 不再塌成 `''` |
| `packages/zai/test/web/imageReader.test.ts` | (新建) readImageAsBase64 单测 |
| `packages/zai/test/web/useAgentStore.test.ts` | 扩 attachments 相关用例 (loadTranscript 重建 + removeAttachment revoke) |
| `packages/zai/test/server/agent.test.ts` | (新建) `/api/agent/stream` 接 contentBlocks 集成测试 |

### 不修改

- ❌ `packages/zai-agent-core/src/transcript/store.ts` — `TranscriptMessage.raw: unknown` 已经支持任意 JSON, `JSON.stringify(raw.content)` 自然处理 array
- ❌ `packages/zai-agent-core/src/opencc-internals/services/api/filesApi.ts` — 不走 Files API

---

## Task 1: imageReader 库 + 单测

**Files:**
- Create: `packages/zai/src/web/src/lib/imageReader.ts`
- Create: `packages/zai/test/web/imageReader.test.ts`

**Interfaces:**
- Produces:
  ```ts
  export class ImageReadError extends Error {
    constructor(public reason: 'unsupported_mime' | 'too_large' | 'read_failed', message: string)
  }
  export function readImageAsBase64(
    file: File,
    signal?: AbortSignal,
  ): Promise<{ mime: string; dataUrl: string; size: number; filename: string }>
  ```

### Step 1: 写失败测试

`packages/zai/test/web/imageReader.test.ts`:

```ts
import { describe, expect, it, vi } from 'vitest'
import { readImageAsBase64, ImageReadError } from '../../src/web/src/lib/imageReader'

// 构造一个能在测试环境跑起来的最小 File polyfill.
// happy-dom / jsdom 没有内置 File, 但 vitest 在 test/web/* 默认走 happy-dom,
// 其 globalThis.File 是不可用的. 用 Blob + name/type 手搓一个最小版本.
function makeFile(content: string, name: string, type: string, sizeBytes?: number): File {
  // BlobPart 可以是 string 或 Uint8Array; 这里给 string, 浏览器会自动算 size
  return new Blob([content], { type }) as unknown as File
  // 上面丢 name 也没关系, 我们在测试里单独传 filename
}

// Mock FileReader (happy-dom 没有完整的 FileReader)
class MockFileReader {
  result: string | ArrayBuffer | null = null
  error: Error | null = null
  onload: (() => void) | null = null
  onerror: (() => void) | null = null
  onabort: (() => void) | null = null
  abort() { this.onabort?.() }
  readAsDataURL(blob: Blob) {
    // 模拟 base64: 'data:' + blob.type + ';base64,' + btoa(content)
    blob.text().then(text => {
      this.result = `data:${blob.type};base64,${btoa(text)}`
      this.onload?.()
    })
  }
}

describe('readImageAsBase64', () => {
  it('returns dataURL for valid PNG', async () => {
    vi.stubGlobal('FileReader', MockFileReader)
    const f = makeFile('fake-png-bytes', 'shot.png', 'image/png')
    Object.defineProperty(f, 'name', { value: 'shot.png' })
    const r = await readImageAsBase64(f)
    expect(r.mime).toBe('image/png')
    expect(r.dataUrl).toMatch(/^data:image\/png;base64,/)
    expect(r.filename).toBe('shot.png')
    vi.unstubAllGlobals()
  })

  it('throws unsupported_mime for text/plain', async () => {
    const f = makeFile('hello', 'note.txt', 'text/plain')
    Object.defineProperty(f, 'name', { value: 'note.txt' })
    await expect(readImageAsBase64(f)).rejects.toThrowError(ImageReadError)
    try { await readImageAsBase64(f) } catch (e: any) {
      expect(e.reason).toBe('unsupported_mime')
    }
  })

  it('throws too_large when file > 10MB', async () => {
    // 用 11MB Buffer 模拟
    const big = new Uint8Array(11 * 1024 * 1024)
    const f = new Blob([big], { type: 'image/png' }) as unknown as File
    Object.defineProperty(f, 'name', { value: 'big.png' })
    await expect(readImageAsBase64(f)).rejects.toThrowError(ImageReadError)
    try { await readImageAsBase64(f) } catch (e: any) {
      expect(e.reason).toBe('too_large')
    }
  })

  it('throws read_failed when signal is already aborted', async () => {
    const f = makeFile('x', 'x.png', 'image/png')
    Object.defineProperty(f, 'name', { value: 'x.png' })
    const ctrl = new AbortController()
    ctrl.abort()
    await expect(readImageAsBase64(f, ctrl.signal)).rejects.toThrowError(/已取消/)
  })
})
```

### Step 2: 跑测试确认失败

```bash
cd /Users/ethan/code/opencc-web && pnpm -F zai test imageReader.test.ts
```

Expected: FAIL (module not found)

### Step 3: 实现 imageReader

`packages/zai/src/web/src/lib/imageReader.ts`:

```ts
// MiniMax /anthropic/v1/messages 限制: image 直接 base64 输入 ≤ 10MB
// 支持 JPEG / PNG / GIF / WEBP
// Source: https://platform.minimax.io/docs/api-reference/text-chat-anthropic (MediaSource)
const MAX_BYTES = 10 * 1024 * 1024
const ALLOWED_MIME = new Set(['image/jpeg', 'image/png', 'image/gif', 'image/webp'])

export class ImageReadError extends Error {
  constructor(
    public reason: 'unsupported_mime' | 'too_large' | 'read_failed',
    message: string,
  ) {
    super(message)
    this.name = 'ImageReadError'
  }
}

export type ImageReadResult = {
  mime: string
  dataUrl: string
  size: number
  filename: string
}

export async function readImageAsBase64(
  file: File,
  signal?: AbortSignal,
): Promise<ImageReadResult> {
  if (!ALLOWED_MIME.has(file.type)) {
    throw new ImageReadError(
      'unsupported_mime',
      `不支持的图片格式: ${file.type || '未知'}`,
    )
  }
  if (file.size > MAX_BYTES) {
    throw new ImageReadError(
      'too_large',
      `图片超过 10MB 上限 (${(file.size / 1024 / 1024).toFixed(1)}MB)`,
    )
  }
  if (signal?.aborted) {
    throw new ImageReadError('read_failed', '已取消')
  }
  return new Promise<ImageReadResult>((resolve, reject) => {
    const reader = new FileReader()
    reader.onerror = () =>
      reject(new ImageReadError('read_failed', reader.error?.message ?? '读取失败'))
    reader.onabort = () => reject(new ImageReadError('read_failed', '已取消'))
    reader.onload = () => {
      const dataUrl = reader.result as string
      resolve({
        mime: file.type,
        dataUrl,
        size: file.size,
        filename: file.name || 'image',
      })
    }
    if (signal) {
      signal.addEventListener(
        'abort',
        () => reader.abort(),
        { once: true },
      )
    }
    reader.readAsDataURL(file)
  })
}
```

### Step 4: 跑测试确认通过

```bash
pnpm -F zai test imageReader.test.ts
```

Expected: 4 passed

### Step 5: Commit

```bash
git add packages/zai/src/web/src/lib/imageReader.ts packages/zai/test/web/imageReader.test.ts
git commit -m "feat(zai-web): 新增 readImageAsBase64 helper (粘贴/拖拽前置)"
```

---

## Task 2: 修 createUserMessage.imagePasteIds 类型 number[] → string[]

**Files:**
- Modify: `packages/zai-agent-core/src/opencc-internals/utils/messages.ts:497`

**Interfaces:**
- Mutates: `createUserMessage` 形参 `imagePasteIds?: number[]` → `string[]` (与 `UserMessage.imagePasteIds?: string[]` 顶层类型对齐)

### Step 1: 跑 typecheck 确认基线

```bash
pnpm -F zai-agent-core typecheck
```

Expected: 0 errors (本次改动前的现状)

### Step 2: 改 messages.ts

`packages/zai-agent-core/src/opencc-internals/utils/messages.ts:497`:

```diff
-  imagePasteIds?: number[]
+  imagePasteIds?: string[]
```

### Step 3: 跑 typecheck 确认通过

```bash
pnpm -F zai-agent-core typecheck
```

Expected: 0 errors

### Step 4: 跑所有 zai-agent-core 测试确认没回归

```bash
pnpm -F zai-agent-core test
```

Expected: 全部通过 (类型兼容, 没有 runtime 调用差异)

### Step 5: Commit

```bash
git add packages/zai-agent-core/src/opencc-internals/utils/messages.ts
git commit -m "fix(zai-agent-core): createUserMessage.imagePasteIds 类型 number[] → string[]"
```

---

## Task 3: queryLoop resume 路径支持 array content

> 关键修复: 当 transcript 里 user message 的 `raw.content` 是 `ContentBlock[]` (图片) 而非 string 时, resume 该 session 不能再塌成空字符串喂模型. 这一步不依赖 Task 1/2 但与它们正交, 提前做以便 server 端代码可以依赖该行为.

**Files:**
- Modify: `packages/zai-agent-core/src/runtime/queryLoop.ts:99`

### Step 1: 读现状

读 `packages/zai-agent-core/src/runtime/queryLoop.ts:90-120`, 确认改动位置.

### Step 2: 改 queryLoop.ts

```diff
       if (role === 'user') {
-        content = typeof raw.content === 'string' ? raw.content : ''
+        content = Array.isArray(raw.content)
+          ? raw.content  // ContentBlock[] (例如带图片) 直接传给 modelCaller
+          : typeof raw.content === 'string'
+            ? raw.content
+            : ''
       } else {
```

### Step 3: 跑 typecheck

```bash
pnpm -F zai-agent-core typecheck
```

Expected: 0 errors (raw.content 已经是 unknown, 这里只是改类型分支)

### Step 4: 跑测试确认没回归

```bash
pnpm -F zai-agent-core test
```

Expected: 全部通过

### Step 5: Commit

```bash
git add packages/zai-agent-core/src/runtime/queryLoop.ts
git commit -m "fix(zai-agent-core): queryLoop resume 路径支持 array content (图片消息)"
```

---

## Task 4: server `/api/agent/stream` 接受 contentBlocks

**Files:**
- Modify: `packages/zai/src/server/routes/agent.ts`
- Create: `packages/zai/test/server/agent.test.ts`

**Interfaces:**
- Consumes: `{ prompt: string, contentBlocks?: ContentBlock[], cwd?, sessionId? }` (前端 POST body)
- Produces: 调 `runtime.run({ prompt: [{ role: 'user', content: ContentBlock[] }] | string, cwd, resumeFromTranscriptId, systemPrompt, abortSignal })` 走 array 路径

### Step 1: 写失败测试

`packages/zai/test/server/agent.test.ts`:

```ts
import { describe, expect, it, vi, beforeAll } from 'vitest'
import express from 'express'
import http from 'node:http'
import agentRouter from '../../src/server/routes/agent.js'

// Mock agentRuntime — 不需要真实 LLM 跑, 我们只验证请求体透传
let lastRunOpts: any = null
vi.mock('../../src/server/services/agentRuntime.js', () => ({
  getRuntime: () => ({
    run: (opts: any) => {
      lastRunOpts = opts
      // 立刻结束的 async iterable, 避免 hanging
      return (async function* () {
        yield { type: 'runtime.done', eventId: 'd', sessionId: 'sess-1', ts: 0, turnIndex: 1 }
      })()
    },
    abort: async () => {},
    listSessions: async () => [],
    readSession: async () => ({ version: 1, transcriptId: 'sess-1', meta: {} as any, messages: [] }),
    patchSession: async () => {},
    removeSession: async () => {},
  }),
  getAskRegistry: () => ({ abortAll: () => {} }),
  getCurrentSessionId: () => 'sess-1',
  setCurrentSessionId: () => {},
  getTranscriptStore: () => ({
    list: async () => [],
    read: async () => ({ version: 1, transcriptId: 'sess-1', meta: {} as any, messages: [] }),
    patch: async () => {},
    remove: async () => {},
    append: async () => {},
  }),
  initAgentRuntime: () => {},
  abortAgentSession: async () => {},
}))

vi.mock('@zn-ai/zai-agent-core', () => ({
  loadAgentsMd: async () => null,
  buildAgentsMdSystemPrompt: () => null,
}))

function startApp(): Promise<{ url: string; close: () => void }> {
  return new Promise((resolve) => {
    const app = express()
    app.use(express.json())
    app.use('/api', agentRouter)
    const server = http.createServer(app).listen(0, () => {
      const addr = server.address() as any
      resolve({
        url: `http://127.0.0.1:${addr.port}`,
        close: () => server.close(),
      })
    })
  })
}

describe('POST /api/agent/stream with contentBlocks', () => {
  it('passes contentBlocks to runtime.run as array prompt', async () => {
    const { url, close } = await startApp()
    try {
      const res = await fetch(`${url}/api/agent/stream`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          prompt: 'describe this',
          contentBlocks: [
            { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'data:image/png;base64,AAA' } },
          ],
        }),
      })
      // 读 SSE 流 (哪怕只有 done 事件, 也要消费完才能拿到 lastRunOpts)
      const reader = res.body!.getReader()
      const dec = new TextDecoder()
      let buf = ''
      while (true) {
        const { done, value } = await reader.read()
        if (done) break
        buf += dec.decode(value, { stream: true })
      }
      // 断言 runtime.run 收到了 array prompt, 且第一个 message 的 content 是 ContentBlock[]
      expect(Array.isArray(lastRunOpts.prompt)).toBe(true)
      expect(lastRunOpts.prompt).toHaveLength(1)
      expect(lastRunOpts.prompt[0].role).toBe('user')
      expect(Array.isArray(lastRunOpts.prompt[0].content)).toBe(true)
      expect(lastRunOpts.prompt[0].content[0].type).toBe('image')
      // 确认 text 也拼上去了
      const textBlock = lastRunOpts.prompt[0].content.find((b: any) => b.type === 'text')
      expect(textBlock?.text).toBe('describe this')
    } finally {
      close()
    }
  })

  it('falls back to string prompt when contentBlocks absent', async () => {
    lastRunOpts = null
    const { url, close } = await startApp()
    try {
      const res = await fetch(`${url}/api/agent/stream`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ prompt: 'hello' }),
      })
      const reader = res.body!.getReader()
      while (true) {
        const { done } = await reader.read()
        if (done) break
      }
      expect(lastRunOpts.prompt).toBe('hello')
    } finally {
      close()
    }
  })
})
```

### Step 2: 跑测试确认失败

```bash
pnpm -F zai test agent.test.ts
```

Expected: FAIL (contentBlocks 还没被 server 识别)

### Step 3: 改 server route

`packages/zai/src/server/routes/agent.ts`:

```diff
 const StreamRequest = z.object({
   prompt: z.string().min(1).max(32_000),
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
+    .max(10) // 与前端 MAX_ATTACHMENTS_PER_TURN 一致
+    .optional(),
   cwd: z.string().optional(),
   token: z.string().optional(),
   sessionId: z.string().optional(),
 })
```

然后改 `runtime.run` 调用:

```diff
 router.post('/agent/stream', async (req: Request, res: Response) => {
   const parsed = StreamRequest.safeParse(req.body)
   if (!parsed.success) {
     return res.status(400).json({ error: 'invalid body: need {prompt, cwd?}' })
   }

-  const { prompt, cwd = process.cwd(), sessionId: existingSessionId } = parsed.data
+  const { prompt, contentBlocks, cwd = process.cwd(), sessionId: existingSessionId } = parsed.data
   const runtime = getRuntime()

   ...

   try {
+    // 拼 user message: ContentBlock[] 在前, text 块在后.
+    // zai-agent-core queryLoop array 路径 (queryLoop.ts:114) 会把每个元素
+    // 作为 user message append 到 messages[], 内部 appendUserMessage 直接
+    // JSON.stringify 进 raw.content, 无需手动序列化.
+    const userContent = contentBlocks?.length
+      ? [
+          ...contentBlocks,
+          ...(prompt ? [{ type: 'text' as const, text: prompt }] : []),
+        ]
+      : prompt
+    const promptArg: string | Array<{ role: 'user'; content: unknown }> =
+      typeof userContent === 'string'
+        ? userContent
+        : [{ role: 'user', content: userContent }]
+
     const events = runtime.run({
-      prompt,
+      prompt: promptArg,
       cwd,
       ...(existingSessionId ? { resumeFromTranscriptId: existingSessionId } : {}),
       systemPrompt,
       abortSignal: abortController.signal,
     })
```

### Step 4: 跑测试确认通过

```bash
pnpm -F zai test agent.test.ts
```

Expected: 2 passed

### Step 5: Commit

```bash
git add packages/zai/src/server/routes/agent.ts packages/zai/test/server/agent.test.ts
git commit -m "feat(zai-server): /api/agent/stream 接受 contentBlocks (走 array prompt 路径)"
```

---

## Task 5: sseAgent.runAgentStream 透传 contentBlocks

**Files:**
- Modify: `packages/zai/src/web/src/lib/sseAgent.ts`

### Step 1: 改 sseAgent.ts

```diff
 export type AgentStreamOptions = {
   prompt: string
+  contentBlocks?: Array<{ type: string; source?: { type: string; media_type?: string; data?: string }; [k: string]: unknown }>
   cwd?: string
   sessionId?: string
   onEvent: (event: RuntimeEvent) => void
   onEnd?: () => void
   signal?: AbortSignal
 }

 export async function runAgentStream(opts: AgentStreamOptions): Promise<void> {
-  const { prompt, cwd, sessionId, onEvent, onEnd, signal } = opts
+  const { prompt, cwd, sessionId, contentBlocks, onEvent, onEnd, signal } = opts

   const token = localStorage.getItem('zai-token') || ''

   const response = await fetch(`${API_BASE}/agent/stream`, {
     method: 'POST',
     headers: {
       'Content-Type': 'application/json',
       'X-Zai-Token': token,
     },
-    body: JSON.stringify({ prompt, cwd, sessionId }),
+    body: JSON.stringify({
+      prompt,
+      ...(contentBlocks?.length ? { contentBlocks } : {}),
+      cwd,
+      sessionId,
+    }),
     signal,
   })
```

### Step 2: 跑 typecheck

```bash
pnpm -F zai typecheck
```

Expected: 0 errors

### Step 3: Commit

```bash
git add packages/zai/src/web/src/lib/sseAgent.ts
git commit -m "feat(zai-web): runAgentStream 透传 contentBlocks"
```

---

## Task 6: AttachmentStrip 组件

**Files:**
- Create: `packages/zai/src/web/src/components/AttachmentStrip.tsx`

**Interfaces:**
- Produces:
  ```tsx
  export function AttachmentStrip(props: { attachments: PendingAttachment[]; onRemove?: (localId: string) => void })
  ```

### Step 1: 实现组件

`packages/zai/src/web/src/components/AttachmentStrip.tsx`:

```tsx
import { Button, Spin } from 'antd'
import { CloseOutlined } from '@ant-design/icons'

export type StripAttachment = {
  localId: string
  mime: string
  filename: string
  thumbnailUrl: string
  status: 'reading' | 'ready' | 'error'
  error?: string
}

export function AttachmentStrip({
  attachments,
  onRemove,
}: {
  attachments: StripAttachment[]
  onRemove?: (localId: string) => void
}) {
  if (attachments.length === 0) return null
  return (
    <div
      style={{
        display: 'flex',
        gap: 8,
        flexWrap: 'wrap',
        padding: '8px 0',
      }}
    >
      {attachments.map((a) => (
        <div
          key={a.localId}
          style={{
            position: 'relative',
            width: 80,
            height: 80,
            borderRadius: 6,
            overflow: 'hidden',
            background: 'rgba(0,0,0,0.04)',
            border: a.status === 'error' ? '1px solid #ff4d4f' : '1px solid transparent',
          }}
          title={a.filename}
        >
          {a.status === 'ready' ? (
            <img
              src={a.thumbnailUrl}
              alt={a.filename}
              style={{
                width: '100%',
                height: '100%',
                objectFit: 'cover',
                display: 'block',
              }}
            />
          ) : a.status === 'error' ? (
            <div
              style={{
                fontSize: 10,
                color: '#ff4d4f',
                padding: 4,
                overflow: 'hidden',
                textOverflow: 'ellipsis',
                wordBreak: 'break-all',
              }}
            >
              {a.error ?? '加载失败'}
            </div>
          ) : (
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', height: '100%' }}>
              <Spin size="small" />
            </div>
          )}
          {onRemove && (
            <Button
              size="small"
              type="text"
              icon={<CloseOutlined />}
              onClick={() => onRemove(a.localId)}
              title="移除"
              style={{
                position: 'absolute',
                top: 2,
                right: 2,
                width: 20,
                height: 20,
                minWidth: 20,
                padding: 0,
                background: 'rgba(0,0,0,0.55)',
                color: '#fff',
                display: 'inline-flex',
                alignItems: 'center',
                justifyContent: 'center',
              }}
            />
          )}
        </div>
      ))}
    </div>
  )
}
```

### Step 2: 跑 typecheck

```bash
pnpm -F zai typecheck
```

Expected: 0 errors

### Step 3: Commit

```bash
git add packages/zai/src/web/src/components/AttachmentStrip.tsx
git commit -m "feat(zai-web): 新增 AttachmentStrip 组件"
```

---

## Task 7: useAgentStore attachments slice + sendMessage + loadTranscript

**Files:**
- Modify: `packages/zai/src/web/src/store/useAgentStore.ts`
- Modify: `packages/zai/test/web/useAgentStore.test.ts`

### Step 1: 读现状

读 `packages/zai/test/web/useAgentStore.test.ts` 看现有测试模式, 复用相同 mock 风格 (zustand 的 create + 直接调用 store action).

### Step 2: 写失败测试

**attachments slice 测试**: 在 `packages/zai/test/web/useAgentStore.test.ts` 末尾追加:

```ts
describe('useAgentStore attachments', () => {
  beforeEach(() => {
    useAgentStore.setState({ attachments: [] })
  })

  it('addAttachments 注入 ready attachment', async () => {
    const store = useAgentStore.getState()
    const f = new Blob(['fake'], { type: 'image/png' }) as unknown as File
    Object.defineProperty(f, 'name', { value: 'x.png' })
    await store.addAttachments([f])
    const att = useAgentStore.getState().attachments
    expect(att).toHaveLength(1)
    expect(att[0].status).toBe('ready')
    expect(att[0].mime).toBe('image/png')
    expect(att[0].thumbnailUrl).toMatch(/^blob:/)
  })

  it('removeAttachment 调用 URL.revokeObjectURL', async () => {
    const store = useAgentStore.getState()
    const f = new Blob(['x'], { type: 'image/png' }) as unknown as File
    Object.defineProperty(f, 'name', { value: 'x.png' })
    await store.addAttachments([f])
    const att = useAgentStore.getState().attachments[0]!
    const spy = vi.spyOn(URL, 'revokeObjectURL')
    store.removeAttachment(att.localId)
    expect(spy).toHaveBeenCalledWith(att.thumbnailUrl)
    expect(useAgentStore.getState().attachments).toHaveLength(0)
  })

  it('addAttachments 静默丢弃超出 10 张的文件', async () => {
    const store = useAgentStore.getState()
    const files = Array.from({ length: 12 }, (_, i) => {
      const f = new Blob(['x'], { type: 'image/png' }) as unknown as File
      Object.defineProperty(f, 'name', { value: `${i}.png` })
      return f
    })
    await store.addAttachments(files)
    expect(useAgentStore.getState().attachments).toHaveLength(10)
  })

  it('addAttachments 对 oversized File 标记 error', async () => {
    const store = useAgentStore.getState()
    const big = new Uint8Array(11 * 1024 * 1024)
    const f = new Blob([big], { type: 'image/png' }) as unknown as File
    Object.defineProperty(f, 'name', { value: 'big.png' })
    await store.addAttachments([f])
    const att = useAgentStore.getState().attachments
    expect(att).toHaveLength(1)
    expect(att[0].status).toBe('error')
    expect(att[0].error).toMatch(/10MB/)
  })
})
```

并在文件顶部补 import:

```ts
import { describe, it, expect, beforeEach, vi } from 'vitest'
```

**sendMessage 单独测试** (mock sseAgent 模块, 避免污染其他用例): 新建 `packages/zai/test/web/useAgentStore.sendMessage.test.ts`:

```ts
import { describe, it, expect, beforeEach, vi } from 'vitest'

// 必须 hoist: vi.mock 在 import 之前替换模块
vi.mock('../../src/web/src/lib/sseAgent', () => ({
  runAgentStream: vi.fn(async () => {}),
  abortAgent: vi.fn(),
}))

import { useAgentStore } from '../../src/web/src/store/useAgentStore'
import { runAgentStream } from '../../src/web/src/lib/sseAgent'

const runMock = vi.mocked(runAgentStream)

describe('useAgentStore.sendMessage with contentBlocks', () => {
  beforeEach(() => {
    useAgentStore.setState({
      messages: [],
      attachments: [],
      textSegmentRev: 0,
      segmentedToolUseIds: {},
      sendSeq: 0,
    })
    runMock.mockClear()
  })

  it('把 attachments 拼成 base64 ContentBlock[] 传给 runAgentStream', async () => {
    const store = useAgentStore.getState()
    const f = new Blob(['x'], { type: 'image/png' }) as unknown as File
    Object.defineProperty(f, 'name', { value: 'y.png' })
    await store.addAttachments([f])
    await store.sendMessage({ text: 'hi' })
    expect(runMock).toHaveBeenCalledOnce()
    const arg = runMock.mock.calls[0]![0] as any
    expect(arg.prompt).toBe('hi')
    expect(Array.isArray(arg.contentBlocks)).toBe(true)
    expect(arg.contentBlocks[0].type).toBe('image')
    expect(arg.contentBlocks[0].source.type).toBe('base64')
    expect(arg.contentBlocks[0].source.data).toMatch(/^data:image\/png;base64,/)
  })

  it('无 attachments 时不传 contentBlocks', async () => {
    await useAgentStore.getState().sendMessage({ text: 'just text' })
    const arg = runMock.mock.calls[0]![0] as any
    expect(arg.prompt).toBe('just text')
    expect(arg.contentBlocks).toBeUndefined()
  })

  it('sendMessage 后 clearAttachments() 清空 slice', async () => {
    const store = useAgentStore.getState()
    const f = new Blob(['x'], { type: 'image/png' }) as unknown as File
    Object.defineProperty(f, 'name', { value: 'z.png' })
    await store.addAttachments([f])
    await store.sendMessage({ text: 'go' })
    // runAgentStream 是同步 resolve 的 mock, sendMessage 在 await 后已经走到 onEnd → clearAttachments
    expect(useAgentStore.getState().attachments).toHaveLength(0)
  })
})
```

### Step 3: 跑测试确认失败

```bash
pnpm -F zai test useAgentStore.test.ts
```

Expected: FAIL (addAttachments 不存在)

### Step 4: 改 useAgentStore.ts

在文件顶部 import 增加:

```ts
import { readImageAsBase64, ImageReadError } from '../lib/imageReader'
```

新增类型 + 常量 (放在文件顶部 AgentMessage 旁):

```ts
export type PendingAttachment = {
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

`AgentState` interface 加 3 个字段 + 改 sendMessage 签名:

```diff
 interface AgentState {
   ...
   sendMessage: (args: { text: string; contentBlocks?: Array<{ type: string; source?: unknown; [k: string]: unknown }> }, cwd?: string) => Promise<void>
+  attachments: PendingAttachment[]
+  addAttachments: (files: File[], signal?: AbortSignal) => Promise<void>
+  removeAttachment: (localId: string) => void
+  clearAttachments: () => void
 }
```

`create<AgentState>((set, get) => ({` 内初始值:

```diff
   sendSeq: 0,
+  attachments: [],
+
+  addAttachments: async (files, signal) => {
+    // 上限 10 张, 超出静默丢弃
+    const accepted = files.slice(0, MAX_ATTACHMENTS_PER_TURN)
+    const placeholders: PendingAttachment[] = accepted.map(file => ({
+      localId: crypto.randomUUID(),
+      mime: file.type,
+      size: file.size,
+      filename: file.name || 'image',
+      thumbnailUrl: URL.createObjectURL(file),
+      base64DataUrl: '',
+      status: 'reading',
+    }))
+    set(s => ({ attachments: [...s.attachments, ...placeholders] }))
+
+    await Promise.all(placeholders.map(async (p, i) => {
+      try {
+        const r = await readImageAsBase64(accepted[i]!, signal)
+        set(s => ({
+          attachments: s.attachments.map(a =>
+            a.localId === p.localId
+              ? { ...a, base64DataUrl: r.dataUrl, status: 'ready' }
+              : a,
+          ),
+        }))
+      } catch (e) {
+        const msg = e instanceof ImageReadError ? e.message : (e as Error).message
+        set(s => ({
+          attachments: s.attachments.map(a =>
+            a.localId === p.localId
+              ? { ...a, status: 'error', error: msg }
+              : a,
+          ),
+        }))
+      }
+    }))
+  },
+
+  removeAttachment: (localId) => {
+    const att = get().attachments.find(a => a.localId === localId)
+    if (att) URL.revokeObjectURL(att.thumbnailUrl)
+    set(s => ({ attachments: s.attachments.filter(a => a.localId !== localId) }))
+  },
+
+  clearAttachments: () => {
+    for (const a of get().attachments) URL.revokeObjectURL(a.thumbnailUrl)
+    set({ attachments: [] })
+  },
```

`sendMessage` 改造:

```diff
-  sendMessage: async (prompt: string, cwd?: string) => {
+  sendMessage: async (
+    args: { text: string; contentBlocks?: Array<{ type: string; source?: unknown; [k: string]: unknown }> },
+    cwd?: string,
+  ) => {
+    const { text: prompt, contentBlocks } = args
     const abortController = new AbortController()
     // 先把用户消息放进 store,前端立即看到自己发出去的内容
     const userMsg: AgentMessage = {
       eventId: `user-${Date.now()}`,
       sessionId: '',
       ts: Date.now(),
       turnIndex: 0,
       type: 'user.text',
       text: prompt,
+      // 把 attachments 快照挂到消息上, 后续 MessageBubble 据此渲染缩略图条
+      // ⚠️ 关键: snapshot 必须把 thumbnailUrl 改写成独立的 dataURL (不复用 store 里的 objectURL),
+      // 否则 sendMessage 成功后 clearAttachments() 会 revokeObjectURL 同一 URL,
+      // 导致已发送气泡里的 <img> 后续渲染断图.
+      attachments: get().attachments
+        .filter(a => a.status === 'ready')
+        .map(a => ({
+          localId: a.localId,
+          mime: a.mime,
+          filename: a.filename,
+          // 用 base64DataUrl 当 src, 不依赖会被 revoke 的 objectURL
+          thumbnailUrl: a.base64DataUrl,
+          status: a.status,
+        })),
     }
     set((s) => ({
       status: 'streaming',
       abortController,
       messages: [...s.messages, userMsg],
       sendSeq: s.sendSeq + 1,
     }))

     await runAgentStream({
       prompt,
+      ...(contentBlocks?.length ? { contentBlocks } : {}),
       cwd: cwd || get().cwd || undefined,
       sessionId: get().sessionId ?? undefined,
       signal: abortController.signal,
       onEvent: (event: RuntimeEvent) => {
         ...
       },
       onEnd: () => {
         const state = get()
         if (state.status === 'streaming') {
           set({ status: 'idle', abortController: null })
         }
+        // 成功结束后清空 attachments (revoke objectURL). 气泡里的 snapshot
+        // 用的是 dataURL, 不受影响.
+        state.clearAttachments()
       },
     })
   },
```

`loadTranscript` 改造 — 当 raw.content 是 array 时还原 attachments:

```diff
       if (msg.type === 'user') {
         if (rawObj.kind === 'skill_injection') continue
-        messages.push({ ...baseFields, eventId: msg.uuid, type: 'user.text', text })
+        if (Array.isArray(rawObj.content)) {
+          // ContentBlock[] (含图片) — 还原 text 字段 (拼接所有 text 块) 与 attachments
+          const blocks = rawObj.content as Array<{ type: string; source?: { media_type?: string; data?: string }; text?: string }>
+          const textFromBlocks = blocks
+            .filter(b => b.type === 'text' && typeof b.text === 'string')
+            .map(b => b.text!)
+            .join('\n')
+          const restoredAttachments = blocks
+            .filter(b => b.type === 'image' && b.source?.type === 'base64')
+            .map((b, i) => {
+              const dataUrl = `data:${b.source!.media_type};base64,${b.source!.data}`
+              // 把 base64 转 Blob, 再 createObjectURL, 避免 base64 直接进 React img src (性能差)
+              const blob = dataURLtoBlob(dataUrl)
+              const thumbnailUrl = blob ? URL.createObjectURL(blob) : dataUrl
+              return {
+                localId: `${msg.uuid}-img-${i}`,
+                mime: b.source!.media_type ?? 'image/png',
+                filename: '[历史图片]',
+                thumbnailUrl,
+                status: blob ? 'ready' : 'error',
+                error: blob ? undefined : '图片已损坏',
+              }
+            })
+          messages.push({
+            ...baseFields,
+            eventId: msg.uuid,
+            type: 'user.text',
+            text: textFromBlocks,
+            ...(restoredAttachments.length ? { attachments: restoredAttachments } : {}),
+          })
+        } else {
+          messages.push({ ...baseFields, eventId: msg.uuid, type: 'user.text', text })
+        }
       } else if (msg.type === 'assistant') {
```

并在文件顶部添加 `dataURLtoBlob` helper:

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

并在 `setCurrentSession` / `createNewSession` / `clearMessages` 中清空 attachments (避免跨会话残留):

```diff
   setCurrentSession: (sessionId) => {
-    set({ sessionId, messages: [], textSegmentRev: 0, segmentedToolUseIds: {}, sendSeq: 0 })
+    const old = get().attachments
+    old.forEach(a => URL.revokeObjectURL(a.thumbnailUrl))
+    set({ sessionId, messages: [], textSegmentRev: 0, segmentedToolUseIds: {}, sendSeq: 0, attachments: [] })
   },

   createNewSession: () => {
-    set({ sessionId: null, messages: [], status: 'idle', textSegmentRev: 0, segmentedToolUseIds: {}, sendSeq: 0 })
+    const old = get().attachments
+    old.forEach(a => URL.revokeObjectURL(a.thumbnailUrl))
+    set({ sessionId: null, messages: [], status: 'idle', textSegmentRev: 0, segmentedToolUseIds: {}, sendSeq: 0, attachments: [] })
   },

   clearMessages: () =>
     set({
       messages: [],
       status: 'idle',
       textSegmentRev: 0,
       segmentedToolUseIds: {},
       sendSeq: 0,
+      attachments: [],
     }),
```

### Step 5: 跑测试确认通过

```bash
pnpm -F zai test useAgentStore.test.ts
```

Expected: 4 个新测试全部通过 (老的不要挂)

### Step 6: Commit

```bash
git add packages/zai/src/web/src/store/useAgentStore.ts packages/zai/test/web/useAgentStore.test.ts
git commit -m "feat(zai-web): useAgentStore attachments slice + sendMessage 接 contentBlocks + loadTranscript 还原"
```

---

## Task 8: Agent.tsx UI 改造 — 输入区 + MessageBubble 渲染 attachments

**Files:**
- Modify: `packages/zai/src/web/src/pages/Agent.tsx`

### Step 1: 改 import

在文件顶部 imports 增加:

```diff
 import { ..., PictureOutlined, CloseOutlined } from '@ant-design/icons'
 import { AttachmentStrip } from '../components/AttachmentStrip'
```

### Step 2: Agent() 组件解构 attachments

```diff
 export default function Agent() {
-  const { messages, status, cwd, sessions, sessionId, sendMessage, stop, clearMessages, loadSessions, setCurrentSession, loadTranscript, createNewSession, deleteSession, pendingAsk, setAskAnswer, setAskNotes, submitAsk, rejectAsk } =
+  const { messages, status, cwd, sessions, sessionId, sendMessage, stop, clearMessages, loadSessions, setCurrentSession, loadTranscript, createNewSession, deleteSession, pendingAsk, setAskAnswer, setAskNotes, submitAsk, rejectAsk, attachments, addAttachments, removeAttachment, clearAttachments } =
     useAgentStore()
```

### Step 3: 加 refs + handlers

```diff
   const streamStartRef = useRef<number | null>(null)
   const [spinnerIdx, setSpinnerIdx] = useState(0)
   const SPINNER = ['✶', '✷', '✸', '✹', '✺', '✻', '✼', '✽']
+  const fileInputRef = useRef<HTMLInputElement>(null)
+  const uploadAbortRef = useRef<AbortController | null>(null)
+
+  const handlePaste = (e: React.ClipboardEvent) => {
+    const files: File[] = []
+    for (const item of e.clipboardData.items) {
+      if (item.kind === 'file') {
+        const f = item.getAsFile()
+        if (f) files.push(f)
+      }
+    }
+    if (files.length === 0) return
+    e.preventDefault()
+    uploadAbortRef.current = new AbortController()
+    void addAttachments(files, uploadAbortRef.current.signal)
+  }
+
+  const handleDrop = (e: React.DragEvent) => {
+    if (status === 'streaming' || pendingAsk?.status === 'pending') {
+      e.preventDefault()
+      message.warning('请等待当前回复结束')
+      return
+    }
+    const files = Array.from(e.dataTransfer.files).filter(f => f.type.startsWith('image/'))
+    if (files.length === 0) return
+    e.preventDefault()
+    uploadAbortRef.current = new AbortController()
+    void addAttachments(files, uploadAbortRef.current.signal)
+  }
+
+  const handleFilePick = (e: React.ChangeEvent<HTMLInputElement>) => {
+    const files = Array.from(e.target.files ?? [])
+    if (files.length === 0) return
+    uploadAbortRef.current = new AbortController()
+    void addAttachments(files, uploadAbortRef.current.signal)
+    e.target.value = ''
+  }
```

### Step 4: handleSend 改造

```diff
   const handleSend = async () => {
-    const trimmed = input.trim()
-    if (!trimmed || status === 'streaming') return
-    setInput('')
-    await sendMessage(trimmed, cwd || undefined)
+    const text = input.trim()
+    const blocks = attachments
+      .filter(a => a.status === 'ready')
+      .map(a => ({
+        type: 'image' as const,
+        source: { type: 'base64' as const, media_type: a.mime, data: a.base64DataUrl },
+      }))
+    if (!text && blocks.length === 0) return
+    if (status === 'streaming') return
+    setInput('')
+    await sendMessage({ text, contentBlocks: blocks }, cwd || undefined)
   }
```

### Step 5: JSX 替换 — 输入区 + MessageBubble

把现有的:

```tsx
<div style={{ display: 'flex', alignItems: 'stretch' }}>
  <TextArea
    value={input}
    onChange={(e) => setInput(e.target.value)}
    onKeyDown={handleKeyDown}
    placeholder="输入消息,按 Enter 发送,Shift+Enter 换行"
    rows={3}
    disabled={status === 'streaming' || pendingAsk?.status === 'pending'}
    style={{ resize: 'none', flex: 1 }}
  />
</div>
```

替换为:

```tsx
<div
  onDrop={handleDrop}
  onDragOver={(e) => e.preventDefault()}
  style={{ /* 容器, 复用现有 flex: 'flex' + alignItems: 'stretch' 的父级即可 */ }}
>
  <AttachmentStrip attachments={attachments} onRemove={removeAttachment} />
  <div style={{ display: 'flex', alignItems: 'stretch' }}>
    <Button
      icon={<PictureOutlined />}
      onClick={() => fileInputRef.current?.click()}
      title="上传图片"
      disabled={status === 'streaming' || pendingAsk?.status === 'pending'}
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
      disabled={status === 'streaming' || pendingAsk?.status === 'pending'}
      style={{ resize: 'none', flex: 1 }}
    />
  </div>
</div>
```

### Step 6: MessageBubble 渲染 attachments

`packages/zai/src/web/src/pages/Agent.tsx:545-563` (`user.text` 分支) 改造:

```diff
   if (msg.type === 'user.text' || msg.type === 'user.message') {
+    const msgAttachments = (msg.attachments as PendingAttachment[] | undefined) ?? []
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
+          {msgAttachments.length > 0 && (
+            <AttachmentStrip attachments={msgAttachments} />
+          )}
           <Space>
             <UserOutlined />
             <Text>{linkifyText((msg.text as string) || (msg.prompt as string) || '')}</Text>
           </Space>
         </Card>
       </div>
     )
   }
```

### Step 7: typecheck + build

```bash
pnpm -F zai typecheck
pnpm -F zai build
```

Expected: 0 errors

### Step 8: Commit

```bash
git add packages/zai/src/web/src/pages/Agent.tsx
git commit -m "feat(zai-web): Agent 页面支持粘贴/拖拽/按钮上传图片 + MessageBubble 渲染 attachments"
```

---

## Task 9: 全量构建 + 测试 + smoke

**Files:** 无新增, 只跑命令

### Step 1: zai-agent-core 全测

```bash
pnpm -F zai-agent-core test
```

Expected: 全部通过

### Step 2: zai 全测

```bash
pnpm -F zai test
```

Expected: 全部通过 (含 imageReader / useAgentStore / agent route)

### Step 3: 全 workspace 构建

```bash
pnpm -r build
```

Expected: 0 errors

### Step 4: typecheck

```bash
pnpm -r typecheck
```

Expected: 0 errors

### Step 5: dev server smoke

```bash
# 单独启动 zai dev server, 在另一个 terminal 测试
pnpm -F zai dev &
sleep 5
# 确认 5173 端口在听
lsof -i :5173 | grep LISTEN
# 杀掉
kill %1
```

Expected: 端口监听, 无 panic

### Step 6: 手动 E2E (read-only)

打开浏览器到 dev server URL, 按顺序验证 (记录在 PR description 里, 不在此步骤 commit):

1. Cmd+V 截图 → 缩略图条出现 < 500ms
2. 拖拽 PNG 到 TextArea → 缩略图条出现
3. 点 🖼 按钮 → 文件选择器 → 选中 → 缩略图条出现
4. 输入文字 + 1 张图 → 发送 → 模型回复引用图片
5. 刷新页面 → 历史气泡的缩略图仍在 (transcript 回放)
6. 拖入 11 张图 → 缩略图条只显示 10 张
7. 拖入 11MB PNG → toast 拒绝 (前端 ImageReadError 'too_large' → attachment.status='error')
8. streaming 时拖拽 → toast 提示「请等待当前回复结束」
9. × 移除某张缩略图 → 不出现在消息中
10. 拖入 text/plain → 静默忽略 (clipboard.items 过滤掉)

### Step 7: 无需 commit (验证步骤, 不改代码)

如果 Step 1-5 全部通过且 E2E OK, 任务完成. 如有失败, 回到对应 Task 修.

---

## Self-Review Checklist

### 1. Spec coverage

- §2.1 imageReader lib → Task 1 ✓
- §2.2 attachments slice → Task 7 ✓
- §2.3 sseAgent contentBlocks 透传 → Task 5 ✓
- §2.4 Agent.tsx UI + MessageBubble → Task 8 ✓
- §2.5 server route contentBlocks → Task 4 ✓
- §2.6 imagePasteIds type fix → Task 2 ✓
- §2.7 transcript raw.content 序列化 → 由 `TranscriptMessage.raw: unknown` 透明处理 (无 store 改动), 但 Task 3 修了 queryLoop resume 路径读 array 的支持 ✓
- §2.8 MessageBubble attachments → Task 8 Step 6 ✓

### 2. Placeholder scan

- 无 "TBD" / "TODO" / "fill in details" 字样
- 所有代码块都是完整可运行片段
- 没有 "类似 Task N" 引用, 每步都给出完整代码

### 3. Type consistency

- `PendingAttachment` 在 Task 6 (AttachmentStrip 的 StripAttachment) 和 Task 7 (useAgentStore) 两处定义, 字段一致
- `ContentBlock` 形态在 Task 4 / 5 / 7 三处签名一致 (`{ type: 'image', source: { type: 'base64', media_type, data } }`)
- `MAX_ATTACHMENTS_PER_TURN = 10` 与 zod `.max(10)` 与前端 spec §4 一致
- `dataURLtoBlob` 在 Task 7 单点定义, loadTranscript 路径专用
- sendMessage 签名 `(args, cwd?)` 在 Task 7 与 Task 8 调用一致
- runAgentStream `AgentStreamOptions` 在 Task 5 与 Task 7 调用一致
- `runtime.run({ prompt })` 在 Task 4 server 传入 `string | Array<{role, content}>`, 与 QueryOptions.prompt 类型 (runtime/types.ts:82) 兼容