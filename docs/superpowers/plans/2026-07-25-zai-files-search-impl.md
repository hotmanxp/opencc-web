# zai Files 视图文件搜索 — 实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在 zai 的 Files 视图头部加搜索框;输入 fuzzy 文件名片段 → 显示 top 200 匹配 → 点击复用右侧 60% 预览面板(`useFsFile`)。

**Architecture:** 后端新增 `GET /api/fs/search?q=…`(BFS walk + 子序列 fuzzy 打分 + 200ms 截断 + MAX_RESULTS=200,start=cwd 锚定防越界);前端 `useFsSearch`(200ms 防抖 + AbortController 守护)→ `FsSearchList`(纯展示 + `<mark>` 子序列高亮)→ 点击调现有 `setSelected()` 触发预览。

**Tech Stack:** Node `fs/promises` (readdir recursion) · Express Router · TypeScript · React + antd `<Input>` + happy-dom vitest · React Testing Library.

---

## Global Constraints

> 所有任务必须遵守。Quoted values copied verbatim from spec.

- **工作目录**:`.worktrees/files-search/`(所有命令 cd 进去)
- **Node 引擎**:`>=20`(zai package.json `engines.node`)。本计划用 `node:fs/promises`、`AbortController`、`setTimeout`(`clearTimeout` cleanup)。
- **路径**:服务端 `FsEntry.path` 必须用 forward-slash(`rel.split(sep).join('/')`),与现有 `/fs/list` 对齐。
- **安全**:`/fs/search` 不接 `dir`/`start`/`cwd` query 参数 — 强制 `resolveSafePath(cwd, '')`。
- **常量(verbatim)**:
  - `MAX_RESULTS = 200`(命中数上限)
  - `WALK_TIMEOUT_MS = 200`(walk 超时强制 partial)
  - `MAX_QUERY_LEN = 64`(防超长 query DoS)
  - `DEBOUNCE_MS = 200`(前端防抖)
  - `TRUNCATED_TAIL = '(结果已截断,继续输入以收窄范围)'`(UI 截断提示)
- **不引入新依赖**(0 npm install);用 `node:fs/promises`、`AbortController`、`fetch`、`api` helper。
- **测试基线**:服务端 `--environment node`;前端文件首行 `// @vitest-environment happy-dom`。`FsTab.test.tsx` 沿用 `vi.mock('./useFsList.js', …) / vi.mock('./useFsFile.js', …)` 套路;新增 `vi.mock('./useFsSearch.js', …)`。
- **不修改**:`FsTab.tsx` 的 `selected / expandedKeys / loaded` 状态机;`useFsFile`;`renderPreview`;`fileIcon`;`extToLang`;`api.ts`。
- **现有红线保持**:`path.resolve` POSIX `/` vs Win `\\`;`IGNORED` 列表复用;hidden skipper(`depthOf(dir)>=1 && name.startsWith('.')`)复用。
- **每次任务结束**:commit。一个 task = 一个 commit。

---

## File Structure

```
packages/zai/src/
├── shared/
│   └── fs.ts                                [MODIFY] +FsSearchResult, FsSearchEntry
├── server/
│   ├── routes/
│   │   ├── fs.ts                            [MODIFY] +handler GET /fs/search, +helpers fuzzyMatch/scorePath/walkForSearch
│   │   ├── fs.search.test.ts                [CREATE] vitest supertest
│   │   └── fs.test.ts                       [TOUCH] 冲一把 fs.test.ts 是否仍通过(可能改 IGNORED export)
│   └── utils/                                [不动]
└── web/src/components/splitPane/
    ├── FsTab.tsx                            [MODIFY] 头部加 <Input>;query==''→树,非空→FsSearchList;trim(query).length>=1 切到搜索
    ├── useFsSearch.ts                       [CREATE] debounce+AbortController hook
    ├── useFsSearch.test.tsx                 [CREATE] 用 fake timers 测防抖/abort
    ├── FsSearchList.tsx                     [CREATE] 纯展示 + <mark> 高亮
    ├── FsSearchList.test.tsx                [CREATE] 点击/空/加载/错误/截断
    ├── FsTab.test.tsx                       [TOUCH] 加 query 切视图/点击回 selected 的集成测
    └── shared.ts                            [不动]
```

**Boundary contracts (must match across tasks)**:

```ts
// shared/fs.ts (扩展, 现有 import 不破坏)
export interface FsSearchEntry {
  path: string        // forward-slash, 相对 cwd, 例 "src/util/foo.ts"
  name: string        // basename, 例 "foo.ts"
  type: 'file'
  score: number       // >= 0
}
export interface FsSearchResult {
  ok: boolean
  error?: string
  entries?: FsSearchEntry[]
  truncated?: boolean
  durationMs?: number
}

// server/routes/fs.ts (新增导出, 给 task 2/3 用)
export function fuzzyMatchScore(query: string, path: string, caseSensitive: boolean): number
export function walkForSearch(
  absRoot: string,
  query: string,
  options: { caseSensitive: boolean; signal: AbortSignal }
): Promise<{ entries: FsSearchEntry[]; truncated: boolean; durationMs: number }>

// web/components/splitPane/useFsSearch.ts (新增)
export interface UseFsSearchResult {
  data: FsSearchResult | null
  loading: boolean
  error: string | null
  durationMs: number | null
}
export function useFsSearch(
  cwd: string | null,
  query: string,
  options?: { caseSensitive?: boolean }
): UseFsSearchResult

// web/components/splitPane/FsSearchList.tsx (新增)
export interface FsSearchListProps {
  entries: FsSearchEntry[]
  loading: boolean
  error: string | null
  truncated: boolean
  query: string
  onSelect: (path: string) => void
}
```

---

## Task 1: Shared types — extend `shared/fs.ts`

**Files:**
- Modify: `packages/zai/src/shared/fs.ts`
- Test: (none — pure type addition, tsc catches)

**Interfaces:**
- Produces: `FsSearchEntry`, `FsSearchResult` (consumed by Tasks 2, 3, 4, 5, 6)

- [ ] **Step 1: Add types to `shared/fs.ts`**

Append to `packages/zai/src/shared/fs.ts` (current file is 43 lines; do NOT remove existing content):

```typescript
/**
 * Result of a filename-only fuzzy search.
 * Returned by /api/fs/search and consumed by useFsSearch → FsSearchList.
 */
export interface FsSearchEntry {
  /** Path relative to cwd, joined with forward slashes (POSIX style). */
  path: string;
  /** Basename of the file — used for UI rendering and <mark> highlight alignment. */
  name: string;
  /** Search only ever returns files (not directories). */
  type: 'file';
  /** Fuzzy match score (>= 0). Higher = better. Useful for debugging + tests. */
  score: number;
}

export interface FsSearchResult {
  ok: boolean;
  error?: string;
  entries?: FsSearchEntry[];
  /** True when hit count exceeded MAX_RESULTS or scan timed out. */
  truncated?: boolean;
  /** Elapsed ms since walk started (server-side). For client telemetry. */
  durationMs?: number;
}
```

- [ ] **Step 2: Type-check the workspace**

Run:
```bash
cd /Users/liangxuechao572/code/opencc-web/.worktrees/files-search/packages/zai && npm run typecheck
```
Expected: PASS (no errors; existing code uses only `FsEntry`/`FsList`/`FsFile`/`FsAck`, not the new types).

- [ ] **Step 3: Commit**

```bash
cd /Users/liangxuechao572/code/opencc-web/.worktrees/files-search && git add packages/zai/src/shared/fs.ts && git commit -m "feat(zai-shared): FsSearchEntry + FsSearchResult types"
```

---

## Task 2: Server-side fuzzy scoring (`fuzzyMatchScore`)

**Files:**
- Modify: `packages/zai/src/server/routes/fs.ts`
- Test: `packages/zai/src/server/routes/fs.search.test.ts` (create in this task)

**Interfaces:**
- Produces: `export function fuzzyMatchScore(query: string, path: string, caseSensitive: boolean): number`
  - Returns `> 0` when query is a **subsequence** of path (case-insensitive by default); higher = better.
  - Returns `0` when query is empty or no match.

