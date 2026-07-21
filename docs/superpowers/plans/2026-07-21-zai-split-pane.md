# zai Split-Pane Right Panel — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a collapsible right-side split-pane to the Agent page with three tabs (Git / Files / placeholder), backed by new read-only `/api/git/*` and `/api/fs/*` endpoints that operate on the session's cwd.

**Architecture:** True split-pane (not Drawer). Three-column flex in `Agent.tsx`: session sidebar | messages | split-pane. Split-pane owns AntD `Tabs` and routes cwd-driven refresh through the existing `useSessionCwd` hook. Backend adds `git.ts` + `fs.ts` routers, both going through a shared `resolveSafePath` util that whitelists paths under the configured `instanceContext.cwd`. Tabs 1 (Git) and 2 (Files) implement the list/detail pattern; tab 3 is a placeholder.

**Tech Stack:** TypeScript, Express, vitest + supertest (backend), happy-dom + @testing-library/react (frontend), AntD `Tabs` + `Tree` + `Empty` + `Button`, existing `react-syntax-highlighter` for file preview, existing `useSessionCwd` hook.

## Global Constraints

- **Path safety:** every filesystem / git endpoint that takes a relative path must call `resolveSafePath(cwd, rel)`. Outside-cwd → 403 (or `{ ok:false, error }` for git-style responses).
- **Size cap:** `MAX_FILE_BYTES = 2 * 1024 * 1024` (mirrored in `git.ts` for diffs).
- **Depth cap:** directory listing refuses depth > 3 (counted as path segments after cwd).
- **Ignore list for fs list:** `node_modules`, `.git`, `.next`, `dist`, `build`, `.cache`, `.DS_Store`. Hidden dirs beyond depth 1 are also filtered (so `.claude`, `.config` remain visible at top level).
- **Git porcelain:** `git status --porcelain=v1 -u normal`. `??` = untracked. Two-char prefix → single-char `status` (`M`/`A`/`D`/`??`); unstaged column wins when both are present.
- **Git diff:** tracked → `git diff --no-color HEAD -- <rel>`; untracked → `git diff --no-color --no-index /dev/null <abs>`.
- **Git command timeout:** 3000 ms (`status --porcelain`, `rev-parse`), 5000 ms (`diff`).
- **No new SSE channels.** No `chokidar`/`fs.watch`. Refresh on cwd change + manual button.
- **localStorage keys:** `zai.splitPane.open` (`'true'`/`'false'`), `zai.splitPane.tab` (`'git'`/`'fs'`/`'tbd'`), `zai.splitPane.width` (numeric px string, range 320-720, default 480). All values are JSON-encoded by the `useLocalStorageState` hook.
- **Responsive:** auto-close when `window.innerWidth < 1024`.
- **Dark theme:** background `#0d0d0d`, border `#303030`, monospace `ui-monospace, SFMono-Regular, Menlo, monospace`.
- **Test runner:** `pnpm --filter @zn-ai/zai test` (runs `vitest run` against `packages/zai/src/**/*.test.{ts,tsx}` and `test/**/*.test.{ts,tsx}`).
- **Test conventions:** server tests use supertest with `makeApp()` factory; frontend tests use `@vitest-environment happy-dom` + `@testing-library/react`.
- **No new dependencies.** All imports already present in `package.json`.

## File Structure

### Backend (new)

| Path | Responsibility |
|------|----------------|
| `packages/zai/src/server/utils/safePath.ts` | `resolveSafePath(root, rel)` — resolves a relative path under `root`, verifies containment, returns `{ ok: true, abs }` or `{ ok: false, error }`. |
| `packages/zai/src/server/utils/safePath.test.ts` | Unit tests: nested escapes, `..`, absolute inputs, symlink-already-resolved-by-resolve (relies on `path.resolve` not following symlinks; documented). |
| `packages/zai/src/server/routes/git.ts` | `GET /git/status`, `GET /git/diff`. Reads `app.locals.instanceContext.cwd`. |
| `packages/zai/src/server/routes/git.test.ts` | Fixture-based: tmpdir + `git init`, modify/add/delete, hit endpoints with supertest. |
| `packages/zai/src/server/routes/fs.ts` | `GET /fs/list`, `GET /fs/file`. Mirrors `dirs.ts` whitelist + extension + size cap, scoped to cwd. |
| `packages/zai/src/server/routes/fs.test.ts` | Fixtures: nested 4-deep dir, large file, binary, escape attempt. |

### Backend (modified)

| Path | Change |
|------|--------|
| `packages/zai/src/server/index.ts` | Import + `app.use('/api', gitRouter); app.use('/api', fsRouter);` next to the existing `dirsRouter` line. |

### Frontend shared (new)

| Path | Responsibility |
|------|----------------|
| `packages/zai/src/shared/git.ts` | `GitStatus`, `GitStatusFile`, `GitDiff` types. Single source of truth, imported by both server and web. |
| `packages/zai/src/shared/fs.ts` | `FsEntry`, `FsFile` types. |

### Frontend (new)

| Path | Responsibility |
|------|----------------|
| `packages/zai/src/web/src/components/splitPane/shared.ts` | localStorage keys, width clamps, status colors, `useLocalStorageState<T>(key, default)` hook. |
| `packages/zai/src/web/src/components/splitPane/shared.test.ts` | Tests for `useLocalStorageState` (default, read, write, JSON parse errors → default). |
| `packages/zai/src/web/src/components/splitPane/DiffView.tsx` | Renders unified-diff text line-by-line with +/- colors; used by `GitTab`. Pure presentational. |
| `packages/zai/src/web/src/components/splitPane/DiffView.test.tsx` | Snapshot of header fold + hunk rendering. |
| `packages/zai/src/web/src/components/splitPane/useGitStatus.ts` | `useGitStatus(cwd | null)` — fetches `/api/git/status` on cwd change. Returns `{ data, loading, error, refetch }`. |
| `packages/zai/src/web/src/components/splitPane/useGitStatus.test.ts` | Stub `api.get`, verify fetch trigger on cwd change, error path. |
| `packages/zai/src/web/src/components/splitPane/useGitDiff.ts` | `useGitDiff(cwd, path, isUntracked)` — fetches `/api/git/diff?path=...`. |
| `packages/zai/src/web/src/components/splitPane/useFsList.ts` | `useFsList(cwd, dir)` — fetches `/api/fs/list?dir=...`. |
| `packages/zai/src/web/src/components/splitPane/useFsFile.ts` | `useFsFile(cwd, path)` — fetches `/api/fs/file?path=...`. |
| `packages/zai/src/web/src/components/splitPane/GitTab.tsx` | List (left 40%) + DiffView (right 60%). Header with refresh button. |
| `packages/zai/src/web/src/components/splitPane/GitTab.test.tsx` | Stub hooks, verify list render + click triggers diff. |
| `packages/zai/src/web/src/components/splitPane/FsTab.tsx` | Tree (left 40%) + preview (right 60%). |
| `packages/zai/src/web/src/components/splitPane/FsTab.test.tsx` | Stub list/file, click leaf → preview shown. |
| `packages/zai/src/web/src/components/splitPane/PlaceholderTab.tsx` | Renders `Empty description="即将到来"`. |
| `packages/zai/src/web/src/components/splitPane/SplitPane.tsx` | Three-column container, toggle, AntD `Tabs`, responsive auto-close. |
| `packages/zai/src/web/src/components/splitPane/SplitPane.test.tsx` | localStorage persistence + toggle + responsive. |

### Frontend (modified)

| Path | Change |
|------|--------|
| `packages/zai/src/web/src/pages/Agent.tsx` | Wrap the existing two-column layout with `<SplitPane>` so messages column gets `flex: 1` and split-pane column gets the persistent width. Add toggle button in left sidebar (`SidebarRightOutlined` / `BorderOutlined`). |

---

## Task 1: Shared types (frontend ↔ backend single source)

**Files:**
- Create: `packages/zai/src/shared/git.ts`
- Create: `packages/zai/src/shared/fs.ts`

**Interfaces:**
- Produces:
  - `GitStatus`: `{ ok: boolean; error?: string; branch?: string | null; files?: GitStatusFile[] }`
  - `GitStatusFile`: `{ path: string; status: 'M' | 'A' | 'D' | '??'; staged: boolean }`
  - `GitDiff`: `{ ok: boolean; error?: string; diff?: string; isUntracked?: boolean }`
  - `FsEntry`: `{ name: string; path: string; type: 'dir' | 'file'; size: number | null }`
  - `FsList`: `{ ok: boolean; error?: string; entries?: FsEntry[] }`
  - `FsFile`: `{ ok: boolean; error?: string; path?: string; name?: string; size?: number; mtime?: string; content?: string }`

- [ ] **Step 1: Create git.ts shared types**

Write `packages/zai/src/shared/git.ts`:

```ts
// Git types shared between server (routes/git.ts) and web (components/splitPane/*).
// Single source of truth — server returns these shapes; web reads them via api.get.

export type GitStatusChar = 'M' | 'A' | 'D' | '??';

export interface GitStatusFile {
  /** Path relative to cwd, exactly as `git status --porcelain` reports. */
  path: string;
  /** Single-char summary used by the UI to color rows. */
  status: GitStatusChar;
  /** True if there is a staged change for this path. */
  staged: boolean;
}

export interface GitStatus {
  ok: boolean;
  error?: string;
  branch?: string | null;
  files?: GitStatusFile[];
}

export interface GitDiff {
  ok: boolean;
  error?: string;
  diff?: string;
  isUntracked?: boolean;
}
```

- [ ] **Step 2: Create fs.ts shared types**

Write `packages/zai/src/shared/fs.ts`:

```ts
// Filesystem types shared between server (routes/fs.ts) and web (components/splitPane/*).

export type FsEntryType = 'dir' | 'file';

export interface FsEntry {
  /** Basename of the entry. */
  name: string;
  /** Path relative to cwd, joined with forward slashes. */
  path: string;
  type: FsEntryType;
  /** File size in bytes, null for directories. */
  size: number | null;
}

export interface FsList {
  ok: boolean;
  error?: string;
  entries?: FsEntry[];
}

export interface FsFile {
  ok: boolean;
  error?: string;
  path?: string;
  name?: string;
  size?: number;
  mtime?: string;
  content?: string;
}
```

- [ ] **Step 3: Type-check**

Run: `pnpm --filter @zn-ai/zai typecheck`
Expected: exit code 0, no errors.

- [ ] **Step 4: Commit**

```bash
git add packages/zai/src/shared/git.ts packages/zai/src/shared/fs.ts
git commit -m "feat(zai-shared): git + fs shared types for split-pane"
```

---

## Task 2: Backend `resolveSafePath` util

**Files:**
- Create: `packages/zai/src/server/utils/safePath.ts`
- Create: `packages/zai/src/server/utils/safePath.test.ts`

**Interfaces:**
- Produces:
  - `resolveSafePath(root: string, rel: string): { ok: true; abs: string } | { ok: false; error: string }`

- [ ] **Step 1: Write the failing test**

Write `packages/zai/src/server/utils/safePath.test.ts`:

