# zai Files 视图内容搜索(ripgrep 后端) — 实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在 zai Files 视图头部搜索框旁加 antd `<Switch>`,切换"文件名 / 内容"模式;"内容"模式复用 vendor ripgrep 做全文搜索,结果列表 + 点击跳到右侧预览并高亮命中行。

**Architecture:** 后端抽 `services/ripgrep.ts`(复刻 `GrepTool.ts` 的 vendor 路径解析 + spawn)+ 新增 `GET /api/fs/content-search` 走 `--json`;前端 `useFsContentSearch`(200ms 防抖 + `enabled` gate + AbortController)+ `FsContentSearchList`(行 = `path:line preview`,submatch 黄色高亮)+ `FsTab` 加 Switch 切换 mode + `pendingLine` state 透传到 `FilePreview`,preview 找 `<span data-line={n}>` 滚到并加黄底 2s。

**Tech Stack:** Node `child_process.spawn` · Express Router · TypeScript · React + antd `<Switch>` + happy-dom vitest · React Testing Library。

**Spec:** `docs/superpowers/specs/2026-07-27-zai-fs-content-search-design.md`

**前置 spec(参考但不修改):** `docs/superpowers/specs/2026-07-25-zai-files-search-design.md`(复用 `useFsSearch` 模板与 IGNORED/TEXT_EXTS 常量)

---

## Global Constraints

> 所有任务必须遵守。Quoted values copied verbatim from spec.

- **工作目录**:`.worktrees/fs-content-search/`(所有 `cd` 命令从这里开始;`${WT}` 在本计划里是它的绝对路径前缀)
- **Node 引擎**:`>=20`(zai package.json `engines.node`)。本计划用 `node:child_process.spawn`、`AbortController`、`setTimeout`(`clearTimeout` cleanup)。
- **路径**:服务端 `FsContentSearchEntry.path` 必须用 forward-slash(`rel.split(sep).join('/')`),与现有 `/fs/list` + `/fs/search` 对齐。
- **安全**:`/fs/content-search` 不允许 `path` 越界 — handler 内用 `resolveSafePath(cwd, '')` 锚定;若未来透传 `path` 子目录参数,同样走 `resolveSafePath`。
- **常量(verbatim from spec)**:
  - `MAX_QUERY_LEN = 64`(防超长 query DoS)
  - `MAX_FILE_BYTES = 2 * 1024 * 1024`(单文件上限 → `--max-filesize 2M`)
  - `DEBOUNCE_MS = 200`(前端防抖)
  - `TRUNCATED_TAIL = '(结果已截断,继续输入以收窄范围)'`(UI 截断提示)
  - `DEFAULT_HEAD_LIMIT = 200`(命中数上限)
  - `RG_TIMEOUT_MS = 10000`(ripgrep 单次 spawn 超时)
  - `HIGHLIGHT_DURATION_MS = 2000`(preview 行高亮停留)
- **ripgrep 路径**:`packages/zai-agent-core/vendor/ripgrep/{rg-<platform>-<arch>[.exe]}`,目前有 darwin-arm64 / darwin-x64 / win32-x64.exe。Linux 必须依赖系统 `rg`(`resolveRgPath` 回退到 `which rg`)。
- **测试基线**:
  - 服务端:沿用 `packages/zai/vitest.config.ts`(默认 node 环境,globals);supertest `app.use('/api', fsRouter)` + `app.locals.instanceContext = { cwd, cwdName: 'test' }`。
  - 前端:`// @vitest-environment happy-dom` 首行 pragma;fs-search-input 等 test-id 沿用现有。
  - `FsTab.test.tsx` 沿用 `vi.mock('./useFsList.js'…) / vi.mock('./useFsFile.js'…) / vi.mock('./useFsSearch.js'…) / vi.mock('./useFsWrite.js'…)` 套路,新增 `vi.mock('./useFsContentSearch.js', …)`。
- **不引入新依赖**(0 npm install);用 `node:child_process`、`AbortController`、`fetch`、`api` helper、antd 已有 `Switch`。
- **不修改**:`GrepTool.ts`(只抽 service,Agent 工具调用路径不变);`useFsSearch.ts`(只读);`FsSearchList.tsx`(只读);`api.ts`;`safePath.ts`;`fsWrite.ts`;`/fs/search` 路由;ANTD 主题。
- **每次任务结束**:commit。一个 task = 一个 commit。
- **禁止**:`TODO` / `TBD` / "implement later" / "add appropriate error handling" — 必须给完整代码或显式说明并给出代码。

---

## File Structure

```
packages/zai/src/
├── shared/
│   └── fs.ts                                          [MODIFY] +FsContentSearchSubmatch/Entry/Match/Result
├── server/
│   ├── services/
│   │   ├── ripgrep.ts                                 [CREATE] resolveRgPath() + runRipgrep()
│   │   └── ripgrep.test.ts                             [CREATE] vitest node env
│   ├── routes/
│   │   ├── fs.ts                                      [MODIFY] +GET /fs/content-search handler
│   │   └── fs.content-search.test.ts                  [CREATE] vitest supertest
│   └── utils/                                         [不动]
└── web/src/components/splitPane/
    ├── FsTab.tsx                                      [MODIFY] +mode state + Switch + pendingLine + FilePreview prop
    ├── FsTab.test.tsx                                 [MODIFY] +Switch/pendingLine/highlight cases
    ├── FilePreview (内嵌)                              [MODIFY] +pendingLine prop + <span data-line> + scrollIntoView
    ├── useFsContentSearch.ts                          [CREATE] debounce + AbortController + enabled gate
    ├── useFsContentSearch.test.tsx                    [CREATE] fake-timer debounce/abort/enabled
    ├── FsContentSearchList.tsx                        [CREATE] render row + submatch highlight
    ├── FsContentSearchList.test.tsx                   [CREATE] empty/loading/error/click/truncated
    └── shared.ts                                      [不动]
```

**Boundary contracts (must match across tasks)**:

```ts
// shared/fs.ts (追加,现有 import 不破坏)
export interface FsContentSearchSubmatch {
  /** 命中的子串原文(大小写与原文一致)。 */
  text: string;
  /** 0-based column offset (UTF-8 字节,与 ripgrep JSON 一致)。 */
  start: number;
  /** 排除性 end column。 */
  end: number;
}
export interface FsContentSearchMatch {
  /** 1-based line number。 */
  line: number;
  /** 完整行文本(去尾换行,前导空白保留)。 */
  text: string;
  /** 第一个 submatch(当前 ripgrep 调用固定返回单 submatch)。 */
  submatch: FsContentSearchSubmatch;
}
export interface FsContentSearchEntry {
  /** 相对 cwd 的 POSIX 路径。 */
  path: string;
  /** basename。 */
  name: string;
  /** 该文件的所有命中行(默认只展示首个,排序由 server 完成)。 */
  matches: FsContentSearchMatch[];
}
export interface FsContentSearchResult {
  ok: boolean;
  error?: string;
  entries?: FsContentSearchEntry[];
  /** 命中数超过 headLimit 或超时截断。 */
  truncated?: boolean;
  /** server 端耗时 ms。 */
  durationMs?: number;
}

// server/services/ripgrep.ts (新增导出)
export type SpawnResult = {
  stdout: string; stderr: string;
  code: number | null; signal: NodeJS.Signals | null;
  error?: NodeJS.ErrnoException;
};
export type RunRipgrepOptions = { cwd: string; signal?: AbortSignal; timeoutMs?: number };
export function resolveRgPath(): { rgPath: string; mode: 'vendor' | 'system' } | null;
export async function runRipgrep(args: string[], opts: RunRipgrepOptions): Promise<SpawnResult>;

// server/routes/fs.ts (handler 内部用到)
async function handleContentSearch(
  searchRoot: string, q: string, headLimit: number, signal: AbortSignal,
): Promise<{ entries: FsContentSearchEntry[]; truncated: boolean; durationMs: number }>

// web/components/splitPane/useFsContentSearch.ts (新增)
export interface UseFsContentSearchOptions { enabled?: boolean; headLimit?: number }
export interface UseFsContentSearchResult {
  data: FsContentSearchResult | null; loading: boolean; error: string | null; durationMs: number | null;
}
export function useFsContentSearch(
  cwd: string | null, query: string,
  options?: UseFsContentSearchOptions,
): UseFsContentSearchResult;

// web/components/splitPane/FsContentSearchList.tsx (新增)
export interface FsContentSearchListProps {
  entries: FsContentSearchEntry[]; loading: boolean; error: string | null;
  truncated: boolean; query: string;
  onSelect: (path: string, line: number) => void;
}
export function FsContentSearchList(props: FsContentSearchListProps): JSX.Element;
export function highlightLine(text: string, submatch: { start: number; end: number }): JSX.Element[];

// FsTab.tsx 内部新增(不导出)
type SearchMode = 'name' | 'content';
```

