# zai /desktop 办公桌面 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 新增 `/desktop` 全屏沉浸式"仿 macOS"办公桌面:壁纸 + Dock + 可拖拽浮窗(资源管理器窗 + Agent 对话窗),资源拖入附件区作为 `@` 文件引用上下文,Agent 默认 Office(仅桌面作用域,进出自动切换/还原)。

**Architecture:** 前端新增 `pages/Desktop.tsx`(脱离 Layout 的顶层路由)装配桌面壳;自研轻浮窗组件 `components/desktop/DesktopWindow.tsx`(受控,Pointer Events 拖拽/缩放,位置存 localStorage);资源管理器 `DesktopExplorer.tsx` 走新增服务端端点 `GET /api/desktop/fs/list|file`(任意绝对路径,安全模型同 fsPicker);Agent 窗直接渲染现有 `AgentConversation`(会话/store/SSE 全局共享);附件区 `AttachmentZone.tsx` 收拖拽文件,发送时经纯函数 `gatherMentions` 以 `mentionGrammar.formatFileMention` 语法 append 进 prompt。「默认 Office」= 进入桌面 snapshot + PUT work-mode/main-agent,离开还原。

**Tech Stack:** React 18 + Zustand + AntD 5;Express(现有 zai server);Vitest(server: supertest;web: happy-dom + testing-library)。

## Global Constraints

- **Commit 格式**(全计划一致):`HRMSV3-ZN-WEBSITE#668 <type>(<scope>): <描述>`,type 用 `feat`/`test`/`docs`,scope 用 `zai`。
- **测试粒度(AGENTS.md)**:只跑受影响测试文件,命令 `pnpm --filter @zn-ai/zai test <path>`,禁止全量 `pnpm -r test`。
- **样式改动不跑单元测试**:壁纸/Dock/窗口视觉仅由 ego-browser 真实验收,不得为样式加单测或把单测当门禁。
- **真实浏览器验收(强制)**:全部代码完成后必须 `/ego-browser` 走通用户路径(见 Task 7)。ego-browser 访问开发实例时**不要 kill 920x 端口进程**,用空闲端口起独立 dev(`pnpm --filter @zn-ai/zai dev -- --port 8102 --api-port 7715`)。
- **仅改 `packages/zai/src/web/` + `packages/zai/src/server/` 无 core 依赖**,**不需要** `build:core`。
- 新建 service/route 后记得在 `server/index.ts` 挂载(`app.use('/api', router)` 与既有路由并列)。
- spec 依赖:`docs/superpowers/specs/2026-08-26-zai-desktop-office-design.md`。
- 本地路径语义跨平台:所有 `path.join/sep` 处理在服务端;前端只透传字符串。服务端新代码引用现有 `expandTilde`(`src/server/utils/expandTilde.js`)。

---

## 文件结构

```
packages/zai/src/shared/desktopFs.ts                        [Task 1] 类型:DesktopFsEntry / DesktopFsList / DesktopFsFile
packages/zai/src/server/routes/desktopFs.ts                  [Task 1] 新路由:GET /desktop/fs/list、GET /desktop/fs/file
packages/zai/src/server/routes/desktopFs.test.ts             [Task 1] supertest 测试(临时目录 fixture)
packages/zai/src/server/index.ts                             [Task 1] 挂载 desktopFsRouter
packages/zai/src/web/src/components/desktop/windowMath.ts    [Task 3] 纯函数:clampBounds / initWindows / applyMaximizeToggle
packages/zai/src/web/src/components/desktop/windowMath.test.ts [Task 3]
packages/zai/src/web/src/components/desktop/DesktopWindow.tsx [Task 3] 浮窗:标题栏拖拽/缩放/置顶/最小化/最大化
packages/zai/src/web/src/components/desktop/DesktopWindow.test.tsx [Task 3]
packages/zai/src/web/src/components/desktop/DesktopExplorer.tsx [Task 4] 资源管理器:Tab 本地/线上、导航、文件网格、拖拽源
packages/zai/src/web/src/components/desktop/DesktopExplorer.test.tsx [Task 4]
packages/zai/src/web/src/components/desktop/AttachmentZone.tsx [Task 5] 附件区:drop → FileRef chip(MentionChip 样式)
packages/zai/src/web/src/components/desktop/AttachmentZone.test.tsx [Task 5]
packages/zai/src/web/src/components/desktop/gatherMentions.ts [Task 2] 纯函数:refs+draft → append 文本
packages/zai/src/web/src/components/desktop/gatherMentions.test.ts [Task 2]
packages/zai/src/web/src/components/desktop/desktopStore.ts   [Task 6] 类型 + useLocalStorageState 组合(窗口/快捷方式/壁纸)
packages/zai/src/web/src/pages/Desktop.tsx                   [Task 6] 页面装配:壁纸/顶栏/Dock/窗口/快捷方式/Office 作用域
packages/zai/src/web/src/pages/Desktop.test.tsx              [Task 6] Office snapshot/还原 PUT 顺序(fetch mock)、移动端重定向
packages/zai/src/web/src/router.tsx                          [Task 6] 顶层新增 /desktop Route(不进 Layout)
packages/zai/src/web/src/components/Layout.tsx               [Task 6] ALL_MENU_ITEMS 加"桌面"项
```

任务依赖:Task 2 ≤ Task 5 ≤ Task 6;Task 4 依赖 Task 1(list 端点);Task 1/2/3 相互独立可并行;Task 7(系统能力打开)依赖 Task 1(desktopFs 路由)与 Task 6(openPreview 分流);Task 8(便签)与 Task 9(待办)依赖 Task 6(Desktop 装配/desktopStore/localStorage)且相互独立可并行;Task 10(验收)依赖 Task 1-9。

---

### Task 1: 服务端 `desktopFs` 端点(list + file)

**Files:**
- Create: `packages/zai/src/shared/desktopFs.ts`
- Create: `packages/zai/src/server/routes/desktopFs.ts`
- Create: `packages/zai/src/server/routes/desktopFs.test.ts`
- Modify: `packages/zai/src/server/index.ts`(import + `app.use('/api', desktopFsRouter)`)

**Interfaces:**
- Produces:
  - `shared/desktopFs.ts`: `interface DesktopFsEntry { name: string; kind: 'file' | 'dir'; size: number; mtime: number }`;`interface DesktopFsList { ok: boolean; path?: string; home?: string; parent?: string | null; entries?: DesktopFsEntry[]; error?: string }`;`interface DesktopFsFile { ok: boolean; mime?: string; dataUrl?: string; size?: number; error?: string }`
  - 路由:`GET /api/desktop/fs/list?path=<abs>`(缺省 → `os.homedir()`;响应含 `home`);`GET /api/desktop/fs/file?path=<abs>`(仅文本/图片,`<=2MB`,返回 dataURL)
- Consumes: `expandTilde`(`src/server/utils/expandTilde.js`);错误映射模式参考 `routes/fsPicker.ts`(`errorBody`)

- [ ] **Step 1: 写 shared 类型**

`packages/zai/src/shared/desktopFs.ts`:
```ts
export interface DesktopFsEntry {
  name: string
  kind: 'file' | 'dir'
  /** 完整子路径(服务端 path.join 生成,OS-native 分隔符——跨平台不必在前端拼) */
  path: string
  size: number
  mtime: number
}
export interface DesktopFsList {
  ok: boolean
  path?: string
  home?: string
  parent?: string | null
  entries?: DesktopFsEntry[]
  error?: string
}
export interface DesktopFsFile {
  ok: boolean
  mime?: string
  dataUrl?: string
  fileName?: string
  error?: string
}
```

- [ ] **Step 2: 写失败测试**

`packages/zai/src/server/routes/desktopFs.test.ts`(模式照 `fsPicker.test.ts`:临时目录 fixture + `makeApp()`):
```ts
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import express from 'express';
import request from 'supertest';
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir, homedir } from 'node:os';
import { join } from 'node:path';
import desktopFsRouter from './desktopFs.js';

function makeApp(): express.Express {
  const app = express();
  app.use('/api', desktopFsRouter);
  return app;
}

describe('routes/desktopFs', () => {
  let root: string;
  beforeAll(() => {
    root = mkdtempSync(join(tmpdir(), 'zai-desktopfs-'));
    mkdirSync(join(root, 'folder'));
    writeFileSync(join(root, 'a.md'), 'hi\n');
    writeFileSync(join(root, 'b.png'), Buffer.from([0x89, 0x50, 0x4e, 0x47])); // PNG magic 非完整,仅测路径存在性
  });
  afterAll(() => rmSync(root, { recursive: true, force: true }));

  test('list: 缺省 path → home,含 home 字段,entries 为数组', async () => {
    const res = await request(makeApp()).get('/api/desktop/fs/list');
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.path).toBe(homedir());
    expect(res.body.home).toBe(homedir());
    expect(Array.isArray(res.body.entries)).toBe(true);
  });

  test('list: 目录在前、文件名字典序、条目含 kind/size/mtime 与完整 path', async () => {
    const res = await request(makeApp()).get('/api/desktop/fs/list').query({ path: root });
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    const entries = res.body.entries as Array<{ name: string; kind: string; size: number; mtime: number; path: string }>;
    expect(entries.map((e) => e.kind)).toEqual(expect.arrayContaining(['file', 'dir']));
    expect(entries[0]!.kind).toBe('dir');                 // 目录第一
    expect(entries.map((e) => e.name)).toEqual(['folder', 'a.md', 'b.png']); // dir 在后按字典序,文件按字典序
    expect(entries[1]!.mtime).toBeGreaterThan(0);
    expect(entries[0]!.path).toBe(join(root, 'folder'));  // path 由服务端 join,OS-native
  });

  test('list: ENOENT → 404, ok:false', async () => {
    const res = await request(makeApp()).get('/api/desktop/fs/list').query({ path: join(root, 'nope') });
    expect(res.status).toBe(404);
    expect(res.body.ok).toBe(false);
  });

  test('list: NUL 字节 → 400', async () => {
    const res = await request(makeApp()).get('/api/desktop/fs/list').query({ path: '/x\x00y' });
    expect(res.status).toBe(400);
  });

  test('list: 根目录 parent 为 null,非根 parent 非 null', async () => {
    const child = join(root, 'folder');
    const resChild = await request(makeApp()).get('/api/desktop/fs/list').query({ path: child });
    expect(resChild.body.parent).toBe(root);
    const resRoot = await request(makeApp()).get('/api/desktop/fs/list').query({ path: '/' });
    expect(resRoot.body.parent).toBeNull();
  });

  test('file: 文本文件返回 dataUrl 文本 mime', async () => {
    const res = await request(makeApp()).get('/api/desktop/fs/file').query({ path: join(root, 'a.md') });
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.mime).toContain('text');
    expect(typeof res.body.dataUrl).toBe('string');
  });

  test('file: 非白名单类型 → 400', async () => {
    // 临时造一个 .zip 文件
    const { writeFileSync: w } = await import('node:fs');
    const zip = join(root, 'x.zip');
    w(zip, 'PK\x03\x04');
    const res = await request(makeApp()).get('/api/desktop/fs/file').query({ path: zip });
    expect(res.status).toBe(400);
  });

  test('file: 超 2MB → 413', async () => {
    const big = join(root, 'big.md');
    writeFileSync(big, 'x'.repeat(2 * 1024 * 1024 + 1));
    const res = await request(makeApp()).get('/api/desktop/fs/file').query({ path: big });
    expect(res.status).toBe(413);
  });

  test('file: ENOENT → 404', async () => {
    const res = await request(makeApp()).get('/api/desktop/fs/file').query({ path: join(root, 'no.txt') });
    expect(res.status).toBe(404);
  });
});
```

- [ ] **Step 3: 跑测试确认失败(模块不存在)**

Run: `pnpm --filter @zn-ai/zai test src/server/routes/desktopFs.test.ts`
Expected: FAIL("Cannot find module './desktopFs.js'")

- [ ] **Step 4: 实现路由**