```ts
import { describe, expect, test } from 'vitest';
import { resolveSafePath } from './safePath.js';

describe('resolveSafePath', () => {
  test('resolves a plain relative path under root', () => {
    const r = resolveSafePath('/tmp/repo', 'src/index.ts');
    expect(r).toEqual({ ok: true, abs: expect.stringContaining('src/index.ts') });
  });

  test('rejects .. escape', () => {
    const r = resolveSafePath('/tmp/repo', '../etc/passwd');
    expect(r.ok).toBe(false);
  });

  test('rejects absolute path outside root', () => {
    const r = resolveSafePath('/tmp/repo', '/etc/passwd');
    expect(r.ok).toBe(false);
  });

  test('treats empty relative as root', () => {
    const r = resolveSafePath('/tmp/repo', '');
    expect(r).toEqual({ ok: true, abs: expect.stringMatching(/repo$/) });
  });
});
```

- [ ] **Step 2: Run the test to confirm it fails**

Run: `pnpm --filter @zn-ai/zai test -- --reporter=default safePath`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement resolveSafePath**

Write `packages/zai/src/server/utils/safePath.ts`:

```ts
import { resolve, sep } from 'node:path';

/**
 * Resolve `rel` under `root` and ensure the result stays inside root.
 * Used by read-only filesystem / git endpoints that accept a path
 * relative to the configured cwd. Returns `{ ok: false, error }` if
 * the resolved path escapes `root` or is otherwise invalid.
 *
 * Note: this does NOT follow symlinks (path.resolve does not).
 * A symlink that points outside root will only be caught when the
 * caller subsequently does fs.stat/readFile on it. Both fs.ts and
 * git.ts run resolveSafePath BEFORE running git or fs operations,
 * so any subsequent ENOENT/ELOOP surfaces to the caller as the
 * normal error path. Documented risk: malicious symlinks. Mitigated
 * because the endpoints are read-only and the agent core already
 * runs in a sandbox.
 */
export function resolveSafePath(
  root: string,
  rel: string,
): { ok: true; abs: string } | { ok: false; error: string } {
  if (typeof rel !== 'string') {
    return { ok: false, error: 'path 必须为字符串' };
  }
  // Empty rel means "the root itself" — useful for /fs/list?dir=
  const abs = resolve(root, rel);
  // Resolve removes trailing slash on root; compare exactly + the
  // separator-aware prefix check.
  if (abs === root || abs.startsWith(root + sep)) {
    return { ok: true, abs };
  }
  return { ok: false, error: `禁止访问：路径越界 (${rel})` };
}
```

- [ ] **Step 4: Run the test to confirm it passes**

Run: `pnpm --filter @zn-ai/zai test -- safePath`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add packages/zai/src/server/utils/safePath.ts packages/zai/src/server/utils/safePath.test.ts
git commit -m "feat(zai-server): resolveSafePath util for cwd-scoped read endpoints"
```

---

## Task 3: Backend `routes/git.ts` — status + diff

**Files:**
- Create: `packages/zai/src/server/routes/git.ts`
- Create: `packages/zai/src/server/routes/git.test.ts`

**Interfaces:**
- Consumes:
  - `resolveSafePath(root, rel)` from Task 2.
  - `GitStatus`, `GitDiff` types from Task 1.
- Produces:
  - `GET /git/status` → `GitStatus`
  - `GET /git/diff?path=<rel>` → `GitDiff`

- [ ] **Step 1: Write the failing test**

Write `packages/zai/src/server/routes/git.test.ts`:

```ts
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'vitest';
import express from 'express';
import request from 'supertest';
import { mkdtempSync, writeFileSync, rmSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import gitRouter from './git.js';

function makeApp(cwd: string) {
  const app = express();
  app.locals.instanceContext = { cwd, cwdName: 'test' };
  app.use('/api', gitRouter);
  return app;
}

function git(cwd: string, args: string[]) {
  return execFileSync('git', args, { cwd, encoding: 'utf8' });
}

describe('routes/git', () => {
  let repo: string;
  let notRepo: string;

  beforeAll(() => {
    repo = mkdtempSync(join(tmpdir(), 'zai-git-'));
    git(repo, ['init', '-q']);
    git(repo, ['config', 'user.email', 'test@local']);
    git(repo, ['config', 'user.name', 'test']);
    writeFileSync(join(repo, 'a.txt'), 'one\n');
    git(repo, ['add', '.']);
    git(repo, ['commit', '-q', '-m', 'init']);

    notRepo = mkdtempSync(join(tmpdir(), 'zai-nogit-'));
  });

  afterAll(() => {
    rmSync(repo, { recursive: true, force: true });
    rmSync(notRepo, { recursive: true, force: true });
  });

  beforeEach(() => {
    // reset repo to a clean "init" state before each test
    rmSync(repo, { recursive: true, force: true });
    mkdirSync(repo);
    git(repo, ['init', '-q']);
    git(repo, ['config', 'user.email', 'test@local']);
    git(repo, ['config', 'user.name', 'test']);
    writeFileSync(join(repo, 'a.txt'), 'one\n');
    git(repo, ['add', '.']);
    git(repo, ['commit', '-q', '-m', 'init']);
  });

  test('GET /git/status on a non-git cwd returns ok:false', async () => {
    const res = await request(makeApp(notRepo)).get('/api/git/status');
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(false);
    expect(res.body.error).toMatch(/not a git repository/i);
  });

  test('GET /git/status lists modified and untracked files', async () => {
    writeFileSync(join(repo, 'a.txt'), 'one\ntwo\n'); // modified
    writeFileSync(join(repo, 'new.md'), '# new\n');   // untracked
    const res = await request(makeApp(repo)).get('/api/git/status');
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    const paths = (res.body.files as Array<{ path: string; status: string }>).map((f) => [f.path, f.status]);
    expect(paths).toContainEqual(['a.txt', 'M']);
    expect(paths).toContainEqual(['new.md', '??']);
  });

  test('GET /git/status marks staged files', async () => {
    writeFileSync(join(repo, 'a.txt'), 'one\ntwo\n');
    git(repo, ['add', 'a.txt']);
    const res = await request(makeApp(repo)).get('/api/git/status');
    expect(res.body.files.find((f: any) => f.path === 'a.txt').staged).toBe(true);
  });

  test('GET /git/diff?path=<untracked> returns isUntracked:true with content lines', async () => {
    writeFileSync(join(repo, 'new.md'), 'alpha\nbeta\n');
    const res = await request(makeApp(repo)).get('/api/git/diff').query({ path: 'new.md' });
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.isUntracked).toBe(true);
    expect(res.body.diff).toMatch(/\+alpha/);
    expect(res.body.diff).toMatch(/\+beta/);
  });

  test('GET /git/diff?path=<tracked modified> returns HEAD-vs-work diff', async () => {
    writeFileSync(join(repo, 'a.txt'), 'one\nTWO\n');
    const res = await request(makeApp(repo)).get('/api/git/diff').query({ path: 'a.txt' });
    expect(res.body.ok).toBe(true);
    expect(res.body.isUntracked).toBe(false);
    expect(res.body.diff).toMatch(/TWO/);
  });

  test('GET /git/diff?path=../etc/passwd refuses escape', async () => {
    const res = await request(makeApp(repo)).get('/api/git/diff').query({ path: '../escape' });
    expect(res.body.ok).toBe(false);
    expect(res.body.error).toMatch(/越界|禁止/);
  });
});
```

- [ ] **Step 2: Run the test to confirm it fails**

Run: `pnpm --filter @zn-ai/zai test -- git.test`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement the router**

Write `packages/zai/src/server/routes/git.ts`:

```ts
import { Router, type IRouter } from 'express';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { resolveSafePath } from '../utils/safePath.js';
import type { GitDiff, GitStatus, GitStatusChar, GitStatusFile } from '../../shared/git.js';

const execFileAsync = promisify(execFile);

const MAX_DIFF_BYTES = 2 * 1024 * 1024; // 2 MB

interface InstanceContextShape {
  cwd: string;
  cwdName: string;
}

function ctx(req: express.Request): InstanceContextShape {
  return req.app.locals.instanceContext as InstanceContextShape;
}

function mapStatus(staged: string, unstaged: string): { status: GitStatusChar; staged: boolean } {
  // Prefer the unstaged column when non-space (modified-in-workdir is what
  // users want to see). Fall back to the staged column.
  if (unstaged === '?') return { status: '??', staged: false };
  if (unstaged !== ' ') return { status: unstaged as GitStatusChar, staged: staged !== ' ' };
  if (staged !== ' ') return { status: staged as GitStatusChar, staged: true };
  // Shouldn't happen for porcelain output, but fall back to M.
  return { status: 'M', staged: false };
}

export const gitRouter: IRouter = Router();

gitRouter.get('/git/status', async (req, res) => {
  const { cwd } = ctx(req);
  try {
    await execFileAsync('git', ['rev-parse', '--is-inside-work-tree'], { cwd, timeout: 3000 });
  } catch {
    const body: GitStatus = { ok: false, error: 'not a git repository' };
    res.json(body);
    return;
  }
  try {
    const [statusOut, branchOut] = await Promise.all([
      execFileAsync('git', ['status', '--porcelain=v1', '-u', 'normal'], { cwd, timeout: 5000 }),
      execFileAsync('git', ['rev-parse', '--abbrev-ref', 'HEAD'], { cwd, timeout: 3000 }).catch(() => ({ stdout: '' })),
    ]);
    const files: GitStatusFile[] = statusOut.stdout
      .split('\n')
      .filter(Boolean)
      .map((line) => {
        // porcelain v1: "<XY> <path>" where XY is two chars and path starts at col 3
        const staged = line[0] ?? ' ';
        const unstaged = line[1] ?? ' ';
        const path = line.slice(3);
        const mapped = mapStatus(staged, unstaged);
        return { path, status: mapped.status, staged: mapped.staged };
      });
    const body: GitStatus = {
      ok: true,
      branch: branchOut.stdout.trim() || null,
      files,
    };
    res.json(body);
  } catch (err) {
    const body: GitStatus = { ok: false, error: `git status 失败: ${err instanceof Error ? err.message : String(err)}` };
    res.json(body);
  }
});