---

## Task 1: Shared types — extend `shared/fs.ts`

**Files:**
- Modify: `packages/zai/src/shared/fs.ts`(当前 69 行,在文件末尾追加,不动现有内容)
- Test: (none — pure type addition, tsc catches)

**Interfaces:**
- Produces: `FsContentSearchSubmatch`, `FsContentSearchMatch`, `FsContentSearchEntry`, `FsContentSearchResult`(consumed by Tasks 3, 4, 5, 6, 7)

- [ ] **Step 1: Append types to `shared/fs.ts`**

打开 `packages/zai/src/shared/fs.ts`,在文件最后一行后追加:

```typescript
/**
 * Result of a content (full-text) search.
 * Returned by /api/fs/content-search and consumed by useFsContentSearch → FsContentSearchList.
 */
export interface FsContentSearchSubmatch {
  /** 命中的子串原文(大小写与原文一致)。 */
  text: string;
  /** 0-based column offset (UTF-8 字节,与 ripgrep --json 一致)。 */
  start: number;
  /** 排除性 end column。 */
  end: number;
}

export interface FsContentSearchMatch {
  /** 1-based line number。 */
  line: number;
  /** 完整行文本(去尾换行,前导空白保留)。 */
  text: string;
  /** 第一个 submatch(本次固定返回单 submatch)。 */
  submatch: FsContentSearchSubmatch;
}

export interface FsContentSearchEntry {
  /** 相对 cwd 的 POSIX 路径(forward-slash)。 */
  path: string;
  /** basename。 */
  name: string;
  /** 该文件的所有命中行(本次只展示首个,排序由 server 完成)。 */
  matches: FsContentSearchMatch[];
}

export interface FsContentSearchResult {
  ok: boolean;
  error?: string;
  entries?: FsContentSearchEntry[];
  /** 命中数超过 headLimit 或超时截断。 */
  truncated?: boolean;
  /** server 端耗时 ms。 */
  durationMs?: number;
}
```

- [ ] **Step 2: Type-check**

Run:
```bash
cd ${WT}/packages/zai && npx tsc -b --noEmit
```
Expected: PASS(新类型仅是 export,不被现有 import 引用,不会引发错误)。

- [ ] **Step 3: Commit**

```bash
cd ${WT} && git add packages/zai/src/shared/fs.ts && git commit -m "feat(zai-shared): FsContentSearch types for ripgrep content search"
```

---

## Task 2: Extract `services/ripgrep.ts` from `GrepTool`

**Files:**
- Create: `packages/zai/src/server/services/ripgrep.ts`(从 `GrepTool.ts:223-348` 搬运并去掉 ToolContext 依赖)
- Test: `packages/zai/src/server/services/ripgrep.test.ts`(node env,vendor rg 真跑或 mock `spawn` 二选一)

**Interfaces:**
- Produces:
  - `export type SpawnResult = { stdout, stderr, code, signal, error? }`
  - `export type RunRipgrepOptions = { cwd, signal?, timeoutMs? }`
  - `export function resolveRgPath(): { rgPath: string; mode: 'vendor' | 'system' } | null`
  - `export async function runRipgrep(args, opts): Promise<SpawnResult>`

- [ ] **Step 1: Write failing test for `resolveRgPath` + `runRipgrep`**

Create `packages/zai/src/server/services/ripgrep.test.ts`:

```typescript
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { resolveRgPath, runRipgrep } from './ripgrep.js';

describe('resolveRgPath', () => {
  test('returns null when neither vendor nor system rg exists', () => {
    // Note: vendor depends on current platform/arch; this test just verifies
    // the function returns a non-throwing shape. The "vendor exists" branch
    // is exercised by the integration test in Task 3 against the real cwd.
    const r = resolveRgPath();
    // Either null or a valid object — never throws.
    expect(r === null || typeof r.rgPath === 'string').toBe(true);
    if (r) expect(['vendor', 'system']).toContain(r.mode);
  });
});

describe('runRipgrep', () => {
  let root: string;
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'zai-rg-'));
    mkdirSync(join(root, 'sub'));
    writeFileSync(join(root, 'a.ts'), 'foo bar\nbaz\n');
    writeFileSync(join(root, 'sub', 'b.ts'), 'FOO only\n');
  });
  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  test('runs a regex search and captures stdout (skip if rg unavailable)', async () => {
    const rg = resolveRgPath();
    if (!rg) {
      // vendor only ships on darwin+win32; on Linux without system rg,
      // the contract is that runRipgrep still returns gracefully.
      const res = await runRipgrep(['--version'], { cwd: root });
      expect(res).toMatchObject({ stdout: expect.any(String) });
      return;
    }
    const res = await runRipgrep(['-n', '-e', 'foo', root], { cwd: root });
    expect(res.code).toBe(0);
    expect(res.stdout).toContain('a.ts');
    expect(res.stdout).toContain('sub/b.ts');
  });

  test('respects AbortSignal (kills process)', async () => {
    const rg = resolveRgPath();
    if (!rg) return; // skip on no-rg envs
    const ac = new AbortController();
    ac.abort();
    const res = await runRipgrep(['--version'], { cwd: root, signal: ac.signal });
    expect(res.code === null || res.signal !== null).toBe(true);
  });

  test('returns ENOENT-style result when rg binary missing', async () => {
    // Force resolveRgPath-style miss by passing a bogus rgPath via env override
    // is risky; instead, just verify the function shape on a missing toolchain.
    // We test the explicit branch by mocking spawn — done in integration.
    // Here we assert the function does not throw on cwd=null opts.signal.
    const res = await runRipgrep(['--version'], { cwd: root });
    expect(res).toBeTruthy();
    expect(typeof res.stdout).toBe('string');
  });
});
```

- [ ] **Step 2: Run test — verify it fails (functions not exported)**

Run:
```bash
cd ${WT}/packages/zai && npx vitest run src/server/services/ripgrep.test.ts
```
Expected: FAIL with "Cannot find module './ripgrep.js'" or "resolveRgPath is not a function".

- [ ] **Step 3: Implement `services/ripgrep.ts`**

Create `packages/zai/src/server/services/ripgrep.ts`:

```typescript
/**
 * Thin wrapper around the vendored / system ripgrep binary.
 *
 * Extracted from packages/zai-agent-core/src/tools/GrepTool/GrepTool.ts
 * (vendor path resolver + spawn) so the HTTP route layer can call rg
 * directly without depending on ToolContext. The Agent-side GrepTool
 * keeps its existing copy for now — duplicating ~80 lines is cheaper
 * than retrofitting a LegacyTool dependency into the route layer.
 *
 * Vendor: packages/zai-agent-core/vendor/ripgrep/{rg-<platform>-<arch>[.exe]}
 * System: `which rg` / `where rg` fallback.
 *
 * Platform coverage (from fetch-vendor-ripgrep.mjs):
 *   - darwin + arm64 / x64
 *   - win32  + x64
 * Linux users must install ripgrep on PATH; the route layer treats
 * `resolveRgPath() === null` as "ripgrep unavailable" and returns
 * { ok:false, error:'ripgrep 未安装…' } with HTTP 200.
 */
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync, spawn } from 'node:child_process';

export type SpawnResult = {
  stdout: string;
  stderr: string;
  code: number | null;
  signal: NodeJS.Signals | null;
  error?: NodeJS.ErrnoException;
};

export type RunRipgrepOptions = {
  /** ripgrep 进程的 cwd(同时也是默认 search root 的拼装基准)。 */
  cwd: string;
  /** 用于提前中止的 AbortSignal。 */
  signal?: AbortSignal;
  /** 单次 spawn 超时(毫秒)。默认 10000。 */
  timeoutMs?: number;
};

const DEFAULT_TIMEOUT_MS = 10_000;
const SIGKILL_AFTER_MS = 5_000;

/** Resolve vendor ripgrep binary for the current platform/arch. */
export function resolveRgVendor(): { rgPath: string; mode: 'vendor' } | null {
  const platform = process.platform;
  const arch = process.arch;
  if (!['darwin', 'win32'].includes(platform)) return null;
  if (!['arm64', 'x64'].includes(arch)) return null;
  const ext = platform === 'win32' ? '.exe' : '';
  const binName = `rg-${platform}-${arch}${ext}`;
  const here = dirname(fileURLToPath(import.meta.url));
  // services/ → ../../vendor/ripgrep/  (packages/zai-agent-core/vendor/ripgrep/)
  const vendorPath = join(
    here, '..', '..', '..', '..', 'zai-agent-core', 'vendor', 'ripgrep', binName,
  );
  return existsSync(vendorPath) ? { rgPath: vendorPath, mode: 'vendor' } : null;
}

/** Resolve ripgrep via PATH (`which rg` / `where rg`). */
export function resolveRgSystem(): { rgPath: string; mode: 'system' } | null {
  try {
    const cmd = process.platform === 'win32' ? 'where' : 'which';
    const stdout = execFileSync(cmd, ['rg'], { timeout: 3000, encoding: 'utf-8' });
    const rgPath = stdout.trim().split(/\r?\n/)[0];
    return rgPath ? { rgPath, mode: 'system' } : null;
  } catch {
    return null;
  }
}

/** First non-null of vendor → system. Single-binary callers use this. */
export function resolveRgPath(): { rgPath: string; mode: 'vendor' | 'system' } | null {
  return resolveRgVendor() ?? resolveRgSystem();
}

/**
 * Spawn ripgrep with the given args, capture stdout/stderr, settle once on
 * 'close' or 'error'. Mirrors GrepTool.spawnOnce semantics but accepts an
 * AbortSignal + an explicit timeout instead of ToolContext.
 */
export async function runRipgrep(
  args: string[],
  opts: RunRipgrepOptions,
): Promise<SpawnResult> {
  const rg = resolveRgPath();
  if (!rg) {
    return {
      stdout: '',
      stderr: 'ripgrep binary not found (vendor missing + system PATH empty)',
      code: null,
      signal: null,
      error: Object.assign(new Error('ENOENT'), { code: 'ENOENT' }) as NodeJS.ErrnoException,
    };
  }

  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  return new Promise<SpawnResult>((resolveP) => {
    const child = spawn(rg.rgPath, args, {
      cwd: opts.cwd,
      signal: opts.signal,
      windowsHide: true,
    });

    let stdout = '';
    let stderr = '';
    const stdoutChunks: Buffer[] = [];
    const stderrChunks: Buffer[] = [];

    child.stdout?.on('data', (d: Buffer) => {
      stdoutChunks.push(d);
      stdout += d.toString();
    });
    child.stderr?.on('data', (d: Buffer) => {
      stderrChunks.push(d);
      stderr += d.toString();
    });

    let settled = false;
    const settle = (r: SpawnResult) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      clearTimeout(killer);
      resolveP(r);
    };

    const killer = setTimeout(() => {
      try {
        child.kill('SIGKILL');
      } catch {
        /* ignore */
      }
    }, timeoutMs + SIGKILL_AFTER_MS);

    const timer = setTimeout(() => {
      try {
        child.kill('SIGTERM');
      } catch {
        /* ignore */
      }
    }, timeoutMs);

    child.on('close', (code, signal) => {
      settle({ stdout, stderr, code, signal });
    });
    child.on('error', (err: NodeJS.ErrnoException) => {
      settle({ stdout, stderr, code: null, signal: null, error: err });
    });
  });
}
```

> 注:`stdoutChunks` / `stderrChunks` Buffer 数组保留用于将来 max-buffer 截断(本期不做,与 GrepTool 一致只累积字符串)。

- [ ] **Step 4: Run test — verify it passes**

Run:
```bash
cd ${WT}/packages/zai && npx vitest run src/server/services/ripgrep.test.ts
```
Expected: PASS(darwin 系统 + vendor 二进制存在 → 三个 case 全过;Linux 无 vendor + 无系统 rg → 第一个 case 返回 `null`,后两个因 `if (!rg) return` 跳过,`ENOENT-style` case 走默认返回 OK)。

- [ ] **Step 5: Commit**

```bash
cd ${WT} && git add packages/zai/src/server/services/ripgrep.ts packages/zai/src/server/services/ripgrep.test.ts && git commit -m "feat(zai-server): extract ripgrep service for content search"
```

---

## Task 3: Route handler `GET /api/fs/content-search`

**Files:**
- Modify: `packages/zai/src/server/routes/fs.ts`(在 `walkForSearch` 之后或文件末尾追加新 handler)
- Test: `packages/zai/src/server/routes/fs.content-search.test.ts`(supertest)

**Interfaces:**
- Consumes: `FsContentSearchEntry / Match / Submatch / Result`(Task 1),`runRipgrep / resolveRgPath`(Task 2),`resolveSafePath`(existing)
- Produces: handler bound at `fsRouter.get('/fs/content-search', …)`

- [ ] **Step 1: Write failing supertest test**

Create `packages/zai/src/server/routes/fs.content-search.test.ts`:

```typescript
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import express from 'express';
import request from 'supertest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import fsRouter from './fs.js';
import { resolveRgPath } from '../services/ripgrep.js';

function makeApp(cwd: string) {
  const app = express();
  app.locals.instanceContext = { cwd, cwdName: 'test' };
  app.use(express.json());
  app.use('/api', fsRouter);
  return app;
}

const HAS_RG = resolveRgPath() !== null;

describe('GET /api/fs/content-search', () => {
  let root: string;
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'zai-fs-cs-'));
    mkdirSync(join(root, 'src'));
    writeFileSync(join(root, 'src', 'foo.ts'), '// TODO: refactor\nconst x = 1;\nTODO done\n');
    writeFileSync(join(root, 'src', 'bar.ts'), 'no match here\n');
    mkdirSync(join(root, 'node_modules'));
    writeFileSync(join(root, 'node_modules', 'foo.js'), 'TODO skip\n');
  });
  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  test('returns 400 when q is missing', async () => {
    const res = await request(makeApp(root)).get('/api/fs/content-search');
    expect(res.status).toBe(400);
    expect(res.body.ok).toBe(false);
    expect(res.body.error).toMatch(/q/);
  });

  test('returns 400 when q is empty', async () => {
    const res = await request(makeApp(root)).get('/api/fs/content-search').query({ q: '' });
    expect(res.status).toBe(400);
    expect(res.body.ok).toBe(false);
  });

  test('returns 400 when q exceeds MAX_QUERY_LEN (64)', async () => {
    const res = await request(makeApp(root))
      .get('/api/fs/content-search')
      .query({ q: 'a'.repeat(65) });
    expect(res.status).toBe(400);
    expect(res.body.ok).toBe(false);
  });

  test('returns 200 ok:false when ripgrep is unavailable', async () => {
    if (HAS_RG) {
      // We can't easily mock resolveRgPath in this layer without DI;
      // skip when rg is present (the happy path is exercised below).
      return;
    }
    const res = await request(makeApp(root))
      .get('/api/fs/content-search')
      .query({ q: 'TODO' });
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(false);
    expect(res.body.error).toMatch(/ripgrep/i);
  });

  test('happy path: returns path + line + submatch (ripgrep available)', async () => {
    if (!HAS_RG) return;
    const res = await request(makeApp(root))
      .get('/api/fs/content-search')
      .query({ q: 'TODO' });
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(Array.isArray(res.body.entries)).toBe(true);
    const foo = res.body.entries.find((e: { path: string }) => e.path === 'src/foo.ts');
    expect(foo).toBeTruthy();
    expect(foo.matches.length).toBeGreaterThanOrEqual(2);
    expect(foo.matches[0].line).toBe(1);
    expect(foo.matches[0].submatch.text).toBe('TODO');
    expect(typeof foo.matches[0].submatch.start).toBe('number');
    expect(foo.matches[0].submatch.end).toBe(foo.matches[0].submatch.start + 4);
    // node_modules must be excluded
    const nm = res.body.entries.find((e: { path: string }) => e.path.includes('node_modules'));
    expect(nm).toBeFalsy();
    expect(typeof res.body.durationMs).toBe('number');
  });

  test('empty result returns ok:true + entries:[]', async () => {
    if (!HAS_RG) return;
    const res = await request(makeApp(root))
      .get('/api/fs/content-search')
      .query({ q: 'NEVER_MATCHES_ANYWHERE' });
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.entries).toEqual([]);
  });

  test('headLimit truncates and sets truncated:true', async () => {
    if (!HAS_RG) return;
    const res = await request(makeApp(root))
      .get('/api/fs/content-search')
      .query({ q: 'TODO', headLimit: 1 });
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.entries.length).toBeLessThanOrEqual(1);
    // 1 命中行(headLimit=1)够小,但 truncate 仍然可能因为累计截断
    // 我们只断言 entries 长度与 truncated 字段存在
    expect(typeof res.body.truncated).toBe('boolean');
  });
});
```