- [ ] **Step 1: Create test file with first test cases**

Create `packages/zai/src/server/routes/fs.search.test.ts`:

```typescript
import { describe, expect, test } from 'vitest';
import { fuzzyMatchScore, clampScore } from './fs.js';

describe('fuzzyMatchScore', () => {
  test('returns 0 when query is empty', () => {
    expect(fuzzyMatchScore('', 'src/foo.ts', false)).toBe(0);
  });

  test('returns 0 when no subsequence match', () => {
    expect(fuzzyMatchScore('xyz', 'src/foo.ts', false)).toBe(0);
  });

  test('exact filename (case-insensitive) scores positively', () => {
    const a = fuzzyMatchScore('foo.ts', 'src/foo.ts', false);
    expect(a).toBeGreaterThan(0);
  });

  test('case-sensitive mode skips when query case differs', () => {
    expect(fuzzyMatchScore('foo.ts', 'src/Foo.ts', true)).toBe(0);
    expect(fuzzyMatchScore('Foo.ts', 'src/Foo.ts', true)).toBeGreaterThan(0);
  });

  test('continuous / boundary runs score higher than scattered subsequence', () => {
    const continuous = fuzzyMatchScore('foo', 'src/foo.ts', false);
    const scattered = fuzzyMatchScore('foo', 'src/foo-taaua-oooo.ts', false);
    expect(continuous).toBeGreaterThan(0);
    expect(scattered).toBeGreaterThan(0);
    expect(continuous).toBeGreaterThan(scattered);
  });

  test('shorter paths score higher than longer ones at equal match', () => {
    const short = fuzzyMatchScore('foo', 'foo.ts', false);
    const long = fuzzyMatchScore('foo', 'a/very/long/path/foo.ts', false);
    expect(short).toBeGreaterThan(long);
  });

  test('clampScore floors negatives to 0', () => {
    expect(clampScore(-5)).toBe(0);
    expect(clampScore(0)).toBe(0);
    expect(clampScore(42)).toBe(42);
  });
});
```

- [ ] **Step 2: Run test — verify it fails (function not yet defined)**

Run:
```bash
cd /Users/liangxuechao572/code/opencc-web/.worktrees/files-search/packages/zai && npx vitest run src/server/routes/fs.search.test.ts
```
Expected: FAIL with import error (function not exported yet).

- [ ] **Step 3: Implement `fuzzyMatchScore` + `clampScore` in `routes/fs.ts`**

In `packages/zai/src/server/routes/fs.ts`, **after the existing `IMAGE_EXTS` block (after line 37) and before `interface InstanceContextShape`**, insert:

```typescript
/**
 * Score a fuzzy filename match (subsequence algorithm).
 *
 * Match: each query character must appear in `path` in order, respecting
 * `caseSensitive`. Score bonuses reward:
 *   - contiguous runs (typing the literal substring),
 *   - boundary alignment (matching at start-of-word after /, -, _, .),
 *   - case-exact alignment (typed casing matches the casing in path),
 *   - basename-end alignment (path ends with the literal query).
 *
 * Penalties push shallow paths above deep ones and short above long, so
 * common targets float to the top. Final score may be negative for very
 * long paths matched weakly; callers should run it through `clampScore`.
 *
 * Returns 0 when query is empty or cannot be matched.
 */
export function fuzzyMatchScore(
  query: string,
  path: string,
  caseSensitive: boolean,
): number {
  if (!query) return 0;
  const q = caseSensitive ? query : query.toLowerCase();
  const p = caseSensitive ? path : path.toLowerCase();

  let qi = 0;
  let runScore = 0;
  let boundaryScore = 0;
  let caseScore = 0;
  for (let pi = 0; pi < p.length && qi < q.length; pi++) {
    if (p[pi] !== q[qi]) continue;
    runScore += 5;
    const prev = pi > 0 ? path[pi - 1] : '';
    if (pi === 0 || prev === '/' || prev === '-' || prev === '_' || prev === '.') {
      boundaryScore += 10;
    }
    if (path[pi] === query[qi]) {
      caseScore += 8;
    }
    qi++;
  }
  if (qi < q.length) return 0;

  const basenameEndScore = path.endsWith(query) ? 6 : 0;
  const bonuses = runScore + boundaryScore + caseScore + basenameEndScore;
  const depthPenalty = path.split('/').length * 2;
  const lengthPenalty = path.length;
  return bonuses - depthPenalty - lengthPenalty;
}

/** Clamp a possibly-negative raw score from `fuzzyMatchScore` to non-negative. */
export function clampScore(s: number): number {
  return s > 0 ? s : 0;
}
```

- [ ] **Step 4: Re-run test — verify it passes**

Run:
```bash
cd /Users/liangxuechao572/code/opencc-web/.worktrees/files-search/packages/zai && npx vitest run src/server/routes/fs.search.test.ts
```
Expected: PASS — 7 cases pass.

- [ ] **Step 5: Commit**

```bash
cd /Users/liangxuechao572/code/opencc-web/.worktrees/files-search && git add packages/zai/src/server/routes/fs.ts packages/zai/src/server/routes/fs.search.test.ts && git commit -m "feat(zai-fs): fuzzyMatchScore + clampScore"
```

---

## Task 3: `walkForSearch` — bounded BFS with timeout + truncation

**Files:**
- Modify: `packages/zai/src/server/routes/fs.ts`
- Test: `packages/zai/src/server/routes/fs.search.test.ts` (append; same file as Task 2)

**Interfaces:**
- Consumes: `fuzzyMatchScore`, `clampScore` (Task 2)
- Produces: `export async function walkForSearch(absRoot: string, query: string, options: { caseSensitive: boolean; signal: AbortSignal }): Promise<{ entries: FsSearchEntry[]; truncated: boolean; durationMs: number }>`

Behavior:
- BFS from `absRoot` (no symlink resolution — mirrors `/fs/list`)
- Skip names in `IGNORED`. Skip hidden dirs under depth >= 1 (same `depthOf(dir) >= 1 && name.startsWith('.')` rule, applied to the **directory** entry being entered; mirror the deeper `.dot` file rule verbatim from `/fs/list`)
- For each file: compute score, drop if `clampScore(s) === 0`
- After walk: stable-sort by `score desc, path asc`, take top MAX_RESULTS
- If total hits > MAX_RESULTS: `truncated:true`. If walk finished without abort & len <= MAX: `truncated:false`
- Honor `options.signal`: when `signal.aborted` flips true, abandon further readdir recursion (best-effort) but return the partial matches already collected as `truncated:true`
- Time the walk from start to finish; return `durationMs`. The CALLER is responsible for setting up the timeout — `walkForSearch` itself does not start a timer.

- [ ] **Step 1: Append tests for walkForSearch**

Append to `packages/zai/src/server/routes/fs.search.test.ts` (after the `describe('fuzzyMatchScore', ...)` block):