gitRouter.get('/git/diff', async (req, res) => {
  const { cwd } = ctx(req);
  const rel = typeof req.query.path === 'string' ? req.query.path : '';
  if (!rel) {
    const body: GitDiff = { ok: false, error: '缺少 path 参数' };
    res.status(400).json(body);
    return;
  }
  const safe = resolveSafePath(cwd, rel);
  if (!safe.ok) {
    const body: GitDiff = { ok: false, error: safe.error };
    res.json(body);
    return;
  }
  // Decide whether the file is untracked. We use `git status --porcelain`
  // for this so the diff endpoint is the single source of truth — the UI
  // doesn't have to pre-classify.
  let isUntracked = false;
  try {
    const { stdout } = await execFileAsync(
      'git',
      ['status', '--porcelain=v1', '-u', 'normal', '--', rel],
      { cwd, timeout: 3000 },
    );
    isUntracked = stdout.trimStart().startsWith('??');
  } catch {
    isUntracked = false;
  }

  let diff = '';
  try {
    if (isUntracked) {
      const { stdout } = await execFileAsync(
        'git',
        ['diff', '--no-color', '--no-index', '--', '/dev/null', safe.abs],
        { cwd, timeout: 5000, maxBuffer: MAX_DIFF_BYTES * 2 },
      );
      // `git diff --no-index` emits two header lines ("diff --git ..." and
      // "new file mode ...") before the unified-diff hunk header. Strip
      // them so the unified format is consistent with the tracked branch.
      diff = stdout.replace(/^diff --git.*\nnew file mode.*\n/m, '');
    } else {
      const { stdout } = await execFileAsync(
        'git',
        ['diff', '--no-color', 'HEAD', '--', rel],
        { cwd, timeout: 5000, maxBuffer: MAX_DIFF_BYTES * 2 },
      );
      diff = stdout;
    }
  } catch (err) {
    const body: GitDiff = { ok: false, error: `git diff 失败: ${err instanceof Error ? err.message : String(err)}` };
    res.json(body);
    return;
  }

  if (diff.length > MAX_DIFF_BYTES) {
    const mb = (diff.length / 1024 / 1024).toFixed(2);
    const body: GitDiff = { ok: false, error: `diff 过大 (${mb} MB > 2 MB)，暂不支持预览` };
    res.json(body);
    return;
  }

  const body: GitDiff = { ok: true, diff, isUntracked };
  res.json(body);
});

export default gitRouter;
```

- [ ] **Step 4: Run the test to confirm it passes**

Run: `pnpm --filter @zn-ai/zai test -- git.test`
Expected: PASS (6 tests).

- [ ] **Step 5: Commit**

```bash
git add packages/zai/src/server/routes/git.ts packages/zai/src/server/routes/git.test.ts
git commit -m "feat(zai-server): git status + diff read endpoints for split-pane"
```

---

## Task 4: Backend `routes/fs.ts` — list + file

**Files:**
- Create: `packages/zai/src/server/routes/fs.ts`
- Create: `packages/zai/src/server/routes/fs.test.ts`

**Interfaces:**
- Consumes: `resolveSafePath` (Task 2), `FsEntry` / `FsList` / `FsFile` (Task 1).
- Produces: `GET /fs/list?dir=<rel>` → `FsList`; `GET /fs/file?path=<rel>` → `FsFile`.

- [ ] **Step 1: Write the failing test**

Write `packages/zai/src/server/routes/fs.test.ts`:

```ts
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import express from 'express';
import request from 'supertest';
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import fsRouter from './fs.js';

function makeApp(cwd: string) {
  const app = express();
  app.locals.instanceContext = { cwd, cwdName: 'test' };
  app.use('/api', fsRouter);
  return app;
}

describe('routes/fs', () => {
  let root: string;

  beforeAll(() => {
    root = mkdtempSync(join(tmpdir(), 'zai-fs-'));
    mkdirSync(join(root, 'src'));
    writeFileSync(join(root, 'README.md'), 'hello\n');
    writeFileSync(join(root, 'src', 'index.ts'), 'export const x = 1;\n');
    mkdirSync(join(root, 'node_modules'));
    writeFileSync(join(root, 'node_modules', 'x.js'), 'noop');
    // depth-4 nested: root/a/b/c/d/leaf.txt (depth = 4)
    mkdirSync(join(root, 'a', 'b', 'c', 'd'), { recursive: true });
    writeFileSync(join(root, 'a', 'b', 'c', 'd', 'leaf.txt'), 'deep\n');
    // unsupported extension
    writeFileSync(join(root, 'image.bin'), Buffer.from([0, 1, 2, 3]));
  });

  afterAll(() => {
    rmSync(root, { recursive: true, force: true });
  });

  test('GET /fs/list root returns top-level (excludes node_modules)', async () => {
    const res = await request(makeApp(root)).get('/api/fs/list').query({ dir: '' });
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    const names = (res.body.entries as Array<{ name: string; type: string }>).map((e) => [e.name, e.type]);
    expect(names).toContainEqual(['README.md', 'file']);
    expect(names).toContainEqual(['src', 'dir']);
    expect(names).not.toContainEqual(['node_modules', 'dir']);
  });

  test('GET /fs/list refuses depth > 3', async () => {
    const res = await request(makeApp(root)).get('/api/fs/list').query({ dir: 'a/b/c/d' });
    expect(res.body.ok).toBe(false);
    expect(res.body.error).toMatch(/深度|depth/);
  });

  test('GET /fs/file returns content for text', async () => {
    const res = await request(makeApp(root)).get('/api/fs/file').query({ path: 'src/index.ts' });
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.content).toMatch(/export const x/);
  });

  test('GET /fs/file refuses escape', async () => {
    const res = await request(makeApp(root)).get('/api/fs/file').query({ path: '../../etc/passwd' });
    expect(res.status).toBe(403);
  });

  test('GET /fs/file rejects unsupported extension', async () => {
    const res = await request(makeApp(root)).get('/api/fs/file').query({ path: 'image.bin' });
    expect(res.status).toBe(415);
  });
});
```

- [ ] **Step 2: Run the test to confirm it fails**

Run: `pnpm --filter @zn-ai/zai test -- fs.test`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement the router**

Write `packages/zai/src/server/routes/fs.ts`:

```ts
import { Router, type IRouter } from 'express';
import { readdir, stat, readFile } from 'node:fs/promises';
import { extname, basename, sep } from 'node:path';
import { resolveSafePath } from '../utils/safePath.js';
import type { FsEntry, FsFile, FsList } from '../../shared/fs.js';

const MAX_FILE_BYTES = 2 * 1024 * 1024;
const MAX_DEPTH = 3;
const IGNORED = new Set([
  'node_modules', '.git', '.next', 'dist', 'build', '.cache', '.DS_Store',
]);

const TEXT_EXTS = new Set([
  '.md', '.markdown', '.txt', '.json', '.jsonc', '.json5',
  '.yaml', '.yml', '.toml', '.ini', '.cfg', '.conf',
  '.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs',
  '.css', '.scss', '.less', '.html', '.htm', '.xml', '.svg',
  '.sh', '.bash', '.zsh', '.fish', '.ps1',
  '.py', '.rb', '.go', '.rs', '.java', '.kt', '.swift', '.c', '.cc', '.cpp', '.h', '.hpp',
  '.sql', '.graphql', '.gql',
  '.env', '.gitignore', '.gitattributes',
]);

interface InstanceContextShape { cwd: string; cwdName: string }
function ctx(req: express.Request): InstanceContextShape {
  return req.app.locals.instanceContext as InstanceContextShape;
}

function depthOf(rel: string): number {
  if (!rel) return 0;
  return rel.split(sep).filter(Boolean).length;
}

export const fsRouter: IRouter = Router();

fsRouter.get('/fs/list', async (req, res) => {
  const { cwd } = ctx(req);
  const dir = typeof req.query.dir === 'string' ? req.query.dir : '';
  const safe = resolveSafePath(cwd, dir);
  if (!safe.ok) {
    const body: FsList = { ok: false, error: safe.error };
    res.status(403).json(body);
    return;
  }
  if (depthOf(dir) > MAX_DEPTH) {
    const body: FsList = { ok: false, error: `目录深度超过 ${MAX_DEPTH} 层，拒绝展开` };
    res.json(body);
    return;
  }
  let names: string[];
  try {
    names = await readdir(safe.abs);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'ENOENT') {
      const body: FsList = { ok: false, error: '目录不存在' };
      res.status(404).json(body);
      return;
    }
    const body: FsList = { ok: false, error: `读取目录失败：${err instanceof Error ? err.message : String(err)}` };
    res.status(500).json(body);
    return;
  }

  const entries: FsEntry[] = [];
  for (const name of names) {
    if (IGNORED.has(name)) continue;
    // Hide hidden entries below top level so .claude/.config remain
    // visible at dir="" but not deeper.
    if (depthOf(dir) >= 1 && name.startsWith('.')) continue;
    const abs = `${safe.abs}${sep}${name}`;
    let type: 'dir' | 'file';
    let size: number | null;
    try {
      const s = await stat(abs);
      if (s.isDirectory()) { type = 'dir'; size = null; }
      else if (s.isFile()) { type = 'file'; size = s.size; }
      else { continue; }
    } catch {
      continue;
    }
    const relPath = dir ? `${dir}${sep}${name}` : name;
    entries.push({ name, path: relPath.split(sep).join('/'), type, size });
  }
  // dirs first, then files; alphabetical within each.
  entries.sort((a, b) => {
    if (a.type !== b.type) return a.type === 'dir' ? -1 : 1;
    return a.name.localeCompare(b.name);
  });
  const body: FsList = { ok: true, entries };
  res.json(body);
});

fsRouter.get('/fs/file', async (req, res) => {
  const { cwd } = ctx(req);
  const rel = typeof req.query.path === 'string' ? req.query.path : '';
  if (!rel) {
    res.status(400).json({ ok: false, error: '缺少 path 参数' } satisfies FsFile);
    return;
  }
  const safe = resolveSafePath(cwd, rel);
  if (!safe.ok) {
    res.status(403).json({ ok: false, error: safe.error } satisfies FsFile);
    return;
  }
  const ext = extname(safe.abs).toLowerCase();
  if (!TEXT_EXTS.has(ext)) {
    res.status(415).json({ ok: false, error: `不支持的文件类型：${ext || '(无扩展名)'}` } satisfies FsFile);
    return;
  }
  let info;
  try {
    info = await stat(safe.abs);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'ENOENT') {
      res.status(404).json({ ok: false, error: '文件不存在' } satisfies FsFile);
      return;
    }
    res.status(500).json({ ok: false, error: `stat 失败：${err instanceof Error ? err.message : String(err)}` } satisfies FsFile);
    return;
  }
  if (!info.isFile()) {
    res.status(400).json({ ok: false, error: '不是文件' } satisfies FsFile);
    return;
  }
  if (info.size > MAX_FILE_BYTES) {
    const mb = (info.size / 1024 / 1024).toFixed(2);
    res.status(413).json({ ok: false, error: `文件过大 (${mb} MB > 2 MB)，暂不支持预览` } satisfies FsFile);
    return;
  }
  try {
    const content = await readFile(safe.abs, 'utf8');
    const body: FsFile = {
      ok: true,
      path: safe.abs,
      name: basename(safe.abs),
      size: info.size,
      mtime: info.mtime.toISOString(),
      content,
    };
    res.json(body);
  } catch (err) {
    res.status(500).json({ ok: false, error: `读取失败：${err instanceof Error ? err.message : String(err)}` } satisfies FsFile);
  }
});