`packages/zai/src/server/routes/desktopFs.ts`:
```ts
import { Router, type IRouter, type Request } from 'express';
import { readdir, stat, readFile } from 'node:fs/promises';
import { dirname, extname, join, resolve } from 'node:path';
import { homedir } from 'node:os';
import { expandTilde } from '../utils/expandTilde.js';
import type { DesktopFsEntry, DesktopFsList, DesktopFsFile } from '../../shared/desktopFs.js';

const router: IRouter = Router();

// 安全模型同 routes/fsPicker.ts:zai 仅监听 localhost,等同本机 ls。
// 但这里要列"文件+目录"(picker 只列目录),因此独立成端点,不动 fsPicker。
// 相对路径经 resolve 解析(相对 server 进程 cwd),不要求客户端传绝对路径。

const IMAGE_EXTS: Record<string, string> = {
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
  '.gif': 'image/gif', '.webp': 'image/webp', '.bmp': 'image/bmp',
  '.svg': 'image/svg+xml', '.ico': 'image/x-icon', '.avif': 'image/avif',
};
const TEXT_EXTS = new Set([
  '.md', '.markdown', '.txt', '.json', '.jsonc', '.json5', '.yaml', '.yml',
  '.toml', '.ini', '.cfg', '.conf', '.ts', '.tsx', '.js', '.jsx', '.mjs',
  '.cjs', '.css', '.scss', '.less', '.xml', '.sh', '.bash', '.zsh', '.py',
  '.rs', '.go', '.java', '.kt', '.sql', '.graphql', '.log', '.env',
]);
const MAX_FILE_BYTES = 2 * 1024 * 1024;

function errBody(message: string, status: number): { body: DesktopFsList | DesktopFsFile; status: number } {
  return { body: { ok: false, error: message }, status };
}

function normalizePath(raw: string): string {
  if (raw.includes('\x00')) throw Object.assign(new Error('path 含 NUL 字符'), { status: 400 } as { status: number });
  const target = raw === '' ? homedir() : resolve(expandTilde(raw));
  return resolve(target);
}

function toMime(name: string): string | undefined {
  const ext = extname(name).toLowerCase();
  return IMAGE_EXTS[ext] ?? (TEXT_EXTS.has(ext) ? 'text/plain' : undefined);
}

router.get('/desktop/fs/list', async (req: Request, res) => {
  const raw = typeof req.query.path === 'string' ? req.query.path : '';
  let target: string;
  try {
    target = normalizePath(raw);
  } catch (e) {
    const status = (e as { status?: number }).status ?? 500;
    const { body, status: s } = errBody((e as Error).message, status);
    return res.status(s).json(body);
  }
  let st;
  try {
    st = await stat(target);
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code;
    if (code === 'ENOENT') return res.status(404).json(errBody(`目录不存在: ${target}`, 404).body);
    if (code === 'EACCES' || code === 'EPERM') return res.status(403).json(errBody(`无权限访问: ${target}`, 403).body);
    return res.status(500).json(errBody(`stat 失败: ${(e as Error).message}`, 500).body);
  }
  if (!st.isDirectory()) return res.status(400).json(errBody(`不是目录: ${target}`, 400).body);
  let dirents;
  try {
    dirents = await readdir(target, { withFileTypes: true });
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code;
    if (code === 'EACCES' || code === 'EPERM') return res.status(403).json(errBody(`无权限列出目录: ${target}`, 403).body);
    return res.status(500).json(errBody(`读取目录失败: ${(e as Error).message}`, 500).body);
  }
  const entries: DesktopFsEntry[] = [];
  for (const d of dirents) {
    if (d.name === '.' || d.name === '..') continue;
    const child = join(target, d.name);
    let s: Awaited<ReturnType<typeof stat>>;
    try {
      s = await stat(child); // 不 follow symlink(fsPicker 同款取舍)
    } catch {
      continue;
    }
    entries.push({ name: d.name, kind: s.isDirectory() ? 'dir' : 'file', path: child, size: s.size, mtime: s.mtimeMs });
  }
  entries.sort((a, b) =>
    a.kind === b.kind ? a.name.localeCompare(b.name) : a.kind === 'dir' ? -1 : 1,
  );
  const parent = dirname(target) === target ? null : dirname(target);
  const body: DesktopFsList = { ok: true, path: target, home: homedir(), parent, entries };
  res.json(body);
});

router.get('/desktop/fs/file', async (req: Request, res) => {
  const raw = typeof req.query.path === 'string' ? req.query.path : '';
  let target: string;
  try {
    target = normalizePath(raw);
  } catch (e) {
    const status = (e as { status?: number }).status ?? 500;
    const { body, status: s } = errBody((e as Error).message, status);
    return res.status(s).json(body);
  }
  const mime = toMime(target);
  if (!mime) return res.status(400).json(errBody('该类型暂不支持预览', 400).body);
  let buf: Buffer;
  try {
    const st = await stat(target);
    if (!st.isFile()) return res.status(400).json(errBody('不是文件', 400).body);
    if (st.size > MAX_FILE_BYTES) return res.status(413).json(errBody(`文件超过 ${MAX_FILE_BYTES / 1024 / 1024}MB 限制`, 413).body);
    buf = await readFile(target);
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code;
    if (code === 'ENOENT') return res.status(404).json(errBody('文件不存在', 404).body);
    if (code === 'EACCES' || code === 'EPERM') return res.status(403).json(errBody('无权限读取', 403).body);
    return res.status(500).json(errBody(`读取失败: ${(e as Error).message}`, 500).body);
  }
  const body: DesktopFsFile = { ok: true, mime, dataUrl: `data:${mime};base64,${buf.toString('base64')}` };
  res.json(body);
});

export default router;
```

- [ ] **Step 5: 挂载路由**

`packages/zai/src/server/index.ts`:
- import 区加 `import desktopFsRouter from './routes/desktopFs.js';`
- 在 `app.use('/api', fsPickerRouter);`(现约 207 行)之后加 `app.use('/api', desktopFsRouter);`
- 如没有则补 `import { op }`……(无需,普通挂载)

- [ ] **Step 6: 跑测试确认通过**

Run: `pnpm --filter @zn-ai/zai test src/server/routes/desktopFs.test.ts`
Expected: PASS(10 cases)

- [ ] **Step 7: 类型检查**

Run: `pnpm --filter @zn-ai/zai exec tsc --noEmit`
Expected: 无新错误

- [ ] **Step 8: Commit**

```bash
git add packages/zai/src/shared/desktopFs.ts packages/zai/src/server/routes/desktopFs.ts packages/zai/src/server/routes/desktopFs.test.ts packages/zai/src/server/index.ts
git commit -m "HRMSV3-ZN-WEBSITE#668 feat(zai): 新增 /api/desktop/fs list|file 端点(任意路径资源浏览)"
```

---

### Task 2: `gatherMentions` 纯函数

**Files:**
- Create: `packages/zai/src/web/src/components/desktop/gatherMentions.ts`
- Create: `packages/zai/src/web/src/components/desktop/gatherMentions.test.ts`

**Interfaces:**
- Consumes: `formatFileMention`(`~/web/src/components/mentionGrammar.ts`)——签名 `(candidate: {path: string; kind: 'file'|'dir'}, preserveQuote: boolean) => string | undefined`
- Produces: `export interface FileRef { id: string; path: string; name: string; kind: 'file' | 'dir' }`;`export function gatherMentions(refs: FileRef[], draft: string): string`(返回应 append 到 draft 末尾的文本,已含开头分隔;无新增时为 `''`)

- [ ] **Step 1: 写失败测试**

`packages/zai/src/web/src/components/desktop/gatherMentions.test.ts`:
```ts
// @vitest-environment happy-dom
import { describe, expect, test } from 'vitest';
import { gatherMentions, type FileRef } from './gatherMentions.js';

const ref = (path: string, kind: 'file' | 'dir' = 'file'): FileRef => ({
  id: `r-${path}`, path, name: path.split('/').pop() ?? path, kind,
});

describe('gatherMentions', () => {
  test('空附件 → 空字符串', () => {
    expect(gatherMentions([], 'hi')).toBe('');
  });

  test('文件路径 append 为 @path,前有换行分隔', () => {
    expect(gatherMentions([ref('/a/b.md')], '帮我读')).toBe('\n@/a/b.md');
  });

  test('路径含空格 → 引号变体 @"path with space"', () => {
    expect(gatherMentions([ref('/a/my file.md')], '')).toBe('@"/a/my file.md"');
  });

  test('draft 已含同一 @mention → 跳过(去重)', () => {
    const draft = '看下 @/a/b.md 的内容';
    expect(gatherMentions([ref('/a/b.md')], draft)).toBe('');
  });

  test('多条去重 + 空格拼接', () => {
    const refs = [ref('/a/b.md'), ref('/a/b.md'), ref('/c.txt')];
    expect(gatherMentions(refs, '')).toBe('@/a/b.md @/c.txt');
  });

  test('控制字符/双引号路径 → 该条跳过(formatFileMention 返回 undefined)', () => {
    expect(gatherMentions([ref('/a/b".md')], 'x')).toBe('');
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm --filter @zn-ai/zai test src/web/src/components/desktop/gatherMentions.test.ts`
Expected: FAIL(Cannot find module)

- [ ] **Step 3: 实现**

`packages/zai/src/web/src/components/desktop/gatherMentions.ts`:
```ts
import { formatFileMention } from '../mentionGrammar.js';

export interface FileRef {
  id: string;
  path: string;
  name: string;
  kind: 'file' | 'dir';
}

/** 附件 → 追加进 prompt 的 @mention 文本。draft 已含同路径(按 mention 字符串)
 *  时跳过;返回 '' 表示无需追加。control 字符/坏路径(格式化为 undefined)跳过。 */
export function gatherMentions(refs: FileRef[], draft: string): string {
  const mentions: string[] = [];
  const seen = new Set<string>();
  for (const r of refs) {
    const fmt = formatFileMention({ path: r.path, kind: r.kind }, false);
    if (fmt === undefined) continue;               // 控制字符/双引号 → 拒绝
    if (seen.has(fmt)) continue;
    seen.add(fmt);
    if (draft.includes(fmt)) continue;             // 已在原文 → 去重
    mentions.push(fmt);
  }
  if (mentions.length === 0) return '';
  return `\n${mentions.join(' ')}`;
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `pnpm --filter @zn-ai/zai test src/web/src/components/desktop/gatherMentions.test.ts`
Expected: PASS(6 cases)

- [ ] **Step 5: Commit**

```bash
git add packages/zai/src/web/src/components/desktop/gatherMentions.ts packages/zai/src/web/src/components/desktop/gatherMentions.test.ts
git commit -m "HRMSV3-ZN-WEBSITE#668 feat(zai): gatherMentions 纯函数(附件→@mention prompt 文本)"
```

---

### Task 3: `DesktopWindow` 浮窗组件 + 窗口几何纯函数

**Files:**
- Create: `packages/zai/src/web/src/components/desktop/windowMath.ts`
- Create: `packages/zai/src/web/src/components/desktop/windowMath.test.ts`
- Create: `packages/zai/src/web/src/components/desktop/DesktopWindow.tsx`
- Create: `packages/zai/src/web/src/components/desktop/DesktopWindow.test.tsx`

**Interfaces:**
- Produces:
  - `windowMath.ts`:
    ```ts
    export interface WindowBounds { x: number; y: number; w: number; h: number }
    export interface DesktopWindowState extends WindowBounds {
      id: 'agent' | 'explorer'; title: string; z: number;
      minimized: boolean; maximized: boolean;
    }
    export const MIN_W = 320, MIN_H = 200, AGENT_MIN_W = 560, AGENT_MIN_H = 420;
    export function clampBounds(b: WindowBounds, viewport: {w: number; h: number}, id: 'agent' | 'explorer'): WindowBounds
    // x/y 钳制在 viewport 内(至少标题栏可见),w/h 不低于各自最小;最大化态宽度=viewport.w
    export function initWindows(viewport: {w: number; h: number}): DesktopWindowState[]
    // explorer 左(24,24,420,60%) z=1;agent 右(旁 24,24 起,宽 viewport.w-468,高 60%) z=2
    export function toggleMaximized(w: DesktopWindowState, viewport: {w: number; h: number}): DesktopWindowState
    // 记录 preMaximize?简化:maximized 翻转,UI 渲染最大化样式,还原回调用方存的上一次 bounds
    ```
    设计简化:`maximized=true` 时渲染层直接用 `{x:0,y:0,w:viewport.w,h:viewport.h}`;`toggleMaximized` 只翻转布尔。
  - `DesktopWindow.tsx`:
    ```ts
    interface DesktopWindowProps {
      win: DesktopWindowState            // 渲染所需的 z/minimized/maximized/title
      active: boolean
      onFocus: () => void                // 点击即置顶
      onMinimize: () => void
      onToggleMax: () => void
      onChange: (patch: Partial<DesktopWindowState>) => void  // 拖拽/缩放的运动态回写
      viewport: { w: number; h: number }
      children: React.ReactNode
    }
    ```
    渲染:`minimized` 时 `return null`(Dock 负责还原);有效宽高始终经 `clampBounds`。
    标题栏:红黄绿三点(`title-bar-dots`)+ 标题;`onPointerDown` 起拖移(`setPointerCapture`,`onPointerMove` 更新 x/y,`onPointerUp` 释放);右下角 `resize-handle` 同样式缩放。
- Consumes: `DesktopWindowState`(本 task 定义,Task 6 存 localStorage)

- [ ] **Step 1: 写 windowMath 失败测试**

`windowMath.test.ts`:
```ts
import { describe, expect, test } from 'vitest';
import { clampBounds, initWindows, toggleMaximized, AGENT_MIN_W } from './windowMath.js';

const V = { w: 1200, h: 800 };

describe('windowMath', () => {
  test('clampBounds 钳制尺寸不小于最小', () => {
    expect(clampBounds({ x: 0, y: 0, w: 100, h: 100 }, V, 'explorer').w).toBeGreaterThanOrEqual(320);
  });
  test('agent 最小宽 560', () => {
    expect(clampBounds({ x: 0, y: 0, w: 100, h: 100 }, V, 'agent').w).toBe(AGENT_MIN_W);
  });
  test('initWindows 两窗错开、z 递增', () => {
    const ws = initWindows(V);
    expect(ws.map((w) => w.id)).toEqual(['explorer', 'agent']);
    expect(ws[0]!.z).toBeLessThan(ws[1]!.z);
    expect(ws[0]!.x).toBeLessThan(ws[1]!.x);
  });
  test('toggleMaximized 翻转布尔', () => {
    const w = initWindows(V)[0]!;
    expect(toggleMaximized(w, V).maximized).toBe(true);
    expect(toggleMaximized({ ...w, maximized: true }, V).maximized).toBe(false);
  });
});
```

- [ ] **Step 2: 跑确认失败**

Run: `pnpm --filter @zn-ai/zai test src/web/src/components/desktop/windowMath.test.ts`

- [ ] **Step 3: 实现 windowMath**

`windowMath.ts` 实现要点:
```ts
export interface WindowBounds { x: number; y: number; w: number; h: number }
export interface DesktopWindowState extends WindowBounds {
  id: 'agent' | 'explorer'; title: string; z: number;
  minimized: boolean; maximized: boolean;
}
export const MIN_W = 320, MIN_H = 200, AGENT_MIN_W = 560, AGENT_MIN_H = 420;

const minFor = (id: 'agent' | 'explorer') =>
  id === 'agent' ? { w: AGENT_MIN_W, h: AGENT_MIN_H } : { w: MIN_W, h: MIN_H };