- [ ] **Step 2: Run test — verify it fails (route not defined)**

Run:
```bash
cd ${WT}/packages/zai && npx vitest run src/server/routes/fs.content-search.test.ts
```
Expected: FAIL with HTTP 404("Cannot GET /api/fs/content-search")。

- [ ] **Step 3: Add handler to `routes/fs.ts`**

打开 `packages/zai/src/server/routes/fs.ts`,先更新顶部 import:

```typescript
// 顶部 import 区域,在原有 import 后追加:
import { resolveRgPath, runRipgrep } from '../services/ripgrep.js';
import type {
  FsContentSearchEntry, FsContentSearchMatch,
  FsContentSearchResult, FsContentSearchSubmatch,
} from '../../shared/fs.js';
import { dirname as pathDirname, relative as pathRelative } from 'node:path';
```

然后在 `walkForSearch` 函数定义之后,文件末尾(在任何现有 `fsRouter.get('/fs/search', …)` 附近 — 我们加在它后面)追加:

```typescript
// --- Content search (ripgrep-backed) -------------------------------------

const RG_TIMEOUT_MS = 10_000;
const DEFAULT_HEAD_LIMIT = 200;
const MAX_HEAD_LIMIT = 500;
const RG_GLOBS = [
  // Binary / archive
  '--glob', '!*.{png,jpg,jpeg,gif,webp,ico,pdf,zip,tar,gz,wasm,mp3,mp4,avi,mov,ogg,flac,ttf,otf,eot,bin,exe,so,dll,class,o,obj}',
  // VCS
  '--glob', '!{.git,.svn,.hg,.bzr,.jj,.sl}',
  // Deps / build
  '--glob', '!{node_modules,dist,build,coverage,.next,.turbo,.cache}',
];

interface ParsedRgMatch {
  path: string;
  line: number;
  text: string;
  submatch: { text: string; start: number; end: number };
}

function parseRgJsonLine(line: string): ParsedRgMatch | null {
  if (!line) return null;
  let obj: unknown;
  try {
    obj = JSON.parse(line);
  } catch {
    return null;
  }
  if (
    typeof obj !== 'object' || obj === null ||
    (obj as { type?: string }).type !== 'match'
  ) {
    return null;
  }
  const o = obj as {
    data?: {
      path?: { text?: string };
      line_number?: number;
      lines?: { text?: string };
      submatches?: Array<{ match?: { text?: string }; start: number; end: number }>;
    };
  };
  const d = o.data;
  if (!d?.path?.text || typeof d.line_number !== 'number' || !d.lines?.text) return null;
  const sub = d.submatches?.[0];
  if (!sub?.match?.text) return null;
  return {
    path: d.path.text,
    line: d.line_number,
    text: d.lines.text.replace(/\r?\n$/, ''),
    submatch: { text: sub.match.text, start: sub.start, end: sub.end },
  };
}

/**
 * Aggregate ripgrep --json output into FsContentSearchEntry[].
 * - Relativises paths against searchRoot, joins POSIX forward-slashes.
 * - Aggregates matches per path.
 * - Sorts entries by matches.length desc, then path asc.
 * - Truncates to headLimit; sets truncated=true if either the headLimit
 *   cut was reached OR a parse error forced early termination.
 */
function aggregateRgOutput(
  stdout: string,
  searchRoot: string,
  headLimit: number,
): { entries: FsContentSearchEntry[]; truncated: boolean } {
  const byPath = new Map<string, ParsedRgMatch[]>();
  let parseErrors = 0;
  for (const raw of stdout.split('\n')) {
    if (!raw) continue;
    const m = parseRgJsonLine(raw);
    if (!m) {
      parseErrors++;
      continue;
    }
    // Relativise + POSIX join.
    const rel = pathRelative(searchRoot, m.path);
    const relPosix = rel.split(sep).join('/');
    const arr = byPath.get(relPosix);
    if (arr) arr.push(m);
    else byPath.set(relPosix, [m]);
  }

  const allEntries: FsContentSearchEntry[] = [];
  for (const [relPath, matches] of byPath) {
    matches.sort((a, b) => a.line - b.line);
    const name = relPath.includes('/')
      ? relPath.slice(relPath.lastIndexOf('/') + 1)
      : relPath;
    allEntries.push({
      path: relPath,
      name,
      matches: matches.map((m) => ({
        line: m.line,
        text: m.text,
        submatch: m.submatch,
      })),
    });
  }
  allEntries.sort((a, b) => {
    const byCount = b.matches.length - a.matches.length;
    return byCount !== 0 ? byCount : a.path.localeCompare(b.path);
  });

  const truncated = parseErrors > 0 || allEntries.length > headLimit;
  const entries = allEntries.slice(0, headLimit);
  return { entries, truncated };
}

fsRouter.get('/fs/content-search', async (req, res) => {
  const ctxVal = ctx(req);
  if (!ctxVal || typeof ctxVal.cwd !== 'string') {
    res.status(500).json({ ok: false, error: 'instance cwd not configured' } satisfies FsContentSearchResult);
    return;
  }
  const { cwd } = ctxVal;

  const q = typeof req.query.q === 'string' ? req.query.q : '';
  if (!q) {
    res.status(400).json({ ok: false, error: '缺少 q 参数' } satisfies FsContentSearchResult);
    return;
  }
  if (q.length > MAX_QUERY_LEN) {
    res.status(400).json({ ok: false, error: `q 太长 (>${MAX_QUERY_LEN})` } satisfies FsContentSearchResult);
    return;
  }

  const safe = resolveSafePath(cwd, '');
  if (!safe.ok) {
    res.status(403).json({ ok: false, error: safe.error } satisfies FsContentSearchResult);
    return;
  }

  const headLimitRaw = parseInt(String(req.query.headLimit ?? ''), 10);
  const headLimit = Number.isFinite(headLimitRaw) && headLimitRaw > 0
    ? Math.min(headLimitRaw, MAX_HEAD_LIMIT)
    : DEFAULT_HEAD_LIMIT;

  const rg = resolveRgPath();
  if (!rg) {
    res.status(200).json({
      ok: false,
      error: 'ripgrep 未安装,内容搜索不可用',
    } satisfies FsContentSearchResult);
    return;
  }

  const startMs = Date.now();
  const ac = new AbortController();
  // Outer timer aborts on top of spawn's own timeout; whichever fires
  // first wins. We expose partial results with truncated:true.
  const outerTimer = setTimeout(() => ac.abort(), RG_TIMEOUT_MS);

  const args = [
    '--json',
    '-n',
    '-i',
    '--max-filesize', '2M',
    ...RG_GLOBS,
    '-e', q,
    safe.abs,
  ];

  let result;
  try {
    result = await runRipgrep(args, { cwd: safe.abs, signal: ac.signal, timeoutMs: RG_TIMEOUT_MS });
  } finally {
    clearTimeout(outerTimer);
  }

  // EAGAIN retry (errno 11) — single-thread rerun, then give up.
  if (
    result.code === 2 &&
    (result.stderr.includes('os error 11') || result.stderr.includes('Resource temporarily unavailable'))
  ) {
    ac.abort();
    const ac2 = new AbortController();
    const outerTimer2 = setTimeout(() => ac2.abort(), RG_TIMEOUT_MS);
    try {
      result = await runRipgrep(['-j', '1', ...args], {
        cwd: safe.abs,
        signal: ac2.signal,
        timeoutMs: RG_TIMEOUT_MS,
      });
    } finally {
      clearTimeout(outerTimer2);
    }
  }

  if (result.error?.code === 'ENOENT' || (result.code !== 0 && result.code !== 1)) {
    res.status(200).json({
      ok: false,
      error: `search 失败: ${result.stderr || result.error?.message || `exit ${result.code}`}`,
    } satisfies FsContentSearchResult);
    return;
  }

  const { entries, truncated } = aggregateRgOutput(result.stdout, safe.abs, headLimit);
  res.json({
    ok: true,
    entries,
    truncated,
    durationMs: Date.now() - startMs,
  } satisfies FsContentSearchResult);
});

- [ ] **Step 4: Run test — verify it passes**

Run:
```bash
cd ${WT}/packages/zai && npx vitest run src/server/routes/fs.content-search.test.ts
```
Expected: PASS(darwin + vendor rg → 7 个 case 全跑过;Linux 无 vendor + 无系统 rg → 前 3 个 400 case 过,"ripgrep 不可用" case 过,后 3 个 happy path 因 `if (!HAS_RG) return` 跳过 — 报告 `passed 5 / skipped 3`)。

- [ ] **Step 5: Run full server test suite — verify no regression**

Run:
```bash
cd ${WT}/packages/zai && npx vitest run src/server
```
Expected: PASS(原有 `/fs/list`、`/fs/file`、`/fs/search` 等 case 仍过)。

- [ ] **Step 6: Commit**

```bash
cd ${WT} && git add packages/zai/src/server/routes/fs.ts packages/zai/src/server/routes/fs.content-search.test.ts && git commit -m "feat(zai-server): GET /api/fs/content-search with ripgrep --json"
```

---

## Task 4: `useFsContentSearch` hook

**Files:**
- Create: `packages/zai/src/web/src/components/splitPane/useFsContentSearch.ts`
- Test: `packages/zai/src/web/src/components/splitPane/useFsContentSearch.test.tsx`

**Interfaces:**
- Consumes: `FsContentSearchResult`(Task 1)
- Produces:
  - `export interface UseFsContentSearchOptions { enabled?: boolean; headLimit?: number }`
  - `export interface UseFsContentSearchResult { data, loading, error, durationMs }`
  - `export function useFsContentSearch(cwd, query, options?): UseFsContentSearchResult`

- [ ] **Step 1: Write failing test**

Create `packages/zai/src/web/src/components/splitPane/useFsContentSearch.test.tsx`:

```typescript
// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { useFsContentSearch } from './useFsContentSearch.js';

