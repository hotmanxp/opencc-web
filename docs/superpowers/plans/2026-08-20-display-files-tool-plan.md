# display_files 内置工具 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 新增 zai-native 内置工具 `display_files`,Agent 调用后在主对话流中渲染一组本地文件卡片;每个卡片支持 [预览](右侧 Drawer 按文件类型渲染内容) 与 [打开目录](POST `/api/fs/reveal` 唤起 Finder/Explorer)。

**Architecture:** 工具走 zai-native `buildDefaultTools()` 注册(与 `bashTool`/`taskTools`/`subagentControlTool` 同路径),stat 后只返回文件元数据(JSON 进 transcript),文件内容按需通过新增 `GET /api/fs/preview` 端点拉取。前端 `toolRenderers/fileDisplay.tsx` 走 `renderFull` 整块接管渲染,挂全局 `<FilePreviewDrawer>` 单例。HTML 用 sandbox="" iframe,MD 走 `MarkdownText`,代码 `SyntaxHighlighter`,图片 base64,二进制降级。

**Tech Stack:** TypeScript / zod / vitest / Node fs / Express / React + Zustand + Antd Drawer

---

## Global Constraints

- 工作目录:`/Users/ethan/code/opencc-web-display-files`(worktree,branch `feat/display-files-tool`,基于 main HEAD `af8ea3b6`)。**所有 cd 命令都基于此路径**。
- 路径不限制 cwd,接受任意绝对路径(用户在多 PWD 切换时也能展示)。
- 单文件预览限 **1 MiB**(1048576 字节);超过时只显示元数据 + 预览按钮 disabled。
- 单次调用最多 **20 个文件**(`paths` 数组上限)。
- 工具分类规则(`TEXT_EXTS` / `IMAGE_EXTS` / `HTML_EXTS`)**跨包重复**:zai 端放 `packages/zai/src/shared/fileKind.ts`(供 fs.preview 路由 import),zn-agent-core 端在 `compat/tools/displayFiles.ts` 同目录复制一份 Set 字面量。两侧单测各覆盖关键扩展名(`png`/`jpg`/`html`/`ts`/`md`/`bin`)作为规则同步护栏。
- 修改 `packages/zn-agent-core/src/compat/tools/` 后**必须 `pnpm run build:core`** 后再启 zai 验证。
- 提交信息遵循 conventional commits:`feat(zn-agent-core): ...` / `feat(zai): ...` / `fix(zai): ...`。
- HTML iframe `sandbox=""`(空字符串,等同禁止 scripts/forms/popups/同源)。
- 类型优先复用现有 `packages/zai/src/shared/fs.ts` 的 `FsFile` 风格(`ok` 字段 + `kind` discriminator);只在必要时新增 `FilePreviewPayload` / `FilePreviewError` 接口到 `fs.ts`。
- 不动现有的 `GET /fs/file`(`fs.ts:281`,cwd 限制 + 2 MB);新增 `GET /fs/preview` 走 spec 设计(绝对路径 + 1 MiB)。
- 不抽 `FsTab.tsx:468` 的 `FilePreview` 组件(深度耦合 FsTab 状态);`FilePreviewDrawer` 自写轻量版。

---

## File Structure

### 新增

```
packages/zai/src/shared/fileKind.ts                              # TEXT_EXTS / IMAGE_EXTS / HTML_EXTS / classifyKind / mimeFromExt / FilePreviewKind

packages/zai/src/web/src/components/toolRenderers/fileDisplay.tsx              # fileDisplayRenderer (renderFull)
packages/zai/src/web/src/components/conversation/FilePreviewDrawer.tsx         # 右侧 Drawer,接 /fs/preview

packages/zn-agent-core/src/compat/tools/displayFiles.ts                        # displayFilesTool (stat + 同目录复制规则)

packages/zai/test/shared/fileKind.test.ts                        # fileKind 分类规则
packages/zai/test/server/routes/fs.preview.test.ts               # /fs/preview 路由
packages/zai/test/web/components/toolRenderers/fileDisplay.test.tsx            # renderer 渲染 + 错误态 + 超 1 MiB
packages/zai/test/web/components/conversation/FilePreviewDrawer.test.tsx       # Drawer 各 kind 渲染 + iframe sandbox
packages/zn-agent-core/test/unit/tools/displayFiles.test.ts                   # stat + 分类 + 错误结构化 + paths 长度
packages/zn-agent-core/test/unit/tools/buildDefaultToolsIncludesDisplayFiles.test.ts  # 注册断言
```

### 修改

- `packages/zn-agent-core/src/compat/tools/index.ts` — `buildDefaultTools()` 追加 `displayFilesTool`
- `packages/zai/src/web/src/components/toolRenderers/registry.ts:11-20` — 注册 `DisplayFiles: fileDisplayRenderer`
- `packages/zai/src/web/src/store/useAgentStore.ts` — state `filePreviewPath: string | null` + actions `openFilePreview` / `closeFilePreview`
- `packages/zai/src/web/src/pages/Agent.tsx:513-515` — mount `<FilePreviewDrawer />`
- `packages/zai/src/web/src/pages/MobileAgent.tsx:79-81` — mount `<FilePreviewDrawer />`
- `packages/zai/src/server/routes/fs.ts:917` 后 — 新增 `GET /fs/preview` handler + `clampInt` + `mapStatError` helper(内联定义在文件底部,不新建文件)
- `packages/zai/src/shared/fs.ts` — 新增 `FilePreviewPayload` / `FilePreviewError` 接口(纯类型,无运行时代码)

---

## Task 1: 共享 fileKind 模块(TDD)

**Files:**
- Create: `packages/zai/src/shared/fileKind.ts`
- Test: `packages/zai/test/shared/fileKind.test.ts`

**Interfaces:**
- Consumes: 无
- Produces:
  - `TEXT_EXTS: ReadonlySet<string>`
  - `HTML_EXTS: ReadonlySet<string>`
  - `IMAGE_EXTS: Readonly<Record<string, string>>`
  - `classifyKind(absPath: string): FilePreviewKind`
  - `mimeFromExt(absPath: string): string | undefined`
  - `type FilePreviewKind = 'text' | 'image' | 'html' | 'binary'`

- [ ] **Step 1: 写失败测试**

在 `packages/zai/test/shared/fileKind.test.ts` 新建:

```ts
import { describe, expect, it } from 'vitest'
import { classifyKind, mimeFromExt } from '../../src/shared/fileKind.js'

describe('fileKind.classifyKind', () => {
  it('classifies image extensions as image', () => {
    expect(classifyKind('/tmp/photo.png')).toBe('image')
    expect(classifyKind('/tmp/photo.JPG')).toBe('image')
    expect(classifyKind('/tmp/photo.svg')).toBe('image')
  })

  it('classifies html extensions as html', () => {
    expect(classifyKind('/tmp/page.html')).toBe('html')
    expect(classifyKind('/tmp/page.HTM')).toBe('html')
  })

  it('classifies known text extensions as text', () => {
    expect(classifyKind('/tmp/code.ts')).toBe('text')
    expect(classifyKind('/tmp/data.json')).toBe('text')
    expect(classifyKind('/tmp/readme.md')).toBe('text')
  })

  it('classifies unknown / binary extensions as binary', () => {
    expect(classifyKind('/tmp/blob.zip')).toBe('binary')
    expect(classifyKind('/tmp/no-extension')).toBe('binary')
  })

  it('handles paths with multiple dots', () => {
    expect(classifyKind('/tmp/foo.bar.ts')).toBe('text')
    expect(classifyKind('/tmp/foo.bar.png')).toBe('image')
  })
})

describe('fileKind.mimeFromExt', () => {
  it('returns mime for known image extensions', () => {
    expect(mimeFromExt('/tmp/x.png')).toBe('image/png')
    expect(mimeFromExt('/tmp/x.jpg')).toBe('image/jpeg')
    expect(mimeFromExt('/tmp/x.svg')).toBe('image/svg+xml')
  })

  it('returns undefined for non-image / unknown', () => {
    expect(mimeFromExt('/tmp/x.ts')).toBeUndefined()
    expect(mimeFromExt('/tmp/x.bin')).toBeUndefined()
  })
})
```

- [ ] **Step 2: 运行测试确认失败**

Run:
```bash
cd /Users/ethan/code/opencc-web-display-files
pnpm --filter @zn-ai/zai test test/shared/fileKind.test.ts
```
Expected: FAIL with "Cannot find module '../../src/shared/fileKind.js'"(因为文件还不存在)。

- [ ] **Step 3: 实现 fileKind.ts**

在 `packages/zai/src/shared/fileKind.ts` 新建:

```ts
// Shared file-kind classification for display_files + /fs/preview.
// Kept separate from compat/tools/displayFiles.ts (zn-agent-core) because
// the compat layer bundles to dist/opencc-core.mjs and cannot import from
// the zai package. The two sides duplicate these Sets intentionally; key
// extensions are asserted in both test suites as a sync guard.

export type FilePreviewKind = 'text' | 'image' | 'html' | 'binary'

export const TEXT_EXTS: ReadonlySet<string> = new Set([
  '.md', '.markdown', '.txt', '.json', '.jsonc', '.json5',
  '.yaml', '.yml', '.toml', '.ini', '.cfg', '.conf',
  '.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs',
  '.css', '.scss', '.less', '.xml',
  '.sh', '.bash', '.zsh', '.fish', '.ps1', '.bat', '.cmd',
  '.py', '.rb', '.go', '.rs', '.java', '.kt', '.swift',
  '.c', '.cc', '.cpp', '.h', '.hpp',
  '.sql', '.graphql', '.gql',
  '.env', '.gitignore', '.gitattributes', '.lock',
])

export const HTML_EXTS: ReadonlySet<string> = new Set(['.html', '.htm'])

export const IMAGE_EXTS: Readonly<Record<string, string>> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.bmp': 'image/bmp',
  '.ico': 'image/x-icon',
  '.avif': 'image/avif',
  '.svg': 'image/svg+xml',
}

import { extname } from 'node:path'

export function classifyKind(absPath: string): FilePreviewKind {
  const ext = extname(absPath).toLowerCase()
  if (ext in IMAGE_EXTS) return 'image'
  if (HTML_EXTS.has(ext)) return 'html'
  if (TEXT_EXTS.has(ext)) return 'text'
  return 'binary'
}

export function mimeFromExt(absPath: string): string | undefined {
  const ext = extname(absPath).toLowerCase()
  return IMAGE_EXTS[ext]
}
```

- [ ] **Step 4: 重新运行测试确认通过**

Run:
```bash
cd /Users/ethan/code/opencc-web-display-files
pnpm --filter @zn-ai/zai test test/shared/fileKind.test.ts
```
Expected: PASS。

- [ ] **Step 5: 提交**

```bash
cd /Users/ethan/code/opencc-web-display-files
git add packages/zai/src/shared/fileKind.ts packages/zai/test/shared/fileKind.test.ts
git commit -m "feat(zai): add shared fileKind module (TEXT/IMAGE/HTML EXTS + classifyKind)"
```

---

## Task 2: fs 端类型增强(FilePreviewPayload / FilePreviewError)

**Files:**
- Modify: `packages/zai/src/shared/fs.ts` 末尾追加

**Interfaces:**
- Consumes: 无(纯类型)
- Produces:
  - `interface FilePreviewPayload { kind: FilePreviewKind; mime?: string; content?: string; size: number; mtime: number; ext?: string }`(从 `@zn-ai/.../shared/fileKind` import FilePreviewKind,这里 re-export 类型便于前端使用)
  - `interface FilePreviewError { code: 'ENOENT'|'EACCES'|'EISDIR'|'ETOOBIG'|'EBADREQ'|'EIO'; message: string; meta?: { size?: number } }`

- [ ] **Step 1: 追加类型到 fs.ts**

打开 `packages/zai/src/shared/fs.ts`,在文件末尾追加:

```ts
import type { FilePreviewKind } from './fileKind.js'
export type { FilePreviewKind } from './fileKind.js'

/**
 * /fs/preview 路由成功响应:按 kind 决定 content 字段语义。
 * - 'text' / 'html' → `content` 为 utf8 原文
 * - 'image' → `content` 为 base64(配合 mime 拼 data URL)
 * - 'binary' → 仅返回元数据 + ext
 */
export interface FilePreviewPayload {
  kind: FilePreviewKind
  mime?: string
  content?: string
  size: number
  mtime: number
  ext?: string
}

/**
 * /fs/preview 路由失败响应:HTTP status 携带语义,body 仅供前端展示。
 * `code` 与工具层 `display_files` 的 error.code 对齐,便于 UI 复用同一套 Tag 文案。
 */
export interface FilePreviewError {
  code: 'ENOENT' | 'EACCES' | 'EISDIR' | 'ETOOBIG' | 'EBADREQ' | 'EIO'
  message: string
  meta?: { size?: number }
}
```

- [ ] **Step 2: 类型检查通过**

Run:
```bash
cd /Users/ethan/code/opencc-web-display-files
pnpm --filter @zn-ai/zai exec tsc --noEmit
```
Expected: 0 errors(纯类型追加,不影响运行时)。

- [ ] **Step 3: 提交**

```bash
cd /Users/ethan/code/opencc-web-display-files
git add packages/zai/src/shared/fs.ts
git commit -m "feat(zai): add FilePreviewPayload / FilePreviewError types to shared/fs"
```

---

## Task 3: GET /fs/preview 路由实现(TDD)

**Files:**
- Modify: `packages/zai/src/server/routes/fs.ts` 在 line 917(`platformCommands` 之前)区域新增 handler + 末尾追加 `clampInt` / `mapStatError` helper
- Test: `packages/zai/test/server/routes/fs.preview.test.ts`

**Interfaces:**
- Consumes: `classifyKind` / `mimeFromExt` from `../../shared/fileKind.js`
- Produces: `GET /api/fs/preview?path=<abs>&maxBytes=<n>` 返回 `FilePreviewPayload` / `FilePreviewError`

- [ ] **Step 1: 写失败测试**

新建 `packages/zai/test/server/routes/fs.preview.test.ts`(参考已有 `fs.test.ts` 的 supertest 模式):

```ts
import { describe, expect, it, beforeEach } from 'vitest'
import request from 'supertest'
import path from 'node:path'
import { promises as fs } from 'node:fs'
import os from 'node:os'
import { createFsTestApp } from './_testApp.js'

async function makeTmpFile(name: string, content: string | Buffer): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'fs-preview-'))
  const p = path.join(dir, name)
  await fs.writeFile(p, content)
  return p
}

describe('GET /api/fs/preview', () => {
  let app: ReturnType<typeof createFsTestApp>
  beforeEach(() => { app = createFsTestApp() })

  it('returns text payload for known text extension', async () => {
    const p = await makeTmpFile('hello.ts', 'const x = 1\n')
    const res = await request(app).get('/api/fs/preview').query({ path: p })
    expect(res.status).toBe(200)
    expect(res.body.kind).toBe('text')
    expect(res.body.mime).toBe('text/plain')
    expect(res.body.content).toBe('const x = 1\n')
    expect(res.body.size).toBe(11)
  })

  it('returns image payload with base64 content + mime for .png', async () => {
    // 1x1 transparent PNG bytes
    const png = Buffer.from(
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=',
      'base64',
    )
    const p = await makeTmpFile('pixel.png', png)
    const res = await request(app).get('/api/fs/preview').query({ path: p })
    expect(res.status).toBe(200)
    expect(res.body.kind).toBe('image')
    expect(res.body.mime).toBe('image/png')
    expect(typeof res.body.content).toBe('string')
    expect(Buffer.from(res.body.content, 'base64').length).toBe(png.length)
  })

  it('returns html payload for .html', async () => {
    const p = await makeTmpFile('page.html', '<h1>hi</h1>')
    const res = await request(app).get('/api/fs/preview').query({ path: p })
    expect(res.status).toBe(200)
    expect(res.body.kind).toBe('html')
    expect(res.body.mime).toBe('text/html')
    expect(res.body.content).toBe('<h1>hi</h1>')
  })

  it('returns binary metadata only (no content) for unknown extension', async () => {
    const p = await makeTmpFile('blob.zip', Buffer.from([0x50, 0x4b, 0x03, 0x04]))
    const res = await request(app).get('/api/fs/preview').query({ path: p })
    expect(res.status).toBe(200)
    expect(res.body.kind).toBe('binary')
    expect(res.body.content).toBeUndefined()
    expect(res.body.size).toBe(4)
  })

  it('returns 400 for missing path query', async () => {
    const res = await request(app).get('/api/fs/preview')
    expect(res.status).toBe(400)
    expect(res.body.error.code).toBe('EBADREQ')
  })

  it('returns 404 for non-existent absolute path', async () => {
    const res = await request(app)
      .get('/api/fs/preview')
      .query({ path: '/this/does/not/exist/at/all.txt' })
    expect(res.status).toBe(404)
    expect(res.body.error.code).toBe('ENOENT')
  })

  it('returns 400 for directory', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'fs-preview-dir-'))
    const res = await request(app).get('/api/fs/preview').query({ path: dir })
    expect(res.status).toBe(400)
    expect(res.body.error.code).toBe('EISDIR')
  })

  it('returns 413 when file exceeds 1 MiB default cap', async () => {
    const p = await makeTmpFile('big.txt', 'a'.repeat(1024 * 1024 + 100))
    const res = await request(app).get('/api/fs/preview').query({ path: p })
    expect(res.status).toBe(413)
    expect(res.body.error.code).toBe('ETOOBIG')
    expect(res.body.error.meta.size).toBe(1024 * 1024 + 100)
  })

  it('accepts smaller maxBytes query and applies it', async () => {
    const p = await makeTmpFile('med.txt', 'a'.repeat(2000))
    const res = await request(app)
      .get('/api/fs/preview')
      .query({ path: p, maxBytes: 1024 })
    expect(res.status).toBe(413)
  })

  it('clamps maxBytes query below 1024 to 1024', async () => {
    const p = await makeTmpFile('small.txt', 'hello')
    const res = await request(app)
      .get('/api/fs/preview')
      .query({ path: p, maxBytes: 1 })
    expect(res.status).toBe(200) // 5 bytes < 1024
  })
})
```