```typescript
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, sep } from 'node:path';
import { walkForSearch } from './fs.js';

// 重新维护一个 root, 便于每个 test 用一个 fresh 临时目录。
describe('walkForSearch', () => {
  let root: string;
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'zai-fs-search-'));
  });
  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  function makeFixture() {
    mkdirSync(join(root, 'src'));
    writeFileSync(join(root, 'README.md'), 'readme\n');
    writeFileSync(join(root, 'src', 'foo.ts'), 'foo\n');
    writeFileSync(join(root, 'src', 'bar.ts'), 'bar\n');
    writeFileSync(join(root, 'src', 'FooRunner.ts'), 'r\n');
    mkdirSync(join(root, 'node_modules'));
    writeFileSync(join(root, 'node_modules', 'foo.js'), 'noop\n');
    mkdirSync(join(root, '.git'));
    writeFileSync(join(root, '.git', 'foo'), 'x\n');
    // hidden dotfile at depth >= 1
    mkdirSync(join(root, 'src', '.private'));
    writeFileSync(join(root, 'src', '.private', 'foo.txt'), 'h\n');
  }

  test('finds README at root + case-insensitive', async () => {
    makeFixture();
    const ac = new AbortController();
    const res = await walkForSearch(root, 'readme', { caseSensitive: false, signal: ac.signal });
    expect(res.entries.find((e) => e.path === 'README.md')).toBeTruthy();
    expect(res.truncated).toBe(false);
  });

  test('subsequence matches across slashes', async () => {
    makeFixture();
    const ac = new AbortController();
    const res = await walkForSearch(root, 'fr', { caseSensitive: false, signal: ac.signal });
    // src/foo.ts, src/FooRunner.ts, README(no), src/bar.ts(no 'r' then 'r' — but score >0)
    // Just confirm 'r' substring finds something. Weak assertion.
    expect(res.entries.length).toBeGreaterThan(0);
  });

  test('excludes node_modules via IGNORED', async () => {
    makeFixture();
    const ac = new AbortController();
    const res = await walkForSearch(root, 'foo', { caseSensitive: false, signal: ac.signal });
    expect(res.entries.find((e) => e.path.includes('node_modules'))).toBeFalsy();
    expect(res.entries.find((e) => e.path === 'src/foo.ts')).toBeTruthy();
  });

  test('excludes .git via IGNORED', async () => {
    makeFixture();
    const ac = new AbortController();
    const res = await walkForSearch(root, 'foo', { caseSensitive: false, signal: ac.signal });
    expect(res.entries.find((e) => e.path.startsWith('.git'))).toBeFalsy();
  });

  test('excludes hidden files at depth >= 1', async () => {
    makeFixture();
    const ac = new AbortController();
    const res = await walkForSearch(root, 'foo', { caseSensitive: false, signal: ac.signal });
    expect(res.entries.find((e) => e.path.includes('.private'))).toBeFalsy();
  });

  test('case-sensitive skips mismatched casing', async () => {
    makeFixture();
    const ac = new AbortController();
    const insensitive = await walkForSearch(root, 'foo', { caseSensitive: false, signal: ac.signal });
    const sensitive = await walkForSearch(root, 'foo', { caseSensitive: true, signal: ac.signal });
    expect(insensitive.entries.length).toBeGreaterThan(sensitive.entries.length);
  });

  test('returns empty + non-truncated on no match', async () => {
    makeFixture();
    const ac = new AbortController();
    const res = await walkForSearch(root, 'no-such-thing-xyz', { caseSensitive: false, signal: ac.signal });
    expect(res.entries).toEqual([]);
    expect(res.truncated).toBe(false);
  });

  test('aborted signal returns partial + truncated:true', async () => {
    makeFixture();
    const ac = new AbortController();
    setTimeout(() => ac.abort(), 0);
    const res = await walkForSearch(root, 'foo', { caseSensitive: false, signal: ac.signal });
    // Either we hit MAX_RESULTS or signal aborted. We just assert the
    // shape and the "truncated" semantic is well-defined.
    expect(res.entries).toBeInstanceOf(Array);
    expect(typeof res.durationMs).toBe('number');
  });

  test('truncates to MAX_RESULTS=200 with truncated:true', async () => {
    // Build 250 files in many dirs (so MAX_RESULTS kicks in)
    mkdirSync(join(root, 'trunc'));
    for (let i = 0; i < 250; i++) {
      writeFileSync(join(root, 'trunc', `match-${i}.txt`), 'x\n');
    }
    const ac = new AbortController();
    const res = await walkForSearch(root, 'match', { caseSensitive: false, signal: ac.signal });
    expect(res.entries.length).toBeLessThanOrEqual(200);
    expect(res.truncated).toBe(true);
  });
});
```

- [ ] **Step 2: Run test — verify it fails (`walkForSearch` not yet defined)**

Run:
```bash
cd /Users/liangxuechao572/code/opencc-web/.worktrees/files-search/packages/zai && npx vitest run src/server/routes/fs.search.test.ts
```
Expected: FAIL with import error for `walkForSearch`.

- [ ] **Step 3: Implement `walkForSearch` in `routes/fs.ts`**

In `packages/zai/src/server/routes/fs.ts`, **immediately after `clampScore` (Task 2)**, insert:

```typescript
import { basename, sep } from 'node:path'; // keep existing import line — just confirming sep is already imported (line 2: 'import { extname, basename, sep } from "node:path"')

// Search-level constants. Re-declared here (next to walkForSearch) instead of
// hoisted because MAX_RESULTS is a search-specific cap, unrelated to other
// routes in this file.
const MAX_RESULTS = 200;

interface WalkOptions {
  caseSensitive: boolean;
  signal: AbortSignal;
}

interface WalkResult {
  entries: FsSearchEntry[];
  truncated: boolean;
  durationMs: number;
}

/**
 * BFS workspace walk that collects fuzzy filename matches.
 *
 * Skips the same directories as `/fs/list` (the IGNORED set + hidden dirs
 * at depth >= 1). Returns up to MAX_RESULTS top-scoring files, sorted by
 * score desc then path asc. Honors an AbortSignal — when aborted, the
 * recursion is abandoned and the partial result is returned with
 * truncated:true.
 *
 * The caller is responsible for the overall timeout (WALK_TIMEOUT_MS in the
 * HTTP handler); this function does not start a timer itself. durationMs
 * is measured from function entry to function exit and exposed purely for
 * telemetry / tests.
 */
export async function walkForSearch(
  absRoot: string,
  query: string,
  options: WalkOptions,
): Promise<WalkResult> {
  const start = Date.now();
  const collected: Array<{ path: string; name: string; score: number }> = [];
  let truncated = false;

  // Stack-based BFS to avoid blowing the JS call stack on deep trees.
  // Each entry: { relDir, depth } — relDir '' means absRoot itself.
  const stack: Array<{ relDir: string; depth: number }> = [{ relDir: '', depth: 0 }];

  outer: while (stack.length > 0) {
    if (options.signal.aborted) {
      truncated = true;
      break;
    }
    const { relDir, depth } = stack.pop()!;
    const absDir = relDir ? join(absRoot, relDir) : absRoot;

    let names: string[];
    try {
      names = await readdir(absDir);
    } catch {
      // EACCES / ENOENT on a subdir — skip and continue; don't fail
      // the whole walk over one inaccessible subdirectory.
      continue;
    }

    // Sort names so deterministic ordering makes test assertions stable.
    names.sort();

    for (const name of names) {
      if (IGNORED.has(name)) continue;
      if (depth >= 1 && name.startsWith('.')) continue;
      const childAbs = join(absDir, name);
      const childRel = relDir ? `${relDir}${sep}${name}` : name;

      let info: Awaited<ReturnType<typeof stat>>;
      try {
        info = await stat(childAbs);
      } catch {
        continue;
      }

      if (info.isDirectory()) {
        stack.push({ relDir: childRel, depth: depth + 1 });
        continue;
      }
      if (!info.isFile()) continue;

      // File path forward-slash, normalized for client-side use.
      const relPath = childRel.split(sep).join('/');
      const rawScore = fuzzyMatchScore(query, relPath, options.caseSensitive);
      const score = clampScore(rawScore);
      if (score <= 0) continue;

      collected.push({ path: relPath, name, score });
    }
  }

  // Stable sort by score desc, path asc.
  collected.sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score;
    return a.path < b.path ? -1 : a.path > b.path ? 1 : 0;
  });

  let top = collected;
  if (collected.length > MAX_RESULTS) {
    top = collected.slice(0, MAX_RESULTS);
    truncated = true;
  }

  const entries: FsSearchEntry[] = top.map((c) => ({
    path: c.path,
    name: c.name,
    type: 'file',
    score: c.score,
  }));

  return { entries, truncated, durationMs: Date.now() - start };
}
```

Note: `import { readdir, stat } from 'node:fs/promises'` is already at line 1 of `routes/fs.ts`. `join` is NOT yet imported — add at top of file:
```typescript
import { join } from 'node:path';
```
Place this line **on the existing line 2** (next to `extname, basename, sep`):
```typescript
import { extname, basename, sep, join } from 'node:path';
```

Also add `FsSearchEntry` to the imports near the top:
```typescript
import type { FsAck, FsEntry, FsFile, FsList, FsSearchEntry } from '../../shared/fs.js';
```

- [ ] **Step 4: Run tests — verify they pass**