export default fsRouter;
```

- [ ] **Step 4: Run the test to confirm it passes**

Run: `pnpm --filter @zn-ai/zai test -- fs.test`
Expected: PASS (5 tests).

- [ ] **Step 5: Commit**

```bash
git add packages/zai/src/server/routes/fs.ts packages/zai/src/server/routes/fs.test.ts
git commit -m "feat(zai-server): fs list + file read endpoints for split-pane"
```

---

## Task 5: Wire the new routers in `server/index.ts`

**Files:**
- Modify: `packages/zai/src/server/index.ts` (insert two `app.use('/api', ...)` lines next to `dirsRouter`).

**Interfaces:**
- Consumes: `gitRouter` (Task 3), `fsRouter` (Task 4) — both export default.
- Produces: `GET /api/git/status`, `GET /api/git/diff`, `GET /api/fs/list`, `GET /api/fs/file` reachable.

- [ ] **Step 1: Add the imports + mounts**

In `packages/zai/src/server/index.ts`, find the existing import block (around line 6–19) and the existing `app.use('/api', dirsRouter);` line (around line 79). Add `gitRouter` / `fsRouter` imports and the two new `app.use` calls.

Patch the imports:

```ts
import dirsRouter from './routes/dirs.js';
```

becomes:

```ts
import dirsRouter from './routes/dirs.js';
import gitRouter from './routes/git.js';
import fsRouter from './routes/fs.js';
```

Patch the mounts — find the existing block:

```ts
app.use('/api', dirsRouter);
```

and append directly after it:

```ts
app.use('/api', gitRouter);
app.use('/api', fsRouter);
```

- [ ] **Step 2: Re-run all backend tests**

Run: `pnpm --filter @zn-ai/zai test -- git.test fs.test safePath`
Expected: all PASS (15 tests across 3 files).

- [ ] **Step 3: Type-check**

Run: `pnpm --filter @zn-ai/zai typecheck`
Expected: exit 0.

- [ ] **Step 4: Commit**

```bash
git add packages/zai/src/server/index.ts
git commit -m "feat(zai-server): mount git + fs routers under /api"
```

---

## Task 6: Frontend `splitPane/shared.ts` — localStorage hook + constants

**Files:**
- Create: `packages/zai/src/web/src/components/splitPane/shared.ts`
- Create: `packages/zai/src/web/src/components/splitPane/shared.test.ts`

**Interfaces:**
- Produces:
  - `STORAGE_KEYS = { open: 'zai.splitPane.open', tab: 'zai.splitPane.tab', width: 'zai.splitPane.width' }`
  - `MIN_WIDTH = 320`, `MAX_WIDTH = 720`, `DEFAULT_WIDTH = 480`, `RESPONSIVE_BREAKPOINT = 1024`
  - `useLocalStorageState<T>(key: string, defaultValue: T): [T, (v: T) => void]`
  - `STATUS_COLORS: Record<GitStatusChar, string>` (M = orange, A = green, D = red, ?? = purple)

- [ ] **Step 1: Write the failing test**

Write `packages/zai/src/web/src/components/splitPane/shared.test.ts`:

```tsx
// @vitest-environment happy-dom
import { describe, it, expect, beforeEach } from 'vitest';
import { act, renderHook } from '@testing-library/react';
import { useLocalStorageState, STORAGE_KEYS, DEFAULT_WIDTH } from './shared.js';

beforeEach(() => {
  localStorage.clear();
});

describe('useLocalStorageState', () => {
  it('returns default when key is absent', () => {
    const { result } = renderHook(() => useLocalStorageState(STORAGE_KEYS.width, DEFAULT_WIDTH));
    expect(result.current[0]).toBe(DEFAULT_WIDTH);
  });

  it('writes new value to localStorage on setter', () => {
    const { result } = renderHook(() => useLocalStorageState(STORAGE_KEYS.width, DEFAULT_WIDTH));
    act(() => result.current[1](600));
    expect(localStorage.getItem(STORAGE_KEYS.width)).toBe('600');
    expect(result.current[0]).toBe(600);
  });

  it('reads existing value on mount', () => {
    localStorage.setItem(STORAGE_KEYS.tab, '"fs"');
    const { result } = renderHook(() => useLocalStorageState(STORAGE_KEYS.tab, 'git' as const));
    expect(result.current[0]).toBe('fs');
  });

  it('falls back to default when stored JSON is corrupt', () => {
    localStorage.setItem(STORAGE_KEYS.width, 'not-json');
    const { result } = renderHook(() => useLocalStorageState(STORAGE_KEYS.width, DEFAULT_WIDTH));
    expect(result.current[0]).toBe(DEFAULT_WIDTH);
  });
});
```

- [ ] **Step 2: Run the test to confirm it fails**

Run: `pnpm --filter @zn-ai/zai test -- shared.test`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement shared.ts**

Write `packages/zai/src/web/src/components/splitPane/shared.ts`:

```ts
import { useCallback, useEffect, useState } from 'react';
import type { GitStatusChar } from '../../../../shared/git.js';

export const STORAGE_KEYS = {
  open: 'zai.splitPane.open',
  tab: 'zai.splitPane.tab',
  width: 'zai.splitPane.width',
} as const;

export const MIN_WIDTH = 320;
export const MAX_WIDTH = 720;
export const DEFAULT_WIDTH = 480;
export const RESPONSIVE_BREAKPOINT = 1024;
export const COLLAPSED_WIDTH = 0;

export function clampWidth(value: number): number {
  if (!Number.isFinite(value)) return DEFAULT_WIDTH;
  return Math.min(MAX_WIDTH, Math.max(MIN_WIDTH, Math.round(value)));
}

/**
 * JSON-encoded localStorage state hook. Reads on mount (with default
 * fallback for missing or unparseable values); writes on every setter call.
 * The serializer is JSON.stringify/parse — primitives, strings, numbers,
 * booleans, arrays, objects. Falsy stored values are still valid; we only
 * fall back when JSON.parse throws.
 */
export function useLocalStorageState<T>(
  key: string,
  defaultValue: T,
): [T, (next: T) => void] {
  const [value, setValue] = useState<T>(() => {
    try {
      const raw = localStorage.getItem(key);
      if (raw === null) return defaultValue;
      return JSON.parse(raw) as T;
    } catch {
      return defaultValue;
    }
  });

  // Sync from a different component instance (e.g. tab change from a
  // sibling). Storage event is sufficient for our case — we don't need
  // BroadcastChannel because all state mutations happen through this hook.
  useEffect(() => {
    const onStorage = (e: StorageEvent) => {
      if (e.key !== key || e.newValue === null) return;
      try {
        setValue(JSON.parse(e.newValue) as T);
      } catch {
        // ignore corrupt updates
      }
    };
    window.addEventListener('storage', onStorage);
    return () => window.removeEventListener('storage', onStorage);
  }, [key]);

  const set = useCallback(
    (next: T) => {
      setValue(next);
      try {
        localStorage.setItem(key, JSON.stringify(next));
      } catch {
        // quota / privacy mode — silently ignore, in-memory state still works.
      }
    },
    [key],
  );

  return [value, set];
}

export const STATUS_COLORS: Record<GitStatusChar, string> = {
  M: '#ff8533', // modified
  A: '#52c41a', // added
  D: '#f5222d', // deleted
  '??': '#a78bfa', // untracked
};

export const STATUS_LABELS: Record<GitStatusChar, string> = {
  M: '已修改',
  A: '已新增',
  D: '已删除',
  '??': '未跟踪',
};
```

- [ ] **Step 4: Run the test to confirm it passes**

Run: `pnpm --filter @zn-ai/zai test -- shared.test`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add packages/zai/src/web/src/components/splitPane/shared.ts packages/zai/src/web/src/components/splitPane/shared.test.ts
git commit -m "feat(zai-web): split-pane localStorage helpers + status colors"
```

---

## Task 7: Frontend hooks — `useGitStatus`, `useGitDiff`, `useFsList`, `useFsFile`

**Files:**
- Create: `packages/zai/src/web/src/components/splitPane/useGitStatus.ts`
- Create: `packages/zai/src/web/src/components/splitPane/useGitStatus.test.ts`
- Create: `packages/zai/src/web/src/components/splitPane/useGitDiff.ts`
- Create: `packages/zai/src/web/src/components/splitPane/useFsList.ts`
- Create: `packages/zai/src/web/src/components/splitPane/useFsFile.ts`

**Interfaces:**
- Produces:
  - `useGitStatus(cwd: string | null | undefined): { data: GitStatus | null; loading: boolean; error: string | null; refetch: () => void }`
  - `useGitDiff(cwd: string | null | undefined, path: string | null): { data: GitDiff | null; loading: boolean; error: string | null }`
  - `useFsList(cwd: string | null | undefined, dir: string): { data: FsList | null; loading: boolean; error: string | null; refetch: () => void }`
  - `useFsFile(cwd: string | null | undefined, path: string | null): { data: FsFile | null; loading: boolean; error: string | null }`

- [ ] **Step 1: Write the failing test for `useGitStatus`**

Write `packages/zai/src/web/src/components/splitPane/useGitStatus.test.ts`:

```tsx
// @vitest-environment happy-dom
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, waitFor } from '@testing-library/react';
import { useGitStatus } from './useGitStatus.js';

// Mock the api module that the hook imports. Stubbing at module level
// avoids spinning up MSW — these are pure happy-dom tests.
vi.mock('../../lib/api.js', () => ({
  api: {
    get: vi.fn(),
  },
}));

import { api } from '../../lib/api.js';

const mockGet = api.get as unknown as ReturnType<typeof vi.fn>;

describe('useGitStatus', () => {
  beforeEach(() => {
    mockGet.mockReset();
  });

  it('does not fetch when cwd is null', () => {
    renderHook(() => useGitStatus(null));
    expect(mockGet).not.toHaveBeenCalled();
  });

  it('fetches /api/git/status on cwd', async () => {
    mockGet.mockResolvedValue({ ok: true, branch: 'main', files: [] });
    const { result } = renderHook(() => useGitStatus('/tmp/repo'));
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(mockGet).toHaveBeenCalledWith('/git/status');
    expect(result.current.data?.branch).toBe('main');
  });

  it('surfaces error string when ok:false', async () => {
    mockGet.mockResolvedValue({ ok: false, error: 'not a git repository' });
    const { result } = renderHook(() => useGitStatus('/tmp/notrepo'));
    await waitFor(() => expect(result.current.error).toBe('not a git repository'));
  });

  it('surfaces thrown error', async () => {
    mockGet.mockRejectedValue(new Error('network down'));
    const { result } = renderHook(() => useGitStatus('/tmp/x'));
    await waitFor(() => expect(result.current.error).toBe('network down'));
  });
});
```

- [ ] **Step 2: Run the test to confirm it fails**

Run: `pnpm --filter @zn-ai/zai test -- useGitStatus.test`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement `useGitStatus`**

Write `packages/zai/src/web/src/components/splitPane/useGitStatus.ts`:

```ts
import { useCallback, useEffect, useRef, useState } from 'react';
import { api } from '../../lib/api.js';
import type { GitStatus } from '../../../../shared/git.js';

export interface UseGitStatusResult {
  data: GitStatus | null;
  loading: boolean;
  error: string | null;
  refetch: () => void;
}

export function useGitStatus(cwd: string | null | undefined): UseGitStatusResult {
  const [data, setData] = useState<GitStatus | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const seqRef = useRef(0);

  const load = useCallback(() => {
    if (!cwd) {
      setData(null);
      setError(null);
      setLoading(false);
      return;
    }
    const seq = ++seqRef.current;
    setLoading(true);
    setError(null);
    api
      .get<GitStatus>('/git/status')
      .then((res) => {
        if (seqRef.current !== seq) return; // stale
        setData(res);
        setError(res.ok ? null : res.error ?? '未知错误');
      })
      .catch((err) => {
        if (seqRef.current !== seq) return;
        setError(err instanceof Error ? err.message : String(err));
      })
      .finally(() => {
        if (seqRef.current === seq) setLoading(false);
      });
  }, [cwd]);

  useEffect(() => {
    load();
  }, [load]);

  return { data, loading, error, refetch: load };
}
```