> 注:`createFsTestApp()` helper 是已有 `_testApp.js`(若不存在,先看 `fs.test.ts` 顶端 import 模式 — 通常 `import { createTestApp } from './_testApp.js'`,沿用现有 import 名)。先 `cat fs.test.ts | head -20` 确认 helper 名,若文件不存在就照搬 fs.test.ts 的模式新建一个最小 helper。

- [ ] **Step 2: 运行测试确认失败**

Run:
```bash
cd /Users/ethan/code/opencc-web-display-files
pnpm --filter @zn-ai/zai test test/server/routes/fs.preview.test.ts
```
Expected: FAIL with 404(路由未注册)。

- [ ] **Step 3: 追加 import + 路由 + helpers 到 fs.ts**

打开 `packages/zai/src/server/routes/fs.ts`,在第 11 行附近 `from '../../shared/fs.js'` import 块加入 `FilePreviewPayload, FilePreviewError`,并在下面加:

```ts
import { classifyKind, mimeFromExt } from '../../shared/fileKind.js'
```

定位到 `platformCommands` 函数(line 917)之后、`fsRouter.post('/fs/reveal', ...)`(line 882)之前,插入:

```ts
// 1 MiB hard cap; matches spec §2 '范围与约束'.
// maxBytes query is clamped into [1024, 1 MiB] so a malicious LLM can't
// bypass via maxBytes=0 or maxBytes=999999999.
const PREVIEW_DEFAULT_MAX = 1_048_576

function clampInt(raw: unknown, lo: number, hi: number, fallback: number): number {
  const n = typeof raw === 'string' ? Number.parseInt(raw, 10) : NaN
  if (!Number.isFinite(n)) return fallback
  if (n < lo) return lo
  if (n > hi) return hi
  return n
}

function mapStatError(res: import('express').Response, err: unknown): void {
  const code = (err as NodeJS.ErrnoException).code
  if (code === 'ENOENT') {
    res.status(404).json({ error: { code: 'ENOENT', message: '文件不存在' } } satisfies { error: FilePreviewError })
    return
  }
  if (code === 'EACCES' || code === 'EPERM') {
    res.status(403).json({ error: { code: 'EACCES', message: '无权限访问' } } satisfies { error: FilePreviewError })
    return
  }
  res.status(500).json({
    error: {
      code: 'EIO',
      message: `stat 失败:${err instanceof Error ? err.message : String(err)}`,
    },
  } satisfies { error: FilePreviewError })
}

fsRouter.get('/fs/preview', async (req, res) => {
  const { cwd } = ctx(req)
  const raw = typeof req.query.path === 'string' ? req.query.path : ''
  if (!raw) {
    res.status(400).json({ error: { code: 'EBADREQ', message: 'path 必填' } } satisfies { error: FilePreviewError })
    return
  }
  const abs = path.resolve(raw)
  const maxBytes = clampInt(req.query.maxBytes, 1024, PREVIEW_DEFAULT_MAX, PREVIEW_DEFAULT_MAX)
  void cwd // 不限 cwd,但 log 一次便于排查;实际 cwd 记录在 server 日志

  let info
  try {
    info = await stat(abs)
  } catch (err) {
    mapStatError(res, err)
    return
  }
  if (info.isDirectory()) {
    res.status(400).json({ error: { code: 'EISDIR', message: '路径是目录' } } satisfies { error: FilePreviewError })
    return
  }
  if (info.size > maxBytes) {
    res.status(413).json({
      error: {
        code: 'ETOOBIG',
        message: `文件 ${info.size} 字节,超过 ${maxBytes}`,
        meta: { size: info.size },
      },
    } satisfies { error: FilePreviewError })
    return
  }
  const kind = classifyKind(abs)
  if (kind === 'image') {
    const buf = await readFile(abs)
    const mime = mimeFromExt(abs) ?? 'application/octet-stream'
    const payload: FilePreviewPayload = {
      kind,
      mime,
      content: buf.toString('base64'),
      size: info.size,
      mtime: info.mtimeMs,
    }
    res.json(payload)
    return
  }
  if (kind === 'html' || kind === 'text') {
    const text = await readFile(abs, 'utf8')
    const payload: FilePreviewPayload = {
      kind,
      mime: kind === 'html' ? 'text/html' : 'text/plain',
      content: text,
      size: info.size,
      mtime: info.mtimeMs,
    }
    res.json(payload)
    return
  }
  const payload: FilePreviewPayload = {
    kind: 'binary',
    size: info.size,
    mtime: info.mtimeMs,
    ext: path.extname(abs),
  }
  res.json(payload)
})
```

注意 `path.resolve` 在文件顶部已从 `'node:path'` import(`path.dirname`/`path.relative`),但 `path` 这个名字未被 alias,需要确认 — 看一下 fs.ts:1-15 是否已有 `path` namespace:

> 已确认:fs.ts:2 `import { extname, basename, join, sep } from 'node:path'`,但没有 `import * as path from 'node:path'` 或 `import { resolve as pathResolve }`。需要把 `path.resolve(raw)` 改成 `pathDirname`-style:看 fs.ts:12 已经 import 了 `dirname as pathDirname`,**新增 `import { resolve as pathResolve } from 'node:path'` 在 fs.ts:12 那一行**;然后代码里用 `pathResolve(raw)` 而不是 `path.resolve(raw)`。

修正后 fs.ts:12 那行改为:
```ts
import { dirname as pathDirname, relative as pathRelative, resolve as pathResolve } from 'node:path';
```
handler 内 `path.resolve(raw)` → `pathResolve(raw)`,`path.extname(abs)` → `extname(abs)`(已 import)。

- [ ] **Step 4: 重新运行测试确认通过**

Run:
```bash
cd /Users/ethan/code/opencc-web-display-files
pnpm --filter @zn-ai/zai test test/server/routes/fs.preview.test.ts
```
Expected: 10 tests PASS。

- [ ] **Step 5: 提交**

```bash
cd /Users/ethan/code/opencc-web-display-files
git add packages/zai/src/server/routes/fs.ts packages/zai/test/server/routes/fs.preview.test.ts packages/zai/src/shared/fs.ts
git commit -m "feat(zai): add GET /api/fs/preview for display_files content fetching"
```

---

## Task 4: displayFiles 工具实现(zn-agent-core TDD)

**Files:**
- Create: `packages/zn-agent-core/src/compat/tools/displayFiles.ts`
- Test: `packages/zn-agent-core/test/unit/tools/displayFiles.test.ts`

**Interfaces:**
- Consumes: `makeTool` from `./makeTool.js`
- Produces:
  - `displayFilesTool`:zod schema `{ paths: z.array(z.string().min(1)).min(1).max(20) }`,name `DisplayFiles`,executor 返回 `{ content: [{ type: 'json', json: { files: FileMeta[] } }] }`
  - `type FileMeta`(`{ path, name, size, mtime, kind, error? }`)

- [ ] **Step 1: 写失败测试**

新建 `packages/zn-agent-core/test/unit/tools/displayFiles.test.ts`:

```ts
import { describe, expect, it, beforeEach, afterEach } from 'vitest'
import { promises as fs } from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { displayFilesTool } from '../../../src/compat/tools/displayFiles.js'

async function tmp(name: string, content: string | Buffer): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'displayfiles-'))
  const p = path.join(dir, name)
  await fs.writeFile(p, content)
  return p
}

describe('displayFilesTool', () => {
  it('returns metadata for each input path', async () => {
    const a = await tmp('a.ts', 'const x = 1\n')
    const b = await tmp('b.png', Buffer.from([0x89, 0x50, 0x4e, 0x47]))
    const result = await displayFilesTool.call({ paths: [a, b] }, { cwd: '/tmp' } as any)
    const json = JSON.parse(result.content[0].text)
    expect(json.files).toHaveLength(2)
    expect(json.files[0].path).toBe(a)
    expect(json.files[0].name).toBe('a.ts')
    expect(json.files[0].kind).toBe('text')
    expect(json.files[0].size).toBe(11)
    expect(json.files[1].kind).toBe('image')
  })

  it('classifies html files as kind html', async () => {
    const a = await tmp('page.html', '<h1>x</h1>')
    const result = await displayFilesTool.call({ paths: [a] }, { cwd: '/tmp' } as any)
    const json = JSON.parse(result.content[0].text)
    expect(json.files[0].kind).toBe('html')
  })

  it('classifies unknown extension as binary', async () => {
    const a = await tmp('blob.zip', 'PK')
    const result = await displayFilesTool.call({ paths: [a] }, { cwd: '/tmp' } as any)
    const json = JSON.parse(result.content[0].text)
    expect(json.files[0].kind).toBe('binary')
  })

  it('returns ENOENT error for missing path', async () => {
    const result = await displayFilesTool.call(
      { paths: ['/this/does/not/exist.txt'] },
      { cwd: '/tmp' } as any,
    )
    const json = JSON.parse(result.content[0].text)
    expect(json.files[0].error.code).toBe('ENOENT')
    expect(json.files[0].kind).toBe('binary')
  })

  it('returns EISDIR error for a directory', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'displayfiles-dir-'))
    const result = await displayFilesTool.call(
      { paths: [dir] },
      { cwd: '/tmp' } as any,
    )
    const json = JSON.parse(result.content[0].text)
    expect(json.files[0].error.code).toBe('EISDIR')
  })

  it('handles mix of valid + invalid paths independently', async () => {
    const a = await tmp('a.ts', 'ok')
    const result = await displayFilesTool.call(
      { paths: [a, '/nope.txt'] },
      { cwd: '/tmp' } as any,
    )
    const json = JSON.parse(result.content[0].text)
    expect(json.files[0].error).toBeUndefined()
    expect(json.files[1].error.code).toBe('ENOENT')
  })
})
```

> **前提**:`displayFilesTool.call` 签名得是 `(input, ctx) => Promise<{ content: [{ type: 'text', text: string }] }>`(对齐现有 compat `bashTool` 等)。如果现有 `makeTool` 把 executor 结果 wrap 成 `text` 字段,确认后再调整断言。先 `cat compat/tools/index.ts:150-220` 看 `bashTool.call` 的实际返回形状,按真实形状改 `JSON.parse(result.content[0].text)` 为对应字段(`output` / `content` / `json`)。

- [ ] **Step 2: 运行测试确认失败**

Run:
```bash
cd /Users/ethan/code/opencc-web-display-files
pnpm --filter @zn-ai/zn-agent-core test test/unit/tools/displayFiles.test.ts
```
Expected: FAIL "Cannot find module"。

- [ ] **Step 3: 实现 displayFiles.ts**

新建 `packages/zn-agent-core/src/compat/tools/displayFiles.ts`:

```ts
/**
 * display_files — 把一组本地文件路径以卡片列表渲染进当前会话。
 * 每个卡片带 [预览] 与 [打开目录] 两个按钮,由前端 fileDisplayRenderer 处理。
 *
 * 此工具只 stat + 返回元数据(不进 transcript 大体积),
 * 文件内容由前端按需 fetch /api/fs/preview。
 *
 * 扩展名分类规则复制自 packages/zai/src/shared/fileKind.ts
 * (compat 层 bundle 到 dist/opencc-core.mjs,不能 import zai 包);
 * 关键扩展名 (png/jpg/html/ts/md) 在本文件单测和 zai 端 fileKind.test.ts
 * 各覆盖一次,作为规则同步护栏。
 */
import { stat } from 'node:fs/promises'
import { basename, extname } from 'node:path'
import { z } from 'zod'
import { makeTool } from './makeTool.js'

const TEXT_EXTS = new Set([
  '.md', '.markdown', '.txt', '.json', '.jsonc', '.json5',
  '.yaml', '.yml', '.toml', '.ini', '.cfg', '.conf',
  '.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs',
  '.css', '.scss', '.less', '.xml',
  '.sh', '.bash', '.zsh', '.fish', '.ps1', '.bat', '.cmd',
  '.py', '.rb', '.go', '.rs', '.java', '.kt', '.swift',
  '.c', '.cc', '.cpp', '.h', '.hpp',
  '.sql', '.graphql', '.gql',
  '.env', '.gitignore', '.gitattributes', '.lock',
])

const HTML_EXTS = new Set(['.html', '.htm'])

const IMAGE_EXTS: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.bmp': 'image/bmp',
  '.ico': 'image/x-icon',
  '.avif': 'image/avif',
  '.svg': 'image/svg+xml',
}

type FilePreviewKind = 'text' | 'image' | 'html' | 'binary'

function classifyKind(absPath: string): FilePreviewKind {
  const ext = extname(absPath).toLowerCase()
  if (ext in IMAGE_EXTS) return 'image'
  if (HTML_EXTS.has(ext)) return 'html'
  if (TEXT_EXTS.has(ext)) return 'text'
  return 'binary'
}

type FileErrorCode = 'ENOENT' | 'EACCES' | 'EISDIR' | 'EPERM' | 'EBUSY' | 'ELOOP'

interface FileMeta {
  path: string
  name: string
  size: number
  mtime: number
  kind: FilePreviewKind
  error?: { code: FileErrorCode; message: string }
}

function normalizeErrno(code: string | undefined): FileErrorCode {
  switch (code) {
    case 'ENOENT':
    case 'EACCES':
    case 'EISDIR':
    case 'EPERM':
    case 'EBUSY':
    case 'ELOOP':
      return code
    default:
      return 'EPERM'
  }
}

async function statOneFile(absPath: string): Promise<FileMeta> {
  const name = basename(absPath)
  try {
    const s = await stat(absPath)
    if (s.isDirectory()) {
      return {
        path: absPath,
        name,
        size: 0,
        mtime: s.mtimeMs,
        kind: 'binary',
        error: { code: 'EISDIR', message: '路径是目录,不是文件' },
      }
    }
    return {
      path: absPath,
      name,
      size: s.size,
      mtime: s.mtimeMs,
      kind: classifyKind(absPath),
    }
  } catch (e: unknown) {
    const err = e as NodeJS.ErrnoException
    return {
      path: absPath,
      name,
      size: 0,
      mtime: 0,
      kind: 'binary',
      error: {
        code: normalizeErrno(err.code),
        message: err.message || String(e),
      },
    }
  }
}

const DisplayFilesInput = z.object({
  paths: z
    .array(z.string().min(1))
    .min(1, 'paths 不能为空')
    .max(20, '单次最多 20 个文件')
    .describe('一组待展示的本地文件绝对路径。'),
})

export const displayFilesTool = makeTool({
  name: 'DisplayFiles',
  description:
    '把一组本地文件路径在当前会话中展示给用户:每个文件带 [预览] 与 [打开目录] 按钮。' +
    '适合在完成文件编辑/生成/汇报任务后,把产物路径列给用户。' +
    '文件大于 1 MiB 时仅展示元数据,不会内联预览。单次最多 20 个文件。',
  inputSchema: DisplayFilesInput,
  async call({ paths }) {
    const files = await Promise.all(paths.map(statOneFile))
    return {
      content: [{ type: 'json' as const, json: { files } }],
    }
  },
})
```

- [ ] **Step 4: 重新运行测试确认通过**

Run:
```bash
cd /Users/ethan/code/opencc-web-display-files
pnpm --filter @zn-ai/zn-agent-core test test/unit/tools/displayFiles.test.ts
```
Expected: PASS(若失败,检查 `result.content[0].text` vs `result.content[0].json` —— 跟真实 `makeTool` wrap 形状对齐)。

- [ ] **Step 5: 提交**

```bash
cd /Users/ethan/code/opencc-web-display-files
git add packages/zn-agent-core/src/compat/tools/displayFiles.ts packages/zn-agent-core/test/unit/tools/displayFiles.test.ts
git commit -m "feat(zn-agent-core): add displayFilesTool with stat + kind classification"
```

---

## Task 5: 注册 displayFilesTool 到 buildDefaultTools(TDD)

**Files:**
- Modify: `packages/zn-agent-core/src/compat/tools/index.ts:36`(imports) + line 509 之后(`buildDefaultTools` 数组)
- Test: `packages/zn-agent-core/test/unit/tools/buildDefaultToolsIncludesDisplayFiles.test.ts`

**Interfaces:**
- Consumes: `displayFilesTool` from `./displayFiles.js`
- Produces: `buildDefaultTools()` 返回数组包含 `DisplayFiles`