export function clampBounds(b: WindowBounds, vp: { w: number; h: number }, id: 'agent' | 'explorer'): WindowBounds {
  const mn = minFor(id);
  const w = Math.min(vp.w, Math.max(mn.w, Math.round(b.w)));
  const h = Math.min(vp.h, Math.max(mn.h, Math.round(b.h)));
  const x = Math.min(Math.max(0, Math.round(b.x)), Math.max(0, vp.w - 60)); // 标题栏至少留 60px 可抓
  const y = Math.min(Math.max(0, Math.round(b.y)), Math.max(0, vp.h - 40));
  return { x, y, w, h };
}

export function initWindows(vp: { w: number; h: number }): DesktopWindowState[] {
  const hh = Math.round(vp.h * 0.6);
  return [
    { id: 'explorer', title: '资源管理器', x: 24, y: 24, w: 420, h: hh, z: 1, minimized: false, maximized: false },
    { id: 'agent', title: 'Agent · Office', x: Math.round(vp.w * 0.4), y: 24, w: Math.max(AGENT_MIN_W, vp.w - Math.round(vp.w * 0.4) - 24), h: hh, z: 2, minimized: false, maximized: false },
  ];
}

export function toggleMaximized(w: DesktopWindowState, _vp: { w: number; h: number }): DesktopWindowState {
  return { ...w, maximized: !w.maximized };
}
```
`initWindows` 的 agent 宽用 `clampBounds` 兜底(测试 1200 → w=1200-480-24=696 ≥ 560 ✓)。Task 6 从 localStorage 读旧值时也会过 `clampBounds`,防损坏数据。

- [ ] **Step 4: 跑过 windowMath 测试**

- [ ] **Step 5: 写 DesktopWindow 组件失败测试**

`DesktopWindow.test.tsx`:
```tsx
// @vitest-environment happy-dom
import { describe, expect, test, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import DesktopWindow from './DesktopWindow.js';
import { initWindows } from './windowMath.js';
import '@testing-library/jest-dom';

const V = { w: 1200, h: 800 };

function baseWin(over: Partial<ReturnType<typeof initWindows>[number]> = {}) {
  return { ...initWindows(V)[1]!, title: 'Agent · Office', ...over };
}

describe('DesktopWindow', () => {
  test('渲染标题与内容,minimized 时返回 null', () => {
    const { rerender } = render(
      <DesktopWindow win={baseWin()} active viewport={V} onFocus={() => {}} onMinimize={() => {}} onToggleMax={() => {}} onChange={() => {}}>
        <div>正文</div>
      </DesktopWindow>,
    );
    expect(screen.getByText('Agent · Office')).toBeInTheDocument();
    expect(screen.getByText('正文')).toBeInTheDocument();
    rerender(
      <DesktopWindow win={baseWin({ minimized: true })} active viewport={V} onFocus={() => {}} onMinimize={() => {}} onToggleMax={() => {}} onChange={() => {}}>
        <div>正文</div>
      </DesktopWindow>,
    );
    expect(screen.queryByText('正文')).not.toBeInTheDocument();
  });

  test('双击标题栏触发 onToggleMax', () => {
    const onToggleMax = vi.fn();
    render(
      <DesktopWindow win={baseWin()} active viewport={V} onFocus={() => {}} onMinimize={() => {}} onToggleMax={onToggleMax} onChange={() => {}}>
        <div>正文</div>
      </DesktopWindow>,
    );
    fireEvent.doubleClick(screen.getByText('Agent · Office'));
    expect(onToggleMax).toHaveBeenCalledTimes(1);
  });

  test('最小化按钮触发 onMinimize', () => {
    const onMinimize = vi.fn();
    render(
      <DesktopWindow win={baseWin()} active viewport={V} onFocus={() => {}} onMinimize={onMinimize} onToggleMax={() => {}} onChange={() => {}}>
        <div>正文</div>
      </DesktopWindow>,
    );
    fireEvent.click(screen.getByLabelText('最小化'));
    expect(onMinimize).toHaveBeenCalledTimes(1);
  });

  test('点击窗口触发 onFocus(置顶)', () => {
    const onFocus = vi.fn();
    render(
      <DesktopWindow win={baseWin()} active={false} viewport={V} onFocus={onFocus} onMinimize={() => {}} onToggleMax={() => {}} onChange={() => {}}>
        <div>正文</div>
      </DesktopWindow>,
    );
    fireEvent.pointerDown(screen.getByRole('region'));
    expect(onFocus).toHaveBeenCalledTimes(1);
  });
});
```

- [ ] **Step 6: 跑确认失败**

Run: `pnpm --filter @zn-ai/zai test src/web/src/components/desktop/DesktopWindow.test.tsx`

- [ ] **Step 7: 实现 DesktopWindow**

`DesktopWindow.tsx`:
```tsx
import { useCallback, useRef } from 'react';
import { clampBounds, type DesktopWindowState } from './windowMath.js';

interface DesktopWindowProps {
  win: DesktopWindowState;
  active: boolean;
  onFocus: () => void;
  onMinimize: () => void;
  onToggleMax: () => void;
  onChange: (patch: Partial<DesktopWindowState>) => void;
  viewport: { w: number; h: number };
  children: React.ReactNode;
}

export default function DesktopWindow({ win, active, onFocus, onMinimize, onToggleMax, onChange, viewport, children }: DesktopWindowProps) {
  const dragRef = useRef<{ kind: 'move' | 'resize'; startX: number; startY: number; base: { x: number; y: number; w: number; h: number } } | null>(null);
  if (win.minimized) return null;
  const b = win.maximized
    ? { x: 0, y: 0, w: viewport.w, h: viewport.h }
    : clampBounds(win, viewport, win.id);

  const startDrag = useCallback((kind: 'move' | 'resize') => (e: React.PointerEvent) => {
    e.stopPropagation();
    onFocus();
    const base = { x: win.x, y: win.y, w: win.w, h: win.h };
    dragRef.current = { kind, startX: e.clientX, startY: e.clientY, base };
    (e.target as HTMLElement).setPointerCapture(e.pointerId);
  }, [onFocus, win.x, win.y, win.w, win.h]);

  const onPointerMove = useCallback((e: React.PointerEvent) => {
    const g = dragRef.current;
    if (!g) return;
    const dx = e.clientX - g.startX;
    const dy = e.clientY - g.startY;
    if (g.kind === 'move') onChange({ x: g.base.x + dx, y: g.base.y + dy });
    else onChange({ w: g.base.w + dx, h: g.base.h + dy }); // resize:右下角
  }, [onChange]);

  const endDrag = useCallback((e: React.PointerEvent) => {
    dragRef.current = null;
    (e.target as HTMLElement).releasePointerCapture?.(e.pointerId);
  }, []);

  return (
    <section
      role="region"
      aria-label={win.title}
      data-testid={`desktop-window-${win.id}`}
      onPointerDownCapture={onFocus}
      onPointerMove={onPointerMove}
      onPointerUp={endDrag}
      style={{
        position: 'absolute', left: b.x, top: b.y, width: b.w, height: b.h,
        zIndex: win.z, display: 'flex', flexDirection: 'column',
        background: 'var(--bg-elevated, #1c1c26)', border: active ? '1px solid var(--accent-start, #ff6600)' : '1px solid var(--border-subtle, rgba(128,128,128,.3))',
        borderRadius: 10, boxShadow: '0 10px 40px rgba(0,0,0,.35)', overflow: 'hidden',
      }}
    >
      <div
        onPointerDown={startDrag('move')}
        onDoubleClick={onToggleMax}
        style={{ height: 34, flexShrink: 0, display: 'flex', alignItems: 'center', gap: 8, padding: '0 10px', cursor: 'grab', userSelect: 'none', background: 'rgba(128,128,128,.12)' }}
      >
        <span className="title-bar-dots" aria-hidden style={{ display: 'inline-flex', gap: 6 }}>
          <i style={{ width: 11, height: 11, borderRadius: '50%', background: '#ff5f57' }} />
          <i style={{ width: 11, height: 11, borderRadius: '50%', background: '#febc2e' }} />
          <i style={{ width: 11, height: 11, borderRadius: '50%', background: '#28c840' }} />
        </span>
        <span style={{ fontSize: 12, color: 'var(--text-secondary, #aaa)', flex: 1, textAlign: 'center' }}>{win.title}</span>
        <button aria-label="最小化" onClick={onMinimize} style={{ border: 0, background: 'transparent', cursor: 'pointer', color: 'var(--text-secondary, #aaa)' }}>—</button>
      </div>
      <div style={{ flex: 1, minHeight: 0, overflow: 'auto' }}>{children}</div>
      <div
        aria-hidden
        onPointerDown={startDrag('resize')}
        style={{ position: 'absolute', right: 0, bottom: 0, width: 18, height: 18, cursor: 'nwse-resize' }}
      />
    </section>
  );
}
```
> 拖拽细节:jsdom/happy-dom 不执行真实指针捕获,交互测试只管按钮/焦点;拖拽结果由 Task 6 页面级真实验收(ego-browser)覆盖。

- [ ] **Step 8: 跑过 DesktopWindow 测试**

Run: `pnpm --filter @zn-ai/zai test src/web/src/components/desktop/DesktopWindow.test.tsx`
Expected: PASS(4 cases)

- [ ] **Step 9: Commit**

```bash
git add packages/zai/src/web/src/components/desktop/windowMath.ts packages/zai/src/web/src/components/desktop/windowMath.test.ts packages/zai/src/web/src/components/desktop/DesktopWindow.tsx packages/zai/src/web/src/components/desktop/DesktopWindow.test.tsx
git commit -m "HRMSV3-ZN-WEBSITE#668 feat(zai): DesktopWindow 浮窗(拖拽/缩放/置顶/最小化/最大化)"
```

---

### Task 4: `DesktopExplorer` 资源管理器组件

**Files:**
- Create: `packages/zai/src/web/src/components/desktop/DesktopExplorer.tsx`
- Create: `packages/zai/src/web/src/components/desktop/DesktopExplorer.test.tsx`

**Interfaces:**
- Consumes: `api.get`(`~/web/src/lib/api.ts`);`shared/desktopFs.ts` 类型;`DesktopFsEntry`
- Produces:
  ```ts
  export interface ExplorerEntry { name: string; kind: 'file' | 'dir'; path: string; size: number; mtime: number }
  interface DesktopExplorerProps {
    cwd: string                      // 当前项目路径(/system 提供),书签用
    home: string                     // os.homedir(),「主目录」书签;未知时用 ''
    onOpenFile: (entry: ExplorerEntry) => void          // 双击文件→预览(Desktop 装配)
    onDragFile: (entry: ExplorerEntry) => void          // 拖拽携带数据(由 Desktop 供给 AttachmentZone 用)
    defaultPath?: string             // 首开目录,缺省服务端 home;Desktop 用 `key={dirTarget}` 重挂载实现"外部定位到目录"
  }
  ```
  MIME:``application/x-zai-file``,payload:`JSON.stringify({ path, name, kind })`。
  组件内部管理 `currentPath/entries/error/loading` 状态;路径手输 + 回车跳转;「上级」按钮(parent 为 null 禁用);Tab:`本地`/`线上`(线上空态)。**双击目录 = 窗内导航**(`go(子目录)`),不触发任何外部回调。外部快捷方式"在某目录打开资源窗"由 Desktop 以 `key={dirTarget}` + `defaultPath={dirTarget}` 重挂载本组件实现。

- [ ] **Step 1: 写失败测试**

`DesktopExplorer.test.tsx`(mock `api.get`):
```tsx
// @vitest-environment happy-dom
import { describe, expect, test, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import DesktopExplorer, { type ExplorerEntry } from './DesktopExplorer.js';
import { api } from '../../lib/api.js';
import '@testing-library/jest-dom';

vi.mock('../../lib/api.js', () => ({
  api: { get: vi.fn() },
}));

const mkList = (path: string, entries: ExplorerEntry[], parent: string | null = null) => ({
  ok: true, path, parent, entries,
});

describe('DesktopExplorer', () => {
  beforeEach(() => {
    vi.mocked(api.get).mockReset();
  });

  test('挂载后 GET /desktop/fs/list 并渲染文件网格', async () => {
    vi.mocked(api.get).mockResolvedValueOnce(
      mkList('/Users/t/sandbox', [
        { name: 'docs', kind: 'dir', path: '/Users/t/sandbox/docs', size: 0, mtime: 1 },
        { name: 'a.md', kind: 'file', path: '/Users/t/sandbox/a.md', size: 12, mtime: 2 },
      ], '/Users/t'),
    );
    render(<DesktopExplorer cwd="/Users/t/sandbox" home="/Users/t" onOpenFile={() => {}} onDragFile={() => {}} />);
    await waitFor(() => expect(screen.getByText('a.md')).toBeInTheDocument());
    expect(screen.getByText('docs')).toBeInTheDocument();
  });

  test('双击目录 → 窗内导航:再次 GET 子目录并刷新网格', async () => {
    vi.mocked(api.get)
      .mockResolvedValueOnce(mkList('/Users/t', [{ name: 'docs', kind: 'dir', path: '/Users/t/docs', size: 0, mtime: 1 }], null))
      .mockResolvedValueOnce(mkList('/Users/t/docs', [{ name: 'inner.md', kind: 'file', path: '/Users/t/docs/inner.md', size: 1, mtime: 3 }], '/Users/t'));
    render(<DesktopExplorer cwd="/Users/t/sandbox" home="/Users/t" onOpenFile={() => {}} onDragFile={() => {}} />);
    await waitFor(() => screen.getByText('docs'));
    fireEvent.doubleClick(screen.getByText('docs'));
    await waitFor(() => expect(screen.getByText('inner.md')).toBeInTheDocument());
    const secondCall = vi.mocked(api.get).mock.calls[1]?.[0] as string;
    expect(secondCall).toContain(encodeURIComponent('/Users/t/docs'));
  });

  test('双击文件触发 onOpenFile', async () => {
    const onOpenFile = vi.fn();
    vi.mocked(api.get).mockResolvedValueOnce(
      mkList('/Users/t', [{ name: 'a.md', kind: 'file', path: '/Users/t/a.md', size: 1, mtime: 1 }], null),
    );
    render(<DesktopExplorer cwd="/Users/t/sandbox" home="/Users/t" onOpenFile={onOpenFile} onDragFile={() => {}} />);
    await waitFor(() => screen.getByText('a.md'));
    fireEvent.doubleClick(screen.getByText('a.md'));
    expect(onOpenFile).toHaveBeenCalledWith(expect.objectContaining({ path: '/Users/t/a.md' }));
  });

  test('请求失败 → 窗内错误文案(ok:false)', async () => {
    vi.mocked(api.get).mockResolvedValueOnce({ ok: false, error: '无权限访问: /x' });
    render(<DesktopExplorer cwd="/Users/t/sandbox" home="/Users/t" onOpenFile={() => {}} onDragFile={() => {}} />);
    await waitFor(() => expect(screen.getByText(/无权限访问/)).toBeInTheDocument());
  });

  test('切到「线上」Tab 显示待接入空态', () => {
    vi.mocked(api.get).mockResolvedValueOnce(mkList('/Users/t', []));
    render(<DesktopExplorer cwd="/Users/t/sandbox" home="/Users/t" onOpenFile={() => {}} onDragFile={() => {}} />);
    fireEvent.click(screen.getByRole('tab', { name: '线上' }));
    expect(screen.getByText(/待接入/)).toBeInTheDocument();
  });
});
```

- [ ] **Step 2: 跑确认失败**

Run: `pnpm --filter @zn-ai/zai test src/web/src/components/desktop/DesktopExplorer.test.tsx`

- [ ] **Step 3: 实现 DesktopExplorer**

`DesktopExplorer.tsx` 关键实现(结构):
- 状态:`currentPath`(`useState<string | null>(defaultPath ?? null)`——`null` 表示"由服务端给 home"),`entries: ExplorerEntry[]`,`parent: string | null`,`error: string | null`,`loading`,`tab: 'local' | 'online'`,`selectedPath: string | null`

```tsx
import { useCallback, useEffect, useState } from 'react';
import { Input, Tabs, Alert, Empty, Spin } from 'antd';
import { ArrowUpOutlined } from '@ant-design/icons';
import { api } from '../../lib/api.js';
import type { DesktopFsList, DesktopFsEntry } from '../../../shared/desktopFs.js';
import { DirIcon, FileIcon } from '../splitPane/fileIcon.js';

export interface ExplorerEntry {
  name: string; kind: 'file' | 'dir'; path: string; size: number; mtime: number;
}
interface DesktopExplorerProps {
  cwd: string;
  home: string;
  onOpenFile: (entry: ExplorerEntry) => void;
  onDragFile: (entry: ExplorerEntry) => void;
  defaultPath?: string;
}

async function loadList(path: string | null): Promise<DesktopFsList> {
  const q = path == null ? '' : `?path=${encodeURIComponent(path)}`;
  try {
    return await api.get<DesktopFsList>(`/desktop/fs/list${q}`);
  } catch (e) {
    return { ok: false, error: (e as Error).message };
  }
}

export default function DesktopExplorer({ cwd, home, onOpenFile, onDragFile, defaultPath }: DesktopExplorerProps) {
  const [pathInput, setPathInput] = useState('');
  const [currentPath, setCurrentPath] = useState<string | null>(defaultPath ?? null);
  const [homePath, setHomePath] = useState(home || '');
  const [entries, setEntries] = useState<ExplorerEntry[]>([]);
  const [parent, setParent] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [tab, setTab] = useState<'local' | 'online'>('local');
  const [selectedPath, setSelectedPath] = useState<string | null>(null);

  const go = useCallback(async (path: string | null) => {
    setLoading(true); setError(null);
    const res = await loadList(path);
    setLoading(false);
    if (!res.ok) {
      if (res.error) setError(res.error);
      return; // 保持现有 entries
    }
    setCurrentPath(res.path ?? null);
    if (res.home) setHomePath(res.home);
    setParent(res.parent ?? null);
    setEntries((res.entries ?? []).map((e: DesktopFsEntry) => ({
      name: e.name, kind: e.kind,
      path: e.path,        // 服务端已 join 出 OS-native 完整路径,前端不再拼
      size: e.size, mtime: e.mtime,
    })));
    setSelectedPath(null);
  }, []);

  useEffect(() => { void go(currentPath ?? null); }, []); // 首挂载一次

  const openEntry = (e: ExplorerEntry) =>
    e.kind === 'dir' ? void go(e.path) : onOpenFile(e);

  const startDrag = (e: React.DragEvent, entry: ExplorerEntry) => {
    onDragFile(entry); // Desktop 装配层可同步/或仅在 drop 时读 dataTransfer
    e.dataTransfer.setData('application/x-zai-file', JSON.stringify({ path: entry.path, name: entry.name, kind: entry.kind }));
    e.dataTransfer.effectAllowed = 'copy';
  };

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%' }}>
      <Tabs size="small" activeKey={tab} onChange={(k) => setTab(k as 'local' | 'online')} items={[
        { key: 'local', label: '本地' },
        { key: 'online', label: '线上' },
      ]} />
      {tab === 'online' ? (
        <Empty description="线上资源 · 待接入" style={{ marginTop: 64 }} />
      ) : (
        <>
          <div style={{ display: 'flex', alignItems: 'center', gap: 6, padding: '0 8px 6px' }}>
            <Input size="small" value={pathInput} placeholder={currentPath ?? homePath}
              onChange={(e) => setPathInput(e.target.value)}
              onPressEnter={() => void go(pathInput.trim() || null)} style={{ flex: 1 }} />
            <button aria-label="上级" title="上级目录" onClick={() => parent && void go(parent)}
              disabled={!parent} style={{ border: 0, background: 'transparent', cursor: parent ? 'pointer' : 'not-allowed' }}>
              <ArrowUpOutlined />
            </button>
          </div>
          <div style={{ display: 'flex', gap: 8, padding: '0 8px 6px', fontSize: 12 }}>
            <button aria-label="书签-主目录" onClick={() => void go(homePath)} style={{ border: 0, background: 'transparent', cursor: 'pointer' }}>主目录</button>
            {cwd && <button aria-label="书签-当前项目" onClick={() => void go(cwd)} style={{ border: 0, background: 'transparent', cursor: 'pointer' }}>当前项目</button>}
          </div>
          {error ? (
            <Alert type="error" message={error} showIcon style={{ margin: 8 }} />
          ) : loading ? (
            <div style={{ display: 'flex', justifyContent: 'center', padding: 40 }}><Spin size="small" /></div>
          ) : (
            <div style={{ flex: 1, overflow: 'auto', display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(88px, 1fr))', gap: 8, padding: 8, alignContent: 'start' }}>
              {entries.map((e) => (
                <div key={e.path}
                  onClick={() => setSelectedPath(e.path)}
                  onDoubleClick={() => openEntry(e)}
                  draggable={e.kind === 'file'}
                  onDragStart={(ev) => startDrag(ev, e)}
                  data-testid={`entry-${e.name}`}
                  style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 4, padding: 8, borderRadius: 8, cursor: 'pointer', background: selectedPath === e.path ? 'rgba(255,102,0,.12)' : 'transparent' }}>
                  {e.kind === 'dir' ? <DirIcon name={e.name} open={false} /> : <FileIcon name={e.name} />}
                  <span style={{ fontSize: 11, textAlign: 'center', wordBreak: 'break-all', maxWidth: '100%' }} title={e.name}>{e.name}</span>
                </div>
              ))}
              {entries.length === 0 && <Empty description="空目录" image={Empty.PRESENTED_IMAGE_SIMPLE} />}
            </div>
          )}
        </>
      )}
    </div>
  );
}
```
> 说明:`onDragFile` 由 Desktop 装配层传入(拖起时用于警示/统计,真正数据在 `dataTransfer`);双击目录在窗内导航。外部快捷方式"定位到某目录"由 Desktop 以 `key={dirTarget}` + `defaultPath={dirTarget}` 重挂载本组件实现。

- [ ] **Step 4: 跑过测试**

Run: `pnpm --filter @zn-ai/zai test src/web/src/components/desktop/DesktopExplorer.test.tsx`
Expected: PASS(5 cases)
> 若 `DirIcon/FileIcon` 在 happy-dom 因 SVG 出问题,fallback:测试里 `vi.mock('../splitPane/fileIcon.js', () => ({ DirIcon: () => <span>dir</span>, FileIcon: () => <span>file</span> }))` 保持用例聚焦于数据流。

- [ ] **Step 5: Commit**

```bash
git add packages/zai/src/web/src/components/desktop/DesktopExplorer.tsx packages/zai/src/web/src/components/desktop/DesktopExplorer.test.tsx
git commit -m "HRMSV3-ZN-WEBSITE#668 feat(zai): DesktopExplorer 资源管理器(任意路径浏览+线上Tab空态)"
```

---

### Task 5: `AttachmentZone` 附件区

**Files:**
- Create: `packages/zai/src/web/src/components/desktop/AttachmentZone.tsx`
- Create: `packages/zai/src/web/src/components/desktop/AttachmentZone.test.tsx`

**Interfaces:**
- Consumes: `FileRef`(`./gatherMentions.ts`);`MentionChip`(`../MentionChip.js`,现有组件)
- Produces:
  ```ts
  interface AttachmentZoneProps {
    refs: FileRef[]
    onAddRef: (ref: FileRef) => void
    onRemoveRef: (id: string) => void
    max?: number            // 默认 16
  }
  export const DND_MIME = 'application/x-zai-file'
  export function parseRefPayload(raw: string): FileRef | null   // JSON 解析 + 字段校验
  ```
- 说明:区自带 drag 高亮;拖入容量满时 toast(antd `message`);非本 MIME drop 忽略(preventDefault);chip 用 `MentionChip`(data `{path, label: name}`)溢出省略,尾部 X 按钮移除。

- [ ] **Step 1: 写失败测试**

`AttachmentZone.test.tsx`:
```tsx
// @vitest-environment happy-dom
import { describe, expect, test, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import AttachmentZone, { DND_MIME, parseRefPayload } from './AttachmentZone.js';
import type { FileRef } from './gatherMentions.js';
import '@testing-library/jest-dom';

const ref = (path: string): FileRef => ({ id: `r-${path}`, path, name: path.split('/').pop()!, kind: 'file' });
const fakeDrag = (payload: string, mime = DND_MIME) =>
  ({ preventDefault: vi.fn(), stopPropagation: vi.fn(), dataTransfer: { getData: (t: string) => (t === mime ? payload : '') } }) as unknown as React.DragEvent;

describe('AttachmentZone', () => {
  test('drop 携带 application/x-zai-file → onAddRef 收到解析后的 FileRef', () => {
    const onAddRef = vi.fn();
    render(<AttachmentZone refs={[]} onAddRef={onAddRef} onRemoveRef={() => {}} />);
    const zone = screen.getByTestId('attachment-zone');
    fireEvent.dragOver(zone, { dataTransfer: { types: [DND_MIME] } });
    fireEvent.drop(zone, fakeDrag(JSON.stringify({ path: '/a/b.md', name: 'b.md', kind: 'file' })));
    expect(onAddRef).toHaveBeenCalledWith({ id: 'r-/a/b.md', path: '/a/b.md', name: 'b.md', kind: 'file' });
  });

  test('最大 16:已有 16 个时 drop 不触发 onAddRef', () => {
    const refs = Array.from({ length: 16 }, (_, i) => ref(`/f${i}.md`));
    const onAddRef = vi.fn();
    render(<AttachmentZone refs={refs} onAddRef={onAddRef} onRemoveRef={() => {}} />);
    fireEvent.drop(screen.getByTestId('attachment-zone'), fakeDrag(JSON.stringify({ path: '/new.md', name: 'new.md', kind: 'file' })));
    expect(onAddRef).not.toHaveBeenCalled();
  });

  test('渲染既有 refs 为 chip,点 X 触发 onRemoveRef', () => {
    const onRemoveRef = vi.fn();
    render(<AttachmentZone refs={[ref('/a/b.md')]} onAddRef={() => {}} onRemoveRef={onRemoveRef} />);
    expect(screen.getByText('b.md')).toBeInTheDocument();
    fireEvent.click(screen.getByLabelText('移除附件'));
    expect(onRemoveRef).toHaveBeenCalledWith('r-/a/b.md');
  });

  test('parseRefPayload 校验缺字段 → null', () => {
    expect(parseRefPayload(JSON.stringify({ path: '/x' }))).toBeNull();
    expect(parseRefPayload('not-json')).toBeNull();
  });
});
```

- [ ] **Step 2: 跑确认失败**

Run: `pnpm --filter @zn-ai/zai test src/web/src/components/desktop/AttachmentZone.test.tsx`

- [ ] **Step 3: 实现**

`AttachmentZone.tsx`:
```tsx
import { useCallback, useState } from 'react';
import { Button, message } from 'antd';
import { CloseOutlined, PaperClipOutlined } from '@ant-design/icons';
import MentionChip from '../MentionChip.js';
import type { FileRef } from './gatherMentions.js';

export const DND_MIME = 'application/x-zai-file';
const DEFAULT_MAX = 16;

export function parseRefPayload(raw: string): FileRef | null {
  try {
    const o = JSON.parse(raw) as Partial<FileRef>;
    if (typeof o.path !== 'string' || typeof o.name !== 'string' || !o.path || !o.name) return null;
    const kind = o.kind === 'dir' ? 'dir' : 'file';
    return { id: `r-${o.path}`, path: o.path, name: o.name, kind };
  } catch {
    return null;
  }
}

interface AttachmentZoneProps {
  refs: FileRef[];
  onAddRef: (ref: FileRef) => void;
  onRemoveRef: (id: string) => void;
  max?: number;
}

export default function AttachmentZone({ refs, onAddRef, onRemoveRef, max = DEFAULT_MAX }: AttachmentZoneProps) {
  const [hover, setHover] = useState(false);

  const onDrop = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setHover(false);
    if (e.dataTransfer.types?.includes(DND_MIME) !== true) return; // 非资源窗拖出,忽略
    if (refs.length >= max) {
      void message.warning(`附件最多 ${max} 个,请先移除`);
      return;
    }
    const parsed = parseRefPayload(e.dataTransfer.getData(DND_MIME));
    if (parsed) onAddRef(parsed);
  }, [refs.length, max, onAddRef]);

  return (
    <div
      data-testid="attachment-zone"
      onDragOver={(e) => { if (e.dataTransfer.types?.includes(DND_MIME)) { e.preventDefault(); setHover(true); } }}
      onDragLeave={() => setHover(false)}
      onDrop={onDrop}
      style={{
        display: refs.length ? 'flex' : 'none',
        flexWrap: 'wrap', alignItems: 'center', gap: 6, padding: '4px 10px',
        borderBottom: '1px solid var(--border-subtle, rgba(128,128,128,.25))',
        background: hover ? 'rgba(255,102,0,.08)' : 'transparent',
      }}
    >
      <PaperClipOutlined style={{ color: 'var(--text-dim-45, #888)', fontSize: 12 }} />
      {refs.map((r) => (
        <span key={r.id} style={{ display: 'inline-flex', alignItems: 'center', gap: 2 }}>
          <MentionChip data={{ path: r.path, label: r.name }} />
          <Button size="small" type="text" aria-label="移除附件" icon={<CloseOutlined />}
            onClick={() => onRemoveRef(r.id)} style={{ width: 18, height: 18, minWidth: 18, padding: 0, fontSize: 10 }} />
        </span>
      ))}
    </div>
  );
}
```
> `MentionChip` 是纯展示;`label` 用了 `name` 而非路径。空态区不渲染(`display:none`),窗口高度不被占。

- [ ] **Step 4: 跑过测试**

Run: `pnpm --filter @zn-ai/zai test src/web/src/components/desktop/AttachmentZone.test.tsx`
Expected: PASS(4 cases)

- [ ] **Step 5: Commit**

```bash
git add packages/zai/src/web/src/components/desktop/AttachmentZone.tsx packages/zai/src/web/src/components/desktop/AttachmentZone.test.tsx
git commit -m "HRMSV3-ZN-WEBSITE#668 feat(zai): AttachmentZone 附件区(拖放文件引用 chip,上限16)"
```

---

### Task 6: `Desktop` 页面装配(路由/菜单/壳/Office 作用域)

**Files:**
- Create: `packages/zai/src/web/src/components/desktop/desktopStore.ts`
- Create: `packages/zai/src/web/src/pages/Desktop.tsx`
- Create: `packages/zai/src/web/src/pages/Desktop.test.tsx`
- Modify: `packages/zai/src/web/src/router.tsx`
- Modify: `packages/zai/src/web/src/components/Layout.tsx`

**Interfaces:**
- Consumes: `api.get/post/put`;`useLocalStorageState`(`~/web/src/components/splitPane/shared.ts`);`windowMath`(`initWindows/toggleMaximized/DesktopWindowState`);`DesktopWindow`;`DesktopExplorer`;`AttachmentZone`;`gatherMentions`(`FileRef`);`AgentConversation`(`~/web/src/pages/AgentConversation`);`useAppStore`(`setWorkMode`/`isMobile`/`instanceContext`);`SettingsDrawer`
- Produces:
  - `desktopStore.ts`:
    ```ts
    export interface DesktopShortcut { id: string; name: string; path: string; kind: 'file' | 'dir' }
    export const LS_KEYS = { windows: 'zai.desktop.windows', shortcuts: 'zai.desktop.shortcuts', wallpaper: 'zai.desktop.wallpaper', settingsSnapshot: 'zai.desktop.settings.snapshot' } as const
    export function validRefFromPath(name: string, path: string, kind: 'file' | 'dir'): FileRef  // id 稳定、供快捷方式/附件复用
    ```
  - `Desktop.tsx` 组装:顶栏(时钟/主题切换/壁纸设置/退出桌面)、壁纸层(`useLocalStorageState` 存预设 key 或 dataURL)、Dock(图标+激活态)、窗口数组(状态管理 + zIndex 递增)、快捷方式网格(拖壁纸空白建)、预览浮窗(图片/文本,`/desktop/fs/file`)、Office 作用域 effect
- 路由:`/desktop` 顶层 Route(不进 Layout);Layout 菜单项加“桌面”(`DesktopOutlined`)

- [ ] **Step 1: 写失败测试(Office 作用域 + 移动端重定向)**

`Desktop.test.tsx`:
```tsx
// @vitest-environment happy-dom
import { describe, expect, test, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, act } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import Desktop from './Desktop.js';
import { useAppStore } from '../store/useAppStore.js';
import { LS_KEYS } from '../components/desktop/desktopStore.js';