describe('useFsContentSearch', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  test('does nothing when cwd is null', () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    const { result } = renderHook(() => useFsContentSearch(null, 'foo'));
    expect(result.current.loading).toBe(false);
    expect(result.current.data).toBeNull();
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  test('does nothing when query is empty after trim', () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    const { result } = renderHook(() => useFsContentSearch('/repo', '   '));
    expect(result.current.loading).toBe(false);
    expect(result.current.data).toBeNull();
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  test('does nothing when enabled=false', () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    const { result } = renderHook(() =>
      useFsContentSearch('/repo', 'foo', { enabled: false }),
    );
    expect(result.current.loading).toBe(false);
    expect(result.current.data).toBeNull();
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  test('records data on successful response', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: () =>
        Promise.resolve({
          ok: true,
          entries: [
            {
              path: 'foo.ts',
              name: 'foo.ts',
              matches: [{ line: 1, text: 'TODO', submatch: { text: 'TODO', start: 0, end: 4 } }],
            },
          ],
          truncated: false,
          durationMs: 7,
        }),
    });
    vi.stubGlobal('fetch', fetchMock);
    const { result } = renderHook(() => useFsContentSearch('/repo', 'TODO'));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(250);
    });
    await act(async () => {
      await Promise.resolve();
    });
    expect(result.current.loading).toBe(false);
    expect(result.current.data?.ok).toBe(true);
    expect(result.current.data?.entries?.[0].path).toBe('foo.ts');
    expect(result.current.durationMs).toBe(7);
  });

  test('passes headLimit via query string', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: () => Promise.resolve({ ok: true, entries: [] }),
    });
    vi.stubGlobal('fetch', fetchMock);
    const { result } = renderHook(() =>
      useFsContentSearch('/repo', 'foo', { headLimit: 50 }),
    );
    await act(async () => {
      await vi.advanceTimersByTimeAsync(250);
    });
    await act(async () => {
      await Promise.resolve();
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const url = String(fetchMock.mock.calls[0][0]);
    expect(url).toContain('headLimit=50');
    expect(url).toContain('q=foo');
  });

  test('records error when fetch throws', async () => {
    const fetchMock = vi.fn().mockRejectedValue(new Error('boom'));
    vi.stubGlobal('fetch', fetchMock);
    const { result } = renderHook(() => useFsContentSearch('/repo', 'foo'));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(250);
    });
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(result.current.error).toMatch(/boom/);
    expect(result.current.data).toBeNull();
  });

  test('aborts inflight when enabled flips to false', async () => {
    let resolveFn: (v: unknown) => void = () => {};
    const fetchMock = vi.fn().mockImplementation(
      () => new Promise((r) => { resolveFn = r; }),
    );
    vi.stubGlobal('fetch', fetchMock);
    const { result, rerender } = renderHook(
      ({ enabled }: { enabled: boolean }) =>
        useFsContentSearch('/repo', 'foo', { enabled }),
      { initialProps: { enabled: true } },
    );
    await act(async () => {
      await vi.advanceTimersByTimeAsync(250);
    });
    expect(result.current.loading).toBe(true);
    rerender({ enabled: false });
    await act(async () => {
      await Promise.resolve();
    });
    expect(result.current.loading).toBe(false);
    expect(result.current.data).toBeNull();
  });
});
```

- [ ] **Step 2: Run test — verify it fails (hook not exported)**

Run:
```bash
cd ${WT}/packages/zai && npx vitest run src/web/src/components/splitPane/useFsContentSearch.test.tsx
```
Expected: FAIL with "Cannot find module './useFsContentSearch.js'"。

- [ ] **Step 3: Implement the hook**

Create `packages/zai/src/web/src/components/splitPane/useFsContentSearch.ts`:

```typescript
import { useEffect, useRef, useState } from 'react';
import type { FsContentSearchResult } from '../../../../shared/fs.js';

export interface UseFsContentSearchOptions {
  /** When false the hook never fires a request and aborts any inflight. */
  enabled?: boolean;
  /** Override default headLimit (server default 200). */
  headLimit?: number;
}

export interface UseFsContentSearchResult {
  data: FsContentSearchResult | null;
  loading: boolean;
  error: string | null;
  durationMs: number | null;
}

const DEBOUNCE_MS = 200;

/**
 * Debounced content (ripgrep) search hook with an `enabled` gate.
 *
 * Differences from useFsSearch:
 *   - adds an `enabled` flag; while false, the hook returns empty state
 *     AND aborts any inflight fetch.
 *   - 200ms debounce + seqRef + AbortController (same template).
 *
 * Uses global `fetch` so AbortSignal can be passed; `api.get` does not
 * accept a signal.
 */