- [ ] **Step 4: Run the test to confirm it passes**

Run: `pnpm --filter @zn-ai/zai test -- useGitStatus.test`
Expected: PASS (4 tests).

- [ ] **Step 5: Implement `useGitDiff`**

Write `packages/zai/src/web/src/components/splitPane/useGitDiff.ts`:

```ts
import { useEffect, useRef, useState } from 'react';
import { api } from '../../lib/api.js';
import type { GitDiff } from '../../../../shared/git.js';

export interface UseGitDiffResult {
  data: GitDiff | null;
  loading: boolean;
  error: string | null;
}

export function useGitDiff(
  cwd: string | null | undefined,
  path: string | null,
): UseGitDiffResult {
  const [data, setData] = useState<GitDiff | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const seqRef = useRef(0);

  useEffect(() => {
    if (!cwd || !path) {
      setData(null);
      setError(null);
      setLoading(false);
      return;
    }
    const seq = ++seqRef.current;
    setLoading(true);
    setError(null);
    api
      .get<GitDiff>(`/git/diff?path=${encodeURIComponent(path)}`)
      .then((res) => {
        if (seqRef.current !== seq) return;
        setData(res);
        setError(res.ok ? null : res.error ?? '未知错误');
      })
      .catch((err) => {
        if (seqRef.current !== seq) return;
        setError(err instanceof Error ? err.message : String(err));
      })
      .finally(() => {
        if (seqRef.current === seq) setLoading(false);
      });
  }, [cwd, path]);

  return { data, loading, error };
}
```

- [ ] **Step 6: Implement `useFsList`**

Write `packages/zai/src/web/src/components/splitPane/useFsList.ts`:

```ts
import { useCallback, useEffect, useRef, useState } from 'react';
import { api } from '../../lib/api.js';
import type { FsList } from '../../../../shared/fs.js';

export interface UseFsListResult {
  data: FsList | null;
  loading: boolean;
  error: string | null;
  refetch: () => void;
}

export function useFsList(cwd: string | null | undefined, dir: string): UseFsListResult {
  const [data, setData] = useState<FsList | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const seqRef = useRef(0);

  const load = useCallback(() => {
    if (!cwd) {
      setData(null);
      setError(null);
      setLoading(false);
      return;
    }
    const seq = ++seqRef.current;
    setLoading(true);
    setError(null);
    api
      .get<FsList>(`/fs/list?dir=${encodeURIComponent(dir)}`)
      .then((res) => {
        if (seqRef.current !== seq) return;
        setData(res);
        setError(res.ok ? null : res.error ?? '未知错误');
      })
      .catch((err) => {
        if (seqRef.current !== seq) return;
        setError(err instanceof Error ? err.message : String(err));
      })
      .finally(() => {
        if (seqRef.current === seq) setLoading(false);
      });
  }, [cwd, dir]);

  useEffect(() => {
    load();
  }, [load]);

  return { data, loading, error, refetch: load };
}
```

- [ ] **Step 7: Implement `useFsFile`**

Write `packages/zai/src/web/src/components/splitPane/useFsFile.ts`:

```ts
import { useEffect, useRef, useState } from 'react';
import { api } from '../../lib/api.js';
import type { FsFile } from '../../../../shared/fs.js';

export interface UseFsFileResult {
  data: FsFile | null;
  loading: boolean;
  error: string | null;
}

export function useFsFile(
  cwd: string | null | undefined,
  path: string | null,
): UseFsFileResult {
  const [data, setData] = useState<FsFile | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const seqRef = useRef(0);

  useEffect(() => {
    if (!cwd || !path) {
      setData(null);
      setError(null);
      setLoading(false);
      return;
    }
    const seq = ++seqRef.current;
    setLoading(true);
    setError(null);
    api
      .get<FsFile>(`/fs/file?path=${encodeURIComponent(path)}`)
      .then((res) => {
        if (seqRef.current !== seq) return;
        // ok:false responses are emitted as 200 by the server; the api helper
        // unwraps them and we surface `error` directly to the caller.
        setData(res);
        setError(res.ok ? null : res.error ?? '未知错误');
      })
      .catch((err) => {
        if (seqRef.current !== seq) return;
        setError(err instanceof Error ? err.message : String(err));
      })
      .finally(() => {
        if (seqRef.current === seq) setLoading(false);
      });
  }, [cwd, path]);

  return { data, loading, error };
}
```

- [ ] **Step 8: Run all hook tests + frontend helper tests**

Run: `pnpm --filter @zn-ai/zai test -- useGitStatus.test shared.test`
Expected: PASS.

- [ ] **Step 9: Commit**

```bash
git add packages/zai/src/web/src/components/splitPane/useGitStatus.ts \
        packages/zai/src/web/src/components/splitPane/useGitStatus.test.ts \
        packages/zai/src/web/src/components/splitPane/useGitDiff.ts \
        packages/zai/src/web/src/components/splitPane/useFsList.ts \
        packages/zai/src/web/src/components/splitPane/useFsFile.ts
git commit -m "feat(zai-web): split-pane data hooks for git + fs endpoints"
```

---

## Task 8: Frontend `DiffView` — unified diff renderer

**Files:**
- Create: `packages/zai/src/web/src/components/splitPane/DiffView.tsx`
- Create: `packages/zai/src/web/src/components/splitPane/DiffView.test.tsx`

**Interfaces:**
- Produces: `<DiffView diff={string} />` — pure presentational, parses unified diff text, renders colored rows.

- [ ] **Step 1: Write the failing test**

Write `packages/zai/src/web/src/components/splitPane/DiffView.test.tsx`:

```tsx
// @vitest-environment happy-dom
import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { DiffView } from './DiffView.js';

const SAMPLE = [
  'diff --git a/foo.ts b/foo.ts',
  'index 0000..1111 100644',
  '--- a/foo.ts',
  '+++ b/foo.ts',
  '@@ -1,2 +1,2 @@',
  ' unchanged',
  '-old line',
  '+new line',
  '+another new',
].join('\n');

describe('DiffView', () => {
  it('renders empty state for empty diff', () => {
    render(<DiffView diff="" />);
    expect(screen.getByText(/没有差异/i)).toBeTruthy();
  });

  it('renders added lines with + marker', () => {
    render(<DiffView diff={SAMPLE} />);
    expect(screen.getAllByText('+new line').length).toBeGreaterThan(0);
    expect(screen.getAllByText('+another new').length).toBeGreaterThan(0);
  });

  it('renders deleted lines with - marker', () => {
    render(<DiffView diff={SAMPLE} />);
    expect(screen.getAllByText('-old line').length).toBeGreaterThan(0);
  });

  it('renders hunk header', () => {
    render(<DiffView diff={SAMPLE} />);
    expect(screen.getAllByText(/@@ -1,2 \+1,2 @@/).length).toBeGreaterThan(0);
  });
});
```

- [ ] **Step 2: Run the test to confirm it fails**

Run: `pnpm --filter @zn-ai/zai test -- DiffView.test`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement `DiffView`**

Write `packages/zai/src/web/src/components/splitPane/DiffView.tsx`:

```tsx
import { Empty } from 'antd';

const MONO = 'ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace';
const ADD_BG = 'rgba(46,160,67,0.18)';
const ADD_FG = '#3fb950';
const DEL_BG = 'rgba(248,81,73,0.18)';
const DEL_FG = '#f85149';
const CTX_FG = 'rgba(255,255,255,0.72)';
const GUTTER_FG = 'rgba(255,255,255,0.30)';
const HUNK_FG = 'rgba(167,139,250,0.85)';

type Row =
  | { kind: 'add'; text: string }
  | { kind: 'del'; text: string }
  | { kind: 'ctx'; text: string }
  | { kind: 'hunk'; text: string };

function classify(line: string): Row {
  if (line.startsWith('@@')) return { kind: 'hunk', text: line };
  if (line.startsWith('+')) return { kind: 'add', text: line.slice(1) };
  if (line.startsWith('-')) return { kind: 'del', text: line.slice(1) };
  return { kind: 'ctx', text: line.startsWith(' ') ? line.slice(1) : line };
}

function rowStyle(kind: Row['kind']): React.CSSProperties {
  switch (kind) {
    case 'add': return { background: ADD_BG, color: ADD_FG };
    case 'del': return { background: DEL_BG, color: DEL_FG };
    case 'hunk': return { color: HUNK_FG, fontWeight: 600 };
    default: return { color: CTX_FG };
  }
}

export function DiffView({ diff }: { diff: string }) {
  if (!diff) {
    return <Empty description="没有差异" />;
  }
  const lines = diff.split('\n');
  return (
    <div
      data-testid="diff-view"
      style={{
        fontFamily: MONO,
        fontSize: 12,
        lineHeight: 1.55,
        border: '1px solid rgba(255,255,255,0.08)',
        borderRadius: 6,
        padding: '6px 0',
        maxHeight: 'calc(100vh - 360px)',
        minHeight: 200,
        overflow: 'auto',
        background: 'rgba(255,255,255,0.02)',
      }}
    >
      {lines.map((line, idx) => {
        const row = classify(line);
        return (
          <div
            key={idx}
            style={{ display: 'flex', minWidth: 'max-content', ...rowStyle(row.kind) }}
          >
            <span
              style={{
                flexShrink: 0,
                width: 16,
                textAlign: 'center',
                color: GUTTER_FG,
                userSelect: 'none',
              }}
            >
              {row.kind === 'add' ? '+' : row.kind === 'del' ? '-' : ' '}
            </span>
            <span style={{ whiteSpace: 'pre', paddingRight: 12 }}>
              {row.text || ' '}
            </span>
          </div>
        );
      })}
    </div>
  );
}
```

- [ ] **Step 4: Run the test to confirm it passes**

Run: `pnpm --filter @zn-ai/zai test -- DiffView.test`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add packages/zai/src/web/src/components/splitPane/DiffView.tsx \
        packages/zai/src/web/src/components/splitPane/DiffView.test.tsx
git commit -m "feat(zai-web): split-pane unified DiffView renderer"
```

---

## Task 9: Frontend `GitTab` — list + diff

**Files:**
- Create: `packages/zai/src/web/src/components/splitPane/GitTab.tsx`
- Create: `packages/zai/src/web/src/components/splitPane/GitTab.test.tsx`

**Interfaces:**
- Produces: `<GitTab cwd={string | null} />` — left column = file list, right column = `DiffView`.

- [ ] **Step 1: Write the failing test**

Write `packages/zai/src/web/src/components/splitPane/GitTab.test.tsx`:

```tsx
// @vitest-environment happy-dom
import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';

// Mock the hooks this component uses.
vi.mock('./useGitStatus.js', () => ({
  useGitStatus: vi.fn(),
}));
vi.mock('./useGitDiff.js', () => ({
  useGitDiff: vi.fn(),
}));

import { useGitStatus } from './useGitStatus.js';
import { useGitDiff } from './useGitDiff.js';
import { GitTab } from './GitTab.js';