- [ ] **Step 1: 写失败测试**

新建 `packages/zn-agent-core/test/unit/tools/buildDefaultToolsIncludesDisplayFiles.test.ts`:

```ts
import { describe, expect, it } from 'vitest'
import { buildDefaultTools } from '../../../src/compat/tools/index.js'

describe('buildDefaultTools includes DisplayFiles', () => {
  it('contains the DisplayFiles tool', () => {
    const names = buildDefaultTools().map((t) => t.name)
    expect(names).toContain('DisplayFiles')
  })

  it('DisplayFiles tool has correct schema shape', () => {
    const tool = buildDefaultTools().find((t) => t.name === 'DisplayFiles')
    expect(tool).toBeDefined()
    expect(tool!.description).toContain('展示')
  })
})
```

- [ ] **Step 2: 运行测试确认失败**

Run:
```bash
cd /Users/ethan/code/opencc-web-display-files
pnpm --filter @zn-ai/zn-agent-core test test/unit/tools/buildDefaultToolsIncludesDisplayFiles.test.ts
```
Expected: FAIL "expected to contain 'DisplayFiles'"。

- [ ] **Step 3: 注册到 buildDefaultTools**

打开 `packages/zn-agent-core/src/compat/tools/index.ts`:

1. 在第 36 行 `import { subagentControlTool } from './opencc/subagentControl.js'` 之后,加:
   ```ts
   import { displayFilesTool } from './displayFiles.js'
   ```

2. 在 `buildDefaultTools()`(line 491)的 `tools: Tool[] = [...]` 数组中,`subagentControlTool`(line 509)之后追加:
   ```ts
     displayFilesTool as Tool,
   ```

- [ ] **Step 4: 重新运行测试确认通过**

Run:
```bash
cd /Users/ethan/code/opencc-web-display-files
pnpm --filter @zn-ai/zn-agent-core test test/unit/tools/buildDefaultToolsIncludesDisplayFiles.test.ts
```
Expected: PASS。

- [ ] **Step 5: 提交**

```bash
cd /Users/ethan/code/opencc-web-display-files
git add packages/zn-agent-core/src/compat/tools/index.ts packages/zn-agent-core/test/unit/tools/buildDefaultToolsIncludesDisplayFiles.test.ts
git commit -m "feat(zn-agent-core): register displayFilesTool in buildDefaultTools"
```

---

## Task 6: store 接线(filePreviewPath + actions)

**Files:**
- Modify: `packages/zai/src/web/src/store/useAgentStore.ts` — 在 AgentState 增加 `filePreviewPath` 字段,在 actions 区加 `openFilePreview` / `closeFilePreview`

**Interfaces:**
- Consumes: 现有 `useAgentStore` 的 AgentState / actions 模式
- Produces:
  - `filePreviewPath: string | null` state(初始 `null`)
  - `openFilePreview(path: string): void`
  - `closeFilePreview(): void`

- [ ] **Step 1: 看 store 现状**

```bash
cd /Users/ethan/code/opencc-web-display-files
grep -n "AgentState\|create<\|set((state)" packages/zai/src/web/src/store/useAgentStore.ts | head -20
```
找到 AgentState interface 定义位置 + actions 区域(reference 现有 `setSettingsTheme` 或 `openSettingsDrawer` 模式,line 360 附近)。

- [ ] **Step 2: 增加 state 字段**

在 AgentState interface(line 60 区域)中追加:

```ts
  /** 当前打开预览的文件绝对路径;null = 关闭。 */
  filePreviewPath: string | null
```

- [ ] **Step 3: 增加 actions**

在 AgentState interface 中(紧跟其他 actions 之后,line 100-110 区域附近):

```ts
  openFilePreview: (path: string) => void
  closeFilePreview: () => void
```

在 create()(line 300+ 区域,对照 `openSettingsDrawer` / `closeSettingsDrawer` 的写法)实现:

```ts
  openFilePreview: (path) => set({ filePreviewPath: path }),
  closeFilePreview: () => set({ filePreviewPath: null }),
```

并在 store 初始 state(line 220+ 区域 `filePreviewPath: null`):

```ts
  filePreviewPath: null,
```

- [ ] **Step 4: 确认不破坏现有 store test**

```bash
cd /Users/ethan/code/opencc-web-display-files
pnpm --filter @zn-ai/zai test test/web/useAgentStore.test.ts test/web/useAgentStore-loadTranscript.test.ts
```
Expected: PASS(新增字段与 actions 不影响现有断言)。

- [ ] **Step 5: 类型检查**

Run:
```bash
cd /Users/ethan/code/opencc-web-display-files
pnpm --filter @zn-ai/zai exec tsc --noEmit
```
Expected: 0 errors。

- [ ] **Step 6: 提交**

```bash
cd /Users/ethan/code/opencc-web-display-files
git add packages/zai/src/web/src/store/useAgentStore.ts
git commit -m "feat(zai): add filePreviewPath state + openFilePreview / closeFilePreview actions"
```

---

## Task 7: fileDisplayRenderer(TDD)

**Files:**
- Create: `packages/zai/src/web/src/components/toolRenderers/fileDisplay.tsx`
- Modify: `packages/zai/src/web/src/components/toolRenderers/registry.ts:11-20`
- Test: `packages/zai/test/web/components/toolRenderers/fileDisplay.test.tsx`

**Interfaces:**
- Consumes: `ToolRenderer` type from `./types.js`, `useAgentStore` from `../../store/useAgentStore.js`, AntD `Card` / `Button` / `Tag`
- Produces:
  - `fileDisplayRenderer: ToolRenderer` — `renderFull(msg)` 渲染 FileCardList;`preview(input)` 返回 `"展示 N 个文件"`

- [ ] **Step 1: 写失败测试**

新建 `packages/zai/test/web/components/toolRenderers/fileDisplay.test.tsx`:

```tsx
import { describe, expect, it, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import React from 'react'
import { fileDisplayRenderer } from '../../../../src/web/src/components/toolRenderers/fileDisplay.js'
import { useAgentStore } from '../../../../src/web/src/store/useAgentStore.js'

function makeMsg(files: any[]) {
  return {
    type: 'tool_use:done' as const,
    toolUseId: 'tu-1',
    name: 'DisplayFiles',
    input: { paths: files.map((f) => f.path) },
    output: { content: [{ type: 'json', json: { files } }] },
  } as any
}

describe('fileDisplayRenderer.renderFull', () => {
  beforeEach(() => {
    useAgentStore.setState({
      filePreviewPath: null,
      openFilePreview: (p) => useAgentStore.setState({ filePreviewPath: p }),
      closeFilePreview: () => useAgentStore.setState({ filePreviewPath: null }),
    })
  })

  it('renders one card per file', () => {
    const msg = makeMsg([
      { path: '/a.ts', name: 'a.ts', size: 100, mtime: 0, kind: 'text' },
      { path: '/b.png', name: 'b.png', size: 200, mtime: 0, kind: 'image' },
    ])
    const { container } = render(<>{fileDisplayRenderer.renderFull!(msg)}</>)
    expect(container.textContent).toContain('a.ts')
    expect(container.textContent).toContain('b.png')
  })

  it('shows error tag for files with error', () => {
    const msg = makeMsg([
      { path: '/nope.txt', name: 'nope.txt', size: 0, mtime: 0, kind: 'binary',
        error: { code: 'ENOENT', message: 'not found' } },
    ])
    const { container } = render(<>{fileDisplayRenderer.renderFull!(msg)}</>)
    expect(container.textContent).toContain('文件不存在')
  })

  it('disables preview button for files > 1 MiB', () => {
    const msg = makeMsg([
      { path: '/big.ts', name: 'big.ts', size: 2 * 1024 * 1024, mtime: 0, kind: 'text' },
    ])
    render(<>{fileDisplayRenderer.renderFull!(msg)}</>)
    const previewBtn = screen.getByRole('button', { name: /预览/ })
    expect(previewBtn).toBeDisabled()
  })

  it('calls openFilePreview on preview click', () => {
    const msg = makeMsg([
      { path: '/a.ts', name: 'a.ts', size: 100, mtime: 0, kind: 'text' },
    ])
    render(<>{fileDisplayRenderer.renderFull!(msg)}</>)
    fireEvent.click(screen.getByRole('button', { name: /预览/ }))
    expect(useAgentStore.getState().filePreviewPath).toBe('/a.ts')
  })

  it('calls /api/fs/reveal on open-folder click', async () => {
    const fetchSpy = vi.spyOn(global, 'fetch').mockResolvedValue(new Response())
    const msg = makeMsg([
      { path: '/a.ts', name: 'a.ts', size: 100, mtime: 0, kind: 'text' },
    ])
    render(<>{fileDisplayRenderer.renderFull!(msg)}</>)
    fireEvent.click(screen.getByRole('button', { name: /打开目录/ }))
    expect(fetchSpy).toHaveBeenCalledWith(
      '/api/fs/reveal',
      expect.objectContaining({ method: 'POST' }),
    )
    fetchSpy.mockRestore()
  })
})

describe('fileDisplayRenderer.preview', () => {
  it('returns "展示 N 个文件" summary', () => {
    expect(fileDisplayRenderer.preview({ paths: ['/a', '/b', '/c'] } as any)).toBe('展示 3 个文件')
  })
})
```