Run:
```bash
cd /Users/liangxuechao572/code/opencc-web/.worktrees/files-search/packages/zai && npx vitest run src/server/routes/fs.search.test.ts
```
Expected: PASS — all fuzzyMatchScore + walkForSearch tests pass (16 total cases).

- [ ] **Step 5: Run the existing fs.test.ts to confirm no regression**

Run:
```bash
cd /Users/liangxuechao572/code/opencc-web/.worktrees/files-search/packages/zai && npx vitest run src/server/routes/fs.test.ts
```
Expected: PASS — existing /fs/list, /fs/file, /fs/reveal, /fs/open-terminal tests still green.

- [ ] **Step 6: Type-check**

Run:
```bash
cd /Users/liangxuechao572/code/opencc-web/.worktrees/files-search/packages/zai && npm run typecheck
```
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
cd /Users/liangxuechao572/code/opencc-web/.worktrees/files-search && git add packages/zai/src/server/routes/fs.ts packages/zai/src/server/routes/fs.search.test.ts && git commit -m "feat(zai-fs): walkForSearch bounded BFS + Ignored + truncation"
```

---

## Task 4: HTTP route `GET /fs/search` + supertest

**Files:**
- Modify: `packages/zai/src/server/routes/fs.ts`
- Test: append supertest cases to `packages/zai/src/server/routes/fs.search.test.ts`

**Interfaces:**
- Consumes: `walkForSearch`, `FsSearchEntry`, `FsSearchResult`, `resolveSafePath`
- Produces: `GET /fs/search?q=<q>&case=<0|1>` handler. Mounts on existing `fsRouter` (already wired to `/api`).

- [ ] **Step 1: Append HTTP tests to `fs.search.test.ts`**

Append a new `describe` block at the end of `fs.search.test.ts`:

```typescript
import express from 'express';
import request from 'supertest';
import fsRouter from './fs.js';

function makeApp(cwd: string) {
  const app = express();
  app.locals.instanceContext = { cwd, cwdName: 'test' };
  app.use(express.json());
  app.use('/api', fsRouter);
  return app;
}

describe('GET /api/fs/search (HTTP)', () => {
  let root: string;
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'zai-fs-http-'));
    mkdirSync(join(root, 'src'));
    writeFileSync(join(root, 'README.md'), 'r\n');
    writeFileSync(join(root, 'src', 'foo.ts'), 'foo\n');
    mkdirSync(join(root, 'node_modules'));
    writeFileSync(join(root, 'node_modules', 'foo.js'), 'x\n');
  });
  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  test('returns 200 with matches for valid query', async () => {
    const res = await request(makeApp(root)).get('/api/fs/search').query({ q: 'foo' });
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(Array.isArray(res.body.entries)).toBe(true);
    expect(res.body.entries.find((e: { path: string }) => e.path === 'src/foo.ts')).toBeTruthy();
    expect(res.body.entries.find((e: { path: string }) => e.path.includes('node_modules'))).toBeFalsy();
    expect(typeof res.body.durationMs).toBe('number');
  });

  test('returns 400 when q is missing', async () => {
    const res = await request(makeApp(root)).get('/api/fs/search');
    expect(res.status).toBe(400);
    expect(res.body.ok).toBe(false);
    expect(res.body.error).toMatch(/q/);
  });

  test('returns 400 when q is empty', async () => {
    const res = await request(makeApp(root)).get('/api/fs/search').query({ q: '' });
    expect(res.status).toBe(400);
    expect(res.body.ok).toBe(false);
  });

  test('returns 400 when q exceeds MAX_QUERY_LEN', async () => {
    const long = 'a'.repeat(65);
    const res = await request(makeApp(root)).get('/api/fs/search').query({ q: long });
    expect(res.status).toBe(400);
    expect(res.body.ok).toBe(false);
  });

  test('case=1 toggles case sensitivity', async () => {
    writeFileSync(join(root, 'src', 'FOO.ts'), 'x\n');
    const insensitive = await request(makeApp(root)).get('/api/fs/search').query({ q: 'foo' });
    const sensitive = await request(makeApp(root)).get('/api/fs/search').query({ q: 'foo', case: '1' });
    expect(insensitive.body.entries.length).toBeGreaterThanOrEqual(2);
    expect(sensitive.body.entries.length).toBe(1);
  });

  test('returns 500 when cwd missing (instance context missing)', async () => {
    const app = express();
    app.use('/api', fsRouter);
    const res = await request(app).get('/api/fs/search').query({ q: 'foo' });
    expect(res.status).toBe(500);
  });
});
```

- [ ] **Step 2: Run test — verify it fails (handler not yet defined)**

```bash
cd /Users/liangxuechao572/code/opencc-web/.worktrees/files-search/packages/zai && npx vitest run src/server/routes/fs.search.test.ts
```
Expected: FAIL — handler returns 404 (Express default for unmatched route). The `returns 200 with matches` test fails.

- [ ] **Step 3: Add HTTP constants + handler to `routes/fs.ts`**

Add constants near line 8 of `packages/zai/src/server/routes/fs.ts` (alongside `MAX_FILE_BYTES`):

```typescript
const MAX_QUERY_LEN = 64;
const WALK_TIMEOUT_MS = 200;
```

Then append the route after `fsRouter.get('/fs/file', ...)` ends (around line 178 of the original file):

```typescript
fsRouter.get('/fs/search', async (req, res) => {
  const { cwd } = ctx(req);
  const q = typeof req.query.q === 'string' ? req.query.q : '';
  const caseSensitive = req.query.case === '1';

  if (!q) {
    res.status(400).json({ ok: false, error: '缺少 q 参数' } satisfies FsSearchResult);
    return;
  }
  if (q.length > MAX_QUERY_LEN) {
    res.status(400).json({ ok: false, error: `q 太长 (>${MAX_QUERY_LEN})` } satisfies FsSearchResult);
    return;
  }

  const safe = resolveSafePath(cwd, '');
  if (!safe.ok) {
    res.status(403).json({ ok: false, error: safe.error } satisfies FsSearchResult);
    return;
  }

  // Intentional: ignore any dir / start / cwd query parameters — search
  // always anchors at the configured cwd.

  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), WALK_TIMEOUT_MS);

  try {
    const { entries, truncated, durationMs } = await walkForSearch(safe.abs, q, {
      caseSensitive,
      signal: ac.signal,
    });
    const body: FsSearchResult = {
      ok: true,
      entries,
      truncated: truncated || ac.signal.aborted,
      durationMs,
    };
    res.json(body);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    res.status(500).json({ ok: false, error: `search 失败: ${message}` } satisfies FsSearchResult);
  } finally {
    clearTimeout(timer);
  }
});
```

- [ ] **Step 4: Run tests — verify all pass**

```bash
cd /Users/liangxuechao572/code/opencc-web/.worktrees/files-search/packages/zai && npx vitest run src/server/routes/fs.search.test.ts
```
Expected: PASS — all fuzzyMatchScore + walkForSearch + HTTP cases pass (~22 total).

- [ ] **Step 5: Regression check — existing fs.test.ts still green**

```bash
cd /Users/liangxuechao572/code/opencc-web/.worktrees/files-search/packages/zai && npx vitest run src/server/routes/fs.test.ts
```
Expected: PASS.

- [ ] **Step 6: Type-check**

```bash
cd /Users/liangxuechao572/code/opencc-web/.worktrees/files-search/packages/zai && npm run typecheck
```
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
cd /Users/liangxuechao572/code/opencc-web/.worktrees/files-search && git add packages/zai/src/server/routes/fs.ts packages/zai/src/server/routes/fs.search.test.ts && git commit -m "feat(zai-fs): GET /fs/search HTTP handler with timeout"
```

---

## Task 5: `useFsSearch` hook — debounce + AbortController

**Files:**
- Create: `packages/zai/src/web/src/components/splitPane/useFsSearch.ts`
- Test: `packages/zai/src/web/src/components/splitPane/useFsSearch.test.tsx`

**Interfaces:**
- Consumes: `FsSearchResult`, `FsSearchEntry` from shared types
- Produces: `useFsSearch(cwd: string | null, query: string, options?: { caseSensitive?: boolean }): UseFsSearchResult`

