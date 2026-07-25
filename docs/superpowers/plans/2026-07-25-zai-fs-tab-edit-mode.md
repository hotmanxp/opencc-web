# zai FsTab 文件预览编辑模式 — 实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在 zai 的 Files 标签(`FsTab`)上,把文本 / 代码 / Markdown 文件预览升级为"可点击编辑 → Cmd/Ctrl+S 保存"的轻量编辑器,保持图片 / HTML 预览的只读语义。

**Architecture:**
- 后端 `routes/fs.ts` 新增 `PUT /api/fs/file`,复用 `resolveSafePath` + `TEXT_EXTS` 白名单 + 2 MB 上限,写入后返回新 `mtime`/`size`。
- 前端新增 `useFsWrite` hook 封装 `api.put('/fs/file')`,把 `ApiError` 翻译为 `{ ok:false, error }`。
- 新增 `TextEditor` 组件封装 CodeMirror 6(5 个 lang 包 + Cmd-S / Esc 拦截 + dark theme)。
- `FsTab` 加 `editingPath` + `dirtyPaths` state,在预览区 header 加 `编辑 / 保存 / 取消` 按钮,在 file tree dirty 路径前画淡橙小圆点。

**Tech Stack:** TypeScript、Express、Vitest(`@vitest-environment happy-dom` + `@testing-library/react` + `renderHook`)、Ant Design、React、CodeMirror 6(`@codemirror/state` + `view` + `commands` + `lang-javascript` + `lang-json` + `lang-python` + `lang-rust` + `lang-go` + `lang-sql`)。

---

## Global Constraints

- 服务端扩展名白名单:**严格沿用** `routes/fs.ts:14-23` 的 `TEXT_EXTS`(代码 / Markdown / YAML / JSON / 脚本 / SQL 等);不在白名单的扩展名 + 非 dotfile 一律拒绝写入(状态码 400)
- 路径安全:**严格复用** `utils/safePath.ts:resolveSafePath` 做越界 + NUL 防护;NUL 走 400,越界走 403(沿用现有 `safe.error` 字符串区分)
- 大小上限:`Buffer.byteLength(content, 'utf8') > 2 * 1024 * 1024` → 413(沿用现有 `MAX_FILE_BYTES` 常量)
- 写入:覆盖式 `writeFile(abs, content, 'utf8')`;不锁、不 mtime 检查
- 响应:成功 `{ ok:true, path, name, mtime, size }`(复用 `FsFile` schema);失败 `{ ok:false, error }`
- 状态码:200 / 400 / 403 / 404 / 413 / 500
- 客户端:`api.put`(`lib/api.ts:33-37`)走 `Content-Type: application/json`,失败抛 `ApiError` 由 hook catch
- 前端可编辑范围:**仅 `file.kind === 'text'`**;`image` / `html` 仍只读(不显示编辑按钮)
- 编辑器:Ctrl/Cmd+S 保存、Esc 取消、不引入查找 / 多光标菜单 / settings(本期 YAGNI)
- 脏标记:前端内存 `Set<string>`,切 cwd 时清空,刷新 / 切文件不主动清
- 测试覆盖:关键模块 line ≥ 85%(commit 前 `pnpm vitest run` + `pnpm typecheck`)
- 不在本次引入 Monaco / Ace / 文件锁 / SSE 通知 agent / 编辑未保存确认弹窗

---

## File Structure

新建:
- `packages/zai/src/server/utils/fsWrite.ts` — `writeTextFile(safePath, content)` 单一职责,封装 stat + writeFile + 字节上限校验。便于测试与复用。
- `packages/zai/src/web/src/components/splitPane/useFsWrite.ts` — `useFsWrite()` hook。
- `packages/zai/src/web/src/components/splitPane/TextEditor.tsx` — CodeMirror 6 封装。

修改:
- `packages/zai/src/server/routes/fs.ts` — 加 `fsRouter.put('/fs/file', ...)`。
- `packages/zai/src/web/src/components/splitPane/FsTab.tsx` — 加 `editingPath` / `dirtyPaths` state、header 按钮、editor 挂载、tree 圆点。

测试:
- `packages/zai/src/server/utils/fsWrite.test.ts`(新)
- `packages/zai/src/server/routes/fs.test.ts`(在现有 `describe('routes/fs')` 内加 `describe('PUT /fs/file')`)
- `packages/zai/src/web/src/components/splitPane/useFsWrite.test.tsx`(新)
- `packages/zai/src/web/src/components/splitPane/TextEditor.test.tsx`(新)
- `packages/zai/src/web/src/components/splitPane/FsTab.test.tsx`(在现有 `describe('FsTab')` 内加 5 个 case)

依赖:
- `packages/zai/package.json` `dependencies` 加 6 个 CodeMirror 包(`state` / `view` / `commands` / `lang-javascript` / `lang-json` / `lang-python` / `lang-rust` / `lang-go` / `lang-sql`)。

---

## Task 1: 服务端 `writeTextFile` 工具

**Files:**
- Create: `packages/zai/src/server/utils/fsWrite.ts`
- Test: `packages/zai/src/server/utils/fsWrite.test.ts`

**Interfaces:**
- Consumes: `node:fs/promises` 的 `stat` + `writeFile`,常量 `MAX_FILE_BYTES = 2 * 1024 * 1024`(从 `routes/fs.ts:7` 复用,本文件 import 而非重复定义)
- Produces:
  ```ts
  export async function writeTextFile(
    absPath: string,
    content: string,
  ): Promise<{ ok: true; mtime: string; size: number } | { ok: false; code: 'ENOENT' | 'EACCES' | 'ENOSPC' | 'OTHER'; error: string }>;
  ```

- [ ] **Step 1: 写失败测试**

`packages/zai/src/server/utils/fsWrite.test.ts`:

```ts
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, readFileSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { writeTextFile } from './fsWrite.js';

describe('writeTextFile', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'zai-fsWrite-'));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  test('writes utf8 content and returns mtime/size', async () => {
    const file = join(dir, 'a.txt');
    const result = await writeTextFile(file, '你好\n世界\n');
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.size).toBe(Buffer.byteLength('你好\n世界\n', 'utf8'));
    expect(new Date(result.mtime).getTime()).toBeGreaterThan(0);
    expect(readFileSync(file, 'utf8')).toBe('你好\n世界\n');
  });

  test('overwrites existing file', async () => {
    const file = join(dir, 'a.txt');
    writeFileSync(file, 'old');
    const result = await writeTextFile(file, 'new');
    expect(result.ok).toBe(true);
    expect(readFileSync(file, 'utf8')).toBe('new');
  });

  test('returns ENOENT when target dir missing', async () => {
    const result = await writeTextFile(join(dir, 'no-such-dir/a.txt'), 'x');
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.code).toBe('ENOENT');
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cd packages/zai && pnpm vitest run src/server/utils/fsWrite.test.ts`
Expected: FAIL — `Cannot find module './fsWrite.js'`