const mockStatus = useGitStatus as unknown as ReturnType<typeof vi.fn>;
const mockDiff = useGitDiff as unknown as ReturnType<typeof vi.fn>;

describe('GitTab', () => {
  it('renders empty state when cwd is null', () => {
    mockStatus.mockReturnValue({ data: null, loading: false, error: null, refetch: vi.fn() });
    mockDiff.mockReturnValue({ data: null, loading: false, error: null });
    render(<GitTab cwd={null} />);
    expect(screen.getByText(/未选择会话/i)).toBeTruthy();
  });

  it('renders file list from useGitStatus', async () => {
    mockStatus.mockReturnValue({
      data: { ok: true, branch: 'feat/x', files: [{ path: 'a.ts', status: 'M', staged: false }] },
      loading: false,
      error: null,
      refetch: vi.fn(),
    });
    mockDiff.mockReturnValue({ data: null, loading: false, error: null });
    render(<GitTab cwd="/repo" />);
    expect(screen.getByText('a.ts')).toBeTruthy();
    expect(screen.getByText('feat/x')).toBeTruthy();
  });

  it('shows non-git error', () => {
    mockStatus.mockReturnValue({
      data: { ok: false, error: 'not a git repository' },
      loading: false,
      error: 'not a git repository',
      refetch: vi.fn(),
    });
    mockDiff.mockReturnValue({ data: null, loading: false, error: null });
    render(<GitTab cwd="/notrepo" />);
    expect(screen.getByText(/not a git repository/i)).toBeTruthy();
  });

  it('shows hint to select a file when list is loaded but nothing picked', () => {
    mockStatus.mockReturnValue({
      data: { ok: true, branch: 'main', files: [] },
      loading: false,
      error: null,
      refetch: vi.fn(),
    });
    mockDiff.mockReturnValue({ data: null, loading: false, error: null });
    render(<GitTab cwd="/repo" />);
    expect(screen.getByText(/选择左侧文件/i)).toBeTruthy();
  });
});
```

- [ ] **Step 2: Run the test to confirm it fails**

Run: `pnpm --filter @zn-ai/zai test -- GitTab.test`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement `GitTab`**

Write `packages/zai/src/web/src/components/splitPane/GitTab.tsx`:

```tsx
import { useEffect, useState } from 'react';
import { Button, Empty, Spin, Tag } from 'antd';
import { ReloadOutlined } from '@ant-design/icons';
import { useGitStatus } from './useGitStatus.js';
import { useGitDiff } from './useGitDiff.js';
import { DiffView } from './DiffView.js';
import { STATUS_COLORS, STATUS_LABELS } from './shared.js';
import type { GitStatusChar } from '../../../../shared/git.js';

const MONO = 'ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace';

export function GitTab({ cwd }: { cwd: string | null }) {
  const status = useGitStatus(cwd);
  const [selected, setSelected] = useState<string | null>(null);
  const diff = useGitDiff(cwd, selected);

  // When cwd changes, drop the selection — old paths no longer apply.
  useEffect(() => {
    setSelected(null);
  }, [cwd]);

  if (!cwd) {
    return (
      <div style={{ padding: 16 }}>
        <Empty description="未选择会话 cwd" />
      </div>
    );
  }

  const refreshBtn = (
    <Button
      size="small"
      icon={<ReloadOutlined />}
      loading={status.loading}
      onClick={() => status.refetch()}
      title="刷新 git 状态"
    >
      刷新
    </Button>
  );

  if (status.error && !status.data?.ok) {
    return (
      <div style={{ padding: 12, display: 'flex', flexDirection: 'column', gap: 8, height: '100%' }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
          <span style={{ color: 'rgba(255,255,255,0.55)', fontSize: 12 }}>Git</span>
          {refreshBtn}
        </div>
        <Empty description={status.error} />
      </div>
    );
  }

  const files = status.data?.files ?? [];
  const branch = status.data?.branch ?? null;

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%' }}>
      <div
        style={{
          display: 'flex',
          justifyContent: 'space-between',
          alignItems: 'center',
          padding: '6px 12px',
          borderBottom: '1px solid rgba(255,255,255,0.08)',
        }}
      >
        <span style={{ fontSize: 12, color: 'rgba(255,255,255,0.55)' }}>
          Git {branch ? <Tag color="orange" style={{ marginLeft: 6 }}>{branch}</Tag> : null}
          <span style={{ marginLeft: 8, color: 'rgba(255,255,255,0.35)' }}>{files.length} 项变更</span>
        </span>
        {refreshBtn}
      </div>
      <div style={{ display: 'flex', flex: 1, minHeight: 0 }}>
        {/* Left list */}
        <div
          data-testid="git-list"
          style={{
            flex: '0 0 40%',
            overflowY: 'auto',
            borderRight: '1px solid rgba(255,255,255,0.08)',
            padding: '4px 0',
          }}
        >
          {status.loading && files.length === 0 ? (
            <div style={{ padding: 16, textAlign: 'center' }}>
              <Spin />
            </div>
          ) : files.length === 0 ? (
            <div style={{ padding: 16, color: 'rgba(255,255,255,0.45)', fontSize: 12 }}>
              没有变更
            </div>
          ) : (
            files.map((f) => {
              const isSel = selected === f.path;
              return (
                <div
                  key={f.path}
                  role="button"
                  onClick={() => setSelected(f.path)}
                  style={{
                    padding: '6px 12px',
                    cursor: 'pointer',
                    background: isSel ? 'rgba(255,102,0,0.12)' : 'transparent',
                    display: 'flex',
                    alignItems: 'center',
                    gap: 8,
                    fontFamily: MONO,
                    fontSize: 12,
                  }}
                >
                  <span
                    style={{
                      display: 'inline-block',
                      width: 20,
                      textAlign: 'center',
                      color: STATUS_COLORS[f.status as GitStatusChar],
                      fontWeight: 700,
                    }}
                  >
                    {f.status === '??' ? '?' : f.status}
                  </span>
                  <span
                    style={{
                      flex: 1,
                      minWidth: 0,
                      overflow: 'hidden',
                      textOverflow: 'ellipsis',
                      whiteSpace: 'nowrap',
                      color: 'rgba(255,255,255,0.85)',
                    }}
                    title={f.path}
                  >
                    {f.path}
                  </span>
                  {f.staged && (
                    <span
                      style={{
                        fontSize: 10,
                        color: 'rgba(167,139,250,0.85)',
                        border: '1px solid rgba(167,139,250,0.35)',
                        borderRadius: 3,
                        padding: '0 4px',
                      }}
                      title={STATUS_LABELS[f.status as GitStatusChar]}
                    >
                      staged
                    </span>
                  )}
                </div>
              );
            })
          )}
        </div>
        {/* Right detail */}
        <div
          data-testid="git-detail"
          style={{ flex: '0 0 60%', padding: 12, overflow: 'auto' }}
        >
          {!selected ? (
            <Empty description="选择左侧文件查看 diff" />
          ) : diff.loading ? (
            <div style={{ textAlign: 'center', padding: 24 }}>
              <Spin />
            </div>
          ) : diff.error ? (
            <Empty description={diff.error} />
          ) : diff.data?.diff !== undefined ? (
            <DiffView diff={diff.data.diff} />
          ) : (
            <Empty description="没有差异" />
          )}
        </div>
      </div>
    </div>
  );
}
```

- [ ] **Step 4: Run the test to confirm it passes**

Run: `pnpm --filter @zn-ai/zai test -- GitTab.test`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add packages/zai/src/web/src/components/splitPane/GitTab.tsx \
        packages/zai/src/web/src/components/splitPane/GitTab.test.tsx
git commit -m "feat(zai-web): split-pane GitTab (file list + diff)"
```

---

## Task 10: Frontend `FsTab` — directory tree + preview

**Files:**
- Create: `packages/zai/src/web/src/components/splitPane/FsTab.tsx`
- Create: `packages/zai/src/web/src/components/splitPane/FsTab.test.tsx`

**Interfaces:**
- Produces: `<FsTab cwd={string | null} />` — left column = AntD `Tree`, right column = `useFsFile` preview.

- [ ] **Step 1: Write the failing test**

Write `packages/zai/src/web/src/components/splitPane/FsTab.test.tsx`:

```tsx
// @vitest-environment happy-dom
import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';

vi.mock('./useFsList.js', () => ({ useFsList: vi.fn() }));
vi.mock('./useFsFile.js', () => ({ useFsFile: vi.fn() }));

import { useFsList } from './useFsList.js';
import { useFsFile } from './useFsFile.js';
import { FsTab } from './FsTab.js';

const mockList = useFsList as unknown as ReturnType<typeof vi.fn>;
const mockFile = useFsFile as unknown as ReturnType<typeof vi.fn>;

describe('FsTab', () => {
  it('renders empty state when cwd is null', () => {
    mockList.mockReturnValue({ data: null, loading: false, error: null, refetch: vi.fn() });
    mockFile.mockReturnValue({ data: null, loading: false, error: null });
    render(<FsTab cwd={null} />);
    expect(screen.getByText(/未选择会话/i)).toBeTruthy();
  });

  it('renders entries from useFsList', () => {
    mockList.mockReturnValue({
      data: { ok: true, entries: [{ name: 'src', path: 'src', type: 'dir', size: null }] },
      loading: false,
      error: null,
      refetch: vi.fn(),
    });
    mockFile.mockReturnValue({ data: null, loading: false, error: null });
    render(<FsTab cwd="/repo" />);
    expect(screen.getByText('src')).toBeTruthy();
  });

  it('renders empty hint when nothing selected', () => {
    mockList.mockReturnValue({
      data: { ok: true, entries: [] },
      loading: false,
      error: null,
      refetch: vi.fn(),
    });
    mockFile.mockReturnValue({ data: null, loading: false, error: null });
    render(<FsTab cwd="/repo" />);
    expect(screen.getByText(/选择左侧文件查看内容/i)).toBeTruthy();
  });

  it('shows error from useFsList', () => {
    mockList.mockReturnValue({
      data: { ok: false, error: '目录深度超过 3 层' },
      loading: false,
      error: '目录深度超过 3 层',
      refetch: vi.fn(),
    });
    mockFile.mockReturnValue({ data: null, loading: false, error: null });
    render(<FsTab cwd="/repo" />);
    expect(screen.getByText(/目录深度超过 3 层/)).toBeTruthy();
  });
});
```

- [ ] **Step 2: Run the test to confirm it fails**

Run: `pnpm --filter @zn-ai/zai test -- FsTab.test`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement `FsTab`**

Write `packages/zai/src/web/src/components/splitPane/FsTab.tsx`:

```tsx
import { useEffect, useState } from 'react';
import { Button, Empty, Spin, Tree } from 'antd';
import { ReloadOutlined, FolderOutlined, FileOutlined } from '@ant-design/icons';
import type { DataNode } from 'antd/es/tree';
import { useFsList } from './useFsList.js';
import { useFsFile } from './useFsFile.js';
import { MAX_DEPTH } from './shared.js';

const MONO = 'ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace';

interface NodeMeta {
  absPath: string;
  type: 'dir' | 'file';
  size: number | null;
  loaded?: boolean;
}

function entryToNode(entry: { name: string; path: string; type: 'dir' | 'file' }, onLoad: (path: string) => void): DataNode {
  const meta: NodeMeta = { absPath: entry.path, type: entry.type, size: entry.size };
  return {
    key: entry.path,
    title: <span style={{ fontFamily: MONO, fontSize: 12 }}>{entry.name}</span>,
    icon: entry.type === 'dir' ? <FolderOutlined /> : <FileOutlined />,
    isLeaf: entry.type === 'file',
    // AntD Tree calls onLoad when a dir is expanded; we lazy-fetch children.
    children: entry.type === 'dir' ? [{ key: `${entry.path}__placeholder`, title: '…', isLeaf: true }] : undefined,
    // We can't easily attach meta via DataNode (no metadata field). Use a
    // closure map keyed by node key to look up type when handling clicks.
    // For simplicity here we rely on the key being the path string.
  } as DataNode & NodeMeta;
  void meta;
  void onLoad;
}

// We track loaded children in a map keyed by parent path.
type LoadedMap = Record<string, Array<{ name: string; path: string; type: 'dir' | 'file'; size: number | null }>>;

export function FsTab({ cwd }: { cwd: string | null }) {
  const root = useFsList(cwd, '');
  const [selected, setSelected] = useState<string | null>(null);
  const [expandedKeys, setExpandedKeys] = useState<React.Key[]>([]);
  const [loaded, setLoaded] = useState<LoadedMap>({});
  const file = useFsFile(cwd, selected);

  // Reset on cwd change.
  useEffect(() => {
    setSelected(null);
    setExpandedKeys([]);
    setLoaded({});
  }, [cwd]);

  if (!cwd) {
    return (
      <div style={{ padding: 16 }}>
        <Empty description="未选择会话 cwd" />
      </div>
    );
  }

  const handleLoadData = (treeNode: DataNode): Promise<void> =>
    new Promise((resolve) => {
      const key = String(treeNode.key);
      if (loaded[key]) {
        resolve();
        return;
      }
      useFsList.getState // not used; this pattern won't work — we need a way
      // to fetch a sub-dir without a hook. Inline a one-shot fetch instead:
      void fetch(`/api/fs/list?dir=${encodeURIComponent(key)}`)
        .then((r) => r.json())
        .then((j) => {
          if (j?.ok && Array.isArray(j.entries)) {
            setLoaded((cur) => ({ ...cur, [key]: j.entries }));
          } else {
            setLoaded((cur) => ({ ...cur, [key]: [] }));
          }
          resolve();
        })
        .catch(() => {
          setLoaded((cur) => ({ ...cur, [key]: [] }));
          resolve();
        });
    });

  const renderTree = (entries: Array<{ name: string; path: string; type: 'dir' | 'file'; size: number | null }>): DataNode[] =>
    entries.map((e) => {
      const children = loaded[e.path];
      return {
        key: e.path,
        title: <span style={{ fontFamily: MONO, fontSize: 12 }}>{e.name}</span>,
        icon: e.type === 'dir' ? <FolderOutlined /> : <FileOutlined />,
        isLeaf: e.type === 'file',
        children:
          e.type === 'dir'
            ? children
              ? renderTree(children)
              : [{ key: `${e.path}__ph`, title: '…', isLeaf: true }]
            : undefined,
      } as DataNode;
    });

  const refreshBtn = (
    <Button
      size="small"
      icon={<ReloadOutlined />}
      loading={root.loading}
      onClick={() => root.refetch()}
      title="刷新目录"
    >
      刷新
    </Button>
  );

  const treeData = root.data?.ok && root.data.entries ? renderTree(root.data.entries) : [];

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%' }}>
      <div
        style={{
          display: 'flex',
          justifyContent: 'space-between',
          alignItems: 'center',
          padding: '6px 12px',
          borderBottom: '1px solid rgba(255,255,255,0.08)',
        }}
      >
        <span style={{ fontSize: 12, color: 'rgba(255,255,255,0.55)' }}>
          Files <span style={{ marginLeft: 8, color: 'rgba(255,255,255,0.35)' }}>(深度 ≤ {MAX_DEPTH})</span>
        </span>
        {refreshBtn}
      </div>
      <div style={{ display: 'flex', flex: 1, minHeight: 0 }}>
        <div
          data-testid="fs-tree"
          style={{
            flex: '0 0 40%',
            overflow: 'auto',
            borderRight: '1px solid rgba(255,255,255,0.08)',
            padding: '4px 8px',
          }}
        >
          {root.error && !root.data?.ok ? (
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
              onSelect={(keys) => {
                const k = keys[0];
                if (typeof k === 'string' && !k.endsWith('__ph')) setSelected(k);
              }}
            />
          )}
        </div>
        <div
          data-testid="fs-preview"
          style={{
            flex: '0 0 60%',
            padding: 12,
            overflow: 'auto',
            fontFamily: MONO,
            fontSize: 12,
          }}
        >
          {!selected ? (
            <Empty description="选择左侧文件查看内容" />
          ) : file.loading ? (
            <div style={{ textAlign: 'center', padding: 24 }}>
              <Spin />
            </div>
          ) : file.error ? (
            <Empty description={file.error} />
          ) : file.data?.content !== undefined ? (
            <pre
              style={{
                margin: 0,
                padding: 12,
                background: 'rgba(255,255,255,0.04)',
                borderRadius: 6,
                maxHeight: 'calc(100vh - 360px)',
                overflow: 'auto',
                whiteSpace: 'pre-wrap',
                wordBreak: 'break-word',
              }}
            >
              {file.data.content}
            </pre>
          ) : (
            <Empty description="没有内容" />
          )}
        </div>
      </div>
    </div>
  );
}
```

- [ ] **Step 4: Run the test to confirm it passes**

Run: `pnpm --filter @zn-ai/zai test -- FsTab.test`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add packages/zai/src/web/src/components/splitPane/FsTab.tsx \
        packages/zai/src/web/src/components/splitPane/FsTab.test.tsx
git commit -m "feat(zai-web): split-pane FsTab (tree + file preview)"
```

---

## Task 11: Frontend `PlaceholderTab` + `SplitPane` shell

**Files:**
- Create: `packages/zai/src/web/src/components/splitPane/PlaceholderTab.tsx`
- Create: `packages/zai/src/web/src/components/splitPane/SplitPane.tsx`
- Create: `packages/zai/src/web/src/components/splitPane/SplitPane.test.tsx`

**Interfaces:**
- Produces:
  - `<PlaceholderTab />` — `<Empty description="即将到来" />`.
  - `<SplitPane cwd={string | null}>{children}</SplitPane>` — renders three-column layout with toggle, tabs, splitter handle. The `children` slot is unused (tabs are managed internally).

- [ ] **Step 1: Create `PlaceholderTab`**

Write `packages/zai/src/web/src/components/splitPane/PlaceholderTab.tsx`:

```tsx
import { Empty } from 'antd';

export function PlaceholderTab() {
  return (
    <div style={{ padding: 24 }}>
      <Empty description="即将到来" />
    </div>
  );
}
```

- [ ] **Step 2: Write the failing test for `SplitPane`**

Write `packages/zai/src/web/src/components/splitPane/SplitPane.test.tsx`:

```tsx
// @vitest-environment happy-dom
import { describe, it, expect, beforeEach } from 'vitest';
import { act, render, screen, fireEvent } from '@testing-library/react';
import { SplitPane } from './SplitPane.js';

beforeEach(() => {
  localStorage.clear();
  // happy-dom defaults innerWidth to 1024 — bump it so the responsive
  // auto-close logic doesn't trip.
  Object.defineProperty(window, 'innerWidth', { configurable: true, value: 1440 });
});

describe('SplitPane', () => {
  it('renders closed by default (no panel width)', () => {
    render(<SplitPane cwd="/repo" />);
    // Toggle button is visible.
    expect(screen.getByTitle(/切换右侧分屏/i)).toBeTruthy();
  });

  it('opens panel on toggle click', () => {
    render(<SplitPane cwd="/repo" />);
    const toggle = screen.getByTitle(/切换右侧分屏/i);
    act(() => { fireEvent.click(toggle); });
    // After open, git tab should be the active tab (default).
    expect(screen.getByText(/Git/)).toBeTruthy();
  });

  it('persists open state to localStorage', () => {
    render(<SplitPane cwd="/repo" />);
    const toggle = screen.getByTitle(/切换右侧分屏/i);
    act(() => { fireEvent.click(toggle); });
    // The hook JSON-stringifies booleans, so the stored value is 'true'.
    expect(localStorage.getItem('zai.splitPane.open')).toBe('true');
  });

  it('switches to files tab and persists', () => {
    render(<SplitPane cwd="/repo" />);
    act(() => { fireEvent.click(screen.getByTitle(/切换右侧分屏/i)); });
    const filesTab = screen.getByRole('tab', { name: /Files/i });
    act(() => { fireEvent.click(filesTab); });
    expect(localStorage.getItem('zai.splitPane.tab')).toBe('"fs"');
  });

  it('restores open state from localStorage', () => {
    // Hook serializes booleans as JSON — 'true' on read.
    localStorage.setItem('zai.splitPane.open', 'true');
    render(<SplitPane cwd="/repo" />);
    expect(screen.getByText(/Git/)).toBeTruthy();
  });

  it('auto-closes when window is narrow', () => {
    localStorage.setItem('zai.splitPane.open', 'true');
    Object.defineProperty(window, 'innerWidth', { configurable: true, value: 800 });
    render(<SplitPane cwd="/repo" />);
    // Panel should not be open — content not visible.
    expect(screen.queryByText(/Git/)).toBeNull();
  });
});
```

- [ ] **Step 3: Run the test to confirm it fails**

Run: `pnpm --filter @zn-ai/zai test -- SplitPane.test`
Expected: FAIL — module not found.

- [ ] **Step 4: Implement `SplitPane`**

Write `packages/zai/src/web/src/components/splitPane/SplitPane.tsx`:

```tsx
import { useCallback, useEffect, useRef, useState } from 'react';
import { Button, Tabs } from 'antd';
import {
  BorderOutlined,
  ReloadOutlined,
  PicCenterOutlined,
} from '@ant-design/icons';
import { GitTab } from './GitTab.js';
import { FsTab } from './FsTab.js';
import { PlaceholderTab } from './PlaceholderTab.js';
import {
  STORAGE_KEYS,
  MIN_WIDTH,
  MAX_WIDTH,
  DEFAULT_WIDTH,
  RESPONSIVE_BREAKPOINT,
  clampWidth,
  useLocalStorageState,
} from './shared.js';

type TabKey = 'git' | 'fs' | 'tbd';

export interface SplitPaneProps {
  cwd: string | null;
}

/**
 * Three-column container:
 *   [slot]            [messages (passed via children, not used here)]      [panel]
 *
 * We don't take children — Agent.tsx wraps its own messages column and
 * passes `cwd` here. The panel column is fully owned by SplitPane.
 */