- [ ] **Step 2: 运行测试确认失败**

Run:
```bash
cd /Users/ethan/code/opencc-web-display-files
pnpm --filter @zn-ai/zai test test/web/components/toolRenderers/fileDisplay.test.tsx
```
Expected: FAIL "Cannot find module"。

- [ ] **Step 3: 实现 fileDisplay.tsx**

新建 `packages/zai/src/web/src/components/toolRenderers/fileDisplay.tsx`:

```tsx
/**
 * fileDisplayRenderer — display_files 工具的 React 渲染。
 * 走 renderFull 整块接管 (header + card list),与 Edit/Write 的 diffRenderer 同模式。
 * 每个文件卡片:
 *   - name / size / mtime
 *   - 错误态红 Tag(若有 error 字段)
 *   - [预览] 按钮:无错误 + size ≤ 1 MiB 时启用
 *   - [打开目录] 按钮:总是 fire-and-forget POST /api/fs/reveal
 */
import React from "react"
import { Button, Card, Tag, Space, Tooltip, Typography } from "antd"
import { FileTextOutlined, EyeOutlined, FolderOpenOutlined, FileImageOutlined, CodeOutlined, FileUnknownOutlined } from "@ant-design/icons"
import type { ToolRenderer } from "./types.js"
import { useAgentStore } from "../../store/useAgentStore.js"

const ONE_MIB = 1024 * 1024

type FileMeta = {
  path: string
  name: string
  size: number
  mtime: number
  kind: 'text' | 'image' | 'html' | 'binary'
  error?: { code: string; message: string }
}

function humanSize(n: number): string {
  if (n < 1024) return `${n} B`
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`
  return `${(n / 1024 / 1024).toFixed(2)} MB`
}

function kindIcon(kind: FileMeta['kind']): React.ReactNode {
  switch (kind) {
    case 'text': return <FileTextOutlined />
    case 'image': return <FileImageOutlined />
    case 'html': return <CodeOutlined />
    default: return <FileUnknownOutlined />
  }
}

function errorLabel(code: string): string {
  switch (code) {
    case 'ENOENT': return '文件不存在'
    case 'EACCES':
    case 'EPERM': return '无权限'
    case 'EISDIR': return '是目录'
    case 'ETOOBIG': return '文件过大'
    default: return code
  }
}

function parseFiles(msg: any): FileMeta[] {
  const out = msg?.output
  if (!out) return []
  // result shape: { content: [{ type: 'json', json: { files: FileMeta[] } }] }
  const block = Array.isArray(out?.content) ? out.content[0] : null
  const files = block?.json?.files ?? out?.json?.files ?? out?.files
  return Array.isArray(files) ? files : []
}

function FileCard({ file }: { file: FileMeta }) {
  const openPreview = useAgentStore((s) => s.openFilePreview)
  const previewable = !file.error && file.size > 0 && file.size <= ONE_MIB

  const onReveal = () => {
    void fetch('/api/fs/reveal', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ path: file.path }),
    })
  }

  return (
    <Card size="small" style={{ marginBottom: 8 }}>
      <Space direction="vertical" size={4} style={{ width: '100%' }}>
        <Space>
          {kindIcon(file.kind)}
          <Typography.Text strong>{file.name}</Typography.Text>
          {file.error && <Tag color="error">{errorLabel(file.error.code)}</Tag>}
        </Space>
        <Space size="small" style={{ color: 'var(--text-dim-65)', fontSize: 12 }}>
          <span>{humanSize(file.size)}</span>
          {file.mtime > 0 && <span>{new Date(file.mtime).toLocaleString()}</span>}
          <Typography.Text type="secondary" ellipsis style={{ maxWidth: 400 }}>
            {file.path}
          </Typography.Text>
        </Space>
        <Space>
          <Tooltip title={previewable ? '预览文件内容' : file.error ? errorLabel(file.error.code) : '文件过大,请在文件管理器中打开'}>
            <Button
              size="small"
              icon={<EyeOutlined />}
              disabled={!previewable}
              onClick={() => openPreview(file.path)}
            >
              预览
            </Button>
          </Tooltip>
          <Button size="small" icon={<FolderOpenOutlined />} onClick={onReveal}>
            打开目录
          </Button>
        </Space>
      </Space>
    </Card>
  )
}

export const fileDisplayRenderer: ToolRenderer = {
  preview(input) {
    const paths = Array.isArray(input?.paths) ? input.paths : []
    return `展示 ${paths.length} 个文件`
  },
  renderFull(msg) {
    const files = parseFiles(msg)
    if (files.length === 0) return null
    return (
      <div data-testid="file-display-list">
        {files.map((f) => (
          <FileCard key={f.path} file={f} />
        ))}
      </div>
    )
  },
}
```

- [ ] **Step 4: 注册到 registry**

打开 `packages/zai/src/web/src/components/toolRenderers/registry.ts`,在 import 区域(line 1-9)增加:

```ts
import { fileDisplayRenderer } from "./fileDisplay.js"
```

并在 `registry` 对象(line 11-20)增加:

```ts
  DisplayFiles: fileDisplayRenderer,