- [ ] **Step 3: 实现 `writeTextFile`**

`packages/zai/src/server/utils/fsWrite.ts`:

```ts
import { stat, writeFile } from 'node:fs/promises';

export const MAX_FILE_BYTES = 2 * 1024 * 1024;

export interface WriteTextFileOk { ok: true; mtime: string; size: number }
export interface WriteTextFileErr { ok: false; code: 'ENOENT' | 'EACCES' | 'ENOSPC' | 'OTHER'; error: string }
export type WriteTextFileResult = WriteTextFileOk | WriteTextFileErr;

/**
 * Overwrite `absPath` with utf8 `content`. Reports back the new mtime + size
 * on success. Designed for the `/api/fs/file` PUT endpoint — keep this
 * layer thin so the route handler owns auth (resolveSafePath) and the
 * extension allow-list, not this helper.
 *
 * Error mapping:
 *   - stat ENOENT → { ok:false, code:'ENOENT' }   (file deleted between resolveSafePath and write)
 *   - writeFile EACCES / EPERM → { ok:false, code:'EACCES' }
 *   - writeFile ENOSPC → { ok:false, code:'ENOSPC' }
 *   - everything else → { ok:false, code:'OTHER' }
 *
 * The caller turns `code` into an HTTP status: ENOENT → 404, EACCES / ENOSPC
 * → 500, OTHER → 500. ByteLength enforcement is the route's job (so it can
 * reject pre-stat, saving a write attempt on a 2MB+ payload).
 */
export async function writeTextFile(
  absPath: string,
  content: string,
): Promise<WriteTextFileResult> {
  try {
    await stat(absPath);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'ENOENT') return { ok: false, code: 'ENOENT', error: '文件不存在' };
    return { ok: false, code: 'OTHER', error: `stat 失败: ${(err as Error).message}` };
  }
  try {
    await writeFile(absPath, content, 'utf8');
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'EACCES' || code === 'EPERM') {
      return { ok: false, code: 'EACCES', error: `权限不足: ${code}` };
    }
    if (code === 'ENOSPC') {
      return { ok: false, code: 'ENOSPC', error: '磁盘空间不足' };
    }
    return { ok: false, code: 'OTHER', error: `写入失败: ${(err as Error).message}` };
  }
  const info = await stat(absPath);
  return { ok: true, mtime: info.mtime.toISOString(), size: info.size };
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `cd packages/zai && pnpm vitest run src/server/utils/fsWrite.test.ts`
Expected: 3 passed

- [ ] **Step 5: Commit**

```bash
git add packages/zai/src/server/utils/fsWrite.ts packages/zai/src/server/utils/fsWrite.test.ts
git commit -m "feat(zai): add writeTextFile helper for PUT /fs/file"
```

---

## Task 2: 服务端 `PUT /api/fs/file` 端点

**Files:**
- Modify: `packages/zai/src/server/routes/fs.ts`(在 `fsRouter.get('/fs/file', ...)` 之后插入 `fsRouter.put('/fs/file', ...)`)
- Modify: `packages/zai/src/server/routes/fs.test.ts`(在 `describe('routes/fs', () => { ... })` 内新增 `describe('PUT /fs/file', () => { ... })`)

**Interfaces:**
- Consumes: `resolveSafePath(cwd, rel)` + 现有 `TEXT_EXTS` / `IMAGE_EXTS` / `HTML_EXTS` 常量 + 新建的 `writeTextFile`
- Produces:HTTP 路由 `PUT /api/fs/file`,body `{ path, content }`,响应 `FsFile`(成功 `{ok:true,path,name,mtime,size}`;失败 `{ok:false,error}`)

- [ ] **Step 1: 写失败测试**

`packages/zai/src/server/routes/fs.test.ts` 追加(在 `describe('GET /fs/file refuses escape', ...)` 块之后):

```ts
describe('PUT /fs/file', () => {
  beforeEach(() => {
    writeFileSync(join(root, 'put-target.ts'), 'old\n');
  });

  test('writes a text file under cwd', async () => {
    const res = await request(makeApp(root))
      .put('/api/fs/file')
      .send({ path: 'put-target.ts', content: 'new content' });
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.path).toMatch(/put-target\.ts$/);
    expect(typeof res.body.mtime).toBe('string');
    expect(res.body.size).toBe(Buffer.byteLength('new content', 'utf8'));
    expect(readFileSync(join(root, 'put-target.ts'), 'utf8')).toBe('new content');
  });

  test('returns 400 when path is missing', async () => {
    const res = await request(makeApp(root))
      .put('/api/fs/file')
      .send({ content: 'x' });
    expect(res.status).toBe(400);
    expect(res.body.ok).toBe(false);
  });

  test('returns 400 when extension is not text', async () => {
    const res = await request(makeApp(root))
      .put('/api/fs/file')
      .send({ path: 'image.bin', content: 'x' });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/不支持|不允许/);
    // file must not have been created
    expect((await import('node:fs')).existsSync(join(root, 'image.bin'))).toBe(true); // pre-existing fixture
    // content unchanged
    const buf = readFileSync(join(root, 'image.bin'));
    expect(buf.equals(Buffer.from([0, 1, 2, 3]))).toBe(true);
  });

  test('returns 403 when path escapes cwd', async () => {
    const res = await request(makeApp(root))
      .put('/api/fs/file')
      .send({ path: '../../etc/passwd', content: 'x' });
    expect(res.status).toBe(403);
    expect(res.body.ok).toBe(false);
    expect(res.body.error).toMatch(/禁止访问|越界/);
  });

  test('returns 400 when path contains NUL byte', async () => {
    const res = await request(makeApp(root))
      .put('/api/fs/file')
      .send({ path: 'src/foo\x00../etc/passwd', content: 'x' });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/NUL/);
  });

  test('returns 404 when target file missing', async () => {
    rmSync(join(root, 'put-target.ts'));
    const res = await request(makeApp(root))
      .put('/api/fs/file')
      .send({ path: 'put-target.ts', content: 'x' });
    expect(res.status).toBe(404);
    expect(res.body.ok).toBe(false);
  });

  test('returns 413 when content exceeds 2MB', async () => {
    const big = 'x'.repeat(2 * 1024 * 1024 + 1);
    const res = await request(makeApp(root))
      .put('/api/fs/file')
      .send({ path: 'put-target.ts', content: big });
    expect(res.status).toBe(413);
    expect(res.body.ok).toBe(false);
    // file untouched
    expect(readFileSync(join(root, 'put-target.ts'), 'utf8')).toBe('old\n');
  });

  test('preserves utf8 multi-byte sequences', async () => {
    const res = await request(makeApp(root))
      .put('/api/fs/file')
      .send({ path: 'put-target.ts', content: '你好\n世界\n' });
    expect(res.status).toBe(200);
    expect(readFileSync(join(root, 'put-target.ts'), 'utf8')).toBe('你好\n世界\n');
    expect(res.body.size).toBe(Buffer.byteLength('你好\n世界\n', 'utf8'));
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cd packages/zai && pnpm vitest run src/server/routes/fs.test.ts -t "PUT /fs/file"`
Expected: FAIL — 404 路由

- [ ] **Step 3: 实现 `PUT /fs/file` 路由**

`packages/zai/src/server/routes/fs.ts`,在 `fsRouter.get('/fs/file', ...)` 块(以 `res.json(body);` 结尾的 if (isHtml) / else 分支之后,L361 附近)之后插入:

```ts
import { MAX_FILE_BYTES, writeTextFile } from '../utils/fsWrite.js';
```

修改顶部 import(`fs.ts:5` 已是 `import type { FsAck, FsEntry, FsFile, FsList, FsSearchEntry, FsSearchResult } from '../../shared/fs.js';`,无需调整)。在 `fs.ts` 文件**末尾**(最后一个 `fsRouter.post('/fs/delete', ...)` 之前或之后皆可,但放在 delete 块之后保持"先读后写"语义),追加:

```ts
fsRouter.put('/fs/file', async (req, res) => {
  const { cwd } = ctx(req);
  const body = req.body ?? {};
  const rel = typeof body.path === 'string' ? body.path : '';
  const content = typeof body.content === 'string' ? body.content : null;
  if (!rel) {
    res.status(400).json({ ok: false, error: '缺少 path 参数' } satisfies FsFile);
    return;
  }
  if (content === null) {
    res.status(400).json({ ok: false, error: '缺少 content 字段' } satisfies FsFile);
    return;
  }
  const safe = resolveSafePath(cwd, rel);
  if (!safe.ok) {
    const status = safe.error.includes('NUL') ? 400 : 403;
    res.status(status).json({ ok: false, error: safe.error } satisfies FsFile);
    return;
  }
  // 扩展名白名单:复用 GET /fs/file 的逻辑(只允许 TEXT_EXTS 内的扩展 + dotfile)
  const ext = extname(safe.abs).toLowerCase();
  const base = basename(safe.abs);
  const isDotfile = base.startsWith('.') && base !== '.' && base !== '..';
  if (!TEXT_EXTS.has(ext) && !isDotfile) {
    res.status(400).json({ ok: false, error: `不允许写入:扩展名 ${ext || '(无)'} 不在白名单` } satisfies FsFile);
    return;
  }
  const bytes = Buffer.byteLength(content, 'utf8');
  if (bytes > MAX_FILE_BYTES) {
    const mb = (bytes / 1024 / 1024).toFixed(2);
    res.status(413).json({ ok: false, error: `内容过大 (${mb} MB > 2 MB)` } satisfies FsFile);
    return;
  }
  const result = await writeTextFile(safe.abs, content);
  if (!result.ok) {
    if (result.code === 'ENOENT') {
      res.status(404).json({ ok: false, error: result.error } satisfies FsFile);
      return;
    }
    res.status(500).json({ ok: false, error: result.error } satisfies FsFile);
    return;
  }
  res.json({
    ok: true,
    kind: 'text',
    path: safe.abs,
    name: base,
    size: result.size,
    mtime: result.mtime,
  } satisfies FsFile);
});
```

> 注意:现有 `GET /fs/file` 已经用 `MAX_FILE_BYTES` 做 `info.size > MAX_FILE_BYTES → 413`(`fs.ts:303-307`),这里 `MAX_FILE_BYTES` 在新文件 `fsWrite.ts` 中 export 后从 import 取,删除原 `fs.ts:7` 的本地常量避免重复定义(同时也是为了保持单一来源):
>
> ```diff
> - const MAX_FILE_BYTES = 2 * 1024 * 1024;
> ```

- [ ] **Step 4: 跑测试确认通过**

Run: `cd packages/zai && pnpm vitest run src/server/routes/fs.test.ts -t "PUT /fs/file"`
Expected: 8 passed

- [ ] **Step 5: 跑全文件测试,确保 GET /fs/file 仍然过(因为改了 MAX_FILE_BYTES 来源)**

Run: `cd packages/zai && pnpm vitest run src/server/routes/fs.test.ts`
Expected: all passed

- [ ] **Step 6: Commit**

```bash
git add packages/zai/src/server/routes/fs.ts packages/zai/src/server/routes/fs.test.ts
git commit -m "feat(zai): add PUT /fs/file endpoint for text file writes"
```

---

## Task 3: 安装 CodeMirror 6 依赖

**Files:**
- Modify: `packages/zai/package.json`(`dependencies` 段)

**Interfaces:**
- 无代码接口,只新增 npm 依赖。

- [ ] **Step 1: 添加依赖**

`packages/zai/package.json` `dependencies` 末尾追加:

```json
"@codemirror/state": "^6.4.0",
"@codemirror/view": "^6.30.0",
"@codemirror/commands": "^6.6.0",
"@codemirror/lang-javascript": "^6.2.2",
"@codemirror/lang-json": "^6.0.1",
"@codemirror/lang-python": "^6.1.6",
"@codemirror/lang-rust": "^6.0.1",
"@codemirror/lang-go": "^6.0.1",
"@codemirror/lang-sql": "^6.7.0"
```

- [ ] **Step 2: 安装**

Run: `pnpm install`
Expected: 9 packages added; 无 ERR!

- [ ] **Step 3: 验证 TS 类型能解析**

Run: `cd packages/zai && pnpm typecheck`
Expected: 无新报错(原项目已有类型错误不算)

- [ ] **Step 4: Commit**

```bash
git add packages/zai/package.json pnpm-lock.yaml
git commit -m "chore(zai): add CodeMirror 6 deps for file editor"
```

---

## Task 4: 前端 `useFsWrite` hook

**Files:**
- Create: `packages/zai/src/web/src/components/splitPane/useFsWrite.ts`
- Test: `packages/zai/src/web/src/components/splitPane/useFsWrite.test.tsx`

**Interfaces:**
- Consumes: `lib/api.ts:api.put`、`shared/fs.ts:FsFile`
- Produces:
  ```ts
  export interface UseFsWriteResult {
    save: (path: string, content: string) => Promise<{ ok: boolean; mtime?: string; size?: number; error?: string }>;
    saving: boolean;
  }
  export function useFsWrite(): UseFsWriteResult;
  ```

- [ ] **Step 1: 写失败测试**

`packages/zai/src/web/src/components/splitPane/useFsWrite.test.tsx`:

```tsx
// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { renderHook, act } from '@testing-library/react';

vi.mock('../../lib/api.js', () => ({
  api: {
    put: vi.fn(),
    get: vi.fn(),
    post: vi.fn(),
  },
}));

import { api } from '../../lib/api.js';
import { useFsWrite } from './useFsWrite.js';

const mockPut = api.put as unknown as ReturnType<typeof vi.fn>;

describe('useFsWrite', () => {
  beforeEach(() => {
    mockPut.mockReset();
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  test('calls api.put with /fs/file and body { path, content }', async () => {
    mockPut.mockResolvedValueOnce({ ok: true, mtime: '2026-07-25T00:00:00Z', size: 3 });
    const { result } = renderHook(() => useFsWrite());
    await act(async () => {
      const r = await result.current.save('a.txt', 'hey');
      expect(r).toEqual({ ok: true, mtime: '2026-07-25T00:00:00Z', size: 3 });
    });
    expect(mockPut).toHaveBeenCalledTimes(1);
    expect(mockPut).toHaveBeenCalledWith('/fs/file', { path: 'a.txt', content: 'hey' });
    expect(result.current.saving).toBe(false);
  });

  test('returns { ok:false, error } when api.put rejects', async () => {
    mockPut.mockRejectedValueOnce(new Error('network down'));
    const { result } = renderHook(() => useFsWrite());
    await act(async () => {
      const r = await result.current.save('a.txt', 'x');
      expect(r.ok).toBe(false);
      if (r.ok) return;
      expect(r.error).toMatch(/network down/);
    });
    expect(result.current.saving).toBe(false);
  });

  test('returns { ok:false, error } when server returns { ok:false }', async () => {
    mockPut.mockResolvedValueOnce({ ok: false, error: '权限不足' });
    const { result } = renderHook(() => useFsWrite());
    await act(async () => {
      const r = await result.current.save('a.txt', 'x');
      expect(r.ok).toBe(false);
      if (r.ok) return;
      expect(r.error).toBe('权限不足');
    });
  });

  test('saving flag is true during in-flight request', async () => {
    let resolveSave!: (v: unknown) => void;
    mockPut.mockImplementationOnce(() => new Promise((res) => { resolveSave = res; }));
    const { result } = renderHook(() => useFsWrite());
    let savePromise: Promise<unknown> = Promise.resolve();
    act(() => {
      savePromise = result.current.save('a.txt', 'x');
    });
    expect(result.current.saving).toBe(true);
    await act(async () => {
      resolveSave({ ok: true, mtime: '', size: 1 });
      await savePromise;
    });
    expect(result.current.saving).toBe(false);
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cd packages/zai && pnpm vitest run src/web/src/components/splitPane/useFsWrite.test.tsx`
Expected: FAIL — `Cannot find module './useFsWrite.js'`

- [ ] **Step 3: 实现 hook**

`packages/zai/src/web/src/components/splitPane/useFsWrite.ts`:

```ts
import { useCallback, useRef, useState } from 'react';
import { api } from '../../lib/api.js';
import type { FsFile } from '../../../../shared/fs.js';

export interface UseFsWriteResult {
  save: (path: string, content: string) => Promise<{ ok: boolean; mtime?: string; size?: number; error?: string }>;
  saving: boolean;
}

/**
 * Wraps `PUT /api/fs/file` for the file editor. Returns `{ ok:false, error }`
 * instead of throwing — the editor stays mounted on failure so the user's
 * keystrokes aren't lost. `saving` is a single in-flight flag (the editor
 * only needs to know "is a save happening right now" for the Save button
 * loading state; concurrent saves are not a supported flow).
 */
export function useFsWrite(): UseFsWriteResult {
  const [saving, setSaving] = useState(false);
  // Ref guard so a stray double-click on Save doesn't double-fire while
  // saving is true. setSaving is async; we want the second click to bail
  // immediately.
  const inFlight = useRef(false);

  const save = useCallback(async (path: string, content: string) => {
    if (inFlight.current) {
      return { ok: false, error: '已有保存请求正在进行' };
    }
    inFlight.current = true;
    setSaving(true);
    try {
      const res = await api.put<FsFile>('/fs/file', { path, content });
      if (!res.ok) {
        return { ok: false, error: res.error ?? '保存失败' };
      }
      return { ok: true, mtime: res.mtime, size: res.size };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    } finally {
      inFlight.current = false;
      setSaving(false);
    }
  }, []);

  return { save, saving };
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `cd packages/zai && pnpm vitest run src/web/src/components/splitPane/useFsWrite.test.tsx`
Expected: 4 passed

- [ ] **Step 5: Commit**

```bash
git add packages/zai/src/web/src/components/splitPane/useFsWrite.ts packages/zai/src/web/src/components/splitPane/useFsWrite.test.tsx
git commit -m "feat(zai-web): add useFsWrite hook for PUT /fs/file"
```

---

## Task 5: 前端 `TextEditor` 组件

**Files:**
- Create: `packages/zai/src/web/src/components/splitPane/TextEditor.tsx`
- Test: `packages/zai/src/web/src/components/splitPane/TextEditor.test.tsx`

**Interfaces:**
- Consumes: `@codemirror/state`, `@codemirror/view`, `@codemirror/commands`, `@codemirror/lang-javascript`, `@codemirror/lang-json`, `@codemirror/lang-python`, `@codemirror/lang-rust`, `@codemirror/lang-go`, `@codemirror/lang-sql`
- Produces:
  ```ts
  export interface TextEditorProps {
    initialContent: string;
    language: string | null; // extToLanguage(name) 的输出, null = 纯文本
    onSave: (newContent: string) => void | Promise<void>;
    onCancel: () => void;
    saving?: boolean;
  }
  export function TextEditor(props: TextEditorProps): JSX.Element;
  // 容器 data-testid="fs-editor"; 内部由 CodeMirror 渲染 .cm-editor
  ```

- [ ] **Step 1: 写失败测试**

`packages/zai/src/web/src/components/splitPane/TextEditor.test.tsx`:

```tsx
// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { render, screen, fireEvent, cleanup } from '@testing-library/react';

vi.mock('@codemirror/lang-javascript', () => ({ javascript: () => ({}) }));
vi.mock('@codemirror/lang-json', () => ({ json: () => ({}) }));
vi.mock('@codemirror/lang-python', () => ({ python: () => ({}) }));
vi.mock('@codemirror/lang-rust', () => ({ rust: () => ({}) }));
vi.mock('@codemirror/lang-go', () => ({ go: () => ({}) }));
vi.mock('@codemirror/lang-sql', () => ({ sql: () => ({}) }));

import { TextEditor } from './TextEditor.js';

describe('TextEditor', () => {
  beforeEach(() => { /* nothing */ });
  afterEach(() => { cleanup(); });

  test('mounts CodeMirror with the initial content', () => {
    render(<TextEditor initialContent="hello" language="typescript" onSave={() => {}} onCancel={() => {}} />);
    const editor = screen.getByTestId('fs-editor');
    expect(editor.querySelector('.cm-editor')).toBeTruthy();
    // The doc is rendered inside .cm-content
    expect(editor.textContent).toContain('hello');
  });

  test('fires onSave with current doc on Ctrl/Cmd-S', async () => {
    const onSave = vi.fn();
    render(<TextEditor initialContent="abc" language="typescript" onSave={onSave} onCancel={() => {}} />);
    // CodeMirror receives keystrokes at the contenteditable surface; the
    // test framework dispatches a real keydown which CodeMirror's keymap
    // picks up.
    const surface = screen.getByTestId('fs-editor').querySelector('.cm-content') as HTMLElement;
    expect(surface).toBeTruthy();
    fireEvent.keyDown(surface, { key: 's', code: 'KeyS', ctrlKey: true, metaKey: false });
    // Default browser behavior would call preventDefault; we just assert
    // onSave fires with the initial doc.
    expect(onSave).toHaveBeenCalledWith('abc');
  });

  test('fires onCancel on Escape', () => {
    const onCancel = vi.fn();
    render(<TextEditor initialContent="abc" language={null} onSave={() => {}} onCancel={onCancel} />);
    const surface = screen.getByTestId('fs-editor').querySelector('.cm-content') as HTMLElement;
    fireEvent.keyDown(surface, { key: 'Escape', code: 'Escape' });
    expect(onCancel).toHaveBeenCalledTimes(1);
  });

  test('does not throw on unmount', () => {
    const { unmount } = render(<TextEditor initialContent="x" language={null} onSave={() => {}} onCancel={() => {}} />);
    expect(() => unmount()).not.toThrow();
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cd packages/zai && pnpm vitest run src/web/src/components/splitPane/TextEditor.test.tsx`
Expected: FAIL — `Cannot find module './TextEditor.js'`

- [ ] **Step 3: 实现 `TextEditor`**

`packages/zai/src/web/src/components/splitPane/TextEditor.tsx`:

```tsx
import { useEffect, useRef } from 'react';
import { EditorState } from '@codemirror/state';
import { EditorView, keymap, lineNumbers, highlightActiveLine } from '@codemirror/view';
import { defaultKeymap, history, historyKeymap, indentWithTab } from '@codemirror/commands';
import { javascript } from '@codemirror/lang-javascript';
import { json } from '@codemirror/lang-json';
import { python } from '@codemirror/lang-python';
import { rust } from '@codemirror/lang-rust';
import { go } from '@codemirror/lang-go';
import { sql } from '@codemirror/lang-sql';

export interface TextEditorProps {
  initialContent: string;
  /** extToLanguage(name) result. null = plain text (no language pack). */
  language: string | null;
  onSave: (newContent: string) => void | Promise<void>;
  onCancel: () => void;
  saving?: boolean;
}

/**
 * Map Prism-style language ids from `extToLanguage` to CodeMirror language
 * extensions. Anything not in the map falls back to plain text (no lang
 * extension is added — CM's default behavior).
 */
function langLoader(language: string | null) {
  switch (language) {
    case 'typescript':
    case 'tsx':
    case 'javascript':
    case 'jsx':
      return javascript();
    case 'json':
      return json();
    case 'python':
      return python();
    case 'rust':
      return rust();
    case 'go':
      return go();
    case 'sql':
      return sql();
    default:
      return null;
  }
}

/**
 * Mount a CodeMirror 6 view into the returned container. Dark theme aligned
 * with the rest of the zai web UI (#0d0d0d background, off-white text, dim
 * selection). Cmd-S / Ctrl-S triggers `onSave`; Escape triggers `onCancel`.
 * The view is destroyed on unmount to avoid leaking DOM event handlers.
 *
 * We do NOT import `@codemirror/view/dist/index.css` — CM ships the styles
 * inline in JS for v6. We do override a few class names via `EditorView.theme`
 * so colors match zai's palette.
 */
export function TextEditor(props: TextEditorProps): JSX.Element {
  const { initialContent, language, onSave, onCancel, saving } = props;
  const containerRef = useRef<HTMLDivElement | null>(null);
  const viewRef = useRef<EditorView | null>(null);

  useEffect(() => {
    if (!containerRef.current) return;
    const langExt = langLoader(language);
    const state = EditorState.create({
      doc: initialContent,
      extensions: [
        lineNumbers(),
        highlightActiveLine(),
        history(),
        keymap.of([
          ...defaultKeymap,
          ...historyKeymap,
          indentWithTab,
          {
            key: 'Mod-s',
            preventDefault: true,
            run: (view) => {
              void onSave(view.state.doc.toString());
              return true;
            },
          },
          {
            key: 'Escape',
            preventDefault: false,
            run: () => {
              onCancel();
              return true;
            },
          },
        ]),
        ...(langExt ? [langExt] : []),
        EditorView.theme({
          '&': {
            backgroundColor: '#0d0d0d',
            color: 'rgba(255,255,255,0.85)',
            height: '100%',
            fontSize: '12px',
          },
          '.cm-content': {
            fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace',
          },
          '.cm-gutters': {
            backgroundColor: '#0d0d0d',
            color: 'rgba(255,255,255,0.35)',
            border: 'none',
          },
          '.cm-activeLine': {
            backgroundColor: 'rgba(255,255,255,0.04)',
          },
          '.cm-activeLineGutter': {
            backgroundColor: 'transparent',
            color: 'rgba(255,255,255,0.65)',
          },
        }),
      ],
    });
    const view = new EditorView({ state, parent: containerRef.current });
    viewRef.current = view;
    return () => {
      view.destroy();
      viewRef.current = null;
    };
    // initialContent 改变 → 重挂;onSave/onCancel 用 ref 包一层避免无效重挂。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [initialContent, language]);

  // 占位 useEffect:让 `saving` prop 切换时父组件(若有 spinner)能感知到。
  // 这里不做渲染,仅依赖数组包含 saving 即可让 React 在该 prop 变化时不警告。
  useEffect(() => {
    /* saving is consumed by parent for button loading state */
  }, [saving]);

  return (
    <div
      data-testid="fs-editor"
      ref={containerRef}
      style={{ flex: 1, minHeight: 0, overflow: 'auto' }}
    />
  );
}
- [ ] **Step 4: 跑测试确认通过**

Run: `cd packages/zai && pnpm vitest run src/web/src/components/splitPane/TextEditor.test.tsx`
Expected: 4 passed(注意:如果 CodeMirror 在 happy-dom 下初始化失败,需要调整 keymap dispatch 路径 — 见 §4 已知问题)

- [ ] **Step 5: Commit**

```bash
git add packages/zai/src/web/src/components/splitPane/TextEditor.tsx packages/zai/src/web/src/components/splitPane/TextEditor.test.tsx
git commit -m "feat(zai-web): add TextEditor CodeMirror 6 component"
```

---

## Task 6: FsTab 编辑态集成(Edit 按钮 + editor 挂载 + dirty 标记)

**Files:**
- Modify: `packages/zai/src/web/src/components/splitPane/FsTab.tsx`(state、header 按钮、renderTree 圆点、editor 挂载)
- Modify: `packages/zai/src/web/src/components/splitPane/FsTab.test.tsx`(5 个新 case,加 `vi.mock('./useFsWrite.js')`)

**Interfaces:**
- Consumes:Task 4 的 `useFsWrite`,Task 5 的 `TextEditor`,现有 `useFsFile` / `extToLanguage`
- Produces:
  - header 内(仅 `file.kind === 'text'` 时):`[data-testid="fs-edit-btn"]` 「编辑」 按钮
  - 编辑态:`[data-testid="fs-save-btn"]` 「保存」、`[data-testid="fs-cancel-btn"]` 「取消」
  - 预览区:`[data-testid="fs-editor"]` (来自 `<TextEditor>`)
  - 文件树:`[data-testid="fs-tree-dirty-<name>"]` 圆点(脏路径的 title 前 `<span style="..." />`)
  - state:`editingPath: string | null`、`dirtyPaths: Set<string>`

- [ ] **Step 1: 写失败测试**

`packages/zai/src/web/src/components/splitPane/FsTab.test.tsx` 顶部 `vi.mock` 块补:

```ts
vi.mock('./useFsWrite.js', () => ({
  useFsWrite: vi.fn(),
}));
```

并在文件末尾追加 import:

```ts
import { useFsWrite } from './useFsWrite.js';
const mockWrite = useFsWrite as unknown as ReturnType<typeof vi.fn>;
```

在 `describe('FsTab', ...)` 块内 `beforeEach` 处增加:

```ts
beforeEach(() => {
  mockSearch.mockReturnValue({ data: null, loading: false, error: null, durationMs: null });
  mockWrite.mockReturnValue({ save: vi.fn().mockResolvedValue({ ok: true }), saving: false });
});
```

5 个新 case:

```tsx
it('shows 编辑 button only for text-kind files', () => {
  mockList.mockReturnValue({
    data: { ok: true, entries: [
      { name: 'foo.ts', path: 'foo.ts', type: 'file', size: 10 },
    ]},
    loading: false, error: null, refetch: vi.fn(),
  });
  mockFile.mockReturnValue({
    data: { ok: true, path: '/repo/foo.ts', name: 'foo.ts', size: 10, mtime: '', content: 'x' },
    loading: false, error: null,
  });
  render(<FsTab cwd="/repo" />);
  fireEvent.click(screen.getByText('foo.ts'));
  expect(screen.getByTestId('fs-edit-btn')).toBeTruthy();
});

it('hides 编辑 button for image and html files', () => {
  mockList.mockReturnValue({
    data: { ok: true, entries: [
      { name: 'pic.png', path: 'pic.png', type: 'file', size: 10 },
    ]},
    loading: false, error: null, refetch: vi.fn(),
  });
  mockFile.mockReturnValue({
    data: { ok: true, kind: 'image', path: '/repo/pic.png', name: 'pic.png', size: 10, mime: 'image/png', dataUrl: 'data:image/png;base64,xxx' },
    loading: false, error: null,
  });
  render(<FsTab cwd="/repo" />);
  fireEvent.click(screen.getByText('pic.png'));
  expect(screen.queryByTestId('fs-edit-btn')).toBeNull();
});

it('enters edit mode on 编辑 click', () => {
  mockList.mockReturnValue({
    data: { ok: true, entries: [
      { name: 'foo.ts', path: 'foo.ts', type: 'file', size: 10 },
    ]},
    loading: false, error: null, refetch: vi.fn(),
  });
  mockFile.mockReturnValue({
    data: { ok: true, path: '/repo/foo.ts', name: 'foo.ts', size: 10, mtime: '', content: 'x' },
    loading: false, error: null,
  });
  render(<FsTab cwd="/repo" />);
  fireEvent.click(screen.getByText('foo.ts'));
  fireEvent.click(screen.getByTestId('fs-edit-btn'));
  expect(screen.getByTestId('fs-editor')).toBeTruthy();
  expect(screen.getByTestId('fs-save-btn')).toBeTruthy();
  expect(screen.getByTestId('fs-cancel-btn')).toBeTruthy();
});

it('saves on Save click and marks file dirty', async () => {
  const save = vi.fn().mockResolvedValue({ ok: true });
  mockWrite.mockReturnValue({ save, saving: false });
  mockList.mockReturnValue({
    data: { ok: true, entries: [
      { name: 'foo.ts', path: 'foo.ts', type: 'file', size: 10 },
    ]},
    loading: false, error: null, refetch: vi.fn(),
  });
  mockFile.mockReturnValue({
    data: { ok: true, path: '/repo/foo.ts', name: 'foo.ts', size: 10, mtime: '', content: 'x' },
    loading: false, error: null,
  });
  render(<FsTab cwd="/repo" />);
  fireEvent.click(screen.getByText('foo.ts'));
  fireEvent.click(screen.getByTestId('fs-edit-btn'));
  // Editor mounts; we can't easily dispatch Mod-S through CodeMirror in
  // happy-dom, so we exercise the Save button directly.
  fireEvent.click(screen.getByTestId('fs-save-btn'));
  expect(save).toHaveBeenCalledTimes(1);
  expect(save).toHaveBeenCalledWith('foo.ts', expect.any(String));
  // dirty dot rendered in tree
  expect(screen.getByTestId('fs-tree-dirty-foo.ts')).toBeTruthy();
});

it('does not call save on Cancel click', () => {
  const save = vi.fn();
  mockWrite.mockReturnValue({ save, saving: false });
  mockList.mockReturnValue({
    data: { ok: true, entries: [
      { name: 'foo.ts', path: 'foo.ts', type: 'file', size: 10 },
    ]},
    loading: false, error: null, refetch: vi.fn(),
  });
  mockFile.mockReturnValue({
    data: { ok: true, path: '/repo/foo.ts', name: 'foo.ts', size: 10, mtime: '', content: 'x' },
    loading: false, error: null,
  });
  render(<FsTab cwd="/repo" />);
  fireEvent.click(screen.getByText('foo.ts'));
  fireEvent.click(screen.getByTestId('fs-edit-btn'));
  fireEvent.click(screen.getByTestId('fs-cancel-btn'));
  expect(save).not.toHaveBeenCalled();
  expect(screen.queryByTestId('fs-editor')).toBeNull();
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cd packages/zai && pnpm vitest run src/web/src/components/splitPane/FsTab.test.tsx`
Expected: 5 新 case 全 FAIL(按钮 / editor 找不到)

- [ ] **Step 3: 改 `FsTab.tsx` — 加 state + 按钮 + editor + 圆点**

在 `FsTab.tsx` 顶部 import 段(在 `import { MarkdownText }` 后)追加:

```tsx
import { TextEditor } from './TextEditor.js';
import { useFsWrite } from './useFsWrite.js';
import { message } from 'antd';
```

在 `useFsFile(cwd, selected);` 后(`FsTab.tsx:263`)增加 state + hook:

```tsx
const { save: saveFile, saving } = useFsWrite();
const [editingPath, setEditingPath] = useState<string | null>(null);
const [dirtyPaths, setDirtyPaths] = useState<Set<string>>(new Set());
```

扩展现有 `useEffect([cwd])`(L281-287 附近)增加 `setEditingPath(null)` + `setDirtyPaths(new Set())`:

```tsx
useEffect(() => {
  setSelected(null);
  setExpandedKeys([]);
  setLoaded({});
  setContextMenu(null);
  setQuery('');
  setEditingPath(null);
  setDirtyPaths(new Set());
}, [cwd]);
```

在 `FsTab.tsx` 的 `FsTab` 函数体内部、JSX 返回之前,加一个 `handleSave` 处理函数(放在 `refreshBtn` 之后):

```tsx
const handleSave = async (path: string, content: string) => {
  const r = await saveFile(path, content);
  if (r.ok) {
    setDirtyPaths((prev) => {
      const next = new Set(prev);
      next.add(path);
      return next;
    });
    setEditingPath(null);
    message.success('已保存');
  } else {
    message.error(r.error ?? '保存失败');
  }
};
const handleCancel = () => {
  setEditingPath(null);
};
```

修改 `renderTree`(L320-349),把 title 节点改成可选前置 dirty 圆点:

```tsx
const renderTree = (entries: Array<{ name: string; path: string; type: 'dir' | 'file'; size: number | null }>): DataNode[] =>
  entries.map((e) => {
    const children = loaded[e.path];
    const isLoaded = Object.prototype.hasOwnProperty.call(loaded, e.path);
    const isDirty = e.type === 'file' && dirtyPaths.has(e.path);
    return {
      key: e.path,
      title: (
        <span style={{ fontFamily: MONO, fontSize: 12 }}>
          {isDirty && (
            <span
              data-testid={`fs-tree-dirty-${e.name}`}
              style={{
                display: 'inline-block',
                width: 6,
                height: 6,
                borderRadius: '50%',
                background: 'rgba(255,102,0,0.7)',
                marginRight: 6,
                verticalAlign: 'middle',
              }}
            />
          )}
          {e.name}
        </span>
      ),
      icon:
        e.type === 'dir' ? (
          <DirIcon name={e.name} open={expandedKeys.includes(e.path)} />
        ) : (
          <FileIcon name={e.name} />
        ),
      isLeaf: e.type === 'file',
      children:
        e.type === 'dir'
          ? isLoaded
            ? renderTree(children ?? [])
            : undefined
          : undefined,
    } as DataNode;
  });
```

修改 header 段(L367-402),在 `<Refresh>` 按钮之前插入编辑态按钮组:

```tsx
{showHtmlToggle && (
  <Segmented ... />
)}
{file.data && file.data.kind === 'text' && file.data.path && editingPath !== file.data.path && (
  <Button
    size="small"
    data-testid="fs-edit-btn"
    onClick={() => setEditingPath(file.data!.path!)}
  >
    编辑
  </Button>
)}
{editingPath && file.data && file.data.path === editingPath && file.data.kind === 'text' && (
  <>
    <Button
      size="small"
      data-testid="fs-save-btn"
      loading={saving}
      onClick={() => {
        // 编辑器在 DOM 中,获取最新 doc 通过 window 上的 cm view 实例。
        // 这里直接通过 TextEditor 的回调拿到新内容;为简单起见,我们
        // 通过自定义事件让 TextEditor 暴露 doc getter。
        const ev = new CustomEvent('fs-editor-get-doc');
        const editor = document.querySelector('[data-testid="fs-editor"]');
        let newContent: string | null = null;
        const handler = (e: Event) => {
          newContent = (e as CustomEvent<string>).detail;
        };
        window.addEventListener('fs-editor-doc', handler);
        editor?.dispatchEvent(ev);
        window.removeEventListener('fs-editor-doc', handler);
        void handleSave(editingPath, newContent ?? file.data!.content ?? '');
      }}
    >
      保存
    </Button>
    <Button size="small" data-testid="fs-cancel-btn" onClick={handleCancel}>
      取消
    </Button>
  </>
)}
{refreshBtn}
```

> 上面 Save 按钮的 doc-getter 设计(自定义事件)需要在 Task 5 的 `TextEditor` 上加一对事件监听 — 见 Task 5 的实现 Step 3 的 `useEffect` 末尾追加:
>
> ```ts
> const onGetDoc = () => {
>   window.dispatchEvent(new CustomEvent('fs-editor-doc', { detail: view.state.doc.toString() }));
> };
> const el = containerRef.current!;
> el.addEventListener('fs-editor-get-doc', onGetDoc);
> return () => {
>   view.destroy();
>   viewRef.current = null;
>   el.removeEventListener('fs-editor-get-doc', onGetDoc);
> };
> ```

修改预览区主段(L484-496),让编辑态替换 `renderPreview`:

```tsx
{!selected ? (
  <Empty description="选择左侧文件查看内容" />
) : file.loading ? (
  <div style={{ textAlign: 'center', padding: 24 }}><Spin /></div>
) : file.error ? (
  <Empty description={file.error} />
) : file.data && editingPath && file.data.path === editingPath && file.data.kind === 'text' && file.data.content !== undefined ? (
  <TextEditor
    initialContent={file.data.content}
    language={file.data.name ? extToLanguage(file.data.name) : null}
    saving={saving}
    onSave={(newContent) => void handleSave(editingPath, newContent)}
    onCancel={handleCancel}
  />
) : file.data && (file.data.content !== undefined || file.data.kind === 'image' || file.data.kind === 'html') ? (
  renderPreview(file.data, htmlMode)
) : (
  <Empty description="没有内容" />
)}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `cd packages/zai && pnpm vitest run src/web/src/components/splitPane/FsTab.test.tsx`
Expected: 所有旧 case + 5 个新 case 全 passed

- [ ] **Step 5: 跑 typecheck**

Run: `cd packages/zai && pnpm typecheck`
Expected: 无新报错

- [ ] **Step 6: Commit**

```bash
git add packages/zai/src/web/src/components/splitPane/FsTab.tsx packages/zai/src/web/src/components/splitPane/FsTab.test.tsx packages/zai/src/web/src/components/splitPane/TextEditor.tsx
git commit -m "feat(zai-web): wire Edit/Save/Cancel into FsTab with dirty dot"
```

---

## Task 7: 端到端验证 + 最终回归

**Files:**
- (no production changes — verification only)

- [ ] **Step 1: 跑服务端所有 fs 测试**

Run: `cd packages/zai && pnpm vitest run src/server/routes/fs.test.ts src/server/utils/fsWrite.test.ts`
Expected: all passed

- [ ] **Step 2: 跑前端 splitPane 测试**

Run: `cd packages/zai && pnpm vitest run src/web/src/components/splitPane`
Expected: all passed

- [ ] **Step 3: 跑全量 web 测试**

Run: `cd packages/zai && pnpm vitest run src/web`
Expected: all passed(无回归)

- [ ] **Step 4: typecheck**

Run: `cd packages/zai && pnpm typecheck`
Expected: 无新报错

- [ ] **Step 5: 手工 sanity(可选)**

Run: `cd packages/zai && pnpm dev`,浏览器打开,选中一个 `.ts` 文件,点 "编辑",改几行,Ctrl+S,确认 toast 弹"已保存"且 tree 项前出现淡橙圆点。

- [ ] **Step 6: Commit(若有 typecheck 修复)**

```bash
git status  # 通常为空
# 仅在 Step 4 修了代码时才需要 commit
```

---

## Self-Review

1. **Spec 覆盖**:
   - §2.1 服务端 `PUT /api/fs.file` + 安全 + 错误码 → Task 1 (`writeTextFile` helper) + Task 2 (路由)
   - §2.2 `TextEditor` + lang 映射 → Task 5
   - §2.3 / 2.4 `FsTab` 切换态 + header 按钮 → Task 6
   - §2.5 `useFsWrite` → Task 4
   - §2.6 dirtyPaths 内存 set + 圆点 → Task 6 (`renderTree` 改动)
   - §2.7 依赖 → Task 3
   - §5 测试 → Task 1 / 2 / 4 / 5 / 6 自带 vitest case;Task 7 端到端回归

2. **Placeholder 扫描**:Plan 中无 "TBD" / "TODO" / "implement later"。所有 code block 完整。**Task 6 Step 3 的 "需要 Task 5 的实现 Step 3 的 useEffect 末尾追加" 通过侧注明确指向,不是占位**。

3. **类型一致**:`useFsWrite` 在 Task 4 定义 `{ save(path, content): Promise<...>, saving: boolean }`,Task 6 调用 `saveFile(path, content)` 与 `saving`;`TextEditor` 的 `saving` prop 在 Task 5 定义后 Task 6 传入,接口一致。`handleSave(path, content)` 在 Task 6 中既被 Save 按钮调用,也被 `TextEditor.onSave` 回调调用,签名一致。

4. **已知边界**:
   - CodeMirror 在 happy-dom 下挂载时 contenteditable 可能行为差异 — `fireEvent.keyDown` 走的是 React 合成事件,CodeMirror 的 keymap 监听原生 keydown,需要确保 dispatch 在 `.cm-content` 节点上(测试代码已显式 querySelector 该节点)。如果测试不稳定,降级方案:用 `view.contentDOM.dispatchEvent(new KeyboardEvent('keydown', { key:'s', ctrlKey:true }))`。
   - Task 6 的 Save 按钮 doc-getter 走自定义事件(`fs-editor-get-doc` / `fs-editor-doc`):依赖 TextEditor 在 mount 时挂监听。如果事件方案不稳,可改为 `window` 上挂 `__currentEditorView` 引用 — 但那需要 Task 5 单独加测试覆盖。当前方案测试只覆盖 "Save 按钮调 save()",不强制验证 doc 内容来源,因为这是 Task 5 单元测试的事。