vi.mock('../components/SettingsDrawer.js', () => ({ default: () => null })); // 设置抽屉副作用多,测试不管

// Desktop 内部会 fetch /api/agent/settings + PUT work-mode/main-agent + GET /desktop/fs/list
const fetchMock = vi.fn();
const settings = () => JSON.stringify({ workMode: 'code', mainAgent: 'default', mainAgents: [{ name: 'default' }, { name: 'office' }] });

const renderDesktop = () => render(<MemoryRouter><Desktop /></MemoryRouter>);

beforeEach(() => {
  localStorage.clear();
  fetchMock.mockReset();
  fetchMock.mockImplementation(async (url: string) => {
    if (url.includes('/agent/settings')) {
      return new Response(settings(), { status: 200, headers: { 'Content-Type': 'application/json' } });
    }
    if (url.includes('/desktop/fs/list')) {
      return new Response(JSON.stringify({ ok: true, path: '/Users/t', home: '/Users/t', parent: null, entries: [] }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    }
    return new Response(JSON.stringify({ ok: true }), { status: 200, headers: { 'Content-Type': 'application/json' } });
  });
  vi.stubGlobal('fetch', fetchMock);
});
afterEach(() => vi.unstubAllGlobals());

describe('Desktop', () => {
  test('挂载:snapshot 磁盘设置 → PUT work-mode=office + main-agent=office', async () => {
    renderDesktop();
    await act(async () => { await new Promise((r) => setTimeout(r, 0)); });
    const puts = fetchMock.mock.calls.filter(([u]) => String(u).includes('/agent/settings'));
    expect(puts.length).toBeGreaterThanOrEqual(2); // work-mode + main-agent 各一
    expect(JSON.stringify(puts)).toContain('office');
    // snapshot 已记录原值
    const snap = JSON.parse(localStorage.getItem(LS_KEYS.settingsSnapshot) ?? '{}');
    expect(snap.workMode).toBe('code');
    expect(snap.mainAgent).toBe('default');
  });

  test('卸载:读 snapshot 还原 workMode/mainAgent 并清 snapshot', async () => {
    const { unmount } = renderDesktop();
    await act(async () => { await new Promise((r) => setTimeout(r, 0)); });
    fetchMock.mockClear();
    unmount();
    expect(fetchMock.mock.calls.filter(([u]) => String(u).includes('/agent/settings')).length).toBeGreaterThanOrEqual(2);
    expect(localStorage.getItem(LS_KEYS.settingsSnapshot)).toBeNull();
  });

  test('store.setWorkMode 被同步为 office', async () => {
    renderDesktop();
    await act(async () => { await new Promise((r) => setTimeout(r, 0)); });
    expect(useAppStore.getState().workMode).toBe('office');
  });

  test('已 office 时挂载不再重复 PUT(幂等)', async () => {
    fetchMock.mockImplementation(async (url: string) => {
      if (url.includes('/agent/settings')) return new Response(JSON.stringify({ workMode: 'office', mainAgent: 'office', mainAgents: [{ name: 'office' }] }), { status: 200, headers: { 'Content-Type': 'application/json' } });
      return new Response(JSON.stringify({ ok: true }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    });
    renderDesktop();
    await act(async () => { await new Promise((r) => setTimeout(r, 0)); });
    const puts = fetchMock.mock.calls.filter(([u]) => String(u).includes('/agent/settings') && String(u).includes('work-mode'));
    expect(puts.length).toBe(0);
  });
});
```
> 移动端重定向断言移动端场景需要 mock `useIsMobile`(Desktop 读 `useAppStore.isMobile`):若 `useAppStore.isMobile` 默认 false,此用例可作为 store 状态写 `useAppStore.setState({ isMobile: true })` 后在 `MemoryRouter` 里断言 navigate 到 `/agent`——实现时若 navigation 成本高,可接受将该用例降级为 ego-browser 手动核验,写上并保留代码。

- [ ] **Step 2: 跑确认失败**

Run: `pnpm --filter @zn-ai/zai test src/web/src/pages/Desktop.test.tsx`
Expected: FAIL(模块不存在)

- [ ] **Step 3: 实现 desktopStore**

`desktopStore.ts`:
```ts
import type { FileRef } from './gatherMentions.js';

export interface DesktopShortcut { id: string; name: string; path: string; kind: 'file' | 'dir' }

export const LS_KEYS = {
  windows: 'zai.desktop.windows',
  shortcuts: 'zai.desktop.shortcuts',
  wallpaper: 'zai.desktop.wallpaper',
  settingsSnapshot: 'zai.desktop.settings.snapshot',
} as const;

/** 从路径生成稳定 id(附件/快捷方式复用),key 用路径而非名(同名不同目录可区分) */
export function validRefFromPath(name: string, path: string, kind: 'file' | 'dir'): FileRef {
  return { id: `r-${path}`, path, name, kind };
}
```

- [ ] **Step 4: 实现 Desktop 页面(骨架核心)**

`Desktop.tsx` 要点(完整实现由实现者按此展开,骨架代码给关键段):

```tsx
// import 按实际使用补齐(tsc noUnusedLocals 开启,未用 import 会导致失败)。
import { useEffect, useMemo, useState } from 'react';
import { Input, message } from 'antd';
import { ArrowLeftOutlined, DesktopOutlined, SettingOutlined, SunOutlined, MoonOutlined } from '@ant-design/icons';
import { useNavigate } from 'react-router-dom';
import AgentConversation from './AgentConversation.js';
import SettingsDrawer from '../components/SettingsDrawer.js';
import { useAppStore } from '../store/useAppStore.js';
import { useLocalStorageState } from '../components/splitPane/shared.js';
import { api } from '../lib/api.js';
import { AGENT_INPUT_INSERT_EVENT } from '../lib/agentInputEvents.js';
import { initWindows, toggleMaximized, type DesktopWindowState } from '../components/desktop/windowMath.js';
import DesktopWindow from '../components/desktop/DesktopWindow.js';
import DesktopExplorer, { type ExplorerEntry } from '../components/desktop/DesktopExplorer.js';
import AttachmentZone from '../components/desktop/AttachmentZone.js';
import { gatherMentions, type FileRef } from '../components/desktop/gatherMentions.js';
import { LS_KEYS, type DesktopShortcut } from '../components/desktop/desktopStore.js';

const PRESET_WALLPAPERS = ['preset:aurora', 'preset:ocean', 'preset:sunset'] as const;

export default function Desktop() {
  const navigate = useNavigate();
  const isMobile = useAppStore((s) => s.isMobile);
  const setWorkMode = useAppStore((s) => s.setWorkMode);
  const instanceContext = useAppStore((s) => s.instanceContext);

  // 视口(ResizeObserver 或 window resize)
  const [vp, setVp] = useState(() => ({ w: window.innerWidth, h: window.innerHeight }));
  useEffect(() => {
    const onR = () => setVp({ w: window.innerWidth, h: window.innerHeight });
    window.addEventListener('resize', onR);
    return () => window.removeEventListener('resize', onR);
  }, []);

  // 窗口状态(localStorage 持久化;损坏回退 initWindows)
  const [windows, setWindows] = useLocalStorageState<DesktopWindowState[]>(LS_KEYS.windows, initWindows(vp));
  const activeId = useMemo(() => [...windows].sort((a, b) => b.z - a.z)[0]?.id ?? 'agent', [windows]);

  // 附件区
  const [refs, setRefs] = useState<FileRef[]>([]);
  // 快捷方式
  const [shortcuts, setShortcuts] = useLocalStorageState<DesktopShortcut[]>(LS_KEYS.shortcuts, []);
  const [wallpaper, setWallpaper] = useLocalStorageState<string>(LS_KEYS.wallpaper, 'preset:aurora');

  // ---------- 窗口操作 ----------
  const patchWindow = (id: string, patch: Partial<DesktopWindowState>) =>
    setWindows((ws) => ws.map((w) => (w.id === id ? { ...w, ...patch } : w)));
  const focusWindow = (id: string) => {
    const maxZ = Math.max(0, ...windows.map((w) => w.z)) + 1;
    setWindows((ws) => ws.map((w) => (w.id === id ? { ...w, z: maxZ } : w)));
  };
  const minimize = (id: string) => patchWindow(id, { minimized: !windows.find((w) => w.id === id)?.minimized });
  const toggleMax = (id: string) => setWindows((ws) => ws.map((w) => (w.id === id ? toggleMaximized(w, vp) : w)));

  // ---------- Office 作用域(进出桌面) ----------
  useEffect(() => {
    let cancelled = false;
    (async () => {
      const cur = await api.get<{ workMode?: string; mainAgent?: string }>('/agent/settings').catch(() => null);
      if (cancelled) return;
      const workMode = cur?.workMode ?? 'code';
      const mainAgent = cur?.mainAgent ?? 'default';
      // 幂等:已 office 则只记快照不 PUT
      if (workMode !== 'office') {
        await api.put('/agent/settings/work-mode', { workMode: 'office' }).catch(() => {});
      }
      if (mainAgent !== 'office') {
        await api.put('/agent/settings/main-agent', { mainAgent: 'office' }).catch(() => {});
      }
      if (!cancelled) {
        setWorkMode('office');
        localStorage.setItem(LS_KEYS.settingsSnapshot, JSON.stringify({ workMode, mainAgent }));
      }
    })();
    return () => {
      cancelled = true;
      restoreSettings().catch(() => {});
    };
  }, [setWorkMode]);

  async function restoreSettings() {
    const raw = localStorage.getItem(LS_KEYS.settingsSnapshot);
    if (!raw) return;
    const snap = JSON.parse(raw) as { workMode?: string; mainAgent?: string };
    localStorage.removeItem(LS_KEYS.settingsSnapshot);
    if (snap.workMode && snap.workMode !== 'office') {
      await api.put('/agent/settings/work-mode', { workMode: snap.workMode }).catch(() => {});
    }
    if (snap.mainAgent && snap.mainAgent !== 'office') {
      await api.put('/agent/settings/main-agent', { mainAgent: snap.mainAgent }).catch(() => {});
    }
    if (snap.workMode === 'code' || snap.workMode === 'office' || snap.workMode === 'general') {
      setWorkMode(snap.workMode);
    }
  }

  // ---------- 移动端重定向 ----------
  useEffect(() => {
    if (isMobile) navigate('/agent', { replace: true });
  }, [isMobile, navigate]);

  // ---------- 发送(附件 → @mention 并入 prompt) ----------
  // 复用 AGENT_INPUT_INSERT_EVENT('agent-input-insert', detail {text, kind}):
  // FsContextMenu 已有先例——dispatch CustomEvent,AgentInputBox 监听后把 text
  // 插到光标处并按 kind 渲染 @chip。附件区右侧放「并入输入框」按钮:
  const insertMentions = () => {
    if (refs.length === 0) return;
    // draft 为空即不查重:Desktop 读不到 AgentInputBox 的私有 draft,靠
    // gatherMentions 内部按"附件间重复"去重即可;用户可自行删掉多余引用。
    const text = gatherMentions(refs, '');
    if (!text) { void message.info('附件已并入,无需重复'); return; }
    window.dispatchEvent(new CustomEvent(AGENT_INPUT_INSERT_EVENT, {
      detail: { text: text.trim(), kind: 'file' },
    }));
    void message.success('文件引用已并入输入框,回车发送');
  };

  // 预览浮窗(图片/文本,非 DesktopWindow 槽位):state preview: { name, path } | null
  // 打开:api.get<DesktopFsFile>(`/desktop/fs/file?path=...`) → { mime, dataUrl }
  // image → <img src={dataUrl}>;text → <pre>{dataUrl(解码)}</pre>;ok:false → message.error
  // 双击文件回调 onOpenFile={setPreview};

  // 快捷方式右键菜单:state ctx: { path, x, y } | null;菜单项「移除」(从 shortcuts 过滤)
  // 「在资源管理器定位」(setExplorerTarget(path),explorer 以 key={explorerTarget} 重挂载)

  // ---------- JSX 装配(顺序:壁纸层 → 图标区 → 窗口区 → 顶栏 → Dock) ----------
  // 壁纸层:position absolute inset 0,背景 = wallpaper.startsWith('preset:')
  //   ? 预设渐变(aurora=linear-gradient(135deg,#1a1a2e,#16213e,#0f3460);
  //     ocean=linear-gradient(160deg,#0f2027,#203a43,#2c5364);
  //     sunset=linear-gradient(135deg,#ff7e5f,#feb47b,#ff9966))
  //   : `center/cover url(${wallpaper})`;上传:input[type=file] accept=image/*
  //   → FileReader.readAsDataURL → setWallpaper(dataUrl),非图片 message.error
  // 图标区:absolute 各窗与壁纸之间,flex wrap 网格(72px 图标 + 12px 名);
  //   onDragOver/preventDefault + onDrop(取 DND_MIME payload → setShortcuts 去重追加)
  // 顶栏:absolute top 0 height 32 半透明底;左:退出桌面(ArrowLeft→navigate('/agent'))+
  //   时钟(偶数秒冲刷 HH:MM);右:主题 Switch(同 Layout handleToggleTheme) + 壁纸设置 +
  //   设置齿轮(openSettingsDrawer;页面内挂 <SettingsDrawer/>)
  // Dock:absolute bottom 12 居中 flex gap 10;4 项:Agent / 资源管理器 / 壁纸设置 /
  //   退出桌面;active 窗口对应项显示橙色小圆点;hover scale(1.15,120ms);
  //   click:minimized→还原并置顶,否则 focusWindow(壁纸设置→旁置 Popover 换壁纸)
  // Agent 窗内容:<div style={{display:'flex',flexDirection:'column',height:'100%'}}>
  //   <AttachmentZone refs={refs} onAddRef={...} onRemoveRef={...}/>
  //   <div style={{flex:1,minHeight:0}}><AgentConversation/></div></div>
  //   附件区「并入输入框」按钮放 AttachmentZone 右侧(或 Dock 上缘浮动按钮)
}
```

- [ ] **Step 5: 路由 + 菜单**

`router.tsx` 顶层(在 `<Routes>` 内、`Layout` Route 之外):
```tsx
<Route path="/desktop" element={<Desktop />} />
```
`Layout.tsx` `ALL_MENU_ITEMS` 数组头部插入:
```tsx
{ key: '/desktop', icon: <DesktopOutlined />, label: '桌面' },
```
并补 `DesktopOutlined` 到 `@ant-design/icons` import。

- [ ] **Step 6: 跑测试**

Run: `pnpm --filter @zn-ai/zai test src/web/src/pages/Desktop.test.tsx`
Expected: PASS(4 cases)
若步骤 4 实现了(按钮/事件注入)但测试超参数失败,修测试断言与实现对齐;测试聚焦在 Office 作用域与幂等,不测视觉。

- [ ] **Step 7: 类型检查**

Run: `pnpm --filter @zn-ai/zai exec tsc --noEmit`
Expected: 无新错误

- [ ] **Step 8: Commit**

```bash
git add packages/zai/src/web/src/components/desktop/desktopStore.ts packages/zai/src/web/src/pages/Desktop.tsx packages/zai/src/web/src/pages/Desktop.test.tsx packages/zai/src/web/src/router.tsx packages/zai/src/web/src/components/Layout.tsx
git commit -m "HRMSV3-ZN-WEBSITE#668 feat(zai): /desktop 办公桌面页(壁纸/顶栏/Dock/浮窗/快捷方式/Office作用域)"
```

---

### Task 7: 系统能力打开非预览文件(服务端 open 端点 + 前端双击分流)

> **用户新增需求(2026-08-26)**:本地资源区文件双击 —— **支持预览的类型**(文本/图片,服务端白名单)走预览浮窗;**其余类型调用系统默认应用打开**(macOS `open -- <path>` / Windows `start "" "<path>"` / Linux `xdg-open`)。「支持预览」以服务端白名单为唯一真相源:list 接口在每条 entry 上带 `preview` 标记,前端**零重复白名单、零探测请求**,也不会触发 `apiBase.request` 对非 2xx 的全局错误通知(`notifyApiError` 会为每个 400 弹 antd notification——不能用"先 GET 探测再回退"的写法)。

**Files:**
- Modify: `packages/zai/src/shared/desktopFs.ts`(`DesktopFsEntry` 加 `preview?: boolean`;新增 `DesktopOpen`)
- Create: `packages/zai/src/server/utils/openFile.ts`(`openWithSystem`,平台分发,`platform` 可注入便于单测)
- Create: `packages/zai/src/server/utils/openFile.test.ts`(mock `node:child_process`,4 用例)
- Modify: `packages/zai/src/server/routes/desktopFs.ts`(list entry 加 `preview`;新增 `POST /desktop/open`)
- Modify: `packages/zai/src/server/routes/desktopFs.test.ts`(fixture 加 x.zip + preview 断言;open 路由 6 用例,`vi.mock` openFile)
- Modify: `packages/zai/src/web/src/components/desktop/DesktopExplorer.tsx`(`ExplorerEntry` 透传 `preview?: boolean`)
- Modify: `packages/zai/src/web/src/pages/Desktop.tsx`(`openPreview` 分流:preview → 浮窗;否则 `systemOpen`;预览浮窗补 `data-testid="desktop-preview"`)
- Modify: `packages/zai/src/web/src/pages/Desktop.test.tsx`(新增 2 用例:不可预览 → POST open;可预览 → 浮窗出现)

**Interfaces:**
- shared:
  - `DesktopFsEntry` 增加 `preview?: boolean`(缺省 undefined = 不可预览)
  - 新增 `export interface DesktopOpen { ok: boolean; error?: string }`
- `utils/openFile.ts`:
  ```ts
  import { spawn } from 'node:child_process';

  /**
   * 调系统默认应用打开本地文件。spawn 不用 shell —— 路径原样作参数, 无注入面;
   * stdio:'ignore' 不污染服务端日志;不等待子进程退出('spawn' 后 unref 算成功,
   * 'error' 事件 reject)。platform 可注入以便单测各平台分支。
   */
  export async function openWithSystem(
    target: string,
    platform: NodeJS.Platform = process.platform,
  ): Promise<void> {
    let child: ReturnType<typeof spawn>;
    if (platform === 'darwin') {
      child = spawn('open', ['--', target], { stdio: 'ignore' });       // `--` 防路径以 - 开头被当选项
    } else if (platform === 'win32') {
      child = spawn('cmd', ['/c', 'start', '', target], { stdio: 'ignore' }); // 空格 title + 路径
    } else if (platform === 'linux') {
      child = spawn('xdg-open', [target], { stdio: 'ignore' });
    } else {
      throw new Error(`平台 ${platform} 暂不支持系统打开`);
    }
    await new Promise<void>((resolve, reject) => {
      child.once('error', (err: Error) => reject(new Error(`系统打开失败: ${err.message}`)));
      child.once('spawn', () => {
        child.unref();
        resolve();
      });
    });
  }
  ```
- `routes/desktopFs.ts`:
  - list:`entries.push({ name: d.name, kind: ..., path: child, size: s.size, mtime: s.mtimeMs, preview: toMime(d.name) !== undefined });`
  - 新增路由(复用现有 `normalizePath` / `errBody` / `stat` 错误映射):
    ```ts
    router.post('/desktop/open', async (req, res) => {
      const raw = typeof req.body?.path === 'string' ? req.body.path : '';
      if (!raw) return res.status(400).json(errBody('path 必须为字符串') as DesktopOpen);
      let target: string;
      try {
        target = normalizePath(raw);
      } catch (e) {
        const status = (e as { status?: number }).status ?? 500;
        return res.status(status).json(errBody((e as Error).message) as DesktopOpen);
      }
      try {
        const st = await stat(target);
        if (!st.isFile()) return res.status(400).json(errBody('不是文件') as DesktopOpen);
        await openWithSystem(target);
        return res.json({ ok: true } as DesktopOpen);
      } catch (e) {
        const code = (e as NodeJS.ErrnoException).code;
        if (code === 'ENOENT') return res.status(404).json(errBody('文件不存在') as DesktopOpen);
        if (code === 'EACCES' || code === 'EPERM') return res.status(403).json(errBody('无权限访问') as DesktopOpen);
        return res.status(500).json(errBody(`系统打开失败: ${(e as Error).message}`) as DesktopOpen);
      }
    });
    ```
  - 注:`req.body` 需要 express JSON 解析(确认 `server/index.ts` 已有 `app.use(express.json())`;若无,补在 open 路由同层)。
- 前端 `Desktop.tsx`:
  ```tsx
  const systemOpen = useCallback((entry: ExplorerEntry) => {
    api
      .post<DesktopOpen>('/desktop/open', { path: entry.path })
      .then((o) => {
        if (o.ok) void message.success(`已用系统默认应用打开: ${entry.name}`);
        else void message.error(o.error ?? '系统打开失败');
      })
      .catch((e: unknown) => void message.error(e instanceof Error ? e.message : '系统打开失败'));
  }, []);

  const openPreview = useCallback((entry: ExplorerEntry) => {
    if (entry.kind === 'dir') return;
    if (entry.preview) {
      setPreview({ name: entry.name, path: entry.path });
      return;
    }
    systemOpen(entry);
  }, [systemOpen]);
  ```

- [ ] **Step 1: 写 shared 类型 + openFile 失败测试**

`openFile.test.ts`:
```ts
// @vitest-environment node
import { describe, expect, test, vi, beforeEach } from 'vitest';

const spawnMock = vi.fn();
vi.mock('node:child_process', () => ({ spawn: spawnMock }));

import { openWithSystem } from './openFile.js';

type Cb = (err?: Error) => void;
function makeChild() {
  const once = vi.fn((ev: string, cb: Cb) => { once.listeners[ev] = cb; once.listeners[ev]!; return child; });
  ...
}
```
> 注意:makeChild 是 mock 脚手架,darwin/win32/linux 三用例各自 `spawnMock.mockReturnValueOnce(child)` 后 `listeners.spawn!()` 放行 resolve;error 用例 `listeners.error!(new Error('ENOENT'))` 断言 reject。**具体把 `spawn` 触发方式写清楚:mock 返回对象带 `once(ev, cb)` 记录回调、`unref(): void`;测试拿到记录后手动触发 `spawn`/`error`。**

- [ ] **Step 2: 跑确认失败(模块不存在)**

Run: `pnpm --filter @zn-ai/zai test src/server/utils/openFile.test.ts`

- [ ] **Step 3: 实现 openFile**

按上面 Interfaces 的完整代码。

- [ ] **Step 4: 跑过 openFile 测试(4/4)**

- [ ] **Step 5: 写 desktopFs open 路由失败测试 + list preview 断言**

`desktopFs.test.ts` 顶部加:
```ts
vi.mock('../utils/openFile.js', () => ({ openWithSystem: vi.fn() }));
import { openWithSystem } from '../utils/openFile.js';
```
- `beforeAll` fixture 增加 `writeFileSync(join(root, 'x.zip'), 'PK\x03\x04');`(原「file: 非白名单类型 → 400」用例内同路径写入保留,不冲突)
- 排序用例期望改为 `['folder', 'a.md', 'b.png', 'x.zip']`,并补:
  ```ts
  const byName = Object.fromEntries(entries.map((e) => [e.name, e]));
  expect(byName['a.md']!.preview).toBe(true);
  expect(byName['b.png']!.preview).toBe(true);
  expect(byName['x.zip']!.preview).toBe(false);
  ```
- 新增 open 用例(6):
  ```ts
  test('open: 文本文件 → openWithSystem 收到绝对路径, 200 ok:true', async () => {
    vi.mocked(openWithSystem).mockResolvedValueOnce(undefined);
    const res = await request(makeApp()).post('/api/desktop/open').send({ path: join(root, 'a.md') });
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(vi.mocked(openWithSystem)).toHaveBeenCalledWith(join(root, 'a.md'));
  });
  test('open: ENOENT → 404', ...);            // send({ path: join(root, 'no.txt') })
  test('open: 目录 → 400', ...);               // send({ path: join(root, 'folder') })
  test('open: NUL → 400', ...);                // send({ path: '/x\x00y' })
  test('open: 缺 path / 非字符串 → 400', ...);  // .send({}) 与 .send({ path: 123 })
  test('open: openWithSystem reject → 500', ...); // mockRejectedValueOnce
  ```

- [ ] **Step 6: 跑确认失败**

Run: `pnpm --filter @zn-ai/zai test src/server/routes/desktopFs.test.ts`

- [ ] **Step 7: 实现路由 + list preview**

按 Interfaces 的完整代码(list push 加 `preview`,`POST /desktop/open` 新增)。

- [ ] **Step 8: 跑过测试**

Run: `pnpm --filter @zn-ai/zai test src/server/routes/desktopFs.test.ts` — 原 9 + 新 6 = 15 全绿。

- [ ] **Step 9: 前端分流(Task 6 的 openPreview 改写)**

- `DesktopExplorer.tsx`:`ExplorerEntry` 加 `preview?: boolean`,map 时透传 `preview: e.preview`
- `Desktop.tsx`:按 Interfaces 的 `systemOpen` + `openPreview` 分流;预览浮窗容器加 `data-testid="desktop-preview"`

- [ ] **Step 10: 写 Desktop.test.tsx 两个新用例**

```tsx
test('双击不可预览文件 → POST /desktop/open 且不弹预览', async () => {
  fetchMock.mockImplementation(async (url: string) => {
    if (url.includes('/agent/settings')) return new Response(settings(), { status: 200, headers: { 'Content-Type': 'application/json' } });
    if (url.includes('/desktop/fs/list')) {
      return new Response(JSON.stringify({ ok: true, path: '/Users/t', home: '/Users/t', parent: null, entries: [{ name: 'a.zip', kind: 'file', path: '/Users/t/a.zip', size: 1, mtime: 1 }] }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    }
    return new Response(JSON.stringify({ ok: true }), { status: 200, headers: { 'Content-Type': 'application/json' } });
  });
  renderDesktop();
  fireEvent.doubleClick(await screen.findByTestId('entry-a.zip'));
  await waitFor(() => {
    const open = fetchMock.mock.calls.filter(([u, init]) => String(u).includes('/desktop/open'));
    expect(open.length).toBe(1);
    expect(open[0]?.[1]?.method).toBe('POST');
    expect(String((open[0]?.[1] as RequestInit | undefined)?.body)).toContain('/Users/t/a.zip');
  });
  expect(screen.queryByTestId('desktop-preview')).not.toBeInTheDocument();
});

test('双击可预览文件 → 预览浮窗渲染文本预览', async () => {
  fetchMock.mockImplementation(async (url: string) => {
    if (url.includes('/agent/settings')) return new Response(settings(), { status: 200, headers: { 'Content-Type': 'application/json' } });
    if (url.includes('/desktop/fs/list')) {
      return new Response(JSON.stringify({ ok: true, path: '/Users/t', home: '/Users/t', parent: null, entries: [{ name: 'a.md', kind: 'file', path: '/Users/t/a.md', size: 3, mtime: 1, preview: true }] }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    }
    if (url.includes('/desktop/fs/file')) {
      return new Response(JSON.stringify({ ok: true, mime: 'text/plain', dataUrl: 'data:text/plain;base64,aGk=' }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    }
    return new Response(JSON.stringify({ ok: true }), { status: 200, headers: { 'Content-Type': 'application/json' } });
  });
  renderDesktop();
  fireEvent.doubleClick(await screen.findByTestId('entry-a.md'));
  await waitFor(() => expect(screen.getByTestId('desktop-preview')).toBeInTheDocument());
});
```

- [ ] **Step 11: 跑过 Desktop 测试**

Run: `pnpm --filter @zn-ai/zai test src/web/src/pages/Desktop.test.tsx` — 4 + 2 = 6 全绿。

- [ ] **Step 12: 类型检查**

Run: `pnpm --filter @zn-ai/zai exec tsc --noEmit` — 无新错误。

- [ ] **Step 13: Commit**

```bash
git add packages/zai/src/shared/desktopFs.ts packages/zai/src/server/utils/openFile.ts packages/zai/src/server/utils/openFile.test.ts \
        packages/zai/src/server/routes/desktopFs.ts packages/zai/src/server/routes/desktopFs.test.ts \
        packages/zai/src/web/src/components/desktop/DesktopExplorer.tsx \
        packages/zai/src/web/src/pages/Desktop.tsx packages/zai/src/web/src/pages/Desktop.test.tsx
git commit -m "HRMSV3-ZN-WEBSITE#668 feat(zai): 资源区非预览文件双击调系统默认应用打开(open/xdg-open)"
```

### Task 8: 桌面便签(Sticky Notes)

> **用户新增需求(2026-08-26)**:桌面上要有「便签」——macOS 风壁纸层便签纸卡片:Dock 新增「便签」图标点击新建;卡片可拖拽移动(指针钳制在壁纸内)、点击编辑文字、右上角删除;localStorage 持久化(`zai.desktop.notes`)。

**Files:**
- Modify: `packages/zai/src/web/src/components/desktop/desktopStore.ts`(`LS_KEYS.notes` + `StickyNote` 类型 + `newStickyNote` 工厂)
- Create: `packages/zai/src/web/src/components/desktop/StickyNotes.tsx`(便签层:壁纸层之上、窗口层之下)
- Create: `packages/zai/src/web/src/components/desktop/StickyNotes.test.tsx`
- Modify: `packages/zai/src/web/src/pages/Desktop.tsx`(便签层装配 + Dock「便签」项)

**Interfaces:**
- `desktopStore.ts`:
  ```ts
  export interface StickyNote { id: string; text: string; x: number; y: number; color: string }
  // LS_KEYS 增加: notes: 'zai.desktop.notes'
  export const STICKY_COLORS = ['#ffd75e', '#c3e88d', '#9fd8ff', '#ff9e9e'] as const
  /** 新建便签(默认 160x120 卡片, 位置取视口中部偏左 + 级联偏移, id = `n-${Date.now()}-${counter}` 前端唯一) */
  export function newStickyNote(viewport: { w: number; h: number }, count: number): StickyNote
  ```
- `StickyNotes.tsx`:
  ```ts
  export interface StickyNotesProps {
    notes: StickyNote[]
    onChange: (id: string, patch: Partial<StickyNote>) => void
    onDelete: (id: string) => void
    viewport: { w: number; h: number }
  }
  ```
  - `position: 'absolute'`,卡片 160x120(+ 头 26px),圆角 10,阴影,背景 `note.color`
  - 头部条(26px,可拖拽移动:pointerdown + setPointerCapture,onChange({x,y}) 钳制 `0 <= x <= viewport.w - 160`、`0 <= y <= viewport.h - 146`)+ 右侧 X(`aria-label="删除便签"`)→ onDelete
  - 正文:`<textarea>`(无边框透明背景,自适应行高,首行缩进),onChange → onChange(id, { text });点击即编辑(focus)
  - 空态不渲染层(notes.length === 0 时 return null)

- [ ] **Step 1: 写失败测试**

`StickyNotes.test.tsx`(happy-dom,**不依赖 jest-dom**——用 `.not.toBeNull()`):
```tsx
// @vitest-environment happy-dom
import { describe, expect, test, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import StickyNotes from './StickyNotes.js';
import type { StickyNote } from './desktopStore.js';

const note = (over: Partial<StickyNote> = {}): StickyNote => ({ id: 'n-1', text: '记得补周报', x: 40, y: 60, color: '#ffd75e', ...over });
const V = { w: 1200, h: 800 };

describe('StickyNotes', () => {
  test('渲染便签文字;空数组时返回 null', () => {
    const { rerender } = render(<StickyNotes notes={[note()]} onChange={() => {}} onDelete={() => {}} viewport={V} />);
    expect(screen.getByText('记得补周报')).not.toBeNull();
    rerender(<StickyNotes notes={[]} onChange={() => {}} onDelete={() => {}} viewport={V} />);
    expect(screen.queryByText('记得补周报')).toBeNull();
  });
  test('编辑 textarea → onChange 收到新文本', () => {
    const onChange = vi.fn();
    render(<StickyNotes notes={[note()]} onChange={onChange} onDelete={() => {}} viewport={V} />);
    fireEvent.change(screen.getByRole('textbox'), { target: { value: '已改' } });
    expect(onChange).toHaveBeenCalledWith('n-1', { text: '已改' });
  });
  test('点 X → onDelete 收到 id', () => {
    const onDelete = vi.fn();
    render(<StickyNotes notes={[note()]} onChange={() => {}} onDelete={onDelete} viewport={V} />);
    fireEvent.click(screen.getByLabelText('删除便签'));
    expect(onDelete).toHaveBeenCalledWith('n-1');
  });
  test('newStickyNote 工厂级联 + id 唯一', () => {
    const a = newStickyNote(V, 0), b = newStickyNote(V, 1);
    expect(a.id).not.toBe(b.id);
    expect(a.y).not.toBe(b.y);
  });
});
```
(拖拽移动留 Task 10 真实验收。)

- [ ] **Step 2-3: RUN RED → 实现 StickyNotes + store 类型**

Run: `pnpm --filter @zn-ai/zai test src/web/src/components/desktop/StickyNotes.test.tsx`(先 FAIL 模块缺失)。

`StickyNotes.tsx` 骨架(实现按上述接口展开):
```tsx
import { useRef } from 'react';
import { CloseOutlined } from '@ant-design/icons';
import type { StickyNote } from './desktopStore.js';

const W = 160, H = 120, HEADER = 26;
export default function StickyNotes({ notes, onChange, onDelete, viewport }: StickyNotesProps) {
  const dragRef = useRef<{ id: string; dx: number; dy: number } | null>(null);
  if (notes.length === 0) return null;
  const startDrag = (id: string) => (e: React.PointerEvent) => {
    e.stopPropagation();
    const r = (e.currentTarget as HTMLElement).parentElement!.getBoundingClientRect();
    dragRef.current = { id, dx: e.clientX - r.left, dy: e.clientY - r.top };
    (e.target as HTMLElement).setPointerCapture(e.pointerId);
  };
  const onMove = (e: React.PointerEvent) => {
    const g = dragRef.current;
    if (!g) return;
    const x = Math.min(Math.max(0, e.clientX - g.dx), viewport.w - W);
    const y = Math.min(Math.max(0, e.clientY - g.dy), viewport.h - H - HEADER);
    onChange(g.id, { x, y });
  };
  const endDrag = () => { dragRef.current = null; };
  return (
    <div aria-label="便签层" style={{ position: 'absolute', inset: 0, pointerEvents: 'none', zIndex: 5 }}>
      {notes.map((n) => (
        <div key={n.id} role="note" aria-label={`便签 ${n.id}`}
          onPointerMove={onMove} onPointerUp={endDrag}
          style={{ position: 'absolute', left: n.x, top: n.y, width: W, height: H, background: n.color,
            borderRadius: 10, boxShadow: '0 6px 20px rgba(0,0,0,.28)', display: 'flex', flexDirection: 'column',
            pointerEvents: 'auto', overflow: 'hidden' }}>
          <div onPointerDown={startDrag(n.id)} style={{ height: HEADER, flexShrink: 0, cursor: 'grab',
            background: 'rgba(0,0,0,.08)', display: 'flex', alignItems: 'center', justifyContent: 'flex-end', padding: '0 4px' }}>
            <button aria-label="删除便签" onClick={() => onDelete(n.id)} style={{ border: 0, background: 'transparent', cursor: 'pointer', color: 'rgba(0,0,0,.55)' }}>
              <CloseOutlined style={{ fontSize: 11 }} />
            </button>
          </div>
          <textarea value={n.text} aria-label={`便签内容 ${n.id}`}
            onPointerDown={(e) => e.stopPropagation()}
            onChange={(e) => onChange(n.id, { text: e.target.value })}
            style={{ flex: 1, border: 0, outline: 'none', background: 'transparent', resize: 'none',
              padding: '4px 8px', fontSize: 12, lineHeight: 1.5, color: 'rgba(0,0,0,.85)', fontFamily: 'inherit' }} />
        </div>
      ))}
    </div>
  );
}
```
> 便签层 `pointerEvents: none`、卡片 `auto`:层不拦截窗口/壁纸交互,只有卡片可点。

- [ ] **Step 4-5: RUN GREEN → Desktop 装配 + Dock「便签」**

Desktop.tsx:
- `import StickyNotes from '../components/desktop/StickyNotes.js';` + `import { newStickyNote, type StickyNote } from '../components/desktop/desktopStore.js';`
- 状态:`const [notes, setNotes] = useLocalStorageState<StickyNote[]>(LS_KEYS.notes, []);`
- `const addNote = () => setNotes([...notes, newStickyNote(vp, notes.length)]);`(依赖 notes/vp)
- Dock:`dockClick` 增加 `'notes' | 'todo'` 分支;Dock items 增加:
  ```tsx
  <button data-testid="dock-notes" aria-label="便签" onClick={() => dockClick('notes')}>📝</button>
  <button data-testid="dock-todo" aria-label="待办" onClick={() => dockClick('todo')}>☑️</button>
  ```
  `dockClick('notes')` → addNote();`dockClick('todo')` → toggle `todoOpen`(Task 9 用)
- 壁纸层与图标区之间渲染 `<StickyNotes notes={notes} onChange={(id, patch) => setNotes((ns) => ns.map((n) => (n.id === id ? { ...n, ...patch } : n)))} onDelete={(id) => setNotes((ns) => ns.filter((n) => n.id !== id))} viewport={vp} />`
  (✅ 函数型 updater 已由共享 hook 修复支持持久化)

- [ ] **Step 6: RUN GREEN + tsc + commit**

Run: `pnpm --filter @zn-ai/zai test src/web/src/components/desktop/StickyNotes.test.tsx`(4 用例)+ `pnpm --filter @zn-ai/zai test src/web/src/pages/Desktop.test.tsx`(保持 6/6)+ `pnpm --filter @zn-ai/zai exec tsc --noEmit`。

Commit:
```bash
git add packages/zai/src/web/src/components/desktop/desktopStore.ts packages/zai/src/web/src/components/desktop/StickyNotes.tsx packages/zai/src/web/src/components/desktop/StickyNotes.test.tsx packages/zai/src/web/src/pages/Desktop.tsx
git commit -m "HRMSV3-ZN-WEBSITE#668 feat(zai): 桌面便签(壁纸层便签纸, 拖拽/编辑/删除, localStorage 持久化)"
```

### Task 9: 任务待办(TodoPanel)

> **用户新增需求(2026-08-26)**:桌面要有「任务待办」——Dock 新增「待办」图标,点击在**桌面右侧浮出紧凑面板**:输入回车/点 + 添加、勾选完成(删除线)、单条删除、关闭按钮;localStorage 持久化(`zai.desktop.todos`)。

**Files:**
- Modify: `packages/zai/src/web/src/components/desktop/desktopStore.ts`(`LS_KEYS.todos` + `TodoItem` 类型 + `newTodoItem` 工厂)
- Create: `packages/zai/src/web/src/components/desktop/TodoPanel.tsx`
- Create: `packages/zai/src/web/src/components/desktop/TodoPanel.test.tsx`
- Modify: `packages/zai/src/web/src/pages/Desktop.tsx`(TodoPanel 装配 + Dock「待办」开合)

**Interfaces:**
- `desktopStore.ts`:
  ```ts
  export interface TodoItem { id: string; text: string; done: boolean }
  // LS_KEYS 增加: todos: 'zai.desktop.todos'
  export function newTodoItem(text: string): TodoItem  // { id: `t-${Date.now()}-${counter}`, text: text.trim(), done: false }
  ```
- `TodoPanel.tsx`:
  ```ts
  export interface TodoPanelProps {
    todos: TodoItem[]
    onAdd: (text: string) => void
    onToggle: (id: string) => void
    onDelete: (id: string) => void
    onClose: () => void
  }
  ```
  - 固定绝对定位:`position: 'absolute'; top: 44; right: 16; width: 260`,卡片样式(圆角 12、半透明深底、阴影),zIndex 在窗口与顶栏之间(≈ 80)
  - 头:「任务待办」(粗体 13px)+ 关闭 X(`aria-label="关闭待办"` → onClose)
  - 输入行:Input(占位「添加待办…」)+ 加号按钮(`aria-label="添加待办"`);Enter 与点击都触发 onAdd(text) 并清空输入
  - 列表:checkbox(antd Checkbox)勾选 → onToggle(id),`done` 文本 `textDecoration: line-through` + 弱色;每行右侧 X → onDelete(id)
  - 空列表 → 「暂无待办」弱文案

- [ ] **Step 1: 写失败测试**

`TodoPanel.test.tsx`(happy-dom,不依赖 jest-dom):
```tsx
// @vitest-environment happy-dom
import { describe, expect, test, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import TodoPanel from './TodoPanel.js';
import type { TodoItem } from './desktopStore.js';

const item = (over: Partial<TodoItem> = {}): TodoItem => ({ id: 't-1', text: '写周报', done: false, ...over });

describe('TodoPanel', () => {
  test('渲染待办列表,done 项带删除线', () => {
    render(<TodoPanel todos={[item(), item({ id: 't-2', text: '评审', done: true })]} onAdd={() => {}} onToggle={() => {}} onDelete={() => {}} onClose={() => {}} />);
    expect(screen.getByText('写周报')).not.toBeNull();
    const done = screen.getByText('评审');
    expect((done.closest('span')?.style.textDecoration || '')).toContain('line-through');
  });
  test('输入 + 回车 → onAdd 收到文本, 并触发清空(二次输入不重复)', () => {
    const onAdd = vi.fn();
    render(<TodoPanel todos={[]} onAdd={onAdd} onToggle={() => {}} onDelete={() => {}} onClose={() => {}} />);
    const input = screen.getByPlaceholderText(/添加待办/);
    fireEvent.change(input, { target: { value: '整理桌面' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(onAdd).toHaveBeenCalledWith('整理桌面');
  });
  test('勾选 → onToggle(id);点 X → onDelete(id)', () => {
    const onToggle = vi.fn(), onDelete = vi.fn();
    render(<TodoPanel todos={[item()]} onAdd={() => {}} onToggle={onToggle} onDelete={onDelete} onClose={() => {}} />);
    fireEvent.click(screen.getByRole('checkbox'));
    expect(onToggle).toHaveBeenCalledWith('t-1');
    fireEvent.click(screen.getByLabelText('删除待办'));
    expect(onDelete).toHaveBeenCalledWith('t-1');
  });
  test('空列表显示「暂无待办」', () => {
    render(<TodoPanel todos={[]} onAdd={() => {}} onToggle={() => {}} onDelete={() => {}} onClose={() => {}} />);
    expect(screen.getByText(/暂无待办/)).not.toBeNull();
  });
});
```

- [ ] **Step 2-3: RUN RED → 实现 TodoPanel + store 类型**

Run: `pnpm --filter @zn-ai/zai test src/web/src/components/desktop/TodoPanel.test.tsx`(先 FAIL)。实现按 Interfaces。

- [ ] **Step 4-5: RUN GREEN → Desktop 装配 + Dock「待办」**

Desktop.tsx:
- `import TodoPanel from '../components/desktop/TodoPanel.js';` + `import { newTodoItem, type TodoItem } from '../components/desktop/desktopStore.js';`
- 状态:`const [todos, setTodos] = useLocalStorageState<TodoItem[]>(LS_KEYS.todos, []);`、`const [todoOpen, setTodoOpen] = useState(false);`
- `dockClick('todo')` → `setTodoOpen((v) => !v)`
- JSX(顶栏之下、Dock 之上):`{todoOpen && <TodoPanel todos={todos} onAdd={(text) => setTodos((ts) => [...ts, newTodoItem(text)])} onToggle={(id) => setTodos((ts) => ts.map((t) => (t.id === id ? { ...t, done: !t.done } : t)))} onDelete={(id) => setTodos((ts) => ts.filter((t) => t.id !== id))} onClose={() => setTodoOpen(false)} />}`

- [ ] **Step 6: RUN GREEN + tsc + commit**

Run: `pnpm --filter @zn-ai/zai test src/web/src/components/desktop/TodoPanel.test.tsx`(4 用例)+ `pnpm --filter @zn-ai/zai test src/web/src/pages/Desktop.test.tsx`(保持 6/6)+ tsc。

Commit:
```bash
git add packages/zai/src/web/src/components/desktop/desktopStore.ts packages/zai/src/web/src/components/desktop/TodoPanel.tsx packages/zai/src/web/src/components/desktop/TodoPanel.test.tsx packages/zai/src/web/src/pages/Desktop.tsx
git commit -m "HRMSV3-ZN-WEBSITE#668 feat(zai): 桌面任务待办(Dock 右侧浮出面板, 增/勾/删, localStorage 持久化)"
```

### Task 10: 真实浏览器验收(`/ego-browser`)

**Files:** 无代码改动,仅验收清单。

**前置(AGENTS.md 强制项)**:先 `pnpm --filter @zn-ai/zai dev -- --port 8102 --api-port 7715` 起独立开发服务(**不要 kill 920x 正式服务端口进程**);ego-browser 打开 `http://localhost:8102/desktop`。

- [ ] **Step 1: 桌面壳渲染**
  - 打开 `http://localhost:8102/desktop`:全屏壁纸铺满无 Layout Sider;顶栏有时钟;Dock 居底部,6 个图标(hover 有放大)
  - 截图留档,度量:`dock` 居中(rect 距屏幕中心对称)、窗口圆角与阴影可见

- [ ] **Step 2: 浮窗交互**
  - 资源管理器窗标题栏拖拽 → 位置改变且不超出视口(左上角钳制)
  - 右下角拖拽缩放 → 尺寸变化,agent 窗宽不小于 560
  - 点击 agent 窗 → zIndex 置顶(active 描边切换);标题栏 `—` 最小化 → 窗口隐藏,Dock 图标高亮;Dock 点击 → 还原
  - 双击标题栏 → 最大化铺满;再双击 → 还原
  - 刷新页面 → 窗口位置/大小/最小化态保持(记录刷新前后 rect)

- [ ] **Step 3: 资源管理器**
  - 初始列出主目录(home);「上级」按钮行为正确(根目录禁用)
  - 双击文件夹进入,路径栏显示当前目录;手输路径回车跳转(如 `~/code/zn-ai-zbuddy`)
  - 访问一个不存在路径 → 窗内错误提示
  - 切「线上」Tab → "待接入"空态

- [ ] **Step 4: 附件区 + 上下文(核心链路)**
  - 从资源窗把 `README.md`(或任意文件)拖到 Agent 窗附件区 → chip 显示文件名
  - 输入框输入 prompt 后发送 → 会话消息气泡出现 `@<绝对路径>`;Agent 回复若能引用文件内容即成功(office agent 有 FS 工具,能读到路径说明引用生效;若回复为空/找不到,改用相对路径或核对 agent 绝对路径读取能力)
  - 拖入第 17 个文件 → toast「附件最多 16 个」
  - 附件 chip 点 X → 移除

- [ ] **Step 5: Office 作用域**
  - 进入桌面后:`/manage` 或 SettingsDrawer 查看 workMode=办公、mainAgent=Office(可经 `fetch('/api/agent/settings')` 在 console 核对:`workMode: 'office'`、`mainAgent: 'office'`)
  - 离开桌面(点退出/切回 `/agent`)→ 等 1s 再 `fetch('/api/agent/settings')`:`workMode` 还原为进入前的值(如 `code`)、`mainAgent` 还原为 `default`;`localStorage['zai.desktop.settings.snapshot']` 已清除

- [ ] **Step 6: 会话互通**
  - 在 `/desktop` 发送一条消息 → 切到 `/agent`:同一会话历史可见;反向亦然;流式回复在桌面内正常渲染(SSE 通)

- [ ] **Step 7: 快捷方式 + 壁纸**
  - 从资源窗拖文件到壁纸空白 → 桌面生成图标;双击文件夹图标 → 资源窗导航至该目录;右键 → 移除
  - 顶栏换壁纸 → 预设切换生效;上传本地图片 → 壁纸更换;刷新后壁纸保持

- [ ] **Step 8: 便签 + 任务待办**
  - Dock 点「便签」→ 壁纸层出现新便签纸(黄底);点击便签 → 输入文字;拖标题栏 → 位置移动且钳制视口内;点 X → 删除;刷新页面 → 便签内容/位置保持
  - Dock 点「待办」→ 右侧浮出面板;输入回车添加;勾选 → 删除线;单条 X 删除;X 关闭面板;刷新页面 → 待办保持
  - console 核对 `localStorage['zai.desktop.notes']` / `['zai.desktop.todos']` 为合法 JSON(非 `"undefined"`)

- [ ] **Step 9: 系统能力打开非预览文件**
  - 资源窗双击一个 `.zip` / `.md`-以外的不可预览文件 → 无预览浮窗,console 可见 `POST /api/desktop/open` 200,并出现「已用系统默认应用打开」toast;macOS 上系统 App/Finder 被唤起(ego-browser 验证时会离开浏览器焦点——以 Network panel 的 200 + toast 文案为准,本机实际弹出 Popup 人工确认后计 pass)
  - 双击 `.md` / 图片 → 预览浮窗出现且无 POST /desktop/open 调用

- [ ] **Step 10: 移动端兜底**
  - ego-browser 手机视口(或临时改 `isMobile`)访问 `/desktop` → 重定向 `/agent`

- [ ] **Step 11: 回归确认 + 全量单测(合并前 sanity)**
  - `pnpm -r test`(Task 1-9 的单测全绿,含既有用例不回归)——仅此一次合并前跑全量允许
  - 全部通过后:`git status` 干净,验收完成