```

- [ ] **Step 5: 重新运行测试确认通过**

Run:
```bash
cd /Users/ethan/code/opencc-web-display-files
pnpm --filter @zn-ai/zai test test/web/components/toolRenderers/fileDisplay.test.tsx
```
Expected: PASS(若失败,先检查 `useAgentStore` 的 setState 模式 —— 可能 actions 已是 store 创建时直接提供,无需在 `beforeEach` 重设)。

- [ ] **Step 6: 提交**

```bash
cd /Users/ethan/code/opencc-web-display-files
git add packages/zai/src/web/src/components/toolRenderers/fileDisplay.tsx packages/zai/src/web/src/components/toolRenderers/registry.ts packages/zai/test/web/components/toolRenderers/fileDisplay.test.tsx
git commit -m "feat(zai): add fileDisplayRenderer + register DisplayFiles in tool renderers"
```

---

## Task 8: FilePreviewDrawer 组件(TDD)

**Files:**
- Create: `packages/zai/src/web/src/components/conversation/FilePreviewDrawer.tsx`
- Test: `packages/zai/test/web/components/conversation/FilePreviewDrawer.test.tsx`

**Interfaces:**
- Consumes: AntD `Drawer` / `Alert` / `Spin` / `Button`;`useAgentStore` 的 `filePreviewPath` / `closeFilePreview`;`SyntaxHighlighter` / `MarkdownText` / `<iframe sandbox="">` / `<img src=data:>`
- Produces: `<FilePreviewDrawer />` 单例组件(无 props,从 store 读 path)

- [ ] **Step 1: 写失败测试**

新建 `packages/zai/test/web/components/conversation/FilePreviewDrawer.test.tsx`:

```tsx
import { describe, expect, it, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import React from 'react'
import { FilePreviewDrawer } from '../../../../src/web/src/components/conversation/FilePreviewDrawer.js'
import { useAgentStore } from '../../../../src/web/src/store/useAgentStore.js'

function mockFetch(payload: any) {
  return vi.spyOn(global, 'fetch').mockResolvedValue({
    ok: true,
    status: 200,
    json: async () => payload,
  } as any)
}

describe('FilePreviewDrawer', () => {
  beforeEach(() => {
    useAgentStore.setState({ filePreviewPath: null, closeFilePreview: () => useAgentStore.setState({ filePreviewPath: null }) })
  })

  it('renders nothing when path is null', () => {
    const { container } = render(<FilePreviewDrawer />)
    expect(container.querySelector('.ant-drawer')).toBeNull()
  })

  it('renders text content via SyntaxHighlighter for .ts', async () => {
    mockFetch({ kind: 'text', mime: 'text/plain', content: 'const x = 1\n', size: 11, mtime: 0 })
    useAgentStore.setState({ filePreviewPath: '/a.ts' })
    render(<FilePreviewDrawer />)
    await waitFor(() => {
      expect(screen.getByText(/const x = 1/)).toBeInTheDocument()
    })
  })

  it('renders image via <img> with data URL', async () => {
    mockFetch({ kind: 'image', mime: 'image/png', content: 'AAAA', size: 3, mtime: 0 })
    useAgentStore.setState({ filePreviewPath: '/a.png' })
    render(<FilePreviewDrawer />)
    await waitFor(() => {
      const img = screen.getByRole('img')
      expect(img.getAttribute('src')).toMatch(/^data:image\/png;base64,AAAA$/)
    })
  })

  it('renders html via <iframe> with sandbox=""', async () => {
    mockFetch({ kind: 'html', mime: 'text/html', content: '<h1>x</h1>', size: 8, mtime: 0 })
    useAgentStore.setState({ filePreviewPath: '/a.html' })
    render(<FilePreviewDrawer />)
    await waitFor(() => {
      const iframe = document.querySelector('iframe')
      expect(iframe).not.toBeNull()
      expect(iframe!.getAttribute('sandbox')).toBe('')
    })
  })

  it('renders binary metadata + open-folder button', async () => {
    mockFetch({ kind: 'binary', size: 100, mtime: 0, ext: '.zip' })
    useAgentStore.setState({ filePreviewPath: '/a.zip' })
    render(<FilePreviewDrawer />)
    await waitFor(() => {
      expect(screen.getByText(/不支持内联预览/)).toBeInTheDocument()
      expect(screen.getByRole('button', { name: /打开目录/ })).toBeInTheDocument()
    })
  })

  it('shows Alert with error message on 404', async () => {
    vi.spyOn(global, 'fetch').mockResolvedValue({
      ok: false, status: 404, json: async () => ({ error: { code: 'ENOENT', message: '文件不存在' } }),
    } as any)
    useAgentStore.setState({ filePreviewPath: '/nope.txt' })
    render(<FilePreviewDrawer />)
    await waitFor(() => {
      expect(screen.getByText(/文件不存在/)).toBeInTheDocument()
    })
  })
})
```

- [ ] **Step 2: 运行测试确认失败**

Run:
```bash
cd /Users/ethan/code/opencc-web-display-files
pnpm --filter @zn-ai/zai test test/web/components/conversation/FilePreviewDrawer.test.tsx
```
Expected: FAIL "Cannot find module"。

- [ ] **Step 3: 实现 FilePreviewDrawer.tsx**

新建 `packages/zai/src/web/src/components/conversation/FilePreviewDrawer.tsx`:

```tsx
/**
 * FilePreviewDrawer — display_files 工具的右侧 Drawer 预览。
 * 从 useAgentStore.filePreviewPath 读当前打开路径,自动 fetch /api/fs/preview
 * 并按 kind 渲染(text/code/MD/html/image/binary)。
 */
import React, { useEffect, useState } from "react"
import { Alert, Button, Drawer, Spin, Typography } from "antd"
import { FolderOpenOutlined } from "@ant-design/icons"
import { useAgentStore } from "../../store/useAgentStore.js"
import { MarkdownText } from "../../markdown/MarkdownText.js"

type Payload = {
  kind: 'text' | 'image' | 'html' | 'binary'
  mime?: string
  content?: string
  size: number
  mtime: number
  ext?: string
}

const PREVIEW_LINE_LIMIT = 200

function humanSize(n: number): string {
  if (n < 1024) return `${n} B`
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`
  return `${(n / 1024 / 1024).toFixed(2)} MB`
}

function basename(path: string): string {
  const parts = path.split('/')
  return parts[parts.length - 1] || path
}

function detectLanguage(path: string): string {
  const ext = path.toLowerCase().split('.').pop() ?? ''
  const map: Record<string, string> = {
    ts: 'typescript', tsx: 'typescript', js: 'javascript', jsx: 'javascript',
    mjs: 'javascript', cjs: 'javascript', json: 'json', jsonc: 'json',
    py: 'python', rb: 'ruby', go: 'go', rs: 'rust', java: 'java',
    css: 'css', scss: 'scss', less: 'less', html: 'xml', xml: 'xml',
    yaml: 'yaml', yml: 'yaml', toml: 'ini', ini: 'ini', sh: 'bash',
    bash: 'bash', zsh: 'bash', sql: 'sql', md: 'markdown',
  }
  return map[ext] ?? 'text'
}

function truncateLines(text: string, limit: number): { head: string; truncated: boolean } {
  const lines = text.split('\n')
  if (lines.length <= limit) return { head: text, truncated: false }
  return { head: lines.slice(0, limit).join('\n'), truncated: true }
}

export function FilePreviewDrawer() {
  const path = useAgentStore((s) => s.filePreviewPath)
  const closeFilePreview = useAgentStore((s) => s.closeFilePreview)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [payload, setPayload] = useState<Payload | null>(null)
  const [expanded, setExpanded] = useState(false)

  useEffect(() => {
    if (!path) {
      setPayload(null)
      setError(null)
      setLoading(false)
      setExpanded(false)
      return
    }
    let cancelled = false
    setLoading(true)
    setError(null)
    setPayload(null)
    setExpanded(false)
    fetch(`/api/fs/preview?path=${encodeURIComponent(path)}`)
      .then(async (r) => {
        const body = await r.json()
        if (cancelled) return
        if (!r.ok) {
          setError(body?.error?.message ?? `HTTP ${r.status}`)
        } else {
          setPayload(body as Payload)
        }
      })
      .catch((e) => {
        if (!cancelled) setError(String(e))
      })
      .finally(() => { if (!cancelled) setLoading(false) })
    return () => { cancelled = true }
  }, [path])

  const open = path !== null

  return (
    <Drawer
      title={path ? `${basename(path)} (${humanSize(0)})` : ''}
      placement="right"
      width={720}
      open={open}
      onClose={closeFilePreview}
      destroyOnClose
    >
      {!path ? null : loading ? (
        <div style={{ textAlign: 'center', padding: 40 }}><Spin /></div>
      ) : error ? (
        <Alert type="error" message={error} />
      ) : !payload ? null : payload.kind === 'image' ? (
        <img
          src={`data:${payload.mime ?? 'application/octet-stream'};base64,${payload.content}`}
          style={{ maxWidth: '100%' }}
          alt={basename(path)}
        />
      ) : payload.kind === 'html' ? (
        <iframe
          srcDoc={payload.content ?? ''}
          sandbox=""
          title={basename(path)}
          style={{ width: '100%', height: 'calc(100vh - 120px)', border: 0 }}
        />
      ) : payload.kind === 'binary' ? (
        <div>
          <Alert
            type="info"
            message="此文件类型不支持内联预览"
            description={
              <div>
                <Typography.Paragraph>大小: {humanSize(payload.size)}</Typography.Paragraph>
                {payload.ext && <Typography.Paragraph>扩展名: {payload.ext}</Typography.Paragraph>}
                <Button
                  icon={<FolderOpenOutlined />}
                  onClick={() => void fetch('/api/fs/reveal', {
                    method: 'POST',
                    headers: { 'content-type': 'application/json' },
                    body: JSON.stringify({ path }),
                  })}
                >
                  打开目录
                </Button>
              </div>
            }
          />
        </div>
      ) : (
        <TextPreview path={path} content={payload.content ?? ''} expanded={expanded} onToggle={() => setExpanded(!expanded)} />
      )}
    </Drawer>
  )
}

function TextPreview({ path, content, expanded, onToggle }: { path: string; content: string; expanded: boolean; onToggle: () => void }) {
  const ext = path.toLowerCase().split('.').pop() ?? ''
  const isMd = ext === 'md' || ext === 'markdown'
  const { head, truncated } = truncateLines(content, PREVIEW_LINE_LIMIT)
  const display = !truncated || expanded ? content : head
  if (isMd) {
    return (
      <div>
        <MarkdownText source={display} />
        {truncated && !expanded && <Button type="link" onClick={onToggle}>展开全部</Button>}
      </div>
    )
  }
  // 代码/纯文本走 dynamic-import SyntaxHighlighter(react-syntax-highlighter ~610KB,
  // 不能静态 import,会被 vite 拆为独立 chunk;首次打开代码文件会异步加载,
  // 加载完前显示 <pre> 占位,与 markdown/syntaxHighlighter.ts 的 lazy 模式一致)
  return <CodeBlock path={path} content={display} truncated={truncated && !expanded} onToggle={onToggle} />
}

import { MarkdownText } from "../../markdown/MarkdownText.js"

function CodeBlock({ path, content, truncated, onToggle }: { path: string; content: string; truncated: boolean; onToggle: () => void }) {
  const [Highlighter, setHighlighter] = useState<null | { SyntaxHighlighter: any; oneDark: any }>(null)
  useEffect(() => {
    let cancelled = false
    import("../../markdown/syntaxHighlighter.js").then((mod) => {
      if (!cancelled) setHighlighter({ SyntaxHighlighter: mod.SyntaxHighlighter, oneDark: mod.oneDark })
    })
    return () => { cancelled = true }
  }, [])
  const lang = detectLanguage(path)
  return (
    <div>
      {Highlighter ? (
        <Highlighter.SyntaxHighlighter language={lang} style={Highlighter.oneDark} customStyle={{ fontSize: 12 }}>
          {content}
        </Highlighter.SyntaxHighlighter>
      ) : (
        <pre data-testid="code-fallback" data-language={lang} style={{ whiteSpace: 'pre', fontSize: 12, padding: 12, background: '#282c34', color: '#abb2bf' }}>
          {content}
        </pre>
      )}
      {truncated && <Button type="link" onClick={onToggle}>展开全部</Button>}
    </div>
  )
}
```

> 注:`SyntaxHighlighter` 通过 `import("../../markdown/syntaxHighlighter.js")` 动态加载(`markdown/syntaxHighlighter.ts` 是 lazy shim,不能静态 import);MD 通过 `MarkdownText` 直接渲染。dynamic import 加载完前显示 `<pre data-testid="code-fallback">` 占位,首屏延迟可见但 200ms 内完成。

- [ ] **Step 4: 重新运行测试确认通过**

Run:
```bash
cd /Users/ethan/code/opencc-web-display-files
pnpm --filter @zn-ai/zai test test/web/components/conversation/FilePreviewDrawer.test.tsx
```
Expected: PASS。

- [ ] **Step 5: 提交**

```bash
cd /Users/ethan/code/opencc-web-display-files
git add packages/zai/src/web/src/components/conversation/FilePreviewDrawer.tsx packages/zai/test/web/components/conversation/FilePreviewDrawer.test.tsx
git commit -m "feat(zai): add FilePreviewDrawer with kind-based content rendering"
```

---

## Task 9: root mount(Agent.tsx + MobileAgent.tsx)

**Files:**
- Modify: `packages/zai/src/web/src/pages/Agent.tsx:513-515` 区域
- Modify: `packages/zai/src/web/src/pages/MobileAgent.tsx:79-81` 区域

**Interfaces:**
- Consumes: `FilePreviewDrawer` from `../components/conversation/FilePreviewDrawer.js` / `'../components/conversation/FilePreviewDrawer'`
- Produces: 两个页面顶层挂载单例 `<FilePreviewDrawer />`

- [ ] **Step 1: Agent.tsx 挂载**

打开 `packages/zai/src/web/src/pages/Agent.tsx`,在 `import SettingsDrawer from "../components/SettingsDrawer";`(line 23)下面加:

```tsx
import { FilePreviewDrawer } from "../components/conversation/FilePreviewDrawer.js";
```

在 line 515 `<SettingsDrawer />` 下面追加:

```tsx
      <FilePreviewDrawer />
```

- [ ] **Step 2: MobileAgent.tsx 挂载**

打开 `packages/zai/src/web/src/pages/MobileAgent.tsx`,在 `import SettingsDrawer from '../components/SettingsDrawer'`(line 10)下面加:

```tsx
import { FilePreviewDrawer } from '../components/conversation/FilePreviewDrawer'
```

在 line 81 `<SettingsDrawer />` 下面追加:

```tsx
      <FilePreviewDrawer />
```

- [ ] **Step 3: 类型检查**

Run:
```bash
cd /Users/ethan/code/opencc-web-display-files
pnpm -r exec tsc --noEmit
```
Expected: 0 errors。

- [ ] **Step 4: 跑 web 相关单测确保不破坏现有页面 test**

Run:
```bash
cd /Users/ethan/code/opencc-web-display-files
pnpm --filter @zn-ai/zai test test/web/pages/Agent.test.tsx
```
Expected: PASS(若失败,可能因为 Agent.test.tsx mock 了 TaskDrawer 等 — 同步加 `vi.mock("../components/conversation/FilePreviewDrawer.js", () => ({ FilePreviewDrawer: () => null }))` 到 Agent.test.tsx 顶部 mock 列表)。

- [ ] **Step 5: 提交**

```bash
cd /Users/ethan/code/opencc-web-display-files
git add packages/zai/src/web/src/pages/Agent.tsx packages/zai/src/web/src/pages/MobileAgent.tsx
git commit -m "feat(zai): mount FilePreviewDrawer in Agent and MobileAgent pages"
```

---

## Task 10: build:core + 真实浏览器验收(/ego-browser)

**Files:** 无新文件;验证 + 修复

- [ ] **Step 1: 改 core 后必须 build**

Run:
```bash
cd /Users/ethan/code/opencc-web-display-files
pnpm run build:core
```
Expected: build 成功,无错误。

- [ ] **Step 2: 启动 zai dev(独立端口)**

Run:
```bash
cd /Users/ethan/code/opencc-web-display-files
pnpm --filter @zn-ai/zai dev -- --port 8102 --api-port 7715
```
Expected: zai 启动,frontend 在 8102,API 在 7715(独立端口,避免与 920x 正式服务 / 8101 已占用实例冲突)。

**后台运行**(用 run_in_background),等几秒后用 `curl http://localhost:8102` 确认服务可达。

- [ ] **Step 3: 通过 `/ego-browser` 真实浏览器验收**

按 AGENTS.md "真实浏览器验收" 节,通过 ego-browser skill 驱动真实浏览器:

> 用 browser-operator agent(ego-browser)完成多步骤验证:
> 1. 打开 `http://localhost:8102/agent`
> 2. 在对话输入框输入:"请把 /tmp/test.txt 这个文件展示给我"(LLM 触发 display_files 工具调用)
> 3. 验证:
>    - 工具卡片渲染,显示文件名 / size / mtime
>    - [预览] 按钮可点 → Drawer 弹窗 → SyntaxHighlighter/pre 渲染文件内容
>    - [打开目录] 按钮 fire-and-forget(验证 fetch 调用,不一定真打开 Finder)
>    - 文件 > 1 MiB 时 [预览] 按钮 disabled
>    - 路径不存在 → 卡片红 Tag "文件不存在"
>    - 图片(`.png`)/HTML(`.html`)/MD(`.md`)各类型分别验证

- [ ] **Step 4: 移动端独立路径验证**

通过 `/ego-browser` 访问 `http://localhost:8102/m`,重复 Step 3 的核心验证(卡片 + Drawer + 按钮)。

- [ ] **Step 5: 修复发现的问题**

若验收发现 UI/逻辑/类型问题,逐个修复,每个修复单独 commit。修复后**重新 build:core**(若改 core)+ 重新启 zai dev + 重跑 ego-browser 直到全部通过。

- [ ] **Step 6: 最终提交(若有修复)+ 整体验收标记**

```bash
cd /Users/ethan/code/opencc-web-display-files
git log --oneline feat/display-files-tool ^main
```
确认 main..HEAD 是完整 feature 提交链。然后告知用户验收结果与 commit 列表。

---

## Self-Review(已执行)

**1. Spec 覆盖**:spec 11 个章节均有对应任务:
- §2 范围与约束 → Task 1 (fileKind 分类), Task 3 (1 MiB 上限 + maxBytes clamp + 任意绝对路径), Task 4 (paths max 20)
- §4 工具定义 → Task 4 (displayFiles.ts), Task 5 (注册)
- §5 前端渲染 → Task 6 (store), Task 7 (renderer + registry), Task 8 (Drawer), Task 9 (mount)
- §6 后端 /fs/preview → Task 2 (类型), Task 3 (handler)
- §7 错误处理矩阵 → Task 3 (mapStatError), Task 4 (normalizeErrno), Task 7 (错误态 UI)
- §8 持久化 → Task 7 (renderer 重渲染), Task 8 (Drawer 按需 fetch)
- §9 测试 → Task 1/3/4/5/7/8/9 各自单测, Task 10 ego-browser 验收
- §10 风险 → 全局约束已写明不复用 FsTab FilePreview、HTML sandbox=""、1 MiB hard cap、build:core 强制
- §11 worktree → 已用

**2. Placeholder scan**:无 "TBD" / "TODO" / "fill in"。所有代码块都有完整实现。`createFsTestApp` 在 Step 1 注里指明沿用 `fs.test.ts` 现有模式(避免凭空写 helper)。

**3. 类型一致性**:
- `FilePreviewKind` 在 zai 端 `fileKind.ts` 与 zn-agent-core 端 `displayFiles.ts` 都是 `'text' | 'image' | 'html' | 'binary'`
- 工具结果 JSON shape `{ files: FileMeta[] }` 一致
- `FileMeta` 字段 `path / name / size / mtime / kind / error?` 一致
- `filePreviewPath: string | null` state 在 store / renderer / Drawer 三处一致
- Drawer fetch `/api/fs/preview` query 与 Task 3 路由 query 一致(`path` + `maxBytes`)