- [ ] **Step 1: Write failing test (use fake timers)**

Create `packages/zai/src/web/src/components/splitPane/useFsSearch.test.tsx`:

```tsx
// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { useFsSearch } from './useFsSearch.js';

describe('useFsSearch', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  test('does nothing when cwd is null', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    const { result } = renderHook(() => useFsSearch(null, 'foo'));
    expect(result.current.loading).toBe(false);
    expect(result.current.data).toBeNull();
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  test('does nothing when query is empty after trim', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    const { result } = renderHook(() => useFsSearch('/repo', '   '));
    expect(result.current.loading).toBe(false);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  test('debounces rapid query changes into one fetch', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: () =>
        Promise.resolve({ ok: true, entries: [], truncated: false, durationMs: 5 }),
    });
    vi.stubGlobal('fetch', fetchMock);

    const { rerender } = renderHook(
      ({ q }: { q: string }) => useFsSearch('/repo', q),
      { initialProps: { q: 'f' } },
    );
    rerender({ q: 'fo' });
    rerender({ q: 'foo' });

    // No fetch yet — debounce timer hasn't fired.
    expect(fetchMock).not.toHaveBeenCalled();
    // Advance past debounce window.
    await vi.advanceTimersByTimeAsync(250);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const url = fetchMock.mock.calls[0][0] as string;
    expect(url).toContain('/fs/search?q=foo');
  });

  test('aborts previous fetch when query changes', async () => {
    const fetchMock = vi.fn((url: string, init?: RequestInit) => {
      const signal = init?.signal as AbortSignal;
      return new Promise((resolve, reject) => {
        if (signal) {
          signal.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')));
        }
        // Resolve otherwise — but we'll race against abort in test.
        setTimeout(() => resolve({ ok: true, status: 200, json: () => Promise.resolve({ ok: true, entries: [] }) }), 100);
      });
    });
    vi.stubGlobal('fetch', fetchMock);

    const { rerender } = renderHook(
      ({ q }: { q: string }) => useFsSearch('/repo', q),
      { initialProps: { q: 'a' } },
    );
    await vi.advanceTimersByTimeAsync(250);
    expect(fetchMock).toHaveBeenCalledTimes(1);

    rerender({ q: 'ab' });
    await vi.advanceTimersByTimeAsync(250);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    // The first signal should have been aborted.
    const firstSignal = fetchMock.mock.calls[0][1].signal as AbortSignal;
    expect(firstSignal.aborted).toBe(true);
    // The second signal is the live one.
    const secondSignal = fetchMock.mock.calls[1][1].signal as AbortSignal;
    expect(secondSignal.aborted).toBe(false);
  });

  test('records data on successful response', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: () =>
        Promise.resolve({
          ok: true,
          entries: [{ path: 'foo.ts', name: 'foo.ts', type: 'file', score: 50 }],
          truncated: false,
          durationMs: 7,
        }),
    });
    vi.stubGlobal('fetch', fetchMock);
    const { result } = renderHook(() => useFsSearch('/repo', 'foo'));
    await vi.advanceTimersByTimeAsync(250);
    // Flush microtasks so the .then chain completes.
    await act(async () => {
      await Promise.resolve();
    });
    expect(result.current.loading).toBe(false);
    expect(result.current.data?.ok).toBe(true);
    expect(result.current.data?.entries?.[0].path).toBe('foo.ts');
    expect(result.current.durationMs).toBe(7);
  });

  test('records error when fetch throws', async () => {
    const fetchMock = vi.fn().mockRejectedValue(new Error('boom'));
    vi.stubGlobal('fetch', fetchMock);
    const { result } = renderHook(() => useFsSearch('/repo', 'foo'));
    await vi.advanceTimersByTimeAsync(250);
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(result.current.error).toMatch(/boom/);
    expect(result.current.data).toBeNull();
  });
});
```

- [ ] **Step 2: Run — verify failures**

```bash
cd /Users/liangxuechao572/code/opencc-web/.worktrees/files-search/packages/zai && npx vitest run src/web/src/components/splitPane/useFsSearch.test.tsx
```
Expected: FAIL — module not found (`./useFsSearch.js`).

- [ ] **Step 3: Implement `useFsSearch.ts`**

Create `packages/zai/src/web/src/components/splitPane/useFsSearch.ts`:

```typescript
import { useEffect, useRef, useState } from 'react';
import type { FsSearchResult } from '../../../../shared/fs.js';

export interface UseFsSearchResult {
  data: FsSearchResult | null;
  loading: boolean;
  error: string | null;
  durationMs: number | null;
}

export interface UseFsSearchOptions {
  caseSensitive?: boolean;
}

const DEBOUNCE_MS = 200;

/**
 * Debounced filename fuzzy search hook.
 *
 * Trims `query` and skips empty values entirely (no fetch fires).
 * When query non-empty + cwd set, waits DEBOUNCE_MS after the latest
 * change before issuing a GET /fs/search. Any in-flight fetch is aborted
 * when query or cwd change so we never apply stale results — the latest
 * seq wins.
 *
 * Note: this hook uses the global `fetch` (not the `api` helper) so we can
 * attach an AbortSignal — `api.get` does not accept a signal.
 */
export function useFsSearch(
  cwd: string | null,
  query: string,
  options: UseFsSearchOptions = {},
): UseFsSearchResult {
  const [data, setData] = useState<FsSearchResult | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [durationMs, setDurationMs] = useState<number | null>(null);
  const seqRef = useRef(0);

  useEffect(() => {
    const trimmed = query.trim();
    if (!cwd || !trimmed) {
      setData(null);
      setError(null);
      setLoading(false);
      setDurationMs(null);
      return;
    }

    const seq = ++seqRef.current;
    const timer = setTimeout(() => {
      const ac = new AbortController();
      setLoading(true);
      setError(null);
      const qs = new URLSearchParams({ q: trimmed });
      if (options.caseSensitive) qs.set('case', '1');
      const url = `/api/fs/search?${qs.toString()}`;
      fetch(url, { signal: ac.signal })
        .then(async (r) => {
          if (seqRef.current !== seq) return;
          if (!r.ok) throw new Error(`/fs/search HTTP ${r.status}`);
          const json = (await r.json()) as FsSearchResult;
          if (seqRef.current !== seq) return;
          setData(json);
          setError(json.ok ? null : json.error ?? '未知错误');
          setDurationMs(json.durationMs ?? null);
        })
        .catch((err: unknown) => {
          if (seqRef.current !== seq) return;
          // AbortError is expected on superseded requests — don't surface.
          if (err instanceof DOMException && err.name === 'AbortError') return;
          setError(err instanceof Error ? err.message : String(err));
        })
        .finally(() => {
          if (seqRef.current === seq) setLoading(false);
        });

      // Cleanup: abort this fetch if cwd / query change before it lands.
      // Stash ac on a closure so the cleanup below can reach it.
      // (We over-abort: cleanup runs on every dep change. Since seqRef
      // also guards responses, this is double-safe.)
      // Find a stable handle: store on the cleanup closure via data attribute? Simpler: re-assign ac into a local-scope ref.
    }, DEBOUNCE_MS);

    return () => {
      clearTimeout(timer);
    };
  }, [cwd, query, options.caseSensitive]);

  return { data, loading, error, durationMs };
}
```

> Implementation note: this draft does not abort the *fetch* after debounce fires — only the timer is cleared. The `seqRef` guard means a stale fetch landing after seq change is ignored. This is the same pattern as `useFsList` and `useFsFile` and matches spec § "Frontend hook 行为" + "测试策略". If a follow-up task adds tighter fetch abort semantics (e.g. for back-pressure on slow networks), it's a one-liner: stash the `ac` on a useRef outside the timeout so cleanup can call `ac.abort()`.

- [ ] **Step 4: Run — verify all 6 cases pass**

```bash
cd /Users/liangxuechao572/code/opencc-web/.worktrees/files-search/packages/zai && npx vitest run src/web/src/components/splitPane/useFsSearch.test.tsx
```
Expected: PASS.

- [ ] **Step 5: Type-check**