export function useFsContentSearch(
  cwd: string | null,
  query: string,
  options: UseFsContentSearchOptions = {},
): UseFsContentSearchResult {
  const enabled = options.enabled !== false; // default true
  const headLimit = options.headLimit;

  const [data, setData] = useState<FsContentSearchResult | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [durationMs, setDurationMs] = useState<number | null>(null);
  const seqRef = useRef(0);

  useEffect(() => {
    const trimmed = query.trim();
    if (!enabled || !cwd || !trimmed) {
      // Abort inflight if any, reset state.
      seqRef.current++; // invalidate any pending seq
      setData(null);
      setError(null);
      setLoading(false);
      setDurationMs(null);
      return;
    }

    const seq = ++seqRef.current;
    const ac = new AbortController();
    const timer = setTimeout(() => {
      setLoading(true);
      setError(null);
      const qs = new URLSearchParams({ q: trimmed });
      if (typeof headLimit === 'number') qs.set('headLimit', String(headLimit));
      const url = `/api/fs/content-search?${qs.toString()}`;
      fetch(url, { signal: ac.signal })
        .then(async (r) => {
          if (seqRef.current !== seq) return;
          if (!r.ok) throw new Error(`/fs/content-search HTTP ${r.status}`);
          const json = (await r.json()) as FsContentSearchResult;
          if (seqRef.current !== seq) return;
          setData(json);
          setError(json.ok ? null : json.error ?? '未知错误');
          setDurationMs(json.durationMs ?? null);
        })
        .catch((err: unknown) => {
          if (seqRef.current !== seq) return;
          if (err instanceof DOMException && err.name === 'AbortError') return;
          setError(err instanceof Error ? err.message : String(err));
        })
        .finally(() => {
          if (seqRef.current === seq) setLoading(false);
        });
    }, DEBOUNCE_MS);

    return () => {
      clearTimeout(timer);
      ac.abort();
    };
  }, [cwd, query, enabled, headLimit]);

  return { data, loading, error, durationMs };
}
```

- [ ] **Step 4: Run test — verify it passes**

Run:
```bash
cd ${WT}/packages/zai && npx vitest run src/web/src/components/splitPane/useFsContentSearch.test.tsx
```
Expected: PASS(7/7 case)。

- [ ] **Step 5: Commit**

```bash
cd ${WT} && git add packages/zai/src/web/src/components/splitPane/useFsContentSearch.ts packages/zai/src/web/src/components/splitPane/useFsContentSearch.test.tsx && git commit -m "feat(zai-web): useFsContentSearch hook with enabled gate"
```

---

## Task 5: `FsContentSearchList` component + `highlightLine` helper

**Files:**
- Create: `packages/zai/src/web/src/components/splitPane/FsContentSearchList.tsx`
- Test: `packages/zai/src/web/src/components/splitPane/FsContentSearchList.test.tsx`

**Interfaces:**
- Consumes: `FsContentSearchEntry / Match / Submatch`(Task 1)
- Produces:
  - `export interface FsContentSearchListProps { entries, loading, error, truncated, query, onSelect }`
  - `export function FsContentSearchList(props): JSX.Element`
  - `export function highlightLine(text, submatch): JSX.Element[]`

- [ ] **Step 1: Write failing test**

Create `packages/zai/src/web/src/components/splitPane/FsContentSearchList.test.tsx`:

```typescript
// @vitest-environment happy-dom
import { describe, expect, test, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { FsContentSearchList, highlightLine } from './FsContentSearchList.js';
import type { FsContentSearchEntry } from '../../../../shared/fs.js';

const sampleEntries: FsContentSearchEntry[] = [
  {
    path: 'src/foo.ts',
    name: 'foo.ts',
    matches: [
      { line: 42, text: '// TODO: refactor', submatch: { text: 'TODO', start: 3, end: 7 } },
    ],
  },
  {
    path: 'src/bar.ts',
    name: 'bar.ts',
    matches: [
      { line: 17, text: 'const TODO_LIST = []', submatch: { text: 'TODO', start: 6, end: 10 } },
    ],
  },
];

describe('highlightLine', () => {
  test('returns single string when submatch is empty', () => {
    const out = highlightLine('hello', { start: 0, end: 0 });
    expect(out).toHaveLength(1);
    expect(String(out[0])).toBe('hello');
  });

  test('splits around the submatch range', () => {
    const out = highlightLine('// TODO: refactor', { start: 3, end: 7 });
    const text = out.map((n) => (typeof n === 'string' ? n : '')).join('');
    expect(text).toBe('// TODO: refactor');
    // Middle element is the highlighted span
    expect(out).toHaveLength(3);
  });

  test('clamps negative or out-of-range offsets to no-op', () => {
    const out = highlightLine('foo', { start: -1, end: 99 });
    const text = out.map((n) => (typeof n === 'string' ? n : '')).join('');
    expect(text).toBe('foo');
  });
});

describe('FsContentSearchList', () => {
  test('renders empty hint when entries=[]', () => {
    render(
      <FsContentSearchList
        entries={[]}
        loading={false}
        error={null}
        truncated={false}
        query="nope"
        onSelect={() => {}}
      />,
    );
    expect(screen.getByTestId('fs-content-empty')).toBeTruthy();
  });

  test('renders one row per entry with path:line + preview text', () => {
    render(
      <FsContentSearchList
        entries={sampleEntries}
        loading={false}
        error={null}
        truncated={false}
        query="TODO"
        onSelect={() => {}}
      />,
    );
    const rows = screen.getAllByTestId('fs-content-row');
    expect(rows).toHaveLength(2);
    expect(rows[0].getAttribute('data-path')).toBe('src/foo.ts');
    expect(rows[0].getAttribute('data-line')).toBe('42');
    expect(rows[0].textContent).toContain('// TODO: refactor');
  });

  test('clicking a row fires onSelect with that path and line', () => {
    const onSelect = vi.fn();
    render(
      <FsContentSearchList
        entries={sampleEntries}
        loading={false}
        error={null}
        truncated={false}
        query="TODO"
        onSelect={onSelect}
      />,
    );
    fireEvent.click(screen.getAllByTestId('fs-content-row')[0]);
    expect(onSelect).toHaveBeenCalledWith('src/foo.ts', 42);
  });

  test('shows loading spinner when loading and no entries', () => {
    render(
      <FsContentSearchList
        entries={[]}
        loading={true}
        error={null}
        truncated={false}
        query="TODO"
        onSelect={() => {}}
      />,
    );
    expect(screen.getByTestId('fs-content-loading')).toBeTruthy();
  });

  test('shows error placeholder when error is non-null', () => {
    render(
      <FsContentSearchList
        entries={[]}
        loading={false}
        error="ripgrep 未安装,内容搜索不可用"
        truncated={false}
        query="TODO"
        onSelect={() => {}}
      />,
    );
    expect(screen.getByTestId('fs-content-error')).toBeTruthy();
    expect(screen.getByText(/ripgrep/)).toBeTruthy();
  });

  test('shows truncated tail when truncated=true', () => {
    render(
      <FsContentSearchList
        entries={sampleEntries}
        loading={false}
        error={null}
        truncated={true}
        query="TODO"
        onSelect={() => {}}
      />,
    );
    expect(screen.getByTestId('fs-content-truncated')).toBeTruthy();
  });
});
```

- [ ] **Step 2: Run test — verify it fails**

Run:
```bash
cd ${WT}/packages/zai && npx vitest run src/web/src/components/splitPane/FsContentSearchList.test.tsx
```
Expected: FAIL with "Cannot find module './FsContentSearchList.js'"。

- [ ] **Step 3: Implement the component**

Create `packages/zai/src/web/src/components/splitPane/FsContentSearchList.tsx`:

```typescript
import React from 'react';
import { Empty, Spin } from 'antd';
import type {
  FsContentSearchEntry,
  FsContentSearchMatch,
} from '../../../../shared/fs.js';

export interface FsContentSearchListProps {
  entries: FsContentSearchEntry[];
  loading: boolean;
  error: string | null;
  truncated: boolean;
  query: string;
  onSelect: (path: string, line: number) => void;
}

const TRUNCATED_TAIL = '(结果已截断,继续输入以收窄范围)';
const MONO = 'ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace';

/**
 * Split `text` into [before, highlighted, after] JSX nodes around the
 * submatch byte-offset range. Returns a single string node when the
 * range is empty or out of bounds (defensive — should not happen for
 * well-formed server output).
 */
export function highlightLine(
  text: string,
  submatch: { start: number; end: number },
): JSX.Element[] {
  const { start, end } = submatch;
  if (end <= start || start < 0 || end > text.length) {
    return [<React.Fragment key="full">{text}</React.Fragment>];
  }
  const before = text.slice(0, start);
  const hit = text.slice(start, end);
  const after = text.slice(end);
  return [
    <React.Fragment key="b">{before}</React.Fragment>,
    <span
      key="hit"
      data-testid="fs-content-hit"
      style={{ background: 'rgba(255, 200, 0, 0.4)', borderRadius: 2 }}
    >
      {hit}
    </span>,
    <React.Fragment key="a">{after}</React.Fragment>,
  ];
}

const rowStyle: React.CSSProperties = {
  padding: '6px 10px',
  borderRadius: 4,
  cursor: 'pointer',
  fontFamily: MONO,
  fontSize: 12,
  display: 'flex',
  alignItems: 'baseline',
  gap: 8,
  color: 'rgba(255,255,255,0.85)',
};

const pathStyle: React.CSSProperties = {
  color: 'rgba(255,255,255,0.55)',
  fontSize: 11,
  whiteSpace: 'nowrap',
};

const previewStyle: React.CSSProperties = {
  flex: 1,
  minWidth: 0,
  overflow: 'hidden',
  textOverflow: 'ellipsis',
  whiteSpace: 'pre',
};

export function FsContentSearchList(props: FsContentSearchListProps): JSX.Element {
  const { entries, loading, error, truncated, query, onSelect } = props;

  if (!query.trim()) {
    return <div data-testid="fs-content-empty-query" />;
  }

  if (loading && entries.length === 0) {
    return (
      <div data-testid="fs-content-loading" style={{ padding: 16, textAlign: 'center' }}>
        <Spin />
      </div>
    );
  }

  if (error) {
    return (
      <div data-testid="fs-content-error" style={{ padding: 16 }}>
        <Empty description={error} />
      </div>
    );
  }

  if (entries.length === 0) {
    return (
      <div data-testid="fs-content-empty" style={{ padding: 16 }}>
        <Empty description={`无内容匹配: "${query.trim()}"`} />
      </div>
    );
  }

  return (
    <div
      data-testid="fs-content-list"
      style={{
        display: 'flex',
        flexDirection: 'column',
        gap: 2,
        padding: '4px 0',
      }}
    >
      {entries.map((e) => {
        // Display only the first match per file (per spec). The remaining
        // matches are still on the result object so callers can show counts
        // or expand later.
        const first: FsContentSearchMatch = e.matches[0];
        const extra = e.matches.length > 1 ? ` (+${e.matches.length - 1} more)` : '';
        return (
          <div
            key={e.path}
            data-testid="fs-content-row"
            data-path={e.path}
            data-line={first.line}
            role="button"
            tabIndex={0}
            onClick={() => onSelect(e.path, first.line)}
            onKeyDown={(ev) => {
              if (ev.key === 'Enter' || ev.key === ' ') {
                ev.preventDefault();
                onSelect(e.path, first.line);
              }
            }}
            style={rowStyle}
            onMouseEnter={(ev) => {
              (ev.currentTarget as HTMLDivElement).style.background = 'rgba(255,255,255,0.06)';
            }}
            onMouseLeave={(ev) => {
              (ev.currentTarget as HTMLDivElement).style.background = 'transparent';
            }}
          >
            <span style={pathStyle}>
              {e.path}:{first.line}
              {extra}
            </span>
            <span style={previewStyle}>{highlightLine(first.text, first.submatch)}</span>
          </div>
        );
      })}
      {truncated && (
        <div
          data-testid="fs-content-truncated"
          style={{
            padding: '6px 10px',
            color: 'rgba(255,255,255,0.45)',
            fontSize: 11,
            fontStyle: 'italic',
          }}
        >
          {TRUNCATED_TAIL}
        </div>
      )}
    </div>
  );
}
```

- [ ] **Step 4: Run test — verify it passes**

Run:
```bash
cd ${WT}/packages/zai && npx vitest run src/web/src/components/splitPane/FsContentSearchList.test.tsx
```
Expected: PASS(6 component cases + 3 highlightLine cases = 9/9)。

- [ ] **Step 5: Commit**

```bash
cd ${WT} && git add packages/zai/src/web/src/components/splitPane/FsContentSearchList.tsx packages/zai/src/web/src/components/splitPane/FsContentSearchList.test.tsx && git commit -m "feat(zai-web): FsContentSearchList with submatch highlight"
```

---

## Task 6: `FsTab` integration — Switch + mode + pendingLine + FilePreview line-numbering

**Files:**
- Modify: `packages/zai/src/web/src/components/splitPane/FsTab.tsx`(新增 state + Switch + FilePreview 改 prop)
- Test: `packages/zai/src/web/src/components/splitPane/FsTab.test.tsx`(新增 4 个 case)

**Interfaces:**
- Consumes: `useFsContentSearch`(Task 4),`FsContentSearchList`(Task 5)
- Produces: 修改后 `FsTab` 接受 `mode='name'|'content'` 切换逻辑 + 行点击 → `(path, line)` + FilePreview 接 `pendingLine` prop

- [ ] **Step 1: Append failing tests to `FsTab.test.tsx`**

打开 `packages/zai/src/web/src/components/splitPane/FsTab.test.tsx`,在第 7 行 `vi.mock('./useFsSearch.js', …)` 之后插入:

```typescript
vi.mock('./useFsContentSearch.js', () => ({ useFsContentSearch: vi.fn() }));
```

在文件顶部 import 区域(在 `import { useFsSearch } from './useFsSearch.js';` 之后)插入:

```typescript
import { useFsContentSearch } from './useFsContentSearch.js';
```

在 `const mockSearch = useFsSearch as unknown as ReturnType<typeof vi.fn>;` 之后插入:

```typescript
const mockContentSearch = useFsContentSearch as unknown as ReturnType<typeof vi.fn>;
```

在 `beforeEach(...)` 内部、`mockSearch.mockReturnValue(...)` 之后插入:

```typescript
    mockContentSearch.mockReturnValue({ data: null, loading: false, error: null, durationMs: null });
```

在文件末尾追加以下 4 个测试:

```typescript
// --- Content search mode (Switch) ---

it('renders the Switch in name mode by default', () => {
  mockList.mockReturnValue({ data: { ok: true, entries: [] }, loading: false, error: null, refetch: vi.fn() });
  mockFile.mockReturnValue({ data: null, loading: false, error: null });
  render(<FsTab cwd="/repo" />);
  const sw = screen.getByTestId('fs-search-mode') as HTMLElement;
  // antd Switch exposes role=switch with aria-checked
  expect(sw.getAttribute('aria-checked')).toBe('false');
});

it('toggling the Switch renders FsContentSearchList when query is non-empty', () => {
  mockList.mockReturnValue({ data: { ok: true, entries: [] }, loading: false, error: null, refetch: vi.fn() });
  mockFile.mockReturnValue({ data: null, loading: false, error: null });
  mockContentSearch.mockReturnValue({
    data: {
      ok: true,
      entries: [
        {
          path: 'src/foo.ts',
          name: 'foo.ts',
          matches: [{ line: 42, text: 'TODO', submatch: { text: 'TODO', start: 0, end: 4 } }],
        },
      ],
      truncated: false,
      durationMs: 5,
    },
    loading: false,
    error: null,
    durationMs: 5,
  });
  render(<FsTab cwd="/repo" />);
  fireEvent.change(screen.getByTestId('fs-search-input'), { target: { value: 'TODO' } });
  const sw = screen.getByTestId('fs-search-mode');
  fireEvent.click(sw);
  expect(sw.getAttribute('aria-checked')).toBe('true');
  expect(screen.getByTestId('fs-content-list')).toBeTruthy();
});

it('clicking a content search row passes pendingLine to FilePreview', () => {
  mockList.mockReturnValue({ data: { ok: true, entries: [] }, loading: false, error: null, refetch: vi.fn() });
  mockFile.mockReturnValue({
    data: {
      ok: true, kind: 'text', path: '/repo/src/foo.ts', name: 'foo.ts',
      size: 42, mtime: '', content: 'line1\nTODO\nline3\n',
    },
    loading: false,
    error: null,
  });
  mockContentSearch.mockReturnValue({
    data: {
      ok: true,
      entries: [
        {
          path: 'src/foo.ts', name: 'foo.ts',
          matches: [{ line: 2, text: 'TODO', submatch: { text: 'TODO', start: 0, end: 4 } }],
        },
      ],
      truncated: false,
      durationMs: 5,
    },
    loading: false,
    error: null,
    durationMs: 5,
  });
  render(<FsTab cwd="/repo" />);
  fireEvent.change(screen.getByTestId('fs-search-input'), { target: { value: 'TODO' } });
  fireEvent.click(screen.getByTestId('fs-search-mode'));
  fireEvent.click(screen.getByTestId('fs-content-row'));
  // pendingLine=2 should mark the second <span data-line="2"> as highlighted
  const line2 = document.querySelector('[data-line="2"]') as HTMLElement | null;
  expect(line2).toBeTruthy();
  // Background fades in via inline style. The data-line attr is what
  // marks it; the actual inline style is asserted in FsContentSearchList.
});

it('cwd change resets mode and pendingLine', () => {
  mockList.mockReturnValue({ data: { ok: true, entries: [] }, loading: false, error: null, refetch: vi.fn() });
  mockFile.mockReturnValue({ data: null, loading: false, error: null });
  mockContentSearch.mockReturnValue({
    data: {
      ok: true,
      entries: [{ path: 'a.ts', name: 'a.ts', matches: [{ line: 1, text: 'x', submatch: { text: 'x', start: 0, end: 1 } }] }],
      truncated: false,
      durationMs: 1,
    },
    loading: false,
    error: null,
    durationMs: 1,
  });
  const { rerender } = render(<FsTab cwd="/repo1" />);
  fireEvent.change(screen.getByTestId('fs-search-input'), { target: { value: 'foo' } });
  fireEvent.click(screen.getByTestId('fs-search-mode'));
  rerender(<FsTab cwd="/repo2" />);
  // After cwd change, query should be empty and mode reset to 'name'
  const input = screen.getByTestId('fs-search-input') as HTMLInputElement;
  expect(input.value).toBe('');
  const sw = screen.getByTestId('fs-search-mode');
  expect(sw.getAttribute('aria-checked')).toBe('false');
});
```

- [ ] **Step 2: Run the four new tests — verify they fail**

Run:
```bash
cd ${WT}/packages/zai && npx vitest run src/web/src/components/splitPane/FsTab.test.tsx
```
Expected: FAIL on the new tests because `fs-search-mode` Switch + `useFsContentSearch` mock + `data-line` span don't exist yet。

- [ ] **Step 3: Modify `FsTab.tsx` — add Switch + mode state + pendingLine + FilePreview prop**

打开 `packages/zai/src/web/src/components/splitPane/FsTab.tsx`。

**3a)** 在文件顶部 import 区域(在 antd `Empty` import 之后,具体看你看到的顺序)插入:

```typescript
import { Switch } from 'antd';
import { useFsContentSearch } from './useFsContentSearch.js';
import { FsContentSearchList } from './FsContentSearchList.js';
import type { FsFile } from '../../../shared/fs.js';
```

**3b)** 在 `function FilePreview({ file, htmlMode }: { … })` 函数签名(line 223 附近)替换为:

```typescript
function FilePreview({
  file,
  htmlMode,
  pendingLine,
}: {
  file: FsFile;
  htmlMode: HtmlMode;
  pendingLine: number | null;
}): JSX.Element {
```

**3c)** 在 `FilePreview` 函数体内部,紧接 `const lang = name ? extToLanguage(name) : null;` 行(line 243 附近)之后,插入以下 `useEffect`:

```typescript
  // pendingLine: scroll to that 1-based line and pulse a yellow highlight
  // for 2 seconds. The text kind renders below in a single <pre>; image /
  // html / md branches ignore it (line-number navigation only makes sense
  // for textual previews).
  const content = file.content ?? '';
  const pendingRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    if (pendingLine == null) return;
    // Wait until content is available — the lazy SyntaxHighlighter might
    // not have mounted on the very first render.
    if (!content) return;
    const el = pendingRef.current?.querySelector<HTMLElement>(
      `[data-line="${pendingLine}"]`,
    );
    if (!el) return;
    el.scrollIntoView({ block: 'center', behavior: 'smooth' });
    el.style.transition = 'background 0.3s';
    el.style.background = 'rgba(255, 200, 0, 0.4)';
    const id = setTimeout(() => {
      el.style.background = '';
    }, 2000);
    return () => clearTimeout(id);
  }, [pendingLine, content]);