export function SplitPane({ cwd }: SplitPaneProps) {
  const [openStored, setOpenStored] = useLocalStorageState<boolean>(STORAGE_KEYS.open, false);
  const [tab, setTab] = useLocalStorageState<TabKey>(STORAGE_KEYS.tab, 'git');
  const [widthStored, setWidthStored] = useLocalStorageState<number>(
    STORAGE_KEYS.width,
    DEFAULT_WIDTH,
  );
  const width = clampWidth(widthStored);

  // Responsive: collapse when window is narrow regardless of stored state.
  const [responsiveClosed, setResponsiveClosed] = useState(
    typeof window !== 'undefined' && window.innerWidth < RESPONSIVE_BREAKPOINT,
  );
  useEffect(() => {
    const onResize = () => {
      setResponsiveClosed(window.innerWidth < RESPONSIVE_BREAKPOINT);
    };
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, []);

  const open = openStored && !responsiveClosed;

  // Splitter drag state.
  const dragRef = useRef<{ startX: number; startW: number } | null>(null);
  const onHandleMouseDown = useCallback(
    (e: React.MouseEvent) => {
      dragRef.current = { startX: e.clientX, startW: width };
      const onMove = (ev: MouseEvent) => {
        if (!dragRef.current) return;
        // Drag left → reduce panel width; right → grow.
        const next = dragRef.current.startW + (ev.clientX - dragRef.current.startX) * -1;
        setWidthStored(clampWidth(next));
      };
      const onUp = () => {
        dragRef.current = null;
        window.removeEventListener('mousemove', onMove);
        window.removeEventListener('mouseup', onUp);
      };
      window.addEventListener('mousemove', onMove);
      window.addEventListener('mouseup', onUp);
    },
    [width, setWidthStored],
  );

  const panelWidth = open ? width : 0;

  return (
    <div
      data-testid="split-pane"
      style={{
        flex: '0 0 auto',
        width: panelWidth,
        minWidth: panelWidth,
        height: '100%',
        display: 'flex',
        flexDirection: 'column',
        background: '#0d0d0d',
        borderLeft: open ? '1px solid rgba(255,255,255,0.08)' : 'none',
        overflow: 'hidden',
        transition: 'width 0.2s ease, min-width 0.2s ease',
      }}
    >
      {open && (
        <>
          <Tabs
            activeKey={tab}
            onChange={(k) => setTab(k as TabKey)}
            size="small"
            tabBarStyle={{
              margin: 0,
              padding: '0 8px',
              background: '#141414',
              borderBottom: '1px solid rgba(255,255,255,0.08)',
            }}
            items={[
              { key: 'git', label: 'Git', children: <GitTab cwd={cwd} /> },
              { key: 'fs', label: 'Files', children: <FsTab cwd={cwd} /> },
              { key: 'tbd', label: '待定', children: <PlaceholderTab /> },
            ]}
          />
          {/* Splitter handle — drag to resize. */}
          <div
            data-testid="split-pane-handle"
            onMouseDown={onHandleMouseDown}
            style={{
              position: 'absolute',
              top: 0,
              right: 0,
              width: 6,
              height: '100%',
              cursor: 'ew-resize',
              background: 'transparent',
              zIndex: 5,
            }}
            onMouseEnter={(e) => {
              (e.currentTarget as HTMLDivElement).style.background = 'rgba(255,102,0,0.18)';
            }}
            onMouseLeave={(e) => {
              (e.currentTarget as HTMLDivElement).style.background = 'transparent';
            }}
            title={`拖动以调整宽度 (${MIN_WIDTH}-${MAX_WIDTH}px)`}
          />
        </>
      )}
    </div>
  );
}

/**
 * Companion toggle button — rendered by Agent.tsx in the left sidebar.
 */
export function SplitPaneToggle({
  open,
  onToggle,
}: {
  open: boolean;
  onToggle: () => void;
}) {
  return (
    <Button
      type="text"
      size="small"
      icon={open ? <PicCenterOutlined /> : <BorderOutlined />}
      onClick={onToggle}
      title="切换右侧分屏"
      data-testid="split-pane-toggle"
      style={{
        // Match the existing icon-button cluster in the left sidebar.
      }}
    />
  );
}

void ReloadOutlined; // re-exported for potential future "refresh" use
```

> Note: the splitter handle is positioned with `position:absolute` — for it to align correctly the SplitPane root needs `position: relative`. Add that here:

Edit `packages/zai/src/web/src/components/splitPane/SplitPane.tsx` — at the top of the style on the outer `<div>`, after `display: 'flex'`:

```tsx
        position: 'relative',
```

(Apply this single-line insertion so the splitter handle aligns to the right edge.)

- [ ] **Step 5: Run the test to confirm it passes**

Run: `pnpm --filter @zn-ai/zai test -- SplitPane.test`
Expected: PASS (6 tests).

- [ ] **Step 6: Commit**

```bash
git add packages/zai/src/web/src/components/splitPane/PlaceholderTab.tsx \
        packages/zai/src/web/src/components/splitPane/SplitPane.tsx \
        packages/zai/src/web/src/components/splitPane/SplitPane.test.tsx
git commit -m "feat(zai-web): split-pane shell + toggle button + tabs"
```

---

## Task 12: Wire `SplitPane` into `Agent.tsx`

**Files:**
- Modify: `packages/zai/src/web/src/pages/Agent.tsx`

**Interfaces:**
- Consumes: `<SplitPane cwd>`, `<SplitPaneToggle open onToggle>` (Task 11).
- Produces: three-column layout (sidebar / messages / split-pane) with persisted state.

- [ ] **Step 1: Add imports and toggle button to left sidebar**

In `packages/zai/src/web/src/pages/Agent.tsx`, add to the import block:

```tsx
import { SplitPane, SplitPaneToggle } from '../components/splitPane/SplitPane.js';
import {
  STORAGE_KEYS,
  DEFAULT_WIDTH,
  clampWidth,
  useLocalStorageState,
} from '../components/splitPane/shared.js';
```

- [ ] **Step 2: Add state + handlers in the component body**

After the existing `useState` calls inside `function Agent()`, add:

```tsx
  // Split-pane state mirrors the hook used by SplitPane so the toggle
  // button in the sidebar can update the same persisted value.
  const [openStored, setOpenStored] = useLocalStorageState<boolean>(STORAGE_KEYS.open, false);
  const [widthStored] = useLocalStorageState<number>(STORAGE_KEYS.width, DEFAULT_WIDTH);
  const splitPaneOpen = openStored; // responsive handling lives inside SplitPane
  const toggleSplitPane = () => setOpenStored(!openStored);
```

- [ ] **Step 3: Insert the toggle into the left sidebar**

In the existing sidebar block — find the cluster of icon buttons for the *collapsed* branch (the absolute-positioned `Plus` / `N` / `MenuUnfold`) and the *expanded* branch (the `<Space size={4}>` containing `Plus` / `N` / `MenuFold`). Add a fourth button next to `MenuFold` / `MenuUnfold` in both branches.

For the **expanded** branch (find this block):

```tsx
              <Space size={4}>
                <Button ... PlusOutlined ... onClick={createNewSession} ... />
                <Button ... onClick={openNewSessionInNewTab} ... >N</Button>
                <Button ... MenuFoldOutlined ... onClick={() => setSessionsCollapsed(true)} ... />
              </Space>
```

Add immediately after the `MenuFold` button, before the closing `</Space>`:

```tsx
                <Button
                  type="text"
                  size="small"
                  icon={<BorderOutlined />}
                  onClick={toggleSplitPane}
                  title="切换右侧分屏"
                  data-testid="split-pane-toggle"
                  style={{
                    color: splitPaneOpen ? '#ff6600' : undefined,
                  }}
                />
```

For the **collapsed** branch (find this block inside the `<div style={{ position: 'relative', width: '100%', height: 92 }}>`):

```tsx
              <Button ... MenuUnfoldOutlined ... onClick={() => setSessionsCollapsed(false)} ... />
```

Add an additional icon button below it (top: 96) using the same `position:absolute` pattern:

```tsx
              <Button
                type="text"
                size="small"
                icon={<BorderOutlined />}
                onClick={toggleSplitPane}
                title="切换右侧分屏"
                data-testid="split-pane-toggle-collapsed"
                style={{
                  position: 'absolute',
                  top: 96,
                  left: '50%',
                  transform: 'translateX(-50%)',
                  width: 28,
                  height: 28,
                  padding: 0,
                  display: 'inline-flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  color: splitPaneOpen ? '#ff6600' : undefined,
                }}
              />
```

Also add `BorderOutlined` to the `@ant-design/icons` import block at the top of the file (search for the existing icons import).

- [ ] **Step 4: Add `<SplitPane>` as the third flex child**

Find the outermost `<div style={{ flex: 1, ... }}>` block that wraps the session sidebar + messages columns. Append a third sibling after the existing messages column wrapper (which itself wraps `<div ref={scrollContainerRef}>` and the input box stack) and before the existing `<TaskDrawer>` / `<SettingsDrawer>` / `<SessionCwdBridge>` siblings. Use `splitPaneOpen` to control whether the panel column has width.

```tsx
      <SplitPane cwd={cwd} />
```

(SplitPane owns its own width via localStorage — Agent only passes `cwd`. The toggle button in the sidebar is independent.)

- [ ] **Step 5: Run the full frontend test suite**

Run: `pnpm --filter @zn-ai/zai test -- Agent`
Expected: existing `Agent.test.tsx` still passes (no behavioral changes to the existing surface).

- [ ] **Step 6: Type-check**

Run: `pnpm --filter @zn-ai/zai typecheck`
Expected: exit 0.

- [ ] **Step 7: Commit**

```bash
git add packages/zai/src/web/src/pages/Agent.tsx
git commit -m "feat(zai-web): wire SplitPane into Agent page"
```

---

## Task 13: Final verification

- [ ] **Step 1: Run the full test suite**

Run: `pnpm --filter @zn-ai/zai test`
Expected: ALL tests PASS — backend (safePath + git + fs) + frontend (shared + useGitStatus + DiffView + GitTab + FsTab + SplitPane).

- [ ] **Step 2: Type-check + build**

Run: `pnpm --filter @zn-ai/zai typecheck && pnpm --filter @zn-ai/zai build`
Expected: exit 0.

- [ ] **Step 3: Manual smoke checklist**

The engineer should boot the dev server (`pnpm --filter @zn-ai/zai dev`) and verify against the spec's manual checklist:

1. Toggle button visible in the left sidebar.
2. Click → panel slides open with `Git` tab active.
3. On a git cwd: file list shows, click a file → diff renders.
4. On a non-git cwd: Git tab shows "not a git repository".
5. Switch to Files tab → tree renders (root + first level); click a leaf → preview.
6. Switch to placeholder tab → "即将到来" Empty.
7. Refresh localStorage (`localStorage.clear()`) → reload → panel starts closed.
8. Set localStorage `zai.splitPane.open = 'true'` (JSON-encoded boolean) → reload → panel opens.
9. Resize browser to < 1024px → panel auto-closes.
10. Resize browser back to ≥ 1024px → panel stays closed (no auto-reopen).

- [ ] **Step 4: Final commit (only if smoke checklist revealed tweaks)**

If any tweak was needed, commit:

```bash
git add -A
git commit -m "fix(zai): split-pane smoke checklist follow-ups"
```

If nothing needed: no commit.

---