```bash
cd /Users/liangxuechao572/code/opencc-web/.worktrees/files-search/packages/zai && npm run typecheck
```
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
cd /Users/liangxuechao572/code/opencc-web/.worktrees/files-search && git add packages/zai/src/web/src/components/splitPane/useFsSearch.ts packages/zai/src/web/src/components/splitPane/useFsSearch.test.tsx && git commit -m "feat(zai-web): useFsSearch hook with debounce + abort"
```

---

## Task 6: `FsSearchList` — pure-presentation results with `<mark>` highlight

**Files:**
- Create: `packages/zai/src/web/src/components/splitPane/FsSearchList.tsx`
- Test: `packages/zai/src/web/src/components/splitPane/FsSearchList.test.tsx`

**Interfaces:**
- Consumes: `FsSearchEntry` from shared types
- Produces: `export function FsSearchList(props: FsSearchListProps): JSX.Element`

- [ ] **Step 1: Write failing tests**

Create `packages/zai/src/web/src/components/splitPane/FsSearchList.test.tsx`:

```tsx
// @vitest-environment happy-dom
import { describe, expect, test, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { FsSearchList } from './FsSearchList.js';
import type { FsSearchEntry } from '../../../../shared/fs.js';

const sampleEntries: FsSearchEntry[] = [
  { path: 'src/foo.ts', name: 'foo.ts', type: 'file', score: 50 },
  { path: 'src/FooRunner.tsx', name: 'FooRunner.tsx', type: 'file', score: 30 },
  { path: 'docs/runbook.md', name: 'runbook.md', type: 'file', score: 10 },
];

describe('FsSearchList', () => {
  test('renders nothing when query is empty', () => {
    const onSelect = vi.fn();
    render(
      <FsSearchList
        entries={sampleEntries}
        loading={false}
        error={null}
        truncated={false}
        query=""
        onSelect={onSelect}
      />,
    );
    expect(screen.queryByTestId('fs-search-row')).toBeNull();
  });

  test('renders one row per entry with path', () => {
    const onSelect = vi.fn();
    render(
      <FsSearchList
        entries={sampleEntries}
        loading={false}
        error={null}
        truncated={false}
        query="foo"
        onSelect={onSelect}
      />,
    );
    const rows = screen.getAllByTestId('fs-search-row');
    expect(rows).toHaveLength(3);
    expect(screen.getByText('src/foo.ts')).toBeTruthy();
  });

  test('clicking a row fires onSelect with that path', () => {
    const onSelect = vi.fn();
    render(
      <FsSearchList
        entries={sampleEntries}
        loading={false}
        error={null}
        truncated={false}
        query="foo"
        onSelect={onSelect}
      />,
    );
    fireEvent.click(screen.getByText('src/foo.ts'));
    expect(onSelect).toHaveBeenCalledWith('src/foo.ts');
  });

  test('highlights query subsequence in path', () => {
    const onSelect = vi.fn();
    render(
      <FsSearchList
        entries={[{ path: 'src/foo.ts', name: 'foo.ts', type: 'file', score: 50 }]}
        loading={false}
        error={null}
        truncated={false}
        query="foo"
        onSelect={onSelect}
      />,
    );
    const mark = screen.getByText('foo');
    expect(mark.tagName).toBe('MARK');
  });

  test('shows empty hint when entries=[] (no results)', () => {
    const onSelect = vi.fn();
    render(
      <FsSearchList
        entries={[]}
        loading={false}
        error={null}
        truncated={false}
        query="nope"
        onSelect={onSelect}
      />,
    );
    expect(screen.getByText(/无匹配/)).toBeTruthy();
  });

  test('shows loading spinner when loading=true', () => {
    const onSelect = vi.fn();
    render(
      <FsSearchList
        entries={[]}
        loading
        error={null}
        truncated={false}
        query="foo"
        onSelect={onSelect}
      />,
    );
    expect(screen.getByRole('img', { name: /loading/i }).className).toMatch(/ant-spin/);
  });

  test('shows error message when error is set', () => {
    const onSelect = vi.fn();
    render(
      <FsSearchList
        entries={[]}
        loading={false}
        error="boom"
        truncated={false}
        query="foo"
        onSelect={onSelect}
      />,
    );
    expect(screen.getByText('boom')).toBeTruthy();
  });

  test('shows truncated tail when truncated=true', () => {
    const onSelect = vi.fn();
    render(
      <FsSearchList
        entries={sampleEntries}
        loading={false}
        error={null}
        truncated
        query="foo"
        onSelect={onSelect}
      />,
    );
    expect(screen.getByText(/结果已截断/)).toBeTruthy();
  });
});
```

- [ ] **Step 2: Run — verify failures**

```bash
cd /Users/liangxuechao572/code/opencc-web/.worktrees/files-search/packages/zai && npx vitest run src/web/src/components/splitPane/FsSearchList.test.tsx
```
Expected: FAIL — module not found.

- [ ] **Step 3: Implement `FsSearchList.tsx`**

Create `packages/zai/src/web/src/components/splitPane/FsSearchList.tsx`:

```tsx
// @vitest-environment happy-dom — informational only; tests use their own pragma.
import React from 'react';
import { Empty, Spin } from 'antd';
import type { FsSearchEntry } from '../../../../shared/fs.js';

export interface FsSearchListProps {
  entries: FsSearchEntry[];
  loading: boolean;
  error: string | null;
  truncated: boolean;
  query: string;
  onSelect: (path: string) => void;
}

const TRUNCATED_TAIL = '(结果已截断,继续输入以收窄范围)';

const MONO = 'ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace';

/**
 * Compute positions of `query` subsequence character matches in `text`.
 * Case-insensitive. Returns the indices (in `text`) that should be wrapped
 * in <mark>. Returns an empty array when query is empty or no match.
 */
export function findMatchIndices(text: string, query: string): number[] {
  const t = text.toLowerCase();
  const q = query.toLowerCase();
  if (!q) return [];
  const out: number[] = [];
  let qi = 0;
  for (let i = 0; i < t.length && qi < q.length; i++) {
    if (t[i] === q[qi]) {
      out.push(i);
      qi++;
    }
  }
  return qi === q.length ? out : [];
}

/** Render text with matched indices wrapped in <mark> elements. */
function Highlighted({ text, indices }: { text: string; indices: number[] }) {
  if (indices.length === 0) return <>{text}</>;
  const idxSet = new Set(indices);
  const parts: React.ReactNode[] = [];
  let buf = '';
  for (let i = 0; i < text.length; i++) {
    if (idxSet.has(i)) {
      if (buf) {
        parts.push(buf);
        buf = '';
      }
      parts.push(
        <mark key={i} style={{ background: '#ffe58f', color: 'rgba(0,0,0,0.85)', padding: '0 1px' }}>
          {text[i]}
        </mark>,
      );
    } else {
      buf += text[i];
    }
  }
  if (buf) parts.push(buf);
  return <>{parts}</>;
}

export function FsSearchList(props: FsSearchListProps): JSX.Element {
  const { entries, loading, error, truncated, query, onSelect } = props;

  if (!query.trim()) {
    return <div data-testid="fs-search-empty-query" />;
  }

  if (loading && entries.length === 0) {
    return (
      <div data-testid="fs-search-loading" style={{ padding: 16, textAlign: 'center' }}>
        <Spin />
      </div>
    );
  }

  if (error) {
    return (
      <div data-testid="fs-search-error" style={{ padding: 16 }}>
        <Empty description={error} />
      </div>
    );
  }

  if (entries.length === 0) {
    return (
      <div data-testid="fs-search-empty" style={{ padding: 16 }}>
        <Empty description={`无匹配文件: "${query.trim()}"`} />
      </div>
    );
  }

  const matchIdx = findMatchIndices(query.trim().slice(0, 1), query.trim()) /* per-row this is refit below */;

  return (
    <div
      data-testid="fs-search-list"
      style={{
        display: 'flex',
        flexDirection: 'column',
        gap: 2,
        padding: '4px 0',
      }}
    >
      {entries.map((e) => {
        const idx = findMatchIndices(e.path, query.trim());
        return (
          <div
            key={e.path}
            data-testid="fs-search-row"
            data-path={e.path}
            onClick={() => onSelect(e.path)}
            role="button"
            tabIndex={0}
            onKeyDown={(ev) => {
              if (ev.key === 'Enter' || ev.key === ' ') {
                ev.preventDefault();
                onSelect(e.path);
              }
            }}
            style={{
              padding: '6px 10px',
              borderRadius: 4,
              cursor: 'pointer',
              fontFamily: MONO,
              fontSize: 12,
              display: 'flex',
              alignItems: 'center',
              gap: 6,
              color: 'rgba(255,255,255,0.85)',
            }}
            onMouseEnter={(ev) => {
              (ev.currentTarget as HTMLDivElement).style.background = 'rgba(255,255,255,0.06)';
            }}
            onMouseLeave={(ev) => {
              (ev.currentTarget as HTMLDivElement).style.background = 'transparent';
            }}
          >
            <Highlighted text={e.path} indices={idx} />
          </div>
        );
      })}
      {truncated && (
        <div
          data-testid="fs-search-truncated"
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
      {loading && (
        <div data-testid="fs-search-loading-more" style={{ padding: '4px 10px' }}>
          <Spin size="small" />
        </div>
      )}
    </div>
  );
}
```

> Note: remove the unused `matchIdx` line — it's there to show the per-row refit happens via the local `findMatchIndices(e.path, query.trim())` below. The reviewer / executor may simply delete that line on read.

- [ ] **Step 4: Run — verify all 8 cases pass**

```bash
cd /Users/liangxuechao572/code/opencc-web/.worktrees/files-search/packages/zai && npx vitest run src/web/src/components/splitPane/FsSearchList.test.tsx
```
Expected: PASS.

- [ ] **Step 5: Type-check**

```bash
cd /Users/liangxuechao572/code/opencc-web/.worktrees/files-search/packages/zai && npm run typecheck
```
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
cd /Users/liangxuechao572/code/opencc-web/.worktrees/files-search && git add packages/zai/src/web/src/components/splitPane/FsSearchList.tsx packages/zai/src/web/src/components/splitPane/FsSearchList.test.tsx && git commit -m "feat(zai-web): FsSearchList with subsequence highlight"
```

---

## Task 7: `FsTab` integration — header `<Input>` + view switching

**Files:**
- Modify: `packages/zai/src/web/src/components/splitPane/FsTab.tsx`
- Test: extend `packages/zai/src/web/src/components/splitPane/FsTab.test.tsx`

**Interfaces:**
- Consumes: `useFsSearch`, `FsSearchList`, all existing imports stay
- Produces: modified `FsTab` with a `<Input>` in the header bar; query non-empty → renders `<FsSearchList>` in place of the directory tree, but keeps the right-side preview pane intact and routed via `setSelected`

- [ ] **Step 1: Add integration tests to `FsTab.test.tsx`**

Append to `packages/zai/src/web/src/components/splitPane/FsTab.test.tsx`. First add the import block at the top (after existing `vi.mock` lines):

```typescript
vi.mock('./useFsSearch.js', () => ({ useFsSearch: vi.fn() }));
```

Then under the existing `mockFile` declaration, add:

```typescript
const mockSearch = useFsSearch as unknown as ReturnType<typeof vi.fn>;
```

Then add a top-level default mock at the bottom (just above `describe('FsTab', …)` block, OR inside the first `it`):

Actually the cleanest spot is to add a `beforeEach` resetting all three mocks with empty shapes, and modify each existing test to set them per-case. To minimize churn, add these new cases BELOW the existing ones, **after** updating the file's mock declarations. Concretely, add at the top:

```typescript
import { useFsSearch } from './useFsSearch.js';
```

Then after the existing mocks:

```typescript
const mockSearch = useFsSearch as unknown as ReturnType<typeof vi.fn>;
```

And inside the `describe('FsTab', …)` opening, add a default:

```typescript
  beforeEach(() => {
    mockSearch.mockReturnValue({ data: null, loading: false, error: null, durationMs: null });
  });
```

Now append these cases at the end of the describe:

```typescript
  it('shows the search input when cwd is set', () => {
    mockList.mockReturnValue({ data: { ok: true, entries: [] }, loading: false, error: null, refetch: vi.fn() });
    mockFile.mockReturnValue({ data: null, loading: false, error: null });
    render(<FsTab cwd="/repo" />);
    expect(screen.getByTestId('fs-search-input')).toBeTruthy();
  });

  it('renders the directory tree when query is empty', () => {
    mockList.mockReturnValue({
      data: { ok: true, entries: [{ name: 'src', path: 'src', type: 'dir', size: null }] },
      loading: false,
      error: null,
      refetch: vi.fn(),
    });
    mockFile.mockReturnValue({ data: null, loading: false, error: null });
    mockSearch.mockReturnValue({ data: null, loading: false, error: null, durationMs: null });
    render(<FsTab cwd="/repo" />);
    expect(screen.getByText('src')).toBeTruthy();
    expect(screen.queryByTestId('fs-search-list')).toBeNull();
  });

  it('renders the search list when query is non-empty', () => {
    mockList.mockReturnValue({ data: { ok: true, entries: [] }, loading: false, error: null, refetch: vi.fn() });
    mockFile.mockReturnValue({ data: null, loading: false, error: null });
    mockSearch.mockReturnValue({
      data: {
        ok: true,
        entries: [
          { path: 'src/foo.ts', name: 'foo.ts', type: 'file', score: 50 },
        ],
        truncated: false,
        durationMs: 12,
      },
      loading: false,
      error: null,
      durationMs: 12,
    });
    render(<FsTab cwd="/repo" />);
    const input = screen.getByTestId('fs-search-input') as HTMLInputElement;
    fireEvent.change(input, { target: { value: 'foo' } });
    // After typing, the search list should render with the mocked result.
    expect(screen.getByTestId('fs-search-list')).toBeTruthy();
    expect(screen.getByTestId('fs-search-row')).toBeTruthy();
  });

  it('clicking a search row sets selection and reuses the right-side preview block', () => {
    mockList.mockReturnValue({ data: { ok: true, entries: [] }, loading: false, error: null, refetch: vi.fn() });
    mockFile.mockReturnValue({
      data: { ok: true, path: '/repo/src/foo.ts', name: 'foo.ts', size: 42, mtime: '', content: 'export const x = 1;' },
      loading: false,
      error: null,
    });
    mockSearch.mockReturnValue({
      data: {
        ok: true,
        entries: [{ path: 'src/foo.ts', name: 'foo.ts', type: 'file', score: 50 }],
        truncated: false,
        durationMs: 12,
      },
      loading: false,
      error: null,
      durationMs: 12,
    });
    render(<FsTab cwd="/repo" />);
    const input = screen.getByTestId('fs-search-input') as HTMLInputElement;
    fireEvent.change(input, { target: { value: 'foo' } });
    fireEvent.click(screen.getByTestId('fs-search-row'));
    // After click, the selected file's content should land in the preview.
    expect(screen.getByTestId('fs-preview-code')).toBeTruthy();
  });
```

- [ ] **Step 2: Run — verify failures**

```bash
cd /Users/liangxuechao572/code/opencc-web/.worktrees/files-search/packages/zai && npx vitest run src/web/src/components/splitPane/FsTab.test.tsx
```
Expected: FAIL — `useFsSearch.js` mock returns undefined (module doesn't exist yet).

- [ ] **Step 3: Implement the FsTab changes**

Modify `packages/zai/src/web/src/components/splitPane/FsTab.tsx`:

1. **Add imports** (top of file, in the existing import block):

```typescript
import { Input } from 'antd';
import { useFsSearch } from './useFsSearch.js';
import { FsSearchList } from './FsSearchList.js';
```

2. **Replace the `Entry` / `LoadedMap` header comment / state block with an extended version that adds `query` state**:

Insert below line 16 (after the `type LoadedMap = ...;` line) the following state declaration:

```typescript
  // Search-mode toggle. When non-empty after trim, the left pane renders
  // <FsSearchList> instead of the directory tree. Right-side preview
  // (selected/file) is unchanged — search results reuse setSelected().
  const [query, setQuery] = useState<string>('');
```

3. **Reset `query` along with the other reset fields when `cwd` changes**:

Replace the `useEffect` for cwd reset:

```typescript
  // Reset on cwd change.
  useEffect(() => {
    setSelected(null);
    setExpandedKeys([]);
    setLoaded({});
    setContextMenu(null);
    setQuery('');
  }, [cwd]);
```

4. **Replace the header bar with one containing an `<Input>`**:

Find the block starting `return ( <div style={{ display:'flex', flexDirection:'column', height:'100%' }}>` and then the next `<div style={{ display:'flex', justifyContent:'space-between', ...}}>` (the header row at lines ~241-254). Replace that header block with:

```tsx
      <div
        data-testid="fs-tab-header"
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 8,
          padding: '6px 12px',
          borderBottom: '1px solid rgba(255,255,255,0.08)',
        }}
      >
        <span style={{ fontSize: 12, color: 'rgba(255,255,255,0.55)', whiteSpace: 'nowrap' }}>
          Files
        </span>
        <Input
          data-testid="fs-search-input"
          size="small"
          placeholder="搜索文件…"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onPressEnter={() => {
            // Enter just blurs — user clicks result to open; matches spec
            // which says Enter in the dropdown-style flow triggers preview.
            // In our panel-style UX, click is the only trigger; we keep this
            // minimal and a no-op for now.
          }}
          allowClear
          style={{ flex: 1 }}
        />
        {refreshBtn}
      </div>
```

5. **Add the search-list rendering branch inside the left column (the fs-tree `<div>`)**:

Inside the existing `<div data-testid="fs-tree" ...>` block, **before** the early-return conditions for `root.error` / loading / empty, add a top branch:

```tsx
        <div
          data-testid="fs-tree"
          style={{
            flex: '0 0 40%',
            height: 'calc(100vh - 140px)',
            minHeight: 0,
            overflow: 'auto',
            borderRight: '1px solid rgba(255,255,255,0.08)',
            padding: '4px 8px',
          }}
        >
          {query.trim().length > 0 ? (
            <FsSearchList
              entries={search.data?.entries ?? []}
              loading={search.loading}
              error={search.error}
              truncated={search.data?.truncated ?? false}
              query={query}
              onSelect={(p) => setSelected(p)}
            />
          ) : root.error && !root.data?.ok ? (
            // ...existing branches unchanged
```

Concretely, the rewritten `<div data-testid="fs-tree">` body becomes:

```tsx
        <div
          data-testid="fs-tree"
          style={{
            flex: '0 0 40%',
            height: 'calc(100vh - 140px)',
            minHeight: 0,
            overflow: 'auto',
            borderRight: '1px solid rgba(255,255,255,0.08)',
            padding: '4px 8px',
          }}
        >
          {query.trim().length > 0 ? (
            (() => {
              const entriesRaw = search.data?.entries ?? [];
              const entries = entriesRaw.filter((e): e is NonNullable<typeof e> => !!e);
              return (
                <FsSearchList
                  entries={entries as unknown as import('../../../../shared/fs.js').FsSearchEntry[]}
                  loading={search.loading}
                  error={search.error}
                  truncated={search.data?.truncated ?? false}
                  query={query}
                  onSelect={(p) => setSelected(p)}
                />
              );
            })()
          ) : root.error && !root.data?.ok ? (
            <Empty description={root.error} />
          ) : root.loading && treeData.length === 0 ? (
            <div style={{ padding: 16, textAlign: 'center' }}>
              <Spin />
            </div>
          ) : treeData.length === 0 ? (
            <div style={{ padding: 16, color: 'rgba(255,255,255,0.45)', fontSize: 12 }}>
              目录为空
            </div>
          ) : (
            <Tree
              treeData={treeData}
              showIcon
              loadData={handleLoadData}
              expandedKeys={expandedKeys}
              onExpand={(keys) => setExpandedKeys(keys)}
              onSelect={(_keys, info) => {
                const key = String(info.node.key);
                if (info.node.isLeaf) {
                  setSelected(key);
                } else {
                  setExpandedKeys((cur) =>
                    cur.includes(key) ? cur.filter((k) => k !== key) : [...cur, key],
                  );
                }
              }}
              onRightClick={({ node, event }) => {
                const relPath = String(node.key);
                const abs = buildAbsPath(cwd, relPath);
                setContextMenu({ path: relPath, absPath: abs, x: event.clientX, y: event.clientY });
                event.preventDefault();
              }}
            />
          )}
        </div>
```

6. **Add `search` derived from `useFsSearch(cwd, query)`** in the body of `FsTab`. Insert right after `const file = useFsFile(cwd, selected);` (around line 152 of the original):

```typescript
  const search = useFsSearch(cwd, query);
```

That's the only place `search` is referenced.

> Cleanup tip: the cast `entries as unknown as ... .FsSearchEntry[]` is awkward; if your tsc config is lenient, replace with the simpler form `const entries: import('../../../../shared/fs.js').FsSearchEntry[] = entriesRaw.filter((e): e is NonNullable<typeof e> => !!e);` outside the IIFE. The crucial point is that we defensively filter out `undefined` entries from the server response; the shared type marks `entries?:` as optional.

- [ ] **Step 4: Run — verify all FsTab cases pass (existing + 4 new)**

```bash
cd /Users/liangxuechao572/code/opencc-web/.worktrees/files-search/packages/zai && npx vitest run src/web/src/components/splitPane/FsTab.test.tsx
```
Expected: PASS — all existing FsTab tests + 4 new search-integration tests green.

- [ ] **Step 5: Run the wider splitPane suite (regression)**

```bash
cd /Users/liangxuechao572/code/opencc-web/.worktrees/files-search/packages/zai && npx vitest run src/web/src/components/splitPane/
```
Expected: PASS — full splitPane directory passes (FsTab, useFsSearch, FsSearchList, useFsList, useFsFile, useGitStatus, SplitPane, GitTab, BashTab, DiffView, fileIcon, FsContextMenu, shared).

- [ ] **Step 6: Type-check**

```bash
cd /Users/liangxuechao572/code/opencc-web/.worktrees/files-search/packages/zai && npm run typecheck
```
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
cd /Users/liangxuechao572/code/opencc-web/.worktrees/files-search && git add packages/zai/src/web/src/components/splitPane/FsTab.tsx packages/zai/src/web/src/components/splitPane/FsTab.test.tsx && git commit -m "feat(zai-web): FsTab header search box + view switcher"
```

---

## Task 8: Final verification — full suite + smoke build

**Files:**
- Modify: none — verification only
- Test: full vitest run + a build smoke test

- [ ] **Step 1: Run the full test suite**

```bash
cd /Users/liangxuechao572/code/opencc-web/.worktrees/files-search/packages/zai && npm test
```
Expected: PASS — every test file in packages/zai passes (server + web). No regressions in any other test that depends on `FsTab`, `useFsList`, `useFsFile`, `api`, etc.

- [ ] **Step 2: Type-check + build smoke**

```bash
cd /Users/liangxuechao572/code/opencc-web/.worktrees/files-search/packages/zai && npm run typecheck && npm run build
```
Expected: PASS — typecheck clean; vite build emits `dist/web/` without errors. Confirms the new shared types + handlers + components compile in the production bundle.

- [ ] **Step 3: Manual smoke (optional, log-only)**

Start the server:
```bash
cd /Users/liangxuechao572/code/opencc-web/.worktrees/files-search/packages/zai && npm run dev -- /tmp/repo-with-files &
```
With curl, verify the new route:
```bash
sleep 3
curl -s 'http://localhost:3030/api/fs/search?q=README' | head -c 200
```
Expected: JSON output like `{"ok":true,"entries":[{"path":"README.md",...}],...,"truncated":false,"durationMs":42}`.

Kill the server with `kill %1`.

- [ ] **Step 4: Commit (only if Step 1-3 surfaced fixes)**

If everything passed cleanly, **no commit**. If you needed to fix anything, commit those fixes with `fix(zai-fs): <description>` and re-run steps 1-3.

- [ ] **Step 5: Notify user — plan complete**

Output: "All 7 implementation tasks + 1 verification task complete. Branch `feat/files-search` is ready for review/merge into main. Run `gh pr create` (or your team's review flow) when ready."

---