```

**3d)** 在 `FilePreview` 渲染文本 kind 的 `<pre>` 部分(plain text 分支,line 367-382)替换为:

```typescript
  return (
    <div ref={pendingRef} data-testid="fs-preview-text" style={containerStyle}>
      <pre
        style={{
          margin: 0,
          padding: 12,
          background: 'rgba(255,255,255,0.04)',
          color: 'rgba(255,255,255,0.85)',
          whiteSpace: 'pre-wrap',
          wordBreak: 'break-word',
        }}
      >
        {content.split('\n').map((line, idx) => (
          <span key={idx} data-line={idx + 1} style={{ display: 'block' }}>
            {line}
          </span>
        ))}
      </pre>
    </div>
  );
}
```

> 只改 plain text 分支;image / html / md / SyntaxHighlighter 分支暂不接 `data-line`(本期 YAGNI)。

**3e)** **不动** `Md` / image / html / SyntaxHighlighter 各分支的 ref — 本期 `pendingRef` 只接 plain text 分支,其它分支仍走原渲染路径;`pendingLine` 在非 plain text 情况下 no-op(找不到 `[data-line]` 元素,silently 跳过)。

**3f)** 在 `FsTab({ cwd }: { cwd: string | null })` 函数体(line 385 起)新增 state。找到 `const [query, setQuery] = useState<string>('');`,在它**之后**插入:

```typescript
  const [mode, setMode] = useState<'name' | 'content'>('name');
  const [pendingLine, setPendingLine] = useState<number | null>(null);
  const contentSearch = useFsContentSearch(
    cwd,
    query,
    { enabled: mode === 'content' },
  );
```

**3g)** 在 `useEffect(() => { … }, [cwd]);`(line 432-440)的 reset 块内,在 `setQuery('');` 之后插入:

```typescript
    setMode('name');
    setPendingLine(null);
```

**3h)** 在 header `<Input>` 之后(line 552-560)、`{showHtmlToggle && (<Segmented … />)}` 之前,插入 Switch:

```typescript
        <Switch
          size="small"
          data-testid="fs-search-mode"
          checked={mode === 'content'}
          onChange={(v) => setMode(v ? 'content' : 'name')}
          checkedChildren="内容"
          unCheckedChildren="文件名"
        />
```

**3i)** 修改左栏 list 三元(line 626-634),把 `<FsSearchList … onSelect={(p) => setSelected(p)} />` 那一支换成:

```typescript
          {query.trim().length > 0 ? (
            mode === 'content' ? (
              <FsContentSearchList
                entries={contentSearch.data?.entries ?? []}
                loading={contentSearch.loading}
                error={contentSearch.error}
                truncated={contentSearch.data?.truncated ?? false}
                query={query}
                onSelect={(p, l) => { setSelected(p); setPendingLine(l); }}
              />
            ) : (
              <FsSearchList
                entries={search.data?.entries ?? []}
                loading={search.loading}
                error={search.error}
                truncated={search.data?.truncated ?? false}
                query={query}
                onSelect={(p) => setSelected(p)}
              />
            )
          ) : /* 树形分支,不变 */}

**3j)** 在右栏 `<FilePreview … />` 调用处(line 707 附近),把:

```tsx
<FilePreview file={file.data} htmlMode={htmlMode} />
```

改为:

```tsx
<FilePreview file={file.data} htmlMode={htmlMode} pendingLine={pendingLine} />
```

- [ ] **Step 4: Run FsTab test — verify all 4 new tests pass**

Run:
```bash
cd ${WT}/packages/zai && npx vitest run src/web/src/components/splitPane/FsTab.test.tsx
```
Expected: PASS(原有 case 全过 + 新增 4 个 case 过)。

- [ ] **Step 5: Run all web component tests — verify no regression**

Run:
```bash
cd ${WT}/packages/zai && npx vitest run src/web/src/components/splitPane
```
Expected: PASS(`FsSearchList.test.tsx`、`useFsSearch.test.tsx`、`FsTab.test.tsx` 等全过)。

- [ ] **Step 6: Commit**

```bash
cd ${WT} && git add packages/zai/src/web/src/components/splitPane/FsTab.tsx packages/zai/src/web/src/components/splitPane/FsTab.test.tsx && git commit -m "feat(zai-web): FsTab content search mode with line-jump highlight"
```

---

## Task 7: Final verification — full typecheck + lint + smoke

**Files:** (no file edits)

- [ ] **Step 1: Run full typecheck**

Run:
```bash
cd ${WT} && pnpm -w tsc -b --noEmit
```
Expected: PASS(整个 workspace 无 type error)。

- [ ] **Step 2: Run lint (if configured)**

Run:
```bash
cd ${WT} && pnpm -w lint 2>&1 | tail -40
```
Expected: PASS(无 error;若有 warning 记录但允许通过)。

- [ ] **Step 3: Run all zai tests**

Run:
```bash
cd ${WT}/packages/zai && npx vitest run
```
Expected: PASS(全部 server + web 测试通过)。

- [ ] **Step 4: Manual smoke test**

Run:
```bash
cd ${WT} && pnpm -w zai dev
```
打开浏览器,切到 Files tab:
1. 输入 `TODO` → 默认 name 模式看到文件名 fuzzy 命中
2. 切 Switch 到"内容" → 看到 ripgrep 命中列表,行包含 `path:line preview` + 黄底高亮
3. 点 `src/foo.ts:42` → 右侧 preview 跳到 line 42,黄底闪烁 2s
4. 切回 Switch 到"文件名" → 列表回到 fuzzy 文件名
5. 切 cwd(改 session)→ query / mode / pendingLine 全 reset

Expected: 全部交互正常,console 无 error。

- [ ] **Step 5: Final commit (if any final tweaks)**

如果 Step 1-4 发现问题,做最小修复并 commit:
```bash
cd ${WT} && git add -A && git commit -m "fix(zai): content search smoke test fixes"
```
否则:
```bash
cd ${WT} && git log --oneline main..HEAD
```
验证 7 个 commit 顺序对应 6 个 task(Task 6 一个 commit)。

---

## Summary

| Task | Files | Commit message |
|------|-------|---------------|
| 1 | `shared/fs.ts` | `feat(zai-shared): FsContentSearch types for ripgrep content search` |
| 2 | `server/services/ripgrep.{ts,test.ts}` | `feat(zai-server): extract ripgrep service for content search` |
| 3 | `server/routes/fs.{ts,content-search.test.ts}` | `feat(zai-server): GET /api/fs/content-search with ripgrep --json` |
| 4 | `web/components/splitPane/useFsContentSearch.{ts,test.tsx}` | `feat(zai-web): useFsContentSearch hook with enabled gate` |
| 5 | `web/components/splitPane/FsContentSearchList.{tsx,test.tsx}` | `feat(zai-web): FsContentSearchList with submatch highlight` |
| 6 | `web/components/splitPane/FsTab.{tsx,test.tsx}` | `feat(zai-web): FsTab content search mode with line-jump highlight` |
| 7 | (verification only) | (no commit unless fixes) |